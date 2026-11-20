/**
 * 正文指纹：FNV-1a 32 位 + 长度。
 *
 * 用途只有一个——判断「捕获划线时的那份正文」与「现在要写回的那份正文」是不是同一份。
 * 因此不需要密码学强度，只需要够快、同步、在浏览器里无需 async（crypto.subtle 是异步的，
 * 而捕获必须发生在鼠标抬起的那一刻，选区随时可能被浏览器清掉）。
 *
 * 附上长度是为了压掉 FNV 的冲突概率：同长度同哈希基本可以认定同文本。
 */
export function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(16).padStart(8, '0')}${text.length.toString(16).padStart(6, '0')}`;
}
