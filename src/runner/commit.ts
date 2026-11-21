/**
 * 划线链路 C 段：**把一批已经确定的图写进正文，并（按设置）替他点卡片出图**。
 *
 * 这是 v0.2.0 `runSelection` 的后半段原样抽出。它本来就不认识「plan 是从哪来的」——
 * 只看结构，所以三种入口共用同一份写回逻辑：
 *   ① 全自动  ：分析完直接调它（= v0.2.0 行为）
 *   ② 确认式  ：用户点「确认」后调它，数据来自候选池
 *   ③ 重 Roll ：不调它（只换提示词，不写正文）
 *
 * 与上游唯一的差异仍然只有一处：rebase 的 `currentText` 用整楼现文、
 * `plannedSegments` 用切片绝对行号（见 `runner/plan.ts` 的 buildWritebackText）。
 */

import { autoTagProfile } from '@/autoTag/prompt';
import type { CharChange, ImageInsertion } from '@/autoTag/protocol';
import { relocatePlan, type RelocateOutcome } from '@/selection/relocate';
import { computeSlotShifts, type SelectionPlan } from '@/selection/segmentPlan';
import { readPrefs } from '@/state/prefs';
import {
  BBI_CHAR_EXTRA_KEY,
  lockedCharTagNames,
  makeCharTagFloorDelta,
  readCharTagFloorDelta,
  recomputeCharTags,
} from '@/state/charTags';
import { addCandidateVersion, findCandidate, removeCandidate } from '@/state/candidates';
import { migrateImageSlots } from '@/state/imageSlots';
import { settings } from '@/state/settings';
import { getContext, isAiStoryMessage, type STMessage } from '@/st/context';
import { parseImageTags } from '@/st/imageTagRegex';
import { applyMessageText, type ApplyMessageResult } from '@/st/messageEdit';
import { autoGenerateSlots } from '@/ui/autoGenerate';
import { notify } from '@/ui/notify';
import { analyzeSelection, type SelectionAnalysis } from './analysis';
import { makeIdentity, markProcessed } from './dedupe';
import { diagnostic } from './diagnostic';
import { beginFloorRun } from './locks';
import { buildWritebackText, describeRebase, filterLockedOps, planChangeOps } from './plan';
import { failure, result, skip, type RunResult } from './result';

const ABANDON_REASON: Partial<Record<ApplyMessageResult, string>> = {
  'chat-changed': '已切换聊天，本次没有写入生图 tag',
  'floor-changed': '该楼层已被删除或替换，本次没有写入生图 tag',
  'swipe-changed': '已切换 swipe，本次没有写入生图 tag',
  'build-failed': '楼层正文已被大幅改写，本次没有写入生图 tag',
  unavailable: '当前聊天不可写入，本次没有写入生图 tag',
};

export interface CommitOptions {
  /** 写回成功后是否替他点卡片。全自动 = true；全手动 = false；确认式 = 用户确认即 true。 */
  autoGenerate: boolean;
  signal?: AbortSignal;
}

interface WriteInput {
  chatId: string;
  floor: number;
  swipeId: number;
  message: STMessage;
  plan: SelectionPlan;
  /** 切片内行号的图（写回时由 plan 换算成整楼行号）。 */
  images: ImageInsertion[];
  changes: CharChange[];
  autoGenerate: boolean;
  /** 写回成功后是否记入「这段已经写过了」。 */
  markDedupe: boolean;
  /** 确认式下要移出池子的候选 id。 */
  candidateId?: string;
}

/**
 * 写回 + 槽位迁移 + 反馈。三个入口共用。
 *
 * 注意 changes → ops 是在这里现算的（而不是分析时算好）：确认时角色库若有变动，
 * 落到本楼的是**当下**的口径，与柏宝绘自己重放楼层增量的行为一致。
 * 锁定角色在分析段已经拦过一次，这里再拦一次 —— 旧存档里可能存着锁定前写入的 ops。
 */
async function writeAndPublish(input: WriteInput): Promise<RunResult> {
  const { chatId, floor, swipeId, message, plan, images, changes } = input;
  const stripTags = settings.excludes.customStripTags;
  const tagCountNow = parseImageTags(message.mes).length;
  const identity = makeIdentity(chatId, floor, swipeId, plan.capture.text);

  const effectiveOps = filterLockedOps(planChangeOps({ images: [], changes }), lockedCharTagNames());
  const floorOps = effectiveOps.map(item => item.op);
  const previousDelta = readCharTagFloorDelta(message);
  // 同一楼可以被划多次（尤其确认式：一段一段点头）。楼层增量必须**累加**而不是覆盖 ——
  // 覆盖会把上一次确认里建档的角色一起抹掉，后续画面就丢了外貌基准。
  const carriedOps = previousDelta && previousDelta.swipe === swipeId ? previousDelta.ops : [];
  const mergedOps = [...carriedOps, ...floorOps];

  // 没有图片、也没有角色变化要落时保持无写入（分析段已挡过一次，这里是写回前的最后一道）
  if (!images.length && !floorOps.length && !previousDelta) {
    return result('no-image', '没有可写入的内容');
  }

  let rebaseNote = '';
  let slotShifts: number[] = [];
  /** 新 tag 在写回后正文里的槽位序号：自动出图靠它定位卡片（见 ui/autoGenerate.ts）。 */
  let newSeqs: number[] = [];
  let totalTags = 0;

  const applied = await applyMessageText(
    floor,
    currentText => {
      if (!images.length) return currentText;
      const built = buildWritebackText(plan, currentText, images, stripTags);
      if (!built.ok) {
        diagnostic('writeback:abort', { floor, reason: built.reason });
        return null;
      }
      rebaseNote = built.mode === 'rebased' && built.report ? describeRebase(built.report) : '';
      // 新 tag 若插在既有 tag 之前，既有 tag 的槽位序号会平移，图片历史就认错人。
      // 这里只算位移，真正迁移在正文写成功之后（写失败就不该动历史）。
      slotShifts = computeSlotShifts(currentText, built.images.map(image => image.sourceLine));
      newSeqs = built.seqs;
      totalTags = parseImageTags(built.text).length;
      return built.text;
    },
    chatId,
    swipeId,
    message,
    { key: BBI_CHAR_EXTRA_KEY, value: makeCharTagFloorDelta(mergedOps, swipeId) },
  );

  if (applied === 'saved') {
    recomputeCharTags();
    if (images.length && input.markDedupe) markProcessed(identity, tagCountNow + images.length);

    // 旧 tag 的图必须留在自己身上：把被挤动的历史槽位一起后移（见 state/imageSlots.ts）
    const context = getContext();
    const moved = await migrateImageSlots(context, context?.chat?.[floor], swipeId, slotShifts);
    if (moved.changed) {
      console.info(`[CCX] 第 ${floor} 楼已有图的槽位序号后移：${moved.changed} 条记录`);
      diagnostic('commit:slotShift', { floor, swipeId, entries: moved.changed, shifts: slotShifts });
      // 卡片是按迁移前的序号水合的，此刻还认着旧槽位（图会暂时挂错卡）。
      // 发一条 MESSAGE_UPDATED 让柏宝绘重读 extra —— 它订阅了这个事件。
      const updated = context?.eventTypes?.MESSAGE_UPDATED;
      if (updated && context?.eventSource?.emit) {
        void Promise.resolve(context.eventSource.emit(updated, floor)).catch(() => {});
      }
    } else if (moved.skipped) {
      diagnostic('commit:slotShift', { floor, swipeId, skipped: moved.skipped, shifts: slotShifts });
    }

    if (rebaseNote) console.info(`[CCX] 第 ${floor} 楼 tag 位置重定位:${rebaseNote}`);

    if (images.length) {
      const comic = images.every(image => image.kind === 'comic');
      notify(
        'success',
        comic ? `已在第 ${floor} 楼插入 ${images.length} 页漫画分镜` : `已在第 ${floor} 楼插入 ${images.length} 个生图 tag`,
      );
      // 替他点一下卡片上的「生成图片」。不 await：卡片渲染最多等 5 秒，
      // 没等到也只是提示手动点，不该让划线流程挂在这里。
      if (input.autoGenerate && newSeqs.length) {
        void autoGenerateSlots({ floor, seqs: newSeqs, totalTags }).catch(error => {
          diagnostic('autoGenerate:error', { floor, error: String(error) });
        });
      }
    } else {
      notify('info', '模型认为这段划线没有值得插图的画面');
    }

    diagnostic('commit:saved', { floor, images: images.length, changes: floorOps.length, rebase: rebaseNote || 'none' });
    if (input.candidateId) removeCandidate(input.candidateId);
    return result('saved', '已写入生图 tag', { images: images.length, changes: floorOps.length });
  }

  console.info(`[CCX] 第 ${floor} 楼放弃写入生图 tag：${applied}`);
  notify('warning', ABANDON_REASON[applied] ?? '本次没有写入生图 tag');
  diagnostic('commit:abandon', { floor, result: applied });
  return result('failed', ABANDON_REASON[applied] ?? '本次没有写入生图 tag', { reason: applied });
}

/** 全自动 / 全手动：分析完立刻写回（= v0.2.0 的唯一路径）。 */
export async function commitAnalysis(analysis: SelectionAnalysis, opts: CommitOptions): Promise<RunResult> {
  const context = getContext();
  if (!context) return skip(analysis.floor, 'missing-context', 'SillyTavern 还没就绪，请稍后重试');
  const message = context.chat?.[analysis.floor];
  if (!message || typeof message.mes !== 'string') {
    return failure(analysis.floor, 'message-not-found', '找不到选区对应的楼层数据，可能聊天刚切换或该楼已删除');
  }

  return writeAndPublish({
    chatId: analysis.chatId,
    floor: analysis.floor,
    swipeId: analysis.swipeId,
    message,
    plan: analysis.plan,
    images: analysis.images,
    changes: analysis.changes,
    autoGenerate: opts.autoGenerate,
    markDedupe: true,
  });
}

export type { RelocateOutcome };
export { relocatePlan };

export interface CandidateCommitOptions {
  signal?: AbortSignal;
  /** 覆盖「确认后是否自动出图」。缺省按当前偏好：确认式 = 出图。 */
  autoGenerate?: boolean;
}

/**
 * 确认一条候选：重定位 → 写回 →（按模式）自动出图 → 移出池子。
 *
 * 为什么不能复用捕获时的快照：`planSelection` 第一行就是「正文指纹不符即 stale」，
 * 而确认发生在几分钟甚至几天后，正文多半已经变过。所以走 `relocatePlan`：
 * 按锚点文本 + 前后文重新定位，再拿**当前**正文造计划 —— 绕开 stale，保留全部行号换算。
 */
export async function commitCandidate(imageId: string, opts: CandidateCommitOptions = {}): Promise<RunResult> {
  const item = findCandidate(imageId);
  if (!item) return failure(-1, 'candidate-missing', '这条候选已经不在了：可能刚确认过，或者换了聊天');
  const floor = item.floor;

  // draft（待生成）在结构上就没有版本可写。这里拦一句人话，而不是让下面读到 undefined 抛异常
  const version = item.versions[item.activeVersion];
  if (!version) {
    return skip(floor, 'not-generated', '这条还在待生成里，没有提示词：先点「生成 tag」再确认');
  }

  const context = getContext();
  if (!context) return skip(floor, 'missing-context', 'SillyTavern 还没就绪，请稍后重试');
  if (!settings.enabled) return skip(floor, 'extension-disabled', '柏宝绘已停用，请先在插件设置里开启');
  const chatId = context.getCurrentChatId?.() ?? '';
  if (chatId !== item.chatId) return skip(floor, 'chat-changed', '已切换聊天，这条候选属于原来的聊天');

  const message = context.chat?.[floor];
  if (!message || typeof message.mes !== 'string') {
    return failure(floor, 'message-not-found', '找不到候选对应的楼层，可能该楼已被删除');
  }
  if (!isAiStoryMessage(message)) return skip(floor, 'not-ai-story-message', '这一楼已经不是可插图的剧情楼层');

  const swipeId = typeof message.swipe_id === 'number' ? message.swipe_id : 0;
  if (swipeId !== item.swipeId) return skip(floor, 'swipe-changed', '已切换 swipe，这条候选对应的正文不在了');

  const relocated = relocatePlan(item.segments, message.mes, floor, swipeId, settings.excludes.customStripTags);
  if (!relocated.ok) {
    const reason = `这段文字已经被改过了（${relocated.detail ?? '无法定位'}）：请删掉这条候选，重新划线`;
    notify('warning', reason);
    return failure(floor, 'anchor-lost', reason);
  }

  // 确认就是出图的许可（§7.2）：确认式下 autoGenerate 被锁为关，这里凭 confirmTag 补上
  const autoGenerate = opts.autoGenerate ?? readPrefs().confirmTag;

  const run = beginFloorRun(chatId, floor, opts.signal);
  try {
    if (run.controller.signal.aborted) return result('aborted', '已取消');
    return await writeAndPublish({
      chatId,
      floor,
      swipeId,
      message,
      plan: relocated.plan,
      images: [version.image],
      changes: version.changes,
      autoGenerate,
      markDedupe: true,
      candidateId: item.imageId,
    });
  } finally {
    run.release();
  }
}

/**
 * 重 Roll：只重写这一张的提示词，**不写正文、不出图**。
 *
 * 用 `taskNote` 让模型知道「这是一次单张重写」：它仍能读到完整上下文与同一段正文，
 * 但只需要给一张、且要贴合同一段。这正是用户要的那件事 ——
 * 觉得画面不够好时，不该为此重画整张图、花掉图片额度。
 */
export async function rerollCandidate(imageId: string, opts: CandidateCommitOptions = {}): Promise<RunResult> {
  const item = findCandidate(imageId);
  if (!item) return failure(-1, 'candidate-missing', '这条候选已经不在了：可能刚确认过，或者换了聊天');
  const floor = item.floor;

  const context = getContext();
  if (!context) return skip(floor, 'missing-context', 'SillyTavern 还没就绪，请稍后重试');
  const chatId = context.getCurrentChatId?.() ?? '';
  if (chatId !== item.chatId) return skip(floor, 'chat-changed', '已切换聊天，这条候选属于原来的聊天');

  const message = context.chat?.[floor];
  if (!message || typeof message.mes !== 'string') {
    return failure(floor, 'message-not-found', '找不到候选对应的楼层，可能该楼已被删除');
  }
  const swipeId = typeof message.swipe_id === 'number' ? message.swipe_id : 0;
  if (swipeId !== item.swipeId) return skip(floor, 'swipe-changed', '已切换 swipe，这条候选对应的正文不在了');

  const relocated = relocatePlan(item.segments, message.mes, floor, swipeId, settings.excludes.customStripTags);
  if (!relocated.ok) {
    return failure(floor, 'anchor-lost', '这段文字已经被改过了，没法重 Roll：请删掉这条候选，重新划线');
  }

  const taskNote = [
    `这是一次「重 Roll」：只重写第 ${item.index + 1} 张画面的提示词。`,
    '- 画面仍要贴合同一段正文，不要换场景、不要换人物关系。',
    '- 只输出 1 张（images 数组只有 1 个元素），position 与上次相同。',
  ].join('\n');

  const outcome = await analyzeSelection(relocated.plan.capture, {
    signal: opts.signal,
    skipDedupe: true,
    singleImage: true,
    taskNote,
  });
  if (!outcome.ok) return outcome.result;

  const image = outcome.analysis.images[0];
  if (!image) return failure(floor, 'no-image', '模型这次没有给出画面，候选保持原样');

  // 中文对照跟着新版本走：留在外层的话，重 Roll 后卡片上的中文会停在上一版
  if (!addCandidateVersion(imageId, image, outcome.analysis.tagZh[0], outcome.analysis.charactersZh[0])) {
    return failure(floor, 'candidate-missing', '这条候选已经不在了，无法保存重 Roll 结果');
  }
  diagnostic('candidate:reroll', { floor, imageId, tagChars: image.tag.length });
  return result('pending', '已重 Roll：候选已更新，正文与图片都没动');
}

/** 当前协议形态（UI 想知道「现在是不是漫画方案」时用）。 */
export function currentProfile() {
  return autoTagProfile();
}
