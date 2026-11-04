/**
 * `@any-listen/extension-preload` 的 Android 构建。
 *
 * 这个包是**插件沙箱里的 preload 脚本**：它被拼成字符串注入到 QuickJS 上下文里执行，
 * 因此必须是 **IIFE**（不能有 `import`/`export`，沙箱里没有模块系统）。
 * 上游 `shared/extension-preload/vite.config.ts` 用的是 rolldown 的写法，这里用普通 rollup 配置对齐。
 *
 * 产物：`dist/extension-preload/extension-preload.js`
 * Kotlin 侧把它作为 asset 打进 APK，运行时读成字符串交给 `SandboxPort`。
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const PKGS = path.resolve(ROOT, '../../source/packages')
const PROJECT = path.join(PKGS, 'shared/extension-preload')

export default defineConfig({
  root: PROJECT,
  base: './',
  publicDir: false,
  logLevel: 'warn',
  resolve: {
    alias: [{ find: '@', replacement: path.join(PROJECT, 'src') }],
  },
  define: {
    // 沙箱脚本按"生产 web"环境编译：不启用 dev 分支，也不读取 Node 环境变量
    'import.meta.env.MODE': JSON.stringify('mobile'),
    'import.meta.env.DEV': 'false',
    'import.meta.env.PROD': 'true',
    'import.meta.env.VITE_IS_ANDROID': 'true',
    'import.meta.env.VITE_IS_DESKTOP': 'false',
    'import.meta.env.VITE_IS_WEB': 'false',
    'import.meta.env.VITE_IS_MAC': 'false',
    'import.meta.env.VITE_COMMIT_ID': JSON.stringify('android'),
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    target: 'esnext',
    outDir: path.join(ROOT, 'dist/extension-preload'),
    emptyOutDir: false,
    modulePreload: false,
    reportCompressedSize: false,
    minify: false,
    sourcemap: false,
    assetsDir: '.',
    rollupOptions: {
      input: { 'extension-preload': path.join(PROJECT, 'src/index.ts') },
      output: {
        entryFileNames: '[name].js',
        format: 'iife',
        // IIFE 不能有 code split；插件预载脚本必须单文件
        inlineDynamicImports: true,
      },
    },
  },
})
