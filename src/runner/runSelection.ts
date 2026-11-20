/**
 * 划线出图的编排层 —— 本插件唯一「有副作用」的地方。
 *
 * 它是上游 `autoTag/runner.ts` 的 `runForFloor`（197–633 行）的同构复刻，逐段对应：
 *
 *   上游                                    本文件
 *   --------------------------------------  ------------------------------------------
 *   208–243  上下文/开关/排除/剧情楼闸门     相同，另加「划线快照与当前楼层一致」的 CAS
 *   281–296  source = 整楼正文               ★ source = 划线切片（唯一实质差异）
 *   304–324  identity / 去重 / 每楼一把锁     只保留「每楼一把锁」（本插件点击即执行，不自动跑）
 *   327–352  memory / 库 / anchors / 协议快照 相同（库与记忆仍按整楼取，见 §5.3）
 *   358–433  重试循环（validate 内解析）      相同，解析目标换成切片 segments
 *   437–518  changes → ops、@替换、漫画补外貌  相同（见 runner/plan.ts）
 *   520–530  空结果早退                      相同
 *   547–585  applyMessageText CAS 写回        ★ rebase 的基底用整楼现文（§5.2 铁律 5）
 *   586–632  成功/失败反馈                    相同
 *
 * 每一段的差异都在注释里标了「★」，它们合计只有两项：
 *   ① 喂给 LLM 的目标正文来自划线，其余上下文口径一律照抄；
 *   ② 写回时 rebase 的 currentText 用整楼现文、plannedSegments 用切片绝对行号。
 *
 * 排错顺序（与工程方案 §9.2 一致）：先看 `[CCX][AutoTagDebug]` 的 `:start` 行，
 * sourceLength / segmentCount 不对就是取词错；再看到 `request:*` 与 `:skip reason=`。
 */

import { requestCompletion, requestViaMainApi } from '@/api/client';
import { readBookMemory } from '@/autoTag/bookMemory';
import { resolveCharAnchors } from '@/autoTag/charAnchors';
import { autoTagProfile, buildAutoTagMessages } from '@/autoTag/prompt';
import { injectImageTags, parseComicPlan, parseImagePlan, type ImagePlan } from '@/autoTag/protocol';
import { hashText } from '@/selection/hash';
import { computeSlotShifts, planSelection } from '@/selection/segmentPlan';
import type { CaptureFailure, SelectionCapture } from '@/selection/capture';
import { formatCaptureFailure } from '@/selection/capture';
import {
  BBI_CHAR_EXTRA_KEY,
  charTagsBeforeFloor,
  lockedCharTagNames,
  makeCharTagFloorDelta,
  readCharTagFloorDelta,
  recomputeCharTags,
} from '@/state/charTags';
import { getTagGenChannel, isCurrentChatExcluded, settings } from '@/state/settings';
import { migrateImageSlots } from '@/state/imageSlots';
import { parseImageTags } from '@/st/imageTagRegex';
import { applyMessageText, type ApplyMessageResult } from '@/st/messageEdit';
import { getContext, isAiStoryMessage } from '@/st/context';
import { notify } from '@/ui/notify';
import { diagnostic } from './diagnostic';
import {
  applyPlanPostProcess,
  buildWritebackText,
  describeRebase,
  filterLockedOps,
  planChangeOps,
} from './plan';

export type RunStatus = 'saved' | 'no-image' | 'aborted' | 'skipped' | 'failed';

export interface RunResult {
  status: RunStatus;
  /** 跳过/失败的原因码（稳定、可 grep；文案会变，码不会）。 */
  reason?: string;
  /** 本次实际写入的 tag 数。 */
  images: number;
  /** 本次应用的 changes 条数。 */
  changes: number;
  /** 给用户/日志的一句人话。 */
  message: string;
}

export interface RunOptions {
  /** 外部取消（例如用户切了聊天）。 */
  signal?: AbortSignal;
}

/**
 * 每楼一把锁：同一楼连续划线时，后一次取消前一次，避免两批 tag 交错插入。
 */
const running = new Map<string, AbortController>();

/**
 * 本会话内「这段划线已经写过 tag」的记忆：identity → 写完时本楼 tag 总数。
 *
 * 为什么要它：本插件是点击即执行，没有柏宝绘那种「已有 tag 就跳过」的自动闸门。
 * 同一段文字连点两次就会插两批 tag（用户多半只是想确认一下有没有生效）。
 * 判据刻意做得**可解释**：只有当本楼 tag 数仍 ≥ 上次写完的数量时才算「已经写过了」——
 * 用户删掉那几张卡片（tag 数变少）就自然放行，不需要任何额外操作。
 */
const written = new Map<string, number>();

const ABANDON_REASON: Partial<Record<ApplyMessageResult, string>> = {
  'chat-changed': '已切换聊天，本次没有写入生图 tag',
  'floor-changed': '该楼层已被删除或替换，本次没有写入生图 tag',
  'swipe-changed': '已切换 swipe，本次没有写入生图 tag',
  'build-failed': '楼层正文已被大幅改写，本次没有写入生图 tag',
  unavailable: '当前聊天不可写入，本次没有写入生图 tag',
};

function result(status: RunStatus, message: string, extra: Partial<RunResult> = {}): RunResult {
  return { status, message, images: 0, changes: 0, ...extra };
}

/** 放弃本次运行并交代原因：诊断日志记全量，用户侧给一句人话。 */
function skip(floor: number, reason: string, message: string, payload: Record<string, unknown> = {}): RunResult {
  diagnostic('runSelection:skip', { floor, reason, ...payload });
  return result('skipped', message, { reason });
}

function failure(floor: number, reason: string, message: string, payload: Record<string, unknown> = {}): RunResult {
  diagnostic('runSelection:fail', { floor, reason, ...payload });
  return result('failed', message, { reason });
}

/**
 * 划线捕获失败 → 用户可读文案。取词阶段失败必须当场说清，绝不降级成「拿整楼凑合」：
 * 那样用户以为在划这一句，出来的图却是另一段。
 */
export function describeCaptureFailure(reason: CaptureFailure, detail?: string): string {
  const base = formatCaptureFailure(reason);
  return detail ? `${base}（${detail}）` : base;
}

/**
 * 跑一次划线分析并写回 tag。
 *
 * 调用方（UI）负责先把 `captureSelection()` 的失败讲给用户听；本函数只处理成功捕获之后的一切。
 */
export async function runSelection(capture: SelectionCapture, opts: RunOptions = {}): Promise<RunResult> {
  const floor = capture.messageId;
  diagnostic('runSelection:enter', {
    floor,
    swipeId: capture.swipeId,
    chars: capture.text.length,
    lines: capture.lineCount,
    method: capture.method,
    candidates: capture.candidates,
    expanded: capture.expanded,
    chatId: getContext()?.getCurrentChatId?.() ?? '',
    extensionEnabled: settings.enabled,
  });

  const context = getContext();
  if (!context) return skip(floor, 'missing-context', 'SillyTavern 还没就绪，请稍后重试');
  // 柏宝绘停用时 tag 写进正文也不会有人渲染成卡片，等于往正文里扔死文本 —— 直接拦住
  if (!settings.enabled) return skip(floor, 'extension-disabled', '柏宝绘已停用，请先在插件设置里开启');
  if (isCurrentChatExcluded()) {
    return skip(floor, 'chat-excluded', '该角色已被排除，不生成生图 tag');
  }

  const message = context.chat?.[floor];
  if (!message || typeof message.mes !== 'string') {
    return failure(floor, 'message-not-found', '找不到选区对应的楼层数据，可能聊天刚切换或该楼已删除');
  }
  if (!isAiStoryMessage(message)) {
    return skip(floor, 'not-ai-story-message', '这一楼不是可插图的剧情楼层（用户楼 / ST 系统楼）');
  }
  const chatId = context.getCurrentChatId?.() ?? '';
  if (!chatId) return skip(floor, 'missing-chat-id', '当前没有打开的聊天');

  const swipeId = typeof message.swipe_id === 'number' ? message.swipe_id : 0;
  // 捕获时记下的 swipe 与当前不符 = 用户划完滑走了。此时正文已换，不能把 tag 写进去。
  if (capture.swipeId !== swipeId) {
    return skip(floor, 'swipe-changed', '已切换 swipe，请重新划线', {
      captured: capture.swipeId,
      current: swipeId,
    });
  }

  const rawSource = message.mes;
  if (!rawSource.trim()) return skip(floor, 'empty-source', '本楼正文是空的，没有可分析的内容');

  const stripTags = settings.excludes.customStripTags;
  const plan = planSelection(capture, rawSource, stripTags);
  if (!plan.ok) {
    const detail = plan.detail ?? '';
    if (plan.reason === 'stale') {
      return skip(floor, 'stale', '正文在你划线之后被改过了，请重新划线', { captureHash: capture.sourceHash });
    }
    if (plan.reason === 'empty-target') {
      return skip(floor, 'empty-target', '这段划线里没有可分析的叙事内容（可能被剔除标签名单全删了）', {
        sourceLength: capture.text.length,
        rawTextLength: rawSource.length,
      });
    }
    return failure(floor, plan.reason, `划线定位失败：${detail || plan.reason}`, {
      sourceLength: capture.text.length,
      start: capture.range.start,
      end: capture.range.end,
    });
  }
  const selectionPlan = plan.plan;

  const runKey = `${chatId}\u0000${floor}`;
  const identity = `${chatId}\u0000${floor}\u0000${swipeId}\u0000${hashText(selectionPlan.capture.text)}`;
  const tagCountNow = parseImageTags(rawSource).length;
  const tagCountAfterWrite = written.get(identity);
  if (tagCountAfterWrite !== undefined && tagCountNow >= tagCountAfterWrite) {
    return skip(
      floor,
      'already-processed',
      '这段划线已经出过图了。想重出请先在柏宝绘卡片里删掉那几张，再重新划线。',
      { identity, tagCountNow, tagCountAfterWrite },
    );
  }

  running.get(runKey)?.abort();
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (opts.signal?.aborted) controller.abort();
  else opts.signal?.addEventListener('abort', forwardAbort, { once: true });
  running.set(runKey, controller);

  diagnostic('runSelection:start', {
    floor,
    chatId,
    swipeId,
    identity,
    sourceLength: selectionPlan.promptText.length,
    segmentCount: selectionPlan.sliceSegments.length,
    absoluteStartLine: selectionPlan.absoluteSegments[0]?.sourceLine ?? null,
    absoluteEndLine: selectionPlan.absoluteSegments[selectionPlan.absoluteSegments.length - 1]?.sourceLine ?? null,
    divergent: selectionPlan.divergent,
  });

  try {
    // —— 上下文取数：与上游逐行一致。记忆仍按**整楼 mes**（角色在场是楼层级事实）——
    const memory = readBookMemory(floor, rawSource, context.name1);
    // 库取「本楼之前」的档案；本楼 AI 新建的档在本次 changes 里，由 @替换按位置门控生效
    const entriesBefore = charTagsBeforeFloor(floor);
    const lockedNames = lockedCharTagNames();
    const anchors = resolveCharAnchors(entriesBefore, lockedNames);

    // 协议形态开跑时快照一次：写协议、验收与收尾用同一份
    const profile = autoTagProfile();
    const promptOptions = settings.autoTag;
    const messages = await buildAutoTagMessages(
      context,
      floor,
      promptOptions,
      memory,
      // ★ 唯一替换点：把「整楼 preparedTarget」换成「划线切片」
      { promptText: selectionPlan.promptText, segments: selectionPlan.sliceSegments },
      anchors.text,
      '',
      profile,
    );

    const channel = getTagGenChannel();
    const retries = Math.max(0, Math.floor(Number(settings.autoTag.retryCount) || 0));
    let imagePlan: ImagePlan | null = null;
    let lastError = '';

    for (let attempt = 0; attempt <= retries && !imagePlan; attempt += 1) {
      if (controller.signal.aborted) return result('aborted', '已取消');
      try {
        const parsed: { plan: ImagePlan | null } = { plan: null };
        const validate = (raw: string) => {
          // 漫画不受张数上下限约束（页数由 AI 按内容定），只要求至少一页
          const candidate = profile.comic
            ? parseComicPlan(raw, selectionPlan.sliceSegments)
            : parseImagePlan(
                raw,
                selectionPlan.sliceSegments,
                promptOptions.minImages,
                promptOptions.maxImages,
              );
          // NAI 4.5/V5 + 自然语言：建档必须带 nl，缺了算协议不通过（与上游同一口径）
          if (
            profile.naiCharPrompts &&
            profile.nl &&
            candidate.changes.some(change => change.field === 'new' && !change.nl?.trim())
          ) {
            throw new Error('NAI 4.5/V5 建档必须附带 nl 外貌描述');
          }
          parsed.plan = candidate;
        };
        const source =
          retries > 0 ? `划线出图(第 ${floor} 楼 · 第 ${attempt + 1} 次)` : `划线出图(第 ${floor} 楼)`;

        if (channel) {
          await requestCompletion(channel, messages, { signal: controller.signal, source, validate });
        } else {
          await requestViaMainApi(messages, { signal: controller.signal, source, validate });
        }
        if (controller.signal.aborted) return result('aborted', '已取消');
        imagePlan = parsed.plan;
      } catch (error) {
        if (controller.signal.aborted) return result('aborted', '已取消');
        lastError = error instanceof Error ? error.message : String(error);
        console.warn(`[CCX] 第 ${floor} 楼第 ${attempt + 1}/${retries + 1} 次划线分析失败`, error);
      }
    }

    if (!imagePlan) {
      diagnostic('runSelection:fail', { floor, reason: 'retries-exhausted', lastError, retries });
      notify('error', `${lastError}${retries > 0 ? `（已自动重试 ${retries} 次）` : ''}`);
      return result('failed', lastError, { reason: 'retries-exhausted' });
    }

    // —— changes → ops（锁定角色丢弃），锁定名在重放侧还会再拦一次
    const planOps = planChangeOps(imagePlan);
    const effectiveOps = filterLockedOps(planOps, lockedNames);
    const floorOps = effectiveOps.map(item => item.op);
    const previousDelta = readCharTagFloorDelta(message);

    // —— 逐图后处理：nl 丢弃、画幅锁、@替换、漫画补外貌
    const unknownNames = applyPlanPostProcess(imagePlan, { profile, anchors, effectiveOps, lockedNames });
    if (unknownNames.size) {
      const names = [...unknownNames].join('、');
      console.warn('[CCX] 模型引用了库里没有的角色,已剥除占位符:', names);
      notify('warning', `角色「${names}」没有建档，本次画面中缺少其外貌`);
    }

    // 没有图片、没有角色变化、也没有旧楼层变化要清理时，保持无写入早退
    if (!imagePlan.images.length && !floorOps.length && !previousDelta) {
      diagnostic('runSelection:empty', { floor });
      notify('info', '模型认为这段划线没有值得插图的画面');
      return result('no-image', '模型认为这段划线没有值得插图的画面', { changes: floorOps.length });
    }

    // —— 写回：CAS（聊天 / 楼层 / swipe 身份一致），正文以「落盘那一刻」为基底现算
    let rebaseNote = '';
    let slotShifts: number[] = [];
    const applied = await applyMessageText(
      floor,
      currentText => {
        const base = currentText;
        if (!imagePlan?.images.length) return base;
        const built = buildWritebackText(selectionPlan, base, imagePlan.images, stripTags);
        if (!built.ok) {
          diagnostic('writeback:abort', { floor, reason: built.reason });
          return null;
        }
        rebaseNote = built.mode === 'rebased' && built.report ? describeRebase(built.report) : '';
        // 新 tag 若插在既有 tag 之前，既有 tag 的槽位序号会平移，图片历史就认错人。
        // 这里只算位移，真正迁移在正文写成功之后（写失败就不该动历史）。
        slotShifts = computeSlotShifts(base, built.images.map(image => image.sourceLine));
        return built.text;
      },
      chatId,
      swipeId,
      message,
      { key: BBI_CHAR_EXTRA_KEY, value: makeCharTagFloorDelta(floorOps, swipeId) },
    );

    if (applied === 'saved') {
      recomputeCharTags();
      if (imagePlan.images.length) written.set(identity, tagCountNow + imagePlan.images.length);

      // 旧 tag 的图必须留在自己身上：把被挤动的历史槽位一起后移（见 state/imageSlots.ts）
      const moved = await migrateImageSlots(context, context.chat?.[floor], swipeId, slotShifts);
      if (moved.changed) {
        console.info(`[CCX] 第 ${floor} 楼已有图的槽位序号后移：${moved.changed} 条记录`);
        diagnostic('runSelection:slotShift', { floor, swipeId, entries: moved.changed, shifts: slotShifts });
      } else if (moved.skipped) {
        diagnostic('runSelection:slotShift', { floor, swipeId, skipped: moved.skipped, shifts: slotShifts });
      }

      if (rebaseNote) console.info(`[CCX] 第 ${floor} 楼 tag 位置重定位:${rebaseNote}`);
      if (imagePlan.images.length) {
        notify(
          'success',
          profile.comic
            ? `已在第 ${floor} 楼插入 ${imagePlan.images.length} 页漫画分镜`
            : `已在第 ${floor} 楼插入 ${imagePlan.images.length} 个生图 tag`,
        );
      } else {
        notify('info', '模型认为这段划线没有值得插图的画面');
      }
      diagnostic('runSelection:saved', {
        floor,
        images: imagePlan.images.length,
        changes: floorOps.length,
        rebase: rebaseNote || 'none',
      });
      return result('saved', '已写入生图 tag', {
        images: imagePlan.images.length,
        changes: floorOps.length,
      });
    }

    console.info(`[CCX] 第 ${floor} 楼放弃写入生图 tag：${applied}`);
    notify('warning', ABANDON_REASON[applied] ?? '本次没有写入生图 tag');
    diagnostic('runSelection:abandon', { floor, result: applied });
    return result('failed', ABANDON_REASON[applied] ?? '本次没有写入生图 tag', { reason: applied });
  } catch (error) {
    if (controller.signal.aborted) return result('aborted', '已取消');
    const messageText = error instanceof Error ? error.message : String(error);
    console.error(`[CCX] 第 ${floor} 楼划线分析失败`, error);
    notify('error', messageText);
    diagnostic('runSelection:error', { floor, error });
    return result('failed', messageText, { reason: 'exception' });
  } finally {
    opts.signal?.removeEventListener('abort', forwardAbort);
    if (running.get(runKey) === controller) running.delete(runKey);
  }
}

/** 中止某楼在途的划线分析（切聊天 / 重复点击时用）。 */
export function cancelSelectionRun(floor: number): void {
  const chatId = getContext()?.getCurrentChatId?.() ?? '';
  running.get(`${chatId}\u0000${floor}`)?.abort();
}

/** 中止全部在途分析（切聊天时清场）。 */
export function cancelAllSelectionRuns(): void {
  for (const controller of running.values()) controller.abort();
  running.clear();
}

/** 仅供调试：把一段正文按整楼口径注入 tag（不做请求）。用于排查写回坐标。 */
export function previewInject(currentText: string, images: Parameters<typeof injectImageTags>[1]): string {
  return injectImageTags(currentText, images);
}
