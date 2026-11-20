import { describe, expect, it } from 'vitest';
import type { STContext } from '@/st/context';
import { captureSelection, describeCapture, formatCaptureFailure } from '@/selection/capture';

/**
 * 极简假 DOM：只用得到 nodeType / parentElement / getAttribute / contains /
 * querySelector / closest 六个能力。手写而不是引入 jsdom，是因为真正想验的只有
 * 「楼层归属判定」和「失败路径」，不需要真实渲染与布局。
 */
interface FakeEl {
  nodeType: number;
  parentElement: FakeEl | null;
  attrs: Record<string, string>;
  mesText: FakeEl | null;
  getAttribute(name: string): string | null;
  contains(other: unknown): boolean;
  querySelector(selector: string): FakeEl | null;
  closest(selector: string): FakeEl | null;
}

function makeEl(className: string, attrs: Record<string, string> = {}, parent: FakeEl | null = null): FakeEl {
  const node = {
    nodeType: 1,
    parentElement: parent,
    attrs: { class: className, ...attrs },
    mesText: null as FakeEl | null,
  } as unknown as FakeEl;
  node.getAttribute = (name: string) => (name in node.attrs ? node.attrs[name] : null);
  node.contains = (other: unknown) => {
    let cursor = other as FakeEl | null;
    while (cursor) {
      if (cursor === node) return true;
      cursor = cursor.parentElement;
    }
    return false;
  };
  node.querySelector = (selector: string) =>
    selector === '.mes_text' || selector === '.mes_block' ? node.mesText : null;
  node.closest = (selector: string) => {
    let cursor: FakeEl | null = node;
    while (cursor) {
      const classes = String(cursor.attrs.class ?? '').split(/\s+/);
      if (selector.startsWith('.') && classes.includes(selector.slice(1))) return cursor;
      cursor = cursor.parentElement;
    }
    return null;
  };
  return node;
}

/** 造一层楼：返回 { mes, text, 里层文本节点 } */
function makeMessage(mesid: number) {
  const mes = makeEl('mes', { mesid: String(mesid) });
  const block = makeEl('mes_block', {}, mes);
  const text = makeEl('mes_text', {}, block);
  mes.mesText = text;
  const textNode = { nodeType: 3, parentElement: text, data: '' } as unknown as FakeEl;
  return { mes, text, textNode };
}

interface FakeRangeSpec {
  startContainer: FakeEl;
  startOffset?: number;
  endContainer?: FakeEl;
  endOffset?: number;
  text: string;
  /** doc.createRange() 的 toString：setEnd 后返回 before，setStart 后返回 after */
  before?: string;
  after?: string;
}

function makeWindow(spec: FakeRangeSpec | null, collapsed = false) {
  const doc = {
    body: makeEl('body'),
    createRange() {
      let mode: 'none' | 'end' | 'start' = 'none';
      return {
        selectNodeContents() {},
        setEnd() {
          mode = 'end';
        },
        setStart() {
          mode = 'start';
        },
        toString() {
          if (mode === 'end') return spec?.before ?? '';
          if (mode === 'start') return spec?.after ?? '';
          return '';
        },
      };
    },
  };
  const selection =
    spec === null
      ? null
      : {
          rangeCount: 1,
          isCollapsed: collapsed,
          getRangeAt: () => ({
            startContainer: spec.startContainer,
            startOffset: spec.startOffset ?? 0,
            endContainer: spec.endContainer ?? spec.startContainer,
            endOffset: spec.endOffset ?? 0,
            toString: () => spec.text,
          }),
        };
  return {
    document: doc,
    getSelection: () => selection,
  } as unknown as Window;
}

function makeContext(messages: Array<{ mes: string; swipe_id?: number }>): STContext {
  return {
    chat: messages.map(m => ({
      name: '角色',
      is_user: false,
      is_system: false,
      mes: m.mes,
      swipe_id: m.swipe_id,
    })),
  } as unknown as STContext;
}

describe('captureSelection — 失败路径', () => {
  it('没有选区', () => {
    const outcome = captureSelection({ win: makeWindow(null), context: makeContext([]) });
    expect(outcome).toMatchObject({ ok: false, reason: 'no-selection' });
  });

  it('选区已折叠（只是点了一下）', () => {
    const { textNode } = makeMessage(0);
    const win = makeWindow({ startContainer: textNode, text: '' }, true);
    const outcome = captureSelection({ win, context: makeContext([{ mes: '正文' }]) });
    expect(outcome).toMatchObject({ ok: false, reason: 'no-selection' });
  });

  it('选区跨了两层楼 → cross-message，不合并', () => {
    const a = makeMessage(0);
    const b = makeMessage(1);
    const win = makeWindow({
      startContainer: a.textNode,
      endContainer: b.textNode,
      text: '跨楼的一段文字',
    });
    const outcome = captureSelection({ win, context: makeContext([{ mes: '甲' }, { mes: '乙' }]) });
    expect(outcome).toMatchObject({ ok: false, reason: 'cross-message' });
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.detail).toContain('#0');
    expect(outcome.detail).toContain('#1');
  });

  it('选区不在任何楼层里（比如划到了侧栏）', () => {
    const loose = { nodeType: 3, parentElement: makeEl('sidebar') } as unknown as FakeEl;
    const win = makeWindow({ startContainer: loose, text: '侧栏文字' });
    const outcome = captureSelection({ win, context: makeContext([{ mes: '正文' }]) });
    expect(outcome).toMatchObject({ ok: false, reason: 'not-in-message' });
  });

  it('太短的选区在前置闸门就被拦下（不做全楼搜索）', () => {
    const { textNode } = makeMessage(0);
    const win = makeWindow({ startContainer: textNode, text: '他' });
    const outcome = captureSelection({ win, context: makeContext([{ mes: '他笑了。' }]) });
    expect(outcome).toMatchObject({ ok: false, reason: 'too-short' });
  });

  it('楼层数据缺失（刚切了聊天 / 该楼已删）', () => {
    const { textNode } = makeMessage(3);
    const win = makeWindow({ startContainer: textNode, text: '他笑了。' });
    const outcome = captureSelection({ win, context: makeContext([]) });
    expect(outcome).toMatchObject({ ok: false, reason: 'message-not-found' });
  });

  it('原文里找不到选区文字', () => {
    const { textNode } = makeMessage(0);
    const win = makeWindow({ startContainer: textNode, text: '完全没有出现过的句子' });
    const outcome = captureSelection({ win, context: makeContext([{ mes: '他笑了。' }]) });
    expect(outcome).toMatchObject({ ok: false, reason: 'not-found' });
  });
});

describe('captureSelection — 成功路径', () => {
  it('单楼选区映射回原文区间，并带上楼层/swipe/指纹', () => {
    const mes = '第一段。\n第二段内容。';
    const { textNode } = makeMessage(2);
    const win = makeWindow({ startContainer: textNode, text: '第二段内容。' });
    const outcome = captureSelection({ win, context: makeContext([{ mes: '', swipe_id: 0 }, { mes: '', swipe_id: 0 }, { mes, swipe_id: 4 }]) });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.capture.messageId).toBe(2);
    expect(outcome.capture.swipeId).toBe(4);
    expect(outcome.capture.text).toBe('第二段内容。');
    expect(outcome.capture.range).toEqual({ start: 5, end: 11 });
    expect(describeCapture(outcome.capture)).toContain('[CCX][Selection] msg#2 swipe4');
  });

  it('重复句靠选区前文选中正确那一处', () => {
    const mes = '他笑了。\n她也笑了。\n他笑了。';
    const { textNode } = makeMessage(0);
    const win = makeWindow({
      startContainer: textNode,
      text: '他笑了。',
      before: '他笑了。\n她也笑了。\n',
    });
    const outcome = captureSelection({ win, context: makeContext([{ mes }]) });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.capture.range.start).toBe(mes.lastIndexOf('他笑了。'));
    expect(outcome.capture.method).toBe('strict');
    expect(outcome.capture.candidates).toBe(2);
  });

  it('前半句被划中时自动扩到整行', () => {
    const mes = '他站在门外，雨很大。';
    const { textNode } = makeMessage(0);
    const win = makeWindow({ startContainer: textNode, text: '他站在门外' });
    const outcome = captureSelection({ win, context: makeContext([{ mes }]) });
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.capture.text).toBe(mes);
    expect(outcome.capture.expanded).toBe(true);
    expect(outcome.capture.lineCount).toBe(1);
  });
});

describe('失败文案', () => {
  it('每种失败原因都有中文提示，且提示出现在 UI 上不自相矛盾', () => {
    expect(formatCaptureFailure('ambiguous')).toContain('多次');
    expect(formatCaptureFailure('cross-message')).toContain('楼层');
    expect(formatCaptureFailure('not-found')).toContain('定位');
  });
});
