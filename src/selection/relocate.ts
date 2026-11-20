/**
 * 「按锚点重新定位」——确认 / 重 Roll / 待生成出 tag 共用的一步。
 *
 * 为什么不能复用捕获时的快照：`planSelection` 第一行就是「正文指纹不符即 stale」，
 * 而确认发生在几分钟甚至几天后，正文多半已经变过。所以这里按**锚点文本 + 前后各 200 字**
 * 在当前正文里重新找位置，再用当前正文造一份新的切片计划 —— 绕开 stale，
 * 却把全部行号换算逻辑原样保留。
 *
 * 为什么放在 selection 层而不是 runner 层：分析和写回都要用它（待生成出 tag 属于分析，
 * 确认属于写回），放在 runner/commit.ts 会让 `analysis → commit → analysis` 成环。
 * 这一层只依赖 capture / locate / segmentPlan，没有任何宿主副作用，天然适合当公共底。
 */

import { buildCapture } from './capture';
import { locateSelection } from './locate';
import { planSelection, type SelectionPlan } from './segmentPlan';
import type { SegmentAnchor } from '@/state/candidates';

export type RelocateOutcome =
  | { ok: true; plan: SelectionPlan }
  | { ok: false; reason: 'anchor-lost' | 'empty-target'; detail?: string };

export function relocatePlan(
  segments: SegmentAnchor[],
  raw: string,
  floor: number,
  swipeId: number,
  stripTags: string[],
): RelocateOutcome {
  const anchor = segments[0];
  if (!anchor) return { ok: false, reason: 'anchor-lost', detail: '没有锚点' };

  const located = locateSelection({ raw, domText: anchor.text, before: anchor.before, after: anchor.after });
  if (!located.ok) {
    return {
      ok: false,
      reason: 'anchor-lost',
      detail: located.reason === 'ambiguous' ? '这段文字在楼里出现了多次' : '这段文字已经不在正文里了',
    };
  }

  const built = buildCapture({ raw, messageId: floor, swipeId, domText: anchor.text, located });
  if (!built.ok) return { ok: false, reason: 'anchor-lost', detail: built.reason };

  const planned = planSelection(built.capture, raw, stripTags);
  if (!planned.ok) {
    return { ok: false, reason: planned.reason === 'empty-target' ? 'empty-target' : 'anchor-lost', detail: planned.detail };
  }
  return { ok: true, plan: planned.plan };
}
