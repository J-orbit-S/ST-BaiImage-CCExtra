/**
 * 魔术棒（魔杖）菜单入口。
 *
 * 结构照柏宝绘的 `menu.ts`：往 `#extensionsMenu` 里追加一个
 * `.extension_container > a.list-group-item`，图标用 Font Awesome（ST 菜单是图标字体环境，
 * emoji 在这里尺寸/基线会跟邻居不齐，所以菜单用 `fa-leaf`、悬浮球才用 🍃）。
 *
 * 与柏宝绘那份的唯一差别：不用 jQuery 建节点（原生 DOM 更少依赖），只在收起菜单时
 * 优先走 `$().hide()` —— 那是 ST 自己开合菜单用的通道，行为最一致。
 */

import { diagnostic } from '@/runner/diagnostic';
import { openPanel } from '@/ui/panel';

const ITEM_ID = 'ccx-menu-item';
const ITEM_TEXT = '划线出图';
const POLL_MS = 500;
const MAX_ATTEMPTS = 40;

type JQueryLike = (target: unknown) => { hide?: () => void };

function collapseMenu(menu: HTMLElement): void {
  const $ = (globalThis as { $?: unknown }).$;
  if (typeof $ === 'function') {
    try {
      const wrapped = ($ as JQueryLike)(menu);
      if (typeof wrapped.hide === 'function') {
        wrapped.hide();
        return;
      }
    } catch {
      /* 落到下面的原生做法 */
    }
  }
  menu.style.display = 'none';
}

function buildItem(): HTMLElement {
  const container = document.createElement('div');
  container.className = 'extension_container interactable';
  container.tabIndex = 0;

  const anchor = document.createElement('a');
  anchor.id = ITEM_ID;
  anchor.className = 'list-group-item';
  anchor.href = '#';
  anchor.title = ITEM_TEXT;

  const icon = document.createElement('i');
  icon.className = 'fa-solid fa-leaf';

  const text = document.createElement('span');
  text.textContent = ITEM_TEXT;

  anchor.append(icon, text);
  container.append(anchor);

  container.addEventListener('click', event => {
    event.preventDefault();
    diagnostic('menu:click', {});
    collapseMenu(container.closest<HTMLElement>('#extensionsMenu') ?? document.getElementById('extensionsMenu') ?? container);
    void openPanel();
  });

  return container;
}

/** 立刻尝试注入；成功或已存在返回 true。 */
function tryInject(): boolean {
  if (typeof document === 'undefined') return false;
  const menu = document.getElementById('extensionsMenu');
  if (!menu) return false;
  if (document.getElementById(ITEM_ID)) return true;
  menu.appendChild(buildItem());
  diagnostic('menu:injected', { itemId: ITEM_ID });
  return true;
}

/**
 * 绑定菜单入口。菜单可能是懒渲染的，所以先试一次、再轮询（封顶 ~20 秒，不常驻空转）。
 * 重复调用安全：已注入就直接返回。
 */
export function bindMenuEntry(): () => void {
  if (tryInject()) return () => {};

  let attempts = 0;
  const timer = setInterval(() => {
    if (tryInject() || ++attempts > MAX_ATTEMPTS) clearInterval(timer);
  }, POLL_MS);

  return () => {
    clearInterval(timer);
    document.getElementById(ITEM_ID)?.closest('.extension_container')?.remove();
  };
}
