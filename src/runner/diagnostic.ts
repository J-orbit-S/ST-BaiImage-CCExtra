/**
 * 诊断探针（工程方案 §9.1）。
 *
 * 上游 runner 有一整套 `[BBI][AutoTagDebug] <event> <json>` 日志，线上排错全靠它。
 * CCExtra 的编排与它同构，所以保留**同样的 event 名**，只换前缀 —— 这样两边可以
 * 把日志并排贴出来对拍：同名 event 出现、而某一边数值不同，问题就锁在那一段。
 *
 * 前缀用 `[CCX]`：控制台过滤框里敲四个字符就能只看本插件。
 */
const DIAGNOSTIC_PREFIX = '[CCX][AutoTagDebug]';

export function diagnostic(event: string, payload: unknown = null): void {
  const seen = new WeakSet<object>();
  let detail: string;
  try {
    const json = JSON.stringify(payload, (_key, value: unknown) => {
      if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
      if (typeof value === 'bigint') return String(value);
      if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
      if (value && typeof value === 'object') {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      return value;
    });
    detail = json ?? String(payload);
  } catch (error) {
    detail = JSON.stringify({ stringifyError: error instanceof Error ? error.message : String(error) });
  }
  console.info(`${DIAGNOSTIC_PREFIX} ${event} ${detail}`);
}
