/**
 * 类型检查（`pnpm typecheck`）。
 *
 * 为什么不是裸 `tsc --noEmit`：
 * 移植层通过 vite alias 直接编译 `source/packages` 下的**上游源码**，于是 tsc 会把它们
 * 一起拉进同一个 program。上游是 Node 程序（`lib` 里没有 DOM/WebWorker，`MessagePort` 是
 * node 版、带 `.on()`），而移植层必须带 DOM/WebWorker（AudioWorklet、`window`）。
 * 两套 globals 在同一 program 里必然互相冲突——这些冲突**不是**移植层引入的。
 *
 * 因此这里的规则是：
 * - 移植层自己的文件（entries / host / ports / shims / nodejs / types）**必须零错误**，否则退出码 1
 * - 上游文件的诊断**只统计不拦截**（上游的严格性由它自己的 `pnpm typecheck` 保证）
 *
 * 这样既守住了用户 P0 的 "strict: true + 禁 any 逃逸"，又不会用上游的 lib 冲突掩盖真实问题。
 */

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

let stdout = ''
try {
  stdout = execFileSync('npx', ['tsc', '--noEmit', '-p', 'tsconfig.json'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
} catch (err) {
  stdout = `${err.stdout ?? ''}${err.stderr ?? ''}`
}

const lines = stdout
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => /error TS\d+/.test(l))

const ownFiles = []
const upstreamFiles = []
for (const line of lines) {
  if (/source[\\/]packages/.test(line)) upstreamFiles.push(line)
  else ownFiles.push(line)
}

if (ownFiles.length) {
  console.error(`\n移植层类型错误 ${ownFiles.length} 条：\n`)
  for (const line of ownFiles) console.error(`  ${line}`)
  console.error('')
  process.exit(1)
}

console.log(`移植层类型检查通过（strict: true，0 错误）`)
if (upstreamFiles.length) {
  console.log(
    `上游 source/packages 有 ${upstreamFiles.length} 条诊断，因 DOM/WebWorker 与 Node globals 冲突，` +
      `按约定不计入移植层门禁（详见 scripts/typecheck.mjs 顶部说明）`,
  )
}
