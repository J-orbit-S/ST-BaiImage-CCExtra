/**
 * 候选池：LLM 已经回来了、但还没写进正文的那批画面。
 *
 * 为什么需要它（V2.0「确认式」的落点）：
 *   原来 `runSelection` 是一条链 —— 解析完立刻写回、写完立刻出图。于是「这句台词画得不好」
 *   只能整段重跑，既花了副 API 的文本额度，又可能把已经满意的另一张图一起换掉。
 *   把「解析」与「写回」之间切一刀，中间放这个池子，三件事就各自独立：
 *     生成 tag（花副 API） / 重 Roll（还是副 API，但只重写这一张） / 出图（花柏宝绘）
 *
 * 为什么存 `chatMetadata` 而不是 `extensionSettings`：
 *   后者是全局设置，换聊天会把 A 聊的候选带到 B 聊 —— 用户会看到一段跟自己无关的 tag。
 *   候选天然属于「这一次聊天」，随聊天备份/删除才合理。读写口径照抄 `state/imageSlots.ts`：
 *   结构不认识就跳过，绝不因为池子坏了把主流程打断。
 *
 * 为什么「图」是单位、「段」只是引用（而不是反过来）：
 *   多段落批量是「N 段 → N 张图」，漫画页是「N 段 → 1 页」，段画不出后者这种关系。
 *   所以候选持有 `segments[]`（单插图时长度为 1），将来漫画页只需让长度变成 N，
 *   不必推翻这里的数据结构。
 */

import type { CharChange, ImageInsertion } from '@/autoTag/protocol';
import { hashText } from '@/selection/hash';
import type { SelectionCapture } from '@/selection/capture';
import { lineIndexAt } from '@/selection/segmentPlan';
import { getContext, type STContext } from '@/st/context';

/** 与插件目录同名：既是 chatMetadata 的键，也方便用户在导出的聊天里认出这是谁写的。 */
export const CANDIDATES_KEY = 'ST-BaiImage-CCExtra';

/** 锚点上下文取多长（每侧）。够长才能在同楼重复句里挑对，又不会把整个池子撑大。 */
const ANCHOR_CONTEXT_CHARS = 200;

export interface SegmentAnchor {
  segmentId: string;
  /** 选段原文（= 该段的目标正文）。重定位时拿它当 needle。 */
  text: string;
  /** 选区之前的原文（消歧用）。 */
  before: string;
  /** 选区之后的原文。 */
  after: string;
  /** 生成时的整楼行号，只作诊断；确认时一律重新定位。 */
  startLine: number;
  endLine: number;
}

export interface CandidateVersion {
  /** 已后处理的图（nl 丢弃 / 画幅锁 / @替换都做过），`sourceLine` 仍是**切片内**行号。 */
  image: ImageInsertion;
  /**
   * 这一版带来的角色库变更。整个 plan 里只有第 0 张带 changes，其余为空 ——
   * 否则同一段一次出两张图时，确认两张会把建档做两遍。
   */
  changes: CharChange[];
  createdAt: number;
}

export type CandidateStatus = 'pending' | 'committed' | 'discarded';

export interface ImageCandidate {
  /** 稳定 ID：`planId:index`。同一段重跑命中同一个 ID，因此是「追加版本」而不是新建卡片。 */
  imageId: string;
  /** 一次分析 = 一个 plan。重 Roll 时据此判定「是不是同一批」。 */
  planId: string;
  chatId: string;
  floor: number;
  swipeId: number;
  /** 这张图取材于哪几段。单插图 = 长度 1；漫画页将来 = 长度 N。 */
  segments: SegmentAnchor[];
  /** 该图在原始 plan 里的序号（0 基）。重 Roll 用它告诉模型「只重写第 N 张」。 */
  index: number;
  versions: CandidateVersion[];
  activeVersion: number;
  status: CandidateStatus;
  createdAt: number;
  updatedAt: number;
}

interface StoreV1 {
  v: 1;
  items: ImageCandidate[];
}

type Listener = () => void;

const listeners = new Set<Listener>();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isInsertion(value: unknown): value is ImageInsertion {
  return isPlainObject(value) && nonEmptyString(value.tag) && typeof value.sourceLine === 'number';
}

function normalizeAnchor(raw: unknown): SegmentAnchor | null {
  if (!isPlainObject(raw)) return null;
  if (!nonEmptyString(raw.segmentId) || !nonEmptyString(raw.text)) return null;
  return {
    segmentId: raw.segmentId,
    text: raw.text,
    before: typeof raw.before === 'string' ? raw.before : '',
    after: typeof raw.after === 'string' ? raw.after : '',
    startLine: Number.isInteger(raw.startLine) ? (raw.startLine as number) : 0,
    endLine: Number.isInteger(raw.endLine) ? (raw.endLine as number) : 0,
  };
}

function normalizeVersion(raw: unknown): CandidateVersion | null {
  if (!isPlainObject(raw) || !isInsertion(raw.image)) return null;
  const changes = Array.isArray(raw.changes)
    ? raw.changes.filter((item): item is CharChange => isPlainObject(item) && nonEmptyString(item.name))
    : [];
  return {
    image: raw.image,
    changes,
    createdAt: Number.isFinite(raw.createdAt) ? (raw.createdAt as number) : Date.now(),
  };
}

function normalizeCandidate(raw: unknown): ImageCandidate | null {
  if (!isPlainObject(raw)) return null;
  if (!nonEmptyString(raw.imageId) || !nonEmptyString(raw.planId) || !nonEmptyString(raw.chatId)) return null;
  if (!Number.isInteger(raw.floor) || !Number.isInteger(raw.swipeId)) return null;
  const segments = Array.isArray(raw.segments)
    ? raw.segments.map(normalizeAnchor).filter((item): item is SegmentAnchor => item !== null)
    : [];
  if (!segments.length) return null;
  const versions = Array.isArray(raw.versions)
    ? raw.versions.map(normalizeVersion).filter((item): item is CandidateVersion => item !== null)
    : [];
  if (!versions.length) return null;
  const status: CandidateStatus =
    raw.status === 'committed' || raw.status === 'discarded' ? raw.status : 'pending';
  const active = Number.isInteger(raw.activeVersion) ? (raw.activeVersion as number) : versions.length - 1;
  return {
    imageId: raw.imageId,
    planId: raw.planId,
    chatId: raw.chatId,
    floor: raw.floor as number,
    swipeId: raw.swipeId as number,
    segments,
    index: Number.isInteger(raw.index) ? (raw.index as number) : 0,
    versions,
    activeVersion: active >= 0 && active < versions.length ? active : versions.length - 1,
    status,
    createdAt: Number.isFinite(raw.createdAt) ? (raw.createdAt as number) : Date.now(),
    updatedAt: Number.isFinite(raw.updatedAt) ? (raw.updatedAt as number) : Date.now(),
  };
}

/**
 * 把任意输入规整成合法存储。单条坏了只丢那一条，不整池作废 ——
 * 用户可能刚写完 4 段候选，不能因为第 3 条被别的插件改坏就全没了。
 */
export function normalizeStore(raw: unknown): StoreV1 {
  if (!isPlainObject(raw) || !Array.isArray(raw.items)) return { v: 1, items: [] };
  const items = raw.items
    .map(normalizeCandidate)
    .filter((item): item is ImageCandidate => item !== null);
  return { v: 1, items };
}

function context(): STContext | null {
  return getContext();
}

/** 当前聊天 id。取不到时返回空串（此时一律视为「不属于本聊天」）。 */
function currentChatId(): string {
  return context()?.getCurrentChatId?.() ?? '';
}

function readStore(): StoreV1 {
  const ctx = context();
  if (!ctx?.chatMetadata) return { v: 1, items: [] };
  return normalizeStore(ctx.chatMetadata[CANDIDATES_KEY]);
}

function writeStore(store: StoreV1): void {
  const ctx = context();
  if (!ctx?.chatMetadata) return;
  ctx.chatMetadata[CANDIDATES_KEY] = store;
  try {
    ctx.saveMetadataDebounced?.();
  } catch {
    /* 保存失败只影响「刷新后还在不在」，不该让确认操作本身看起来失败 */
  }
  broadcast();
}

function broadcast(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.error('[CCX] 候选池回调异常', error);
    }
  }
}

/** 订阅候选池变更（面板据此重绘）。返回取消订阅函数。 */
export function onCandidatesChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 供测试：模拟刷新页面后重新从 chatMetadata 读。 */
export function forgetCandidateCache(): void {
  listeners.clear();
}

export interface ListOptions {
  /** 是否连同已确认/已丢弃的一起返回。默认只给待确认。 */
  includeDone?: boolean;
  /** 只列某楼。默认全部。 */
  floor?: number;
}

/** 当前聊天里的候选，按楼层、创建时间排序（面板从上到下读起来是「按剧情顺序」）。 */
export function listCandidates(options: ListOptions = {}): ImageCandidate[] {
  const chatId = currentChatId();
  if (!chatId) return [];
  const items = readStore().items
    .filter(item => item.chatId === chatId)
    .filter(item => (options.includeDone ? true : item.status === 'pending'))
    .filter(item => (options.floor === undefined ? true : item.floor === options.floor));
  items.sort((left, right) => left.floor - right.floor || left.createdAt - right.createdAt || left.index - right.index);
  return items;
}

export function findCandidate(imageId: string): ImageCandidate | null {
  const chatId = currentChatId();
  if (!chatId) return null;
  return readStore().items.find(item => item.imageId === imageId && item.chatId === chatId) ?? null;
}

export function countPending(): number {
  return listCandidates().length;
}

/**
 * 段落 ID：`hash(chatId | floor | swipeId | 锚点原文 | 同楼第 n 次出现)`。
 *
 * 三个刻意的选择：
 * 1. **不含内容 hash / 版本号** → 重 Roll 不换 ID，「同一段的多版候选」天然挂在一起；
 * 2. **含出现次序** → 同一句话在一楼里出现两次也能区分；
 * 3. **含 chatId / floor / swipeId** → 换聊天、换 swipe 绝不串味。
 */
export function makeSegmentId(params: {
  chatId: string;
  floor: number;
  swipeId: number;
  text: string;
  occurrence: number;
}): string {
  return hashText(`${params.chatId}\u0000${params.floor}\u0000${params.swipeId}\u0000${params.text}\u0000${params.occurrence}`);
}

/**
 * 由捕获快照造锚点。
 *
 * `before` / `after` 取的是**原文**里前后各 200 字（不是 DOM 的渲染文本）：
 * 确认发生在几分钟甚至几天后，重定位是拿原文找原文，用原文上下文消歧最准，
 * 也不受 ST 改版把 DOM 结构换掉的影响。
 */
export function buildSegmentAnchor(chatId: string, capture: SelectionCapture, mes: string): SegmentAnchor {
  const start = Math.max(0, capture.range.start);
  const end = Math.min(mes.length, capture.range.end);
  const text = mes.slice(start, end) || capture.text;
  // 「同楼第 n 次出现」：数锚点之前出现过几次同样的文本
  let occurrence = 0;
  let at = mes.indexOf(text);
  while (at >= 0 && at < start) {
    occurrence += 1;
    at = mes.indexOf(text, at + 1);
  }
  return {
    segmentId: makeSegmentId({ chatId, floor: capture.messageId, swipeId: capture.swipeId, text, occurrence }),
    text,
    before: mes.slice(Math.max(0, start - ANCHOR_CONTEXT_CHARS), start),
    after: mes.slice(end, Math.min(mes.length, end + ANCHOR_CONTEXT_CHARS)),
    startLine: lineIndexAt(mes, start),
    endLine: lineIndexAt(mes, Math.max(start, end - 1)),
  };
}

export interface NewCandidateInput {
  chatId: string;
  floor: number;
  swipeId: number;
  segments: SegmentAnchor[];
  /** 已后处理的图，`sourceLine` 为切片内行号。 */
  images: ImageInsertion[];
  changes: CharChange[];
}

/** 一次分析里「同一批」的标识：同一楼、同一 swipe、同一组段 = 同一批。 */
export function makePlanId(input: Pick<NewCandidateInput, 'chatId' | 'floor' | 'swipeId' | 'segments'>): string {
  const ids = input.segments.map(segment => segment.segmentId).join('|');
  return hashText(`${input.chatId}\u0000${input.floor}\u0000${input.swipeId}\u0000${ids}`);
}

/**
 * 把一次分析的结果放进候选池，返回新增/更新的条目数。
 *
 * 合并规则：同一 `imageId` 仍是待确认 → **追加一版**并切到最新（不是新建卡片）。
 * 已确认/已丢弃的不覆盖，另起一张（用户可能就是想再画一版）。
 */
export function addAnalysis(input: NewCandidateInput): number {
  const now = Date.now();
  const planId = makePlanId(input);
  const store = readStore();
  let touched = 0;

  input.images.forEach((image, index) => {
    const base = `${planId}:${index}`;
    let imageId = base;
    let existing = store.items.find(item => item.imageId === imageId && item.chatId === input.chatId);
    for (let suffix = 2; existing && existing.status !== 'pending' && suffix < 50; suffix += 1) {
      imageId = `${base}#${suffix}`;
      existing = store.items.find(item => item.imageId === imageId && item.chatId === input.chatId);
    }

    // 整个 plan 只有第一张带 changes：确认两张时不会把建档做两遍
    const changes = index === 0 ? input.changes : [];
    const version: CandidateVersion = { image, changes, createdAt: now };

    if (existing === undefined) {
      store.items.push({
        imageId,
        planId,
        chatId: input.chatId,
        floor: input.floor,
        swipeId: input.swipeId,
        segments: input.segments.map(segment => ({ ...segment })),
        index,
        versions: [version],
        activeVersion: 0,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      });
    } else {
      existing.versions.push(version);
      existing.activeVersion = existing.versions.length - 1;
      existing.segments = input.segments.map(segment => ({ ...segment }));
      existing.updatedAt = now;
    }
    touched += 1;
  });

  if (touched) writeStore(store);
  return touched;
}

/** 重 Roll：给同一张图追加一版并切到最新。返回条目数（找不到 = 0）。 */
export function addCandidateVersion(imageId: string, image: ImageInsertion): number {
  const store = readStore();
  const chatId = currentChatId();
  const item = store.items.find(entry => entry.imageId === imageId && entry.chatId === chatId);
  if (!item || item.status !== 'pending') return 0;
  item.versions.push({ image, changes: [], createdAt: Date.now() });
  item.activeVersion = item.versions.length - 1;
  item.updatedAt = Date.now();
  writeStore(store);
  return 1;
}

/** 编辑：直接改当前版本里的 tag 文本，**不重跑 API**（改一两个词不该花额度）。 */
export function editCandidateTag(imageId: string, tag: string): boolean {
  const trimmed = tag.trim();
  if (!trimmed) return false;
  const store = readStore();
  const chatId = currentChatId();
  const item = store.items.find(entry => entry.imageId === imageId && entry.chatId === chatId);
  if (!item || item.status !== 'pending') return false;
  item.versions[item.activeVersion].image.tag = trimmed;
  item.updatedAt = Date.now();
  writeStore(store);
  return true;
}

/** 删除：标记丢弃并移出池子（不留痕、不写正文）。 */
export function discardCandidate(imageId: string): boolean {
  const store = readStore();
  const chatId = currentChatId();
  const before = store.items.length;
  store.items = store.items.filter(entry => !(entry.imageId === imageId && entry.chatId === chatId));
  if (store.items.length === before) return false;
  writeStore(store);
  return true;
}

/** 确认成功后把这一张移出池子。 */
export function removeCandidate(imageId: string): boolean {
  return discardCandidate(imageId);
}

/** 清空当前聊天的全部候选（切成自动模式时给用户一个干净的出口）。 */
export function clearCandidates(): number {
  const store = readStore();
  const chatId = currentChatId();
  const before = store.items.length;
  store.items = store.items.filter(entry => entry.chatId !== chatId);
  const removed = before - store.items.length;
  if (removed) writeStore(store);
  return removed;
}
