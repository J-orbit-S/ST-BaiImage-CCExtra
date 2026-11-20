import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PREFS_KEY, readPrefs, forgetPrefsCache } from '@/state/prefs';
import { SETTINGS_KEY } from '@/state/settings';
import { closePanel, isPanelMounted, openPanel, setBusyInfo } from '@/ui/panel';

/**
 * 面板跑在柏宝绘的 shadow root 里，Node 没有 DOM，所以这里搭一个刚好够用的假 DOM。
 *
 * 为什么值得写：面板出问题只有两种表现——「打不开」或者「勾了没反应」。
 * 前者用户会报，后者用户会以为插件坏了但说不清楚。这两类都能在这里钉死。
 *
 * 不追求假 DOM 的完整：只实现 panel.ts 真正碰到的那几个 API。
 */

type Listener = (event: unknown) => void;

class FakeElement {
  tagName: string;
  id = '';
  className = '';
  textContent = '';
  dataset: Record<string, string> = {};
  title = '';
  type = '';
  checked = false;
  disabled = false;
  tabIndex = 0;
  parentElement: FakeElement | null = null;
  children: FakeElement[] = [];
  style: Record<string, unknown> = {
    setProperty: (key: string, value: string) => {
      (this.style as Record<string, unknown>)[key] = value;
    },
  };

  private listeners = new Map<string, Listener[]>();

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  append(...nodes: Array<FakeElement | string>): void {
    for (const node of nodes) {
      if (typeof node === 'string') continue;
      node.parentElement = this;
      this.children.push(node);
    }
  }

  appendChild(node: FakeElement): FakeElement {
    this.append(node);
    return node;
  }

  after(): void {
    /* 假 DOM 里不实现，panel 也不该依赖它（曾经写过一版依赖它，正是这次要防的错） */
  }

  setAttribute(): void {
    /* noop */
  }

  remove(): void {
    /* noop */
  }

  contains(): boolean {
    return false;
  }

  closest(): null {
    return null;
  }

  querySelector(): null {
    return null;
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  dispatch(type: string, event: unknown = { target: this, preventDefault() {} }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  /** 深度查找：面板结构是嵌套的，测试要能按 className 抓到控件。 */
  findAll(predicate: (el: FakeElement) => boolean): FakeElement[] {
    const found: FakeElement[] = [];
    for (const child of this.children) {
      if (predicate(child)) found.push(child);
      found.push(...child.findAll(predicate));
    }
    return found;
  }
}

class FakeShadow {
  children: FakeElement[] = [];

  get childElementCount(): number {
    return this.children.length;
  }

  appendChild(element: FakeElement): FakeElement {
    this.children.push(element);
    return element;
  }

  getElementById(id: string): FakeElement | null {
    return this.children.find(child => child.id === id) ?? null;
  }

  querySelector(): null {
    return null;
  }
}

interface Harness {
  shadow: FakeShadow;
  extensionSettings: Record<string, unknown>;
}

/** 装一个「柏宝绘已加载」的宿主：host 有 open shadow，且里面已经有内容（它 mount 过了）。 */
function install(options: { theme?: string; prefs?: Record<string, unknown> } = {}): Harness {
  const shadow = new FakeShadow();
  // 模拟柏宝绘 mount 时挂进去的 <link>：panel 用 childElementCount>0 判断它已经清空过
  shadow.appendChild(new FakeElement('link'));

  const host = new FakeElement('div');
  host.id = 'bbi-app-host';
  (host as unknown as { shadowRoot: FakeShadow }).shadowRoot = shadow;

  const extensionSettings: Record<string, unknown> = {
    [SETTINGS_KEY]: { ui: { theme: options.theme ?? 'night' } },
  };
  if (options.prefs) extensionSettings[PREFS_KEY] = options.prefs;

  const doc = {
    getElementById: (id: string) => (id === host.id ? host : null),
    createElement: (tag: string) => new FakeElement(tag),
    createComment: () => new FakeElement('#comment'),
    addEventListener: () => {},
    removeEventListener: () => {},
    body: new FakeElement('body'),
  };

  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', {
    SillyTavern: {
      getContext: () => ({ extensionSettings, saveSettingsDebounced: () => {} }),
    },
  });

  return { shadow, extensionSettings };
}

function panelRoot(shadow: FakeShadow): FakeElement | null {
  return shadow.getElementById('ccx-panel-root');
}

function checkboxes(shadow: FakeShadow): FakeElement[] {
  return panelRoot(shadow)?.findAll(el => el.className === 'bbi-checkbox') ?? [];
}

beforeEach(() => {
  forgetPrefsCache();
});

afterEach(() => {
  closePanel();
  // 状态行是模块级的，不清会串到下一条用例（曾出现「没在跑却 had:true」的假象）
  setBusyInfo(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  forgetPrefsCache();
});

describe('面板挂载', () => {
  it('插进柏宝绘的 shadow，而不是 document.body', async () => {
    const { shadow } = install();
    await openPanel();

    const root = panelRoot(shadow);
    expect(root).not.toBeNull();
    expect(root?.className).toContain('bbi-root');
    expect(isPanelMounted()).toBe(true);
  });

  it('主题跟随柏宝绘（不自己存一份）', async () => {
    const { shadow } = install({ theme: 'pastel' });
    await openPanel();
    expect(panelRoot(shadow)?.dataset.theme).toBe('pastel');
  });

  it('柏宝绘主题非法时回落 day，而不是留一个空 data-theme（空的话整套变量都没有）', async () => {
    const { shadow } = install({ theme: 'dark' });
    await openPanel();
    expect(panelRoot(shadow)?.dataset.theme).toBe('day');
  });

  it('窗口收窄到 420px，但用的还是柏宝绘那套变量', async () => {
    const { shadow } = install();
    await openPanel();
    const style = panelRoot(shadow)?.style as Record<string, string>;
    expect(style['--bbi-win-max-w']).toBe('420px');
    expect(style['--bbi-win-max-h']).toBe('auto');
  });

  it('重复打开不会往 shadow 里插第二份面板', async () => {
    const { shadow } = install();
    await openPanel();
    await openPanel();
    expect(shadow.children.filter(child => child.id === 'ccx-panel-root')).toHaveLength(1);
  });
});

describe('开关', () => {
  it('默认两个都开，且反映到控件上', async () => {
    const { shadow } = install();
    await openPanel();
    const boxes = checkboxes(shadow);
    expect(boxes).toHaveLength(2);
    expect(boxes.every(box => box.checked)).toBe(true);
  });

  it('读回存过的值：关掉自动出图时控件是未勾选', async () => {
    const { shadow } = install({ prefs: { autoGenerate: false, showOrb: true } });
    await openPanel();
    expect(checkboxes(shadow)[0].checked).toBe(false);
    expect(checkboxes(shadow)[1].checked).toBe(true);
  });

  it('勾选「自动出图」会把偏好写进我们自己的键', async () => {
    const { shadow, extensionSettings } = install({ prefs: { autoGenerate: false, showOrb: true } });
    await openPanel();

    const box = checkboxes(shadow)[0];
    box.checked = true;
    box.dispatch('change');

    expect(readPrefs().autoGenerate).toBe(true);
    expect(extensionSettings[PREFS_KEY]).toMatchObject({ autoGenerate: true });
  });

  it('取消勾选「显示悬浮球」只改这一项，不动另一项', async () => {
    const { shadow, extensionSettings } = install({ prefs: { autoGenerate: false, showOrb: true } });
    await openPanel();

    const box = checkboxes(shadow)[1];
    box.checked = false;
    box.dispatch('change');

    expect(extensionSettings[PREFS_KEY]).toMatchObject({ autoGenerate: false, showOrb: false });
  });

  it('别处改了偏好，已挂载的控件跟着变（不会出现面板和实际不一致）', async () => {
    const { shadow } = install();
    await openPanel();
    const boxes = checkboxes(shadow);
    expect(boxes[0].checked).toBe(true);

    const prefsModule = await import('@/state/prefs');
    prefsModule.updatePrefs({ autoGenerate: false });
    expect(boxes[0].checked).toBe(false);
  });
});

describe('在途状态行', () => {
  it('平时隐藏，setBusyInfo 后才出现', async () => {
    const { shadow } = install();
    await openPanel();

    const busyRow = panelRoot(shadow)?.findAll(el => el.className === 'bbi-switch-row')?.at(-1);
    expect(busyRow?.style.display).toBe('none');

    setBusyInfo({ label: '正在分析第 3 楼…', onCancel: () => {} });
    expect(busyRow?.style.display).toBe('flex');
    const label = busyRow?.findAll(el => el.className === 'bbi-field-label')[0];
    expect(label?.textContent).toBe('正在分析第 3 楼…');

    setBusyInfo(null);
    expect(busyRow?.style.display).toBe('none');
  });

  it('点「取消」转发的就是调用方给的取消动作', async () => {
    const { shadow } = install();
    await openPanel();

    const onCancel = vi.fn();
    setBusyInfo({ label: '正在分析第 7 楼…', onCancel });

    const busyRow = panelRoot(shadow)?.findAll(el => el.className === 'bbi-switch-row')?.at(-1);
    const cancelButton = busyRow?.findAll(el => el.tagName === 'button')[0];
    cancelButton?.dispatch('click');

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('没在跑的时候点取消是空操作（不该抛错）', async () => {
    const { shadow } = install();
    await openPanel();
    const busyRow = panelRoot(shadow)?.findAll(el => el.className === 'bbi-switch-row')?.at(-1);
    const cancelButton = busyRow?.findAll(el => el.tagName === 'button')[0];
    expect(() => cancelButton?.dispatch('click')).not.toThrow();
  });
});
