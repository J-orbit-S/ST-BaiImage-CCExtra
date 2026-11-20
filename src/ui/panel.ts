/**
 * 设置面板：**借用柏宝绘的界面**，不自己造一套。
 *
 * 做法与代价（写在这里，免得以后有人以为这是巧合）：
 * 柏宝绘的 UI 活在 `#bbi-app-host` 的 **open shadow root** 里，样式是它自己的 `index.css`。
 * 我们把自己的节点插进同一棵 shadow、节点自带 `class="bbi-root" data-theme=…`，
 * 于是 `.bbi-window / .bbi-body / .bbi-switch-row / .bbi-checkbox / .bbi-field-*` 直接生效——
 * 这些都在它的**全局** base.css 里，**一行 CSS 都不用复制**。
 *
 * 只有题头（`.bbi-head` / `.bbi-icon-btn`）拿不到：那几个类写在 App.vue 的 `<style scoped>` 里，
 * 编译后带 `data-v-*` 属性选择器，我们的节点没有那个属性。所以这四处用内联样式复刻同样的
 * 几何与变量（36px 圆角按钮、14px/16px 内边距），颜色仍走 `--bbi-*` → 主题照样跟随。
 *
 * 代价：面板依赖柏宝绘先加载。没启用时**不做备用样式**（那等于养第二份 CSS 副本，
 * 比依赖更危险），只给一句人话提示。
 *
 * 尺寸也不改它任何文件：`.bbi-window` 的宽高读 CSS 变量，我们在自己根节点上
 * 覆写 `--bbi-win-max-w` 就得到「同款壳、只是窄」。
 */

import { diagnostic } from '@/runner/diagnostic';
import { onPrefsChange, readPrefs, updatePrefs, type Prefs } from '@/state/prefs';
import { notify } from '@/ui/notify';
import { readBaibaiTheme } from '@/ui/theme';

/** 柏宝绘的 shadow host（它自己 `index.ts` 里创建，id 固定）。 */
const HOST_ID = 'bbi-app-host';
/** 我们的根节点 id：既用于查重，也方便用户在 devtools 里认出这是谁的东西。 */
const ROOT_ID = 'ccx-panel-root';
const PANEL_TITLE = '划线出图';

/** 打开面板时等柏宝绘就绪的上限。加载顺序不确定，多等一会儿比误报「没启用」好。 */
const MOUNT_TIMEOUT_MS = 5000;
const MOUNT_POLL_MS = 200;

export interface BusyInfo {
  label: string;
  onCancel: () => void;
}

interface PanelDom {
  root: HTMLDivElement;
  overlay: HTMLDivElement;
  autoInput: HTMLInputElement;
  orbInput: HTMLInputElement;
  busyRow: HTMLDivElement;
  busyLabel: HTMLSpanElement;
  cancelButton: HTMLButtonElement;
}

let dom: PanelDom | null = null;
let opened = false;
let busyInfo: BusyInfo | null = null;
let unbindPrefs: (() => void) | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 取柏宝绘的 shadow root。
 * `childElementCount > 0` 是必须的：它 mount 时先 `shadow.textContent = ''` 再挂内容，
 * 若在那一刻插进去会被整棵清掉。等它有子节点，说明那一次清空已经过去了。
 */
function baibaiShadow(): ShadowRoot | null {
  if (typeof document === 'undefined') return null;
  const host = document.getElementById(HOST_ID);
  const shadow = host?.shadowRoot ?? null;
  return shadow && shadow.childElementCount > 0 ? shadow : null;
}

/** 小按钮：颜色走柏宝绘变量，所以自动跟随主题（含它以后新增的主题）。 */
function styleSmallButton(button: HTMLButtonElement): void {
  Object.assign(button.style, {
    border: '1px solid var(--bbi-line-strong)',
    borderRadius: 'var(--bbi-radius-pill)',
    background: 'var(--bbi-surface-2)',
    color: 'var(--bbi-ink)',
    padding: '4px 14px',
    font: '600 12px/1.6 var(--bbi-font-sans)',
    cursor: 'pointer',
  } as Partial<CSSStyleDeclaration>);
}

/** 题头条形按钮：数值抄 App.vue 里 `32/36px` 那套几何（原因见文件头）。 */
function styleIconButton(button: HTMLButtonElement): void {
  Object.assign(button.style, {
    width: '36px',
    height: '36px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '0',
    borderRadius: 'var(--bbi-radius-sm)',
    background: 'var(--bbi-surface-2)',
    color: 'var(--bbi-ink-soft)',
    cursor: 'pointer',
    fontSize: '15px',
  } as Partial<CSSStyleDeclaration>);
}

interface SwitchParts {
  row: HTMLLabelElement;
  input: HTMLInputElement;
  hint: HTMLParagraphElement;
}

/**
 * 一行开关 + 一段说明。
 * 结构照柏宝绘各设置页：`label.bbi-switch-row` 里放「标签 + 原生 checkbox」，
 * 说明单独一段 `.bbi-field-hint`（它有意做成「一段话」而不是挤在开关行里）。
 */
function buildSwitch(labelText: string, hintText: string): SwitchParts {
  const row = document.createElement('label');
  row.className = 'bbi-switch-row';

  const label = document.createElement('span');
  label.className = 'bbi-field-label';
  label.textContent = labelText;

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'bbi-checkbox';

  row.append(label, input);

  const hint = document.createElement('p');
  hint.className = 'bbi-field-hint';
  hint.textContent = hintText;

  return { row, input, hint };
}

function build(): PanelDom {
  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.className = 'bbi-root';
  root.dataset.theme = readBaibaiTheme();
  // 同款窗口壳，只是收窄；高度交给内容
  root.style.setProperty('--bbi-win-max-w', '420px');
  root.style.setProperty('--bbi-win-max-h', 'auto');
  root.style.setProperty('--bbi-page-pad', '20px');

  const overlay = document.createElement('div');
  overlay.className = 'bbi-overlay';
  overlay.style.display = 'none'; // 不用 hidden：.bbi-overlay 的 display:flex 会盖掉 [hidden]
  overlay.addEventListener('click', event => {
    if (event.target === overlay) closePanel();
  });

  const win = document.createElement('div');
  win.className = 'bbi-window';
  win.setAttribute('role', 'dialog');
  win.setAttribute('aria-modal', 'true');
  win.setAttribute('aria-label', PANEL_TITLE);
  // 基类写死了 height:var(--bbi-win-max-h) 与 max-height，这里收回成「按内容」
  win.style.height = 'auto';
  win.style.maxHeight = 'none';

  const head = document.createElement('header');
  head.className = 'bbi-head';
  Object.assign(head.style, {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '14px 16px',
    flex: '0 0 auto',
  } as Partial<CSSStyleDeclaration>);

  const brand = document.createElement('span');
  brand.className = 'bbi-brand-name';
  brand.textContent = PANEL_TITLE;
  Object.assign(brand.style, {
    fontWeight: '600',
    fontSize: '16px',
    letterSpacing: '-0.01em',
    color: 'var(--bbi-ink)',
  } as Partial<CSSStyleDeclaration>);

  const actions = document.createElement('div');
  actions.className = 'bbi-head-actions';
  actions.style.display = 'flex';
  actions.style.gap = '8px';

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'bbi-icon-btn';
  closeButton.title = '关闭';
  closeButton.setAttribute('aria-label', '关闭');
  closeButton.textContent = '✕';
  styleIconButton(closeButton);
  closeButton.addEventListener('click', () => closePanel());

  actions.append(closeButton);
  head.append(brand, actions);

  const body = document.createElement('main');
  body.className = 'bbi-body';
  const page = document.createElement('div');
  page.className = 'bbi-page';

  const auto = buildSwitch(
    '自动出图',
    '划完线直接开始出图。关掉则只写入 tag，由你自己点卡片上的「生成图片」。',
  );
  const orb = buildSwitch('显示悬浮球', '关掉后可以从魔术棒菜单（🍃 划线出图）进来这里重新打开。');

  // 在途分析的状态行：只在真正跑的时候出现，平时不占地方
  const busyRow = document.createElement('div');
  busyRow.className = 'bbi-switch-row';
  busyRow.style.display = 'none';
  const busyLabel = document.createElement('span');
  busyLabel.className = 'bbi-field-label';
  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.textContent = '取消';
  styleSmallButton(cancelButton);
  busyRow.append(busyLabel, cancelButton);

  page.append(auto.row, auto.hint, orb.row, orb.hint, busyRow);
  body.append(page);
  win.append(head, body);
  overlay.append(win);
  root.append(overlay);

  return { root, overlay, autoInput: auto.input, orbInput: orb.input, busyRow, busyLabel, cancelButton };
}

/** 把偏好值刷到控件上。打开面板时、以及任何地方改了偏好，都走它。 */
function syncControls(prefs: Prefs): void {
  if (!dom) return;
  if (dom.autoInput.checked !== prefs.autoGenerate) dom.autoInput.checked = prefs.autoGenerate;
  if (dom.orbInput.checked !== prefs.showOrb) dom.orbInput.checked = prefs.showOrb;
}

function applyBusy(next: PanelDom): void {
  if (!busyInfo) {
    next.busyRow.style.display = 'none';
    next.busyLabel.textContent = '';
    return;
  }
  next.busyLabel.textContent = busyInfo.label;
  next.busyRow.style.display = 'flex';
}

function bindDom(next: PanelDom): void {
  next.autoInput.addEventListener('change', () => {
    const value = next.autoInput.checked;
    diagnostic('panel:autoGenerate', { value });
    updatePrefs({ autoGenerate: value });
    // 只在关掉时提示：开启是默认态，说一句反而啰嗦；关掉要让人知道「以后得自己点」
    if (!value) notify('info', '已切换为手动：划完线只写 tag，出图请你点卡片');
  });

  next.orbInput.addEventListener('change', () => {
    const value = next.orbInput.checked;
    diagnostic('panel:showOrb', { value });
    updatePrefs({ showOrb: value });
  });

  next.cancelButton.addEventListener('click', () => {
    const info = busyInfo;
    diagnostic('panel:cancel', { had: Boolean(info) });
    info?.onCancel();
  });

  unbindPrefs?.();
  unbindPrefs = onPrefsChange(prefs => syncControls(prefs));
}

/** 确保已插入柏宝绘的 shadow；返回是否可用。 */
function ensureMounted(): PanelDom | null {
  const shadow = baibaiShadow();
  if (!shadow) return null;

  const existing = shadow.getElementById(ROOT_ID) as HTMLDivElement | null;
  if (existing && dom && existing === dom.root) return dom;

  dom = build();
  shadow.appendChild(dom.root);
  bindDom(dom);
  diagnostic('panel:mounted', { theme: dom.root.dataset.theme ?? '' });
  return dom;
}

function show(next: PanelDom): void {
  next.root.dataset.theme = readBaibaiTheme();
  syncControls(readPrefs());
  applyBusy(next);
  next.overlay.style.display = 'flex';
  opened = true;
  diagnostic('panel:open', { theme: next.root.dataset.theme });
}

export function closePanel(): void {
  if (!dom || !opened) return;
  dom.overlay.style.display = 'none';
  opened = false;
  diagnostic('panel:close', {});
}

export function isPanelOpen(): boolean {
  return opened;
}

/**
 * 打开面板。柏宝绘可能还没 mount，这里等一会儿；实在等不到才提示，
 * 避免「刚刷新就点菜单」被误报成「没装柏宝绘」。
 */
export async function openPanel(): Promise<void> {
  const deadline = Date.now() + MOUNT_TIMEOUT_MS;
  for (;;) {
    const mounted = ensureMounted();
    if (mounted) {
      show(mounted);
      return;
    }
    if (Date.now() >= deadline) break;
    await sleep(MOUNT_POLL_MS);
  }
  diagnostic('panel:no-host', { hostId: HOST_ID, hasDocument: typeof document !== 'undefined' });
  notify('warning', '没有找到柏宝绘的界面：请先在「扩展」里启用柏宝绘，划线出图借的是它的面板样式');
}

export function togglePanel(): void {
  if (opened) closePanel();
  else void openPanel();
}

/**
 * 在途分析的状态行。传 `null` 收起。
 * 这里只做展示与转发取消，不认识 runSelection —— 取消动作由调用方给，
 * 避免 UI 反向依赖编排层（也让它能在测试里单独喂一个假 cancel）。
 */
export function setBusyInfo(info: BusyInfo | null): void {
  busyInfo = info;
  if (dom) applyBusy(dom);
}

/** 绑 Esc 关闭。只在面板开着时接管，不干扰 ST 自己的快捷键。 */
export function bindPanelHotkeys(): () => void {
  if (typeof document === 'undefined') return () => {};
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && opened) {
      event.stopPropagation();
      closePanel();
    }
  };
  document.addEventListener('keydown', onKeyDown, true);
  return () => document.removeEventListener('keydown', onKeyDown, true);
}

/** 仅供诊断：面板是否已挂在柏宝绘的 shadow 上。 */
export function isPanelMounted(): boolean {
  return Boolean(baibaiShadow()?.getElementById(ROOT_ID));
}
