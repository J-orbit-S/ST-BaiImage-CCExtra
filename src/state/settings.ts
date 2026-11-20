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
import type { ComfyPresetMode, ComfySimpleConfig } from '@/backends/comfyTemplates';
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

/** 出图方案（字段与上游 ComfyWorkflowPreset 一致）。 */
export interface ComfyWorkflowPreset extends SizePair {
  id: string;
  name: string;
  kind: ComfyKind;
  /** 引用的服务器 id；悬空时回落第一台。 */
  serverId: string;
  /** 引用的提示词 id（用户库或内置）；悬空/类型不符时回落同类型内置。 */
  promptSetId: string;
  /** 配置方式：custom=粘贴 API JSON + 占位符；simple=选模型/LoRA 自动组装。 */
  mode: ComfyPresetMode;
  /** custom 模式的工作流 JSON。 */
  workflow: string;
  /** simple 模式的参数。 */
  simple: ComfySimpleConfig;
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

/** 出图/测试连接用的 conn：当前方案引用的服务器 url + 方案的工作流与横竖尺寸。 */
export interface ComfyRunConn extends SizePair {
  url: string;
  workflow: string;
  mode: ComfyPresetMode;
  simple: ComfySimpleConfig;
}

/** 副 API 渠道。字段与上游 ApiChannel 完全一致（含 reasoningEffort 的语义注释见上游）。 */
export interface ApiChannel {
  id: string;
  name: string;
  url: string;
  key: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutSec: number;
  stream: boolean;
  excludeParams: string[];
  /** 空串 = auto = 不发 reasoning_effort；非空时整条请求改走 custom 源。 */
  reasoningEffort: string;
}

/** 只声明我们读的部分；上游还有大量字段，这里不求全，只求字段名准确。 */
export interface ImageSettings {
  defaultBackend: BackendId;
  excludes: ExcludesSettings;
  autoTag: AutoTagSettings;
  /** 任务指派：tagGen 为空串 = 跟随主 API。 */
  assignments: { tagGen: string };
  /** 渠道镜像（真身在 extensionSettings['baibai_api_channels']，这里不使用）。 */
  channels: ApiChannel[];
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
    assignments: { tagGen: '' },
    channels: [],
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
    assignments: { tagGen: '', ...(raw.assignments ?? {}) },
    channels: Array.isArray(raw.channels) ? (raw.channels as ApiChannel[]) : [],
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
 * 递归只读视图：**顶层与深层**的写操作都会抛错。
 *
 * 只做顶层拦截是不够的——`settings.comfyui.promptSets = [...]` 这种写法会绕过顶层 set，
 * 直接改到上游对象上，那才是真正会毁掉用户配置的路径。
 */
function readonlyView<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  return new Proxy(value as object, {
    get(target, prop, receiver) {
      return readonlyView(Reflect.get(target, prop, receiver));
    },
    set(_t, prop) {
      return writeForbidden(prop);
    },
    deleteProperty(_t, prop) {
      return writeForbidden(prop);
    },
    defineProperty(_t, prop) {
      return writeForbidden(prop);
    },
  }) as T;
}

/**
 * 测试草稿层。
 *
 * 上游的单测会直接写 `settings.defaultBackend = 'nai'` 之类来构造场景；
 * 生产上这种写入必须被禁止，否则等于我们能改柏宝绘的配置。
 * 折中：**仅在测试进程里**把 settings 换成一个可写副本（draft），
 * 副本与 extensionSettings 完全脱钩，怎么改都碰不到真实配置；
 * 生产环境永远走 readonlyView，一个字都写不进去。
 */
let draft: ImageSettings | null = null;

function testEnv(): boolean {
  try {
    const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
    return !!g.process?.env?.VITEST;
  } catch {
    return false;
  }
}

/** 启用草稿层（测试用）。seedDefaults 会补一份与上游「出生状态」同形的方案/工作流。 */
export function enableSettingsDraft(seedDefaults = true): void {
  const base = structuredClone(readSettings());
  if (seedDefaults) {
    // 与上游出生状态对齐：新装默认后端是 comfyui（上游 defaults() 里写死）。
    // 不补这一项，未显式设置后端的用例会走进 NAI 分支，测的就不是原本要测的东西。
    if (!base.defaultBackend) base.defaultBackend = 'comfyui';
    if (base.nai.plans.length === 0) {
      base.nai.plans.push({
        id: 'nplan_test_default',
        name: '默认方案',
        endpointId: '',
        // 与上游 newNaiPlan 的默认模型一致，让「4.5/V5 才支持角色提示」这类分支可被测试覆盖
        model: 'nai-diffusion-5-full',
        artistId: '',
        naturalLanguage: true,
        orientationLock: 'auto',
        portraitSize: '832×1216',
        landscapeSize: '1216×832',
      });
      base.nai.activePlanId = 'nplan_test_default';
    }
    if (base.comfyui.workflows.length === 0) {
      base.comfyui.workflows.push({
        id: 'wf_test_default',
        name: '默认工作流',
        kind: 'illustration',
        serverId: '',
        promptSetId: BUILTIN_COMFY_ILLUST_ID,
        mode: 'custom',
        workflow: '',
        simple: {} as ComfySimpleConfig,
        naturalLanguage: false,
        orientationLock: 'auto',
        portraitSize: '832×1216',
        landscapeSize: '1216×832',
      });
      base.comfyui.activeWorkflowId = 'wf_test_default';
    }
  }
  draft = base;
}

/** 关闭草稿层，回到生产的只读语义（我们自己的一致性测试要用）。 */
export function disableSettingsDraft(): void {
  draft = null;
}


/**
 * 设置视图。
 * - 生产：只读，任何层级的写入都抛错；
 * - 测试：读写草稿副本（与真实配置脱钩）。
 */
export const settings: ImageSettings = new Proxy({} as ImageSettings, {
  get(_target, prop) {
    const source = draft ?? readSettings();
    return draft ? source[prop as keyof ImageSettings] : readonlyView(source[prop as keyof ImageSettings]);
  },
  has(_target, prop) {
    return prop in (draft ?? readSettings());
  },
  ownKeys() {
    return Reflect.ownKeys(draft ?? readSettings());
  },
  getOwnPropertyDescriptor(_target, prop): PropertyDescriptor {
    const source = draft ?? readSettings();
    return { configurable: true, enumerable: true, value: source[prop as keyof ImageSettings] };
  },
  set(_target, prop, value) {
    if (!draft) return writeForbidden(prop);
    (draft as unknown as Record<string | symbol, unknown>)[prop] = value;
    return true;
  },
  deleteProperty(_target, prop) {
    if (!draft) return writeForbidden(prop);
    delete (draft as unknown as Record<string | symbol, unknown>)[prop];
    return true;
  },
  defineProperty(_target, prop) {
    return writeForbidden(prop);
  },
});

let promptSetSeq = 0;

/** 新建一套提示词，内容预填同类型内置文本（与上游同口径）。 */
export function newComfyPromptSet(kind: ComfyKind, name: string): ComfyPromptSet {
  promptSetSeq += 1;
  const builtin = builtinComfyPromptSet(kind);
  return { id: `ps_${Date.now()}_${promptSetSeq}`, name, kind, spec: builtin.spec, thinking: builtin.thinking };
}

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
    serverId: '',
    promptSetId: '',
    mode: 'custom',
    workflow: '',
    simple: {} as ComfySimpleConfig,
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

/* —— 副 API 渠道：跨插件共享存储（只读） ——
   真身在 extensionSettings['baibai_api_channels']（带 revision），各插件的设置里只留镜像。
   我们只读真身，不碰镜像、不广播事件、绝不回写——写渠道是柏宝绘/柏宝书的事。 */
export const SHARED_CHANNELS_KEY = 'baibai_api_channels';
export const SHARED_CHANNELS_SCHEMA_VERSION = 1;

/**
 * 字段兜底与上游 normalizeChannel 同口径。
 * 上游在读共享存储时就会 normalize 一遍；我们只读，但同样需要兜底，
 * 否则老渠道缺 timeoutSec 之类会让下游算出 NaN 超时。
 */
export function normalizeChannel(c: Partial<ApiChannel>): ApiChannel {
  return {
    id: typeof c.id === 'string' ? c.id : '',
    name: typeof c.name === 'string' ? c.name : '新渠道',
    url: typeof c.url === 'string' ? c.url : '',
    key: typeof c.key === 'string' ? c.key : '',
    model: typeof c.model === 'string' ? c.model : '',
    temperature: typeof c.temperature === 'number' ? c.temperature : 1.0,
    maxTokens: typeof c.maxTokens === 'number' ? c.maxTokens : 65535,
    timeoutSec:
      typeof c.timeoutSec === 'number' && Number.isFinite(c.timeoutSec) && c.timeoutSec > 0
        ? Math.floor(c.timeoutSec)
        : 180,
    stream: typeof c.stream === 'boolean' ? c.stream : false,
    excludeParams: Array.isArray(c.excludeParams)
      ? c.excludeParams.filter((x): x is string => typeof x === 'string')
      : [],
    reasoningEffort: typeof c.reasoningEffort === 'string' ? c.reasoningEffort.trim() : '',
  };
}

/** 读共享渠道列表（当场读，不缓存）。 */
export function readChannels(): ApiChannel[] {
  const raw = getContext()?.extensionSettings?.[SHARED_CHANNELS_KEY] as
    | { channels?: unknown }
    | undefined;
  const list = raw?.channels;
  if (!Array.isArray(list)) return [];
  return list.filter(c => c && typeof c === 'object').map(c => normalizeChannel(c as Partial<ApiChannel>));
}

/**
 * 当前「写 tag」任务使用的副 API 渠道。
 * 指派为空串 = 跟随主 API（返回 null，调用方据此走 requestViaMainApi）。
 */
export function getTagGenChannel(): ApiChannel | null {
  const id = settings.assignments.tagGen;
  if (!id) return null;
  return readChannels().find(c => c.id === id) ?? null;
}

/* 测试进程里自动启用草稿层：上游单测会直接改 settings 构造场景。
   必须放在文件末尾——它依赖上面定义的 BUILTIN_COMFY_ILLUST_ID 等常量。 */
if (testEnv()) enableSettingsDraft();
