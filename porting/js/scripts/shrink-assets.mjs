#!/usr/bin/env node
/**
 * 构建后处理：把 aapt **拒绝压缩**的媒体资源改名，让它们真正被 deflate。
 *
 * ## 为什么需要这一步（实测数据）
 * aapt2 对一批「看起来已经是压缩格式」的扩展名直接 `Stored`（0% 压缩），`.wav` 就在名单里。
 * 而上游 `view-main/src/assets/medias/filters/*.wav` 是**卷积混响的脉冲响应**（14 个文件），
 * 未压缩合计 7.07 MB —— 占 debug APK 的 27%，而且它们只是噪声式的 IR，
 * 用 deflate 压到 **31%～33%**（实测 `gzip -9`），一点问题都没有。
 *
 * 改名成 `xxx.wav.bin` 后：
 * - aapt2 不再认识这个扩展名 → 正常压缩 → 7.07 MB 变 ~2.3 MB；
 * - 原生 `LocalHttpServer.handleStatic` 用 `assets.open()` 读（AssetManager 自动解压），
 *   未知扩展名回落 `application/octet-stream`（`guessMime` 有兜底）；
 * - 消费端是 `soundEffect.ts` 的 `XMLHttpRequest` + `responseType='arraybuffer'`
 *   + `AudioContext.decodeAudioData()` —— **按内容嗅探 RIFF 头**，不看扩展名、不看 MIME。
 *
 * 所以这是**无损**的：音频数据一个字节没变，只是换了个文件名让打包器干活。
 *
 * ## 为什么放在 vite build 之后、而不是写成 vite 插件
 * `soundEffect.ts` 用的是**变量动态导入**（`import(\`.../filters/${name}.wav\`)`），
 * vite 走 `dynamic-import-vars` 把它展开成 glob；在 `resolveId`/`load` 里拦截这条链
 * 要跟 glob 插件的内部实现耦合，改一次 vite 版本就可能失效。
 * 而产物里的引用就是一个 `"/assets/<name>.<hash>.wav"` 字符串字面量，
 * 构建后按名字替换既稳定又可断言（见下面的 `verify`）。
 *
 * 用法：
 *   node scripts/shrink-assets.mjs           # 原地改名 + 改引用
 *   node scripts/shrink-assets.mjs --dry-run # 只报告
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const spaDirArg = process.argv.find((arg) => arg.startsWith('--spa-dir='))
if (spaDirArg === '--spa-dir=') throw new Error('--spa-dir 不能为空')
const SPA = spaDirArg ? path.resolve(ROOT, spaDirArg.slice('--spa-dir='.length)) : path.join(ROOT, 'dist', 'spa')

const dryRun = process.argv.includes('--dry-run')

/**
 * 需要改名的扩展名。只收「aapt 会 Stored 且体积可观」的：
 * `.mp3` 也一起处理（`Silence02s.mp3` 只有 2 KB，但规则统一更省心）。
 */
const EXTENSIONS = ['.wav', '.mp3']

if (!existsSync(SPA)) {
  console.error(`[shrink] ${SPA} 不存在，先跑 vite build`)
  process.exit(1)
}

/** 1. 找出所有待改名的资源（只扫 assets/ 下，其它位置没有这些文件） */
const assetsDir = path.join(SPA, 'assets')

/* ------------------------------------------------------------------ *
 * 1.5 删除「没被任何产物引用」的 wasm 资产
 *
 * 为什么会有孤儿：`@jitl/quickjs-wasmfile-*` 四个变体模块里都是
 * `new URL('emscripten-module.wasm', import.meta.url)`。vite 在 **transform 阶段**就把
 * `emitFile` 执行掉了，而「哪个变体真正被引用」要到后面 tree-shaking 才定。
 * 我们只用 `release-sync` 一个变体（`quickjs-emscripten` 默认参数），于是另外 3 个：
 *
 *   产物里有 4 个 `assets/emscripten-module-*.wasm` 合计 9.3 MB
 *   产物里只有 1 个被引用（`"/assets/emscripten-module-<hash>.wasm"`，518 KB）
 *
 * 那 9.3 MB 会原样进 APK（`syncWebAssets` 按目录整拷），属于纯死重量。
 *
 * 判据与 `scripts/smoke.mjs` 的 wasm 门禁同源：**从产物里反向抠出所有被引用的 .wasm 名字**。
 * 正则要求引号，避免命中 emscripten glue 里的 `k.wasmBinary` 之类属性访问。
 *
 * 安全边界：
 * - 只删 `assets/` 下的 `.wasm`，不碰 `public/wasm/`（那里是 `locateFile` 约定，如 sql.js）；
 * - 一个引用都没扫到时**不删任何东西**（说明产物形态变了，宁可留着也不误删）；
 * - 每次删除都打日志，不静默。
 * ------------------------------------------------------------------ */
const textFilesForWasm = listFiles(SPA).filter((f) => /\.(js|mjs|css|html)$/.test(f))
const wasmRefs = new Set()
for (const rel of textFilesForWasm) {
  for (const m of readFileSync(path.join(SPA, rel), 'utf8').matchAll(/["'`]([^"'`]*\.wasm)["'`]/g)) {
    wasmRefs.add(path.posix.basename(m[1]))
  }
}

let purgedBytes = 0
const purged = []
const purgeFailed = []
if (wasmRefs.size === 0) {
  console.warn('[shrink] 产物里没扫到任何 .wasm 引用，跳过孤儿 wasm 清理（防止误删）')
} else if (!dryRun) {
  for (const name of listFiles(assetsDir)) {
    if (!name.endsWith('.wasm')) continue
    if (wasmRefs.has(name)) continue
    const size = statSync(path.join(assetsDir, name)).size
    // 删除受限时先隔离到 dist 外，与 copy-wasm 的处理方式一致。
    try {
      unlinkSync(path.join(assetsDir, name))
      purgedBytes += size
      purged.push(name)
    } catch (err) {
      try {
        const trashDir = path.join(ROOT, '.trash')
        mkdirSync(trashDir, { recursive: true })
        const isolated = path.join(trashDir, `${path.basename(name)}.old.${Date.now()}.${process.pid}`)
        if (existsSync(isolated)) throw new Error(`隔离目标已存在: ${isolated}`)
        renameSync(path.join(assetsDir, name), isolated)
        purgedBytes += size
        purged.push(name)
        console.warn(`[shrink] 删除失败，已隔离未引用资源到 ${isolated}`)
      } catch (moveErr) {
        purgeFailed.push(`${name}（删除: ${String(err)}；隔离: ${String(moveErr)}）`)
      }
    }
  }
  if (purged.length) {
    console.log(
      `[shrink] 移除 ${purged.length} 个未被引用的 wasm 资产（${fmt(purgedBytes)}）：${purged.map((n) => n.replace(/-[\w-]{8}\.wasm$/, '')).join(', ')}`
    )
  }
  if (purgeFailed.length) {
    console.warn(
      `[shrink] ${purgeFailed.length} 个孤儿 wasm 无法删除或隔离：\n  - ${purgeFailed.join('\n  - ')}`
    )
    process.exit(1)
  }
}


const renames = new Map() // 旧文件名 → 新文件名
for (const name of listFiles(assetsDir)) {
  const ext = path.extname(name).toLowerCase()
  if (!EXTENSIONS.includes(ext)) continue
  if (name.endsWith('.bin')) continue
  renames.set(name, `${name}.bin`)
}

if (renames.size === 0) {
  console.log('[shrink] 没有需要改名的媒体资源（可能已经处理过）')
  process.exit(0)
}

const savedBytes = [...renames.keys()].reduce((sum, name) => sum + statSync(path.join(assetsDir, name)).size, 0)

/** 2. 改写所有文本产物里的引用 */
const textFiles = listFiles(SPA).filter((f) => /\.(js|mjs|css|html|json)$/.test(f))
let touched = 0
let replaced = 0

for (const rel of textFiles) {
  const file = path.join(SPA, rel)
  const before = readFileSync(file, 'utf8')
  let after = before
  for (const [oldName, newName] of renames) {
    // 负向先行断言：已经带 `.bin` 的不再重复追加（幂等）
    const pattern = new RegExp(`${escapeRe(oldName)}(?!\\.bin)`, 'g')
    const hits = (after.match(pattern) ?? []).length
    if (hits === 0) continue
    replaced += hits
    after = after.replace(pattern, newName)
  }
  if (after !== before) {
    touched += 1
    if (!dryRun) writeFileSync(file, after)
  }
}

/** 3. 断言：每个被改名的资源都至少被引用过一次（否则它是死文件，应该删而不是改名） */
const referenced = new Set()
for (const rel of textFiles) {
  const content = readFileSync(path.join(SPA, rel), 'utf8')
  for (const oldName of renames.keys()) {
    if (content.includes(oldName)) referenced.add(oldName)
  }
}
const orphans = [...renames.keys()].filter((name) => !referenced.has(name))

/** 4. 改名 */
if (!dryRun) {
  for (const [oldName, newName] of renames) {
    renameSync(path.join(assetsDir, oldName), path.join(assetsDir, newName))
  }
}

/** 5. 复核：改名后再扫一遍，确认没有残留的旧引用 */
let leftovers = 0
if (!dryRun) {
  for (const rel of textFiles) {
    const content = readFileSync(path.join(SPA, rel), 'utf8')
    for (const oldName of renames.keys()) {
      // 只看「旧名后面没跟 .bin」的出现
      if (new RegExp(`${escapeRe(oldName)}(?!\\.bin)`).test(content)) {
        leftovers += 1
        console.error(`[shrink] 残留旧引用：${rel} → ${oldName}`)
      }
    }
  }
}

console.log(
  `[shrink] ${renames.size} 个媒体资源 → .bin（${fmt(savedBytes)} 未压缩）` +
    `；改写 ${touched} 个产物文件 / ${replaced} 处引用` +
    (dryRun ? '（--dry-run，未落盘）' : '')
)
if (orphans.length) {
  // 不是错误：可能是上游注释掉的预设（`plugins/player/index.ts` 里就有几条被注释的）
  console.warn(`[shrink] ${orphans.length} 个资源在产物里没有被引用（死文件，可考虑删）：${orphans.slice(0, 5).join(', ')}`)
}
console.log(
  `[shrink] 预期收益：aapt 压缩率约 31%～33% → APK 约省 ${fmt(Math.round(savedBytes * 0.68))}`
)
if (leftovers) {
  console.error(`[shrink] ${leftovers} 处引用未改写成功，请检查 vite 产物格式是否变化`)
  process.exit(1)
}

/* ------------------------------------------------------------------ */

/** 递归列出相对路径（posix 分隔），不含目录 */
function listFiles(root) {
  const out = []
  const walk = (dir, prefix) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel)
      else out.push(rel)
    }
  }
  walk(root, '')
  return out
}

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function fmt(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}
