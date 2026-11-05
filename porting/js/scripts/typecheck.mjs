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
 * - 上游文件的诊断**只统计不拦截**；其中包含类型环境和模块解析差异，未逐项判定原因
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
  // tsc 的 1/2 表示诊断；启动失败、被终止或未输出任何诊断不能当成零错误。
  if ((err.status !== 1 && err.status !== 2) || !/error TS\d+/.test(stdout)) {
    console.error('类型检查未正常完成：', stdout.trim() || err.message)
    process.exit(1)
  }
}

const lines = stdout
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => /error TS\d+/.test(l))

const ownFiles = []
const upstreamFiles = []
for (const line of lines) {
  // 只按诊断所属文件分类；错误描述中也可能引用上游路径。
  const file = line.match(/^(.*?)\(\d+,\d+\): error TS\d+/)?.[1] ?? ''
  if (/(^|[\\/])source[\\/]packages[\\/]/.test(file)) upstreamFiles.push(line)
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
    `上游 source/packages 有 ${upstreamFiles.length} 条诊断，按约定不计入移植层门禁；` +
      `此结果不代表上游类型检查通过（详见 scripts/typecheck.mjs 顶部说明）`,
  )
}
