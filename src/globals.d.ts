declare global {
  /** 构建时由 vite define 注入（见 vite.config.ts 的 `define`）。测试环境不存在。 */
  const __CCX_VERSION__: string;
}

export {};
