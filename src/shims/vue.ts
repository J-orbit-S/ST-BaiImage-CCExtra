/**
 * `vue` 的等价 shim —— 只为让上游文件能**一字不改**地被搬运过来。
 *
 * 上游 `state/charTags.ts` / `state/globalCharTags.ts` 只用到 `reactive`，
 * 用途是把两个缓存对象（charTagLib / charTagBaseNames / globalCharTagLib）包成响应式，
 * 好让柏宝绘的面板在数据变化时重渲染。
 *
 * CCExtra 没有任何 UI，只需要「同一个对象、读了能拿到最新值」，不需要依赖追踪与重渲染，
 * 因此直接返回原对象在语义上完全等价：写入后立即读取就能看到新值，这与 Vue 的 reactive 一致。
 *
 * ⚠ 边界：如果将来上游在这两个文件里用上 computed / watch / ref，
 * 这个 shim 就不够了，必须换成真 Vue（加依赖）——届时 tsc 会因为缺导出当场报错，
 * 不会静默出错，这是刻意保留的安全网。
 */
export function reactive<T extends object>(target: T): T {
  return target;
}
