/**
 * 本插件**自己的**偏好（不是柏宝绘的配置）。
 *
 * 为什么必须有自己的存储：`autoGenerate`（划线写完 tag 后是否替他点卡片）是柏宝绘
 * 根本没有的概念，它只有一个同名的 `autoTag.autoGenerate`（管的是「它自己分析完要不要
 * 自动出图」），语义完全不同，不能共用一个键。
 *
 * 边界（与 settings.ts 的只读 Proxy 分工明确）：
 * - `baibai_image` 下的东西 → **只读**，一个字节都不写（方案、画师串、副 API 全在那边改）；
 * - `extensionSettings['ST-BaiImage-CCExtra']` → 我们自己的小盒子，只放本插件独有的开关。
 *
 * 为什么不用 localStorage：这个开关是「行为偏好」，换设备应该跟着走；柏宝绘的悬浮球位置
 * 之所以放 localStorage，是因为屏幕尺寸不同、同步反而跑到屏幕外——两者动机不同。
 *
 * 容错优先：这些值可能是旧版本写的、被手改坏的、或别的东西塞进来的。任何不认识的东西
 * 一律回落到默认值，绝不让一个坏字段把面板打不开。
 */

import { getContext } from '@/st/context';

/** 存储键。与插件目录同名——ST 的 extensionSettings 惯例，也便于用户自己排查。 */
export const PREFS_KEY = 'ST-BaiImage-CCExtra';

export interface Prefs {
  /** 划线写完 tag 后是否自动点卡片的「生成图片」。关掉 = 手动模式（只写 tag）。 */
  autoGenerate: boolean;
  /**
   * 是否先出候选、等确认再写回（= 确认式）。
   *
   * 与 `autoGenerate` **不是正交的两条轴**，而是有上下级：自动出图开着时这一项被强制为关。
   * 理由不是「会打架」，而是**语义重复** —— 「自动出图」已经是「划线 → 写 tag → 出图」
   * 一条完整闭环，中间再插一步确认没有意义，两个勾同时亮着还会自相矛盾。
   */
  confirmTag: boolean;
  /**
   * 是否让副 API 顺手交一份 Base tag 的中文对照（只给人看，绝不参与出图）。
   *
   * 这是全项目**第二处**与柏宝绘的 messages 偏离（第一处是 source=切片）：
   * 它会在 taskBlock 里多一句输出要求。默认开，关掉即回到「只差 source」的最保守口径，
   * 排错时这是第一条退路。记账见 docs/ENGINEERING.md §1 的例外清单。
   */
  tagZhPreview: boolean;
  /** 是否显示 🍃 悬浮球。 */
  showOrb: boolean;
}

export const DEFAULT_PREFS: Readonly<Prefs> = Object.freeze({
  autoGenerate: true,
  confirmTag: false,
  tagZhPreview: true,
  showOrb: true,
});

type PrefsListener = (prefs: Prefs) => void;

const listeners = new Set<PrefsListener>();

/**
 * 本会话内「改过之后」的真相。
 *
 * 为什么需要它：`getContext()` 在加载顺序、切聊天、宿主异常时都可能返回 null。
 * 若每次都硬读宿主，一次读不到就会把开关**回弹成默认**——用户刚关掉自动出图，
 * 下一张图又被自动点了，这是最难复现也最难解释的 bug。
 *
 * 只在写入后置位，所以没改过的用户仍然是「每次现读」：手改 settings.json 立刻生效。
 */
let memory: Prefs | null = null;

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 把任意输入规整成合法 Prefs。
 * 抽成纯函数是为了能直接单测「存了 null / 数组 / 字符串 / 少字段」这些真实会发生的脏数据。
 */
export function normalizePrefs(raw: unknown): Prefs {
  const source = isPlainObject(raw) ? raw : {};
  // 顺序很重要：先算 autoGenerate，再用它压 confirmTag。反过来会漏掉「自动出图开着、
  // 需确认也开着」这种非法组合（手改 settings.json、旧版本写下的值都可能造出来）。
  const autoGenerate = asBoolean(source.autoGenerate, DEFAULT_PREFS.autoGenerate);
  const confirmTag = autoGenerate ? false : asBoolean(source.confirmTag, DEFAULT_PREFS.confirmTag);
  return {
    autoGenerate,
    confirmTag,
    tagZhPreview: asBoolean(source.tagZhPreview, DEFAULT_PREFS.tagZhPreview),
    showOrb: asBoolean(source.showOrb, DEFAULT_PREFS.showOrb),
  };
}

/** 现读宿主。宿主不可用返回 null（与「宿主里没有这个键」区分开：后者等于默认值）。 */
function readStored(): Prefs | null {
  const settings = getContext()?.extensionSettings;
  if (!settings) return null;
  return normalizePrefs(settings[PREFS_KEY]);
}

/** 读偏好。本会话改过就以内存为准，否则每次现读宿主。 */
export function readPrefs(): Prefs {
  if (memory) return memory;
  return readStored() ?? { ...DEFAULT_PREFS };
}

function broadcast(next: Prefs): void {
  for (const listener of listeners) {
    try {
      listener(next);
    } catch (error) {
      console.error('[CCX] 偏好变更回调异常', error);
    }
  }
}

/**
 * 合并写入并落盘。
 *
 * 三个刻意的细节：
 * 1. **保留未知字段**：写入时以原对象为底再覆盖已知两项。以后（或别的插件好心往这个键里
 *    塞东西）都不会被我们抹掉。
 * 2. **宿主缺失不报错**：getContext 还没就绪时只更新内存并广播，不回写。宁可这一次没记住，
 *    也不能因为写设置把主流程打断。
 * 3. **先置内存再写盘**：写盘可能被 debounce 或失败，但用户按下开关的那一刻就该生效。
 */
export function updatePrefs(patch: Partial<Prefs>): Prefs {
  const context = getContext();
  const settings = context?.extensionSettings;
  const stored = settings?.[PREFS_KEY];
  const base = isPlainObject(stored) ? { ...stored } : {};
  const next = normalizePrefs({ ...base, ...patch });

  // 本会话的真相立刻更新，之后即使宿主读不到也不会回弹
  memory = next;

  if (settings) {
    settings[PREFS_KEY] = { ...base, ...next };
    try {
      context?.saveSettingsDebounced?.();
    } catch {
      /* 保存失败只影响「下次还记不记得」，不该让开关本身看起来没按下 */
    }
  }

  broadcast(next);
  return next;
}

/** 订阅偏好变更。返回取消订阅函数。 */
export function onPrefsChange(listener: PrefsListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 恢复默认（调试口用，也方便以后加「恢复默认」按钮）。 */
export function resetPrefs(): Prefs {
  const context = getContext();
  const settings = context?.extensionSettings;
  const next = { ...DEFAULT_PREFS };
  memory = next;

  if (settings) {
    settings[PREFS_KEY] = { ...DEFAULT_PREFS };
    try {
      context?.saveSettingsDebounced?.();
    } catch {
      /* 同上 */
    }
  }

  broadcast(next);
  return next;
}

/** 仅供测试：清掉内存镜像，模拟「刷新页面后重新从宿主读」。 */
export function forgetPrefsCache(): void {
  memory = null;
}
