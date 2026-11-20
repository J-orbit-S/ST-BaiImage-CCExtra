/**
 * 划线捕获：把浏览器里的「用户选中」变成一份可交给分析链路的快照。
 *
 * 这一层只做三件事，任何一件失败都**明确报错并中止**，绝不降级成「拿整楼凑合」：
 *   1. 从 selection 里取 Range，确认首尾落在**同一条楼层**上（跨楼必须拆开，否则区间没有意义）；
 *   2. 取选区前后的渲染文本作为消歧上下文，交给 locate 映射回原文区间；
 *   3. 把区间扩到完整物理行，连同楼层号 / swipe / 正文指纹一起打包。
 *
 * swipe 与指纹是给后面两段用的：
 *   - swipeId：用户划完可能滑到别的 swipe，写回时若发现 swipe 变了必须放弃；
 *   - sourceHash：正文可能被别的插件改过，写回前要拿它做一次一致性判断（CAS 的「C」）。
 */

import { getContext, type STContext, type STMessage } from '@/st/context';
import { hashText } from './hash';
import { countLines, expandToLineBounds, locateSelection, type MatchMethod } from './locate';

export interface SelectionCapture {
  /** 楼层下标（= chat 数组下标 = DOM 上的 mesid）。 */
  messageId: number;
  /** 捕获时的 swipe 下标。 */
  swipeId: number;
  /** 捕获时整楼原文的指纹，写回前用它判断正文是否已被改动。 */
  sourceHash: string;
  /** 原文内的字符区间，已扩到完整物理行。 */
  range: { start: number; end: number };
  /** 区间对应的原文——**这是分析链路的唯一输入**。 */
  text: string;
  /** 用户实际选中的文字（诊断用；可能与 text 不完全相同）。 */
  domText: string;
  /** 定位命中的归一化口径（strict/normalized/aggressive），排错第一现场。 */
  method: MatchMethod;
  /** 该口径下原文里有几处候选；>1 表示靠上下文选出来的。 */
  candidates: number;
  /** 是否发生过「扩到整行」的扩张（说明用户划的是行内片段）。 */
  expanded: boolean;
  /** 区间跨了几个物理行。 */
  lineCount: number;
}

export type CaptureFailure =
  | 'no-selection'
  | 'not-in-message'
  | 'cross-message'
  | 'message-not-found'
  | 'empty-selection'
  | 'too-short'
  | 'not-found'
  | 'ambiguous';

export type CaptureOutcome =
  | { ok: true; capture: SelectionCapture }
  | { ok: false; reason: CaptureFailure; detail?: string };

const FAILURE_TEXT: Record<CaptureFailure, string> = {
  'no-selection': '没有选中任何文字：请先在正文里划出一段。',
  'not-in-message': '选区不在任何楼层正文里。',
  'cross-message': '选区跨了多个楼层：请只划同一层楼里的内容（跨楼会拆成多次分析）。',
  'message-not-found': '找不到选区对应的楼层数据，可能聊天刚切换或该楼已删除。',
  'empty-selection': '选区是空的。',
  'too-short': '选区太短，无法可靠定位。',
  'not-found': '无法在原文中定位这段选区（可能选中了渲染时插入的内容，如按钮/分隔线）。',
  ambiguous: '这段文字在原文里出现了多次，无法确定你指的是哪一处：请多划一点上下文。',
};

export function formatCaptureFailure(reason: CaptureFailure): string {
  return FAILURE_TEXT[reason];
}

/**
 * 1 = ELEMENT_NODE。这里用局部常量而不是全局 `Node.ELEMENT_NODE`：
 * Node 侧（测试、构建期）没有 DOM 全局，引用它会直接 ReferenceError；
 * 而 nodeType 的取值是 DOM 规范常量，不会变。
 */
const ELEMENT_NODE = 1;

/** 从任意节点向上找 `[mesid]`；找不到返回 null。 */
function messageIdOf(node: Node | null): number | null {
  let el: Element | null = node
    ? node.nodeType === ELEMENT_NODE
      ? (node as Element)
      : node.parentElement
    : null;
  while (el) {
    const attr = el.getAttribute('mesid');
    if (attr !== null && attr !== '') {
      const id = Number(attr);
      if (Number.isInteger(id) && id >= 0) return id;
    }
    el = el.parentElement;
  }
  return null;
}

/** 选区端点所属消息的正文容器 `.mes_text`；没有就退回 `.mes_block`，再退回消息根。 */
function textContainerOf(node: Node | null, mesElement: Element): Element {
  const owner = mesElement.querySelector('.mes_text') ?? mesElement.querySelector('.mes_block');
  if (owner && node && owner.contains(node)) return owner;
  return owner ?? mesElement;
}

function textBefore(doc: Document, root: Element, container: Node, offset: number): string {
  try {
    const range = doc.createRange();
    range.selectNodeContents(root);
    range.setEnd(container, offset);
    return range.toString();
  } catch {
    return '';
  }
}

function textAfter(doc: Document, root: Element, container: Node, offset: number): string {
  try {
    const range = doc.createRange();
    range.selectNodeContents(root);
    range.setStart(container, offset);
    return range.toString();
  } catch {
    return '';
  }
}

export interface BuildParams {
  raw: string;
  messageId: number;
  swipeId: number;
  domText: string;
  located: { start: number; end: number; method: MatchMethod; candidates: number };
  /** 归一化后至少这么长才接受，防误触。默认 2。 */
  minChars?: number;
}

/**
 * 由「已定位成功的原文区间」构造快照（纯函数，不碰 DOM）。
 * 单独拆出来是为了能在没有浏览器的环境里覆盖全部边界：扩行、空行、多行、指纹。
 */
export function buildCapture(params: BuildParams): CaptureOutcome {
  const { raw, messageId, swipeId, domText, located } = params;
  const bounds = expandToLineBounds(raw, located.start, located.end);
  const text = raw.slice(bounds.start, bounds.end);
  if (!text.trim()) return { ok: false, reason: 'empty-selection' };

  const minChars = params.minChars ?? 2;
  if (text.replace(/\s/g, '').length < minChars) return { ok: false, reason: 'too-short' };

  return {
    ok: true,
    capture: {
      messageId,
      swipeId,
      sourceHash: hashText(raw),
      range: { start: bounds.start, end: bounds.end },
      text,
      domText,
      method: located.method,
      candidates: located.candidates,
      expanded: bounds.expanded,
      lineCount: countLines(text),
    },
  };
}

export interface CaptureOptions {
  /** 注入 window，便于测试与多窗口场景。默认全局 window。 */
  win?: Window;
  /** 注入 ST 上下文，便于测试。默认 getContext()。 */
  context?: STContext | null;
  /** 消歧上下文最多取多少字符（每侧）。默认 200。 */
  contextChars?: number;
  /** 归一化后最短长度。默认 2。 */
  minChars?: number;
}

/**
 * 捕获当前划线。**必须在用户鼠标抬起后同步调用**——浏览器会在下一次点击时清掉选区。
 */
export function captureSelection(options: CaptureOptions = {}): CaptureOutcome {
  const win = options.win ?? (typeof window !== 'undefined' ? window : undefined);
  const selection = win?.getSelection?.();
  if (!win || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return { ok: false, reason: 'no-selection' };
  }

  const range = selection.getRangeAt(0);
  const domText = range.toString();
  if (!domText.trim()) return { ok: false, reason: 'empty-selection' };

  // 先做长度闸门再定位：定位是「全楼搜 + 逐个候选打分」，1~2 个字的选区在长楼里
  // 会搜出成百上千处候选，既要算很久，结果也必然 ambiguous。这里提前拦掉。
  const minChars = options.minChars ?? 2;
  if (domText.replace(/\s/g, '').length < minChars) return { ok: false, reason: 'too-short' };

  const startId = messageIdOf(range.startContainer);
  const endId = messageIdOf(range.endContainer);
  if (startId === null || endId === null) return { ok: false, reason: 'not-in-message' };
  if (startId !== endId) {
    return { ok: false, reason: 'cross-message', detail: `选区跨楼层：#${startId} → #${endId}` };
  }

  const ctx = options.context === undefined ? getContext() : options.context;
  const message: STMessage | undefined = ctx?.chat?.[startId];
  if (!message || typeof message.mes !== 'string') {
    return { ok: false, reason: 'message-not-found', detail: `楼层 #${startId}` };
  }

  const doc = win.document;
  const mesElement =
    (range.startContainer.nodeType === ELEMENT_NODE
      ? (range.startContainer as Element).closest?.('.mes')
      : range.startContainer.parentElement?.closest?.('.mes')) ?? null;
  const root = mesElement ?? doc.body;
  const container = textContainerOf(range.startContainer, root);

  const cap = options.contextChars ?? 200;
  const before = textBefore(doc, container, range.startContainer, range.startOffset).slice(-cap);
  const after = textAfter(doc, container, range.endContainer, range.endOffset).slice(0, cap);

  const located = locateSelection({
    raw: message.mes,
    domText,
    before,
    after,
    contextChars: cap,
  });
  if (!located.ok) {
    return {
      ok: false,
      reason: located.reason === 'empty' ? 'empty-selection' : located.reason,
      detail: located.candidates ? `候选 ${located.candidates} 处` : undefined,
    };
  }

  return buildCapture({
    raw: message.mes,
    messageId: startId,
    swipeId: typeof message.swipe_id === 'number' ? message.swipe_id : 0,
    domText,
    located,
    minChars: options.minChars,
  });
}

/** 供日志与 UI 的一行摘要。统一前缀便于过滤，字段顺序稳定便于肉眼比对。 */
export function describeCapture(capture: SelectionCapture): string {
  return (
    `[CCX][Selection] msg#${capture.messageId} swipe${capture.swipeId} ` +
    `[${capture.range.start},${capture.range.end}) ${capture.lineCount}行 ` +
    `method=${capture.method} candidates=${capture.candidates}` +
    `${capture.expanded ? ' expanded' : ''} hash=${capture.sourceHash}`
  );
}
