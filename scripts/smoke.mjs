/**
 * 冒烟：用最小宿主壳把构建产物加载起来，确认入口、事件、菜单、悬浮球、面板接线都在。
 * 不是替代真机测试，只是拦住「构建出来是个残废」这类低级错误。
 */

const created = [];
const listeners = [];

function makeEl(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(),
    id: '',
    className: '',
    textContent: '',
    dataset: {},
    style: { setProperty() {} },
    children: [],
    tabIndex: 0,
    checked: false,
    type: '',
    title: '',
    href: '',
    setAttribute() {},
    removeAttribute() {},
    append(...nodes) {
      this.children.push(...nodes.filter(n => typeof n === 'object'));
    },
    appendChild(node) {
      this.children.push(node);
      return node;
    },
    remove() {
      const i = created.indexOf(this);
      if (i >= 0) created.splice(i, 1);
    },
    addEventListener() {},
    removeEventListener() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    },
    contains(node) {
      if (this === node) return true;
      return this.children.some(child => typeof child?.contains === 'function' && child.contains(node));
    },
    after() {},
    scrollIntoView() {},
    attachShadow() {
      const shadow = {
        children: [],
        childElementCount: 1,
        appendChild(node) {
          this.children.push(node);
          return node;
        },
        getElementById(id) {
          return this.children.find(c => c.id === id) ?? null;
        },
        querySelector() {
          return null;
        },
      };
      this.shadowRoot = shadow;
      return shadow;
    },
  };
  created.push(el);
  return el;
}

const extensionsMenu = makeEl('div');
extensionsMenu.id = 'extensionsMenu';

const bbiHost = makeEl('div');
bbiHost.id = 'bbi-app-host';
const bbiShadow = bbiHost.attachShadow({ mode: 'open' });

globalThis.document = {
  readyState: 'complete',
  body: makeEl('body'),
  getElementById: id => {
    if (id === 'extensionsMenu') return extensionsMenu;
    if (id === 'bbi-app-host') return bbiHost;
    return created.find(el => el.id === id) ?? null;
  },
  createElement: tag => makeEl(tag),
  createComment: () => makeEl('#comment'),
  addEventListener: (type, fn) => listeners.push(`${type}`),
  removeEventListener() {},
  querySelector: () => null,
};

globalThis.window = {
  innerWidth: 1280,
  innerHeight: 900,
  addEventListener() {},
  removeEventListener() {},
  SillyTavern: {
    getContext: () => ({
      chat: [],
      chatMetadata: {},
      name1: '我',
      name2: '小雪',
      characters: [],
      extensionSettings: { baibai_image: { ui: { theme: 'night' } } },
      getCurrentChatId: () => 'c1',
      getRequestHeaders: () => ({}),
      saveMetadataDebounced() {},
      saveChat: async () => {},
      saveSettingsDebounced() {},
      eventSource: { on: () => {}, emit: async () => {} },
      eventTypes: {
        CHAT_CHANGED: 'chat_changed',
        MESSAGE_EDITED: 'message_edited',
        MESSAGE_UPDATED: 'message_updated',
      },
    }),
  },
  getSelection: () => null,
  localStorage: {
    store: {},
    getItem(k) {
      return this.store[k] ?? null;
    },
    setItem(k, v) {
      this.store[k] = v;
    },
  },
};

// 让 clock / timers 正常走（菜单注入轮询要一次 tick）
const mod = await import('file:///G:/%E6%8F%92%E4%BB%B6/ST-BaiImage-CCExtra/dist/index.js');
await new Promise(r => setTimeout(r, 120));

const api = globalThis.CCExtra;
const orb = created.find(el => el.id === 'ccx-orb');
const menuItem = extensionsMenu.children.flatMap(c => c.children ?? []).find(c => c.id === 'ccx-menu-item');

console.log('入口加载:', typeof mod === 'object');
console.log('调试出口:', api ? Object.keys(api).sort().join(', ') : '缺失');
console.log('版本:', api?.version);
console.log('偏好:', JSON.stringify(api?.prefs?.()));
console.log('悬浮球:', orb ? `已创建（${orb.textContent}）` : '未创建');
console.log('魔术棒条目:', menuItem ? `已注入（${menuItem.children?.map(c => c.textContent || c.className).join(' / ')}）` : '未注入');

// 面板：柏宝绘的 shadow 里已经有内容（模拟它 mount 过）
bbiShadow.appendChild(makeEl('link'));
await api?.openPanel?.();
await new Promise(r => setTimeout(r, 50));
const root = bbiShadow.getElementById('ccx-panel-root');
const countByClass = (el, name) => {
  let n = el?.className === name ? 1 : 0;
  for (const child of el?.children ?? []) n += countByClass(child, name);
  return n;
};
console.log('面板挂载:', root ? `已挂（data-theme=${root.dataset?.theme ?? '?'}）` : '未挂');
console.log('面板内开关数:', root ? countByClass(root, 'bbi-checkbox') : '-');
console.log('面板内说明段:', root ? countByClass(root, 'bbi-field-hint') : '-');
console.log('isPanelMounted:', api?.isPanelMounted?.());
console.log('isOrbVisible:', api?.isOrbVisible?.());
