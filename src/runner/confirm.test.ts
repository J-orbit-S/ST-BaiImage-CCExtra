/**
 * 确认式（V2.0）端到端：划线 → 候选 → 确认 → 写回 → 出图。
 *
 * 这个文件只锁一件事，但它是整个 volume 2 的立身之本：
 * **「生成 tag」与「写正文 / 出图」必须是两件事**。
 * 所以每一条用例都在验「什么时候不该写」——没确认之前，正文一个字节都不许动，
 * 图片额度一次都不许花。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/ui/autoGenerate', () => ({
  autoGenerateSlots: vi.fn(async () => ({ clicked: 1 })),
  setAutoGenerate: vi.fn(),
  isAutoGenerateEnabled: () => true,
}));

import { autoGenerateSlots } from '@/ui/autoGenerate';
import { buildCapture, type SelectionCapture } from '@/selection/capture';
import { runSelection } from '@/runner/runSelection';
import { commitCandidate, rerollCandidate } from '@/runner/commit';
import { forgetProcessed } from '@/runner/dedupe';
import { disableSettingsDraft, enableSettingsDraft, SETTINGS_KEY } from '@/state/settings';
import { PREFS_KEY, forgetPrefsCache } from '@/state/prefs';
import { CANDIDATES_KEY, listCandidates, normalizeStore } from '@/state/candidates';
import { BBI_CHAR_EXTRA_KEY } from '@/state/charTags';

type AnyRecord = Record<string, unknown>;

const MES = ['走廊很安静。', '她推开门，灯闪了一下。', '“你回来了。”', ''].join('\n');
const SELECTED = '她推开门，灯闪了一下。';
const TAG_LINE = '<bbi_image>1girl, doorway, dim light<size>portrait</size></bbi_image>';
const TAG_LINE_2 = '<bbi_image>1girl, doorway, warm light<size>portrait</size></bbi_image>';
const TAG_LINE_ROLLED = '<bbi_image>1girl, doorway, moonlight<size>portrait</size></bbi_image>';

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
  captured: Array<{ messages?: Array<{ role: string; content: string }> }>;
  toasts: string[];
  requests: number;
}

let chatSeq = 0;

function reply(tag = '1girl, doorway, dim light', tagZh?: string): string {
  return JSON.stringify({
    images: [{ position: 'P1', tag, ...(tagZh ? { tagZh } : {}), size: 'portrait' }],
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
}

function install(
  options: { replies?: string[]; mes?: string; prefs?: AnyRecord; extra?: AnyRecord } = {},
): Harness {
  const replies = (options.replies ?? [reply()]).slice();
  const extensionSettings: AnyRecord = {
    [SETTINGS_KEY]: baibaiSettings(),
    [PREFS_KEY]: options.prefs ?? { autoGenerate: false, confirmTag: true },
  };
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

  const harness: Harness = { context: {}, message, captured: [], toasts: [], requests: 0 };
  const chatId = `confirm-chat-${++chatSeq}`;
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
      harness.requests += 1;
      harness.captured.push({ messages: params.prompt });
      return replies.length > 1 ? (replies.shift() as string) : replies[0];
    },
    getWorldInfoPrompt: undefined,
    updateMessageBlock: undefined,
    reloadCurrentChat: undefined,
  };
  harness.context = context;

  vi.stubGlobal('window', { SillyTavern: { getContext: () => context } });
  vi.stubGlobal('document', { querySelector: () => null });
  vi.stubGlobal('toastr', {
    info: (text: string) => harness.toasts.push(`info:${text}`),
    success: (text: string) => harness.toasts.push(`success:${text}`),
    warning: (text: string) => harness.toasts.push(`warning:${text}`),
    error: (text: string) => harness.toasts.push(`error:${text}`),
  });

  return harness;
}

function captureOf(raw: string, floor: number, needle = SELECTED): SelectionCapture {
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

beforeEach(() => {
  vi.unstubAllGlobals();
  disableSettingsDraft();
  forgetProcessed();
  forgetPrefsCache();
  vi.mocked(autoGenerateSlots).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  enableSettingsDraft();
  forgetProcessed();
  forgetPrefsCache();
});

describe('确认式：A 段只产出候选', () => {
  it('生成 tag 不写正文、不出图，只把候选放进池子', async () => {
    const harness = install();
    const result = await runSelection(captureOf(MES, 1));

    expect(result.status).toBe('pending');
    expect(harness.message.mes).toBe(MES);
    expect(harness.message.extra as AnyRecord).not.toHaveProperty(BBI_CHAR_EXTRA_KEY);
    expect(vi.mocked(autoGenerateSlots)).not.toHaveBeenCalled();

    const items = listCandidates();
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('pending');
    expect(items[0].floor).toBe(1);
    expect(items[0].versions[0].image.tag).toBe('1girl, doorway, dim light');
    // 候选存在 chatMetadata（随聊天走），不在全局设置里
    expect((harness.context.chatMetadata as AnyRecord)[CANDIDATES_KEY]).toBeTruthy();
    const globalBox = (harness.context.extensionSettings as AnyRecord)[CANDIDATES_KEY] as AnyRecord | undefined;
    expect(globalBox?.items).toBeUndefined();
  });

  it('全自动模式（默认）不经过候选池：照 v0.2.0 直接写回', async () => {
    const harness = install({ prefs: { autoGenerate: true } });
    const result = await runSelection(captureOf(MES, 1));

    expect(result.status).toBe('saved');
    expect(String(harness.message.mes).split('\n')[2]).toBe(TAG_LINE);
    expect(listCandidates()).toEqual([]);
    await Promise.resolve();
    expect(vi.mocked(autoGenerateSlots)).toHaveBeenCalledTimes(1);
  });

  it('全手动模式（都关）：直接写 tag，但不点卡片', async () => {
    const harness = install({ prefs: { autoGenerate: false, confirmTag: false } });
    const result = await runSelection(captureOf(MES, 1));

    expect(result.status).toBe('saved');
    expect(String(harness.message.mes).split('\n')[2]).toBe(TAG_LINE);
    expect(listCandidates()).toEqual([]);
    await Promise.resolve();
    expect(vi.mocked(autoGenerateSlots)).not.toHaveBeenCalled();
  });
});

describe('确认一条候选', () => {
  it('确认才写正文，写完按「确认即出图」点卡片', async () => {
    const harness = install();
    await runSelection(captureOf(MES, 1));
    const item = listCandidates()[0];

    const result = await commitCandidate(item.imageId);
    expect(result.status).toBe('saved');
    expect(String(harness.message.mes).split('\n')[2]).toBe(TAG_LINE);
    // swipe 同步（否则用户一切 swipe 图就没了）
    expect((harness.message.swipes as string[])[0]).toBe(harness.message.mes);

    await Promise.resolve();
    expect(vi.mocked(autoGenerateSlots)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(autoGenerateSlots).mock.calls[0][0].seqs).toEqual([0]);

    // 确认过的候选移出池子，不会被重复确认
    expect(listCandidates()).toEqual([]);
    expect((await commitCandidate(item.imageId)).status).toBe('failed');
  });

  it('确认时用「当前正文」重新定位：楼里上面多了一段也能插对位置', async () => {
    const harness = install();
    await runSelection(captureOf(MES, 1));
    const item = listCandidates()[0];

    // 另一处（或另一个插件）在划线之前加了一行，行号整体 +1
    harness.message.mes = `新的开头。\n${MES}`;
    harness.message.swipes = [harness.message.mes];

    const result = await commitCandidate(item.imageId);
    expect(result.status).toBe('saved');

    const lines = String(harness.message.mes).split('\n');
    expect(lines[0]).toBe('新的开头。');
    expect(lines[2]).toBe(SELECTED);
    expect(lines[3]).toBe(TAG_LINE);
  });

  it('锚点被改掉：不写、给出人话、候选仍留着（可以删掉重划）', async () => {
    const harness = install();
    await runSelection(captureOf(MES, 1));
    const item = listCandidates()[0];

    harness.message.mes = MES.replace(SELECTED, '她已经不在门口了。');
    const result = await commitCandidate(item.imageId);

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('anchor-lost');
    expect(harness.toasts.some(text => text.startsWith('warning:') && text.includes('请删掉这条候选'))).toBe(true);
    expect(listCandidates()).toHaveLength(1);
  });

  it('切了 swipe：拒绝写回（那条候选对应的是另一份正文）', async () => {
    const harness = install();
    await runSelection(captureOf(MES, 1));
    const item = listCandidates()[0];

    harness.message.swipe_id = 1;
    harness.message.swipes = [MES, MES];
    const result = await commitCandidate(item.imageId);

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('swipe-changed');
    expect(harness.message.mes).toBe(MES);
  });
});

describe('重 Roll 与编辑', () => {
  it('重 Roll 只换提示词：不写正文、不出图、候选多一版', async () => {
    const harness = install({ replies: [reply(), reply('1girl, doorway, moonlight')] });
    await runSelection(captureOf(MES, 1));
    const item = listCandidates()[0];
    const requestsAfterAnalyze = harness.requests;

    const result = await rerollCandidate(item.imageId);
    expect(result.status).toBe('pending');
    expect(harness.requests).toBe(requestsAfterAnalyze + 1);
    expect(harness.message.mes).toBe(MES);
    expect(vi.mocked(autoGenerateSlots)).not.toHaveBeenCalled();

    const next = listCandidates()[0];
    expect(next.versions.map(version => version.image.tag)).toEqual([
      '1girl, doorway, dim light',
      '1girl, doorway, moonlight',
    ]);
    expect(next.activeVersion).toBe(1);
  });

  it('重 Roll 只要一张：请求里把最少/最多都压成 1', async () => {
    const harness = install({ replies: [reply(), reply('1girl, doorway, moonlight')] });
    await runSelection(captureOf(MES, 1));
    const item = listCandidates()[0];
    await rerollCandidate(item.imageId);

    const lastRequest = harness.captured.at(-1)?.messages?.map(message => message.content).join('\n') ?? '';
    // 任务备注会说清「只重写第 1 张」——这是单张重写的锚
    expect(lastRequest).toContain('重 Roll');
    expect(lastRequest).toContain('只输出 1 张');
  });

  it('编辑只改候选，不发请求（改一两个词不该花额度）', async () => {
    const harness = install();
    await runSelection(captureOf(MES, 1));
    const item = listCandidates()[0];
    const requests = harness.requests;

    const { editCandidateTag } = await import('@/state/candidates');
    expect(editCandidateTag(item.imageId, '1girl, edited tag')).toBe(true);

    expect(harness.requests).toBe(requests);
    expect(listCandidates()[0].versions[0].image.tag).toBe('1girl, edited tag');
    expect(harness.message.mes).toBe(MES);
  });
});

describe('同一楼多次确认', () => {
  it('两个候选各确认一次：两张 tag 都进正文，楼层 changes 累加不互相覆盖', async () => {
    const harness = install({
      replies: [
        JSON.stringify({
          images: [
            { position: 'P1', tag: '1girl, doorway, dim light', size: 'portrait' },
            { position: 'P1', tag: '1girl, doorway, warm light', size: 'portrait' },
          ],
          changes: [
            {
              name: '小雪',
              field: 'new',
              fields: { sex: '1girl', hair: 'long silver hair', eyes: 'red eyes' },
              position: 'P1',
              reason: '首次出场',
            },
          ],
        }),
      ],
    });

    await runSelection(captureOf(MES, 1));
    const items = listCandidates();
    expect(items).toHaveLength(2);
    // 同一批里只有第一张带 changes
    expect(items[0].versions[0].changes).toHaveLength(1);
    expect(items[1].versions[0].changes).toHaveLength(0);

    expect((await commitCandidate(items[0].imageId)).status).toBe('saved');
    expect((await commitCandidate(items[1].imageId)).status).toBe('saved');

    const next = String(harness.message.mes);
    expect(next).toContain(TAG_LINE);
    expect(next).toContain(TAG_LINE_2);

    // 第二次确认没有带 changes，但第一次的增量必须还在（覆盖会丢角色建档）
    const delta = (harness.message.extra as AnyRecord)[BBI_CHAR_EXTRA_KEY] as AnyRecord;
    expect(delta).toBeTruthy();
    expect((delta.ops as unknown[]).length).toBe(1);
  });

  it('候选只属于生成它的那个聊天', async () => {
    const harness = install();
    await runSelection(captureOf(MES, 1));
    expect(listCandidates()).toHaveLength(1);

    // 换聊天：getCurrentChatId 变了，池子里看不到
    const stubbed = (globalThis as unknown as { window: { SillyTavern: { getContext: () => AnyRecord } } }).window
      .SillyTavern.getContext;
    const original = stubbed();
    (globalThis as unknown as { window: { SillyTavern: { getContext: () => AnyRecord } } }).window.SillyTavern =
      { getContext: () => ({ ...original, getCurrentChatId: () => 'another-chat' }) };

    expect(listCandidates()).toEqual([]);
    expect(normalizeStore((harness.context.chatMetadata as AnyRecord)[CANDIDATES_KEY]).items).toHaveLength(1);
  });
});

describe('中文对照（tagZh）', () => {
  it('确认式下：模型给的 tagZh 跟着候选进池子', async () => {
    const harness = install({ replies: [reply('1girl, doorway, dim light', '少女，门口，昏暗的灯光')] });
    const result = await runSelection(captureOf(MES, 1));
    expect(result.status).toBe('pending');

    const items = normalizeStore((harness.context.chatMetadata as AnyRecord)[CANDIDATES_KEY]).items;
    expect(items).toHaveLength(1);
    expect(items[0].versions[0].tagZh).toBe('少女，门口，昏暗的灯光');
    // 中文只在候选里：正文里绝不能出现（它是「只给人看」的字段）
    expect(String(harness.message.mes)).not.toContain('少女，门口');
  });

  it('重 Roll：新版本带新中文，旧版本的对照保持原样', async () => {
    const harness = install({
      replies: [
        reply('1girl, doorway, dim light', '少女，门口，昏暗的灯光'),
        reply('1girl, doorway, moonlight', '少女，门口，月光'),
      ],
    });
    await runSelection(captureOf(MES, 1));
    const imageId = normalizeStore((harness.context.chatMetadata as AnyRecord)[CANDIDATES_KEY]).items[0].imageId;

    const rolled = await rerollCandidate(imageId);
    expect(rolled.status).toBe('pending');

    const item = normalizeStore((harness.context.chatMetadata as AnyRecord)[CANDIDATES_KEY]).items[0];
    expect(item.versions).toHaveLength(2);
    expect(item.versions[0].tagZh).toBe('少女，门口，昏暗的灯光');
    expect(item.versions[1].tagZh).toBe('少女，门口，月光');
    expect(item.versions[1].image.tag).toBe('1girl, doorway, moonlight');
    // 重 Roll 不写正文、不出图
    expect(String(harness.message.mes)).not.toContain('bbi_image');
    expect(vi.mocked(autoGenerateSlots)).not.toHaveBeenCalled();
  });
});
