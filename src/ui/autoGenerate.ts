/**
 * 写回之后「替他点一下生成」。
 *
 * 为什么只能点卡片，不能自己调公开接口：
 * 柏宝绘的公开 `generate()` 走的是 `saveExternalImage`——落盘位置与卡片完全一样
 * （`柏宝绘_<角色名>/bbi_<hash>_<swipeId>_<promptHash>-<genId>`），但它**只把文件放进目录**，
 * 不写 `extra.bbiImage`、不登记历史、不进 genState，而且 `GenerateResult` 不带 `meta`
 * （画师串/vibe/采样参数）。自己拿 dataUrl 补 extra 的结果是：图在盘上、卡片认不出来、
 * 图库详情缺参数、历史面板少一条。看起来像，实际哪一处都不一致。
 *
 * 卡片上那个「生成图片」按钮走的是 `Card.vue` 的 `generate()`：`decideSeed` → `beginImage`
 * → `generateImage`（含渠道锁、并发闸门）→ `saveImageResult`（落盘 + 写 extra + 侧写）→
 * `hydrateMessage`。全程与用户手点没有任何区别，所以这是**唯一**零漂移的路。
 *
 * 代价写在明处：这是 DOM 契约。柏宝绘改类名/改结构，这里就会失效。
 * 失效的表现是「tag 写入成功、图没出来」，所以每次都留了诊断与一句人话提示，
 * 用户不会以为插件坏了——他点一下卡片就行。
 */

import { diagnostic } from '@/runner/diagnostic';
import { readPrefs, updatePrefs } from '@/state/prefs';
import { notify } from '@/ui/notify';

/**
 * 卡片生成按钮的选择器。**全项目只有这一处**——柏宝绘改版时改这里。
 * 按钮渲在锚点的 shadow root 里（柏宝绘用 `attachShadow({mode:'open'})`，可穿透）。
 */
const GENERATE_BUTTON = '.bbi-figure__generate';

/** 卡片锚点：柏宝绘水合时插在 .mes_text 里，顺序与 tag 顺序一一对应。 */
const SLOT_ANCHOR = 'div[data-bbi-slot]';

/** 「按当前方案重新生成本楼」也穿这个类名，但它会重跑整楼分析——绝不能点。 */
const FLOOR_REGEN_HINT = '本楼';

/** 等卡片渲染的上限。ST 重渲染 + 柏宝绘延迟水合，正常 200ms 内就位。 */
const WAIT_TIMEOUT_MS = 5000;
const POLL_MS = 50;

/**
 * 开关的**唯一真相**是 prefs（面板上那个开关）。这里不留内存副本——
 * 以前是一个模块内 `let enabled`，面板改了 prefs 之后两边会各说各话，
 * 出现「面板显示手动、卡片还是被点了」这种最难查的错。
 */
export function setAutoGenerate(next: boolean): void {
  updatePrefs({ autoGenerate: Boolean(next) });
}
export function isAutoGenerateEnabled(): boolean {
  return readPrefs().autoGenerate;
}

export interface AutoGenerateTarget {
  floor: number;
  /** 需要出图的槽位序号，由 `resolveInjectedSeqs` 算出。 */
  seqs: number[];
  /** 写回后本楼 tag 总数：锚点数量要长到这个数才认为卡片已渲染完。 */
  totalTags: number;
}

export interface AutoGenerateOutcome {
  clicked: number;
  /** 没点成的原因（诊断与提示用）。 */
  reason?: 'disabled' | 'no-seqs' | 'no-message' | 'not-rendered' | 'no-button' | 'floor-regen-only';
}

/**
 * 从卡片的 shadow root 里挑出真正的「生成图片」按钮。
 *
 * 抽成纯函数是为了能单测：DOM 里有两个长得一样的按钮，点错那个会重跑整楼分析，
 * 这种错误不能在真机上才发现。
 */
export function pickGenerateButton(root: Pick<ShadowRoot, 'querySelector'> | null): HTMLButtonElement | null {
  const button = root?.querySelector<HTMLButtonElement>(GENERATE_BUTTON) ?? null;
  if (!button) return null;
  // 「按当前方案重新生成本楼」：tag 类型与方案对不上时的出口，点了会删掉本楼全部 tag 重写
  if ((button.textContent ?? '').includes(FLOOR_REGEN_HINT)) return null;
  return button;
}

function findMesElement(floor: number): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  return document.querySelector<HTMLElement>(`#chat .mes[mesid="${floor}"]`);
}

function slotsOf(message: HTMLElement): HTMLElement[] {
  return Array.from(message.querySelectorAll<HTMLElement>(SLOT_ANCHOR));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 等楼层卡片渲染到「锚点够数、且目标槽位已经有按钮（或确实不该有）」。
 * 用轮询而不是 MutationObserver：卡片会随出图反复重水合，观察器要不停地重挂，
 * 而轮询的最坏代价只是 50ms 的延迟。
 */
async function waitForSlots(
  floor: number,
  totalTags: number,
  seqs: number[],
): Promise<{ message: HTMLElement; anchors: HTMLElement[] } | null> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let scrolled = false;
  while (Date.now() < deadline) {
    const message = findMesElement(floor);
    if (message) {
      const anchors = slotsOf(message);
      if (anchors.length >= totalTags) {
        // 目标槽位的 shadow 都建好了才算就位；建好但没有按钮（如已有图）也算就位
        const ready = seqs.every(seq => {
          const anchor = anchors[seq];
          return anchor && (anchor.shadowRoot?.querySelector(GENERATE_BUTTON) || anchor.shadowRoot);
        });
        if (ready) return { message, anchors };
      }
      // 楼层在 DOM 里但卡片迟迟不挂：可能是懒渲染/离屏，滚过去再等
      if (!scrolled && !anchors.length) {
        scrolled = true;
        message.scrollIntoView?.({ block: 'center' });
      }
    }
    await sleep(POLL_MS);
  }
  return null;
}

/**
 * 逐个点开目标槽位的生成。任一槽位点不动都不影响其它槽位，
 * 也不回滚正文——tag 已经写对了，用户手动点一下即可。
 */
export async function autoGenerateSlots(target: AutoGenerateTarget): Promise<AutoGenerateOutcome> {
  if (!isAutoGenerateEnabled()) return { clicked: 0, reason: 'disabled' };
  if (!target.seqs.length) return { clicked: 0, reason: 'no-seqs' };
  if (typeof document === 'undefined') return { clicked: 0, reason: 'no-message' };

  const waited = await waitForSlots(target.floor, target.totalTags, target.seqs);
  if (!waited) {
    diagnostic('autoGenerate:skip', { floor: target.floor, reason: 'not-rendered', seqs: target.seqs });
    notify('info', '生图 tag 已写入，但卡片还没画出来——稍等一下点卡片上的「生成图片」即可');
    return { clicked: 0, reason: 'not-rendered' };
  }

  let clicked = 0;
  let reason: AutoGenerateOutcome['reason'];
  for (const seq of target.seqs) {
    const anchor = waited.anchors[seq];
    const shadow = anchor?.shadowRoot ?? null;
    if (!shadow) {
      reason = 'not-rendered';
      continue;
    }
    if (shadow.querySelector(GENERATE_BUTTON) && !pickGenerateButton(shadow)) {
      // 只找到「重新生成本楼」那个按钮：tag 类型与当前方案对不上，交给用户决定
      reason = 'floor-regen-only';
      continue;
    }
    const button = pickGenerateButton(shadow);
    if (!button) {
      reason = 'no-button';
      continue;
    }
    button.click();
    clicked += 1;
  }

  diagnostic('autoGenerate:clicked', {
    floor: target.floor,
    seqs: target.seqs,
    clicked,
    reason: reason ?? 'ok',
  });

  if (clicked < target.seqs.length) {
    if (reason === 'floor-regen-only') {
      // 这是「本楼 tag 与当前方案不匹配」，用户需要在卡片上自己选重新生成
      notify('warning', '生图 tag 已写入，但它与当前出图方案不匹配——请在卡片上按提示重新生成本楼');
    } else {
      notify('info', '生图 tag 已写入，请点卡片上的「生成图片」开始出图');
    }
  }

  return { clicked, reason };
}
