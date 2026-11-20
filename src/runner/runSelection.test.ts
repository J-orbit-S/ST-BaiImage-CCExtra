/**
 * 端到端自测：一条划线走完全链路，**不用网络、不用浏览器**。
 *
 * 这个文件是本仓库最重要的一份测试。它跑的是真的 vendored 代码（clean → prompt →
 * client → protocol → rebase → imageTagRegex）和真的编排层，只把三个宿主边界替换掉：
 * `window.SillyTavern.getContext()`（假聊天）、`generateRaw`（假模型输出）、`document`（空壳）。
 *
 * 锁住的三条不变量，正是整个项目的立身之本：
 *   1. **目标正文只有划线**，同楼未划中的句子一个字都不进 messages（其余上下文照旧）；
 *   2. tag 落在**划线那一行之后**，不是楼层开头、不是别的楼；
 *   3. changes 按柏宝绘的格式落进 `extra.bbiCharChanges`，下次重放能算出同样的角色库。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildCapture, type SelectionCapture } from '@/selection/capture';
import { runSelection } from '@/runner/runSelection';
import { disableSettingsDraft, enableSettingsDraft, SETTINGS_KEY } from '@/state/settings';
import { BBI_CHAR_EXTRA_KEY } from '@/state/charTags';

type AnyRecord = Record<string, unknown>;

const MES = ['走廊很安静。', '她推开门，灯闪了一下。', '“你回来了。”', ''].join('\n');
const SELECTED = '她推开门，灯闪了一下。';

/** 一份「柏宝绘已经配置好」的设置：NAI V5、关自然语言、跟随主 API。 */
function baibaiSettings(): AnyRecord {
  return {
    enabled: true,
    defaultBackend: 'nai',
    excludes: { excludedChars: [], customStripTags: [] },
    autoTag: {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 3,
      retryCount: 0,
      autoGenerate: true,
      prompts: {
        jailbreak: '',
        naiSpec: '',
        naiV5Spec: '',
        comfySpec: '',
        comfyThinking: '',
        naiThinking: '',
        naiV5Thinking: '',
      },
    },
    assignments: { tagGen: '' },
    channels: [],
    nai: {
      activePlanId: 'p1',
      plans: [
        {
          id: 'p1',
          name: '方案A',
          endpointId: 'e1',
          model: 'nai-diffusion-5-full',
          artistId: '',
          naturalLanguage: false,
          orientationLock: 'auto',
          portraitSize: '832×1216',
          landscapeSize: '1216×832',
        },
      ],
    },
    comfyui: { workflows: [], activeWorkflowId: '', promptSets: [], servers: [] },
  };
}

interface Harness {
  context: AnyRecord;
  message: AnyRecord;
  captured: { messages?: Array<{ role: string; content: string }> };
  toasts: string[];
}

/**
 * 每次 install 用一个新聊天 id。
 *
 * 编排层里有「本会话内这段划线已经写过 tag」的去重表（按 chatId+楼层+划线文本认），
 * 那是模块级状态，测试之间会互相污染：同一个 id 下同一段划线跑到第二次就会被拦。
 * 真实世界里每次 install 本来就是另一个聊天，用递增 id 才符合语义。
 */
let chatSeq = 0;

function install(options: { reply: string; settings?: AnyRecord; mes?: string; extra?: AnyRecord }): Harness {
  const extensionSettings: AnyRecord = { [SETTINGS_KEY]: options.settings ?? baibaiSettings() };
  const mes = options.mes ?? MES;
  const message: AnyRecord = {
    name: '小雪',
    is_user: false,
    is_system: false,
    mes,
    swipes: [mes],
    swipe_id: 0,
    send_date: '2026-11-20T00:00:00Z',
    extra: options.extra ?? {},
  };
  // 固定两层楼：0 号是上文（用来验证「上下文照旧带」），1 号是被划线的那一楼。
  // 楼层号刻意不从 0 开始 —— floor 0 的边界容易掩盖「把目标楼当成上下文」这类错误。
  const chat: AnyRecord[] = [
    {
      name: '小雪',
      is_user: false,
      is_system: false,
      mes: '她说她今天很累。',
      swipes: ['她说她今天很累。'],
      swipe_id: 0,
      send_date: '2026-11-19T00:00:00Z',
      extra: {},
    },
    message,
  ];

  const captured: Harness['captured'] = {};
  const toasts: string[] = [];
  const chatId = `chat-${++chatSeq}`;
  const context: AnyRecord = {
    chat,
    chatMetadata: {},
    name1: '我',
    name2: '小雪',
    characterId: 0,
    characters: [{ name: '小雪', avatar: 'a.png' }],
    extensionSettings,
    getCurrentChatId: () => chatId,
    getRequestHeaders: () => ({}),
    saveMetadataDebounced: () => {},
    saveChat: async () => {},
    eventSource: { on: () => {}, emit: async () => {} },
    eventTypes: {
      USER_MESSAGE_RENDERED: 'user_message_rendered',
      CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
      MESSAGE_SENT: 'message_sent',
      GENERATION_STARTED: 'generation_started',
      GENERATION_ENDED: 'generation_ended',
      CHAT_CHANGED: 'chat_changed',
      MESSAGE_EDITED: 'message_edited',
      MESSAGE_UPDATED: 'message_updated',
      MESSAGE_SWIPED: 'message_swiped',
      MESSAGE_DELETED: 'message_deleted',
    },
    generateRaw: async (params: { prompt: Array<{ role: string; content: string }> }) => {
      captured.messages = params.prompt;
      return options.reply;
    },
    getWorldInfoPrompt: undefined,
    updateMessageBlock: undefined,
    reloadCurrentChat: undefined,
  };

  vi.stubGlobal('window', { SillyTavern: { getContext: () => context } });
  // applyMessageText 在 Node 里会找 #chat .mes：给个空壳让它走「无需刷新 DOM」分支
  vi.stubGlobal('document', { querySelector: () => null });
  vi.stubGlobal('toastr', {
    info: (text: string) => toasts.push(`info:${text}`),
    success: (text: string) => toasts.push(`success:${text}`),
    warning: (text: string) => toasts.push(`warning:${text}`),
    error: (text: string) => toasts.push(`error:${text}`),
  });

  return { context, message, captured, toasts };
}

function captureOf(raw: string, floor: number, needle: string = SELECTED): SelectionCapture {
  const start = raw.indexOf(needle);
  if (start < 0) throw new Error(`needle not found: ${needle}`);
  const outcome = buildCapture({
    raw,
    messageId: floor,
    swipeId: 0,
    domText: needle,
    located: { start, end: start + needle.length, method: 'strict', candidates: 1 },
  });
  if (!outcome.ok) throw new Error(`capture failed: ${outcome.reason}`);
  return outcome.capture;
}

const REPLY = JSON.stringify({
  images: [{ position: 'P1', tag: '1girl, doorway, dim light', size: 'portrait' }],
  changes: [
    {
      name: '小雪',
      field: 'new',
      fields: { sex: '1girl', hair: 'long silver hair', eyes: 'red eyes' },
      position: 'P1',
      reason: '首次出场',
    },
  ],
});

beforeEach(() => {
  vi.unstubAllGlobals();
  // 默认草稿层是给上游单测用的；这里要验生产语义（真读 extensionSettings）
  disableSettingsDraft();
});

afterEach(() => {
  vi.unstubAllGlobals();
  enableSettingsDraft();
});

describe('runSelection 端到端', () => {
  it('发给模型的「目标正文」只有划线，同楼未划中的句子不进 messages', async () => {
    const harness = install({ reply: REPLY });
    const result = await runSelection(captureOf(MES, 1));

    expect(result.status).toBe('saved');
    const messages = harness.captured.messages ?? [];
    expect(messages.length).toBeGreaterThan(1);
    // 破限词永远置顶（工程方案 §9.3 断言 1）
    expect(messages[0].role).toBe('system');

    const userContent = messages[messages.length - 1].content;
    expect(userContent).toContain(SELECTED);
    // ★ 核心不变量：同一楼里没被划中的句子一个字都不该出现在请求里
    expect(userContent).not.toContain('走廊很安静');
    expect(userContent).not.toContain('你回来了');
    // 但「上下文楼」照旧带上：划线只换一层楼的内容，不裁剪上下文
    expect(userContent).toContain('她说她今天很累');
  });

  it('tag 落在划线那一行之后，正文其余行一字不动', async () => {
    const harness = install({ reply: REPLY });
    const result = await runSelection(captureOf(MES, 1));
    expect(result.status).toBe('saved');

    const next = String(harness.message.mes);
    const lines = next.split('\n');
    expect(lines[0]).toBe('走廊很安静。');
    expect(lines[1]).toBe(SELECTED);
    // 序列化口径（L3 不变量）：插画**不写** <type>、size 恒写出、空段整段不写。
    // 这一行写错，柏宝绘图库的 promptHash 会全变 stale（图全成了「待重新生成」）。
    expect(lines[2]).toBe('<bbi_image>1girl, doorway, dim light<size>portrait</size></bbi_image>');
    expect(next).toContain('“你回来了。”');
    // swipe 同步（否则用户一切 swipe 图就没了）
    expect((harness.message.swipes as string[])[0]).toBe(next);
    expect(result.images).toBe(1);
  });

  it('changes 按柏宝绘格式落进 extra.bbiCharChanges', async () => {
    const harness = install({ reply: REPLY });
    await runSelection(captureOf(MES, 1));
    const delta = (harness.message.extra as AnyRecord)[BBI_CHAR_EXTRA_KEY] as AnyRecord;
    expect(delta).toBeTruthy();
    expect(delta.v).toBe(1);
    expect(delta.swipe).toBe(0);
    const ops = delta.ops as Array<AnyRecord>;
    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe('new');
    expect(ops[0].name).toBe('小雪');
  });

  it('模型返回空 images 且无 changes：不写正文，也不报错', async () => {
    const harness = install({ reply: JSON.stringify({ images: [], changes: [] }) });
    const result = await runSelection(captureOf(MES, 1));
    expect(result.status).toBe('no-image');
    expect(harness.message.mes).toBe(MES);
  });

  it('同一段划线连点两次：第二次被拦住，不会插第二批 tag', async () => {
    const harness = install({ reply: REPLY });
    const capture = captureOf(MES, 1);
    const first = await runSelection(capture);
    expect(first.status).toBe('saved');
    // 第二次必须重新捕获（正文已变，旧快照会判 stale）
    const second = await runSelection(captureOf(String(harness.message.mes), 1));
    expect(second.status).toBe('skipped');
    expect(second.reason).toBe('already-processed');
  });

  it('模型输出不合协议：重试耗尽后如实报错，正文不动', async () => {
    const harness = install({ reply: '抱歉，我无法完成这个请求。' });
    const result = await runSelection(captureOf(MES, 1));
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('retries-exhausted');
    expect(harness.message.mes).toBe(MES);
    expect(harness.toasts.some(text => text.startsWith('error:'))).toBe(true);
  });
});

/**
 * 2026-11-20 用户实测反馈的回归：
 * 「在已经有 bbi_image 的楼里划线出图，会识别到之前的 tag，旧的那版变成『旧提示词』，
 *   图被顶掉」。
 *
 * 这里锁两件事：① 旧 tag 绝不进模型；② 旧 tag 的图文一字不改、历史归属不丢。
 */
describe('楼里已有生图 tag', () => {
  const OLD_TAG = '<bbi_image>1girl, doorway, dim light<size>portrait</size></bbi_image>';
  const FLOOR = ['走廊很安静。', OLD_TAG, '她推开门，灯闪了一下。', '“你回来了。”'].join('\n');

  /** 取旧图那条历史（真实结构：extra.bbiImage[swipe][hash][]）。 */
  function oldEntriesOf(harness: Harness): AnyRecord[] {
    const store = (harness.message.extra as AnyRecord).bbiImage as AnyRecord;
    return (store?.['0'] as AnyRecord)?.H_OLD as AnyRecord[];
  }

  function storeWithOldImage(): AnyRecord {
    return {
      bbiImage: {
        '0': {
          H_OLD: [{ generationId: 'g1', path: '/old.png', prompt: OLD_TAG, seed: null, status: 'ready', createdAt: 1, slotSeq: 0 }],
        },
      },
    };
  }

  it('旧 tag 不进模型：目标正文里看不到 bbi_image 与旧提示词', async () => {
    const harness = install({ reply: REPLY, mes: FLOOR, extra: storeWithOldImage() });
    // 划「她推开门」——它紧挨在旧 tag 下面
    const result = await runSelection(captureOf(FLOOR, 1, '她推开门，灯闪了一下。'));
    expect(result.status).toBe('saved');

    const userContent = (harness.captured.messages ?? []).at(-1)?.content ?? '';
    expect(userContent).toContain('她推开门，灯闪了一下。');
    expect(userContent).not.toContain('bbi_image');
    expect(userContent).not.toContain('1girl, doorway');
  });

  it('旧 tag 原文一字不动，两张 tag 都在正文里', async () => {
    const harness = install({ reply: REPLY, mes: FLOOR, extra: storeWithOldImage() });
    await runSelection(captureOf(FLOOR, 1, '她推开门，灯闪了一下。'));

    const lines = String(harness.message.mes).split('\n');
    expect(lines).toEqual([
      '走廊很安静。',
      OLD_TAG,
      '她推开门，灯闪了一下。',
      '<bbi_image>1girl, doorway, dim light<size>portrait</size></bbi_image>',
      '“你回来了。”',
    ]);
  });

  it('新 tag 插在旧 tag 下方：旧图槽位不动，不需要迁移', async () => {
    const harness = install({ reply: REPLY, mes: FLOOR, extra: storeWithOldImage() });
    await runSelection(captureOf(FLOOR, 1, '她推开门，灯闪了一下。'));

    const oldEntries = oldEntriesOf(harness);
    expect(oldEntries[0].slotSeq).toBe(0);
  });

  it('新 tag 插在旧 tag 上方：旧图槽位跟着后移，图不会认领到新卡上', async () => {
    const harness = install({ reply: REPLY, mes: FLOOR, extra: storeWithOldImage() });
    // 划「走廊很安静。」——它在旧 tag 上面，新 tag 会插到旧 tag 之前
    const result = await runSelection(captureOf(FLOOR, 1, '走廊很安静。'));
    expect(result.status).toBe('saved');

    const next = String(harness.message.mes);
    const lines = next.split('\n');
    // 新 tag 落在划线之后、旧 tag 之前，旧 tag 原文原样跟在其后
    expect(lines[1]).toBe('<bbi_image>1girl, doorway, dim light<size>portrait</size></bbi_image>');
    expect(lines[2]).toBe(OLD_TAG);
    // ★ 旧图的历史槽位 0 → 1，与它在楼里的新位置一致
    const oldEntries = oldEntriesOf(harness);
    expect(oldEntries[0].slotSeq).toBe(1);
    // 其余字段一个都没被改
    expect(oldEntries[0]).toMatchObject({ path: '/old.png', prompt: OLD_TAG, generationId: 'g1' });
    expect(harness.message.extra as AnyRecord).toHaveProperty('bbiCharChanges');
  });

  it('旧图不存在（还没出过图）时不凭空创建图片历史', async () => {
    const harness = install({ reply: REPLY, mes: FLOOR, extra: {} });
    await runSelection(captureOf(FLOOR, 1, '走廊很安静。'));
    expect(harness.message.extra as AnyRecord).not.toHaveProperty('bbiImage');
  });
});
