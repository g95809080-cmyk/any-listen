#!/usr/bin/env node
/**
 * 打包前的**只读**自检：核对 `porting/js/dist` 与 `assets/web/spa` 的引用是否自洽。
 *
 * 由来：真机首屏白屏（停在 `Loading...`、日志 `core worker 崩溃 undefined undefined`）的根因是
 * 「index.html / main.js 来自一次构建，worker 只写出一半」——`new Worker()` 404 时
 * `event.message` 是 undefined，所以日志里看不到 404，极难排查。这个脚本把那次事故变成一条命令。
 *
 * 用途：A/B 串行交接时用（fullstack 冻结 dist → 原生侧打包）。
 *   node scripts/check-webdist.mjs                # 查 porting/js/dist
 *   node scripts/check-webdist.mjs --assets       # 查 app/src/main/assets/web/spa（打包后复查）
 *
 * 两类断言（**两种模式都跑**）：
 *   A. 单侧自洽：index.html 引用的入口 js、所有被引用的 `*worker-<hash>.js`、extension-preload 都在。
 *   B. 两侧一致（F-7，见文件末尾）：`dist/spa` 与 `assets/web/spa` 的 index.html SHA1 /
 *      main.*.js 文件名+SHA1 / extension-preload.js SHA1 必须全等。A 类断言**查不出**
 *      「两个目录各自自洽但属于两代构建」，D-13 就是从这条缝里溜进 APK 的。
 *
 * 退出码：0 = 自洽；1 = 不一致或缺产物（此时**不要**打包）。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const checkAssets = process.argv.includes('--assets')
const spaDir = checkAssets
  ? join(root, 'app/src/main/assets/web/spa')
  : join(root, '../js/dist/spa')

const WORKER_RE = /[A-Za-z0-9_$][A-Za-z0-9_$.-]*worker-[A-Za-z0-9_-]{8}\.js/g
const PRELOAD_REL = 'extension-preload/extension-preload.js'

/**
 * preload 的合法落点有**两个**（两类目录布局），只查一个会误报。
 *
 * - 打包后（`--assets`）：`<spa>/extension-preload/extension-preload.js`
 *   —— gradle 的 `syncWebAssets` 把 `porting/js/dist` 根**拍平**进 `assets/web/spa`，
 *   所以 `dist/extension-preload/` 在包里变成 `<spa>/extension-preload/`；
 * - 构建产物（默认，查 `porting/js/dist/spa`）：preload 在**兄弟目录**
 *   `porting/js/dist/extension-preload/extension-preload.js`，不在 `dist/spa/` 里面。
 *
 * 早期只写死了第一种，导致对**完全合法**的产物报
 * `VERDICT: INCONSISTENT —— 不要打包（装上会停在 Loading...）`，
 * A/B 交接时被误判成产物损坏（2026-11-03 实测踩到）。两处都查即可。
 */
const PRELOAD_CANDIDATES = checkAssets
  ? [join(spaDir, PRELOAD_REL)]
  : [join(spaDir, PRELOAD_REL), join(spaDir, '..', 'extension-preload', 'extension-preload.js')]

if (!existsSync(spaDir)) {
  console.error(`[check-webdist] ${spaDir} 不存在`)
  console.error('  -> `pnpm -C porting/js build:all` 还没跑完，或刚被 clean:spa 删掉。不要打包。')
  process.exit(1)
}

const indexPath = join(spaDir, 'index.html')
if (!existsSync(indexPath)) {
  console.error(`[check-webdist] 缺 ${indexPath}。不要打包。`)
  process.exit(1)
}
const indexHtml = readFileSync(indexPath, 'utf8')

/** 递归列出目录下所有 .js（不假设 vite 把 chunk 平铺在 assets/） */
function listJs (dir) {
  const out = []
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else if (name.endsWith('.js')) out.push(p)
    }
  }
  if (existsSync(dir)) walk(dir)
  return out
}

const assetsDir = join(spaDir, 'assets')
const jsFiles = listJs(assetsDir)
const sha1 = (buf) => createHash('sha1').update(buf).digest('hex')

// 入口：index.html 的 <script src>，拿不到再回落到 main.<hash>.js
let entries = [...indexHtml.matchAll(/<script[^>]+src="([^"]+\.js)"/g)].map((m) => basename(m[1]))
if (entries.length === 0) {
  entries = jsFiles.map((p) => basename(p)).filter((n) => /^main\.[A-Za-z0-9_-]{8}\.js$/.test(n))
}

const present = new Set(jsFiles.map((p) => basename(p)).filter((n) => new RegExp(`^(?:${WORKER_RE.source})$`).test(n)))
const referenced = new Set()
let preloadReferenced = false
for (const p of jsFiles) {
  const text = readFileSync(p, 'utf8')
  for (const m of text.matchAll(WORKER_RE)) referenced.add(m[0])
  if (text.includes(PRELOAD_REL)) preloadReferenced = true
}

const missingEntries = entries.filter((n) => !jsFiles.some((p) => basename(p) === n))
const missingWorkers = [...referenced].filter((n) => !present.has(n)).sort()
const orphans = [...present].filter((n) => !referenced.has(n)).sort()
const preloadPath = PRELOAD_CANDIDATES.find((p) => existsSync(p)) ?? null
const missingPreload = preloadReferenced && !preloadPath

const mainBundle = entries[0] ? jsFiles.find((p) => basename(p) === entries[0]) : undefined
console.log(`[check-webdist] 目标        : ${spaDir}`)
console.log(`[check-webdist] entry       : ${entries.join(', ') || '(未找到)'}`)
console.log(`[check-webdist] workers     : ${present.size} 个 ${[...present].sort().join(' ')}`)
console.log(`[check-webdist] 引用计数    : ${referenced.size}`)
console.log(`[check-webdist] 缺失入口    : ${missingEntries.join(', ') || 'none'}`)
console.log(`[check-webdist] 缺失 worker : ${missingWorkers.join(', ') || 'none'}`)
console.log(`[check-webdist] 孤立 worker : ${orphans.join(', ') || 'none'}`)
console.log(`[check-webdist] preload     : 被引用=${preloadReferenced} 存在=${preloadPath ? 'true (' + preloadPath.replace(root, '.') + ')' : 'false'}`)
console.log(`[check-webdist] SHA1 index  : ${sha1(readFileSync(indexPath))}`)
if (mainBundle) console.log(`[check-webdist] SHA1 ${entries[0]}: ${sha1(readFileSync(mainBundle))}`)

const bad = missingEntries.length > 0 || missingWorkers.length > 0 || missingPreload

/* ==========================================================================
 * F-7：`dist ↔ assets` 一致性（D-13 的复发防线）
 *
 * ## 为什么必须补这一项
 *
 * 上面所有检查都只回答「**这个目录自己**引用是否自洽」。而 D-13 的形态是：
 * `dist/spa` 与 `app/src/main/assets/web/spa` **已经是两代产物**，两个目录各自都自洽
 *（旧的那一代也是完整构建），于是 `check-webdist.mjs` 与 `check-webdist.mjs --assets`
 * 双双 `VERDICT: OK` —— 交付的 APK 里缺了 `androidBack.ts` 的整套返回键契约都查不出来。
 * 实测当时：dist `main.DF1m3J24.js`（1,372,012 B / `8e363856…`） vs
 * assets `main.CgvrA_B_.js`（1,370,688 B / `b0392edd…`），index.html SHA1 也不同。
 *
 * ## 为什么只比 3 项而不是整目录
 *
 * `--assets` 侧被 gradle 的 `exclude` 规则挡掉了约 90 个 sourcemap（dist 213 → 入包 118），
 * 逐文件全等必然误报（D-7/P2-9 就是这么来的）。而"换代"这件事只需要 3 个信号：
 *   1. `index.html` 的 SHA1（构建入口，任何一次构建都会变）；
 *   2. `index.html` 引用的 `main.*.js` **文件名 + SHA1**（文件名带 content hash，双保险）；
 *   3. `extension-preload.js` 的 SHA1（它不在 `dist/spa` 里、独立产出，最容易被漏掉）。
 * 这 3 项全等 ⇒ 两侧来自**同一次构建**；任一不等 ⇒ 已经在交付两代产物。
 *
 * ## 两侧路径为什么不同
 *
 * gradle `syncWebAssets` 把 `dist` 根**拍平**进 `assets/web/spa`，所以 dist 侧的 preload 在
 * 兄弟目录 `../js/dist/extension-preload/`，assets 侧在 `<spa>/extension-preload/`（见 PRELOAD_CANDIDATES）。
 *
 * 注意：`--assets` 模式下这段仍然跑，且**默认开启**（没有开关关它）——
 * 门禁的价值就在于"不需要有人记得打开它"。
 * ========================================================================== */
const DIST_SPA = join(root, '../js/dist/spa')
const ASSETS_SPA = join(root, 'app/src/main/assets/web/spa')

const preloadCandidatesFor = (spa) => [
  join(spa, PRELOAD_REL),
  join(spa, '..', 'extension-preload', 'extension-preload.js'),
]

/** 取一侧产物的身份指纹；目录不存在或缺 index.html 时返回 null */
function fingerprint (spa) {
  const index = join(spa, 'index.html')
  if (!existsSync(index)) return null
  const html = readFileSync(index, 'utf8')
  const names = [...html.matchAll(/<script[^>]+src="([^"]+\.js)"/g)].map((m) => basename(m[1]))
  const mainName = names[0] ?? null
  // 不假设 chunk 平铺：按 basename 在 assets/ 下递归找（与上面的入口判定同一套口径）
  const mainFile = mainName ? jsFilesOf(spa).find((p) => basename(p) === mainName) ?? null : null
  const preload = preloadCandidatesFor(spa).find((p) => existsSync(p)) ?? null
  return {
    dir: spa,
    indexSha1: sha1(readFileSync(index)),
    mainName,
    mainSha1: mainFile ? sha1(readFileSync(mainFile)) : null,
    mainBytes: mainFile ? statSync(mainFile).size : null,
    preloadSha1: preload ? sha1(readFileSync(preload)) : null,
  }
}

function jsFilesOf (spa) {
  const out = []
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else if (name.endsWith('.js')) out.push(p)
    }
  }
  const assets = join(spa, 'assets')
  if (existsSync(assets)) walk(assets)
  return out
}

const distFp = fingerprint(DIST_SPA)
const assetsFp = fingerprint(ASSETS_SPA)

let distAssetsBad = false
const fmt = (v) => (v == null ? '(缺失)' : v)
const rel = (p) => p.replace(root, '.')

if (!distFp) {
  console.log('[check-webdist] dist↔assets: 跳过（porting/js/dist/spa 不存在）')
} else if (!assetsFp) {
  console.log('[check-webdist] dist↔assets: 跳过（app/src/main/assets/web/spa 不存在，尚未打包）')
} else {
  const rows = [
    ['index.html SHA1', distFp.indexSha1, assetsFp.indexSha1],
    ['main.*.js 文件名', distFp.mainName, assetsFp.mainName],
    ['main.*.js SHA1', distFp.mainSha1, assetsFp.mainSha1],
    ['extension-preload.js SHA1', distFp.preloadSha1, assetsFp.preloadSha1],
  ]
  const diffs = rows.filter(([, a, b]) => a !== b)
  console.log(`[check-webdist] dist        : ${rel(distFp.dir)}`)
  console.log(`[check-webdist] assets      : ${rel(assetsFp.dir)}`)
  console.log(`[check-webdist] main.*.js   : dist ${fmt(distFp.mainName)} (${fmt(distFp.mainBytes)} B) | assets ${fmt(assetsFp.mainName)} (${fmt(assetsFp.mainBytes)} B)`)
  console.log(`[check-webdist] SHA1 index  : dist ${fmt(distFp.indexSha1)} | assets ${fmt(assetsFp.indexSha1)}`)
  console.log(`[check-webdist] SHA1 main   : dist ${fmt(distFp.mainSha1)} | assets ${fmt(assetsFp.mainSha1)}`)
  console.log(`[check-webdist] SHA1 preload: dist ${fmt(distFp.preloadSha1)} | assets ${fmt(assetsFp.preloadSha1)}`)
  if (diffs.length) {
    distAssetsBad = true
    console.error('[check-webdist] dist↔assets 不一致（两侧来自不同一次构建 = D-13）：')
    for (const [label, a, b] of diffs) {
      console.error(`  - ${label}\n      dist  : ${fmt(a)}\n      assets: ${fmt(b)}`)
    }
    console.error('  -> `dist` 已换代但 `assets` 没跟上。跑 `./gradlew assembleDebug`（会执行')
    console.error('     :webassets:syncWebAssets）让两侧对齐，再重新校验；**不要**直接交付这个 APK。')
    console.error('     若 assets 里是占位 SPA（index.html 没有 main.*.js），说明 dist 那次构建没成功。')
  } else {
    console.log('[check-webdist] dist↔assets: 3 项指纹全等（同一次构建）')
  }
}

if (bad || distAssetsBad) {
  console.error('[check-webdist] VERDICT: INCONSISTENT —— 不要打包（装上会停在 Loading...）')
  process.exit(1)
}
console.log('[check-webdist] VERDICT: OK' + (orphans.length ? '（有孤立 worker，仅浪费体积）' : ''))
