import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PREFS_KEY, readPrefs, forgetPrefsCache } from '@/state/prefs';
import { SETTINGS_KEY } from '@/state/settings';
import { CANDIDATES_KEY } from '@/state/candidates';
import { closePanel, isPanelMounted, openPanel, resetPanelState, setBusyInfo } from '@/ui/panel';

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
  value = '';
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

  dispatch(type: string, event: unknown = { target: this, preventDefault() {}, stopPropagation() {} }): void {
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
  chatMetadata: Record<string, unknown>;
}

/** 装一个「柏宝绘已加载」的宿主：host 有 open shadow，且里面已经有内容（它 mount 过了）。 */
function install(
  options: {
    theme?: string;
    prefs?: Record<string, unknown>;
    candidates?: unknown[];
    chatId?: string;
  } = {},
): Harness {
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

  const chatMetadata: Record<string, unknown> = {};
  if (options.candidates?.length) chatMetadata[CANDIDATES_KEY] = { v: 1, items: options.candidates };

  const doc = {
    getElementById: (id: string) => (id === host.id ? host : null),
    createElement: (tag: string) => new FakeElement(tag),
    createComment: () => new FakeElement('#comment'),
    addEventListener: () => {},
    removeEventListener: () => {},
    body: new FakeElement('body'),
  };

  const chatId = options.chatId ?? 'chat-panel';
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', {
    SillyTavern: {
      getContext: () => ({
        extensionSettings,
        chatMetadata,
        getCurrentChatId: () => chatId,
        saveMetadataDebounced: () => {},
        saveSettingsDebounced: () => {},
      }),
    },
  });

  return { shadow, extensionSettings, chatMetadata };
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
  resetPanelState();
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
  it('四个开关的默认状态：自动出图开、需确认关、中文对照开、悬浮球开', async () => {
    const { shadow } = install();
    await openPanel();
    const boxes = checkboxes(shadow);
    expect(boxes).toHaveLength(4);
    expect(boxes.map(box => box.checked)).toEqual([true, false, true, true]);
  });

  it('自动出图开着时「需确认」置灰，点不动', async () => {
    const { shadow } = install();
    await openPanel();
    const boxes = checkboxes(shadow);
    expect(boxes[1].disabled).toBe(true);

    // 关掉自动出图 → 需确认解锁
    boxes[0].checked = false;
    boxes[0].dispatch('change');
    expect(boxes[1].disabled).toBe(false);
  });

  it('需确认开 → 关自动出图后勾上，读回来是确认式', async () => {
    const { shadow, extensionSettings } = install({ prefs: { autoGenerate: false, showOrb: true } });
    await openPanel();
    const boxes = checkboxes(shadow);
    boxes[1].checked = true;
    boxes[1].dispatch('change');
    expect(extensionSettings[PREFS_KEY]).toMatchObject({ autoGenerate: false, confirmTag: true });
  });

  it('读回存过的值：关掉自动出图时控件是未勾选', async () => {
    const { shadow } = install({ prefs: { autoGenerate: false, showOrb: true } });
    await openPanel();
    expect(checkboxes(shadow)[0].checked).toBe(false);
    expect(checkboxes(shadow)[3].checked).toBe(true);
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

    const box = checkboxes(shadow)[3];
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

/**
 * 候选卡片：确认式唯一的交互面。
 * 它出问题的表现是「点了没反应」或「字改完一刷新就没了」，所以这里锁三件事：
 * 卡片按池子里的条目长出来、编辑态能改到候选上、删掉之后卡片消失。
 */
function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    imageId: 'plan:0',
    planId: 'plan',
    chatId: 'chat-panel',
    floor: 3,
    swipeId: 0,
    segments: [{ segmentId: 's1', text: '她推开门。', before: '', after: '', startLine: 0, endLine: 0 }],
    index: 0,
    versions: [
      {
        image: {
          position: 'P1',
          sourceLine: 0,
          tag: '1girl, doorway, dim light',
          nl: '',
          negative: '',
          characters: [],
          size: 'portrait',
        },
        changes: [],
        createdAt: 1,
      },
    ],
    activeVersion: 0,
    status: 'pending',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function textsIn(shadow: FakeShadow, text: string): FakeElement[] {
  return panelRoot(shadow)?.findAll(el => el.textContent === text) ?? [];
}

function buttonsOf(shadow: FakeShadow): string[] {
  return (panelRoot(shadow)?.findAll(el => el.tagName === 'button') ?? []).map(button => button.textContent);
}

describe('候选卡片', () => {
  it('没有候选时是空态，不摆一张空卡', async () => {
    const { shadow } = install();
    await openPanel();
    expect(textsIn(shadow, '待确认')).toHaveLength(1);
    expect(
      textsIn(shadow, '没有待确认的画面。生成 tag 之后，候选会出现在这里等你确认。'),
    ).toHaveLength(1);
  });

  it('池子里有候选时，卡片长出来：出处、当前提示词、四个动作', async () => {
    const { shadow } = install({ candidates: [candidate()] });
    await openPanel();

    expect(textsIn(shadow, '待确认 1').length).toBeGreaterThan(0);
    expect(textsIn(shadow, '画面 01 · 第 3 楼')).toHaveLength(1);
    expect(textsIn(shadow, '1girl, doorway, dim light')).toHaveLength(1);
    expect(buttonsOf(shadow)).toEqual(
      expect.arrayContaining(['✓ 确认', '⟳ 重 Roll', '✎ 编辑', '✕ 删除']),
    );
  });

  it('点「编辑」出现文本框并带当前提示词，改完保存写回候选', async () => {
    const { shadow, chatMetadata } = install({ candidates: [candidate()] });
    await openPanel();

    const edit = panelRoot(shadow)?.findAll(el => el.textContent === '✎ 编辑')[0];
    edit?.dispatch('click');

    const areas = panelRoot(shadow)?.findAll(el => el.tagName === 'textarea') ?? [];
    expect(areas).toHaveLength(1);
    expect(areas[0].value).toBe('1girl, doorway, dim light');

    areas[0].value = '1girl, edited tag';
    areas[0].dispatch('input');

    const save = panelRoot(shadow)?.findAll(el => el.textContent === '保存')[0];
    save?.dispatch('click');

    const items = (chatMetadata[CANDIDATES_KEY] as { items: Array<{ versions: Array<{ image: { tag: string } }> }> })
      .items;
    expect(items[0].versions[0].image.tag).toBe('1girl, edited tag');
    // 保存的是候选，不是正文：编辑态收起来、文本框消失
    expect(panelRoot(shadow)?.findAll(el => el.tagName === 'textarea')).toHaveLength(0);
  });

  it('点「删除」把候选移出池子，卡片跟着消失', async () => {
    const { shadow, chatMetadata } = install({ candidates: [candidate()] });
    await openPanel();

    const remove = panelRoot(shadow)?.findAll(el => el.textContent === '✕ 删除')[0];
    remove?.dispatch('click');

    expect((chatMetadata[CANDIDATES_KEY] as { items: unknown[] }).items).toHaveLength(0);
    expect(textsIn(shadow, '画面 01 · 第 3 楼')).toHaveLength(0);
    expect(textsIn(shadow, '待确认')).toHaveLength(1);
  });

  it('别的聊天的候选不会显示在面板里', async () => {
    const { shadow } = install({ candidates: [candidate({ chatId: 'another-chat' })] });
    await openPanel();
    expect(textsIn(shadow, '画面 01 · 第 3 楼')).toHaveLength(0);
  });
});

describe('待生成区域', () => {
  /** 没有版本的候选 = 待生成（draft）。 */
  function draftCandidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return candidate({ versions: [], activeVersion: -1, status: 'draft', ...overrides });
  }

  it('draft 卡片长在「待生成」区：出处、原文预览、生成与删除两个动作', async () => {
    const { shadow } = install({ candidates: [draftCandidate()] });
    await openPanel();

    expect(textsIn(shadow, '待生成 1').length).toBeGreaterThan(0);
    expect(textsIn(shadow, '第 3 楼 · 选段 01')).toHaveLength(1);
    expect(textsIn(shadow, '她推开门。')).toHaveLength(1);
    expect(buttonsOf(shadow)).toEqual(expect.arrayContaining(['⚡ 生成 tag', '✕ 删除']));
    // 不该出现在待确认区
    expect(textsIn(shadow, '画面 01 · 第 3 楼')).toHaveLength(0);
  });

  it('有待生成时，一键按钮出现并写清调用次数（1 段同楼 = 1 次）', async () => {
    const { shadow } = install({
      candidates: [draftCandidate(), draftCandidate({ imageId: 'plan2:0', planId: 'plan2' })],
    });
    await openPanel();

    const bulk = panelRoot(shadow)?.findAll(el => el.tagName === 'button' && el.textContent.startsWith('⚡ 一键生成全部'));
    expect(bulk).toHaveLength(1);
    expect(bulk?.[0].textContent).toContain('2 段');
    expect(bulk?.[0].textContent).toContain('1 次调用');
  });

  it('没有待生成时，一键按钮不出现', async () => {
    const { shadow } = install({ candidates: [candidate()] });
    await openPanel();

    const bulk = panelRoot(shadow)?.findAll(el => el.tagName === 'button' && el.textContent.startsWith('⚡ 一键生成全部'));
    // 按钮常驻 DOM，靠 display 隐藏；没有待生成时必须不可见
    expect(bulk).toHaveLength(1);
    expect(bulk?.[0].style.display).toBe('none');
    expect(textsIn(shadow, '待生成').length).toBeGreaterThan(0);
  });

  it('跨楼的待生成会写明多次调用（2 楼各 1 段 = 2 次）', async () => {
    const { shadow } = install({
      candidates: [draftCandidate(), draftCandidate({ imageId: 'p2:0', planId: 'p2', floor: 9 })],
    });
    await openPanel();

    const bulk = panelRoot(shadow)?.findAll(el => el.tagName === 'button' && el.textContent.startsWith('⚡ 一键生成全部'));
    expect(bulk?.[0].textContent).toContain('2 次调用');
  });

  it('候选卡片显示中文对照（tagZh 挂在当前版本上）', async () => {
    const withZh = candidate({
      versions: [
        {
          image: {
            position: 'P1',
            sourceLine: 0,
            tag: '1girl, doorway',
            nl: '',
            negative: '',
            characters: [],
            size: 'portrait',
          },
          changes: [],
          tagZh: '少女，门口',
          createdAt: 1,
        },
      ],
    });
    const { shadow } = install({ candidates: [withZh] });
    await openPanel();

    expect(textsIn(shadow, '少女，门口')).toHaveLength(1);
    expect(textsIn(shadow, '（没有中文对照：模型没给，或你手改过英文。）')).toHaveLength(0);
  });

  it('候选卡片显示角色分项（先看后插必须看得全）', async () => {
    const withChars = candidate({
      versions: [
        {
          image: {
            position: 'P1',
            sourceLine: 0,
            tag: '1boy, 1girl, embrace',
            nl: '',
            negative: '',
            characters: [
              { name: '叶均', tag: 'boy, handsome, silver hair' },
              { name: '陆子慕', tag: 'girl, brown hair' },
            ],
            size: 'portrait',
          },
          changes: [],
          createdAt: 1,
        },
      ],
    });
    const { shadow } = install({ candidates: [withChars] });
    await openPanel();

    expect(textsIn(shadow, '角色: 叶均')).toHaveLength(1);
    expect(textsIn(shadow, 'boy, handsome, silver hair')).toHaveLength(1);
    expect(textsIn(shadow, '角色: 陆子慕')).toHaveLength(1);
    expect(textsIn(shadow, 'girl, brown hair')).toHaveLength(1);
  });

  it('候选卡片给角色分项挂中文对照（charactersZh 与 characters 同下标）', async () => {
    const withChars = candidate({
      versions: [
        {
          image: {
            position: 'P1',
            sourceLine: 0,
            tag: '1boy, 1girl, embrace',
            nl: '',
            negative: '',
            characters: [
              { name: '叶均', tag: 'boy, handsome, silver hair' },
              { name: '陆子慕', tag: 'girl, brown hair' },
            ],
            size: 'portrait',
          },
          changes: [],
          charactersZh: ['男孩，英俊，银发'],
          createdAt: 1,
        },
      ],
    });
    const { shadow } = install({ candidates: [withChars] });
    await openPanel();

    // 第 0 个角色有对照；第 1 个没有（缺项安全降级，不串位）
    expect(textsIn(shadow, '男孩，英俊，银发')).toHaveLength(1);
  });
});
