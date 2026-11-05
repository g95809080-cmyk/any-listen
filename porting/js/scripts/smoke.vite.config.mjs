/**
 * 冒烟测试的构建配置。
 *
 * 用与 `vite.config.mjs` **同一套** alias / 覆写插件（直接 import 复用，不复制），
 * 只把入口换成 `scripts/smoke-entry.ts`，产出一个 Node 可以直接 import 的 ESM bundle。
 * 这样冒烟验证的就是"真的会被 WebView 加载的那份代码"。
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'

import baseConfig from '../vite.config.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

export default defineConfig({
  ...baseConfig,
  // 冒烟只需要 alias 插件，不需要 html/worker 相关行为
  plugins: baseConfig.plugins,
  worker: undefined,
  publicDir: false,
  build: {
    target: 'esnext',
    // 不写进 dist：Gradle 会把 dist 根拍平拷进 APK。虽然 syncWebAssets 已排除
    // smoke/**，但产物仍会触发「dist 根出现意外条目」告警，且容易在规则变动时误打包。
    // 放到已经被 gitignore 的 node_modules 缓存目录，构建产物与交付目录彻底分离。
    outDir: path.join(ROOT, 'node_modules/.cache/anylisten-smoke'),
    emptyOutDir: false,
    minify: false,
    sourcemap: false,
    reportCompressedSize: false,
    ssr: true,
    rollupOptions: {
      input: { smoke: path.join(ROOT, 'scripts/smoke-entry.ts') },
      output: {
        format: 'es',
        entryFileNames: '[name].mjs',
        inlineDynamicImports: true,
      },
      // Node 内置模块交给运行时；shims 里的 `node:*` 已被插件换成纯 JS 实现
      external: [/^node:/],
    },
  },
})
