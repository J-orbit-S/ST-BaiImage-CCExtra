/**
 * Adapter：柏宝绘设置的**只读**视图。
 *
 * 为什么不是「逐字搬运 settings.ts」：上游那份是 `reactive<ImageSettings>` 的内存单例，
 * 会在任何 UI 改动后把整份设置**回写** extensionSettings。如果 CCExtra 直接搬过来，
 * 就相当于在我们这边也持有一份能写柏宝绘配置的对象——一旦写错，用户辛苦配的方案、
 * 接入点（含明文 key）会被我们覆盖掉。这是不可接受的。
 *
 * 所以这里只做「读」：
 * - `settings` 是一个 Proxy，每次属性访问都**当场**从 extensionSettings['baibai_image'] 读，
 *   不缓存副本 → 用户在柏宝绘里改了什么，我们下一次出图立刻看到（这是硬需求）。
 * - 任何写操作（set / deleteProperty / defineProperty）直接抛错 → 从机制上保证零写入。
 *
 * 内置提示词常量是逐字抽取到 settingsDefaults.ts 的，这里原样再导出，
 * 使得 vendored 的 prompt.ts 里 `from '@/state/settings'` 一个字都不用改。
 */
import type { OrientationLock, SizePair } from '@/backends/size';
import { getContext } from '@/st/context';
import {
  DEFAULT_COMFY_COMIC_SPEC,
  DEFAULT_COMFY_COMIC_THINKING,
  DEFAULT_COMFY_NL_SPEC,
  DEFAULT_COMFY_SPEC,
  DEFAULT_COMFY_THINKING,
  DEFAULT_JAILBREAK_PROMPT,
  DEFAULT_NAI_SPEC,
  DEFAULT_NAI_THINKING,
  DEFAULT_NAI_V5_SPEC,
  DEFAULT_NAI_V5_THINKING,
} from '@/state/settingsDefaults';

export {
  DEFAULT_COMFY_COMIC_SPEC,
  DEFAULT_COMFY_COMIC_THINKING,
  DEFAULT_COMFY_NL_SPEC,
  DEFAULT_COMFY_SPEC,
  DEFAULT_COMFY_THINKING,
  DEFAULT_JAILBREAK_PROMPT,
  DEFAULT_NAI_SPEC,
  DEFAULT_NAI_THINKING,
  DEFAULT_NAI_V5_SPEC,
  DEFAULT_NAI_V5_THINKING,
};

/** 柏宝绘设置的存储键（与上游一致，跨插件共享同一份）。 */
export const SETTINGS_KEY = 'baibai_image';

export type ComfyKind = 'illustration' | 'comic';
export type BackendId = 'nai' | 'comfyui' | string;

/** 可编辑提示词集；空串 = 回落内置默认（上游语义，见 prompt.ts 的 `||` 回落）。 */
export interface AutoTagPrompts {
  jailbreak: string;
  naiSpec: string;
  naiV5Spec: string;
  comfySpec: string;
  comfyThinking: string;
  naiThinking: string;
  naiV5Thinking: string;
}

export interface AutoTagSettings {
  enabled: boolean;
  contextMessages: number;
  minImages: number;
  maxImages: number;
  retryCount: number;
  autoGenerate: boolean;
  prompts: AutoTagPrompts;
}

export interface ExcludesSettings {
  excludedChars: string[];
  excludedWorldNames: string[];
  excludedWorldInfoPatterns: string[];
  /** 自定义清洗标签（只填标签名）。与柏宝书共用名单。 */
  customStripTags: string[];
}

/** 提示词集：用户库与内置库同形。 */
export interface ComfyPromptSet {
  id: string;
  name: string;
  kind: ComfyKind;
  spec: string;
  thinking: string;
}

/** 只声明本插件真正读到的字段；其余字段读不到也不影响判定。 */
export interface ComfyWorkflowPreset extends SizePair {
  id: string;
  name: string;
  kind: ComfyKind;
  /** 引用的提示词集 id（用户库或内置 builtin_*）。 */
  promptSetId: string;
  naturalLanguage: boolean;
  orientationLock: OrientationLock;
}

export interface NaiPlan extends SizePair {
  id: string;
  name: string;
  endpointId: string;
  model: string;
  artistId: string;
  naturalLanguage: boolean;
  orientationLock: OrientationLock;
}

export interface ComfyServer {
  id: string;
  name: string;
  url: string;
}

/** 只声明我们读的部分；上游还有大量字段，这里不求全，只求字段名准确。 */
export interface ImageSettings {
  defaultBackend: BackendId;
  excludes: ExcludesSettings;
  autoTag: AutoTagSettings;
  nai: {
    plans: NaiPlan[];
    activePlanId: string;
  };
  comfyui: {
    workflows: ComfyWorkflowPreset[];
    activeWorkflowId: string;
    promptSets: ComfyPromptSet[];
    servers: ComfyServer[];
  };
  [k: string]: unknown;
}

const EMPTY_EXCLUDES: ExcludesSettings = {
  excludedChars: [],
  excludedWorldNames: [],
  excludedWorldInfoPatterns: [],
  customStripTags: [],
};

const EMPTY_PROMPTS: AutoTagPrompts = {
  jailbreak: '',
  naiSpec: '',
  naiV5Spec: '',
  comfySpec: '',
  comfyThinking: '',
  naiThinking: '',
  naiV5Thinking: '',
};

/** 柏宝绘未安装/未初始化时的兜底形态：字段齐全，但全为空，绝不编造用户配置。 */
function emptySettings(): ImageSettings {
  return {
    defaultBackend: '',
    excludes: EMPTY_EXCLUDES,
    autoTag: {
      enabled: false,
      contextMessages: 0,
      minImages: 0,
      maxImages: 0,
      retryCount: 0,
      autoGenerate: false,
      prompts: EMPTY_PROMPTS,
    },
    nai: { plans: [], activePlanId: '' },
    comfyui: { workflows: [], activeWorkflowId: '', promptSets: [], servers: [] },
  };
}

/**
 * 当场读柏宝绘的当前设置。返回的是**上游对象本身**（不克隆），
 * 因此：调用方只许读，不许改里面的任何东西。
 */
export function readSettings(): ImageSettings {
  const raw = getContext()?.extensionSettings?.[SETTINGS_KEY] as Partial<ImageSettings> | undefined;
  if (!raw || typeof raw !== 'object') return emptySettings();
  // 不做深合并：缺哪块就补哪块的空壳，其余原样透传，避免用我们的默认值覆盖用户真实配置。
  return {
    ...raw,
    excludes: { ...EMPTY_EXCLUDES, ...(raw.excludes ?? {}) },
    autoTag: { ...emptySettings().autoTag, ...(raw.autoTag ?? {}) },
    nai: { plans: [], activePlanId: '', ...(raw.nai ?? {}) },
    comfyui: { workflows: [], activeWorkflowId: '', promptSets: [], servers: [], ...(raw.comfyui ?? {}) },
  } as ImageSettings;
}

function writeForbidden(prop: string | symbol): never {
  throw new Error(
    `[CCExtra] 禁止写入柏宝绘设置（试图写 settings.${String(prop)}）。` +
      `所有配置只允许在柏宝绘里改，本插件只读。`,
  );
}

/**
 * 只读视图。注意：它返回的是上游对象引用，**嵌套对象仍可被改**，
 * 所以代码纪律是「只读」。需要写配置的场景一律去柏宝绘 UI 操作，不要在这里动。
 */
export const settings = new Proxy({} as ImageSettings, {
  get(_target, prop) {
    return readSettings()[prop as keyof ImageSettings];
  },
  has(_target, prop) {
    return prop in readSettings();
  },
  ownKeys() {
    return Reflect.ownKeys(readSettings());
  },
  getOwnPropertyDescriptor(_target, prop) {
    return { configurable: true, enumerable: true, value: readSettings()[prop as keyof ImageSettings] };
  },
  set(_target, prop) {
    return writeForbidden(prop);
  },
  deleteProperty(_target, prop) {
    return writeForbidden(prop);
  },
  defineProperty(_target, prop) {
    return writeForbidden(prop);
  },
});

export const BUILTIN_COMFY_ILLUST_ID = 'builtin_illust';
export const BUILTIN_COMFY_COMIC_ID = 'builtin_comic';

/** 内置提示词：不入库、只读，按 id 解析（与上游 BUILTIN_COMFY_PROMPT_SETS 同口径）。 */
export const BUILTIN_COMFY_PROMPT_SETS: readonly ComfyPromptSet[] = [
  {
    id: BUILTIN_COMFY_ILLUST_ID,
    name: '插画(内置)',
    kind: 'illustration',
    spec: DEFAULT_COMFY_SPEC,
    thinking: DEFAULT_COMFY_THINKING,
  },
  {
    id: BUILTIN_COMFY_COMIC_ID,
    name: '漫画(内置)',
    kind: 'comic',
    spec: DEFAULT_COMFY_COMIC_SPEC,
    thinking: DEFAULT_COMFY_COMIC_THINKING,
  },
];

export function isBuiltinComfyPromptSet(id: string): boolean {
  return BUILTIN_COMFY_PROMPT_SETS.some(p => p.id === id);
}

/** 某类型的内置提示词（两类各恰好一套）。 */
export function builtinComfyPromptSet(kind: ComfyKind): ComfyPromptSet {
  return BUILTIN_COMFY_PROMPT_SETS.find(p => p.kind === kind) ?? BUILTIN_COMFY_PROMPT_SETS[0];
}

/** 无方案时的兜底（与上游 newNaiPlan/newComfyWorkflow 的“空起步”语义一致，不伪造用户值）。 */
function emptyNaiPlan(): NaiPlan {
  return {
    id: '',
    name: '',
    endpointId: '',
    model: '',
    artistId: '',
    naturalLanguage: false,
    orientationLock: 'auto',
    portraitSize: '',
    landscapeSize: '',
  };
}

function emptyComfyWorkflow(): ComfyWorkflowPreset {
  return {
    id: '',
    name: '',
    kind: 'illustration',
    promptSetId: '',
    naturalLanguage: false,
    orientationLock: 'auto',
    portraitSize: '',
    landscapeSize: '',
  };
}

export function activeNaiPlan(): NaiPlan {
  const list = settings.nai.plans;
  return list.find(p => p.id === settings.nai.activePlanId) ?? list[0] ?? emptyNaiPlan();
}

export function activeComfyPreset(): ComfyWorkflowPreset {
  const list = settings.comfyui.workflows;
  return list.find(w => w.id === settings.comfyui.activeWorkflowId) ?? list[0] ?? emptyComfyWorkflow();
}

/** 方案引用的提示词：用户库 ∪ 内置，类型必须与方案一致，否则回落同类型内置。 */
export function comfyPromptSetFor(plan: ComfyWorkflowPreset): ComfyPromptSet {
  const found =
    settings.comfyui.promptSets.find(p => p.id === plan.promptSetId) ??
    BUILTIN_COMFY_PROMPT_SETS.find(p => p.id === plan.promptSetId);
  return found && found.kind === plan.kind ? found : builtinComfyPromptSet(plan.kind);
}

export function activeComfyPromptSet(): ComfyPromptSet {
  return comfyPromptSetFor(activeComfyPreset());
}

/** 当前出图后端的画幅锁：NAI 取渠道级、ComfyUI 取当前方案；其余后端不锁。 */
export function activeOrientationLock(): OrientationLock {
  if (settings.defaultBackend === 'nai') return activeNaiPlan().orientationLock;
  if (settings.defaultBackend === 'comfyui') return activeComfyPreset().orientationLock;
  return 'auto';
}
