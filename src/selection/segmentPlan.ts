/**
 * 划线切片 ⇄ 整楼原文 的换算层。
 *
 * 分析链路吃的是「一段正文」，它会自己按物理行切段、给每行打 `⟦Pn⟧` 位置 ID，
 * 模型返回的插入位置指的是**这段正文里**的行。但真正写回时必须用**整楼**的行号，
 * 否则 tag 会插到楼层开头。这一层就是那唯一一次坐标换算。
 *
 * 为什么不直接把切片丢给 rebaseImagePositions 了事：
 * rebase 的对齐锚是「整行文本相等」，它不知道切片原本在第几行。若一楼里有两行完全一样
 * （重复的「……」、重复的对白很常见），它会把 tag 锚到**第一处**——静默插错位置，
 * 用户只能靠肉眼发现。所以这里先用捕获时的绝对偏移算出「切片起始行」，再逐段平移，
 * 结果与切片内容无关，重复行也不会错。
 *
 * 只有正文在捕获后被别的插件改过（指纹不符）才回落到 rebase——那种情况下文本锚定
 * 本来就是柏宝绘的既有口径，行为与其保持一致。
 */

import { prepareTargetText, type TargetSegment } from '@/autoTag/clean';
import type { ImageInsertion } from '@/autoTag/protocol';
import { rebaseImagePositions, type RebaseResult } from '@/autoTag/rebase';
import type { SelectionCapture } from './capture';
import { hashText } from './hash';

export interface SelectionPlan {
  capture: SelectionCapture;
  /** 交给 LLM 的目标正文（段尾带 ⟦Pn⟧），= 切片清洗后的样子。 */
  promptText: string;
  /** LLM 视角的 segments：sourceLine 是**切片内**物理行号，id 为 P1..Pn。 */
  sliceSegments: TargetSegment[];
  /** 与 sliceSegments **同下标一一对应**，sourceLine 换成整楼绝对行号。 */
  absoluteSegments: TargetSegment[];
  /**
   * 清洗口径是否出现分歧（切片单独清洗 vs 整楼清洗）。
   * 正常为 false；true 说明楼里有跨行的噪声块（如包裹整楼的 <think>），
   * 此时以整楼清洗结果为准，但仍可继续——只记日志，不阻断。
   */
  divergent: boolean;
}

export type PlanOutcome =
  | { ok: true; plan: SelectionPlan }
  | { ok: false; reason: 'stale' | 'empty-target' | 'line-mismatch'; detail?: string };

/**
 * 把正文里已有的生图 tag 原地涂成空白，**字符数与换行一个都不变**。
 *
 * 为什么必须涂白而不是像 `stripImageTags` 那样删掉：本层的所有行号都是「物理行下标」，
 * 删掉一个 tag 会连同它前面的换行一起吃掉，后面每一行的行号都往前挪一格，
 * `absoluteSegments` 就会整体错位——tag 插到上一段去，而且看起来「成功了」。
 * 涂白后：纯 tag 行变成空白行（下游 `prepareTargetText` 会把它过滤掉，模型看不见），
 * 正文 + 内联 tag 的行只剩正文，行号与偏移全部保持原值。
 *
 * 为什么必须做这件事（2026-11-20 用户实测反馈）：
 * 楼里已有 `<bbi_image>` 时，切片会把它当成正文送进目标文本，模型会
 *   ① 把它读成「可插图的正文」，为一个 tag 再生成一张图；
 *   ② 顺着它把旧提示词抄进新 tag（等于替旧图重 roll）。
 * 旧 tag 属于「已经出过图的产物」，不是叙事内容，分析阶段必须当它不存在。
 */
export function maskImageTags(text: string): string {
  const source = String(text ?? '');
  const tokens = /<\/?bbi_image\b[^>]*>/gi;
  const ranges: Array<{ start: number; end: number }> = [];
  const openStack: Array<{ start: number; end: number }> = [];
  for (let match = tokens.exec(source); match; match = tokens.exec(source)) {
    const start = match.index;
    const end = start + match[0].length;
    if (match[0][1] === '/') {
      const open = openStack.pop();
      ranges.push({ start: open ? open.start : start, end });
    } else {
      openStack.push({ start, end });
    }
  }
  // 落单的开/闭标签（AI 只写了一半、或别的插件截断）同样涂掉：留着它照样会误导模型
  for (const open of openStack) ranges.push(open);

  ranges.sort((left, right) => left.start - right.start);
  const chars = source.split('');
  let cursor = 0;
  for (const range of ranges) {
    // 嵌套时外层区间已经吃掉内层，跳过
    if (range.start < cursor) continue;
    for (let index = range.start; index < range.end; index += 1) {
      if (chars[index] !== '\r' && chars[index] !== '\n') chars[index] = ' ';
    }
    cursor = range.end;
  }
  return chars.join('');
}

/**
 * 新 tag 插进来之后，**已有 tag 的槽位序号会平移多少**。
 *
 * 柏宝绘的图片历史按 `(promptHash, slotSeq)` 归属（floor/storage.ts 的 entrySeq），
 * `slotSeq` 就是 tag 在楼里的序号。若新 tag 插在某条既有 tag **之前**，那条 tag
 * 从 N 变成 N+1，它的图就找不到自己——旧卡退回「待生成」，而新卡因为同序号下
 * 有别的 hash 而显示成「旧提示词」，还顶着旧图。用户看到的就是「旧图被新卡顶掉」。
 *
 * 所以写回后要按这份位移把 extra 里的 slotSeq 一起挪（见 state/imageSlots.ts）。
 *
 * `insertLines` 必须是**已换算到 currentText 行号**的插入行；`injectImageTags` 把
 * 新 tag 落在该行文本之后，因此落在同一行的插入不计入位移（它排在既有 tag 之后）。
 *
 * 返回数组下标 = 既有 tag 的序号，值 = 该 tag 需要后移的位数。全 0 表示无需迁移。
 */
export function computeSlotShifts(baseText: string, insertLines: number[]): number[] {
  const pattern = /<bbi_image\b[^>]*>[\s\S]*?<\/bbi_image>|<bbi_image\b[^>]*>/gi;
  const shifts: number[] = [];
  for (const match of baseText.matchAll(pattern)) {
    const tagLine = lineIndexAt(baseText, match.index ?? 0);
    shifts.push(insertLines.filter(line => Number.isInteger(line) && line < tagLine).length);
  }
  return shifts;
}

/** 某字符偏移位于第几个物理行（0-based）。 */
export function lineIndexAt(text: string, offset: number): number {
  const limit = Math.max(0, Math.min(offset, text.length));
  let line = 0;
  for (let i = 0; i < limit; i += 1) {
    const ch = text[i];
    if (ch === '\n') line += 1;
    else if (ch === '\r') {
      // \r\n 只算一次
      if (text[i + 1] === '\n') i += 1;
      line += 1;
    }
  }
  return line;
}

/**
 * 把捕获快照变成一份可执行的分析计划。
 * `mes` 必须是**当前**楼层正文；指纹不符直接判 stale，绝不用过期快照去写回。
 */
export function planSelection(
  capture: SelectionCapture,
  mes: string,
  stripTags: string[],
): PlanOutcome {
  if (hashText(mes) !== capture.sourceHash) return { ok: false, reason: 'stale' };

  // 旧 tag 不是叙事内容：涂白后送模型，行号原样保留（见 maskImageTags 的注释）
  const slicePrepared = prepareTargetText(maskImageTags(capture.text), stripTags);
  if (!slicePrepared.segments.length) return { ok: false, reason: 'empty-target' };

  // 整楼侧两套：real 给写回对齐（rebase 靠原文行文本），masked 只用于口径对照
  const wholeByLine = new Map(
    prepareTargetText(mes, stripTags).segments.map(segment => [segment.sourceLine, segment]),
  );
  const wholeMaskedByLine = new Map(
    prepareTargetText(maskImageTags(mes), stripTags).segments.map(segment => [segment.sourceLine, segment]),
  );
  const startLine = lineIndexAt(mes, capture.range.start);

  let divergent = false;
  const absoluteSegments: TargetSegment[] = [];
  for (const segment of slicePrepared.segments) {
    const line = startLine + segment.sourceLine;
    const whole = wholeByLine.get(line);
    if (!whole) {
      // 切片清洗保留了这一行，整楼清洗却没有：说明切片边界切进了某个跨行噪声块内部。
      return { ok: false, reason: 'line-mismatch', detail: `绝对行 ${line} 在整楼清洗中不存在` };
    }
    // 只比「都涂掉 tag 之后」的文本：否则任何含 tag 的切片都会被误判成 divergent
    if (wholeMaskedByLine.get(line)?.text !== segment.text) divergent = true;
    absoluteSegments.push({ id: segment.id, sourceLine: line, text: whole.text });
  }

  return {
    ok: true,
    plan: {
      capture,
      promptText: slicePrepared.promptText,
      sliceSegments: slicePrepared.segments,
      absoluteSegments,
      divergent,
    },
  };
}

/**
 * 把模型给出的（切片内行号）插入点换成整楼行号。
 * 行号对不上就整批失败——宁可不出图，也不把 tag 丢到随机位置。
 */
export function toAbsoluteImages(
  plan: SelectionPlan,
  images: ImageInsertion[],
): ImageInsertion[] | null {
  const indexBySliceLine = new Map(plan.sliceSegments.map((segment, index) => [segment.sourceLine, index]));
  const out: ImageInsertion[] = [];
  for (const image of images) {
    const index = indexBySliceLine.get(image.sourceLine);
    if (index === undefined) return null;
    out.push({ ...image, sourceLine: plan.absoluteSegments[index].sourceLine });
  }
  return out;
}

export type WritebackOutcome =
  | { ok: true; images: ImageInsertion[]; mode: 'direct' | 'rebased'; report?: RebaseResult['report'] }
  | { ok: false; reason: 'position-lost' | 'rebase-failed' };

/**
 * 写回前最后一次定位：正文没变就用绝对行号直接落，变了就交给 rebase 按文本重锚。
 * 返回的 sourceLine 已经是 `currentMes` 的行号，可直接交给 injectImageTags。
 */
export function resolveWriteback(
  plan: SelectionPlan,
  currentMes: string,
  images: ImageInsertion[],
  stripTags: string[],
): WritebackOutcome {
  const absolute = toAbsoluteImages(plan, images);
  if (!absolute) return { ok: false, reason: 'position-lost' };

  if (hashText(currentMes) === plan.capture.sourceHash) {
    return { ok: true, images: absolute, mode: 'direct' };
  }

  const rebased = rebaseImagePositions(currentMes, plan.absoluteSegments, absolute, stripTags);
  if (!rebased) return { ok: false, reason: 'rebase-failed' };
  return { ok: true, images: rebased.images, mode: 'rebased', report: rebased.report };
}
