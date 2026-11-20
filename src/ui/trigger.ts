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
import { cancelSelectionRun, runSelection } from '@/runner/runSelection';
import { diagnostic } from '@/runner/diagnostic';
import { notify } from '@/ui/notify';
import { setBusyInfo, openPanel } from '@/ui/panel';

const BUTTON_ID = 'ccx-select-trigger';
const IDLE_TEXT = '生成 tag';
/** 忙态不再是「分析中…」这种死字：这个按钮此刻就是取消键。 */
const CANCEL_TEXT = '✕ 取消分析';

let button: HTMLButtonElement | null = null;
let pending: SelectionCapture | null = null;
let busy = false;
let cancelling = false;
/** 正在分析哪一楼。取消按楼层精确掐，不去动别人的在途请求。 */
let runningFloor: number | null = null;
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
    // 忙的时候这个按钮是「取消」，空闲时才是「划线出图」。
    // 分支写在 click 里而不是靠 disabled：禁用就点不动，等于把唯一的取消入口藏了。
    if (busy) {
      cancel();
      return;
    }
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

/**
 * 忙态 = 取消键。以前这里会 `disabled = true`，结果就是「想取消却没有入口」——
 * 按钮变成一句「分析中…」的死字，用户只能干等或刷新页面。
 */
function setBusy(value: boolean, floor: number | null = null): void {
  busy = value;
  runningFloor = value ? floor : null;
  if (!button) return;
  button.textContent = value ? CANCEL_TEXT : IDLE_TEXT;
  button.disabled = false;
  // 忙时染成警示色：一眼看出「这个按钮现在会中止任务」，而不是以为还能再点一次
  button.style.background = value ? 'rgba(180,42,46,.95)' : 'rgba(28,36,44,.94)';
  button.style.cursor = 'pointer';
  button.style.opacity = '1';
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
    runningFloor = null;
    cancelling = false;
    setBusyInfo(null);
    bound = false;
  };
}
