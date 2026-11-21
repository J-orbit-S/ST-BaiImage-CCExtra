import { describe, expect, it } from 'vitest';

import { extractCharactersZh, extractTagZh, TAG_ZH_TASK_NOTE } from '@/autoTag/tagZh';

/**
 * 中文对照是「锦上添花」字段：任何解析失败都必须静默降级成空串，
 * 绝不能让一次成功的分析因为对照缺失而报错。这里钉住三条：
 * 1. 正常取得到、按 images 下标对齐；
 * 2. thinking / 代码块都剥得掉；
 * 3. 脏值、缺失、整段解析不了 → 空串，不抛错。
 */

describe('extractTagZh', () => {
  it('按 images 下标取出 tagZh，缺失的给空串', () => {
    const raw = JSON.stringify({
      images: [
        { position: 'P1', tag: 'a', tagZh: '甲' },
        { position: 'P2', tag: 'b' },
        { position: 'P3', tag: 'c', tagZh: '  丙  ' },
      ],
    });
    expect(extractTagZh(raw)).toEqual(['甲', '', '丙']);
  });

  it('剥掉 <thinking> 再解析', () => {
    const raw = '<thinking>先想想</thinking>\n{"images":[{"tag":"a","tagZh":"甲"}]}';
    expect(extractTagZh(raw)).toEqual(['甲']);
  });

  it('剥掉 markdown 代码块', () => {
    const raw = '```json\n{"images":[{"tag":"a","tagZh":"甲"}]}\n```';
    expect(extractTagZh(raw)).toEqual(['甲']);
  });

  it('没有 images 字段 / 完全不是 JSON → 空数组，不抛错', () => {
    expect(extractTagZh('{"changes":[]}')).toEqual([]);
    expect(extractTagZh('这不是 JSON')).toEqual([]);
    expect(extractTagZh('')).toEqual([]);
    expect(extractTagZh('{"images":"not-array"}')).toEqual([]);
  });

  it('tagZh 不是字符串（数字 / null）→ 空串', () => {
    const raw = JSON.stringify({ images: [{ tag: 'a', tagZh: 42 }, { tag: 'b', tagZh: null }] });
    expect(extractTagZh(raw)).toEqual(['', '']);
  });

  it('协议要求里写明：Base 与角色分项都翻、项数一一对应、tag 本身不改', () => {
    expect(TAG_ZH_TASK_NOTE).toContain('tagZh');
    expect(TAG_ZH_TASK_NOTE).toContain('charactersZh');
    expect(TAG_ZH_TASK_NOTE).toContain('等长');
    expect(TAG_ZH_TASK_NOTE).toContain('一个字都不要改');
  });
});

describe('extractCharactersZh', () => {
  it('按 images 下标取出每张图的分项对照，缺失的给空数组', () => {
    const raw = JSON.stringify({
      images: [
        { position: 'P1', tag: 'a', charactersZh: ['男孩，银发', '女孩，棕发'] },
        { position: 'P2', tag: 'b' },
        { position: 'P3', tag: 'c', charactersZh: [] },
      ],
    });
    expect(extractCharactersZh(raw)).toEqual([['男孩，银发', '女孩，棕发'], [], []]);
  });

  it('脏项（非字符串 / 纯空白）被丢掉，其余保留原下标相对顺序', () => {
    const raw = JSON.stringify({
      images: [{ tag: 'a', charactersZh: ['男孩，银发', 42, '   ', null, '女孩，棕发'] }],
    });
    expect(extractCharactersZh(raw)).toEqual([['男孩，银发', '女孩，棕发']]);
  });

  it('charactersZh 不是数组 / 整段解析不了 → 空数组，不抛错', () => {
    expect(extractCharactersZh(JSON.stringify({ images: [{ tag: 'a', charactersZh: '不是数组' }] }))).toEqual([[]]);
    expect(extractCharactersZh('这不是 JSON')).toEqual([]);
    expect(extractCharactersZh('')).toEqual([]);
    expect(extractCharactersZh('{"changes":[]}')).toEqual([]);
  });

  it('剥掉 <thinking> 与代码块后再解析', () => {
    const raw = '<thinking>想想</thinking>```json\n{"images":[{"charactersZh":["甲"]}]}\n```';
    expect(extractCharactersZh(raw)).toEqual([['甲']]);
  });
});
