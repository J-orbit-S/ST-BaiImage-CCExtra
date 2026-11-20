import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  activeComfyPreset,
  activeComfyPromptSet,
  activeNaiPlan,
  activeOrientationLock,
  builtinComfyPromptSet,
  readSettings,
  SETTINGS_KEY,
  settings,
} from '@/state/settings';

/**
 * Adapter 的两条铁律：
 * 1. 读要「实时」——柏宝绘里改了配置，下一次出图立刻看到（不能缓存副本）。
 * 2. 写要「不可能」——任何试图改柏宝绘设置的操作必须抛错，绝不能悄悄生效。
 * 这两条如果破了，用户会在毫不知情的情况下被改掉方案/接入点（含明文 key）。
 */

type AnyRecord = Record<string, unknown>;

function stubBaibai(value: AnyRecord | undefined): { extensionSettings: AnyRecord } {
  const extensionSettings: AnyRecord = {};
  if (value !== undefined) extensionSettings[SETTINGS_KEY] = value;
  const holder: { extensionSettings: AnyRecord } = { extensionSettings };
  vi.stubGlobal('window', {
    SillyTavern: {
      getContext: () => holder,
    },
  });
  return holder;
}

function baseSettings(): AnyRecord {
  return {
    defaultBackend: 'nai',
    excludes: { customStripTags: ['snow'] },
    autoTag: { enabled: true, contextMessages: 3, prompts: { jailbreak: 'JB-A' } },
    nai: {
      activePlanId: 'p2',
      plans: [
        { id: 'p1', name: '方案A', model: 'nai-diffusion-4-5-full', naturalLanguage: false, orientationLock: 'portrait' },
        { id: 'p2', name: '方案B', model: 'nai-diffusion-5-full', naturalLanguage: true, orientationLock: 'landscape' },
      ],
    },
    comfyui: {
      activeWorkflowId: 'w1',
      workflows: [
        { id: 'w1', kind: 'illustration', promptSetId: 'builtin_illust', naturalLanguage: true, orientationLock: 'auto' },
      ],
      promptSets: [],
      servers: [],
    },
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('只读不变量', () => {
  it('顶层赋值必须抛错，且原配置不被改动', () => {
    const holder = stubBaibai(baseSettings());
    expect(() => {
      (settings as unknown as AnyRecord).defaultBackend = 'comfyui';
    }).toThrow(/禁止写入柏宝绘设置/);
    const raw = holder.extensionSettings[SETTINGS_KEY] as AnyRecord;
    expect(raw.defaultBackend).toBe('nai');
  });

  it('delete 也必须抛错', () => {
    stubBaibai(baseSettings());
    expect(() => {
      delete (settings as unknown as AnyRecord).defaultBackend;
    }).toThrow(/禁止写入柏宝绘设置/);
  });
});

describe('实时读取（不缓存）', () => {
  it('柏宝绘改方案后，同一个 settings 立刻反映新值', () => {
    const holder = stubBaibai(baseSettings());
    expect(settings.defaultBackend).toBe('nai');
    expect(activeNaiPlan().id).toBe('p2');

    // 模拟用户在柏宝绘里切到方案A + 换后端
    const raw = holder.extensionSettings[SETTINGS_KEY] as AnyRecord;
    const nai = raw.nai as AnyRecord;
    nai.activePlanId = 'p1';
    raw.defaultBackend = 'comfyui';

    expect(settings.defaultBackend).toBe('comfyui');
    expect(activeNaiPlan().id).toBe('p1');
  });
});

describe('方案解析', () => {
  it('activeNaiPlan 按 activePlanId 取，不取第一项', () => {
    stubBaibai(baseSettings());
    expect(activeNaiPlan().name).toBe('方案B');
    expect(activeNaiPlan().naturalLanguage).toBe(true);
  });

  it('activePlanId 悬空时回落第一项（与上游同口径）', () => {
    const raw = baseSettings();
    (raw.nai as AnyRecord).activePlanId = 'not-exist';
    stubBaibai(raw);
    expect(activeNaiPlan().id).toBe('p1');
  });

  it('没有方案时不崩溃，返回空起步对象（不伪造用户配置）', () => {
    stubBaibai({ defaultBackend: 'nai', nai: { plans: [], activePlanId: '' } });
    const plan = activeNaiPlan();
    expect(plan.id).toBe('');
    expect(plan.model).toBe('');
    expect(plan.orientationLock).toBe('auto');
  });

  it('画幅锁：NAI 取方案级、ComfyUI 取工作流级、其他后端不锁', () => {
    const raw = baseSettings();
    stubBaibai(raw);
    expect(activeOrientationLock()).toBe('landscape');

    (raw.nai as AnyRecord).activePlanId = 'p1';
    expect(activeOrientationLock()).toBe('portrait');

    raw.defaultBackend = 'comfyui';
    expect(activeOrientationLock()).toBe('auto');
  });

  it('提示词集类型与方案不一致时回落同类型内置（上游行为）', () => {
    stubBaibai({
      defaultBackend: 'comfyui',
      comfyui: {
        activeWorkflowId: 'w1',
        workflows: [{ id: 'w1', kind: 'comic', promptSetId: 'ps_mismatch', naturalLanguage: false, orientationLock: 'auto' }],
        promptSets: [{ id: 'ps_mismatch', name: '插画提示词', kind: 'illustration', spec: 'S', thinking: 'T' }],
        servers: [],
      },
    });
    const set = activeComfyPromptSet();
    expect(set.kind).toBe('comic');
    expect(set.id).toBe('builtin_comic');
  });

  it('activeComfyPreset 按 activeWorkflowId 取', () => {
    stubBaibai(baseSettings());
    expect(activeComfyPreset().id).toBe('w1');
  });
});

describe('柏宝绘未安装/未初始化', () => {
  it('完全没有 extensionSettings 时返回空壳，不抛错', () => {
    vi.stubGlobal('window', { SillyTavern: { getContext: () => ({}) } });
    expect(readSettings().defaultBackend).toBe('');
    expect(settings.excludes.customStripTags).toEqual([]);
    expect(activeNaiPlan().id).toBe('');
  });

  it('getContext 不可用时同样返回空壳', () => {
    vi.stubGlobal('window', undefined);
    expect(() => readSettings()).not.toThrow();
    expect(readSettings().nai.plans).toEqual([]);
  });
});

describe('内置提示词回落', () => {
  it('builtinComfyPromptSet 按类型返回对应内置文本，且非空', () => {
    const illust = builtinComfyPromptSet('illustration');
    const comic = builtinComfyPromptSet('comic');
    expect(illust.id).toBe('builtin_illust');
    expect(comic.id).toBe('builtin_comic');
    expect(illust.spec.length).toBeGreaterThan(100);
    expect(illust.spec).not.toBe(comic.spec);
  });
});
