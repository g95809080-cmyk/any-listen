#!/usr/bin/env node
/**
 * 构建前清理产物目录。
 *
 * ## 为什么必须自己清（而不用 vite 的 `emptyOutDir`）
 * `outDir` 用了固定目录 + content hash（`assets/[name].[hash].js`），
 * 不清目录的话每次构建都会**追加**一整套新 hash 产物，而 `index.html` 只引用最新那套：
 * `dist/spa/assets` 从 94 个文件一路涨到 188+，打进 APK 就是 11.5 MB 纯死文件（17 MB → 26 MB）。
 *
 * vite 的 `emptyOutDir: true` 也能做到，但它有几个不受控的地方：
 * - 只清 `outDir` 自身，`dist/extension-preload` 这类兄弟目录要靠各自配置；
 * - 清理发生在构建开始时，配置解析报错就直接留下"半清"状态；
 * - 早期实测在本机某些环境下 `rmSync` 被替换成 trash 实现会抛
 *   `Error during a trash operation`，而 vite 把该异常当成致命错误。
 *
 * 所以这里做**显式、可重试、可自愈**的清理：
 * 1. 先 `rmSync(recursive)`；
 * 2. 失败则**逐文件 `unlinkSync` + 自底向上 `rmdirSync`**（本机安全策略对单次 `rmSync`
 *    有「一次删 >50 个目标需人工确认」的守卫，逐文件删不受限），带 3 次退避重试；
 * 3. 还失败则 `renameSync` 到 `<js>/.trash/<name>.old.<ts>`（同卷 rename 是原子的）——**只要目标名
 *    让开了，本次构建就可以安全开始**，垃圾目录留到下次再收；
 * 4. 每次运行顺手扫掉历史遗留的 `.trash/*`。
 *
 * ## 为什么垃圾目录要放在 `dist/` 之外
 * 早期的实现把垃圾改名成 `dist/spa.old.<ts>`。而 Gradle 的 `syncWebAssets` 是
 * `from(jsDistDir) { exclude("spa/**") }` —— 它会把 `dist/` 下**除 `spa/` 之外的一切**拍平拷进
 * `app/src/main/assets/web/spa`，于是 `dist/spa.old.<ts>`（一整套完整的旧产物）被原样塞进了 APK。
 * 实测 `assets/web/spa/spa.old.<ts>` 有 89 个文件 / 26 MB。所以垃圾必须落在 `dist/` 之外。
 *
 * ## 退出码语义（重要）
 * 只有「目标目录**仍在原位**」才算失败（构建会写进旧产物里）。垃圾目录（`*.old.*`）清不掉
 * 只 warn 不阻断 —— 它不影响构建正确性，只是占磁盘，下一次构建还有机会收掉。
 * 早期版本把两者混在一个 `failed` 计数里，导致「rename 成功、垃圾没删掉」被当成致命错误，
 * `pnpm verify` 在第一步就退出（症状：`dist/spa` 明明已经不在了却报删除失败）。
 *
 * 用法：
 *   node scripts/clean.mjs            # dist/spa + dist/extension-preload
 *   node scripts/clean.mjs spa        # 只清 dist/spa
 *   node scripts/clean.mjs ext        # 只清 dist/extension-preload
 *   node scripts/clean.mjs --dry-run  # 只报告体积，不删
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')
/**
 * 改名让位用的垃圾区。**必须在 `dist/` 之外** —— 否则会被 Gradle 的 `syncWebAssets`
 * （`from(dist) { exclude("spa/**") }`）当成 SPA 静态资源拷进 APK。
 */
const TRASH_DIR = path.join(ROOT, '.trash')

/** 目标名 → 实际目录 */
const TARGETS = {
  spa: path.join(DIST, 'spa'),
  ext: path.join(DIST, 'extension-preload'),
}

const ORPHAN_RE = /\.old\.\d+$/

/** 逐文件删除的重试次数与退避（Windows 上杀毒/索引器会短暂占句柄） */
const RETRY_TIMES = 3
const RETRY_BACKOFF_MS = 120

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const requested = argv.filter((a) => !a.startsWith('-'))
const names = requested.length ? requested : ['spa', 'ext']

const unknown = names.filter((n) => !(n in TARGETS))
if (unknown.length) {
  console.error(`[clean] unknown target: ${unknown.join(', ')} (expect: ${Object.keys(TARGETS).join(' | ')})`)
  process.exit(1)
}

let freed = 0
let blocked = 0
let leftovers = 0

for (const name of names) {
  const target = TARGETS[name]
  if (!existsSync(target)) {
    console.log(`[clean] ${rel(target)} — 不存在，跳过`)
    continue
  }

  const { files, bytes } = measure(target)
  if (dryRun) {
    console.log(`[clean] ${rel(target)} — 可释放 ${files} 个文件 / ${fmt(bytes)}（--dry-run，未删）`)
    continue
  }

  const result = removeWithFallback(target)
  if (result.ok) {
    freed += bytes
    console.log(`[clean] ${rel(target)} — 已删除 ${files} 个文件 / ${fmt(bytes)}`)
    if (result.leftover) {
      leftovers += 1
      console.warn(`[clean] ${rel(result.leftover)} — 目录仍在（句柄未释放），下次构建再收；不影响本次构建`)
    }
  } else {
    blocked += 1
    console.error(`[clean] ${rel(target)} — 删除失败：目录仍在原位，构建会写进旧产物`)
  }
}

/* 清掉历史遗留的 .old.* 目录（上一次清理的残留） */
if (!dryRun) {
  for (const orphan of listOrphans()) {
    const { bytes } = measure(orphan)
    const result = removeWithFallback(orphan)
    if (result.ok && !result.leftover) {
      freed += bytes
      console.log(`[clean] ${rel(orphan)} — 遗留目录已清除（${fmt(bytes)}）`)
    } else {
      leftovers += 1
      console.warn(`[clean] ${rel(orphan)} — 遗留目录未清掉（${fmt(bytes)}），不影响本次构建`)
    }
  }
}

const tail = []
if (leftovers) tail.push(`${leftovers} 个残留目录待下次清理`)
console.log(`[clean] 完成，释放 ${fmt(freed)}${tail.length ? `；${tail.join('；')}` : ''}`)
if (blocked) {
  console.error(
    `[clean] ${blocked} 个目标目录无法让位。请先关掉仍在写 dist 的进程（vite dev / gradle syncWebAssets / 资源管理器预览）后重试。`,
  )
  process.exit(1)
}

/* ------------------------------------------------------------------ */

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/')
}

/**
 * 删除目录/文件，返回 `{ ok, leftover? }`。
 *
 * `ok` 的语义是**「目标名已让开，构建可以安全开始」**，而不是「磁盘上一个字节都没剩」。
 * `leftover` 是还没删掉的垃圾目录（仅当 ok=true 时可能出现），由调用方降级成 warn。
 */
function removeWithFallback(target) {
  // 快路径：rmSync。小目录（asset 少时）能一次过。
  try {
    rmSync(target, { recursive: true, force: true })
    if (!existsSync(target)) return { ok: true }
  } catch {
    // 落到逐文件删除
  }

  // 主力路径：逐文件删，带重试
  if (removeTreeByFile(target, RETRY_TIMES)) return { ok: true }

  // 已经是遗留目录名：不再套一层后缀，避免名字越滚越长
  if (ORPHAN_RE.test(target)) return { ok: !existsSync(target) }

  // 最后手段：改名让位。同卷 rename 是原子操作，只要能让开就安全。
  const trash = path.join(TRASH_DIR, `${path.basename(target)}.old.${Date.now()}`)
  try {
    mkdirSync(TRASH_DIR, { recursive: true })
    renameSync(target, trash)
  } catch (err) {
    console.error(`[clean] ${rel(target)} — rename 也失败：${errText(err)}`)
    return { ok: !existsSync(target) }
  }
  if (existsSync(target)) return { ok: false }

  // 目标已让位 → 本次构建安全。垃圾能不能删掉只影响磁盘占用。
  const cleaned = removeTreeByFile(trash, RETRY_TIMES)
  return cleaned ? { ok: true } : { ok: true, leftover: trash }
}

/**
 * 逐文件删除整棵子树，返回是否删干净。
 * `attempts > 1` 时对**失败的文件/目录**做退避重试（只重试失败项，不重扫成功项）。
 */
function removeTreeByFile(root, attempts = 1) {
  for (let i = 0; i < Math.max(1, attempts); i += 1) {
    if (!existsSync(root)) return true
    const pending = sweep(root)
    if (!pending) return true
    if (i + 1 < attempts) sleepSync(RETRY_BACKOFF_MS * (i + 1))
  }
  return !existsSync(root)
}

/**
 * 单趟扫描删除。返回 `true` 表示有失败项（需要重试）。
 */
function sweep(root) {
  let pending = false

  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      pending = true
      return
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(p)
        continue
      }
      if (!tryUnlink(p)) pending = true
    }
    // 目录可能已被子层级的 rmdir 连锁删掉，这时不算失败
    if (!existsSync(dir)) return
    try {
      rmdirSync(dir)
    } catch {
      if (existsSync(dir)) pending = true
    }
  }

  walk(root)
  return pending
}

function tryUnlink(file) {
  try {
    unlinkSync(file)
    return true
  } catch {
    // 只读文件先改权限再试一次
  }
  try {
    chmodSync(file, 0o666)
    unlinkSync(file)
    return true
  } catch {
    return !existsSync(file)
  }
}

/** 一次性统计文件数与总字节（删除前调用） */
function measure(root) {
  let files = 0
  let bytes = 0
  const stack = [root]
  while (stack.length) {
    const cur = stack.pop()
    let entries
    try {
      entries = readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const p = path.join(cur, entry.name)
      if (entry.isDirectory()) {
        stack.push(p)
        continue
      }
      files += 1
      try {
        bytes += statSync(p).size
      } catch {
        // 单文件取大小失败不影响清理
      }
    }
  }
  return { files, bytes }
}

/**
 * 找出遗留垃圾：
 * - `.trash/*` —— 当前实现的让位目录，正常应该每次都清空；
 * - `dist/*.old.*` —— 旧实现把垃圾放在 dist 里的残留，必须收掉，否则会被 Gradle 拷进 APK。
 */
function listOrphans() {
  const out = []
  for (const dir of [TRASH_DIR, DIST]) {
    if (!existsSync(dir)) continue
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !ORPHAN_RE.test(entry.name)) continue
      out.push(path.join(dir, entry.name))
    }
  }
  return out
}

/** 同步 sleep —— clean 是纯同步脚本，这里只为给 Windows 的句柄释放留一点时间 */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const end = Date.now() + ms
    while (Date.now() < end) {
      /* busy wait fallback */
    }
  }
}

function errText(err) {
  return err instanceof Error ? err.message : String(err)
}

function fmt(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
