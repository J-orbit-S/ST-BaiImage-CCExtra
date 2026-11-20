/**
 * 分析结果后处理：把模型输出的 `images / changes` 变成「可直接写回的形态」。
 *
 * 本文件的三个函数逐字对应上游 `autoTag/runner.ts` 的 140–181 行（planChangeOps）与
 * 435–518 行（逐图后处理），以及 547–574 行（写回构造）。抽出来只为一件事：
 * 让「取数 → 请求 → 后处理 → 写回」四段里，后两段能脱离 DOM 与网络被测试覆盖。
 *
 * ⚠ 逻辑改动必须回上游核对后同步。这里任何一处「顺手优化」都会让
 * 「分析过程一模一样」当场失效，而且肉眼查不出来（见 VENDORED.md 的红线）。
 */

import {
  applyPositionedCharRefs,
  entriesAtPosition,
  type PositionedCharOp,
  type ResolvedCharAnchors,
} from '@/autoTag/charAnchors';
import type { AutoTagProfile } from '@/autoTag/prompt';
import { injectImageTags, type ImageInsertion, type ImagePlan } from '@/autoTag/protocol';
import { rebaseImagePositions, type RebaseReport } from '@/autoTag/rebase';
import { bakeAppearance, comicAppearance } from '@/backends/mossLayout';
import {
  CHAR_TAG_FIELDS,
  createCharTagNewOp,
  createCharTagSetOp,
  emptyCharFields,
  type CharTagAutoOp,
  type CharTagEntry,
  type CharTagField,
} from '@/state/charTags';
import { resolveWriteback, type SelectionPlan } from '@/selection/segmentPlan';

/**
 * 把 AI 报告的 changes 转成当前楼层操作。（上游 runner.ts:140–181 逐字）
 *
 * 真正写回在正文 CAS 成功时一次完成（见 runSelection 的 extraUpdate）。
 */
export function planChangeOps(plan: ImagePlan): PositionedCharOp[] {
  const ops: PositionedCharOp[] = [];
  for (const change of plan.changes) {
    let op: CharTagAutoOp | null = null;
    if (change.field === 'new') {
      // value 可能是结构化字段的 JSON 串(protocol.ts 拼),也可能是整串 tag 文本
      let fields: Partial<Record<CharTagField, string>> | null = null;
      let value = '';
      if (change.value.startsWith('{')) {
        try {
          const parsed = JSON.parse(change.value) as Record<string, unknown>;
          const picked: Partial<Record<CharTagField, string>> = {};
          for (const field of CHAR_TAG_FIELDS) {
            const fieldValue = parsed[field];
            if (typeof fieldValue === 'string' && fieldValue.trim()) picked[field] = fieldValue.trim();
          }
          if (Object.keys(picked).length) fields = picked;
        } catch {
          /* 非 JSON → 当整串处理 */
        }
      }
      if (!fields && change.value) value = change.value;
      op = createCharTagNewOp(
        {
          name: change.name,
          fields: { ...emptyCharFields(), ...(fields ?? {}) },
          raw: value,
          nl: change.nl ?? '',
          source: 'ai',
          desc: '',
        },
        change.reason,
      );
    } else if (change.field === 'nl') {
      op = createCharTagSetOp(change.name, 'nl', change.value || change.nl || '', change.reason);
    } else {
      op = createCharTagSetOp(change.name, change.field, change.value, change.reason);
    }
    if (op) ops.push({ op, sourceLine: change.sourceLine });
  }
  return ops.sort((left, right) => left.sourceLine - right.sourceLine);
}

/**
 * 锁定角色（全局库）不接受 AI changes：丢弃，不写入楼层、不参与 @替换。
 * 重放侧 applyCharTagOps 也会按锁定名再拦一次（旧消息里可能已存这类 ops）。
 */
export function filterLockedOps(
  ops: PositionedCharOp[],
  lockedNames: ReadonlySet<string>,
): PositionedCharOp[] {
  if (!lockedNames.size) return ops;
  return ops.filter(item => !lockedNames.has(item.op.name));
}

export interface PostProcessContext {
  profile: AutoTagProfile;
  anchors: ResolvedCharAnchors;
  /** 已按锁定名过滤后的 ops。 */
  effectiveOps: PositionedCharOp[];
  lockedNames: ReadonlySet<string>;
}

/**
 * 逐图后处理（上游 runner.ts:446–518 逐字）：nl 丢弃、画幅锁归一、@占位符替换、漫画补外貌。
 *
 * 返回值 unknownNames = 模型当成角色、库里却没有档案的名字。这是「漏建档」唯一的
 * 确定性信号，调用方必须让用户看见，不能只写控制台。
 */
export function applyPlanPostProcess(plan: ImagePlan, ctx: PostProcessContext): Set<string> {
  const { profile, anchors, effectiveOps, lockedNames } = ctx;
  const unknownNames = new Set<string>();
  for (const image of plan.images) {
    // 协议只要 tag 时,模型照写的 nl 一律丢掉(ComfyUI 关自然语言同一口径):
    // 留着它就会照常发送,开关等于没关。渠道锁了方向则统一改记锁定值——出图本就按锁走,
    // 这里只是让 tag 里记的方向与实际画幅一致。
    if (!profile.nl) {
      image.nl = '';
      for (const character of image.characters) character.nl = '';
    }
    if (profile.lockedSize) image.size = profile.lockedSize;
    if (image.layout) {
      bakeComicAppearance(
        image,
        entriesAtPosition(anchors.entries, effectiveOps, image.sourceLine, lockedNames),
        unknownNames,
      );
      continue;
    }
    const tagRes = applyPositionedCharRefs(
      image.tag,
      anchors.entries,
      effectiveOps,
      image.sourceLine,
      'tag',
      lockedNames,
    );
    if (tagRes.text) image.tag = tagRes.text;
    if (image.nl) {
      const nlRes = applyPositionedCharRefs(
        image.nl,
        anchors.entries,
        effectiveOps,
        image.sourceLine,
        'nl',
        lockedNames,
      );
      image.nl = nlRes.text;
      for (const n of nlRes.unknown) unknownNames.add(n);
    }
    for (const character of image.characters) {
      const charTag = applyPositionedCharRefs(
        character.tag,
        anchors.entries,
        effectiveOps,
        image.sourceLine,
        'tag',
        lockedNames,
      );
      character.tag = charTag.text;
      for (const n of charTag.unknown) unknownNames.add(n);
      if (character.nl) {
        const charNl = applyPositionedCharRefs(
          character.nl,
          anchors.entries,
          effectiveOps,
          image.sourceLine,
          'nl',
          lockedNames,
        );
        character.nl = charNl.text;
        for (const n of charNl.unknown) unknownNames.add(n);
      }
    }
    for (const n of tagRes.unknown) unknownNames.add(n);
  }
  return unknownNames;
}

/**
 * 漫画分镜里带 name 的人物:按库把固定外貌补进 caption。MOSS 靠逐字复用同一串词认人,
 * 交给 AI 抄写迟早会漂;库里查不到的名字原样留着,收进 unknown 交给调用方告警。
 * （上游 runner.ts:187–195 逐字）
 */
function bakeComicAppearance(
  image: ImageInsertion,
  entries: CharTagEntry[],
  unknown: Set<string>,
): void {
  const layout = image.layout;
  if (!layout) return;
  const byName = new Map(entries.map(entry => [entry.name, entry]));
  for (const item of layout.items) {
    if (item.label !== 'character' || !item.name) continue;
    const entry = byName.get(item.name);
    if (entry) item.caption = bakeAppearance(item.caption, comicAppearance(entry));
    else unknown.add(item.name);
  }
}

/** 重定位结果的一行摘要;全部原位命中时返回空串(无需记日志)。 */
export function describeRebase(report: RebaseReport): string {
  if (!report.remapped && !report.drifted) return '';
  const parts = [`原位 ${report.anchored}`];
  if (report.remapped) parts.push(`跟随改写句 ${report.remapped}`);
  if (report.drifted) parts.push(`顺延到上一段 ${report.drifted}`);
  return parts.join(' · ');
}

export type WritebackBuild =
  | {
      ok: true;
      text: string;
      /** 换算到 currentText 行号后的插入点（迁移既有 tag 的槽位序号时要用）。 */
      images: ImageInsertion[];
      mode: 'direct' | 'rebased';
      report?: RebaseReport;
    }
  | { ok: false; reason: 'position-lost' | 'rebase-failed' | 'inject-failed' };

/**
 * 写回构造：把「切片内行号」的 images 落到 `currentText`（整楼现文）上。
 *
 * 与上游 565–573 行的差别只有一处（也是全方案唯一必须不同的地方）：
 * rebase 的 `plannedSegments` 用**切片的绝对行号段**，`currentText` 用**整楼现文**。
 * 上游两边同源，所以它不需要这层换算。
 */
export function buildWritebackText(
  plan: SelectionPlan,
  currentText: string,
  images: ImageInsertion[],
  stripTags: string[],
): WritebackBuild {
  const resolved = resolveWriteback(plan, currentText, images, stripTags);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  try {
    return {
      ok: true,
      text: injectImageTags(currentText, resolved.images),
      images: resolved.images,
      mode: resolved.mode,
      report: resolved.report,
    };
  } catch {
    // injectImageTags 只在落点越过正文行数时抛错——此时宁可不写，也不插到随机位置
    return { ok: false, reason: 'inject-failed' };
  }
}
