import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildAutoTagMessages } from '@/autoTag/prompt';
import { enableSettingsDraft, settings, type AutoTagSettings, type AutoTagPrompts } from '@/state/settings';
import type { STContext } from '@/st/context';

/**
 * 黄金哈希哨兵（工程方案 §7.4 的落地）。
 *
 * 目的：**锁住「我们发出去的 messages」**。
 * 上游代码是逐字搬的（SHA 已校验），所以只要这条哈希不变，就能断定
 * 「LLM 看到的输入与基准时刻完全一致」；一旦适配层（设置读取、上下文装配、
 * 草稿默认值）出现任何会改变消息的漂移，这里立刻红。
 *
 * 它和 verify:upstream 是互补的两道闸：
 * - verify:upstream 管「代码有没有被改」（字节级）；
 * - 本哨兵管「跑出来的东西有没有变」（行为级）。
 *
 * 更新方式（只有在**确认变更符合预期**时才做，并在 commit message 里说明原因）：
 *   GOLDEN_UPDATE=1 npx vitest run src/consistency/golden.test.ts
 */

const FIXTURE = path.resolve(__dirname, 'fixtures/autoTag-messages.json');

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function prompts(overrides: Partial<AutoTagPrompts> = {}): AutoTagPrompts {
  return {
    jailbreak: '',
    naiSpec: '',
    naiV5Spec: '',
    comfySpec: '',
    comfyThinking: '',
    naiThinking: '',
    naiV5Thinking: '',
    ...overrides,
  };
}

function autoTag(overrides: Partial<AutoTagSettings> = {}): AutoTagSettings {
  return {
    enabled: true,
    contextMessages: 2,
    minImages: 0,
    maxImages: 2,
    retryCount: 1,
    autoGenerate: false,
    prompts: prompts(),
    ...overrides,
  };
}

function context(): STContext {
  return {
    chat: [
      { name: 'User', is_user: true, is_system: false, mes: '上一层' } as never,
      { name: 'Char', is_user: false, is_system: false, mes: '她站在雨里，抬头看向亮着的窗。\n\n手里攥着那封信。' } as never,
    ],
    chatMetadata: {},
    name1: 'User',
    name2: 'Char',
    getCurrentChatId: () => 'chat-golden',
    getRequestHeaders: () => ({}),
    saveMetadataDebounced: () => undefined,
    saveChat: async () => undefined,
    eventSource: { on: () => undefined },
    eventTypes: {
      USER_MESSAGE_RENDERED: 'user',
      CHARACTER_MESSAGE_RENDERED: 'character',
      MESSAGE_SENT: 'sent',
      GENERATION_STARTED: 'started',
      GENERATION_ENDED: 'ended',
      CHAT_CHANGED: 'changed',
      MESSAGE_EDITED: 'edited',
      MESSAGE_UPDATED: 'updated',
      MESSAGE_SWIPED: 'swiped',
      MESSAGE_DELETED: 'deleted',
    },
  } as unknown as STContext;
}

type Fingerprint = Record<string, { sha256: string; messageCount: number; roles: string[] }>;

function readFixture(): Fingerprint {
  if (!fs.existsSync(FIXTURE)) return {};
  return JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Fingerprint;
}

const UPDATE = process.env.GOLDEN_UPDATE === '1';
const store: Fingerprint = readFixture();

async function fingerprint(name: string, build: () => Promise<{ role: string; content: string }[]>): Promise<void> {
  const messages = await build();
  const payload = JSON.stringify(messages);
  const actual = { sha256: sha256(payload), messageCount: messages.length, roles: messages.map(m => m.role) };

  if (UPDATE) {
    store[name] = actual;
    return;
  }

  const expected = store[name];
  if (!expected) {
    throw new Error(`缺少黄金基准 "${name}"。首次生成请运行：GOLDEN_UPDATE=1 npx vitest run src/consistency/golden.test.ts`);
  }
  expect(
    { sha256: actual.sha256, messageCount: actual.messageCount, roles: actual.roles },
    `黄金基准 "${name}" 不匹配：消息内容已变化。若本次变更**有意**改变提示词，请确认后更新基准。`,
  ).toEqual(expected);
}

beforeEach(() => {
  enableSettingsDraft();
});

afterEach(() => {
  // 把基准写回磁盘（仅在 UPDATE 模式下有内容变化）
  if (UPDATE) {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  }
});

describe('黄金哈希：整楼文本作为输入', () => {
  it('NAI + 4.5/V5 角色提示（默认方案）', async () => {
    settings.defaultBackend = 'nai';
    await fingerprint('nai-char-prompts', () =>
      buildAutoTagMessages(context(), 1, autoTag() as never, null),
    );
  });

  it('NAI + 非 4.5 模型（单串 tag 分支）', async () => {
    settings.defaultBackend = 'nai';
    const plan = settings.nai.plans[0];
    const savedModel = plan.model;
    plan.model = 'nai-diffusion-4-full';
    try {
      await fingerprint('nai-single-string', () =>
        buildAutoTagMessages(context(), 1, autoTag() as never, null),
      );
    } finally {
      plan.model = savedModel;
    }
  });

  it('ComfyUI + 关闭自然语言', async () => {
    settings.defaultBackend = 'comfyui';
    const preset = settings.comfyui.workflows[0];
    preset.naturalLanguage = false;
    await fingerprint('comfy-tags', () =>
      buildAutoTagMessages(context(), 1, autoTag() as never, null),
    );
  });

  it('用户自定义思维链（验证「柏宝绘改了就跟着变」）', async () => {
    settings.defaultBackend = 'nai';
    await fingerprint('nai-custom-thinking', () =>
      buildAutoTagMessages(
        context(),
        1,
        autoTag({ prompts: prompts({ naiV5Thinking: '我的自定义思维链' }) }) as never,
        null,
      ),
    );
  });
});
