/**
 * 面板主题 = **跟随柏宝绘**，不自建一套。
 *
 * 用户在柏宝绘里切到夜间，我们的面板同时变夜间——这比给我们加一个主题开关更符合
 * 「配置全在柏宝绘里改」的规矩，也少一个要维护的界面。
 *
 * 值域与柏宝绘 `state/ui.ts` 的 `validTheme` 同口径（day / night / pastel / green / st），
 * 非法值一律回落 `day`。刻意不 import 它的模块：那边是 Vue 单例，拿不到也不该拿。
 */

import { getContext } from '@/st/context';
import { SETTINGS_KEY } from '@/state/settings';

export const CCX_THEMES = ['day', 'night', 'pastel', 'green', 'st'] as const;
export type CcxTheme = (typeof CCX_THEMES)[number];

export const DEFAULT_THEME: CcxTheme = 'day';

/** 把任意输入收敛成合法主题名。抽成纯函数便于单测脏数据。 */
export function resolveTheme(raw: unknown): CcxTheme {
  return typeof raw === 'string' && (CCX_THEMES as readonly string[]).includes(raw)
    ? (raw as CcxTheme)
    : DEFAULT_THEME;
}

/**
 * 现读柏宝绘当前主题。
 * 每次打开面板都调一次（不缓存）——用户在柏宝绘里刚切完主题，下次打开就该是新颜色。
 */
export function readBaibaiTheme(): CcxTheme {
  const raw = getContext()?.extensionSettings?.[SETTINGS_KEY] as { ui?: { theme?: unknown } } | undefined;
  return resolveTheme(raw?.ui?.theme);
}
