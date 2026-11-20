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

  const slicePrepared = prepareTargetText(capture.text, stripTags);
  if (!slicePrepared.segments.length) return { ok: false, reason: 'empty-target' };

  const wholeByLine = new Map(
    prepareTargetText(mes, stripTags).segments.map(segment => [segment.sourceLine, segment]),
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
    if (whole.text !== segment.text) divergent = true;
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
