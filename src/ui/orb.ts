/**
 * 🍃 悬浮球：伸进宿主页面的把手。
 *
 * 交互照柏宝绘那颗球的规矩来（不是抄代码，是照它的手感，免得两个球用起来不一样）：
 * - 自由拖动，拖到屏幕中间就停在中间；
 * - 只有松手时距左/右边缘 ≤ 56px 才吸附贴边，贴边后静止半隐、hover / 聚焦 / 拖动才整条滑出；
 * - 位移小于 6px 视为「点击」→ 打开面板；
 * - 位置存本机 localStorage（各设备屏幕尺寸不同，同步反而会跑到屏幕外）。
 *
 * 与柏宝绘那颗球的区别：**放在 light DOM**（`document.body`），不塞进它的 shadow root。
 * 理由是入口应该比面板更早可用——柏宝绘还没加载完时，用户点球至少能得到一句解释，
 * 而不是「点了没反应」。球的视觉极简（圆底 + emoji + 阴影），不需要它那套主题变量。
 */

import { diagnostic } from '@/runner/diagnostic';
import { openPanel } from '@/ui/panel';

const ORB_ID = 'ccx-orb';
const POS_KEY = 'ccx.orb.pos.v1';
const ORB_SIZE = 44;
const SNAP_ZONE = 56;
const CLICK_SLOP = 6;

export type Dock = 'left' | 'right' | 'none';

/** 松手后该吸附到哪边。抽成纯函数：这是球唯一的数学逻辑，也是最容易算反的一处。 */
export function decideDock(
  x: number,
  viewportWidth: number,
  orbSize: number = ORB_SIZE,
  snapZone: number = SNAP_ZONE,
): Dock {
  if (x <= snapZone) return 'left';
  if (viewportWidth - (x + orbSize) <= snapZone) return 'right';
  return 'none';
}

interface OrbPos {
  dock: Dock;
  /** 贴边时无意义；free 时为左上角 x */
  x: number;
  /** 左上角 y，三种状态都用 */
  y: number;
}

let orb: HTMLDivElement | null = null;
let pos: OrbPos = { dock: 'right', x: 0, y: 0 };
let dragging = false;
let awake = false;
let activePointer: number | null = null;
let grabDX = 0;
let grabDY = 0;
let startX = 0;
let startY = 0;
let moved = 0;
let boundResize = false;

function viewport(): { w: number; h: number } {
  if (typeof window === 'undefined') return { w: 1280, h: 800 };
  return { w: window.innerWidth, h: window.innerHeight };
}

function loadPos(): OrbPos {
  const { h } = viewport();
  const fallback: OrbPos = { dock: 'right', x: 0, y: Math.round(h * 0.6) };
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<OrbPos>;
    if (!parsed || typeof parsed !== 'object') return fallback;
    const dock: Dock =
      parsed.dock === 'left' || parsed.dock === 'right' || parsed.dock === 'none' ? parsed.dock : 'right';
    return {
      dock,
      x: Number.isFinite(parsed.x) ? Number(parsed.x) : 0,
      y: Number.isFinite(parsed.y) ? Number(parsed.y) : fallback.y,
    };
  } catch {
    return fallback;
  }
}

function savePos(): void {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify(pos));
  } catch {
    /* 存不了就算了，下次回到默认位置，不影响功能 */
  }
}

function clampToViewport(): void {
  const { w, h } = viewport();
  const maxY = Math.max(0, h - ORB_SIZE);
  const maxX = Math.max(0, w - ORB_SIZE);
  pos.y = Math.min(Math.max(0, pos.y), maxY);
  if (pos.dock === 'none') pos.x = Math.min(Math.max(0, pos.x), maxX);
}

function currentLeft(): number {
  const { w } = viewport();
  if (pos.dock === 'right') return w - ORB_SIZE;
  if (pos.dock === 'left') return 0;
  return pos.x;
}

/** 贴在左/右边缘时静止半隐，唤醒/拖动整条滑出。 */
function applyTransform(): void {
  if (!orb) return;
  if (pos.dock === 'left') {
    orb.style.left = '0px';
    orb.style.right = '';
    orb.style.transform = dragging || awake ? 'translateX(0)' : 'translateX(-42%)';
  } else if (pos.dock === 'right') {
    orb.style.left = '';
    orb.style.right = '0px';
    orb.style.transform = dragging || awake ? 'translateX(0)' : 'translateX(42%)';
  } else {
    orb.style.left = `${pos.x}px`;
    orb.style.right = '';
    orb.style.transform = 'translateX(0)';
  }
  orb.style.top = `${pos.y}px`;
}

function onPointerDown(event: PointerEvent): void {
  if (!orb) return;
  activePointer = event.pointerId;
  dragging = true;
  moved = 0;
  startX = event.clientX;
  startY = event.clientY;
  grabDX = event.clientX - currentLeft();
  grabDY = event.clientY - pos.y;
  orb.style.opacity = '1';
  try {
    orb.setPointerCapture(event.pointerId);
  } catch {
    /* 某些环境不支持捕获，靠 document 上的 pointermove 兜底 */
  }
  applyTransform();
}

function onPointerMove(event: PointerEvent): void {
  if (!dragging || event.pointerId !== activePointer) return;
  moved = Math.max(moved, Math.abs(event.clientX - startX) + Math.abs(event.clientY - startY));
  pos.dock = 'none';
  pos.x = event.clientX - grabDX;
  pos.y = event.clientY - grabDY;
  clampToViewport();
  applyTransform();
}

function onPointerUp(event: PointerEvent): void {
  if (!dragging || event.pointerId !== activePointer) return;
  dragging = false;
  activePointer = null;

  if (moved < CLICK_SLOP) {
    // 点击：打开面板。贴边状态保持不变（跟柏宝绘一致，不因为点了一下就跳回中间）
    diagnostic('orb:click', { dock: pos.dock });
    void openPanel();
    applyTransform();
    return;
  }

  const { w } = viewport();
  pos.dock = decideDock(pos.x, w);
  clampToViewport();
  savePos();
  applyTransform();
  diagnostic('orb:drop', { dock: pos.dock, x: Math.round(pos.x), y: Math.round(pos.y) });
}

function ensureOrb(): HTMLDivElement {
  if (orb && document.body.contains(orb)) return orb;

  const el = document.createElement('div');
  el.id = ORB_ID;
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  el.title = '划线出图';
  el.setAttribute('aria-label', '划线出图');
  el.textContent = '🍃';

  Object.assign(el.style, {
    position: 'fixed',
    zIndex: '9999',
    width: `${ORB_SIZE}px`,
    height: `${ORB_SIZE}px`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxSizing: 'border-box',
    borderRadius: '999px',
    background: 'rgba(255,255,255,.92)',
    border: '1px solid rgba(0,0,0,.08)',
    boxShadow: '0 6px 16px rgba(0,0,0,.24)',
    fontSize: '22px',
    lineHeight: '1',
    cursor: 'grab',
    userSelect: 'none',
    touchAction: 'none',
    opacity: '0.72',
    transition: 'transform .28s cubic-bezier(.22,.61,.36,1), opacity .28s cubic-bezier(.22,.61,.36,1)',
  } as Partial<CSSStyleDeclaration>);

  el.addEventListener('pointerdown', onPointerDown);
  el.addEventListener('pointermove', onPointerMove);
  el.addEventListener('pointerup', onPointerUp);
  el.addEventListener('pointercancel', onPointerUp);
  el.addEventListener('pointerenter', () => {
    awake = true;
    applyTransform();
  });
  el.addEventListener('pointerleave', () => {
    awake = false;
    applyTransform();
  });
  el.addEventListener('focus', () => {
    awake = true;
    applyTransform();
  });
  el.addEventListener('blur', () => {
    awake = false;
    applyTransform();
  });
  el.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      void openPanel();
    }
  });

  document.body.appendChild(el);
  orb = el;
  pos = loadPos();
  clampToViewport();
  applyTransform();
  return el;
}

function onResize(): void {
  clampToViewport();
  savePos();
  applyTransform();
}

/** 按偏好显示/隐藏。幂等，可反复调用。 */
export function syncOrb(show: boolean): void {
  if (typeof document === 'undefined') return;
  if (!show) {
    orb?.remove();
    orb = null;
    if (boundResize) {
      window.removeEventListener('resize', onResize);
      boundResize = false;
    }
    return;
  }
  ensureOrb();
  if (!boundResize) {
    window.addEventListener('resize', onResize);
    boundResize = true;
  }
}

/** 仅供诊断。 */
export function isOrbVisible(): boolean {
  return Boolean(orb && document.body.contains(orb));
}
