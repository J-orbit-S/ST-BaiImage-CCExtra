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
 * 面板里有两块东西：
 *   ① 本插件自己的开关（自动出图 / 需确认 / 显示悬浮球）；
 *   ② 待确认的候选画面（volume 2 的确认式）。候选卡片是纯 DOM 现搭，样式全部走 `--bbi-*`。
 *
 * 代价：面板依赖柏宝绘先加载。没启用时**不做备用样式**（那等于养第二份 CSS 副本，
 * 比依赖更危险），只给一句人话提示。
 */

import { diagnostic } from '@/runner/diagnostic';
import { commitCandidate, rerollCandidate } from '@/runner/commit';
import {
  countPending,
  editCandidateTag,
  discardCandidate,
  listCandidates,
  onCandidatesChange,
  type ImageCandidate,
} from '@/state/candidates';
import { onPrefsChange, readPrefs, updatePrefs, type Prefs } from '@/state/prefs';
import { notify } from '@/ui/notify';
import { readBaibaiTheme } from '@/ui/theme';
import { getContext } from '@/st/context';

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
  confirmInput: HTMLInputElement;
  confirmRow: HTMLElement;
  orbInput: HTMLInputElement;
  busyRow: HTMLDivElement;
  busyLabel: HTMLSpanElement;
  cancelButton: HTMLButtonElement;
  candidatesSection: HTMLElement;
  candidatesTitle: HTMLSpanElement;
  candidatesEmpty: HTMLParagraphElement;
  candidatesList: HTMLDivElement;
}

let dom: PanelDom | null = null;
let opened = false;
let busyInfo: BusyInfo | null = null;
let unbindPrefs: (() => void) | null = null;
let unbindCandidates: (() => void) | null = null;
let chatHookBound = false;
/** 正在确认 / 重 Roll 的那一条（同一时刻只允许一个动作，避免连点造出两份写回）。 */
let actionBusy = false;
/** 正在编辑哪一条，以及编辑中的草稿（重绘列表时必须保留，否则一改就丢字）。 */
let editingId: string | null = null;
let editingText = '';

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

/**
 * 清空一个容器。
 *
 * 为什么不用 `textContent = ''`：单元测试里的假 DOM 只把它当普通字段，子节点还在，
 * 重绘一次列表就会叠一层。`replaceChildren` 是真 DOM 的正解，假 DOM 用数组清空顶上。
 */
function clearNode(node: HTMLElement): void {
  const candidate = node as unknown as { replaceChildren?: () => void; children?: unknown[] };
  if (typeof candidate.replaceChildren === 'function') {
    candidate.replaceChildren();
    return;
  }
  if (Array.isArray(candidate.children)) {
    candidate.children.length = 0;
    return;
  }
  node.textContent = '';
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
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
  // 基类写死了 height:var(--bbi-win-max-h) 与 max-height，这里收回成「按内容」；
  // 候选一多就滚动，别把整个视口顶满
  win.style.height = 'auto';
  win.style.maxHeight = '80vh';
  win.style.display = 'flex';
  win.style.flexDirection = 'column';

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
  body.style.overflowY = 'auto';
  const page = document.createElement('div');
  page.className = 'bbi-page';

  const auto = buildSwitch(
    '自动出图',
    '划完线直接开始出图。关掉则只写入 tag，由你自己点卡片上的「生成图片」。',
  );
  const confirm = buildSwitch(
    '需确认',
    '先出候选 tag，确认后才写进正文——确认即出图，不会再问一次。自动出图开着时此项不可用。',
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

  page.append(auto.row, auto.hint, confirm.row, confirm.hint, orb.row, orb.hint, busyRow);

  // —— 候选区（确认式）：标题 + 空态 + 列表 ——
  const candidatesSection = el('section');
  Object.assign(candidatesSection.style, {
    marginTop: '18px',
    paddingTop: '14px',
    borderTop: '1px solid var(--bbi-line)',
  } as Partial<CSSStyleDeclaration>);

  const candidatesTitle = el('span', 'bbi-field-label');
  Object.assign(candidatesTitle.style, {
    display: 'block',
    fontWeight: '600',
    fontSize: '13px',
    color: 'var(--bbi-ink)',
    marginBottom: '8px',
  } as Partial<CSSStyleDeclaration>);

  const candidatesEmpty = el('p', 'bbi-field-hint');
  candidatesEmpty.textContent = '没有待确认的画面。划选正文 → 点「生成 tag」，候选会出现在这里。';

  const candidatesList = el('div');
  candidatesList.style.display = 'flex';
  candidatesList.style.flexDirection = 'column';

  candidatesSection.append(candidatesTitle, candidatesEmpty, candidatesList);

  page.append(candidatesSection);
  body.append(page);
  win.append(head, body);
  overlay.append(win);
  root.append(overlay);

  return {
    root,
    overlay,
    autoInput: auto.input,
    confirmInput: confirm.input,
    confirmRow: confirm.row,
    orbInput: orb.input,
    busyRow,
    busyLabel,
    cancelButton,
    candidatesSection,
    candidatesTitle,
    candidatesEmpty,
    candidatesList,
  };
}

/** 把偏好值刷到控件上。打开面板时、以及任何地方改了偏好，都走它。 */
function syncControls(prefs: Prefs): void {
  if (!dom) return;
  if (dom.autoInput.checked !== prefs.autoGenerate) dom.autoInput.checked = prefs.autoGenerate;
  if (dom.confirmInput.checked !== prefs.confirmTag) dom.confirmInput.checked = prefs.confirmTag;
  if (dom.orbInput.checked !== prefs.showOrb) dom.orbInput.checked = prefs.showOrb;

  // 互锁的 UI 投影。真正的压制在 normalizePrefs 里（状态层），这里只负责「看起来也对」。
  const locked = prefs.autoGenerate;
  dom.confirmInput.disabled = locked;
  dom.confirmRow.style.opacity = locked ? '0.45' : '1';
  dom.confirmRow.title = locked ? '自动出图开着时，划线就已经是完整闭环了，不需要再确认一次' : '';
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

/** 卡片上的小按钮（全部走内联样式，不依赖 scoped 类）。 */
function cardButton(text: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = text;
  styleSmallButton(button);
  button.style.padding = '3px 11px';
  button.style.fontSize = '12px';
  if (disabled) {
    button.disabled = true;
    button.style.opacity = '0.5';
    button.style.cursor = 'default';
  } else {
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
  }
  return button;
}

/** 一条候选的动作：串行执行，跑的时候整列按钮禁用（避免连点写两遍）。 */
async function runAction(label: string, fn: () => Promise<{ status: string; message: string }>): Promise<void> {
  if (actionBusy) return;
  actionBusy = true;
  renderCandidates();
  try {
    const outcome = await fn();
    if (outcome.status === 'aborted') notify('info', '已取消，正文未改动');
  } catch (error) {
    console.error(`[CCX] ${label}失败`, error);
    notify('error', `「${label}」失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    actionBusy = false;
    renderCandidates();
  }
}

function buildCard(item: ImageCandidate, ordinal: number): HTMLElement {
  const card = el('div');
  Object.assign(card.style, {
    border: '1px solid var(--bbi-line)',
    borderRadius: 'var(--bbi-radius-sm)',
    background: 'var(--bbi-surface-2)',
    padding: '10px 12px',
    marginBottom: '8px',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  } as Partial<CSSStyleDeclaration>);

  const head = el('div');
  Object.assign(head.style, {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
  } as Partial<CSSStyleDeclaration>);

  const title = el('span');
  title.textContent = `画面 ${String(ordinal + 1).padStart(2, '0')} · 第 ${item.floor} 楼`;
  Object.assign(title.style, {
    font: '600 12px/1.5 var(--bbi-font-sans)',
    color: 'var(--bbi-ink)',
  } as Partial<CSSStyleDeclaration>);

  const badge = el('span');
  badge.textContent = `待确认 ${item.activeVersion + 1}/${item.versions.length}`;
  Object.assign(badge.style, {
    font: '600 11px/1.4 var(--bbi-font-sans)',
    color: 'var(--bbi-ink-soft)',
    border: '1px solid var(--bbi-line)',
    borderRadius: 'var(--bbi-radius-pill)',
    padding: '1px 8px',
    whiteSpace: 'nowrap',
  } as Partial<CSSStyleDeclaration>);

  head.append(title, badge);

  const editing = editingId === item.imageId;
  const current = item.versions[item.activeVersion];

  if (editing) {
    const area = document.createElement('textarea');
    area.value = editingText;
    Object.assign(area.style, {
      width: '100%',
      minHeight: '64px',
      boxSizing: 'border-box',
      background: 'var(--bbi-surface)',
      color: 'var(--bbi-ink)',
      border: '1px solid var(--bbi-line-strong)',
      borderRadius: 'var(--bbi-radius-sm)',
      padding: '6px 8px',
      font: '12px/1.55 var(--bbi-font-sans)',
      resize: 'vertical',
    } as Partial<CSSStyleDeclaration>);
    area.addEventListener('input', () => {
      editingText = area.value;
    });

    const row = el('div');
    row.style.display = 'flex';
    row.style.gap = '6px';
    row.append(
      cardButton(
        '保存',
        () => {
          // 只改候选，不重跑 API：改一两个词不该花额度
          if (!editCandidateTag(item.imageId, editingText)) notify('warning', '提示词不能为空');
          else {
            editingId = null;
            editingText = '';
            diagnostic('panel:candidateEdit', { imageId: item.imageId });
          }
          renderCandidates();
        },
        actionBusy,
      ),
      cardButton(
        '取消',
        () => {
          editingId = null;
          editingText = '';
          renderCandidates();
        },
        actionBusy,
      ),
    );

    card.append(head, area, row);
    return card;
  }

  const tag = el('p');
  tag.textContent = current.image.tag;
  Object.assign(tag.style, {
    margin: '0',
    maxHeight: '72px',
    overflowY: 'auto',
    font: '12px/1.55 var(--bbi-font-sans)',
    color: 'var(--bbi-ink)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  } as Partial<CSSStyleDeclaration>);

  const row = el('div');
  Object.assign(row.style, { display: 'flex', gap: '6px', flexWrap: 'wrap' } as Partial<CSSStyleDeclaration>);
  row.append(
    cardButton('✓ 确认', () => void runAction('确认', () => commitCandidate(item.imageId)), actionBusy),
    cardButton('⟳ 重 Roll', () => void runAction('重 Roll', () => rerollCandidate(item.imageId)), actionBusy),
    cardButton(
      '✎ 编辑',
      () => {
        editingId = item.imageId;
        editingText = current.image.tag;
        renderCandidates();
      },
      actionBusy,
    ),
    cardButton(
      '✕ 删除',
      () => {
        discardCandidate(item.imageId);
        if (editingId === item.imageId) {
          editingId = null;
          editingText = '';
        }
        renderCandidates();
      },
      actionBusy,
    ),
  );

  card.append(head, tag, row);
  return card;
}

/** 重绘候选列表。池子一变、面板一打开、切聊天都会走它。 */
export function renderCandidates(): void {
  if (!dom) return;
  paintCandidates(dom, listCandidates());
}

function paintCandidates(target: PanelDom, items: ImageCandidate[]): void {
  target.candidatesTitle.textContent = items.length ? `待确认 ${items.length}` : '待确认';
  target.candidatesEmpty.style.display = items.length ? 'none' : 'block';
  clearNode(target.candidatesList);

  // 编辑中的那条如果已经不在池子里（比如被别处删了），把编辑态一起清掉
  if (editingId && !items.some(item => item.imageId === editingId)) {
    editingId = null;
    editingText = '';
  }

  items.forEach((item, index) => {
    target.candidatesList.append(buildCard(item, index));
  });
}

function bindDom(next: PanelDom): void {
  next.autoInput.addEventListener('change', () => {
    const value = next.autoInput.checked;
    diagnostic('panel:autoGenerate', { value });
    // 打开自动出图会把「需确认」压成 false（状态层负责），这里只补一句人话
    updatePrefs({ autoGenerate: value });
    notify(
      'info',
      value ? '已开启自动出图：划线后直接出图（需确认已自动关闭）' : '已切换为手动：划完线只写 tag，出图请你点卡片',
    );
  });

  next.confirmInput.addEventListener('change', () => {
    const value = next.confirmInput.checked;
    diagnostic('panel:confirmTag', { value });
    updatePrefs({ confirmTag: value });
    if (value) notify('info', '已开启需确认：划线后先生成候选，确认才写入正文并出图');
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

  unbindCandidates?.();
  unbindCandidates = onCandidatesChange(() => renderCandidates());

  // 切聊天后候选属于另一个聊天：重绘而不是清空（池子按 chatId 过滤，天然隔离）
  if (!chatHookBound) {
    const context = getContext();
    const chatChanged = context?.eventTypes?.CHAT_CHANGED;
    if (chatChanged && context?.eventSource?.on) {
      context.eventSource.on(chatChanged, () => {
        editingId = null;
        editingText = '';
        renderCandidates();
      });
      chatHookBound = true;
    }
  }
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
  renderCandidates();
  next.overlay.style.display = 'flex';
  opened = true;
  diagnostic('panel:open', { theme: next.root.dataset.theme, pending: countPending() });
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

/** 仅供测试：清掉「聊天事件只绑一次」与编辑态（模块级状态，用例之间会互相污染）。 */
export function resetPanelState(): void {
  chatHookBound = false;
  editingId = null;
  editingText = '';
  actionBusy = false;
  unbindCandidates?.();
  unbindCandidates = null;
  unbindPrefs?.();
  unbindPrefs = null;
}
