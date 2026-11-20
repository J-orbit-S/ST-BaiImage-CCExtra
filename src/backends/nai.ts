// VENDORED (逐字照抄上游 src/backends/nai.ts 的三个纯判定函数；M1 只搬判定，不搬出图逻辑)
// 来源行号：isNai5 = 124-126, isNai45 = 166-168, naiSupportsCharacterPrompts = 180-182

export function isNai5(model: string): boolean {
  return model.includes('nai-diffusion-5');
}

export function isNai45(model: string): boolean {
  return model.includes('nai-diffusion-4-5');
}

export function naiSupportsCharacterPrompts(model: string): boolean {
  return isNai45(model) || isNai5(model);
}
