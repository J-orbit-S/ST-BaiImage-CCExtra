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
 * 2. **按下按钮不许清选区**。容器级 pointerdown preventDefault（触屏）+ 每个按钮
 *    mousedown preventDefault（桌面）。漏一个，按下去的瞬间选区被清，页面还会滚一下。
 * 3. **只在 AI 剧情楼浮出**。柏宝绘的楼层按钮也不给用户楼 —— 本插件出的是 tag，
 *    用户楼没有卡片可渲染，浮出来只会点到一句「这一楼不是剧情楼层」。
 * 4. **忙态只留一个按钮**：`✕ 取消分析`。此时若还摆着「生成 / 待生成」，
 *    点它们只会得到一句"正在跑"，不如把唯一的动作做成取消。
 *
 * 定位（v0.2.5）：气泡压在**选区内部、纵向偏下**（62% 处）的位置，横向居中。
 * 为什么不再挂在选区下方：那一条是所有划线工具的**公共地盘**——系统选择菜单
 * （拷贝/翻译）、其他插件的气泡都在那儿，谁挂上去都会互相盖。
 * 仍然用 fixed 定位 + 视口钳位，不依赖任何 ST 布局容器（ST 改版不会把我们挤到页面外）。
 *
 * 可见性模型（v0.2.6 重写）：
 *
 *   **工具条的可见性是「当前选区」的纯函数**：选区非空且能捕获 → 显示；
 *   选区塌陷 → 收起；滚动 → 跟着选区重新锚定。没有任何「一次失败就永久哑火」的
 *   抑制位——v0.2.3~v0.2.5 的 `suppressed` 有一个死锁：settle 一失败就 hide，
 *   hide 发现选区还在就置抑制位，而手机上长按选区后选区长期不塌陷，
 *   于是 selectionchange 全部被拦，气泡再也不出来（真机录屏实测 32 秒不出）。
 *
 *   唯一的例外是**显式忽略**（`dismissed`）：用户点了 ✕ / Esc / 完成了一次动作，
 *   表示「这次选区我不要了」，此后滚动和 selectionchange 不再复显——
 *   直到选区塌陷，或用户做出新的手势（mouseup / touchend）。
 *
 * 触屏（v0.2.3 起，v0.2.6 重做）：手机划线靠长按 + 手柄拖动，**从头到尾没有 mouseup**。
 * 监听三路：`selectionchange`（去抖 120ms）、`touchend`（去抖 120ms，手指抬起的确定性信号）、
 * `mouseup`（桌面立即落定）。系统菜单（拷贝/翻译）依附真实选区，我们不清选区（v0.2.5 教训），
 * 气泡压在选区内部偏下避开它。
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

/**
 * 选区稳定判定：手机拖动选区手柄时 selectionchange 会连发，停 120ms 才算划完。
 * v0.2.3 用 350ms 是为了「拖完再出」，实测太钝（真机上像失灵）；
 * 120ms 拖动中每次变化都重置计时，停手即出。
 */
const SETTLE_DELAY = 120;
let settleTimer: number | null = null;
/**
 * 显式忽略：用户点了 ✕ / Esc / 完成一次动作后置位——这次选区不要了，
 * 滚动与 selectionchange 不再复显。选区塌陷或新的手势（mouseup/touchend）解除。
 * 它不是 v0.2.3 那个会死锁的抑制位：那只拦「自动复显」，绝不拦新手势。
 */
let dismissed = false;

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
    userSelect: 'none',
    WebkitUserSelect: 'none',
    WebkitTouchCallout: 'none',
    touchAction: 'manipulation',
  } as Partial<CSSStyleDeclaration>);
  // 按下不许清选区（见文件头第 2 条）。三个按钮都要绑，漏一个就点不动。
  button.addEventListener('mousedown', event => event.preventDefault());
}

/**
 * click 与 touchend 双绑：触屏直接在 touchend 响应，
 * 不等浏览器合成 click（iOS 上慢且可能被系统菜单截走）；300ms 忙锁防止
 * touchend + 合成 click 双触发跑两遍。
 */
function bindButtonActivation(button: HTMLButtonElement, onClick: () => void): void {
  let lockUntil = 0;
  const fire = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
    const now = Date.now();
    if (now < lockUntil) return;
    lockUntil = now + 300;
    onClick();
  };
  button.addEventListener('click', fire);
  button.addEventListener('touchend', fire, { passive: false });
}

function makeButton(text: string, background: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = text;
  stylePill(button, background);
  bindButtonActivation(button, onClick);
  return button;
}

function ensureToolbar(): HTMLDivElement {
  if (toolbar && document.body.contains(toolbar)) return toolbar;

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
    // 触屏按按钮时不许触发文字选择 / iOS 长按呼出
    userSelect: 'none',
    WebkitUserSelect: 'none',
    WebkitTouchCallout: 'none',
    touchAction: 'manipulation',
  } as Partial<CSSStyleDeclaration>);
  // 容器级 pointerdown preventDefault：iOS 上点按钮的瞬间会清掉选区（点在选区外），
  // 按钮用的是快照不依赖选区，但清选区会连带触发 selectionchange → 收起竞态。
  el.addEventListener('pointerdown', event => event.preventDefault());

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

function isToolbarVisible(): boolean {
  return Boolean(toolbar && toolbar.style.display === 'flex');
}

/**
 * 定位：压在**选区内部、纵向偏下**（62% 处），横向居中。
 *
 * 为什么不是「选区下方」：那一条是所有划线工具的公共地盘——系统选择菜单（拷贝/翻译）、
 * 其他插件的气泡都在那儿，谁挂上去都会互相盖（v0.2.4 的教训）。
 * 选区内偏下没人占，而且离用户刚划完的位置最近，点起来顺手。
 */
function showAt(rect: DOMRect): void {
  const el = ensureToolbar();
  const width = el.offsetWidth || 150;
  const height = el.offsetHeight || 26;
  const centerX = rect.left + rect.width / 2;
  const anchorY = rect.top + rect.height * 0.62;
  const left = Math.min(Math.max(8, centerX - width / 2), Math.max(8, window.innerWidth - width - 8));
  const top = Math.min(Math.max(8, anchorY - height / 2), Math.max(8, window.innerHeight - height - 8));
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  el.style.display = 'flex';
}

/**
 * 收起工具条。`dismiss` 只在**用户明确说「这次选区不要了」**时为 true
 * （✕ / Esc / 一次动作完成）：此后滚动与 selectionchange 不再自动复显。
 * 捕获失败、选区塌陷这类「非用户意图」的收起必须传 false——否则一次失败
 * 就把复显路堵死，这就是 v0.2.5 抑制位死锁的变体（真机录屏 32 秒不出气泡）。
 */
function hide(dismiss = true): void {
  pending = null;
  if (toolbar) toolbar.style.display = 'none';
  dismissed = dismiss;
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

/** 选区落定后：能出图就浮按钮，不能就安静地什么都不做。失败不留任何死锁状态——下次事件照常重查。 */
function settle(): void {
  if (busy) return;
  const outcome = captureSelection();
  if (!outcome.ok) {
    // 「什么都没选中」是绝大多数鼠标抬起的正常情况（点按钮、点面板），不记日志；
    // 只有用户确实划了东西、却没通过校验时才值得进诊断流。
    if (outcome.reason !== 'no-selection' && outcome.reason !== 'empty-selection') {
      diagnostic('trigger:no-capture', { reason: outcome.reason, detail: outcome.detail ?? null });
    }
    hide(false);
    return;
  }
  const context = getContext();
  const message = context?.chat?.[outcome.capture.messageId];
  if (!isAiStoryMessage(message)) {
    diagnostic('trigger:skip', { reason: 'not-ai-story-message', floor: outcome.capture.messageId });
    hide(false);
    return;
  }
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    hide(false);
    return;
  }
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  pending = outcome.capture;
  dismissed = false;
  console.debug(describeCapture(outcome.capture));
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
    // 划到一半塌陷（误触 / 重新开始）：停掉在途判定，收起气泡，解除显式忽略
    if (settleTimer !== null) {
      window.clearTimeout(settleTimer);
      settleTimer = null;
    }
    if (isToolbarVisible()) hide(false);
    dismissed = false;
    return;
  }
  // 非空选区：只要不是用户显式忽略的，就照常去查。v0.2.3 的抑制位死锁已删——
  // 一次捕获失败不该让气泡永久哑火（真机录屏 32 秒不出气泡的根因）。
  if (dismissed) return;
  scheduleSettle();
}

/**
 * 滚动跟随：气泡是 fixed 定位，文字滚走了它不会自己动。
 * 只要气泡正显示且选区还活着，就按当前选区重新锚定；选区塌陷才收起。
 * 显式忽略（✕ / Esc / 动作完成）后不复显、也不跟随。
 */
function onScroll(): void {
  if (!isToolbarVisible() || dismissed) return;
  const selection = typeof document !== 'undefined' ? document.getSelection?.() ?? window.getSelection() : null;
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    hide(false);
    return;
  }
  showAt(selection.getRangeAt(0).getBoundingClientRect());
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

  // mouseup / touchend 是「用户主动手势」：一律解除显式忽略——用户在划新选区，必须照常浮出。
  // 桌面 mouseup 立即落定；触屏 touchend 走 120ms 去抖（等选区最终定型）。
  const onSettle = () => {
    dismissed = false;
    settle();
  };
  const onTouchEnd = () => {
    dismissed = false;
    scheduleSettle();
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

  doc.addEventListener('mouseup', onSettle, true);
  doc.addEventListener('touchend', onTouchEnd, true);
  doc.addEventListener('keyup', onSettle, true);
  doc.addEventListener('selectionchange', onSelectionChange, true);
  doc.addEventListener('keydown', onKeyDown, true);
  win.addEventListener('scroll', onScroll, true);

  diagnostic('trigger:bound', { toolbarId: TOOLBAR_ID, coarsePointer: COARSE_POINTER, settleDelay: SETTLE_DELAY });

  return () => {
    doc.removeEventListener('mouseup', onSettle, true);
    doc.removeEventListener('touchend', onTouchEnd, true);
    doc.removeEventListener('keyup', onSettle, true);
    doc.removeEventListener('selectionchange', onSelectionChange, true);
    doc.removeEventListener('keydown', onKeyDown, true);
    win.removeEventListener('scroll', onScroll, true);
    if (settleTimer !== null) {
      window.clearTimeout(settleTimer);
      settleTimer = null;
    }
    dismissed = false;
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
