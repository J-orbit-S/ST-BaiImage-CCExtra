/**
 * 划线链路 A 段：**只分析、不写正文**。
 *
 * 这是 v0.2.0 `runSelection` 的前半段（闸门 → 上下文 → 请求 → 解析 → 后处理）原样抽出，
 * 唯一新增的是「跑完不落盘」。拆出来的目的就是让「生成 tag」成为一件单独的事：
 * 它可以只产出候选、等用户点头；也可以（全自动模式）紧接着交给写回段。
 *
 * v0.2.2 起它多了一个入口：`analyzeBatch`——把「待生成」里同楼的 N 段拼成一个伪造楼层，
 * **一次调用**出 N 张图。它走的是同一套闸门、同一套上下文、同一套后处理，
 * 只是 `preparedTargetOverride` 由拼装层自己造（见 §6.2 的拼装规则）。
 *
 * 与上游的差异（VENDORED.md 红线）：
 *   ① 喂给模型的目标正文是**划线切片**（批量时是「多处切片拼成的伪楼层」），不是整楼；
 *   ② taskBlock 里可能多一句「顺手给一份中文对照」（可由偏好关掉）。
 * 上下文、协议、重试、changes、后处理全部照抄。
 */

import { requestCompletion, requestViaMainApi } from '@/api/client';
import { readBookMemory } from '@/autoTag/bookMemory';
import { resolveCharAnchors } from '@/autoTag/charAnchors';
import type { TargetSegment } from '@/autoTag/clean';
import { autoTagProfile, buildAutoTagMessages, type AutoTagProfile } from '@/autoTag/prompt';
import {
  parseComicPlan,
  parseImagePlan,
  type CharChange,
  type ImageInsertion,
  type ImagePlan,
} from '@/autoTag/protocol';
import { extractCharactersZh, extractTagZh, TAG_ZH_TASK_NOTE } from '@/autoTag/tagZh';
import { hashText } from '@/selection/hash';
import { relocatePlan } from '@/selection/relocate';
import { planSelection, type SelectionPlan } from '@/selection/segmentPlan';
import { type CaptureFailure, type SelectionCapture, formatCaptureFailure } from '@/selection/capture';
import { buildSegmentAnchor, type SegmentAnchor } from '@/state/candidates';
import { charTagsBeforeFloor, lockedCharTagNames, readCharTagFloorDelta } from '@/state/charTags';
import { readPrefs } from '@/state/prefs';
import { getTagGenChannel, isCurrentChatExcluded, settings, type AutoTagSettings } from '@/state/settings';
import { getContext, isAiStoryMessage, type STContext, type STMessage } from '@/st/context';
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
  /** Base tag 的中文对照，与 `images` 同下标；空串 = 模型没给。只给人看，绝不写回。 */
  tagZh: string[];
  /** 角色分项的中文对照，与 `images` 同下标（每项再与该图 characters[] 同下标）。 */
  charactersZh: string[][];
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

/**
 * 楼层级的公共前置：宿主、开关、排除名单、楼层、swipe、正文。
 * 单段与批量共用同一份，避免两条路径各判一次（那正是 v0.2.1 §8.2 那个 bug 的形状）。
 */
interface FloorEnv {
  context: STContext;
  message: STMessage;
  chatId: string;
  floor: number;
  swipeId: number;
  rawSource: string;
}

type EnvOutcome = { ok: true; env: FloorEnv } | { ok: false; result: RunResult };

function loadFloorEnv(floor: number, swipeId: number): EnvOutcome {
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

  const currentSwipe = typeof message.swipe_id === 'number' ? message.swipe_id : 0;
  // 捕获时记下的 swipe 与当前不符 = 用户划完滑走了。此时正文已换，不能把 tag 写进去。
  if (swipeId !== currentSwipe) {
    return {
      ok: false,
      result: skip(floor, 'swipe-changed', '已切换 swipe，请重新划线', { captured: swipeId, current: currentSwipe }),
    };
  }

  const rawSource = message.mes;
  if (!rawSource.trim()) return { ok: false, result: skip(floor, 'empty-source', '本楼正文是空的，没有可分析的内容') };
  return { ok: true, env: { context, message, chatId, floor, swipeId, rawSource } };
}

/** 上下文取数的快照：记忆按**整楼**取（角色在场是楼层级事实），库取本楼之前的档案。 */
interface PromptEnv extends FloorEnv {
  memory: ReturnType<typeof readBookMemory>;
  anchors: ReturnType<typeof resolveCharAnchors>;
  lockedNames: ReadonlySet<string>;
  profile: AutoTagProfile;
  stripTags: string[];
}

function loadPromptEnv(env: FloorEnv): PromptEnv {
  const memory = readBookMemory(env.floor, env.rawSource, env.context.name1);
  const entriesBefore = charTagsBeforeFloor(env.floor);
  const lockedNames = lockedCharTagNames();
  return {
    ...env,
    memory,
    anchors: resolveCharAnchors(entriesBefore, lockedNames),
    lockedNames,
    profile: autoTagProfile(),
    stripTags: settings.excludes.customStripTags,
  };
}

/** 中文对照的输出要求：开关关着、或者当前是漫画方案（没有 tag 键）时都不加。 */
function zhNoteFor(profile: AutoTagProfile): string {
  if (profile.comic) return '';
  return readPrefs().tagZhPreview ? TAG_ZH_TASK_NOTE : '';
}

function mergeTaskNote(taskNote: string | undefined, zh: string): string {
  return [taskNote?.trim(), zh].filter(Boolean).join('\n\n');
}

/** 一次请求 + 重试 + 验收。原始响应文本同时用来取中文对照（协议是 vendored 的，不能加字段）。 */
async function requestPlan(params: {
  env: PromptEnv;
  prepared: { promptText: string; segments: TargetSegment[] };
  promptOptions: AutoTagSettings;
  taskNote: string;
  label: string;
  signal?: AbortSignal;
}): Promise<{ ok: true; plan: ImagePlan; tagZh: string[]; charactersZh: string[][] } | { ok: false; result: RunResult }> {
  const { env, prepared, promptOptions, taskNote, label, signal } = params;
  const { context, floor, profile } = env;

  const messages = await buildAutoTagMessages(
    context,
    floor,
    promptOptions,
    env.memory,
    // ★ 唯一替换点：把「整楼 preparedTarget」换成「划线切片 / 拼装的伪楼层」
    prepared,
    env.anchors.text,
    taskNote,
    profile,
  );

  const channel = getTagGenChannel();
  const retries = Math.max(0, Math.floor(Number(settings.autoTag.retryCount) || 0));
  let imagePlan: ImagePlan | null = null;
  let tagZh: string[] = [];
  let charactersZh: string[][] = [];
  let lastError = '';

  for (let attempt = 0; attempt <= retries && !imagePlan; attempt += 1) {
    if (signal?.aborted) return { ok: false, result: result('aborted', '已取消') };
    try {
      const parsed: { plan: ImagePlan | null; tagZh: string[]; charactersZh: string[][] } = { plan: null, tagZh: [], charactersZh: [] };
      const validate = (raw: string) => {
        // 漫画不受张数上下限约束（页数由 AI 按内容定），只要求至少一页
        const candidate = profile.comic
          ? parseComicPlan(raw, prepared.segments)
          : parseImagePlan(raw, prepared.segments, promptOptions.minImages, promptOptions.maxImages);
        // NAI 4.5/V5 + 自然语言：建档必须带 nl，缺了算协议不通过（与上游同一口径）
        if (
          profile.naiCharPrompts &&
          profile.nl &&
          candidate.changes.some(change => change.field === 'new' && !change.nl?.trim())
        ) {
          throw new Error('NAI 4.5/V5 建档必须附带 nl 外貌描述');
        }
        parsed.plan = candidate;
        // 中文对照只在插画方案下取（漫画没有 tag 键）；任何脏值都安全降级成空
        if (!profile.comic) {
          parsed.tagZh = extractTagZh(raw);
          parsed.charactersZh = extractCharactersZh(raw);
        }
      };
      const source = retries > 0 ? `${label}(第 ${floor} 楼 · 第 ${attempt + 1} 次)` : `${label}(第 ${floor} 楼)`;

      if (channel) {
        await requestCompletion(channel, messages, { signal, source, validate });
      } else {
        await requestViaMainApi(messages, { signal, source, validate });
      }
      if (signal?.aborted) return { ok: false, result: result('aborted', '已取消') };
      imagePlan = parsed.plan;
      tagZh = parsed.plan ? parsed.tagZh : [];
      charactersZh = parsed.plan ? parsed.charactersZh : [];
    } catch (error) {
      if (signal?.aborted) return { ok: false, result: result('aborted', '已取消') };
      lastError = error instanceof Error ? error.message : String(error);
      console.warn(`[CCX] 第 ${floor} 楼第 ${attempt + 1}/${retries + 1} 次${label}失败`, error);
    }
  }

  if (!imagePlan) {
    diagnostic('analysis:fail', { floor, reason: 'retries-exhausted', lastError, retries });
    notify('error', `${lastError}${retries > 0 ? `（已自动重试 ${retries} 次）` : ''}`);
    return { ok: false, result: result('failed', lastError, { reason: 'retries-exhausted' }) };
  }
  return { ok: true, plan: imagePlan, tagZh, charactersZh };
}

/** 后处理 + changes → ops。返回过滤后的 ops（锁定角色丢弃）与「库外角色」清单。 */
function postProcess(env: PromptEnv, plan: ImagePlan): { effectiveOps: ReturnType<typeof planChangeOps>; unknownNames: Set<string> } {
  const planOps = planChangeOps(plan);
  const effectiveOps = filterLockedOps(planOps, env.lockedNames);
  const unknownNames = applyPlanPostProcess(plan, {
    profile: env.profile,
    anchors: env.anchors,
    effectiveOps,
    lockedNames: env.lockedNames,
  });
  if (unknownNames.size) {
    const names = [...unknownNames].join('、');
    console.warn('[CCX] 模型引用了库里没有的角色,已剥除占位符:', names);
    notify('warning', `角色「${names}」没有建档，本次画面中缺少其外貌`);
  }
  return { effectiveOps, unknownNames };
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

  const loaded = loadFloorEnv(floor, capture.swipeId);
  if (!loaded.ok) return { ok: false, result: loaded.result };
  const env = loadPromptEnv(loaded.env);

  const plan = planSelection(capture, env.rawSource, env.stripTags);
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
          rawTextLength: env.rawSource.length,
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

  const identity = makeIdentity(env.chatId, floor, env.swipeId, selectionPlan.capture.text);
  const tagCountNow = parseImageTags(env.rawSource).length;
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

  const run = beginFloorRun(env.chatId, floor, opts.signal);
  try {
    // 重 Roll：只让模型给一张，避免「重 Roll 一张却回来三张」
    const promptOptions = opts.singleImage
      ? { ...settings.autoTag, minImages: 1, maxImages: 1 }
      : { ...settings.autoTag };
    const requested = await requestPlan({
      env,
      prepared: { promptText: selectionPlan.promptText, segments: selectionPlan.sliceSegments },
      promptOptions,
      taskNote: mergeTaskNote(opts.taskNote, zhNoteFor(env.profile)),
      label: opts.singleImage ? '重 Roll' : '划线出图',
      signal: run.controller.signal,
    });
    if (!requested.ok) return { ok: false, result: requested.result };

    const imagePlan = requested.plan;
    const { effectiveOps } = postProcess(env, imagePlan);
    const floorOps = effectiveOps.map(item => item.op);
    const previousDelta = readCharTagFloorDelta(env.message);

    // 没有图片、没有角色变化、也没有旧楼层变化要清理时，保持无写入早退
    if (!imagePlan.images.length && !floorOps.length && !previousDelta) {
      diagnostic('analysis:empty', { floor });
      notify('info', '模型认为这段划线没有值得插图的画面');
      return { ok: false, result: result('no-image', '模型认为这段划线没有值得插图的画面', { changes: floorOps.length }) };
    }

    return {
      ok: true,
      analysis: {
        chatId: env.chatId,
        floor,
        swipeId: env.swipeId,
        plan: selectionPlan,
        images: imagePlan.images,
        changes: imagePlan.changes,
        tagZh: requested.tagZh,
        charactersZh: imagePlan.images.map((_, index) => requested.charactersZh[index] ?? []),
        profile: env.profile,
        segment: buildSegmentAnchor(env.chatId, selectionPlan.capture, env.rawSource),
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

/* ============================ 批量（一键全生成） ============================ */

export interface BatchItem {
  imageId: string;
  anchor: SegmentAnchor;
}

export interface BatchPayload {
  imageId: string;
  /** 这一段拿到的图（`sourceLine` 已换算回**该段自己的切片**行号）。理论上一张。 */
  images: ImageInsertion[];
  /** 归属于这一段的角色库变更（已换算成该段切片行号）。 */
  changes: CharChange[];
  /** 与 `images` 同下标的中文对照。 */
  tagZh: string[];
  /** 该段那张图的分项中文对照，与其 characters[] 同下标。 */
  charactersZh: string[];
}

export interface BatchAnalysis {
  chatId: string;
  floor: number;
  swipeId: number;
  profile: AutoTagProfile;
  /** 有图的条目。没有的见 `missing`。 */
  payloads: BatchPayload[];
  /** 模型没给图的条目（调用方决定补发还是留作待生成）。 */
  missing: string[];
  /** 锚点失效、本次没参与的条目。 */
  skipped: Array<{ imageId: string; reason: string }>;
  /** 模型多给的图（一段要一张，多出来的丢弃）。仅用于诊断。 */
  droppedImages: number;
}

export type BatchOutcome = { ok: true; batch: BatchAnalysis } | { ok: false; result: RunResult };

/**
 * 段与段之间的说明行。
 *
 * **不进 `segments`，所以没有 P 编号** —— 模型不可能把它当成插入位置。
 * 这句话不是修辞：不说清，模型会把「吻手背 → 整理领带 → 抱上桌」理解成一套连续动作，
 * 三张图互相呼应；而待生成列表要的是三个独立瞬间（VOLUME2.md R10）。
 */
const SEGMENT_GAP = '……（以下跳到本楼更后面的一处所选段落，中间省略的剧情不在本轮画面范围内）……';

interface ComposedLine {
  text: string;
  /** 整楼真实行号。 */
  absLine: number;
  /** 该段自己切片里的行号（写回时按它换算）。 */
  sliceLine: number;
  owner: string;
}

/**
 * 一键全生成：同楼的多条 draft **一次调用**出多张图。
 *
 * 省的是 system prompt 与上下文楼层（每段单独跑都要重付一遍），输出 token 省不了。
 * 三条纪律写在实现里：
 * - `minImages = 0`：`parseImagePlan` 在数量不足时会 throw，设 0 才不会因为「模型只给 2 张」
 *   把整批判失败、逼出一次重试（比逐段还贵）。缺的段自己补，第一次的成果不推翻。
 * - 段间不连续要说明（`SEGMENT_GAP`），否则三张图会互相呼应。
 * - 调用方必须按 `(floor, swipeId)` 分组：跨楼合在一起会让 12 楼的段读到 13 楼的前文。
 */
export async function analyzeBatch(floor: number, swipeId: number, items: BatchItem[], opts: { signal?: AbortSignal } = {}): Promise<BatchOutcome> {
  if (!items.length) return { ok: false, result: skip(floor, 'no-items', '没有待生成的选段') };

  const loaded = loadFloorEnv(floor, swipeId);
  if (!loaded.ok) return { ok: false, result: loaded.result };
  const env = loadPromptEnv(loaded.env);

  if (env.profile.comic) {
    return {
      ok: false,
      result: skip(floor, 'comic-batch-unsupported', '当前是漫画方案：一键生成只支持插画方案，请逐段生成'),
    };
  }

  // ① 逐段重定位（正文可能已经变过），失败的那段跳过、其余继续
  const composed: ComposedLine[] = [];
  const skipped: Array<{ imageId: string; reason: string }> = [];
  for (const item of items) {
    const relocated = relocatePlan([item.anchor], env.rawSource, floor, env.swipeId, env.stripTags);
    if (!relocated.ok) {
      skipped.push({ imageId: item.imageId, reason: relocated.detail ?? relocated.reason });
      continue;
    }
    // 只取清洗后的叙事行：与单段路径的 promptText 同源（prepareTargetText 已按行过滤噪声）
    relocated.plan.sliceSegments.forEach((segment, index) => {
      const absolute = relocated.plan.absoluteSegments[index];
      if (!absolute) return;
      composed.push({ text: segment.text, absLine: absolute.sourceLine, sliceLine: segment.sourceLine, owner: item.imageId });
    });
  }
  if (!composed.length) {
    return {
      ok: false,
      result: failure(floor, 'anchor-lost', '这些选段的原文都被改过了，没法生成：请删掉它们重新划线', { skipped }),
    };
  }

  // ② 按整楼行号排序，**全局重编 P1..Pn**（各段自己编号会撞号）
  composed.sort((left, right) => left.absLine - right.absLine);
  const segments: TargetSegment[] = composed.map((line, index) => ({ id: `P${index + 1}`, sourceLine: index, text: line.text }));
  const absoluteSegments: TargetSegment[] = composed.map((line, index) => ({
    id: `P${index + 1}`,
    sourceLine: line.absLine,
    text: line.text,
  }));

  const parts: string[] = [];
  let lastOwner = '';
  composed.forEach((line, index) => {
    if (lastOwner && line.owner !== lastOwner) parts.push(SEGMENT_GAP);
    parts.push(`${line.text} ⟦P${index + 1}⟧`);
    lastOwner = line.owner;
  });

  const capture: SelectionCapture = {
    messageId: floor,
    swipeId: env.swipeId,
    // 指纹取「此刻的正文」：写回时若正文没变就直接按行号落，变了交给 rebase 按文本重锚
    sourceHash: hashText(env.rawSource),
    range: { start: 0, end: env.rawSource.length },
    text: env.rawSource,
    domText: '',
    method: 'strict',
    candidates: 1,
    expanded: false,
    lineCount: 1,
  };
  const plan: SelectionPlan = {
    capture,
    promptText: parts.join('\n\n'),
    sliceSegments: segments,
    absoluteSegments,
    divergent: false,
  };

  const expected = new Set(composed.map(line => line.owner)).size;
  const taskNote = mergeTaskNote(
    [
      `【本轮说明】目标正文由本楼里 ${expected} 处**互不相邻**的选段拼成，段与段之间省略了剧情（用「……」标出）。`,
      `- 每一处选段都必须恰好产出 1 张图：images 数量 = ${expected}，不要给某一段两张、也不要漏掉任何一段。`,
      '- 各段是相互独立的瞬间：不要把上一段的动作、情绪或道具带进下一段，也不要把它们连成一套连续动作。',
      '- position 填该段自己的 P 编号。',
    ].join('\n'),
    zhNoteFor(env.profile),
  );

  const run = beginFloorRun(env.chatId, floor, opts.signal);
  try {
    const requested = await requestPlan({
      env,
      prepared: { promptText: plan.promptText, segments },
      // 下限 0 是关键：见函数头。上限压到段数，模型多给的会被 parseImagePlan 截掉
      promptOptions: { ...settings.autoTag, minImages: 0, maxImages: Math.max(1, expected) },
      taskNote,
      label: '一键生成',
      signal: run.controller.signal,
    });
    if (!requested.ok) return { ok: false, result: requested.result };

    const imagePlan = requested.plan;
    postProcess(env, imagePlan);

    const byOwner = new Map<string, BatchPayload>();
    for (const item of items) {
      byOwner.set(item.imageId, { imageId: item.imageId, images: [], changes: [], tagZh: [], charactersZh: [] });
    }
    let droppedImages = 0;
    imagePlan.images.forEach((image, index) => {
      const line = composed[image.sourceLine];
      if (!line) return;
      const payload = byOwner.get(line.owner);
      if (!payload) return;
      if (payload.images.length) {
        // 一段要一张：多给的直接丢，不悄悄变成两个版本（那会让「确认」变成二选一）
        droppedImages += 1;
        return;
      }
      // 换算回该段自己的切片行号：之后 commitCandidate 会按同一段重新定位，
      // 两边的行号必须在同一个坐标系里，否则 tag 会插到段的开头。
      payload.images.push({ ...image, sourceLine: line.sliceLine });
      const zh = requested.tagZh[index];
      payload.tagZh.push(zh ?? '');
      payload.charactersZh = requested.charactersZh[index] ?? [];
    });
    for (const change of imagePlan.changes) {
      const line = composed[change.sourceLine];
      if (!line) continue;
      const payload = byOwner.get(line.owner);
      if (!payload) continue;
      // changes 也按段归属：这样「确认第一条」时只写它自己那部分建档，不会重复
      payload.changes.push({ ...change, sourceLine: line.sliceLine });
    }

    const payloads: BatchPayload[] = [];
    const missing: string[] = [];
    for (const [imageId, payload] of byOwner) {
      if (payload.images.length) payloads.push(payload);
      else missing.push(imageId);
    }

    diagnostic('analysis:batch', {
      floor,
      requested: items.length,
      generated: payloads.length,
      missing: missing.length,
      skipped: skipped.length,
      droppedImages,
    });

    return {
      ok: true,
      batch: {
        chatId: env.chatId,
        floor,
        swipeId: env.swipeId,
        profile: env.profile,
        payloads,
        missing,
        skipped,
        droppedImages,
      },
    };
  } catch (error) {
    if (run.controller.signal.aborted) return { ok: false, result: result('aborted', '已取消') };
    const text = error instanceof Error ? error.message : String(error);
    notify('error', text);
    diagnostic('analysis:batchError', { floor, error });
    return { ok: false, result: result('failed', text, { reason: 'exception' }) };
  } finally {
    run.release();
  }
}
