import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_PREFS,
  forgetPrefsCache,
  normalizePrefs,
  onPrefsChange,
  PREFS_KEY,
  readPrefs,
  resetPrefs,
  updatePrefs,
} from '@/state/prefs';
import { SETTINGS_KEY } from '@/state/settings';

/**
 * 这个文件守三件事：
 * 1. 脏数据不会把面板打不开（null / 数组 / 字符串 / 少字段都回落到默认）；
 * 2. 写只落在我们自己的键上，**永远不碰 baibai_image**（这是项目红线）；
 * 3. 宿主没就绪时，读写都不能抛错——加载顺序不确定，抛错就等于插件崩了。
 */

type AnyRecord = Record<string, unknown>;

interface Harness {
  extensionSettings: AnyRecord;
  saved: number;
}

function install(seed?: AnyRecord): Harness {
  const extensionSettings: AnyRecord = {};
  if (seed) Object.assign(extensionSettings, seed);
  const harness: Harness = { extensionSettings, saved: 0 };
  vi.stubGlobal('window', {
    SillyTavern: {
      getContext: () => ({
        extensionSettings: harness.extensionSettings,
        saveSettingsDebounced: () => {
          harness.saved += 1;
        },
      }),
    },
  });
  return harness;
}

// 模块级内存镜像会跨用例残留，每条用例都当作「刚刷新页面」
beforeEach(() => {
  forgetPrefsCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  forgetPrefsCache();
});

describe('normalizePrefs', () => {
  it('没有输入时给出默认值（自动出图开、悬浮球开）', () => {
    expect(normalizePrefs(undefined)).toEqual({ autoGenerate: true, showOrb: true });
    expect(normalizePrefs(null)).toEqual(DEFAULT_PREFS);
  });

  it('不是对象的脏数据一律回落默认，而不是抛错', () => {
    for (const dirty of ['yes', 42, [], [true, false], true]) {
      expect(normalizePrefs(dirty)).toEqual(DEFAULT_PREFS);
    }
  });

  it('只写了其中一个字段时，另一个用默认值补上', () => {
    expect(normalizePrefs({ autoGenerate: false })).toEqual({ autoGenerate: false, showOrb: true });
    expect(normalizePrefs({ showOrb: false })).toEqual({ autoGenerate: true, showOrb: false });
  });

  it('字段类型不对（字符串 "false"、数字 0、null）不认，回落默认', () => {
    expect(normalizePrefs({ autoGenerate: 'false', showOrb: 0 })).toEqual(DEFAULT_PREFS);
    expect(normalizePrefs({ autoGenerate: null, showOrb: {} })).toEqual(DEFAULT_PREFS);
  });
});

describe('readPrefs', () => {
  it('没存过时返回默认', () => {
    install();
    expect(readPrefs()).toEqual(DEFAULT_PREFS);
  });

  it('读得出存过的值', () => {
    install({ [PREFS_KEY]: { autoGenerate: false, showOrb: false } });
    expect(readPrefs()).toEqual({ autoGenerate: false, showOrb: false });
  });

  it('宿主完全没就绪时不抛错，返回默认', () => {
    vi.stubGlobal('window', {});
    expect(readPrefs()).toEqual(DEFAULT_PREFS);
  });
});

describe('updatePrefs', () => {
  it('写入自己的键并触发保存', () => {
    const harness = install();
    const next = updatePrefs({ autoGenerate: false });
    expect(next).toEqual({ autoGenerate: false, showOrb: true });
    expect(harness.extensionSettings[PREFS_KEY]).toEqual({ autoGenerate: false, showOrb: true });
    expect(harness.saved).toBe(1);
  });

  it('只改一项时另一项保持原值（不是回落到默认）', () => {
    const harness = install({ [PREFS_KEY]: { autoGenerate: false, showOrb: false } });
    updatePrefs({ showOrb: true });
    expect(harness.extensionSettings[PREFS_KEY]).toEqual({ autoGenerate: false, showOrb: true });
  });

  it('保留键里的未知字段（以后加字段/别的插件写进来的东西不会被抹掉）', () => {
    const harness = install({ [PREFS_KEY]: { autoGenerate: true, future: 'keep-me' } });
    updatePrefs({ showOrb: false });
    expect(harness.extensionSettings[PREFS_KEY]).toMatchObject({ future: 'keep-me', showOrb: false });
  });

  it('绝不碰柏宝绘的设置键（红线）', () => {
    const baibai = { autoTag: { autoGenerate: true } };
    const harness = install({ [SETTINGS_KEY]: baibai });
    updatePrefs({ autoGenerate: false });
    expect(harness.extensionSettings[SETTINGS_KEY]).toBe(baibai);
    expect(baibai).toEqual({ autoTag: { autoGenerate: true } });
  });

  it('宿主缺失时不抛错，只是这次没记住', () => {
    vi.stubGlobal('window', {});
    expect(() => updatePrefs({ autoGenerate: false })).not.toThrow();
    expect(updatePrefs({ autoGenerate: false })).toEqual({ autoGenerate: false, showOrb: true });
  });

  it('改过之后即使宿主读不到，也不会回弹成默认（否则用户关了自动出图还会被自动点）', () => {
    const harness = install();
    updatePrefs({ autoGenerate: false });
    expect(harness.extensionSettings[PREFS_KEY]).toMatchObject({ autoGenerate: false });

    // 模拟切聊天/瞬时不可用：getContext 这一刻拿不到东西
    vi.stubGlobal('window', {});
    expect(readPrefs()).toEqual({ autoGenerate: false, showOrb: true });
  });

  it('刷新页面（内存清空）后从宿主重新读回上次的选择', () => {
    const harness = install({ [PREFS_KEY]: { autoGenerate: false, showOrb: false } });
    expect(readPrefs()).toEqual({ autoGenerate: false, showOrb: false });

    // 没改过时是真·每次现读：手改 settings.json 立刻生效
    harness.extensionSettings[PREFS_KEY] = { autoGenerate: true, showOrb: false };
    expect(readPrefs()).toEqual({ autoGenerate: true, showOrb: false });
  });
});

describe('onPrefsChange / resetPrefs', () => {
  it('写入后广播新值，取消订阅后不再收到', () => {
    install();
    const seen: Array<{ autoGenerate: boolean; showOrb: boolean }> = [];
    const off = onPrefsChange(prefs => seen.push({ ...prefs }));

    updatePrefs({ autoGenerate: false });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ autoGenerate: false, showOrb: true });

    off();
    updatePrefs({ autoGenerate: true });
    expect(seen).toHaveLength(1);
  });

  it('某个回调抛错不影响其它回调', () => {
    install();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: boolean[] = [];
    onPrefsChange(() => {
      throw new Error('boom');
    });
    const off = onPrefsChange(() => seen.push(true));

    expect(() => updatePrefs({ showOrb: false })).not.toThrow();
    expect(seen).toHaveLength(1);
    off();
    errors.mockRestore();
  });

  it('resetPrefs 恢复默认并落盘', () => {
    const harness = install({ [PREFS_KEY]: { autoGenerate: false, showOrb: false } });
    expect(resetPrefs()).toEqual(DEFAULT_PREFS);
    expect(harness.extensionSettings[PREFS_KEY]).toEqual(DEFAULT_PREFS);
    expect(harness.saved).toBe(1);
  });
});
