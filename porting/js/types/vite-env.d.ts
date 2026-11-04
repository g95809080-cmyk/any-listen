/// <reference types="vite/client" />

/**
 * `?worker&url` / `?url` 等 vite 查询后缀的类型由 `vite/client` 提供。
 * 单独放一个文件是为了让 `tsconfig.json` 的 `include` 能显式命中它
 * （`vite/client` 的 ambient 声明必须被加载，否则 `import x from './a.ts?worker&url'` 会报 TS2307）。
 */
