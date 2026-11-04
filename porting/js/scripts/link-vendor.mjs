#!/usr/bin/env node
/**
 * 把 `view-main` 的构建期依赖挂进 `porting/js/node_modules`。
 *
 * ## 为什么需要这一步
 * `porting/js` **不在** `source/` 的 pnpm workspace 里（不能改 `source/pnpm-workspace.yaml`），
 * 所以 Node 的模块向上查找到不了 `source/packages/view-main/node_modules`。
 * 而 UI 层必须用**上游同一份** `svelte` 编译器与插件：
 * - 版本不一致 → 编译产物与运行时 `svelte/internal` 不匹配；
 * - 版本一致但装两份 → 响应式失效（两份 `$state` 实现互不识别）。
 *
 * 因此这里做**目录联接（junction / symlink）**，而不是 `pnpm add` 一份新的：
 * 既不引入网络依赖，也保证与上游逐字节同一份。
 *
 * ## 为什么不是 `resolve.alias`
 * `svelte` 有 `exports` 子路径映射（`svelte/internal/client` → `src/internal/client/index.js`），
 * alias 是纯字符串替换，会让这类子路径全部 404。只有真实目录在 Node 解析路径上才走 `exports`。
 *
 * 幂等：已存在且指向同一目标则跳过；指向别处则**不覆盖**并告警（可能是用户在调别的版本）。
 *
 * 用法：`node scripts/link-vendor.mjs`（`pnpm build` / `pnpm typecheck` 会先跑它）
 */

import { existsSync, mkdirSync, readlinkSync, statSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VIEW_MAIN_NM = path.resolve(ROOT, '../../source/packages/view-main/node_modules')
const LOCAL_NM = path.join(ROOT, 'node_modules')

/**
 * 需要联接的包。
 * 只列**构建 UI 必需**的，不做"整个 node_modules 挂过去"——那会把上游的 eslint/stylelint
 * 一并暴露给移植层，反而让"误用上游 devDependency"变得可能。
 */
const PACKAGES = [
  'svelte', // 组件编译 + 运行时（$state/$derived、svelte/internal/*）
  'svelte-preprocess', // svelte.config.js 用它处理 <script lang="ts"> / <style lang="less">
  '@sveltejs/vite-plugin-svelte',
  'vite-plugin-svg-icons', // virtual:svg-icons-register
  'postcss-pxtorem', // 上游根字号 → rem（rootValue:16，team-lead 明确禁止改）
  'postcss',
  'less',
]

if (!existsSync(VIEW_MAIN_NM)) {
  console.error(`[link-vendor] 找不到 ${VIEW_MAIN_NM}`)
  console.error('[link-vendor] 先在 source/ 下执行 pnpm install（上游 workspace）')
  process.exit(1)
}

mkdirSync(LOCAL_NM, { recursive: true })

let linked = 0
let skipped = 0
const missing = []

for (const name of PACKAGES) {
  const target = path.join(VIEW_MAIN_NM, ...name.split('/'))
  if (!existsSync(target)) {
    missing.push(name)
    continue
  }
  const linkPath = path.join(LOCAL_NM, ...name.split('/'))
  // 作用域包（@sveltejs/xxx）需要先建父目录
  mkdirSync(path.dirname(linkPath), { recursive: true })

  if (existsSync(linkPath) || isDanglingLink(linkPath)) {
    const current = readTarget(linkPath)
    if (current && samePath(current, target)) {
      skipped += 1
      continue
    }
    console.warn(`[link-vendor] ${name} 已存在且指向 ${current ?? '未知'}，不覆盖`)
    skipped += 1
    continue
  }

  // Windows 用 junction：不需要管理员权限，也不依赖开发者模式
  symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  console.log(`[link-vendor] ${name} → ${path.relative(ROOT, target).split(path.sep).join('/')}`)
  linked += 1
}

if (missing.length) {
  console.error(`[link-vendor] 缺失依赖：${missing.join(', ')}`)
  console.error('[link-vendor] 先在 source/ 下执行 pnpm install')
  process.exit(1)
}

console.log(`[link-vendor] 完成：新建 ${linked}，已存在 ${skipped}`)

/* ------------------------------------------------------------------ */

function isDanglingLink(p) {
  try {
    readlinkSync(p)
    return true
  } catch {
    return false
  }
}

function readTarget(p) {
  try {
    // junction 的 readlink 会带 `\\?\` 前缀，归一化后再比
    return readlinkSync(p).replace(/^\\\\\?\\/, '')
  } catch {
    try {
      return statSync(p).isDirectory() ? p : null
    } catch {
      return null
    }
  }
}

function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
}
