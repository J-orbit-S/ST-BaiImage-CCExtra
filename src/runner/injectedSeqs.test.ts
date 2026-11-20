/**
 * 「新 tag 落在第几个槽位」的自测。
 *
 * 这个数一旦算错，自动出图就会去点别人的卡片：那张卡可能已经有图（点一下只弹个提示），
 * 而真正该出的那张一直停在待生成——用户在真机上看到的是「有时出图、有时不出」，
 * 极难归因。所以这里全部用**真实的注入函数**构造正文，不手搓字符串：
 * 测的是「与 `injectImageTags` 的插入规则是否一致」，而不是我脑子里的一致性。
 */

import { describe, expect, it } from 'vitest';
import { injectImageTags, type ImageInsertion } from '@/autoTag/protocol';
import { resolveInjectedSeqs } from '@/runner/plan';

function image(over: Partial<ImageInsertion> = {}): ImageInsertion {
  return {
    position: 'P1',
    sourceLine: 0,
    tag: '1girl, doorway',
    nl: '',
    negative: '',
    characters: [],
    size: 'portrait',
    ...over,
  } as ImageInsertion;
}

/** 用真实注入规则生成正文，再算序号。 */
function seqsOf(text: string, images: ImageInsertion[]): number[] {
  return resolveInjectedSeqs(injectImageTags(text, images), images);
}

describe('resolveInjectedSeqs', () => {
  it('没有插入时返回空数组', () => {
    expect(resolveInjectedSeqs('第一段\n第二段', [])).toEqual([]);
  });

  it('正文里没有 tag 时，第一条就是第 0 个槽位', () => {
    expect(seqsOf('她推开门。', [image({ sourceLine: 0 })])).toEqual([0]);
  });

  it('插在已有 tag 之后时序号是 1', () => {
    const text = '她推开门。\n<bbi_image>1girl, doorway<size>portrait</size></bbi_image>\n她坐下。';
    // 在第 0 行之后插，新 tag 落在旧 tag 前面 → 它自己是 0，旧 tag 被挤到 1
    expect(seqsOf(text, [image({ sourceLine: 0 })])).toEqual([0]);
    // 在第 1 行（旧 tag 所在行）之后插 → 旧 tag 仍是 0，新的排 1
    expect(seqsOf(text, [image({ sourceLine: 1 })])).toEqual([1]);
  });

  it('同一条划线插两条：按行内顺序排成连续两个槽位', () => {
    const images = [image({ sourceLine: 0 }), image({ sourceLine: 0, position: 'P2' })];
    expect(seqsOf('她推开门。', images)).toEqual([0, 1]);
  });

  it('两条划线各插一条：序号按行号升序推进', () => {
    const images = [image({ sourceLine: 1 }), image({ sourceLine: 0 })];
    // 注入函数按行号处理，与入参数组顺序无关；输出顺序跟注入顺序一致
    expect(seqsOf('第一行\n第二行', images)).toEqual([1, 0]);
  });

  it('旧 tag 与新 tag 文本完全相同时不会配反', () => {
    // 对同一段划两次线 → 两条 tag 一字不差。靠行号分辨，不靠文本配对。
    const same = '1girl, doorway';
    const text = `她推开门。\n<bbi_image>${same}<size>portrait</size></bbi_image>\n她坐下。`;
    const before = seqsOf(text, [image({ sourceLine: 0, tag: same })]);
    expect(before).toEqual([0]);
    const after = seqsOf(text, [image({ sourceLine: 1, tag: same })]);
    expect(after).toEqual([1]);
  });

  it('一行里本来写了两个 tag 时序号算得对', () => {
    const line = '<bbi_image>a</bbi_image><bbi_image>b</bbi_image>';
    expect(seqsOf(`正文\n${line}`, [image({ sourceLine: 1 })])).toEqual([2]);
  });

  it('CRLF 正文与末尾无换行都能算对', () => {
    const images = [image({ sourceLine: 0 })];
    expect(seqsOf('第一行\r\n第二行', images)).toEqual([0]);
    expect(seqsOf('第一行', images)).toEqual([0]);
  });

  it('行号越过正文时整批放弃，不猜位置', () => {
    // 模拟「注入规则变了、行号推算对不上」：落点那行没有 tag
    expect(resolveInjectedSeqs('第一行\n第二行\n第三行', [image({ sourceLine: 0 })])).toEqual([]);
  });
});
