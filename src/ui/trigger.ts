/**
 * 划线触发：在正文里选中一段文字后，浮出一个小工具条。
 *
 * 三个按钮（v0.2.2）：
 *   `⚡ 生成`    —— 立刻跑：分析 →（按模式）写回 / 进候选池
 *   `＋ 待生成`  —— 只记下选段，不发请求、不开面板。攒够了一键全生成
 *   `✕`         —— 丢弃本次选区（误划时的出口）
 *
 * 四条纪律（都被真实浏览器行为逼出来的）：
 *
 * 1. **捕获必须在 mouseup 当场做完**。浏览器会在下一次点击时清掉选区，
 *    等按钮的 click 回来再 `captureSelection()` 就已经没有选区了 —— 用户会看到
 *    「点了没反应」。所以 mouseup 时就地算好快照，click 只负责把快照交给执行层。
 *    三个按钮**共用同一份快照**。
 * 2. **每个按钮的 mousedown 都必须 preventDefault**。否则按下按钮的瞬间选区被清，
 *    页面还会滚一下（focus 行为）。漏一个，那个按钮按下去就等于什么都没选。
 * 3. **只在 AI 剧情楼浮出**。柏宝绘的楼层按钮也不给用户楼 —— 本插件出的是 tag，
 *    用户楼没有卡片可渲染，浮出来只会点到一句「这一楼不是剧情楼层」。
 * 4. **忙态只留一个按钮**：`✕ 取消分析`。此时若还摆着「生成 / 待生成」，
 *    点它们只会得到一句"正在跑"，不如把唯一的动作做成取消。
 *
 * 定位用 `range.getBoundingClientRect()` 的右下角，钳进视口；用 fixed 定位，
 * 这样不依赖任何 ST 布局容器（ST 改版不会把我们挤到页面外）。
 *
 * 触屏（v0.2.3）：手机上划线靠长按 + 手柄拖动，**从头到尾没有 mouseup**——
 * 只听 mouseup 的版本在手机上永远不出气泡。所以补一条 `selectionchange` 监听：
 * 选区稳定（去抖 350ms 没再变）且非空才落定。抑制位（`suppressed`）保证
 * 「点过按钮 / 手动收起后」残留的选区不会把气泡又顶回来。
 *
 * 触屏（v0.2.4）：iOS/Android 的原生选择菜单（拷贝/翻译那排）会**盖住**浮出按钮。
 * 它只依附于真实选区存在，而按钮用的本来就是快照 —— 落定时 `removeAllRanges()`
 * 菜单就必然消失；视觉上用 Custom Highlight API 补一层假高亮（Safari 17.4+），
 * 不支持的浏览器只是没有高亮，功能不受影响。桌面保留原生选区不动。
 */

import { captureSelection, describeCapture, type SelectionCapture } from '@/selection/capture';
import { isAiStoryMessage, getContext } from '@/st/context';
import { cancelSelectionRun, runSelection } from '@/runner/runSelection';
import { addDraft, buildSegmentAnchor, countDrafts } from '@/state/candidates';
import { diagnostic } from '@/runner/diagnostic';
import { notify } from '@/ui/notify';
import { setBusyInfo, openPanel } from '@/ui/panel';

const TOOLBAR_ID = 'ccx-select-toolbar';
const GENERATE_TEXT = '⚡ 生成';
const DRAFT_TEXT = '＋ 待生成';
const CLOSE_TEXT = '✕';
const CANCEL_TEXT = '✕ 取消分析';

let toolbar: HTMLDivElement | null = null;
let generateButton: HTMLButtonElement | null = null;
let draftButton: HTMLButtonElement | null = null;
let closeButton: HTMLButtonElement | null = null;
let cancelButton: HTMLButtonElement | null = null;

let pending: SelectionCapture | null = null;
let busy = false;
let cancelling = false;
/** 正在分析哪一楼。取消按楼层精确掐，不去动别人的在途请求。 */
let runningFloor: number | null = null;
let bound = false;

/** 选区稳定判定：手机拖动选区手柄时 selectionchange 会连发，停 350ms 才算划完。 */
const SETTLE_DELAY = 350;
let settleTimer: number | null = null;
/**
 * 抑制位：hide() 时选区往往还在（手机上点按钮不清选区）。
 * 不压住的话，下一次 selectionchange（比如其他插件动了 DOM）会把气泡又顶回来。
 * 选区一塌陷（用户重新划线）就解除。
 */
let suppressed = false;

/**
 * 触屏上的原生菜单对策（v0.2.4）：iOS/Android 的「拷贝 / 翻译」那排系统菜单只依附于
 * **真实选区**存在，而三个按钮用的本来就是 settle 时算好的快照，不依赖选区活着。
 * 所以粗指针环境下落定时把真实选区清掉（removeAllRanges），系统菜单必然消失；
 * 视觉上用 Custom Highlight API 补一层假高亮，用户不会丢「选了哪里」。
 * 桌面不动：右键菜单不盖气泡，保留原生选区还能顺手复制。
 */
const HIGHLIGHT_NAME = 'ccx-select';
const HIGHLIGHT_STYLE_ID = 'ccx-highlight-style';

function highlightSupported(): boolean {
  const g = globalThis as unknown as Record<string, unknown>;
  const css = g.CSS as { highlights?: Map<string, unknown> } | undefined;
  return typeof g.Highlight === 'function' && typeof css?.highlights?.set === 'function';
}

function applyHighlight(range: Range): void {
  if (!highlightSupported()) return;
  try {
    const css = (globalThis as unknown as { CSS: { highlights: Map<string, unknown> } }).CSS;
    const HighlightCtor = (globalThis as unknown as { Highlight: new (ranges: Range[]) => unknown }).Highlight;
    css.highlights.delete(HIGHLIGHT_NAME);
    css.highlights.set(HIGHLIGHT_NAME, new HighlightCtor([range]));
  } catch {
    /* 高亮是锦上添花，任何失败都不影响功能 */
  }
}

function clearHighlight(): void {
  if (!highlightSupported()) return;
  try {
    ((globalThis as unknown as { CSS: { highlights: Map<string, unknown> } }).CSS.highlights).delete(HIGHLIGHT_NAME);
  } catch {
    /* 同上 */
  }
}

/** 注入 ::highlight 的着色规则（幂等；不支持 Custom Highlight API 的浏览器规则不会被引用）。 */
function ensureHighlightStyle(doc: Document): void {
  if (doc.getElementById(HIGHLIGHT_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = HIGHLIGHT_STYLE_ID;
  style.textContent = `::highlight(${HIGHLIGHT_NAME}) { background-color: rgba(96,165,250,.35); }`;
  (doc.head ?? doc.body).appendChild(style);
}

/** 三套颜色：正常 / 待生成（轻一点，不抢主按钮）/ 取消（红，明确会中止任务）。 */
const BASE_BG = 'rgba(28,36,44,.94)';
const DRAFT_BG = 'rgba(56,72,88,.94)';
const CANCEL_BG = 'rgba(180,42,46,.95)';

/**
 * 触屏设备上 12px 小药丸按不中（Apple HIG / Android 都建议 ≥44px 命中区）。
 * 粗指针环境放大按钮，鼠标环境保持原样。
 */
const COARSE_POINTER =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(pointer: coarse)').matches
    : false;

function stylePill(button: HTMLButtonElement, background: string): void {
  Object.assign(button.style, {
    padding: COARSE_POINTER ? '8px 14px' : '4px 10px',
    minHeight: COARSE_POINTER ? '36px' : '',
    border: '1px solid rgba(255,255,255,.18)',
    borderRadius: '999px',
    background,
    color: '#fff',
    font: COARSE_POINTER
      ? '500 14px/1.4 system-ui,"PingFang SC","Microsoft YaHei",sans-serif'
      : '500 12px/1.6 system-ui,"PingFang SC","Microsoft YaHei",sans-serif',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  } as Partial<CSSStyleDeclaration>);
  // 按下不许清选区（见文件头第 2 条）。三个按钮都要绑，漏一个就点不动。
  button.addEventListener('mousedown', event => event.preventDefault());
}

function makeButton(text: string, background: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = text;
  stylePill(button, background);
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return button;
}

function ensureToolbar(): HTMLDivElement {
  if (toolbar && document.body.contains(toolbar)) return toolbar;

  ensureHighlightStyle(document);
  const el = document.createElement('div');
  el.id = TOOLBAR_ID;
  Object.assign(el.style, {
    position: 'fixed',
    zIndex: '2147483000',
    display: 'none',
    alignItems: 'center',
    gap: COARSE_POINTER ? '8px' : '4px',
    // 容器本身不可见也不吃事件：否则它会在选区旁边留一块"透明墙"
    background: 'transparent',
  } as Partial<CSSStyleDeclaration>);

  generateButton = makeButton(GENERATE_TEXT, BASE_BG, () => void trigger());
  draftButton = makeButton(DRAFT_TEXT, DRAFT_BG, () => parkSelection());
  closeButton = makeButton(CLOSE_TEXT, BASE_BG, () => hide());
  // 忙态才出现的唯一按钮
  cancelButton = makeButton(CANCEL_TEXT, CANCEL_BG, () => cancel());
  cancelButton.style.display = 'none';

  el.append(generateButton, draftButton, closeButton, cancelButton);
  document.body.appendChild(el);
  toolbar = el;
  return el;
}

function showAt(rect: DOMRect): void {
  const el = ensureToolbar();
  const width = el.offsetWidth || 150;
  const height = el.offsetHeight || 26;
  const gap = 8;
  const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
  // 选区靠页面底部时翻到上方，别被视口裁掉
  const below = rect.bottom + gap;
  const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - gap) : below;
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  el.style.display = 'flex';
}

function hide(): void {
  pending = null;
  clearHighlight();
  if (toolbar) toolbar.style.display = 'none';
  // 选区还在的话压住 selectionchange 的自动复显；塌陷后自动解除（见 suppressed 注释）
  const selection = typeof document !== 'undefined' ? document.getSelection?.() ?? window.getSelection() : null;
  suppressed = Boolean(selection && !selection.isCollapsed);
}

/**
 * 忙态 = 只剩一个取消键。以前这里会 `disabled = true`，结果就是「想取消却没有入口」——
 * 按钮变成一句「分析中…」的死字，用户只能干等或刷新页面。
 */
function setBusy(value: boolean, floor: number | null = null): void {
  busy = value;
  runningFloor = value ? floor : null;
  if (!toolbar || !generateButton || !draftButton || !closeButton || !cancelButton) return;
  generateButton.style.display = value ? 'none' : 'inline-block';
  draftButton.style.display = value ? 'none' : 'inline-block';
  closeButton.style.display = value ? 'none' : 'inline-block';
  cancelButton.style.display = value ? 'inline-block' : 'none';
}

/** 掐掉当前这一楼的在途分析。重复点击无副作用（abort 幂等）。 */
function cancel(): void {
  if (!busy || cancelling || runningFloor === null) return;
  cancelling = true;
  diagnostic('trigger:cancel', { floor: runningFloor });
  cancelSelectionRun(runningFloor);
}

async function trigger(): Promise<void> {
  const capture = pending;
  if (!capture || busy) return;
  setBusy(true, capture.messageId);
  // 面板里同步显示一行状态：按钮可能被滚走、或者用户正开着面板
  setBusyInfo({ label: `正在分析第 ${capture.messageId} 楼…`, onCancel: cancel });
  diagnostic('trigger:click', { floor: capture.messageId, chars: capture.text.length });
  try {
    const outcome = await runSelection(capture);
    // runSelection 取消时只返回状态、不弹提示——不补这一句，用户会以为「点了没反应」
    if (outcome.status === 'aborted') notify('info', '已取消，正文未改动');
    // 确认式：候选已经放进池子，直接把面板打开让人确认（不然用户不知道下一步在哪）
    if (outcome.status === 'pending') void openPanel();
  } catch (error) {
    // runSelection 自己把异常转成了 toast；这里只兜住「连 toast 都没来得及」的情况
    console.error('[CCX] 划线出图异常', error);
  } finally {
    cancelling = false;
    setBusy(false);
    setBusyInfo(null);
    hide();
  }
}

/**
 * 「＋ 待生成」：只写池子，不发请求。
 *
 * **不打开面板**：这个按钮的语义就是「先攒着」，弹面板等于打断当前阅读。
 * 但 toast 必须说清「没调 API」——否则在自动模式下，用户会以为它已经在跑了。
 */
function parkSelection(): void {
  const capture = pending;
  if (!capture || busy) return;
  const context = getContext();
  const message = context?.chat?.[capture.messageId];
  if (!message || typeof message.mes !== 'string') {
    notify('warning', '找不到这一楼的正文，没法加入待生成');
    return;
  }
  const chatId = context?.getCurrentChatId?.() ?? '';
  if (!chatId) {
    notify('warning', '当前没有打开的聊天，没法加入待生成');
    return;
  }
  const anchor = buildSegmentAnchor(chatId, capture, message.mes);
  const added = addDraft({ chatId, floor: capture.messageId, swipeId: capture.swipeId, segment: anchor });
  diagnostic('trigger:draft', { floor: capture.messageId, created: added.created, existing: added.existingStatus ?? null });

  if (!added.created) {
    notify(
      'info',
      added.existingStatus === 'pending' ? '这一段已经有候选了，去面板的「待确认」里看' : '这段已经在待生成里了',
    );
  } else {
    notify('info', `已加入待生成（共 ${countDrafts()} 段，尚未调用 API）`);
  }
  hide();
}

/** 选区落定后：能出图就浮按钮，不能就安静地什么都不做。 */
function settle(): void {
  if (busy) return;
  const outcome = captureSelection();
  if (!outcome.ok) {
    // 「什么都没选中」是绝大多数鼠标抬起的正常情况（点按钮、点面板），不记日志；
    // 只有用户确实划了东西、却没通过校验时才值得进诊断流。
    if (outcome.reason !== 'no-selection' && outcome.reason !== 'empty-selection') {
      diagnostic('trigger:no-capture', { reason: outcome.reason, detail: outcome.detail ?? null });
    }
    hide();
    return;
  }
  const context = getContext();
  const message = context?.chat?.[outcome.capture.messageId];
  if (!isAiStoryMessage(message)) {
    diagnostic('trigger:skip', { reason: 'not-ai-story-message', floor: outcome.capture.messageId });
    hide();
    return;
  }
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    hide();
    return;
  }
  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  pending = outcome.capture;
  console.debug(describeCapture(outcome.capture));
  if (COARSE_POINTER) {
    // 快照已到手：清掉真实选区，系统菜单（拷贝/翻译）随之消失，气泡不再被盖住。
    // 清不掉（老浏览器不配合）也不影响功能——只是菜单可能还压在上面。
    try {
      selection.removeAllRanges();
    } catch {
      /* 保留原样 */
    }
    applyHighlight(range.cloneRange());
  } else {
    clearHighlight();
  }
  showAt(rect);
}

/** 选区稳定后落定；手机拖动手柄期间连发的 selectionchange 靠去抖挡住。 */
function scheduleSettle(): void {
  if (settleTimer !== null) window.clearTimeout(settleTimer);
  settleTimer = window.setTimeout(() => {
    settleTimer = null;
    settle();
  }, SETTLE_DELAY);
}

function onSelectionChange(): void {
  const selection = typeof document !== 'undefined' ? document.getSelection?.() ?? window.getSelection() : null;
  if (!selection || selection.isCollapsed) {
    // 划到一半塌陷（误触 / 重新开始）：停掉在途判定，并解除抑制
    if (settleTimer !== null) {
      window.clearTimeout(settleTimer);
      settleTimer = null;
    }
    suppressed = false;
    return;
  }
  if (suppressed) return;
  scheduleSettle();
}

/** 选区之外的地方按下/滚动，就该收起来 —— 否则按钮会飘在屏幕上跟着用户走。 */
function onDocumentMouseDown(event: MouseEvent): void {
  if (toolbar && event.target instanceof Node && toolbar.contains(event.target)) return;
  if (busy) return;
  hide();
}

export interface TriggerOptions {
  /** 注入 document / window，便于测试与多窗口场景。 */
  doc?: Document;
  win?: Window;
}

/**
 * 绑定划线触发。可安全重复调用（只会绑一次）。
 * 返回解绑函数，供「插件卸载 / 切聊天清场」使用。
 */
export function bindSelectionTrigger(options: TriggerOptions = {}): () => void {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  if (bound) return () => {};
  bound = true;

  // mouseup / keyup 是桌面路径；路径上先解除抑制——用户主动划了新选区，必须照常浮出
  const onSettle = () => {
    suppressed = false;
    settle();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    // 忙的时候 Esc 等于「取消」：按钮此刻就是取消键，语义一致。
    // 空闲时才只是把浮出按钮收起来。
    if (busy) {
      cancel();
      return;
    }
    hide();
  };
  const onScroll = () => {
    if (!busy) hide();
  };

  doc.addEventListener('mouseup', onSettle, true);
  doc.addEventListener('keyup', onSettle, true);
  doc.addEventListener('selectionchange', onSelectionChange, true);
  doc.addEventListener('mousedown', onDocumentMouseDown, true);
  doc.addEventListener('keydown', onKeyDown, true);
  win.addEventListener('scroll', onScroll, true);

  diagnostic('trigger:bound', { toolbarId: TOOLBAR_ID, coarsePointer: COARSE_POINTER });

  return () => {
    doc.removeEventListener('mouseup', onSettle, true);
    doc.removeEventListener('keyup', onSettle, true);
    doc.removeEventListener('selectionchange', onSelectionChange, true);
    doc.removeEventListener('mousedown', onDocumentMouseDown, true);
    doc.removeEventListener('keydown', onKeyDown, true);
    win.removeEventListener('scroll', onScroll, true);
    if (settleTimer !== null) {
      window.clearTimeout(settleTimer);
      settleTimer = null;
    }
    suppressed = false;
    clearHighlight();
    toolbar?.remove();
    toolbar = null;
    generateButton = null;
    draftButton = null;
    closeButton = null;
    cancelButton = null;
    pending = null;
    busy = false;
    runningFloor = null;
    cancelling = false;
    setBusyInfo(null);
    bound = false;
  };
}
