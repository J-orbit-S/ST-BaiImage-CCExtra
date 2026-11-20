// STUB (M1) — 逐字照抄上游 src/state/charTags.ts 的类型与常量定义（行 16–27、40–41、86–92）。
// 这些是 protocol.ts / mossLayout.ts 编译所需的最小面；运行时函数 M2 Adapter 补。

export type CharTagField = 'fandom' | 'sex' | 'hair' | 'eyes' | 'skin' | 'body' | 'extra' | 'outfit';

export const CHAR_TAG_FIELDS: readonly CharTagField[] = [
  'fandom',
  'sex',
  'hair',
  'eyes',
  'skin',
  'body',
  'extra',
  'outfit',
];

export type CharTagSource = 'book' | 'manual' | 'ai';
export type CharTagHistoryField = CharTagField | 'new' | 'raw' | 'nl';

export interface CharTagChangeRecord {
  field: CharTagHistoryField;
  from: string;
  to: string;
  reason: string;
  floor: number;
  at: number;
}

export interface CharTagEntry {
  name: string;
  fields: Record<CharTagField, string>;
  raw: string;
  nl: string;
  source: CharTagSource;
  desc: string;
  history: CharTagChangeRecord[];
}

export const BBI_CHAR_EXTRA_KEY = 'bbiCharChanges';
