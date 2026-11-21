import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CANDIDATES_KEY,
  addAnalysis,
  addCandidateVersion,
  addDraft,
  buildSegmentAnchor,
  countDrafts,
  countPending,
  discardCandidate,
  editCandidateTag,
  fillDraft,
  findCandidate,
  listCandidates,
  makeSegmentId,
  makePlanId,
  normalizeStore,
  onCandidatesChange,
} from '@/state/candidates';
import { buildCapture, type SelectionCapture } from '@/selection/capture';
import type { ImageInsertion } from '@/autoTag/protocol';

/**
 * 候选池是整个确认式的底座。它坏了的表现很难查：
 * 卡片「确认了但没反应」、「刷新之后候选全没了」、「A 聊的候选跑到 B 聊」。
 * 所以这里只测三件事：**存得住、认得出、不串味**。
 */

type AnyRecord = Record<string, unknown>;

let chatId = 'chat-1';
let metadata: AnyRecord = {};
let saves = 0;

function install(): void {
  metadata = {};
  saves = 0;
  vi.stubGlobal('window', {
    SillyTavern: {
      getContext: () => ({
        chatMetadata: metadata,
        getCurrentChatId: () => chatId,
        saveMetadataDebounced: () => {
          saves += 1;
        },
      }),
    },
  });
}

function capture(text: string, raw: string, floor = 1): SelectionCapture {
  const start = raw.indexOf(text);
  if (start < 0) throw new Error(`needle not found: ${text}`);
  const outcome = buildCapture({
    raw,
    messageId: floor,
    swipeId: 0,
    domText: text,
    located: { start, end: start + text.length, method: 'strict', candidates: 1 },
  });
  if (!outcome.ok) throw new Error(`capture failed: ${outcome.reason}`);
  return outcome.capture;
}

const MES = ['走廊很安静。', '她推开门，灯闪了一下。', '“你回来了。”'].join('\n');
const SELECTED = '她推开门，灯闪了一下。';

function image(tag: string, sourceLine = 0): ImageInsertion {
  return {
    position: 'P1',
    sourceLine,
    tag,
    nl: '',
    negative: '',
    characters: [],
    size: 'portrait',
  };
}

/** 造一条输入：一段 = 一个锚点，图按传入顺序编号。 */
function input(tags: string[], opts: { floor?: number; changes?: boolean } = {}) {
  const anchor = buildSegmentAnchor(chatId, capture(SELECTED, MES, opts.floor ?? 1), MES);
  return {
    chatId,
    floor: opts.floor ?? 1,
    swipeId: 0,
    segments: [anchor],
    images: tags.map((tag, index) => image(tag, index)),
    changes:
      opts.changes === false
        ? []
        : [{ name: '小雪', field: 'new' as const, value: '1girl', position: 'P1', sourceLine: 0, reason: '首次出场' }],
  };
}

beforeEach(() => {
  chatId = 'chat-1';
  install();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('normalizeStore', () => {
  it('不是对象 / 没有 items 都回落到空池，而不是抛错', () => {
    for (const dirty of [undefined, null, 'x', 42, [], { v: 1 }]) {
      expect(normalizeStore(dirty)).toEqual({ v: 1, items: [] });
    }
  });

  it('坏数据只丢那一条，其余照留（用户刚写完 4 段，不能因一条损坏全丢）', () => {
    const good = {
      imageId: 'a:0',
      planId: 'a',
      chatId: 'chat-1',
      floor: 1,
      swipeId: 0,
      segments: [{ segmentId: 's1', text: 'x', before: '', after: '', startLine: 0, endLine: 0 }],
      index: 0,
      versions: [{ image: image('1girl'), changes: [], createdAt: 1 }],
      activeVersion: 0,
      status: 'pending',
      createdAt: 1,
      updatedAt: 1,
    };
    const store = normalizeStore({
      v: 1,
      items: [
        good,
        { ...good, imageId: 'b:0', versions: [] }, // 没版本 = 坏
        { ...good, imageId: 'c:0', segments: [] }, // 没锚点 = 坏
        'not-an-object',
      ],
    });
    expect(store.items.map(item => item.imageId)).toEqual(['a:0']);
  });

  it('activeVersion 越界时夹回最后一版（别让卡片指向不存在的版本）', () => {
    const store = normalizeStore({
      v: 1,
      items: [
        {
          imageId: 'a:0',
          planId: 'a',
          chatId: 'chat-1',
          floor: 1,
          swipeId: 0,
          segments: [{ segmentId: 's1', text: 'x' }],
          versions: [{ image: image('1girl') }],
          activeVersion: 9,
        },
      ],
    });
    expect(store.items[0].activeVersion).toBe(0);
    expect(store.items[0].status).toBe('pending');
  });
});

describe('段落 ID 与锚点', () => {
  it('同样的输入给同样的 ID（重 Roll 不换 ID 才挂得住多版候选）', () => {
    const a = makeSegmentId({ chatId: 'c', floor: 1, swipeId: 0, text: '同一句', occurrence: 0 });
    const b = makeSegmentId({ chatId: 'c', floor: 1, swipeId: 0, text: '同一句', occurrence: 0 });
    const c = makeSegmentId({ chatId: 'c', floor: 1, swipeId: 0, text: '同一句', occurrence: 1 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('同一楼里重复出现的句子按出现次序区分', () => {
    const raw = ['她笑了。', '中间一句。', '她笑了。'].join('\n');
    const first = buildSegmentAnchor('c', capture('她笑了。', raw), raw);
    // 划第二处：手工把 range 挪到后面那句
    const secondStart = raw.lastIndexOf('她笑了。');
    const outcome = buildCapture({
      raw,
      messageId: 1,
      swipeId: 0,
      domText: '她笑了。',
      located: { start: secondStart, end: secondStart + 4, method: 'strict', candidates: 2 },
    });
    if (!outcome.ok) throw new Error('capture failed');
    const second = buildSegmentAnchor('c', outcome.capture, raw);
    expect(first.segmentId).not.toBe(second.segmentId);
    expect(second.startLine).toBe(2);
  });

  it('锚点带上前后文与行号（确认时靠它重定位，不只靠行号）', () => {
    const anchor = buildSegmentAnchor('c', capture(SELECTED, MES), MES);
    expect(anchor.text).toBe(SELECTED);
    expect(anchor.before).toBe('走廊很安静。\n');
    expect(anchor.after).toContain('“你回来了。”');
    expect(anchor.startLine).toBe(1);
    expect(anchor.endLine).toBe(1);
  });
});

describe('addAnalysis / 候选池', () => {
  it('一张图一条候选，整个 plan 只有第一条带 changes（避免确认两张时建档做两遍）', () => {
    const added = addAnalysis(input(['1girl, tag-a', '1girl, tag-b']));
    expect(added).toBe(2);

    const items = listCandidates();
    expect(items).toHaveLength(2);
    expect(items.map(item => item.index)).toEqual([0, 1]);
    expect(items[0].versions[0].changes).toHaveLength(1);
    expect(items[1].versions[0].changes).toHaveLength(0);
    expect(saves).toBe(1);
    expect(metadata[CANDIDATES_KEY]).toBeTruthy();
  });

  it('对同一段再分析一次：追加版本，而不是新增卡片', () => {
    addAnalysis(input(['1girl, tag-a']));
    addAnalysis(input(['1girl, tag-a-v2']));

    const items = listCandidates();
    expect(items).toHaveLength(1);
    expect(items[0].versions).toHaveLength(2);
    expect(items[0].activeVersion).toBe(1);
    expect(items[0].versions[1].image.tag).toBe('1girl, tag-a-v2');
  });

  it('删掉之后再分析同一段：重新出现一条干净候选（不带上一版的旧版本）', () => {
    addAnalysis(input(['1girl, tag-a']));
    const first = listCandidates()[0];
    addCandidateVersion(first.imageId, image('1girl, tag-a-v2'));
    // 模拟已确认：移出池子
    discardCandidate(first.imageId);

    addAnalysis(input(['1girl, tag-a-v3']));
    const items = listCandidates();
    expect(items).toHaveLength(1);
    // ID 可以复用：旧条目已经不在池子里了，不存在「两条候选抢同一个 ID」
    expect(items[0].versions).toHaveLength(1);
    expect(items[0].versions[0].image.tag).toBe('1girl, tag-a-v3');
  });

  it('不同楼层排序按剧情顺序（面板从上往下读得通）', () => {
    addAnalysis(input(['floor-2'], { floor: 2 }));
    addAnalysis(input(['floor-1'], { floor: 1 }));
    expect(listCandidates().map(item => item.floor)).toEqual([1, 2]);
    expect(listCandidates({ floor: 2 })).toHaveLength(1);
  });

  it('换聊天看不到上一个聊天的候选（不串味）', () => {
    addAnalysis(input(['1girl, tag-a']));
    expect(countPending()).toBe(1);

    chatId = 'chat-2';
    expect(countPending()).toBe(0);
    expect(listCandidates()).toEqual([]);

    chatId = 'chat-1';
    expect(countPending()).toBe(1);
  });

  it('planId 只看「哪一楼的哪几段」，与图内容无关', () => {
    const a = input(['1girl, tag-a']);
    const b = input(['1girl, tag-b']);
    expect(makePlanId(a)).toBe(makePlanId(b));
  });
});

describe('编辑 / 重 Roll / 删除', () => {
  it('编辑只改当前版本的 tag，不动版本数', () => {
    addAnalysis(input(['1girl, tag-a']));
    const item = listCandidates()[0];
    expect(editCandidateTag(item.imageId, ' 1girl, edited ')).toBe(true);

    const next = findCandidate(item.imageId);
    expect(next?.versions).toHaveLength(1);
    expect(next?.versions[0].image.tag).toBe('1girl, edited');
  });

  it('空 tag 不接受（否则会写出一个没内容的卡片）', () => {
    addAnalysis(input(['1girl, tag-a']));
    const item = listCandidates()[0];
    expect(editCandidateTag(item.imageId, '   ')).toBe(false);
    expect(findCandidate(item.imageId)?.versions[0].image.tag).toBe('1girl, tag-a');
  });

  it('重 Roll 追加一版并切到最新', () => {
    addAnalysis(input(['1girl, tag-a']));
    const item = listCandidates()[0];
    expect(addCandidateVersion(item.imageId, image('1girl, rolled'))).toBe(1);

    const next = findCandidate(item.imageId);
    expect(next?.versions.map(version => version.image.tag)).toEqual(['1girl, tag-a', '1girl, rolled']);
    expect(next?.activeVersion).toBe(1);
  });

  it('删除后就查不到了，且不会再出现在待确认列表里', () => {
    addAnalysis(input(['1girl, tag-a']));
    const item = listCandidates()[0];
    expect(discardCandidate(item.imageId)).toBe(true);
    expect(findCandidate(item.imageId)).toBeNull();
    expect(listCandidates()).toEqual([]);
    // 幂等：再删一次只是 false，不抛错
    expect(discardCandidate(item.imageId)).toBe(false);
  });

  it('池子一变就通知订阅者（面板靠它重绘）', () => {
    let calls = 0;
    const off = onCandidatesChange(() => {
      calls += 1;
    });
    addAnalysis(input(['1girl, tag-a']));
    expect(calls).toBe(1);
    off();
    addAnalysis(input(['1girl, tag-b']));
    expect(calls).toBe(1);
  });

  it('宿主没有 chatMetadata 时不抛错，只是这次没记住', () => {
    vi.stubGlobal('window', { SillyTavern: { getContext: () => ({ getCurrentChatId: () => 'c' }) } });
    expect(() => addAnalysis(input(['1girl, tag-a']))).not.toThrow();
    expect(listCandidates()).toEqual([]);
  });
});

describe('待生成（draft）', () => {
  function draftInput(text = SELECTED, floor = 1) {
    const anchor = buildSegmentAnchor(chatId, capture(text, MES, floor), MES);
    return { chatId, floor, swipeId: 0, segment: anchor };
  }

  it('加入待生成：只记选段，没有版本、状态是 draft', () => {
    const added = addDraft(draftInput());
    expect(added.created).toBe(true);
    expect(countDrafts()).toBe(1);
    expect(countPending()).toBe(0);

    const item = listCandidates({ status: 'draft' })[0];
    expect(item.status).toBe('draft');
    expect(item.versions).toHaveLength(0);
    expect(item.segments[0].text).toBe(SELECTED);
  });

  it('重复加入同一段是幂等的：同 ID，不新建', () => {
    const first = addDraft(draftInput());
    const second = addDraft(draftInput());
    expect(second.created).toBe(false);
    expect(second.imageId).toBe(first.imageId);
    expect(countDrafts()).toBe(1);
  });

  it('同一段已经有候选（pending）时也不新建：报「已经在候选里」', () => {
    addAnalysis(input(['1girl, tag-a']));
    const added = addDraft(draftInput());
    expect(added.created).toBe(false);
    expect(added.existingStatus).toBe('pending');
    expect(countDrafts()).toBe(0);
  });

  it('fillDraft：原地填上版本并翻成 pending（面板不闪、不重排）', () => {
    const added = addDraft(draftInput());
    expect(fillDraft(added.imageId, [{ image: image('1girl, from-draft'), changes: [], tagZh: '少女，草稿', createdAt: 1 }])).toBe(true);

    const item = findCandidate(added.imageId);
    expect(item?.status).toBe('pending');
    expect(item?.versions[0].image.tag).toBe('1girl, from-draft');
    expect(item?.versions[0].tagZh).toBe('少女，草稿');
    expect(countDrafts()).toBe(0);
    expect(countPending()).toBe(1);
    // 同一条记录：ID 没变
    expect(listCandidates()[0].imageId).toBe(added.imageId);
  });

  it('fillDraft 给 pending（非 draft）条目返回 false：不覆盖已有候选', () => {
    addAnalysis(input(['1girl, tag-a']));
    const item = listCandidates()[0];
    expect(fillDraft(item.imageId, [{ image: image('x'), changes: [], createdAt: 1 }])).toBe(false);
    expect(findCandidate(item.imageId)?.versions[0].image.tag).toBe('1girl, tag-a');
  });

  it('addAnalysis 命中 draft：原地补版本，不多出一条重复卡片', () => {
    const added = addDraft(draftInput());
    const before = listCandidates({ status: 'draft' }).length;
    addAnalysis(input(['1girl, tag-a']));
    expect(listCandidates()).toHaveLength(before);
    const item = findCandidate(added.imageId);
    expect(item?.status).toBe('pending');
    expect(item?.versions[0].image.tag).toBe('1girl, tag-a');
  });

  it('tagZh 跟着 addAnalysis 进池子，按张对号', () => {
    addAnalysis({ ...input(['tag-a', 'tag-b']), tagZh: ['中文甲', '中文乙'] });
    const items = listCandidates();
    expect(items[0].versions[0].tagZh).toBe('中文甲');
    expect(items[1].versions[0].tagZh).toBe('中文乙');
  });

  it('tagZh 缺项 / 空串：版本上不挂这个字段', () => {
    addAnalysis({ ...input(['tag-a']), tagZh: ['  '] });
    const item = listCandidates()[0];
    expect(item.versions[0].tagZh).toBeUndefined();
  });

  it('编辑英文后中文对照一起失效（错的对照比没有更糟）', () => {
    addAnalysis({ ...input(['1girl, tag-a']), tagZh: ['中文甲'] });
    const item = listCandidates()[0];
    editCandidateTag(item.imageId, '1girl, edited');
    expect(findCandidate(item.imageId)?.versions[0].tagZh).toBeUndefined();
  });

  it('charactersZh 跟着 addAnalysis 进池子，按张对号', () => {
    addAnalysis({ ...input(['tag-a', 'tag-b']), charactersZh: [['男孩，银发'], ['女孩，棕发']] });
    const items = listCandidates();
    expect(items[0].versions[0].charactersZh).toEqual(['男孩，银发']);
    expect(items[1].versions[0].charactersZh).toEqual(['女孩，棕发']);
  });

  it('charactersZh 空数组 / 全空白项：版本上不挂这个字段', () => {
    addAnalysis({ ...input(['tag-a']), charactersZh: [['  ']] });
    expect(listCandidates()[0].versions[0].charactersZh).toBeUndefined();
  });

  it('编辑 Base 不清 charactersZh：角色分项没被手改，对照仍然有效', () => {
    addAnalysis({
      ...input(['1girl, tag-a']),
      tagZh: ['中文甲'],
      charactersZh: [['男孩，银发']],
    });
    const item = listCandidates()[0];
    editCandidateTag(item.imageId, '1girl, edited');
    const version = findCandidate(item.imageId)?.versions[0];
    expect(version?.tagZh).toBeUndefined();
    expect(version?.charactersZh).toEqual(['男孩，银发']);
  });

  it('addCandidateVersion：charactersZh 挂在最新版本上', () => {
    addAnalysis({ ...input(['1girl, tag-a']) });
    const item = listCandidates()[0];
    addCandidateVersion(item.imageId, image('1girl, v2'), '中文二', ['男孩，黑发']);
    const version = findCandidate(item.imageId)?.versions[1];
    expect(version?.tagZh).toBe('中文二');
    expect(version?.charactersZh).toEqual(['男孩，黑发']);
  });

  it('归一化：charactersZh 里的非字符串 / 空白项被滤掉，全空则不挂字段', () => {
    const base = {
      imageId: 'z:0',
      planId: 'z',
      chatId: 'chat-1',
      floor: 1,
      swipeId: 0,
      segments: [{ segmentId: 's1', text: 'x', before: '', after: '', startLine: 0, endLine: 0 }],
      index: 0,
      versions: [
        {
          image: { position: 'P1', sourceLine: 0, tag: 'tag-a', nl: '', negative: '', characters: [], size: 'portrait' },
          changes: [],
          charactersZh: ['男孩，银发', 42, '   '],
          createdAt: 1,
        },
      ],
      activeVersion: 0,
      status: 'pending',
      createdAt: 1,
      updatedAt: 1,
    };
    const kept = normalizeStore({ v: 1, items: [base] });
    expect(kept.items[0].versions[0].charactersZh).toEqual(['男孩，银发']);
    const empty = normalizeStore({
      v: 1,
      items: [{ ...base, versions: [{ ...base.versions[0], charactersZh: [42, null] }] }],
    });
    expect(empty.items[0].versions[0].charactersZh).toBeUndefined();
  });

  it('归一化双向收敛：draft 没版本要留、draft 有版本要翻回 pending', () => {
    const base = {
      imageId: 'a:0',
      planId: 'a',
      chatId: 'chat-1',
      floor: 1,
      swipeId: 0,
      segments: [{ segmentId: 's1', text: 'x', before: '', after: '', startLine: 0, endLine: 0 }],
      index: 0,
      activeVersion: -1,
      createdAt: 1,
      updatedAt: 1,
    };
    const kept = normalizeStore({ v: 1, items: [{ ...base, versions: [], status: 'draft' }] });
    expect(kept.items).toHaveLength(1);
    expect(kept.items[0].status).toBe('draft');
    expect(kept.items[0].activeVersion).toBe(-1);

    const converged = normalizeStore({ v: 1, items: [{ ...base, versions: [{ image: image('1girl'), changes: [], createdAt: 1 }], status: 'draft' }] });
    expect(converged.items[0].status).toBe('pending');
    expect(converged.items[0].activeVersion).toBe(0);

    // 非 draft 且没版本：仍然丢掉（确认按钮会读到 undefined）
    expect(normalizeStore({ v: 1, items: [{ ...base, versions: [], status: 'pending' }] }).items).toHaveLength(0);
  });

  it('countDrafts / listCandidates({ status }) 把两个区域分开数', () => {
    addDraft(draftInput());
    addDraft(draftInput('走廊很安静。'));
    // 同一段的分析会把对应 draft 原地转 pending（见上一条），所以 draft 剩 1
    addAnalysis(input(['1girl, tag-a']));
    expect(countDrafts()).toBe(1);
    expect(countPending()).toBe(1);
    expect(listCandidates({ status: 'draft' })).toHaveLength(1);
    expect(listCandidates({ status: 'pending' })).toHaveLength(1);
  });
});
