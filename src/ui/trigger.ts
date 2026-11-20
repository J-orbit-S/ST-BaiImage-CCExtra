/**
 * 划线触发：在正文里选中一段文字后，浮出一个小按钮「划线出图」。
 *
 * 三条纪律（都被真实浏览器行为逼出来的）：
 *
 * 1. **捕获必须在 mouseup 当场做完**。浏览器会在下一次点击时清掉选区，
 *    等按钮的 click 回来再 `captureSelection()` 就已经没有选区了 —— 用户会看到
 *    「点了没反应」。所以 mouseup 时就地算好快照，click 只负责把快照交给执行层。
 * 2. **按钮的 mousedown 必须 preventDefault**。否则按下按钮的瞬间选区被清，
 *    页面还会滚一下（focus 行为）。代价很小，收益是点击手感与直觉一致。
 * 3. **只在 AI 剧情楼浮出**。柏宝绘的楼层按钮也不给用户楼 —— 本插件出的是 tag，
 *    用户楼没有卡片可渲染，浮出来只会点到一句「这一楼不是剧情楼层」。
 *
 * 定位用 `range.getBoundingClientRect()` 的右下角，钳进视口；用 fixed 定位，
 * 这样不依赖任何 ST 布局容器（ST 改版不会把我们挤到页面外）。
 */

import { captureSelection, describeCapture, type SelectionCapture } from '@/selection/capture';
import { isAiStoryMessage, getContext } from '@/st/context';
import { runSelection } from '@/runner/runSelection';
import { diagnostic } from '@/runner/diagnostic';

const BUTTON_ID = 'ccx-select-trigger';
const IDLE_TEXT = '划线出图';
const BUSY_TEXT = '分析中…';

let button: HTMLButtonElement | null = null;
let pending: SelectionCapture | null = null;
let busy = false;
let bound = false;

function ensureButton(): HTMLButtonElement {
  if (button && document.body.contains(button)) return button;
  const el = document.createElement('button');
  el.id = BUTTON_ID;
  el.type = 'button';
  el.textContent = IDLE_TEXT;
  // 内联样式：不依赖任何样式表，也不会被 ST 主题的 button 规则改坏
  Object.assign(el.style, {
    position: 'fixed',
    zIndex: '2147483000',
    display: 'none',
    padding: '4px 10px',
    border: '1px solid rgba(255,255,255,.18)',
    borderRadius: '999px',
    background: 'rgba(28,36,44,.94)',
    color: '#fff',
    font: '500 12px/1.6 system-ui,"PingFang SC","Microsoft YaHei",sans-serif',
    cursor: 'pointer',
    boxShadow: '0 4px 14px rgba(0,0,0,.28)',
    whiteSpace: 'nowrap',
  } as Partial<CSSStyleDeclaration>);
  // 按下不许清选区（见文件头第 2 条）
  el.addEventListener('mousedown', event => event.preventDefault());
  el.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    void trigger();
  });
  document.body.appendChild(el);
  button = el;
  return el;
}

function showAt(rect: DOMRect): void {
  const el = ensureButton();
  const width = el.offsetWidth || 84;
  const height = el.offsetHeight || 26;
  const gap = 8;
  const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
  // 选区靠页面底部时翻到上方，别被视口裁掉
  const below = rect.bottom + gap;
  const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - gap) : below;
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  el.style.display = 'block';
}

function hide(): void {
  pending = null;
  if (button) button.style.display = 'none';
}

function setBusy(value: boolean): void {
  busy = value;
  if (!button) return;
  button.textContent = value ? BUSY_TEXT : IDLE_TEXT;
  button.disabled = value;
  button.style.opacity = value ? '0.75' : '1';
  button.style.cursor = value ? 'progress' : 'pointer';
}

async function trigger(): Promise<void> {
  const capture = pending;
  if (!capture || busy) return;
  setBusy(true);
  diagnostic('trigger:click', { floor: capture.messageId, chars: capture.text.length });
  try {
    await runSelection(capture);
  } catch (error) {
    // runSelection 自己把异常转成了 toast；这里只兜住「连 toast 都没来得及」的情况
    console.error('[CCX] 划线出图异常', error);
  } finally {
    setBusy(false);
    hide();
  }
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
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  pending = outcome.capture;
  console.debug(describeCapture(outcome.capture));
  showAt(rect);
}

/** 选区之外的地方按下/滚动，就该收起来 —— 否则按钮会飘在屏幕上跟着用户走。 */
function onDocumentMouseDown(event: MouseEvent): void {
  if (button && event.target instanceof Node && button.contains(event.target)) return;
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

  const onSettle = () => settle();
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') hide();
  };
  const onScroll = () => {
    if (!busy) hide();
  };

  doc.addEventListener('mouseup', onSettle, true);
  doc.addEventListener('keyup', onSettle, true);
  doc.addEventListener('mousedown', onDocumentMouseDown, true);
  doc.addEventListener('keydown', onKeyDown, true);
  win.addEventListener('scroll', onScroll, true);

  diagnostic('trigger:bound', { buttonId: BUTTON_ID });

  return () => {
    doc.removeEventListener('mouseup', onSettle, true);
    doc.removeEventListener('keyup', onSettle, true);
    doc.removeEventListener('mousedown', onDocumentMouseDown, true);
    doc.removeEventListener('keydown', onKeyDown, true);
    win.removeEventListener('scroll', onScroll, true);
    button?.remove();
    button = null;
    pending = null;
    busy = false;
    bound = false;
  };
}
