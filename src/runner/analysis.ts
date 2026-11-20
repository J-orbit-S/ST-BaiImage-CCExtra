/**
 * 划线链路 A 段：**只分析、不写正文**。
 *
 * 这是 v0.2.0 `runSelection` 的前半段（闸门 → 上下文 → 请求 → 解析 → 后处理）原样抽出，
 * 唯一新增的是「跑完不落盘」。拆出来的目的就是让「生成 tag」成为一件单独的事：
 * 它可以只产出候选、等用户点头；也可以（全自动模式）紧接着交给写回段。
 *
 * 与上游的差异仍然只有一处：喂给模型的目标正文是**划线切片**，不是整楼。
 * 上下文、协议、重试、changes、后处理全部照抄 —— 这一条在 VENDORED.md 里是红线。
 */

import { requestCompletion, requestViaMainApi } from '@/api/client';
import { readBookMemory } from '@/autoTag/bookMemory';
import { resolveCharAnchors } from '@/autoTag/charAnchors';
import { autoTagProfile, buildAutoTagMessages, type AutoTagProfile } from '@/autoTag/prompt';
import {
  parseComicPlan,
  parseImagePlan,
  type CharChange,
  type ImageInsertion,
  type ImagePlan,
} from '@/autoTag/protocol';
import { planSelection, type SelectionPlan } from '@/selection/segmentPlan';
import { type CaptureFailure, type SelectionCapture, formatCaptureFailure } from '@/selection/capture';
import { buildSegmentAnchor, type SegmentAnchor } from '@/state/candidates';
import { charTagsBeforeFloor, lockedCharTagNames, readCharTagFloorDelta } from '@/state/charTags';
import { getTagGenChannel, isCurrentChatExcluded, settings } from '@/state/settings';
import { getContext, isAiStoryMessage } from '@/st/context';
import { parseImageTags } from '@/st/imageTagRegex';
import { notify } from '@/ui/notify';
import { diagnostic } from './diagnostic';
import { makeIdentity, processedTagCount } from './dedupe';
import { beginFloorRun } from './locks';
import { applyPlanPostProcess, filterLockedOps, planChangeOps } from './plan';
import { failure, result, skip, type RunResult } from './result';

/** 一次成功分析的完整快照，交给写回段（或候选池）时不再回头找宿主。 */
export interface SelectionAnalysis {
  chatId: string;
  floor: number;
  swipeId: number;
  /** 切片计划：`promptText` 是喂给模型的正文，`absoluteSegments` 用于写回换算。 */
  plan: SelectionPlan;
  /** 已后处理的图；`sourceLine` 仍是**切片内**行号（写回时由 plan 换算成整楼行号）。 */
  images: ImageInsertion[];
  /** 模型报告的 changes（未过滤锁定角色；写回时再过滤一次）。 */
  changes: CharChange[];
  profile: AutoTagProfile;
  /** 锚点快照：确认时可以拿它重新定位（正文变了也不至于插错）。 */
  segment: SegmentAnchor;
}

export type AnalyzeOutcome = { ok: true; analysis: SelectionAnalysis } | { ok: false; result: RunResult };

export interface AnalyzeOptions {
  signal?: AbortSignal;
  /** 重 Roll 不查「这段已经写过了」——用户就是想再要一版。 */
  skipDedupe?: boolean;
  /** 重 Roll 只要一张：把 min/max 都压成 1，模型不敢多给。 */
  singleImage?: boolean;
  /** 追加给模型的任务备注（重 Roll 时说明「只重写第 N 张」）。 */
  taskNote?: string;
}

/**
 * 划线捕获失败 → 用户可读文案。取词阶段失败必须当场说清，绝不降级成「拿整楼凑合」：
 * 那样用户以为在划这一句，出来的图却是另一段。
 */
export function describeCaptureFailure(reason: CaptureFailure, detail?: string): string {
  const base = formatCaptureFailure(reason);
  return detail ? `${base}（${detail}）` : base;
}

export async function analyzeSelection(capture: SelectionCapture, opts: AnalyzeOptions = {}): Promise<AnalyzeOutcome> {
  const floor = capture.messageId;
  diagnostic('analysis:enter', {
    floor,
    swipeId: capture.swipeId,
    chars: capture.text.length,
    lines: capture.lineCount,
    method: capture.method,
    candidates: capture.candidates,
    expanded: capture.expanded,
    chatId: getContext()?.getCurrentChatId?.() ?? '',
    extensionEnabled: settings.enabled,
    singleImage: Boolean(opts.singleImage),
  });

  const context = getContext();
  if (!context) return { ok: false, result: skip(floor, 'missing-context', 'SillyTavern 还没就绪，请稍后重试') };
  // 柏宝绘停用时 tag 写进正文也不会有人渲染成卡片，等于往正文里扔死文本 —— 直接拦住
  if (!settings.enabled) {
    return { ok: false, result: skip(floor, 'extension-disabled', '柏宝绘已停用，请先在插件设置里开启') };
  }
  if (isCurrentChatExcluded()) {
    return { ok: false, result: skip(floor, 'chat-excluded', '该角色已被排除，不生成生图 tag') };
  }

  const message = context.chat?.[floor];
  if (!message || typeof message.mes !== 'string') {
    return {
      ok: false,
      result: failure(floor, 'message-not-found', '找不到选区对应的楼层数据，可能聊天刚切换或该楼已删除'),
    };
  }
  if (!isAiStoryMessage(message)) {
    return { ok: false, result: skip(floor, 'not-ai-story-message', '这一楼不是可插图的剧情楼层（用户楼 / ST 系统楼）') };
  }
  const chatId = context.getCurrentChatId?.() ?? '';
  if (!chatId) return { ok: false, result: skip(floor, 'missing-chat-id', '当前没有打开的聊天') };

  const swipeId = typeof message.swipe_id === 'number' ? message.swipe_id : 0;
  // 捕获时记下的 swipe 与当前不符 = 用户划完滑走了。此时正文已换，不能把 tag 写进去。
  if (capture.swipeId !== swipeId) {
    return {
      ok: false,
      result: skip(floor, 'swipe-changed', '已切换 swipe，请重新划线', { captured: capture.swipeId, current: swipeId }),
    };
  }

  const rawSource = message.mes;
  if (!rawSource.trim()) return { ok: false, result: skip(floor, 'empty-source', '本楼正文是空的，没有可分析的内容') };

  const stripTags = settings.excludes.customStripTags;
  const plan = planSelection(capture, rawSource, stripTags);
  if (!plan.ok) {
    const detail = plan.detail ?? '';
    if (plan.reason === 'stale') {
      return {
        ok: false,
        result: skip(floor, 'stale', '正文在你划线之后被改过了，请重新划线', { captureHash: capture.sourceHash }),
      };
    }
    if (plan.reason === 'empty-target') {
      return {
        ok: false,
        result: skip(floor, 'empty-target', '这段划线里没有可分析的叙事内容（可能被剔除标签名单全删了）', {
          sourceLength: capture.text.length,
          rawTextLength: rawSource.length,
        }),
      };
    }
    return {
      ok: false,
      result: failure(floor, plan.reason, `划线定位失败：${detail || plan.reason}`, {
        sourceLength: capture.text.length,
        start: capture.range.start,
        end: capture.range.end,
      }),
    };
  }
  const selectionPlan = plan.plan;

  const identity = makeIdentity(chatId, floor, swipeId, selectionPlan.capture.text);
  const tagCountNow = parseImageTags(rawSource).length;
  const tagCountAfterWrite = processedTagCount(identity);
  if (!opts.skipDedupe && tagCountAfterWrite !== undefined && tagCountNow >= tagCountAfterWrite) {
    return {
      ok: false,
      result: skip(
        floor,
        'already-processed',
        '这段划线已经出过图了。想重出请先在柏宝绘卡片里删掉那几张，再重新划线。',
        { identity, tagCountNow, tagCountAfterWrite },
      ),
    };
  }

  const run = beginFloorRun(chatId, floor, opts.signal);
  try {
    // —— 上下文取数：与上游逐行一致。记忆仍按**整楼 mes**（角色在场是楼层级事实）——
    const memory = readBookMemory(floor, rawSource, context.name1);
    // 库取「本楼之前」的档案；本楼 AI 新建的档在本次 changes 里，由 @替换按位置门控生效
    const entriesBefore = charTagsBeforeFloor(floor);
    const lockedNames = lockedCharTagNames();
    const anchors = resolveCharAnchors(entriesBefore, lockedNames);

    // 协议形态开跑时快照一次：写协议、验收与收尾用同一份
    const profile = autoTagProfile();
    const baseOptions = settings.autoTag;
    // 重 Roll：只让模型给一张，避免「重 Roll 一张却回来三张」
    const promptOptions = opts.singleImage ? { ...baseOptions, minImages: 1, maxImages: 1 } : baseOptions;
    const messages = await buildAutoTagMessages(
      context,
      floor,
      promptOptions,
      memory,
      // ★ 唯一替换点：把「整楼 preparedTarget」换成「划线切片」
      { promptText: selectionPlan.promptText, segments: selectionPlan.sliceSegments },
      anchors.text,
      opts.taskNote ?? '',
      profile,
    );

    const channel = getTagGenChannel();
    const retries = Math.max(0, Math.floor(Number(settings.autoTag.retryCount) || 0));
    let imagePlan: ImagePlan | null = null;
    let lastError = '';

    for (let attempt = 0; attempt <= retries && !imagePlan; attempt += 1) {
      if (run.controller.signal.aborted) return { ok: false, result: result('aborted', '已取消') };
      try {
        const parsed: { plan: ImagePlan | null } = { plan: null };
        const validate = (raw: string) => {
          // 漫画不受张数上下限约束（页数由 AI 按内容定），只要求至少一页
          const candidate = profile.comic
            ? parseComicPlan(raw, selectionPlan.sliceSegments)
            : parseImagePlan(raw, selectionPlan.sliceSegments, promptOptions.minImages, promptOptions.maxImages);
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
        const label = opts.singleImage ? '重 Roll' : '划线出图';
        const source = retries > 0 ? `${label}(第 ${floor} 楼 · 第 ${attempt + 1} 次)` : `${label}(第 ${floor} 楼)`;

        if (channel) {
          await requestCompletion(channel, messages, { signal: run.controller.signal, source, validate });
        } else {
          await requestViaMainApi(messages, { signal: run.controller.signal, source, validate });
        }
        if (run.controller.signal.aborted) return { ok: false, result: result('aborted', '已取消') };
        imagePlan = parsed.plan;
      } catch (error) {
        if (run.controller.signal.aborted) return { ok: false, result: result('aborted', '已取消') };
        lastError = error instanceof Error ? error.message : String(error);
        console.warn(`[CCX] 第 ${floor} 楼第 ${attempt + 1}/${retries + 1} 次划线分析失败`, error);
      }
    }

    if (!imagePlan) {
      diagnostic('analysis:fail', { floor, reason: 'retries-exhausted', lastError, retries });
      notify('error', `${lastError}${retries > 0 ? `（已自动重试 ${retries} 次）` : ''}`);
      return { ok: false, result: result('failed', lastError, { reason: 'retries-exhausted' }) };
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
      diagnostic('analysis:empty', { floor });
      notify('info', '模型认为这段划线没有值得插图的画面');
      return { ok: false, result: result('no-image', '模型认为这段划线没有值得插图的画面', { changes: floorOps.length }) };
    }

    return {
      ok: true,
      analysis: {
        chatId,
        floor,
        swipeId,
        plan: selectionPlan,
        images: imagePlan.images,
        changes: imagePlan.changes,
        profile,
        segment: buildSegmentAnchor(chatId, selectionPlan.capture, rawSource),
      },
    };
  } catch (error) {
    if (run.controller.signal.aborted) return { ok: false, result: result('aborted', '已取消') };
    const text = error instanceof Error ? error.message : String(error);
    console.error(`[CCX] 第 ${floor} 楼划线分析失败`, error);
    notify('error', text);
    diagnostic('analysis:error', { floor, error });
    return { ok: false, result: result('failed', text, { reason: 'exception' }) };
  } finally {
    run.release();
  }
}

