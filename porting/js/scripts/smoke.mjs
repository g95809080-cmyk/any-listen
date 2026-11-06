/**
 * 冒烟验证：`pnpm smoke`
 *
 * 分两段：
 * 1. **产物检查** —— `dist/` 里该有的文件都在、体积合理（防止"构建成功但产物是空壳"）
 * 2. **行为检查** —— 用同一份 vite 配置打出一个 Node bundle（`node_modules/.cache/anylisten-smoke/smoke.mjs`），
 *    跑移植层的 shims / Ports / Store，并与 Node 原生实现逐字节比对
 * 3. **sql.js 检查** —— 直接用真实依赖建表/插入/查询/export，验证 SqlitePort 的底座可用
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const distArg = process.argv.find((arg) => arg.startsWith('--dist='))
if (distArg === '--dist=') throw new Error('--dist 不能为空')
const DIST = distArg ? path.resolve(ROOT, distArg.slice('--dist='.length)) : path.join(ROOT, 'dist')

const failures = []
const notes = []

function pass(name, detail = '') {
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
}
function fail(name, detail) {
  console.error(`  ✗ ${name} — ${detail}`)
  failures.push(`${name}: ${detail}`)
}

function assert(cond, name, detail) {
  if (cond) pass(name, detail)
  else fail(name, detail)
}

function cssRuleHas(css, selector, declarations) {
  const start = css.indexOf(selector)
  if (start < 0) return false
  const open = css.indexOf('{', start)
  const close = css.indexOf('}', open)
  if (open < 0 || close < 0) return false
  const body = css.slice(open + 1, close)
  return declarations.every((declaration) => body.includes(declaration))
}

/* ------------------------------------------------------------------ *
 * 1. 产物检查
 * ------------------------------------------------------------------ */
console.log('\n[1/3] 产物检查')

const spaDir = path.join(DIST, 'spa')
assert(existsSync(path.join(spaDir, 'index.html')), 'dist/spa/index.html 存在')

const assetsDir = path.join(spaDir, 'assets')
const assets = existsSync(assetsDir) ? readdirSync(assetsDir) : []

function findAsset(pattern) {
  return assets.find((f) => pattern.test(f))
}

for (const [label, pattern] of [
  ['main chunk', /^main\.(?!worker)[A-Za-z0-9_-]+\.js$/],
  ['core worker', /^core\.worker-.*\.js$/],
  ['db worker', /^db\.worker-.*\.js$/],
  ['util worker', /^util\.worker-.*\.js$/],
  ['ext worker', /^ext\.worker-.*\.js$/],
]) {
  const file = findAsset(pattern)
  if (!file) {
    fail(label, `dist/spa/assets 里找不到 ${pattern}`)
    continue
  }
  const size = statSync(path.join(assetsDir, file)).size
  assert(size > 20 * 1024, `${label} 体积合理`, `${file} = ${(size / 1024).toFixed(1)} kB`)
}

// worker 产物不能是未编译的 .ts（踩过一次：new URL 用变量传参会退化成拷源文件）
const tsLeak = assets.filter((f) => f.endsWith('.ts'))
assert(tsLeak.length === 0, 'worker 产物不是未编译 .ts', tsLeak.length ? tsLeak.join(', ') : 'none')

/* ---- worker 产物一致性 ------------------------------------------------------
 * 真机上踩过的坑：APK 里的 `main.js` 引用 `core.worker-<hash>.js` / `db.worker-<hash>.js`，
 * 但这两个文件**不在 APK 里**（404），UI 永久停在 `Loading...`。
 * 根因是 dist 里混进了上一代 hash 的产物（`emptyOutDir:false` 累积 + 与原生侧并发构建）。
 *
 * 所以这里做**双向**核对，而不是"同名文件存在就算过"：
 *   1. 产物里引用到的每一个 `*.worker-<hash>.js` 都必须在 assets 里真实存在（否则运行时 404）；
 *   2. core / db / util / ext 四个 worker 必须**都被引用**（缺一个 = 启动链路断了）；
 *   3. 反向：assets 里存在但没有任何**其它**文件引用的 worker chunk 记 NOTE（死体积）。
 *
 * ⚠️ 引用点**不只在 main chunk**：`view-main/src/worker/index.ts` 的 `createMainWorker()`
 * 被大量**懒加载视图** chunk 引用（`@/worker`），所以 `main.worker-*.js` 的引用字符串
 * 出现在 `Index-*.js` 之类的懒加载 chunk 里。只扫 main 会把它误判成死文件。
 * 所以这里扫**全部** js 产物，并按"引用者 ≠ 自己"过滤掉自引用与 sourceMappingURL。
 */
const workerRefPattern = /([A-Za-z0-9_]+\.worker-[A-Za-z0-9_-]+\.js)/g
/** worker 文件名 → 引用它的其它文件集合 */
const workerReferencedBy = new Map()
for (const name of assets.filter((f) => f.endsWith('.js'))) {
  const source = readFileSync(path.join(assetsDir, name), 'utf8')
  for (const match of source.match(workerRefPattern) ?? []) {
    if (match === name) continue // 自引用（sourceMappingURL 等）
    if (!workerReferencedBy.has(match)) workerReferencedBy.set(match, new Set())
    workerReferencedBy.get(match).add(name)
  }
}
const referencedWorkers = new Set(workerReferencedBy.keys())

const missingWorkers = [...referencedWorkers].filter((name) => !assets.includes(name))
assert(
  missingWorkers.length === 0,
  '引用的 worker 产物全部存在（防 404 卡 Loading）',
  missingWorkers.length
    ? `缺失：${missingWorkers.join(', ')}（dist 里混入了上一代 hash 产物？）`
    : `${referencedWorkers.size} 个引用全部命中`,
)

for (const kind of ['core', 'db', 'util', 'ext']) {
  const referenced = [...referencedWorkers].some((name) => name.startsWith(`${kind}.worker-`))
  const present = assets.some((name) => name.startsWith(`${kind}.worker-`))
  assert(referenced && present, `${kind} worker 已产出且被引用`, present ? 'ok' : 'dist 里没有')
}

const orphanWorkers = assets.filter(
  (name) => name.includes('.worker-') && name.endsWith('.js') && !referencedWorkers.has(name),
)
if (orphanWorkers.length) {
  const bytes = orphanWorkers.reduce((sum, name) => sum + statSync(path.join(assetsDir, name)).size, 0)
  notes.push(`存在未被任何文件引用的 worker chunk（死体积 ${(bytes / 1024).toFixed(0)} kB）：${orphanWorkers.join(', ')}`)
}

/* ---- 上游 `__dirname` 不能出现在"用路径拼文件"的位置 -------------------------
 * 真机 fatal：`core.worker` 启动即 `ReferenceError: __dirname is not defined`
 * （上游 `web-server/src/app/modules/extension/index.ts:40` 的
 * `readFile(joinPath(__dirname, 'extension-preload.js'))`），bootstrap 走不完、UI 卡 Loading。
 * 已由 `host/app/modules/extension/index.ts` 改成 fetch 修掉。
 *
 * `shims/globals.ts` 里会以字符串形式出现 `"__dirname"`（那是兜底定义本身，无害），
 * 所以断言必须精确到"把 `__dirname` 当路径用"这种形态。
 */
const dirnamePathPattern = /\b(?:join|joinPath|resolve|normalize)\(\s*__dirname\b/
for (const kind of ['core', 'db', 'util', 'ext', 'main']) {
  const file = kind === 'main' ? findAsset(/^main\.(?!worker)[A-Za-z0-9_-]+\.js$/) : findAsset(new RegExp(`^${kind}\\.worker-.*\\.js$`))
  if (!file) continue
  const src = readFileSync(path.join(assetsDir, file), 'utf8')
  const hits = (src.match(new RegExp(dirnamePathPattern, 'g')) ?? []).length
  if (kind === 'core') {
    // core.worker 是硬门禁：它挂了整个 App 起不来
    assert(hits === 0, 'core.worker 里没有 `__dirname` 拼路径（防启动即 ReferenceError）', hits ? `${hits} 处` : 'none')
  } else if (hits) {
    // 其余 worker 里已知的是 db 的 `path.join(__dirname, nativeBindingPath)`：
    // sql.js 忽略 nativeBinding，靠 shims/globals.ts 的 '' 兜底即可，记 NOTE 不拦截
    notes.push(`${file} 里有 ${hits} 处 \`__dirname\` 拼路径（依赖 shims/globals.ts 兜底返回 ''）`)
  }
}

const preloadFile = path.join(DIST, 'extension-preload/extension-preload.js')
if (existsSync(preloadFile)) {
  const size = statSync(preloadFile).size
  assert(size > 1024, 'extension-preload IIFE 产物存在', `${(size / 1024).toFixed(1)} kB`)
} else {
  notes.push('dist/extension-preload/extension-preload.js 未生成（先跑 pnpm build:extension-preload）')
}

const wasmDir = path.join(DIST, 'spa/wasm')
if (existsSync(wasmDir) && readdirSync(wasmDir).length) {
  pass('dist/spa/wasm 存在', readdirSync(wasmDir).join(', '))
} else {
  notes.push('dist/spa/wasm 为空：请先跑 pnpm copy-wasm（或依赖 bootstrap 时自动执行）')
}

/* ---- 被引用的 wasm 必须在磁盘上真实存在 -------------------------------------
 * 真机坑（本轮定位）：`sql.js@1.15.2` 的 exports 是
 * `{ ".": { "browser": "./dist/sql-wasm-browser.js", "default": "./dist/sql-wasm.js" } }`，
 * vite 的 browser 目标命中 `browser` 条件 → 打进产物的是 `sql-wasm-browser.js` →
 * 它硬编码请求 `sql-wasm-browser.wasm`；而 `public/wasm/` 里当时放的是 `sql-wasm.wasm`。
 * 于是 wasm 请求 404，sql.js 把 404 的响应体（`"Not Found: …"`，开头正是 ASCII `"Not "`，
 * 即取证里的 `4e 6f 74 20`）当成 wasm 喂给 `instantiate`，最终表现成
 * `[db.worker] sql.js is not initialized` —— 一个命名错位伪装成初始化逻辑缺失。
 *
 * 这类错位会**重演**（换依赖版本 / 换 entry 条件 / 换 wasm 变体都会改名字），所以这里不写死
 * `sql-wasm`，而是从产物里**反向抠出所有被引用的 .wasm 名字**再逐个断言存在。
 *
 * 两种引用形态都要能解析（详见下面 `resolveWasmRef`）：
 * - 裸文件名 + `wasm/`（publicDir 原样拷贝，sql.js 的 `locateFile` 拼 `/wasm/${file}`）
 * - 带路径的 hashed 资产 + `assets/`（vite 对 `new URL('x.wasm', import.meta.url)` 的改写，
 *   quickjs 变体就是这个形态 —— 2026-11 实测：`/assets/emscripten-module-<hash>.wasm`）
 *
 * 正则刻意**要求引号**：裸扫 `.wasm` 会命中 emscripten glue 里的 `k.wasmBinary`
 * 属性访问，制造一条永远修不掉的假红灯，最后大家会习惯性忽略门禁。
 */
const wasmRefPattern = /["'`]([^"'`]*\.wasm)["'`]/g
const wasmRefs = new Set()
for (const file of [
  ...assets.filter((f) => f.endsWith('.js')).map((f) => path.join(assetsDir, f)),
  path.join(spaDir, 'index.html'),
]) {
  if (!existsSync(file)) continue
  for (const m of readFileSync(file, 'utf8').matchAll(wasmRefPattern)) wasmRefs.add(m[1])
}

/**
 * 引用串有两种合法形态，必须都认，否则 quickjs 那一类会被假红：
 * - 裸文件名：`"sql-wasm-browser.wasm"`（sql.js 的 `locateFile` 拼 `/wasm/${file}`）
 * - 带路径：`"/assets/emscripten-module-<hash>.wasm"`（vite 对 `new URL(..., import.meta.url)`
 *   的改写结果，quickjs 变体就是这个形态）
 *
 * 解析顺序：先按「SPA 根相对路径」原样查（`/assets/x.wasm` → `dist/spa/assets/x.wasm`），
 * 再退化成按 basename 在 `wasm/` 与 `assets/` 里找。这样两种约定都能命中，
 * 而 `k.wasmBinary` 这类属性访问因为不带引号仍然不会进来。
 */
const resolveWasmRef = (ref) => {
  const rel = ref.replace(/^\.?\//, '')
  if (rel.includes('/') && existsSync(path.join(spaDir, rel))) return rel
  const base = rel.split('/').pop()
  const hit = ['wasm', 'assets'].find((sub) => existsSync(path.join(spaDir, sub, base)))
  if (hit) return `${hit}/${base}`
  /*
   * 兜底：裸文件名 + 磁盘上没有同名文件。
   *
   * 实测来源是 emscripten glue 里**没被改写**的 fallback 字面量：
   * `(c.locateFile ? c.locateFile("emscripten-module.wasm", x) : (new URL("emscripten-module.wasm",
   * import.meta.url)).href)`。vite 只会改写 `new URL(...)` 那一支，`locateFile` 分支里的字符串
   * 原样留在代码里 —— 运行期走不到它（我们没传 locateFile），它是个死字符串。
   *
   * 判据：只要 `assets/` 里存在**同 stem 的 hashed 变体**（`emscripten-module-<hash>.wasm`），
   * 就说明真正被请求的那份是存在的，这条 fallback 视为已满足。
   * 注意 `sql-wasm-browser.wasm` 走不到这里 —— 它在 `wasm/` 里有精确同名文件。
   */
  if (!base.includes('/')) {
    const assets = path.join(spaDir, 'assets')
    if (existsSync(assets)) {
      const stem = base.replace(/\.wasm$/, '')
      const variant = readdirSync(assets).find((f) => f.startsWith(`${stem}-`) && f.endsWith('.wasm'))
      if (variant) return `assets/${variant}`
    }
  }
  return null
}

if (!wasmRefs.size) {
  // 一条都没扫到不是"通过"，是"门禁失效"——必须留痕，不能静默
  notes.push('产物里没有任何 .wasm 引用：sql.js / quickjs 可能已改成内联 wasm（体积会明显上涨，见 README §8）')
} else {
  const sorted = [...wasmRefs].sort()
  const missing = []
  for (const ref of sorted) {
    const resolved = resolveWasmRef(ref)
    if (resolved) pass(`wasm 引用有对应文件：${ref}`, resolved)
    else missing.push(ref)
  }
  // 汇总行：门禁不能"静默通过"——只打 ✓ 不打数量时，它退化成"一直绿"也没人发现
  if (missing.length) {
    fail('wasm 引用全部存在', `引用 ${sorted.length} 个，缺失 ${missing.length} 个：${missing.join(', ')}`)
  } else {
    pass('wasm 引用统计', `引用 ${sorted.length} 个，全部存在（${sorted.join(', ')}）`)
  }
}

/* ---- 反向门禁：assets/ 下不能有「没被任何产物引用」的 wasm -------------------
 *
 * 上一节保证「代码要的，磁盘上有」；这一节保证「磁盘上有的，代码都要」。
 * 后者不是洁癖：quickjs 的四个变体模块里都是 `new URL('emscripten-module.wasm',
 * import.meta.url)`，vite 在 transform 阶段就 emitFile，而"哪个变体真被引用"要到
 * tree-shaking 之后才定 → 实测 4 个 wasm 共 9.3 MB，只有 1 个（518 KB）被引用，
 * 另外 9.3 MB 会跟着 `syncWebAssets` 整目录拷进 APK。
 *
 * `scripts/shrink-assets.mjs` 的 1.5 节负责删它们；这里负责在它没生效时**大声失败**。
 */
if (wasmRefs.size && existsSync(assetsDir)) {
  // 必须拿「解析后文件的 basename」来比，不能拿原始引用串 —— 引用串可能是
  // `/assets/emscripten-module-<hash>.wasm` 这种带路径形态，直接和文件名比会把真文件当成孤儿。
  const resolvedBases = new Set()
  for (const ref of wasmRefs) {
    const resolved = resolveWasmRef(ref)
    if (resolved) resolvedBases.add(path.basename(resolved))
  }
  const orphans = readdirSync(assetsDir)
    .filter((f) => f.endsWith('.wasm') && !resolvedBases.has(f))
    .map((f) => ({ name: f, size: statSync(path.join(assetsDir, f)).size }))
  if (orphans.length) {
    const mb = (orphans.reduce((s, o) => s + o.size, 0) / 1024 / 1024).toFixed(2)
    fail(
      'assets/ 下没有未被引用的 wasm',
      `${orphans.length} 个孤儿共 ${mb} MB 会进 APK：${orphans.map((o) => o.name).join(', ')}` +
        '（跑 `node scripts/shrink-assets.mjs` 清理）'
    )
  } else {
    pass('assets/ 下没有未被引用的 wasm')
  }
}

// ---- UI 壳层是否真的进了产物 -------------------------------------------------
// 只断言"标记字符串存在"是最便宜的有效检查：这些字符串只可能来自 ui/ 下的壳层组件
// （TabBar 文案、MiniPlayer 类名、长按合成的 contextmenu、桥入口名）。
// 它抓的是"UI 被 tree-shake 掉 / 入口退回占位页"这类回归，不替代真机渲染验证。
const mainChunk = findAsset(/^main\.(?!worker)[A-Za-z0-9_-]+\.js$/)
if (mainChunk) {
  const mainSource = readFileSync(path.join(assetsDir, mainChunk), 'utf8')
  const uiMarkers = [
    ['TabBar 文案（曲库）', '曲库'],
    ['TabBar 文案（在线）', '在线'],
    ['移动端壳层类名', 'tabbar'],
    ['迷你播放器类名', 'mini-main'],
    ['长按合成的 contextmenu', 'contextmenu'],
    ['桥回程入口名', '__anylisten_bridge_recv__'],
    ['MediaSession 替身挂载点', '__anylisten_media_session_shim__'],
  ]
  for (const [label, marker] of uiMarkers) {
    assert(mainSource.includes(marker), `UI 产物包含 ${label}`, marker)
  }
  // 占位页的残留标记：一旦出现说明 entries/main.ts 退回了占位实现
  assert(!mainSource.includes('__anylisten_mount_ui__'), 'UI 不再是占位页', '未找到 __anylisten_mount_ui__')
}

// ---- 移动端 UI 回归守卫 ------------------------------------------------------
// 这些规则都是“看得见但普通类型检查抓不到”的修复：桌面定尺卡片、全局 BottomSheet
// 误伤局部下拉、在线筛选区挤掉一级 Tab。断言编译后的 CSS，避免只改源码注释、
// 或选择器被后续重构悄悄覆盖。
const styleAssets = assets.filter((name) => /^style\..*\.css$/.test(name))
assert(styleAssets.length === 1, '单一样式产物存在', styleAssets.length ? styleAssets.join(', ') : 'none')
if (styleAssets.length === 1) {
  const css = readFileSync(path.join(assetsDir, styleAssets[0]), 'utf8')
  const cssGuards = [
    [
      '在线歌单页一级 Tab 与筛选区分行',
      '.header:has(> #online-header-right > .online-songlist-header-right)',
      ["grid-template-areas: 'types' 'filters'", 'grid-template-columns: minmax(0, 1fr)'],
    ],
    [
      '在线歌单卡切换为单列信息卡',
      '.songlist-list ul:has(.songlist-info)',
      ['grid-template-columns: minmax(0, 1fr) !important'],
    ],
    [
      '在线歌单卡取消桌面最小宽度',
      '.songlist-list ul > li > a.list-item:has(.songlist-info)',
      ['min-width: 0 !important', 'height: auto !important'],
    ],
    [
      '在线歌单标签关闭态不渲染',
      ".online-songlist-header-right .tag-list > .popup[aria-hidden='true']",
      ['display: none !important'],
    ],
    [
      '在线歌单标签打开态铺满抽屉',
      ".online-songlist-header-right .tag-list > .popup[aria-hidden='false']",
      ['display: flex !important'],
    ],
    [
      '在线歌单标签恢复纵向换行',
      '.header > #online-header-right .online-songlist-header-right .tag-list > .popup > .list',
      ['display: block !important', 'overflow-x: hidden !important'],
    ],
  ]
  for (const [label, selector, declarations] of cssGuards) {
    assert(cssRuleHas(css, selector, declarations), `UI 守卫：${label}`, selector)
  }
}

const settingsOverride = readFileSync(
  path.join(ROOT, 'ui/overrides/views/Setting/AppSetting/settings.ts'),
  'utf8',
)
assert(
  settingsOverride.includes("new Set(['hotkey', 'update'])") &&
    settingsOverride.includes('common.windowSizeId') &&
    settingsOverride.includes('common.transparentWindow'),
  'UI 守卫：桌面专属设置仍被过滤',
  '快捷键/更新/窗口/透明窗口',
)
const networkOverride = readFileSync(
  path.join(ROOT, 'ui/overrides/views/Setting/AppSetting/Network.svelte'),
  'utf8',
)
assert(
  !networkOverride.includes('disabled={!import.meta.env.VITE_IS_DESKTOP}'),
  'UI 守卫：Android 网络代理不退回桌面禁用态',
  '未找到桌面 disabled 条件',
)

// ---- 媒体资源必须被 shrink-assets 改过名 -------------------------------------
// aapt2 对 .wav 不压缩（Stored），改名成 .wav.bin 才能被 deflate。
// 漏做的话 APK 会静默大 4.8 MB，所以放在冒烟门禁里。
const storedMedia = assets.filter((f) => /\.(wav|mp3)$/i.test(f))
assert(storedMedia.length === 0, '媒体资源已改名为 .bin（aapt 才会压缩）', storedMedia.length ? storedMedia.slice(0, 3).join(', ') : 'none')

/* ------------------------------------------------------------------ *
 * 2. 行为检查（打 bundle 再跑）
 * ------------------------------------------------------------------ */
console.log('\n[2/3] 行为检查（移植层 shims / Ports / Store）')

const smokeConfig = path.join(ROOT, 'scripts/smoke.vite.config.mjs')
// 直接用 vite 的 build API（不走 CLI）：项目路径里带空格，`execFileSync + shell:true`
// 在 Windows 上会把 "Any Listen移植apk" 从空格处截断。
const { build } = await import('vite')
await build({ configFile: smokeConfig, logLevel: 'warn' })

const smokeModuleUrl = new URL(`file://${path.join(ROOT, 'node_modules/.cache/anylisten-smoke/smoke.mjs').replace(/\\/g, '/')}`)
const { runSmoke } = await import(smokeModuleUrl.href)
if (process.env.QA_VM_GROWTH_ONLY) {
  const { qaVmGrowth } = await import(smokeModuleUrl.href)
  await qaVmGrowth()
  console.log('vm growth probe completed')
  process.exit(0)
}
const { results, nativeCalls } = await runSmoke()
for (const item of results) {
  if (item.ok) pass(item.name, item.detail)
  else fail(item.name, item.detail)
}
assert(nativeCalls > 0, 'Ports RPC 真实走通', `${nativeCalls} 次原生调用`)

/* ------------------------------------------------------------------ *
 * 3. sql.js（SqlitePort 的底座）
 * ------------------------------------------------------------------ */
console.log('\n[3/3] sql.js（SqlitePort 底座）')

const initSqlJs = (await import('sql.js')).default
const sqlJsWasm = path.join(ROOT, 'node_modules/sql.js/dist/sql-wasm.wasm')
if (!existsSync(sqlJsWasm)) {
  fail('sql.js wasm', `找不到 ${sqlJsWasm}`)
} else {
  const SQL = await initSqlJs({ locateFile: () => sqlJsWasm })
  const db = new SQL.Database()
  db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, meta TEXT)')
  db.run("INSERT INTO t (name, meta) VALUES (?, ?)", ['安听', JSON.stringify({ playCount: 0 })])
  const stmt = db.prepare('SELECT id, name, meta FROM t WHERE name = ?')
  stmt.bind(['安听'])
  let row = null
  if (stmt.step()) row = stmt.getAsObject()
  stmt.free()
  assert(row?.name === '安听', 'sql.js 建表/插入/查询（含中文）', JSON.stringify(row))

  const exported = db.export()
  assert(exported.length > 1024, 'sql.js export 产出有效字节流', `${exported.length} bytes`)
  const reopened = new SQL.Database(exported)
  const count = reopened.exec('SELECT COUNT(*) AS c FROM t')[0].values[0][0]
  assert(count === 1, 'export → 重新打开后数据仍在', `count=${count}`)
  db.close()
  reopened.close()
}

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */
console.log('\n' + '─'.repeat(52))
for (const note of notes) console.log(`  · ${note}`)
if (failures.length) {
  console.error(`\n冒烟失败：${failures.length} 项`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log('\n冒烟通过 ✔')
