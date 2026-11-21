import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * trigger 的可见性模型测试（v0.2.6 重写后配套）。
 *
 * 核心不变量：**工具条的可见性是「当前选区」的纯函数**——
 * 选区非空且能捕获就显示，塌陷就收起，滚动就跟随；
 * 任何一次捕获失败都不允许产生「永久哑火」状态（v0.2.3~v0.2.5 抑制位死锁的回归钉）。
 *
 * trigger 跑在真实浏览器里，但它的 DOM 需求极小（建一个 div + 四个 button + 五类事件），
 * 假 DOM 够用；doc/win 走 TriggerOptions 注入，document/window 全局用 vi.stubGlobal 顶住。
 */

const captureResult: { value: unknown } = { value: null };

vi.mock('@/selection/capture', () => ({
  captureSelection: vi.fn(() => captureResult.value ?? { ok: false, reason: 'no-selection' }),
  describeCapture: vi.fn(() => ''),
}));
vi.mock('@/st/context', () => ({
  isAiStoryMessage: vi.fn(() => true),
  getContext: vi.fn(() => ({ chat: { 3: { mes: '正文' } }, getCurrentChatId: () => 'chat-1' })),
}));
vi.mock('@/runner/runSelection', () => ({
  runSelection: vi.fn(async () => ({ status: 'committed' as const })),
  cancelSelectionRun: vi.fn(),
}));
vi.mock('@/state/candidates', () => ({
  addDraft: vi.fn(() => ({ created: true })),
  buildSegmentAnchor: vi.fn(() => ({})),
  countDrafts: vi.fn(() => 0),
}));
vi.mock('@/runner/diagnostic', () => ({ diagnostic: vi.fn() }));
vi.mock('@/ui/notify', () => ({ notify: vi.fn() }));
vi.mock('@/ui/panel', () => ({ setBusyInfo: vi.fn(), openPanel: vi.fn() }));

import { bindSelectionTrigger } from '@/ui/trigger';
import { captureSelection } from '@/selection/capture';

type Handler = (event: unknown) => void;

const OK_CAPTURE = { messageId: 3, swipeId: 0, text: '选中的正文', startLine: 0, endLine: 1 };

function makeRectAt(top: number) {
  return { left: 100, top, width: 300, height: 40, right: 400, bottom: top + 40 };
}

class FakeNode {
  style: Record<string, string> = {};
  children: FakeNode[] = [];
  textContent = '';
  addEventListener = vi.fn();
  append = (...nodes: FakeNode[]): void => {
    this.children.push(...nodes);
  };
  remove = vi.fn();
}

describe('trigger 可见性模型（v0.2.6）', () => {
  let docListeners: Map<string, Set<Handler>>;
  let winListeners: Map<string, Set<Handler>>;
  let appended: FakeNode[];
  let selection: { rangeCount: number; isCollapsed: boolean; getRangeAt: () => { getBoundingClientRect: () => unknown } };
  let unbind: () => void;

  /** 工具条是第一次落定（showAt → ensureToolbar）时才创建的，所以用取数函数而不是变量。 */
  const toolbar = (): FakeNode => appended[0];
  /** 「收起」的两种形态：还没创建过（从没落定）或 display none。 */
  const expectHidden = (): void => {
    expect(!appended[0] || appended[0].style.display === 'none').toBe(true);
  };
  const expectShown = (): void => {
    expect(appended[0]?.style.display).toBe('flex');
  };

  function fireDoc(type: string, event: unknown = {}): void {
    docListeners.get(type)?.forEach(handler => handler(event));
  }
  function fireWin(type: string, event: unknown = {}): void {
    winListeners.get(type)?.forEach(handler => handler(event));
  }
  function liveSelection(top = 200) {
    return {
      rangeCount: 1,
      isCollapsed: false,
      getRangeAt: () => ({ getBoundingClientRect: () => makeRectAt(top) }),
    };
  }
  /** 触发某个按钮的 click（fire 的就是 bindButtonActivation 注册的那条）。 */
  function clickButton(index: number): void {
    const handler = toolbar()
      .children[index].addEventListener.mock.calls.find((call: unknown[]) => call[0] === 'click')?.[1] as Handler;
    handler({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    docListeners = new Map();
    winListeners = new Map();
    appended = [];
    selection = liveSelection();
    const track = (map: Map<string, Set<Handler>>) => (type: string, handler: Handler) => {
      if (!map.has(type)) map.set(type, new Set());
      map.get(type)!.add(handler);
    };
    const untrack = (map: Map<string, Set<Handler>>) => (type: string, handler: Handler) => {
      map.get(type)?.delete(handler);
    };
    const doc = {
      getSelection: () => selection,
      addEventListener: vi.fn(track(docListeners)),
      removeEventListener: vi.fn(untrack(docListeners)),
      createElement: () => new FakeNode(),
      body: { appendChild: (node: FakeNode) => appended.push(node), contains: () => true },
    };
    const win = {
      getSelection: () => selection,
      addEventListener: vi.fn(track(winListeners)),
      removeEventListener: vi.fn(untrack(winListeners)),
      innerWidth: 1024,
      innerHeight: 768,
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (id: number) => clearTimeout(id),
    };
    vi.stubGlobal('document', doc);
    vi.stubGlobal('window', win);
    captureResult.value = { ok: true, capture: OK_CAPTURE };
    vi.mocked(captureSelection).mockClear();
    unbind = bindSelectionTrigger();
  });

  afterEach(() => {
    unbind();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('选区非空 + 捕获成功：selectionchange 去抖 120ms 后浮出', () => {
    fireDoc('selectionchange');
    expectHidden();
    vi.advanceTimersByTime(120);
    expectShown();
  });

  it('拖动手柄期间连发事件不断重置计时，停手后才落定（去抖不闹鬼）', () => {
    fireDoc('selectionchange');
    vi.advanceTimersByTime(100);
    fireDoc('selectionchange');
    vi.advanceTimersByTime(100);
    fireDoc('selectionchange');
    expectHidden();
    vi.advanceTimersByTime(120);
    expectShown();
  });

  it('捕获失败只收起这一次，不产生死锁：随后的 selectionchange 照常重试（回归钉）', () => {
    // 第一次落定失败（比如选区跨楼）
    captureResult.value = { ok: false, reason: 'cross-floor' };
    fireDoc('selectionchange');
    vi.advanceTimersByTime(120);
    expectHidden();
    // 选区没塌陷，用户调整手柄 → 再次 selectionchange：必须照常重查（v0.2.5 以前这里被抑制位拦死）
    captureResult.value = { ok: true, capture: OK_CAPTURE };
    fireDoc('selectionchange');
    vi.advanceTimersByTime(120);
    expectShown();
  });

  it('选区塌陷：立即收起', () => {
    fireDoc('selectionchange');
    vi.advanceTimersByTime(120);
    expectShown();
    selection = { rangeCount: 1, isCollapsed: true, getRangeAt: () => ({ getBoundingClientRect: () => makeRectAt(200) }) };
    fireDoc('selectionchange');
    expectHidden();
  });

  it('滚动跟随：气泡显示中且选区活着 → 按新位置重新锚定', () => {
    fireDoc('selectionchange');
    vi.advanceTimersByTime(120);
    expectShown();
    const topBefore = toolbar().style.top;
    selection = liveSelection(400);
    fireWin('scroll');
    expectShown();
    expect(toolbar().style.top).not.toBe(topBefore);
  });

  it('滚动时选区已塌陷 → 收起', () => {
    fireDoc('selectionchange');
    vi.advanceTimersByTime(120);
    selection = { rangeCount: 1, isCollapsed: true, getRangeAt: () => ({ getBoundingClientRect: () => makeRectAt(200) }) };
    fireWin('scroll');
    expectHidden();
  });

  it('✕ 是显式忽略：滚动与 selectionchange 都不复显，选区塌陷或新手势才解锁', () => {
    fireDoc('selectionchange');
    vi.advanceTimersByTime(120);
    expectShown();
    clickButton(2); // ✕
    expectHidden();

    // 选区还活着：滚动不复显、selectionchange 不复显
    fireWin('scroll');
    expectHidden();
    fireDoc('selectionchange');
    vi.advanceTimersByTime(120);
    expectHidden();

    // 选区塌陷 → 解除；重新划线（mouseup 手势）→ 照常浮出
    selection = { rangeCount: 1, isCollapsed: true, getRangeAt: () => ({ getBoundingClientRect: () => makeRectAt(200) }) };
    fireDoc('selectionchange');
    selection = liveSelection();
    fireDoc('mouseup');
    expectShown();
  });

  it('touchend 是用户手势：解除显式忽略并走 120ms 去抖落定（触屏路径）', () => {
    // 先 ✕ 掉一个旧选区
    fireDoc('selectionchange');
    vi.advanceTimersByTime(120);
    clickButton(2);
    expectHidden();

    // 新手势：touchend（此时选区还是活的）→ 解除忽略 → 去抖后浮出
    fireDoc('touchend');
    vi.advanceTimersByTime(120);
    expectShown();
  });
});
