import { describe, expect, it } from 'vitest';

import { CCX_THEMES, DEFAULT_THEME, resolveTheme } from '@/ui/theme';

/**
 * 主题解析必须「怎么脏都不炸」：settings.json 可能被手改、被旧版本写过、被别的东西塞过。
 * 它是面板的第一层，抛错就等于面板打不开。
 */
describe('resolveTheme', () => {
  it('认得柏宝绘全部五个主题', () => {
    for (const theme of CCX_THEMES) expect(resolveTheme(theme)).toBe(theme);
  });

  it('不认识的值回落 day', () => {
    for (const dirty of ['', 'dark', 'DAY', 'st ', 0, 1, null, undefined, [], {}, true]) {
      expect(resolveTheme(dirty)).toBe(DEFAULT_THEME);
    }
  });
});
