/**
 * 「待生成」→ 生成 tag 的执行层。
 *
 * 两个入口，共用同一套结果落盘：
 *   - `generateDraft(id)`：单段（面板上每条右侧那个「⚡ 生成 tag」）
 *   - `generateDrafts()`：一键全生成，同楼的多段**一次调用**出全部 tag
 *
 * 为什么值得单独一层：它们的输出都是「把 draft 填成 pending」，区别只在
 * 花几次请求。把「要不要接着写回 / 出图」的判断收在这一个地方，
 * 就不会出现 v0.2.1 那个「同一个开关在两处各判一次」的形状（见 §8.2）。
 *
 * 三条模式规则（与「⚡ 生成」完全一致，不因入口不同而漂移）：
 *   全自动 → 生成即写回并出图（条目消失）
 *   确认式 → 生成即转 pending（条目原地变身，留在待确认区）
 *   全手动 → 生成即写回，不出图（条目消失）
 */

import { readPrefs } from '@/state/prefs';
import { findCandidate, fillDraft, listCandidates, type CandidateVersion } from '@/state/candidates';
import { settings } from '@/state/settings';
import { getContext } from '@/st/context';
import { notify } from '@/ui/notify';
import { analyzeBatch, analyzeSelection, type BatchPayload } from './analysis';
import { commitCandidate } from './commit';
import { diagnostic } from './diagnostic';
import { relocatePlan } from '@/selection/relocate';
import { failure, result, skip, type RunResult } from './result';

/** 一次调用最多拼几段。再多，单次响应的 JSON 太长，协议稳定性下降、整批失败代价也变大。 */
export const MAX_BATCH = 6;

function isConfirmMode(): boolean {
  const prefs = readPrefs();
  // confirmTag 在状态层被 autoGenerate 压着，这里再判一次只是防御
  return prefs.confirmTag && !prefs.autoGenerate;
}

function versionOf(payload: BatchPayload): CandidateVersion {
  const image = payload.images[0];
  const zh = payload.tagZh[0]?.trim();
  const charZh = payload.charactersZh?.filter(item => item.trim());
  return {
    image,
    changes: payload.changes,
    ...(zh ? { tagZh: zh } : {}),
    ...(charZh?.length ? { charactersZh: charZh } : {}),
    createdAt: Date.now(),
  };
}

/** 填进池子；确认/手动模式下立刻提交写回（确认式不写，只转 pending）。 */
async function settle(imageId: string, payload: BatchPayload, opts: { signal?: AbortSignal }): Promise<RunResult> {
  if (!payload.images[0]) return failure(-1, 'no-image', '模型这次没有给出画面，条目仍留在待生成');
  if (!fillDraft(imageId, [versionOf(payload)])) {
    return failure(-1, 'candidate-missing', '这条待生成已经不在了（可能刚被删掉）');
  }
  if (isConfirmMode()) {
    return result('pending', '已生成候选，等待确认', { images: 1 });
  }
  return commitCandidate(imageId, { autoGenerate: readPrefs().autoGenerate, signal: opts.signal });
}

/**
 * 单段生成：面板上每条「待生成」右侧的按钮。
 *
 * 用 `analyzeSelection` 而不是拼装层：一段不需要伪楼层，走原路径最简单，
 * 也让「单段」与「划线立刻生成」在协议上完全同构（少一条会漂的分支）。
 */
export async function generateDraft(imageId: string, opts: { signal?: AbortSignal } = {}): Promise<RunResult> {
  const item = findCandidate(imageId);
  if (!item) return failure(-1, 'candidate-missing', '这条待生成已经不在了：可能刚生成过，或者换了聊天');
  if (item.status !== 'draft') return skip(item.floor, 'not-draft', '这条已经有 tag 了，去「待确认」里操作');
  if (!settings.enabled) return skip(item.floor, 'extension-disabled', '柏宝绘已停用，请先在插件设置里开启');

  const context = getContext();
  if (!context) return skip(item.floor, 'missing-context', 'SillyTavern 还没就绪，请稍后重试');
  const chatId = context.getCurrentChatId?.() ?? '';
  if (chatId !== item.chatId) return skip(item.floor, 'chat-changed', '已切换聊天，这条待生成属于原来的聊天');

  const message = context.chat?.[item.floor];
  if (!message || typeof message.mes !== 'string') {
    return failure(item.floor, 'message-not-found', '找不到这条待生成对应的楼层，可能该楼已被删除');
  }
  const swipeId = typeof message.swipe_id === 'number' ? message.swipe_id : 0;
  if (swipeId !== item.swipeId) return skip(item.floor, 'swipe-changed', '已切换 swipe，这条待生成对应的正文不在了');

  const relocated = relocatePlan(item.segments, message.mes, item.floor, swipeId, settings.excludes.customStripTags);
  if (!relocated.ok) {
    const text = `这段文字已经被改过了（${relocated.detail ?? '无法定位'}）：请删掉这条，重新划线`;
    notify('warning', text);
    return failure(item.floor, 'anchor-lost', text);
  }

  const outcome = await analyzeSelection(relocated.plan.capture, {
    signal: opts.signal,
    skipDedupe: true,
    singleImage: true,
  });
  if (!outcome.ok) return outcome.result;

  const image = outcome.analysis.images[0];
  if (!image) return failure(item.floor, 'no-image', '模型这次没有给出画面，条目仍留在待生成');
  const zh = outcome.analysis.tagZh[0]?.trim();
  const payload: BatchPayload = {
    imageId,
    images: [image],
    changes: outcome.analysis.changes,
    tagZh: [zh ?? ''],
    charactersZh: outcome.analysis.charactersZh[0] ?? [],
  };
  diagnostic('draft:generate', { floor: item.floor, imageId, tagChars: image.tag.length });
  return settle(imageId, payload, opts);
}

export interface DraftGroup {
  floor: number;
  swipeId: number;
  ids: string[];
}

/**
 * 按 `(floor, swipeId)` 分组再切块。跨楼合在一次调用里会让 12 楼的段读到 13 楼的前文，
 * 所以分组是**口径正确性**的要求，不是性能优化。
 */
export function planBatches(items: Array<{ imageId: string; floor: number; swipeId: number }>): DraftGroup[] {
  const byFloor = new Map<string, DraftGroup>();
  for (const item of items) {
    const key = `${item.floor}\u0000${item.swipeId}`;
    const group = byFloor.get(key) ?? { floor: item.floor, swipeId: item.swipeId, ids: [] };
    group.ids.push(item.imageId);
    byFloor.set(key, group);
  }
  const chunks: DraftGroup[] = [];
  for (const group of [...byFloor.values()].sort((left, right) => left.floor - right.floor)) {
    for (let start = 0; start < group.ids.length; start += MAX_BATCH) {
      chunks.push({ ...group, ids: group.ids.slice(start, start + MAX_BATCH) });
    }
  }
  return chunks;
}

/** 面板按钮上的「N 次调用」就靠它算——用户点之前就该知道要花几次。 */
export function countBatchCalls(items: Array<{ imageId: string; floor: number; swipeId: number }>): number {
  return planBatches(items).length;
}

export interface GenerateDraftsOutcome {
  requested: number;
  generated: number;
  pendingConfirm: number;
  committed: number;
  missing: number;
  skipped: number;
  /** 实际发出的请求次数（含补发）。 */
  calls: number;
}

/**
 * 一键全生成。
 *
 * 缺段处理是**常规路径**而不是异常分支：一次调用出 N 段时，模型漏一段很常见。
 * 第一次的成果绝不推翻——只对缺的那几段补发单段请求。
 */
export async function generateDrafts(opts: { imageIds?: string[]; signal?: AbortSignal } = {}): Promise<GenerateDraftsOutcome> {
  const drafts = listCandidates({ status: 'draft' }).filter(
    item => !opts.imageIds || opts.imageIds.includes(item.imageId),
  );
  const summary: GenerateDraftsOutcome = {
    requested: drafts.length,
    generated: 0,
    pendingConfirm: 0,
    committed: 0,
    missing: 0,
    skipped: 0,
    calls: 0,
  };
  if (!drafts.length) {
    notify('info', '没有待生成的选段');
    return summary;
  }

  const retry: string[] = [];
  const skippedIds = new Set<string>();
  for (const chunk of planBatches(drafts)) {
    if (opts.signal?.aborted) break;
    summary.calls += 1;
    const items = drafts
      .filter(item => chunk.ids.includes(item.imageId))
      .map(item => ({ imageId: item.imageId, anchor: item.segments[0] }));
    const outcome = await analyzeBatch(chunk.floor, chunk.swipeId, items, { signal: opts.signal });
    if (!outcome.ok) {
      // 整批失败时条目全部原样留着：用户还能逐条点「生成 tag」重来
      diagnostic('batch:failed', { floor: chunk.floor, ids: chunk.ids, reason: outcome.result.reason });
      continue;
    }
    for (const entry of outcome.batch.skipped) skippedIds.add(entry.imageId);
    for (const payload of outcome.batch.payloads) {
      const settled = await settle(payload.imageId, payload, opts);
      if (settled.status === 'aborted') return summary;
      if (settled.status === 'saved') summary.committed += 1;
      else if (settled.status === 'pending') summary.pendingConfirm += 1;
      if (settled.status === 'saved' || settled.status === 'pending') summary.generated += 1;
    }
    retry.push(...outcome.batch.missing);
  }

  // 补发：只对模型漏掉的段各发一次单段请求。第一次的成果已经落盘，不会被这次推翻。
  for (const imageId of retry) {
    if (opts.signal?.aborted) break;
    if (skippedIds.has(imageId)) continue;
    summary.calls += 1;
    const outcome = await generateDraft(imageId, opts);
    if (outcome.status === 'aborted') break;
    if (outcome.status === 'saved') {
      summary.committed += 1;
      summary.generated += 1;
    } else if (outcome.status === 'pending') {
      summary.pendingConfirm += 1;
      summary.generated += 1;
    }
  }

  summary.missing = Math.max(0, summary.requested - summary.generated - skippedIds.size);
  summary.skipped = skippedIds.size;

  const parts: string[] = [`${summary.generated}/${summary.requested} 段已生成（${summary.calls} 次调用）`];
  if (summary.pendingConfirm) parts.push(`${summary.pendingConfirm} 段等确认`);
  if (summary.committed) parts.push(`${summary.committed} 段已写入正文`);
  if (summary.missing) parts.push(`${summary.missing} 段模型没给（仍留在待生成）`);
  if (summary.skipped) parts.push(`${summary.skipped} 段原文被改过（已跳过）`);
  notify(summary.generated ? 'success' : 'warning', parts.join(' · '));
  diagnostic('batch:done', { ...summary });
  return summary;
}
