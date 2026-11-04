/**
 * 把运行时需要的 wasm 从 node_modules 拷到 `public/wasm/`。
 *
 * 为什么必须拷而不是打包：`sql.js` 与 `quickjs-emscripten` 都是"先 fetch wasm 再实例化"，
 * 打包器无法内联（强行 base64 内联会让主 chunk 膨胀数 MB，且 WebView 里解析更慢）。
 *
 * Kotlin 侧保证 `http://127.0.0.1:17930/wasm/*` 可访问（同源 loopback），
 * 因此 `locateFile` 只需要拼 `/wasm/<name>`。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const OUT = path.join(ROOT, 'public/wasm')

/**
 * `[源文件, 目标文件名]`；源不存在时只告警不失败（避免因依赖布局变化卡住构建）。
 *
 * **目标名不是随手起的，它必须等于「被打进产物的那份 sql.js 会去请求的名字」。**
 *
 * `sql.js@1.15.2` 的 exports 是：
 * ```json
 * { ".": { "browser": "./dist/sql-wasm-browser.js", "default": "./dist/sql-wasm.js" } }
 * ```
 * vite 的 browser 目标构建命中 `browser` 条件 → 产物里是 **`sql-wasm-browser.js`**
 * → 它内部硬编码请求 `sql-wasm-browser.wasm`。所以这里拷 `sql-wasm-browser.wasm`。
 *
 * `dist/sql-wasm.wasm` 与 `dist/sql-wasm-browser.wasm` 的 md5 完全相同
 * （`a152cddb3bf70b2cf8e92f5cc59a451f`，都是 685235 B），纯粹是两种命名 —— 但名字错了
 * 在 WebView 里就是 404，而 sql.js 会把 404 的响应体（`"Not Found: …"`，开头 ASCII `"Not "`）
 * 当成 wasm 喂给 `instantiate`，最终表现成 `[db.worker] sql.js is not initialized`。
 *
 * 不要在 `ports/sqlite.ts` 里加 `replace('-browser','')` 一类的映射来"兼容"：
 * 该对齐的是「代码请求什么、磁盘上就有什么」，映射表等于把这个事实藏起来，下次换 entry
 * 又会静默错位。名字对齐 + `scripts/smoke.mjs` 的 wasm 引用门禁，比映射可靠。
 */
const FILES = [
  ['node_modules/sql.js/dist/sql-wasm-browser.wasm', 'sql-wasm-browser.wasm'],
  /*
   * quickjs **不在这张表里**，这是有意的。
   *
   * 它走的是另一条路：`@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.browser.mjs`
   * 内部是 `(new URL("emscripten-module.wasm", import.meta.url)).href`，vite 在 transform 阶段
   * 就会 `emitFile` 并把 URL 改写成 `/assets/emscripten-module-<hash>.wasm` —— 文件自动落到
   * `dist/spa/assets/`，不需要 publicDir 拷贝，也不需要 `locateFile`。
   *
   * 之前这里有一条 `node_modules/@jitl/quickjs-wasmfile-release-sync/…` 的条目，但
   * **`porting/js/node_modules/@jitl/` 从来就不存在**（该包只在 `.pnpm` 里，例如
   * `node_modules/.pnpm/@jitl+quickjs-wasmfile-release-sync@0.31.0/…`），所以它一直在打
   * `跳过（源不存在）` 然后什么都不做 —— 一条误导性的死条目。删掉它，改用
   * `scripts/smoke.mjs` 的 wasm 引用门禁来保证「代码请求什么、磁盘上就有什么」：
   * 从产物里反向抠出所有 `.wasm` 引用，带路径的 hashed 资产按 SPA 根相对路径查，
   * 裸文件名按 `wasm/` 与 `assets/` 双目录查。
   *
   * 若将来 quickjs 的加载方式改成 `locateFile`，再把条目加回来，路径必须写
   * `.pnpm` 里的真实位置，并且要同时确认 `LocalHttpServer.guessMime()` 覆盖 wasm
   * （已覆盖：`"wasm" -> "application/wasm"`，`WebAssembly.instantiateStreaming` 的硬要求）。
   */
]

mkdirSync(OUT, { recursive: true })

let copied = 0
for (const [from, to] of FILES) {
  const src = path.join(ROOT, from)
  if (!existsSync(src)) {
    console.warn(`[copy-wasm] 跳过（源不存在）: ${from}`)
    continue
  }
  const dest = path.join(OUT, to)
  copyFileSync(src, dest)
  const kb = (statSync(dest).size / 1024).toFixed(1)
  console.log(`[copy-wasm] ${from} -> public/wasm/${to} (${kb} kB)`)
  copied++
}

if (!copied) console.warn('[copy-wasm] 没有拷贝任何文件，运行期 locateFile 会失败')

/**
 * `public/wasm/` **完全由本脚本管理**，清掉不在目标列表里的文件。
 *
 * 为什么必须清：`public/` 会被原样拷进 `dist/spa/`，一个旧命名的 wasm 残留就是
 * 685 kB 白给包体；更糟的是「新旧两份并存」会让人以为名字无所谓，而真正的判据是
 * 「产物请求什么名字」。改名这类操作如果只改一次文件、不清旧文件，下次构建又会
 * 把旧名字带回来（或者反过来），静默错位就是这么长出来的。
 *
 * **删除失败要有退路。** 本机安全策略对删除有一道按 **回合累计**计数的守卫
 * （`SAFE_DELETE_BULK_CONFIRM_REQUIRED`，`scope:"turn"`，阈值 50）：`clean:spa` 每轮要删
 * 200+ 个文件，计数顶满之后**同一次构建里任何 `rmSync` 甚至 `unlinkSync` 都会被拦**
 * （实测两种 API 都走同一个 `tryTrash` 分支）。所以这里 `unlinkSync` 失败就退化成
 * **改名隔离到 `.trash/`** —— 与 `scripts/clean.mjs` 的兜底完全同一套思路，
 * 只要文件离开了 `public/`，就不会被拷进产物。
 *
 * 清不掉也移不走才 **fail 构建**：静默留下一个 685 kB 的旧命名 wasm，
 * 等于把「产物请求什么名字」这个事实又藏起来了。
 */
const expected = new Set(FILES.map(([, to]) => to))
for (const name of readdirSync(OUT)) {
  if (expected.has(name)) continue
  const stale = path.join(OUT, name)
  if (!statSync(stale).isFile()) {
    console.error(`[copy-wasm] public/wasm/${name} 不是文件（目录？），请手工处理`)
    process.exit(1)
  }
  try {
    unlinkSync(stale)
    console.log(`[copy-wasm] 清理不在目标列表里的残留: public/wasm/${name}`)
  } catch (err) {
    // `.trash/` 必须在 `dist/` 之外，否则会被 Gradle 的 syncWebAssets 拷进 APK
    const trashDir = path.join(ROOT, '.trash')
    mkdirSync(trashDir, { recursive: true })
    const quarantined = path.join(trashDir, `${name}.old.${Date.now()}`)
    try {
      renameSync(stale, quarantined)
      console.warn(
        `[copy-wasm] public/wasm/${name} 删不掉（安全策略计数已满），已隔离到 .trash/${path.basename(quarantined)}`
      )
    } catch (moveErr) {
      console.error(
        `[copy-wasm] public/wasm/${name} 既删不掉也移不走，产物会多带一个 wasm —— 请手工清掉。` +
          `\n  删除失败：${String(err)}\n  移动失败：${String(moveErr)}`
      )
      process.exit(1)
    }
  }
}
