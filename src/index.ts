/**
 * ST-BaiImage-CCExtra 插件入口。
 *
 * 职责只有四件事，全部围绕「别碰柏宝绘」：
 *   1. 把柏宝绘的角色库读进来（全局库 + 本聊天楼层增量）—— 这一步是**只读**的重放，
 *      和柏宝绘自己启动时做的事同构，因此我们算出的「本楼之前有哪些角色已建档」与它一致；
 *   2. 绑上划线触发（正文里选一段 → 浮出「划线出图」）；
 *   3. 切聊天时清掉在途请求（否则上一聊的 tag 可能写到新聊的同号楼层里）；
 *   4. 在 globalThis 上挂一个调试入口。
 *
 * 刻意**没有**的东西（都是红线，见 VENDORED.md）：
 *   - 没有设置面板：提示词、方案、接入点、副 API 全在柏宝绘里改，本插件每次请求现读；
 *   - 没有自己的配置存储：一个 key 都不写；
 *   - 没有自动触发的钩子：只有用户划线并点按钮才会发请求。
 */

import { bindCharTagSync } from '@/state/charTags';
import { initGlobalCharTags } from '@/state/globalCharTags';
import { captureSelection } from '@/selection/capture';
import { cancelAllSelectionRuns, runSelection } from '@/runner/runSelection';
import { diagnostic } from '@/runner/diagnostic';
import { bindSelectionTrigger } from '@/ui/trigger';
import { isAutoGenerateEnabled, setAutoGenerate } from '@/ui/autoGenerate';
import { getContext } from '@/st/context';

const VERSION = typeof __CCX_VERSION__ === 'string' ? __CCX_VERSION__ : 'dev';

let started = false;

function start(): void {
  if (started) return;
  started = true;

  // 顺序与柏宝绘 index.ts 一致：全局库先注入条目来源，再让它重算首次快照。
  // 反过来的话，第一次 recompute 会看不到全局库，锁定名（[locked]）就丢了。
  initGlobalCharTags();
  bindCharTagSync();

  bindSelectionTrigger();

  const context = getContext();
  const chatChanged = context?.eventTypes?.CHAT_CHANGED;
  if (context?.eventSource && chatChanged) {
    context.eventSource.on(chatChanged, () => {
      diagnostic('CHAT_CHANGED', { currentChatId: getContext()?.getCurrentChatId?.() ?? '' });
      cancelAllSelectionRuns();
    });
  }

  // 调试入口：控制台里 `CCExtra.capture()` 看当前选区解析结果，
  // `CCExtra.version` 确认加载的是哪一版。第三方脚本也可以照此调用。
  (globalThis as unknown as { CCExtra?: unknown }).CCExtra = Object.freeze({
    version: VERSION,
    capture: captureSelection,
    run: runSelection,
    cancelAll: cancelAllSelectionRuns,
    // 自动出图的运行时开关（不落盘、不写柏宝绘设置）：`CCExtra.setAutoGenerate(false)` 后
    // 只写 tag 不点卡片，刷新页面即恢复默认开启。
    setAutoGenerate,
    isAutoGenerateEnabled,
  });

  console.log(`[CCX] ST-BaiImage-CCExtra ${VERSION} 已加载：选中正文 → 点「划线出图」`);
}

/**
 * 加载时机：ST 用动态 import 载入扩展脚本，此刻 document 通常已 interactive，
 * 但 `SillyTavern.getContext()` 未必就绪。事件是委托在 document 上的，不需要等聊天渲染，
 * 所以这里只等 getContext 可用（最多重试 20 次，约 2 秒）。
 */
let bootRetries = 0;

function boot(): void {
  const context = getContext();
  if (!context) {
    bootRetries += 1;
    if (bootRetries > 20) {
      console.error('[CCX] SillyTavern 上下文始终不可用，划线出图未启动');
      return;
    }
    setTimeout(boot, 100);
    return;
  }
  start();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
