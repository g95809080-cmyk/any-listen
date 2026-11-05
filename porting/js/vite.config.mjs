/**
 * Any Listen Android 端口层 —— JS 侧构建配置
 *
 * 核心原则：**零改上游源码**。所有平台差异都在本文件通过「解析期重定向」实现：
 *
 * 1. `node:*` 与裸 `path/fs/crypto/...` → `porting/js/shims/*`
 *    桌面版是 Node 进程，Android 是 WebView（只有 Web API），这一层是必须的。
 * 2. `@/xxx` → 按 **importer 位置** 决定根：
 *    - importer 在 `view-main/src` 里 → `view-main/src/xxx`（上游组件内部的 `@/` 不能被劫走）
 *    - 其它 → 先查 `porting/js/host/xxx`（AndroidShell 稀疏覆盖）→ `web-server/src/xxx` → `view-main/src/xxx`
 *    - `@ui/xxx` 是显式写死的 `view-main/src/xxx`，给覆盖层文件用（避免与 `host/` 撞名）
 * 3. `@any-listen/nodejs/*` 与上游包内的相对导入 → 先查覆写表，未命中用上游原文件
 *    （相对导入也必须过一遍，否则 `mirrorReuqest.ts` 里的 `./request` 会绕过 alias 拿到 undici 版）。
 *    裸 `@any-listen/app/*` 会被 Vite 内置 alias 抢先处理，需要覆写时用 `PACKAGE_OVERRIDES`
 *    的精确 alias，不能只写进 `OVERRIDES`。
 * 4. `better-sqlite3` → `ports/sqlite.ts`（sql.js WASM）
 * 5. UI 覆盖（O-1..O-5）→ `ui/overrides/...`，同样是覆写表的一条，不区分来源写法。
 *
 * 任何被 `OVERRIDES` 命中的条目都必须在 README 的「覆写清单」里有一条对应说明。
 */
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { svelte, vitePreprocess } from '@sveltejs/vite-plugin-svelte'
import pxtorem from 'postcss-pxtorem'
import { defineConfig } from 'vite'
import { createSvgIconsPlugin } from 'vite-plugin-svg-icons'

import svelteConfig, { lessConfig } from '../../source/packages/view-main/svelte.config.js'

/**
 * Svelte 预处理：**不用**上游 `svelte.config.js` 里的 `sveltePreprocess`，改用官方的
 * `vitePreprocess()`。两个原因：
 *
 * 1. 上游那份是 `sveltePreprocess({ typescript: { tsconfigFile: <view-main tsconfig> } })`，
 *    那个 tsconfig 的 `rootDir` 是 view-main —— 我们的 `ui/*.svelte` 在它之外，
 *    直接复用会报 `TS6059: File ... is not under 'rootDir'`；
 * 2. 就算改成 `transpileOnly`，`svelte-preprocess` 内部用的是 `source/` 那份 **TypeScript 6**，
 *    它会为 `moduleResolution` 之类的旧选项抛 deprecation 诊断，而 `svelte-preprocess`
 *    把任何诊断都当致命错误。
 *
 * `vitePreprocess()` 的做法是：
 * - `<script lang="ts">` 交给 **esbuild** 剥类型（快、无类型诊断，类型安全由 `pnpm typecheck` 管）；
 * - `<style lang="less">` 交给 **vite 自己的 CSS 管线**，因此 `css.preprocessorOptions.less`
 *   的 `modifyVars`（全局注入 `mixin.less`，上游组件靠 `.mixin-ellipsis-1()` 等）与
 *   postcss 的 pxtorem **都会生效** —— 这一点比 svelte-preprocess 更正确（后者会绕过 postcss）。
 *
 * `compilerOptions.runes = true` 必须继承：上游组件全部是 runes 写法（`$props()` / `$derived()`）。
 */
const mobileSvelteConfig = {
  compilerOptions: svelteConfig.compilerOptions,
  configFile: false,
  preprocess: vitePreprocess(),
}

const ROOT = path.dirname(fileURLToPath(import.meta.url))
/** `source/packages` —— 上游 monorepo 的包目录 */
const PKGS = path.resolve(ROOT, '../../source/packages')
/** `web-server/src` —— AndroidShell 侧 `@/` 的上游根 */
const WS_SRC = path.join(PKGS, 'web-server/src')
/** `view-main/src` —— UI 侧 `@/` / `@ui/` 的上游根 */
const VM_SRC = path.join(PKGS, 'view-main/src')
const NODEJS_SRC = path.join(PKGS, 'shared/nodejs')

/** 上游文件 → porting 覆写（key = 相对 `source/packages` 的路径，可带 `.svelte` 扩展名） */
const OVERRIDES = {
  // —— @any-listen/nodejs ——
  // 根入口：只覆盖 fileSha256 / *Sync / getPlatform 等 6 个函数，其余 `export *` 沿用上游
  'shared/nodejs/index': 'nodejs/index.ts',
  'shared/nodejs/request': 'nodejs/request.ts', // undici → HttpPort
  'shared/nodejs/download': 'nodejs/download.ts', // node:http 流式 → HttpPort.downloadTo
  'shared/nodejs/download/index': 'nodejs/download.ts',
  'shared/nodejs/watcher': 'nodejs/watcher.ts', // chokidar → FileSystemPort.watch
  'shared/nodejs/Store': 'nodejs/Store.ts', // 同步 IO → 内存同步 + 异步原子落盘
  'shared/nodejs/SafeFS': 'nodejs/SafeFS.ts',
  'shared/nodejs/music': 'nodejs/music.ts', // parseFile → readFile + parseBuffer
  'shared/nodejs/music-metadata': 'nodejs/music-metadata.ts',
  'shared/nodejs/tar': 'nodejs/tar.ts', // tar 包 → TarPort（Kotlin 侧解压）
  'shared/nodejs/logs': 'nodejs/logs.ts', // child_process.exec → LogPort
  // —— @any-listen/app ——
  // worker 工厂：`new Worker(path.join(__dirname, ...))` → `new Worker(url, { type: 'module' })`
  'shared/app/modules/worker/utils/index': 'host/worker/index.ts',
  // worker 子侧：`parentPort.once('message')` + `port instanceof MessagePort` → 原生 MessagePort
  'shared/app/modules/worker/utils/worker': 'host/worker/expose.ts',
  'shared/app/modules/worker/extensionService/shared/configStore':
    'host/app/modules/worker/extensionService/shared/configStore.ts',
  'shared/app/modules/worker/extensionService/shared/index':
    'host/app/modules/worker/extensionService/shared/index.ts',
  // —— view-main UI（Phase 5 触控改造）——
  // 只覆盖"结构必须变"的组件；样式类调整全部走 ui/mobile.less，不动上游文件
  // O-1：曲库歌曲列表（行高 72dp + 多选操作条）。其余覆盖项（ListItem / LyricPlayer /
  // Search）本批次**不做**，理由见 README §7：长按已由 `ui/compositions/longPress.ts`
  // 在 document 层统一转 contextmenu（覆盖全部 34 处右键菜单），不需要在 ListItem 里透传指针事件；
  // 歌词字号与曲库布局全部由 ui/mobile.less 解决。
  // Search：**此前"需要先定 IPC 搜索契约"的判断是错的**（已更正）。搜索链路上游是完整的 ——
  // `rendererEvent/resource.ts:25-70` 有 `tipSearch` / `hotSearch` / `musicSearch` / `songlistSearch`
  // 等全套 expose，`views/Online/Search/**` 的单曲与歌单搜索 UI 也是完整的。真正缺的只有
  // **专辑 / 歌手**两页（`Search/Album/Album.svelte` 与 `Search/Singer/Singer.svelte` 都只有
  // `<style>` 没有模板，且 `albumSearch` / `singerSearch` 在 resource.ts 里没有 expose），
  // 而 `views/Search/index.svelte` 只是这 5 个路由的占位壳。所以移动端要接搜索，落点是
  // `/online?t=search&q=…`（不是 `/search`），前置条件是先装扩展。
  'view-main/src/components/common/MusicList/List/index.svelte':
    'ui/overrides/components/common/MusicList/List/index.svelte',
  // 搜索页的在线列表没有上游 `playOnlineList()` 所支持的 `songlist` / `topSongs`
  // 后台补全接口；搜索结果是快照，直接建立队列即可。其余来源继续走上游实现。
  'view-main/src/components/common/MusicList/List/action':
    'ui/overrides/components/common/MusicList/List/action.ts',
  // O-8：播放列表（队列）的点击语义（D-16 的第二个入口）。上游用 `createClickHandle` 做
  // 400ms 双击窗口，首击空转、二次才切歌；触屏没有双击概念，改为单击即切歌。
  // 与 O-1（曲库列表）是同一缺陷的两个入口，必须一起改，否则"点歌不响"只是换个界面复现。
  'view-main/src/components/common/PlaylistBtn/shared':
    'ui/overrides/components/common/PlaylistBtn/shared.ts',
  // O-7：播放详情页顶栏（D-10 根因①）。上游模板只在 `VITE_IS_DESKTOP` / `VITE_IS_WEB`
  // 分支里渲染顶栏，本构建两者都为 false → `bind:this={domBtns}` 永不赋值，而 `onMount`
  // 里 `domBtns!.addEventListener(...)` 直接抛 TypeError，整个播放详情组件树刷新中断（整屏白）。
  // 覆写只做两件事：① 挂监听前判空（清理函数同样判空）；② 补 `VITE_IS_ANDROID` 分支渲染顶栏
  // —— uiux §5 要求「播放详情顶栏控制键（关闭/全屏）→ 44dp」，没有它判空之后仍然没有关闭键。
  'view-main/src/components/layout/PlayDetail/Header.svelte':
    'ui/overrides/components/layout/PlayDetail/Header.svelte',
  // 无歌词时上游歌词区只剩空白。覆写只在歌词行为空时显示加载/暂无歌词状态；
  // 有歌词后继续挂载上游 LyricPlayer，滚动、高亮、制作信息过滤均保持原逻辑。
  'view-main/src/components/layout/PlayDetail/RightLyric/index.svelte':
    'ui/overrides/components/layout/PlayDetail/RightLyric/index.svelte',
  // 播放状态不使用上游内部异常文案；无歌词时迷你播放器显示歌手，而不是
  // “Failed to obtain lyrics”；音源重试耗尽时显示可行动的中文提示。
  'view-main/src/components/layout/PlayDetail/Footer/PlayStatusText.svelte':
    'ui/overrides/components/layout/PlayDetail/Footer/PlayStatusText.svelte',
  'view-main/src/components/layout/PlayBar/components/PlayInfo.svelte':
    'ui/overrides/components/layout/PlayBar/components/PlayInfo.svelte',
  // A-32：上游把“设置”勾选框写死为 disabled，覆写只恢复选择与回调。
  'view-main/src/views/Setting/AppSetting/Backup/typeSelectModal/App.svelte':
    'ui/overrides/views/Setting/AppSetting/Backup/typeSelectModal/App.svelte',
  // 部分音源把「作词/作曲/制作人」等制作人员表当作带时间戳的歌词行返回，
  // 播放详情页会把它们显示成歌词。初始化歌词时过滤这些元数据行，上游文件不动。
  'view-main/src/modules/lyric/init': 'ui/overrides/modules/lyric/init.ts',
  // O-2：曲库页空态。上游 `views/Library/index.svelte:157` 只有 `{#if listInfo}`、没有 else，
  // 而 `listInfo` 在 `$query.id` 为空时是 undefined → 内容区一个节点都不渲染（纯白、不报错）。
  // 覆写只改模板，script 段逐行保留。空态里的「导入本地音乐」是手机上加歌的**唯一入口**
  // （`importLocalFile()` 全仓只有桌面 Aside 的右键菜单在调，移动壳没有 Aside）。
  'view-main/src/views/Library/index.svelte': 'ui/overrides/views/Library/index.svelte',
  // O-9 / O-10：扩展商店的数据能加载之后的手机布局（D-33）。上游是桌面双列网格
  // （`minmax(300px,1fr)`）+ 卡片 `min-width:300px`，在 393px 视口里 pxtorem 把 300px 压到
  // ~174px → 排成两列 174px，而卡片仍按 280px 排版 → 互相压盖、右侧裁切；顶栏 5 个中文
  // Tab 也被压成竖排。改为单列 + 顶栏横向滚动。
  // 注意：`.list` / `.header` 都是被其它页面复用的类名，所以改在**组件内部**（Svelte scoped
  // style），不要写进全局 mobile.less。
  'view-main/src/views/Extenstion/OnlineList.svelte':
    'ui/overrides/views/Extenstion/OnlineList.svelte',
  'view-main/src/views/Extenstion/Header.svelte':
    'ui/overrides/views/Extenstion/Header.svelte',
  // O-11：与 O-9 同一张网格规则，只是用在「已安装」列表上。装完扩展就会复现同样的压盖，
  // 一起改，避免"修了商店、装完又坏"。
  'view-main/src/views/Extenstion/InstalledList.svelte':
    'ui/overrides/views/Extenstion/InstalledList.svelte',
  // O-12：扩展卡片是桌面定尺（`height:100px` + `min-width:300px`）。本构建根字号 ~9.3px，
  // 100px 经 pxtorem 只剩 58px，内容要 ~94px → 描述文字压到版本行上（D-33）。
  // 改为高度自适应 + 宽度交给网格列。
  'view-main/src/views/Extenstion/ListItemOnline.svelte':
    'ui/overrides/views/Extenstion/ListItemOnline.svelte',
  // 文件浏览时单击进入目录；目录选择模式仍保留选中目录的能力。
  'view-main/src/components/material/fileExplorerModal/ListItem.svelte':
    'ui/overrides/components/material/fileExplorerModal/ListItem.svelte',
  // 上游把「文件名 + 新建文件夹」和「取消 + 确定」挤在同一行。手机窄屏下
  // 文件名标签被压成竖排，两组按钮互相重叠。底栏改为可换行：文件名一行，按钮一行。
  'view-main/src/components/material/fileExplorerModal/FileListModal.svelte':
    'ui/overrides/components/material/fileExplorerModal/FileListModal.svelte',
  'view-main/src/components/material/fileExplorerModal/Save.svelte':
    'ui/overrides/components/material/fileExplorerModal/Save.svelte',
  // O-6：`@/shared/ipc/app` 的两个文件对话框。
  // 上游桌面走 `ipc.showOpenDialog`，Android host **没有也不需要**这个实现（原生 SAF 选择器
  // 拿到的 content:// URI 喂不进 `shims/fs`）；网页版走的是内置文件浏览器弹窗
  // （`components/material/fileExplorerModal`，只依赖我们已经实现的
  // `fileSystemAction read_root_dir/read_dir`）。我们的构建把 `VITE_IS_WEB` 硬编码为 false，
  // 所以上游那个 `if (VITE_IS_WEB)` 分支被摇掉、永远走 ipc → 点「导入本地音乐」抛
  // `showOpenDialog is not defined`。覆写只替换这两个导出，其余 30 多个转发函数用
  // `export * from '@ui-raw/shared/ipc/app'` 原样继承（不抄一遍，避免上游加函数时漏）。
  // **不要翻转全局 VITE_IS_WEB**：它在 view-main/src 里有 37 处使用（App.svelte 根节点、
  // Header、Modal header、mediaSession 等），整体翻转会连带改掉壳层渲染。
  'view-main/src/shared/ipc/app/index': 'ui/overrides/shared/ipc/app/index.ts',
  // —— web-server（AndroidShell 侧）——
  // 上游第 40 行 `readFile(joinPath(__dirname, 'extension-preload.js'))` 在 Worker 里是
  // `ReferenceError`，会让 core.worker 启动失败、UI 永久卡在 Loading。改成 fetch 静态资源。
  // 说明见 host/app/modules/extension/index.ts 的文件头。
  'web-server/src/app/modules/extension/index': 'host/app/modules/extension/index.ts',
}

/**
 * `@any-listen/app/*` 是上游包对外使用的裸包名，Vite 内置 alias 会先于本插件解析。
 * 因此这类入口必须用精确 alias 抢在通用 `@any-listen/app` 映射之前接管；只写 `OVERRIDES`
 * 不会生效（真机实测：设置勾选成功，但导出的备份文件仍只有歌单）。
 */
const PACKAGE_OVERRIDES = [
  {
    // A-31：上游备份模块只导出/恢复歌单，设置项在 UI 与 importData 里都被禁用。
    // 覆写补齐设置快照与安全恢复；source/ 不动。
    find: /^@any-listen\/app\/modules\/backup$/,
    replacement: 'host/app/modules/backup/index.ts',
  },
]

/** 绕过覆写，强制指回上游原文件（供覆写文件内部引用"上游版本"） */
const RAW_TARGETS = {
  '@any-listen/nodejs/uplink': 'shared/nodejs/index',
  // 扩展模块的 `export *` 出口：让 host/app/modules/extension 能"只用上游的转发层、
  // 只替换 initExtension/restartExtensionHost"，不必把 60 多个导出抄一遍（见该文件注释）
  '@porting-uplink/web-server/app/modules/extension': 'web-server/src/app/modules/extension/index',
  // `@/shared/ipc/app` 的 `export *` 出口：让 `ui/overrides/shared/ipc/app/index.ts`
  // 只替换 showOpenDialog / showSaveDialog，其余转发函数全部沿用上游（同 extension 的作法）
  '@ui-raw/shared/ipc/app': 'view-main/src/shared/ipc/app/index',
  '@ui-raw/components/material/fileExplorerModal/ListItem.svelte':
    'view-main/src/components/material/fileExplorerModal/ListItem.svelte',
  '@ui-raw/components/common/MusicList/List/action':
    'view-main/src/components/common/MusicList/List/action',
}

/** Node 内建模块 → shims。键必须写全，不接受 `node:x/y` 前缀模糊匹配（会串味） */
const NODE_SHIMS = {
  'node:path': 'shims/path.ts',
  path: 'shims/path.ts',
  'node:fs': 'shims/fs.ts',
  fs: 'shims/fs.ts',
  'node:fs/promises': 'shims/fs-promises.ts',
  'fs/promises': 'shims/fs-promises.ts',
  'node:crypto': 'shims/crypto.ts',
  crypto: 'shims/crypto.ts',
  'node:zlib': 'shims/zlib.ts',
  zlib: 'shims/zlib.ts',
  'node:os': 'shims/os.ts',
  os: 'shims/os.ts',
  'node:url': 'shims/url.ts',
  url: 'shims/url.ts',
  'node:querystring': 'shims/querystring.ts',
  querystring: 'shims/querystring.ts',
  'node:events': 'shims/events.ts',
  events: 'shims/events.ts',
  'node:stream': 'shims/stream.ts',
  stream: 'shims/stream.ts',
  'node:vm': 'shims/vm.ts',
  vm: 'shims/vm.ts',
  'node:worker_threads': 'shims/worker_threads.ts',
  'node:http': 'shims/http.ts',
  http: 'shims/http.ts',
  'node:https': 'shims/http.ts',
  https: 'shims/http.ts',
  'node:net': 'shims/net.ts',
  'node:child_process': 'shims/child_process.ts',
  'node:perf_hooks': 'shims/perf_hooks.ts',
  'node:timers/promises': 'shims/timers-promises.ts',
  'node:timers': 'shims/timers.ts',
  'node:buffer': 'shims/buffer.ts',
  // 注意：**不要**把裸 `buffer` 也映射到 shims/buffer.ts —— 那里是 `export * from 'buffer'`，
  // 自引用会让 rollup 报 "Buffer cannot be exported ... reexport that references itself"。
  'node:process': 'shims/process.ts',
  process: 'shims/process.ts',
  'node:module': 'shims/module.ts',
  'node:util': 'shims/util.ts',
  // 原生模块
  'better-sqlite3': 'ports/sqlite.ts',
}

/**
 * Vite / Rollup 的模块 id 统一用正斜杠。Windows 上 `path.join` 产出的是反斜杠，
 * 而插件按 id 建缓存（svelte 的虚拟 CSS 模块 `/x.svelte?svelte&type=style&lang.css` 就在其列）——
 * 不归一化会出现「编译时缓存了 A\x.svelte，加载时请求 A/x.svelte」导致 style 块整块丢失。
 */
function norm(p) {
  return p.replace(/\\/g, '/')
}

/** 候选补全：允许省略扩展名 / 指向目录 index。`.svelte` 必须在列，否则 `@/views/Library` 解析不到 */
const SUFFIXES = ['', '.ts', '.tsx', '.svelte', '/index.ts', '/index.tsx', '/index.svelte']

function firstFile(base) {
  for (const suffix of SUFFIXES) {
    const candidate = base + suffix
    if (existsSync(candidate) && statSync(candidate).isFile()) return norm(candidate)
  }
  return null
}

/** 把绝对路径归一化为 `相对 source/packages` 的无扩展名 key */
function toKey(absFile) {
  const rel = path.relative(PKGS, absFile).replace(/\\/g, '/')
  if (rel.startsWith('..')) return null
  return rel.replace(/\.tsx?$/, '')
}

function anylistenAliasPlugin() {
  return {
    name: 'anylisten-android-alias',
    enforce: 'pre',

    resolveId(source, importer) {
      /* 0. 移植层内部自引用：`@porting/xxx` → porting/js/xxx（比相对路径稳，挪文件不会断链） */
      if (source.startsWith('@porting/')) {
        return firstFile(path.join(ROOT, source.slice('@porting/'.length)))
      }

      /* 1. 显式绕过覆写 */
      const rawKey = RAW_TARGETS[source]
      if (rawKey) return firstFile(path.join(PKGS, rawKey))

      /* 2. Node 内建 + 原生模块 */
      const shim = NODE_SHIMS[source]
      if (shim) return norm(path.join(ROOT, shim))

      /* 3. `@/xxx` / `@ui/xxx`：按 importer 位置决定根，再套覆写表 */
      if (source.startsWith('@/') || source.startsWith('@ui/')) {
        const explicitViewMain = source.startsWith('@ui/')
        const rel = source.slice(explicitViewMain ? '@ui/'.length : 2)

        const bases = []
        if (explicitViewMain) {
          bases.push(VM_SRC)
        } else if (importer && isInside(importer, VM_SRC)) {
          // 上游 UI 组件内部的 `@/` 指的是 view-main/src，**不能**被 host/ 或 web-server 抢走
          bases.push(VM_SRC)
        } else {
          bases.push(path.join(ROOT, 'host'), WS_SRC, VM_SRC)
        }

        for (const base of bases) {
          const file = firstFile(path.join(base, rel))
          if (file) return applyOverride(file)
        }
        return null
      }

      /* 4. `@any-listen/nodejs[/sub]` —— 先查覆写表，未命中才用上游原文件 */
      if (source === '@any-listen/nodejs' || source.startsWith('@any-listen/nodejs/')) {
        const sub = source === '@any-listen/nodejs' ? 'index' : source.slice('@any-listen/nodejs/'.length)
        return resolveUpstreamWithOverride(path.join(NODEJS_SRC, sub))
      }

      /* 5. 上游包内部的相对导入：**只有命中覆写表才接管**，其余交给 vite 正常解析。
         这样既保证 `./request` 这类不会绕过覆写拿到桌面实现，又不会把
         `?raw` / `?url` 查询串、css/svg 资源、`./index.svelte` 之类的相对解析引到自己身上。 */
      if (importer && (source.startsWith('./') || source.startsWith('../')) && !source.includes('?')) {
        const abs = path.resolve(path.dirname(importer), source)
        if (!path.relative(PKGS, abs).startsWith('..')) {
          const file = firstFile(abs)
          if (file) {
            const override = OVERRIDES[toKey(file) ?? '']
            if (override) return norm(path.join(ROOT, override))
          }
        }
      }

      return null
    },
  }
}

/** 命中覆写表则返回覆写实现，否则返回原文件 */
function applyOverride(absFile) {
  const override = OVERRIDES[toKey(absFile) ?? '']
  return override ? norm(path.join(ROOT, override)) : absFile
}

function isInside(target, dir) {
  const rel = path.relative(dir, path.resolve(target))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** 命中覆写表则返回覆写实现，否则返回上游原文件（找不到返回 null） */
function resolveUpstreamWithOverride(absNoExt) {
  const file = firstFile(absNoExt)
  if (!file) return null
  return applyOverride(file)
}

/** 只返回上游原文件（用于 `@any-listen/nodejs` 中已被覆写的子模块本身） */
function resolveUpstream(absNoExt) {
  return firstFile(absNoExt)
}

export default defineConfig({
  root: ROOT,
  // 静态资源（sql.js / quickjs 的 wasm）由 scripts/copy-wasm.mjs 拷到 public/wasm
  publicDir: path.join(ROOT, 'public'),
  plugins: [
    anylistenAliasPlugin(),
    // 必须在上游 svelte 配置下编译：`compilerOptions.runes = true`（上游是 Svelte 5 runes 写法）
    // + svelte-preprocess（`<script lang="ts">` / `<style lang="less">` + mixin.less 注入）
    svelte(mobileSvelteConfig),
    // `SvgIcon` 组件用 `<use href="#icon-xxx">` 引用 sprite，必须由虚拟模块注册
    createSvgIconsPlugin({ iconDirs: [path.join(VM_SRC, 'assets/svgs')] }),
  ],
  /**
   * 关键：vite 为 `new Worker(new URL(...))` / `?worker&url` 会起一个**嵌套 rollup 构建**，
   * 而嵌套构建只用 `worker.plugins`（默认 `() => []`），**不继承顶层 `plugins`**。
   * 不在这里再给一次，worker 内部的 `node:*` / `@/` / `@any-listen/nodejs` 会全部解析失败
   * （表现为 `[vite:worker-import-meta-url] Rollup failed to resolve import ...`）。
   */
  worker: {
    format: 'es',
    plugins: () => [anylistenAliasPlugin()],
  },
  resolve: {
    dedupe: ['message2call'],
    // 上游包通过 pnpm workspace 软链接引用。`porting/js` 不在 source/ 的 workspace 里，
    // 所以 Node 的向上查找到不了 `source/packages/web-server/node_modules`。
    // 这里显式把 `@any-listen/*` 指到真实目录（`@any-listen/nodejs` 由插件处理，不在此列）。
    alias: [
      // 精确包名覆写必须放在通用 `@any-listen/app` 之前（详见 PACKAGE_OVERRIDES 注释）
      ...PACKAGE_OVERRIDES.map(({ find, replacement }) => ({
        find,
        replacement: path.join(ROOT, replacement),
      })),
      // 裸 `buffer` 会被 vite 当成 Node 内建而 externalize（node-forge 依赖的 safe-buffer 会因此拿到空模块）。
      // 指到真实包，既不自引用也不会被 externalize。
      { find: 'buffer', replacement: path.join(ROOT, 'node_modules/buffer/index.js') },
      { find: '@any-listen/app', replacement: path.join(PKGS, 'shared/app') },
      { find: '@any-listen/common', replacement: path.join(PKGS, 'shared/common') },
      { find: '@any-listen/i18n', replacement: path.join(PKGS, 'shared/i18n') },
      { find: '@any-listen/theme', replacement: path.join(PKGS, 'shared/theme') },
      { find: '@any-listen/web', replacement: path.join(PKGS, 'shared/web') },
      { find: '@any-listen/types', replacement: path.join(PKGS, 'shared/types') },
      // `music-metadata` 是纯 JS 包（能被 WebView 执行），但它只装在
      // `source/packages/shared/nodejs/node_modules` 下（pnpm 不提升）。
      // 这里直指该目录，好处是版本与上游**强绑定**，不会出现"移植层解析出的元数据
      // 与桌面版不一致"的漂移。确需独立安装时，把这条换成普通 dependency 即可。
      {
        find: 'music-metadata',
        replacement: path.join(PKGS, 'shared/nodejs/node_modules/music-metadata'),
      },
    ],
    // 上游包通过 pnpm workspace 软链接引用，保留真实路径便于排查
    preserveSymlinks: false,
  },
  define: {
    // arch §6.3：三段式条件分支，未定义会静默落到 web 分支 —— 必须显式给值
    'import.meta.env.VITE_IS_ANDROID': 'true',
    'import.meta.env.VITE_IS_DESKTOP': 'false',
    'import.meta.env.VITE_IS_WEB': 'false',
    'import.meta.env.VITE_IS_MAC': 'false',
    'import.meta.env.VITE_COMMIT_ID': JSON.stringify('android'),
    'import.meta.env.VITE_APP_VERSION': JSON.stringify('0.12.1-android'),
    __GIT_COMMIT__: JSON.stringify('android'),
    __GIT_COMMIT_DATE__: JSON.stringify(''),
    __ANYLISTEN_APP_VERSION__: JSON.stringify('0.12.1-android'),
    // 上游若干处以 `process.env.NODE_ENV === 'production'` 做分支
    'process.env.NODE_ENV': JSON.stringify('production'),
    // 上游用 `global.anylisten`（Node 全局），WebView 里只有 globalThis
    global: 'globalThis',
  },
  build: {
    target: 'esnext',
    outDir: 'dist/spa',
    // 清理由 `scripts/clean.mjs` 在构建前显式完成（`pnpm build` 的第一步），
    // 不用 vite 内置的 emptyOutDir：它只清 outDir 自身、且在配置解析后执行，
    // 早期实测某些环境里 rmSync 被替换成 trash 实现会抛 "Error during a trash operation"
    // 被 vite 当成致命错误。自己清还能顺带处理 dist/extension-preload 与 *.old.* 残留。
    emptyOutDir: false,
    // WebView 调试期保留可读产物：Android 上没法 sourcemap 调试，靠日志定位
    minify: false,
    sourcemap: true,
    cssCodeSplit: false,
    assetsInlineLimit: 0,
    reportCompressedSize: false,
    rollupOptions: {
      // 只有 html 一个 input：4 个 worker 通过 `new URL('./x.worker.ts', import.meta.url)`
      // 由 rollup 自动产出为独立 chunk（比 ?worker 后缀更可控，也不会被内联成 blob）
      input: { main: path.join(ROOT, 'index.html') },
      output: {
        format: 'es',
        // 固定布局：dist/spa/assets/<name>.<hash>.js
        entryFileNames: 'assets/[name].[hash].js',
        chunkFileNames: 'assets/[name].[hash].js',
        assetFileNames: 'assets/[name].[hash][extname]',
        // sql.js / quickjs 的 wasm 走 publicDir，不进 bundle
        manualChunks: undefined,
      },
    },
  },
  /**
   * 原样复制上游 `view-main/vite.config.js:169-205` 的 less + postcss 配置。
   *
   * **`pxtorem.rootValue` 必须是 16，且 `selectorBlackList: ['html','ignore-to-rem']` 不能改**
   * （team-lead 硬约束）：改 rootValue 会同时缩放宽高与 padding，411dp 宽度下必然溢出；
   * 而 `selectorBlackList` 里含 `'html'` 正是 `ui/mobile.less` 能"写 px 就是 dp"的前提
   * （`selector.includes('html')` 匹配 → 我们的规则全部跳过 rem 转换）。
   */
  css: {
    preprocessorOptions: {
      less: {
        ...lessConfig,
        javascriptEnabled: true,
      },
    },
    postcss: {
      plugins: [
        pxtorem({
          rootValue: 16,
          unitPrecision: 5,
          propList: [
            'font',
            'font-size',
            'letter-spacing',
            'padding',
            'margin',
            'padding-*',
            'margin-*',
            'height',
            'width',
            '*-height',
            '*-width',
            'flex',
            '::-webkit-scrollbar',
            'top',
            'left',
            'bottom',
            'right',
            'border-radius',
            'border',
            'border-*',
            'grid-template-columns',
            'gap',
          ],
          selectorBlackList: ['html', 'ignore-to-rem'],
          replace: true,
          mediaQuery: false,
          minPixelValue: 0,
          exclude: /node_modules/i,
        }),
      ],
    },
  },
  esbuild: {
    target: 'esnext',
    legalComments: 'none',
  },
})
