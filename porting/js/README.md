# `porting/js` —— Any Listen Android 移植层（JS 侧）

> 目标：把桌面版 `source/packages` 下的**上游源码原样**跑进 Android WebView，**不修改 `source/` 下任何文件**。
> 全部平台差异都在构建期通过 vite 的解析重定向 + 运行期的 Port 适配层实现。

```
Node 桌面                                   Android
────────────────────────────────────        ─────────────────────────────────────────────
main process (Koa + ws + better-sqlite3)     core.worker (AndroidShell + @any-listen/app 全模块)
  ├─ renderer (Electron)                       ├─ db.worker    (SQLite → sql.js WASM)
  └─ native (chokidar / undici / tar)          ├─ util.worker  (元数据解析 / 文件遍历 / 网络)
                                               └─ ext.worker   (node:vm → QuickJS WASM)
                                             UI 主线程 (Svelte + Web Audio/AudioWorklet)
                                               ↕ MessagePort
                                             Kotlin 端口层 (FileSystem/Http/Sqlite/… 真实能力)
```

---

## 1. 快速开始

```bash
cd porting/js
pnpm install                 # 独立 pnpm 项目（不在 source/ 的 workspace 内）
pnpm typecheck               # tsc --noEmit（strict，仅对移植层本身设门禁）
pnpm build:all               # 产出 dist/spa + dist/**/*.worker.js + dist/extension-preload
pnpm smoke                   # 产物 + 行为冒烟（对标 Node 原生实现逐字节比对）
pnpm verify                  # 上面三步串联
```

环境：Node ≥ 22、pnpm ≥ 10、vite 6。无需 Android SDK / 设备（本层可在纯 Node 下验证）。

### 脚本

| 命令 | 实际做的事 |
|---|---|
| `pnpm typecheck` | `link-vendor` + `scripts/typecheck.mjs` → `tsc --noEmit`，**移植层文件必须 0 错误**（上游文件的 lib 冲突只统计不拦截，见 §9 第 3 条） |
| `pnpm link-vendor` | `scripts/link-vendor.mjs`：junction 联接上游同一份 svelte / vite 插件 / less / postcss（见 §11.1） |
| `pnpm clean[:spa\|:ext]` | `scripts/clean.mjs`：三级兜底清产物，垃圾落 `.trash/`（见 §9 第 8 条） |
| `pnpm copy-wasm` | 把 `sql.js` 的 wasm 拷到 `public/wasm/` |
| `pnpm build` | `link-vendor` → `clean:spa` → `copy-wasm` → `vite build` → `shrink-assets` |
| `pnpm shrink-assets` | `scripts/shrink-assets.mjs`：把 `.wav`/`.mp3` 改名为 `.bin` 并改引用，让 aapt2 肯压缩（省 ~4.8 MB，见 §8.1） |
| `pnpm build:extension-preload` | 单文件 **IIFE** 构建 `@any-listen/extension-preload`（`vite.extension-preload.config.mjs`） |
| `pnpm build:all` | 上面两个 |
| `pnpm smoke` | `scripts/smoke.mjs`：产物检查（含 UI 标记 / 媒体改名门禁）→ 行为检查 → sql.js 检查 |
| `pnpm verify` | `typecheck` + `build:all` + `smoke`（交付前必须全绿） |

---

## 2. 目录结构

```
porting/js/
├─ index.html                     WebView 入口页（viewport-fit=cover，禁缩放）
├─ vite.config.mjs                ★ alias / 覆写表 / define 常量 / 产物布局
├─ vite.extension-preload.config.mjs
├─ tsconfig.json                  strict: true
├─ types/
│  ├─ env.d.ts                    编译期常量 + `window` 扩展 + 上游 AnyListen 类型引用
│  └─ vite-env.d.ts               `?worker&url` 等查询后缀的类型
├─ entries/                       ★ 5 个入口（只有这里用 import.meta.url）
│  ├─ main.ts                     UI 主线程：Ports hub / __anylisten_ipc_init__ / AudioRouter / MediaSession shim
│  ├─ core.worker.ts              AndroidShell（"主进程等价物"）
│  ├─ db.worker.ts                SQLite
│  ├─ util.worker.ts              元数据 / 文件 / 网络
│  ├─ ext.worker.ts               扩展沙箱（QuickJS）
│  └─ bootstrap-message.ts        main ⇄ core 首条控制消息的 type-only 定义
├─ ports/                         Port 契约与客户端
│  ├─ types.ts                    15 个 Port 的接口 + PortError
│  ├─ bridge-client.ts            RPC 帧格式与 BridgeClient
│  ├─ sqlite.ts                   better-sqlite3 → sql.js WASM 适配器
│  └─ index.ts                    统一入口 `ports.fs` / `ports.http` / …
├─ shims/                         Node 内建模块替身（21 个）
├─ nodejs/                        @any-listen/nodejs 的覆写（9 个文件 + 根入口）
├─ host/                          稀疏覆盖层（对位 web-server/src，**只放平台语义不同的文件**）
│  ├─ bootstrap.ts                core.worker 的 8 步启动流程
│  ├─ app/app/index.ts            @/app/app  → initAppEnv / updateSetting / sendInitedEvent
│  ├─ app/modules/index.ts        @/app/modules → initModules（11 个）
│  ├─ app/modules/extension/index.ts  ★ 扩展模块：`__dirname` 读 preload → `fetch` 静态资源（见 §3.3.1）
│  ├─ app/modules/music/local.ts  本地音乐 URL / 封面 / 歌词（含 MUSIC_DEVICE_MISMATCH）
│  ├─ app/modules/fileSystem/     checkAllowPath / publicPath / readDir
│  ├─ app/shared/store.ts         getStore（内存同步 + 异步落盘）
│  ├─ app/renderer/winMain/autoUpdate.ts  自动更新 no-op（PDR-003）
│  ├─ modules/ipc/websocket.ts    虚拟 socket（替代 ws 服务端）
│  ├─ ipc/server.ts               ServerIPC 组装（message2call 暴露给 UI）
│  ├─ ipc/ports-hub.ts            主线程 Ports 集线器
│  ├─ worker/index.ts             ★ 覆写 @any-listen/app/modules/worker/utils/index.ts（Web Worker 工厂）
│  ├─ worker/expose.ts            ★ 覆写 .../utils/worker.ts（worker 侧 expose）
│  ├─ mediasession-shim.ts        navigator.mediaSession 运行时替身（metadata→state→actions 有序发布，见 §11.4）
│  └─ audio/engine-router.ts      音频引擎外壳（UI 线程）
├─ ui/                            ★ 移动端壳层与触控样式（只被 entries/main.ts 引用，不被上游引用）
│  ├─ MobileApp.svelte            根组件：不渲染 AppLayout → Aside/Header/PlayBar 自动消失
│  ├─ mobile.less                 13 段触控样式 + 22 个令牌（`--touch-min:44px` / `--row-music:72px`）
│  ├─ i18n.ts                     移动端专用文案 `tm()` + 上游 `t()` 转出
│  ├─ shell/MobileAppShell.svelte 页面容器：AppBar + Router + MiniPlayer + TabBar + 安全区
│  ├─ shell/MobileAppBar.svelte   顶栏（返回 / 标题 / 动作）
│  ├─ shell/MobileTabBar.svelte   3 个 Tab（曲库 / 在线 / 设置），56px + 安全区
│  ├─ shell/MiniPlayer.svelte     吸底迷你播放器（主体进播放详情，右端复用 PlaylistBtn 打开底部队列）
│  ├─ compositions/longPress.ts   document 层长按 → 合成 contextmenu（让 34 处右键菜单零改造）
│  └─ overrides/                  单文件级覆盖的上游组件（见 §3.5）
└─ scripts/
   ├─ typecheck.mjs / smoke.mjs / copy-wasm.mjs
   ├─ clean.mjs                   构建前清 dist（三级兜底，垃圾落 `.trash/`，见 §9.8）
   ├─ link-vendor.mjs             junction 联接上游同一份 svelte / vite 插件（见 §11.1）
   ├─ smoke-entry.ts              冒烟断言（打进 bundle 后跑）
   └─ smoke.vite.config.mjs       复用主配置的 alias
```

> `porting/js` 不在 `source/` 的 pnpm workspace 内，**没有自己的 svelte/vite 依赖树**：
> svelte、`@sveltejs/vite-plugin-svelte`、`vite-plugin-svg-icons`、`less`、`postcss`、`postcss-pxtorem`
> 全部由 `scripts/link-vendor.mjs` 用 Windows junction 指到上游同一份（`source/node_modules`），
> 避免装出第二个 svelte 版本导致 "Cannot read properties of undefined (reading 'ctx')" 之类的运行期炸裂。
> `dist/` 与 `.trash/` 见 `.gitignore`。

---

## 3. 覆写清单（"零改上游"是怎么做到的）

`vite.config.mjs` 里有四张表，**没有任何一条改动 `source/` 下的文件**：

### 3.1 `node:*` / 裸内建 → `shims/`

| Node 模块 | 替代 | 说明 |
|---|---|---|
| `node:path` | 自实现 posix | `sep='/'`，与 Android 真实路径语义一致 |
| `node:fs` | `FileSystemPort`（全异步） | **所有同步 API 一律抛 `EUNSUPPORTED`**，不静默返回假数据 |
| `node:fs/promises` | 同上 | 20 个函数；PortError→errno 异常（带 `code/syscall/path`） |
| `node:crypto` | WebCrypto + @noble/hashes + 纯 JS AES + node-forge | **必须同步**（上游 `createSign/verify/encrypt` 在同步分支里） |
| `node:zlib` | fflate | `deflate/inflate` 用 `zlibSync/unzlibSync`（带 zlib 头）；`deflateRaw/inflateRaw` 用裸 DEFLATE |
| `node:worker_threads` | `host/worker/*` | worker 侧完全不用 Node 语义，见 §4 |
| `node:vm` | QuickJS(WASM) | 64MB 内存上限 + 1MB 栈 + `setInterruptHandler` 超时中断 |
| `node:stream` | 最小 Readable/Writable/PassThrough | 仅代理缓存的 tee 场景 |
| `node:os` / `node:url` / `node:querystring` / `node:events` / `node:timers{/promises}` | 自实现 | |
| `node:http` / `node:https` / `node:net` | 类型 + 抛错 | 服务端由 Kotlin `LocalHttpServer(127.0.0.1:17930)` 提供 |
| `node:child_process` / `node:module` / `node:util` / `node:perf_hooks` | 桩/薄封装 | 被调到即说明有漏网的桌面路径，显式抛错 |
| **`better-sqlite3`** | `ports/sqlite.ts` | sql.js，见 §5 |

### 3.2 `@/xxx` → `host/xxx`（稀疏覆盖）→ `source/packages/web-server/src/xxx`

`@/` 的解析规则是「**覆盖层优先，未命中落上游**」。因此：
- 命中 `porting/js/host/**` 的文件是"平台语义不同"的（上表 §2 的 host 目录）
- 其余（`app/modules/player`、`musicList`、`sync`、`theme`、`hotKey`、`extension`、`renderer/winMain/rendererEvent/*` 等 ~1200 行）**原样复用上游**

### 3.3 `@any-listen/nodejs/*` → `nodejs/*`（未命中用上游）；上游包内相对导入同样过覆写表

| 上游文件 | Android 实现 | 原因 |
|---|---|---|
| `request.ts` | `nodejs/request.ts` | undici → `HttpPort`（保留 Options/Response/重试/代理语义） |
| `download/` | `nodejs/download.ts` | `node:http` 流式 → `HttpPort.downloadTo`（断点续传交给 Kotlin） |
| `watcher.ts` | `nodejs/watcher.ts` | chokidar → `FileSystemPort.watch` |
| `Store.ts` / `SafeFS.ts` | `nodejs/*` | 同步 IO → **内存同步读 + debounce 异步原子落盘** |
| `music.ts` / `music-metadata.ts` | `nodejs/*` | `parseFile`（strtok3+fs）→ `readFile` + `parseBuffer` |
| `tar.ts` | `nodejs/tar.ts` | tar 包 → `TarPort`（Kotlin 解压，`opts.filter/strip` 明确抛错） |
| `logs.ts` | `nodejs/logs.ts` | `child_process.exec` → `LogPort` |
| `index.ts` | `nodejs/index.ts` | `export * from '@any-listen/nodejs/uplink'`（指回上游原始 index），只覆盖 `fileSha256` / `createDirSync` / `checkAndCreateDirSync` / `getPlatform` / `getOSVersion` / `getNativeName` |
| `app/modules/worker/utils/index.ts` | `host/worker/index.ts` | `new Worker(__dirname/…)` → `new Worker(url, {type:'module'})` |
| `app/modules/worker/utils/worker.ts` | `host/worker/expose.ts` | `parentPort.once` + `instanceof MessagePort` → 原生 MessagePort |

> `@any-listen/nodejs/uplink` 是**只为绕过覆写**而存在的别名（指回上游原始 `index.ts`），
> 目的是让「沿用上游」而不是「抄一遍上游」，避免两套实现长期漂移。

### 3.3.1 `web-server` 侧的覆写（`@porting-uplink/...` 同款别名）

| 上游文件 | Android 实现 | 原因 |
|---|---|---|
| `web-server/src/app/modules/extension/index.ts` | `host/app/modules/extension/index.ts` | 第 40 行 `readFile(joinPath(__dirname, 'extension-preload.js'))` 在 Worker 里是 `ReferenceError`，见下方 |

**这是 Phase 5 真机联调抓到的唯一致命 bug：**

```
E/AnyListen/webview: [core.worker] 启动失败 Error: __dirname is not defined
```

`__dirname` 是 Node 全局，Web Worker 里不存在；而它在 `core.worker` 的**启动路径**上，
所以 `bootstrap` 走不完、IPC 连不上、UI 永久停在 `Loading...`。

修法两段（缺一不可）：

1. **正解**：覆写该模块，把"从磁盘读 preload"换成"从 LocalHttpServer 的静态目录 fetch"——
   `extension-preload.js` 由 Gradle 拷到 `assets/web/spa/extension-preload/`，
   所以 `fetch('/extension-preload/extension-preload.js')` 命中；以 `/` 开头 → 在 worker 里按
   `self.location` 解析，与 worker 在哪个目录无关。静态资源**不校验 token**（native 已确认）。
   覆写文件用 `export * from '@porting-uplink/web-server/app/modules/extension'` 沿用上游的
   60 多个导出，**只本地重写 `initExtension` / `restartExtensionHost`**，
   这样上游加导出时不会漂移。
2. **兜底**：`shims/globals.ts` 里给 `__dirname` / `__filename` 定义了 `''` 兜底 + 首次访问打
   带调用栈的 warning。**这不是正解**（相对路径在构建后不可靠），但能让"某个无关模块里的死代码"
   不至于把整个 App 升级成启动失败。目前唯一还依赖它的是
   `shared/app/modules/worker/dbService/db.ts` 的 `path.join(__dirname, nativeBindingPath)` ——
   `nativeBinding` 是 better-sqlite3 的原生 addon 路径，Android 走 sql.js 且**完全不用这个字段**，
   所以 `''` 让 join 退化成原字符串即可。

**回归门禁**（`pnpm smoke`，两条都只在真机上才会暴露，所以必须自动守）：

- `core.worker` 里不允许出现 `join(__dirname` / `joinPath(__dirname` 这类"拿它拼路径"的形态；
- `main` chunk 里引用的每一个 `*.worker-<hash>.js` 必须在 assets 里真实存在
  （抓"dist 里混进上一代 hash 产物 → 运行时 404 → 卡 Loading"）。

### 3.4 其它

- `buffer` → 真实 `buffer` 包（否则 node-forge 依赖的 `safe-buffer` 会被 vite 当内建 externalize 成空模块）
- `music-metadata` → **上游安装的那一份**（`source/packages/shared/nodejs/node_modules/music-metadata`），版本与桌面强绑定，避免元数据解析结果漂移

### 3.5 UI 覆写（vite alias 单文件级，`OVERRIDES` 表）

UI 改造同样**不碰 `source/`**：`resolveId` 里有一张「上游绝对路径 → `porting/js/ui/overrides/...`」的表，
命中就返回覆盖文件。任何 import 写法（相对、`@/`、`@ui/`）都会经过这张表，所以覆盖对上游是透明的。

| 上游组件 | 覆盖文件 | 为什么必须覆盖（而不是纯 CSS） | 批次 |
|---|---|---|---|
| `view-main/src/components/common/MusicList/List/index.svelte` | `ui/overrides/components/common/MusicList/List/index.svelte` | 需要**新增一个 DOM 节点**（`.multiselect-entry` 悬浮按钮）和 `.mobile-select-bar` 容器，CSS 无法凭空造元素；同时把行高改成 4.5 行视口 | 本批次 |
| `view-main/src/views/Setting/index.svelte` | `ui/overrides/views/Setting/index.svelte` | 设置改为一级分组首页 + 二级详情页，并兼容旧 `type/id` 地址 | D-38 |
| `view-main/src/views/Setting/AppSetting/SettingView.svelte` | `ui/overrides/views/Setting/AppSetting/SettingView.svelte` | 二级页去掉桌面左栏与重复标题，内容改为独立滚动区和单列卡片 | D-38 |
| `view-main/src/views/Setting/AppSetting/SettingCommonItem.svelte` | `ui/overrides/views/Setting/AppSetting/SettingCommonItem.svelte` | 布尔项整行触控，单选与输入项改为手机纵向布局 | D-38 |
| `view-main/src/views/Setting/ExtensionSetting/ExtensionSetting.svelte` | `ui/overrides/views/Setting/ExtensionSetting/ExtensionSetting.svelte` | 扩展设置接新路由、补空态，切换条改为可横滑导航 | D-38 |
| `view-main/src/components/layout/PlayDetail/Footer/index.svelte` | `ui/overrides/components/layout/PlayDetail/Footer/index.svelte` | 播放详情底栏改为手机两行：辅控五键在上，红心 / 上一曲 / 播放 / 下一曲 / 播放列表在下 | D-40 |

**以下规格里标了 O-2…O-5 / O-1b，本批次有意不覆盖**，理由逐条如下（不是遗漏）：

| 规格项 | 上游文件 | 不覆盖的理由 |
|---|---|---|
| O-1b | `MusicList/ListItem.svelte` | 长按由 `ui/compositions/longPress.ts` 在 **document 层**统一处理（pointerdown 500ms → 合成 `contextmenu` 事件）。34 处右键菜单因此零改造可用，不需要 ListItem 透传指针事件 |
| O-2 | `views/Library/index.svelte` | 布局（双行卡片 grid、`--card-min:150px`）纯样式可达，已在 `mobile.less` §6 用 `html.mobile .my-list .container` 实现 |
| O-3 | `views/Search/index.svelte` | 上游该文件是 **5 行空壳**（功能在 `views/.../Search` 的兄弟组件里，且依赖 IPC 搜索契约）。TabBar 因此暂时只放 3 个 Tab。**⚠️ 搜索入口待 IPC 搜索契约定义后补**（不是永久缺失）：契约定了就把 `MobileTabBar` 加回第 4 个 Tab + 补这个覆写 |
| O-4 | `LyricPlayer.svelte` | 歌词字号/行距由 `mobile.less` 的 CSS 变量 + `html.mobile` 前缀解决（特异性 `0,2,1` 必赢 Svelte scoped 的 `0,2,0`） |
| O-5 | `AppSetting.svelte` | 设置页已从桌面两栏改为手机一级分组 + 二级详情；不能只靠样式造出二级路由和独立滚动区，因此改为覆写 `Setting/index.svelte` 等 4 个组件，详见 §3.5 表 |
| N-6/7 | `BottomSheet` / `ActionSheet` 独立组件 | 一条全局规则 `html.mobile .menu, html.mobile .popup { position: fixed; bottom: 0; ... }` 把全部右键菜单统一转成 BottomSheet，不需要独立组件 |
| N-8/9 | `LibraryHome` / `SearchPage` | 同 O-2 / O-3 |
| N-12 | `swipeDismiss` 手势 | 依赖独立 BottomSheet 组件；菜单统一转换后，下滑关闭由原生 `WebView` 的 overscroll 兜底。**列为已知缺口**（手感不如原生 sheet） |

### 3.6 IPC 契约覆写：`showOpenDialog` / `showSaveDialog`

这两个 IPC 在**上游 web-server 版里是被故意注释掉的**（网页版走内置文件浏览器 `showFileSelectModal`，
不需要原生对话框）。桌面版才有主进程实现。Android host 既没有也不该有 `showOpenDialog`
→ 曲库空态点「导入本地音乐」会 message2call 到 host 抛 `showOpenDialog is not defined`，按钮点了没反应。

覆写文件 `ui/overrides/shared/ipc/app/index.ts`：

```ts
export * from '@ui-raw/shared/ipc/app'                 // 其余 30+ 个转发函数沿用上游
export const showOpenDialog = async (opts) => showFileSelectModal(opts)
export const showSaveDialog = async (opts) => showFileSaveModal(opts)
```

三个容易踩的点：

1. **必须用 `@ui-raw/` 取上游**。不带 `-raw` 的 `@ui/shared/ipc/app` 会解析回本文件自己，形成自引用。
2. **`showFileSelectModal` 走的是 `@ui/`（过覆写表）**，拿到的才是移植版；它内部只做两件事：
   把 `properties` 翻译成 `showFileExplorerModal` 的 `multi/openDir/openFile`，
   再用 `readRootDir()` / `readDir()`（对应 host 已实现的 `fileSystemAction` `read_root_dir` / `read_dir`）喂目录树。
3. **`showSaveDialog` 不要照抄桌面分支的 `defaultPath = defaultFileName`** —— 那是 Electron 参数兼容补丁；
   网页版 `showFileSaveModal` 自己处理 `defaultFileName`，两个都设会让目录变成文件名。

---

## 4. 线程拓扑与 Worker 接线

```
UI 主线程 (entries/main.ts)
  ├─ PortsHub（core 通道 + 子 worker 动态注册的通道，统一转发 AndroidBridge）
  ├─ window.__anylisten_bridge_recv__       ← Kotlin evaluateJavascript（唯一回帧入口）
  ├─ window.__anylisten_ipc_init__          ← view-main/src/shared/ipc/ipc.ts 唯一读取点
  ├─ workerPortsControl（常驻控制通道：只收子 worker 新通道的 UI 端）
  └─ new Worker(core.worker)
        ↓ postMessage({type:'bootstrap', scripts}, [ipcPort, corePorts, workerPortsControl])
core.worker (entries/core.worker.ts → host/bootstrap.ts)
  ├─ attachPortsChannel(corePorts)
  ├─ initAppEnv → initServerIPC → … → initModules() → connectClient(ipcPort) → sendInitedEvent()
  ├─ configureWorkerFactory({scripts, workerPortsControl})
  └─ spawn(db/util/ext)：**每次** new MessageChannel()，port1 转给子 worker、port2 交给主线程 hub
```

**首条消息只发一次、且带两条通道**：

```ts
worker.postMessage(subChannelPort1, [portsChannel, subChannelPort1])
// worker 侧：event.data = 业务通道；event.ports[0] = Ports 通道
```

这样避免「先发的控制消息早于 `exposeWorker` 注册监听器」的竞态（`exposeWorker` 在 worker 入口的
**静态 import 链**上同步求值 → 监听器一定先就位）。

> **子 worker 的 Ports 通道必须按次创建（ERR-010）**：`MessagePort` 只能被转移一次，
> 转移后原对象即失效。早期版本在启动时一次性建好 db/util/ext 三条通道并复用，
> 于是「重启扩展宿主」第二次 `spawn()` 必然抛 `DataCloneError`，宿主永久不可用（且只在第二次触发，
> 单次冒烟测不出来）。现在 `spawn()` 自己 `new MessageChannel()`，
> 只把 UI 端经同一条常驻 `workerPortsControl` 转给主线程 hub；控制通道本身不参与重复转移。
> 凡是放进 transfer list 的对象，生命周期都必须等于它所属的那次 spawn。

Web Worker 没有 `exit` 事件、`terminate()` 也不回调，`host/worker/index.ts` 用 `WorkerHandle`
模拟 `on('exit'|'error'|'messageerror') / removeAllListeners() / terminate()`，
从而让上游 `worker.ts` 的注册表逻辑（崩溃置空、重启前解绑）零改动复用。

> **硬约束**：`import.meta.url` 只在 `entries/main.ts` 出现。子 worker 的脚本地址由主线程算出后以
> **字符串**下发；worker 内部绝不拼路径（构建后基准会变）。

> **坑（已踩）**：vite 为 `new Worker(new URL(...))` / `?worker&url` 会起**嵌套 rollup 构建**，
> 而嵌套构建**只使用 `config.worker.plugins`**（默认 `() => []`），不继承顶层 `plugins`。
> 不在 `worker.plugins` 里再给一次 alias 插件，worker 内部的 `node:*` / `@/` 全部解析失败。

---

## 5. SqlitePort（better-sqlite3 → sql.js）

- `new Database(path, {fileMustExist, nativeBinding})` —— `nativeBinding` 被忽略
- `prepare/run/get/all/raw/iterate` / `exec` / `pragma` / `transaction` / `backup` / `close` 全部保留
- **对象绑参降维**：`:name` / `@name` / `$name` → 位置绑参（解析时跳过字符串字面量与注释），
  因此 `migrate.ts` / 各 `dbHelper.ts` 零改动
- 全库驻留内存，写入后 **debounce 1.5s 原子落盘**（`.tmp` + rename），并暴露 `flushNow()`
- **`close()` 不刷盘**：`dbService/db.ts` 的 `verifyDB` 失败路径是「先 `close` 再 `backupDB`」，
  若 close 刷盘会覆盖掉用户待备份的坏库
- 生命周期：`LifecyclePort.onBackground / onTrimMemory / onBeforeTerminate` → `flushNow()`

---

## 6. 与 Kotlin 侧的契约

> **对齐结论（Phase 5，已与 native 侧实机对齐）**
> 权威来源是 `porting/android/bridge/src/main/kotlin/com/anylisten/bridge/Message2CallFrames.kt`
> 与 `porting/android/README.md` §3.1。**早期设计稿假设的 `{v,id,name,args}` 对象帧已作废**，
> 下面三节是 JS 侧实际实现（`ports/m2c-frame.ts` / `ports/bridge-client.ts`）。

### 6.1 帧格式 —— message2call v2 数组帧

两个跳次（Worker ⇄ 主线程、主线程 ⇄ Kotlin）**用同一套帧**，且整条链路上帧始终是**同一个 JSON 字符串**
（主线程只 `JSON.parse` 一次看路由信息，转发时用原串），因此不会出现「一边对象帧一边数组帧」的错位。

```
CALL_TYPE = { REQUEST:0, RESPONSE:1, CALLBACK_REQUEST:2, CALLBACK_RESPONSE:3 }

请求      [0, eventName, pathname:[String], args:[Any], callbacks:[Int]]
响应      [1, eventName, error:{code,message,detail?}|null, result?]
回调请求  [2, callbackName, args:[Any]]
回调响应  [3, callbackName, error|null, result?]   ← 本工程不使用
```

- `eventName = pathname.join('.') + '_' + rand'`，用于把响应配回请求（不是 `id`）
- `pathname[0]` 是模块名、其余 join 成方法名 —— `'fs.readFile'` 与 `['fs','readFile']` 等价，**没有映射表**
- **函数实参**在发送端被替换成 `func_<n>_<rand>` 字符串、其下标记进 `callbacks`；
  Kotlin 用 `ctx.callbackAt(order)` / `callbackArg(index)` 取名字，之后用 `[2, callbackName, args]` 反向推事件。
  这是 `listTree(onBatch)` / `watch(onEvent,onReady,onError)` / `downloadTo(onProgress)` /
  `lifecycle.on*` / `theme.onSystemThemeChanged` / `audio.onFocusChange` / `mediaSession.onControl`
  **唯一**的实现方式 —— 结构化克隆不能传函数，Worker 侧必须先把函数换成名字。

**回调生命周期**（`BridgeClient` 负责）

| 类型 | 例子 | 释放时机 |
|---|---|---|
| 一次性 | `fs.listTree` 的 `onBatch`、`http.downloadTo` 的 `onProgress` | 请求 resolve/reject 时自动释放 |
| 订阅 | `fs.watch`、`lifecycle.on*`、`mediaSession.onControl`、`audio.onFocusChange` | 显式 `keepCallbacks: true`；`fs.unwatch(id)` 时释放 |

### 6.2 主线程 ⇄ Kotlin

**下行** — `AndroidBridge` 是 `@JavascriptInterface`，**只有两个方法**：

```js
AndroidBridge.postMessage(token: string, frameJson: string)   // 两个参数，漏 token 会被 Kotlin 直接丢弃
AndroidBridge.ping(): string                                  // "anylisten-bridge/1"
```

token 从 `window.__ANYLISTEN_TOKEN__` 取（`LocalHttpServer` 首帧注入）；
`ping()` 的后缀与本端 `BRIDGE_PROTOCOL_VERSION` 比对，不一致只告警不阻断（帧错了第一次调用就会报错，更好定位）。

**上行** — Kotlin 只调这一个名字，改了就收不到任何回帧：

```js
window.__anylisten_bridge_recv__(frameJson)   // 由 installBridgeReceiver() 在 UI 主线程注册
```

> 旧名 `window.__anylisten_native_dispatch__` 已删除，不再保留别名 ——
> 留着只会让"到底该挂哪个"变成长期困惑。

**路由**（`PortsHub`）

| 表 | 键 | 写入 | 消费 |
|---|---|---|---|
| `eventRoutes` | 请求的 `eventName` | Worker 发请求时 | Kotlin 回 `[1,...]` 时，消费即删 |
| `callbackRoutes` | 回调名 `func_<n>_<rand>` | Worker 发请求时（按 `callbacks` 下标取实参） | Kotlin 推 `[2,...]` 时，**保留**（流式接口要持续推） |
| 主线程自己 | — | `PortsHub.client` 内部 | 上面两表都没命中时兜底 |

`callbackRoutes` 超过 8192 条会扫一遍已注销的 port 做清理（一次性回调没人主动释放，靠这里兜底）。
早期版本的「广播给所有 worker + subId 过滤」已删除 —— 回调名本身每次调用独立生成，精确路由就够。

**模块名（13 个，以 Kotlin `registerAllModules()` 为准）**

`fs` / `http` / `log` / `settings` / `power` / `lifecycle` / `audio` / `mediaSession` / `notification` /
`theme` / `clipboard` / `intent` / `tar`

**二进制**

`Uint8Array` 不能直接过 `JSON.stringify`（会退化成 `{"0":12,"1":255,...}`，膨胀 5–8 倍且类型丢失）。
帧内统一用信封 `{"$b64":"<base64>"}`，两端各实现一次（Kotlin `JsonBinary` / JS `ports/m2c-frame.ts`）。

- 判定条件是**严格单键**：`{$b64:'x'}` 才算信封，`{$b64:'x', extra:1}` 按普通对象处理
- 编码走分块 `String.fromCharCode`（0x8000/批），不用 spread 大数组（栈溢出），也不依赖
  `Uint8Array.prototype.toBase64`（Chrome 130+ 才有，目标 WebView 版本不确定）
- 覆盖 `Uint8Array` / `ArrayBuffer` / `DataView` / 任意 `ArrayBufferView`；`Date` → ISO 字符串，
  `Map`/`Set` → 对象/数组，环引用降级 `null` 并告警（不能让一帧脏数据打断整条通道）

**错误**

`[1, eventName, { code, message, detail? }, null]`，JS 侧还原成 `PortError`。
`code` 与 Node `errno` 同名（`ENOENT`/`EACCES`/`EIO`/`EUNSUPPORTED`/`ECANCELED`/`EUNKNOWN`/`ETIMEDOUT`），
因为上游有 `if (e.code != 'ENOENT')` 这种分支，名字对不上就会走错路径。

### 6.3 需要 Kotlin 遵守的语义

1. **`fs.getEnv()`** 返回 `{dataPath, cachePath, tempPath, externalRoot, platform:'android', arch, osVersion, hasAllFilesAccess}`。
   `dataPath` 布局必须与桌面同构（`<dataPath>/app` 放设置、`<dataPath>/cache`、`<dataPath>/temp`），迁移脚本依赖它。
2. **`fs.toPlayableUrl(path)`** 返回同源 loopback HTTP URL（`http://127.0.0.1:17930/stream/<id>`），
   必须支持 `Range`。**禁止返回 `file://`**：`file://` 下 AudioWorklet 与 `createMediaElementSource` 都不可用。
3. **`mediaSession.onControl` 的 `value` 单位是毫秒**（Kotlin `onSeekTo(pos: Long)`）。
   JS 侧转 `MediaSessionActionDetails.seekTime` 时 `/1000` —— 不换算的话拖进度条会跳到 1000 倍位置。

### 6.4 `FsEntry.displayPath`（UI 侧约束）

SAF 模式下 `path` 是 `/saf/<treeId>/...` 这种内部标识，**不能直接给用户看**。
约定：Kotlin 在 `FsEntry` 里同时返回 `displayPath`（如 `内部存储/Music`），UI 侧一律显示 `displayPath ?? path`。

> **状态（Phase 5 更新）**：`FsEntry.displayPath` **字段已由 native 补上**，但 `Serialize.entry()`
> 只在 `displayPath != path` 时才下发（listTree 一批 500 条，重复传同一字符串没必要）。
> 而 **SAF 遍历尚未实现**（`SafPathResolver` 只能把 `tree/primary:Music` 反解成真实路径，非 primary 卷返回 null），
> 所以当前 `path` 恒为真实路径、`displayPath` 恒为 `null` —— JS 侧的 `displayPath ?? path` 兜底
> 就是这个场景下的**正确行为**，UI 不会看到 `%3A` 这种编码。
> native 计划在下一批次实现 DocumentFile 遍历并开始填 `displayPath`，届时 JS 侧**零改动**即可吃到。

---

## 7. 已实现 / 桩实现清单

### 已实现（有行为验证）

- `path` / `crypto`（hash+AES+RSA+sign/verify）/ `zlib` / `os` / `url` / `querystring` / `events` / `stream` / `timers`
- `Store` + `SafeFS`（内存同步 + 异步原子落盘，经真实 Ports RPC 落盘已在冒烟中验证）
- `BridgeClient`（超时、错误透传、事件订阅、`destroy`）
- `request`（全部 HTTP 方法、重试、重定向、代理、`needBody` 流式替代）
- sql.js 适配器（建表/插入/查询/export/import 已验证）
- QuickJS 沙箱（`createContext` / `runInContext` + 超时中断 + 跨边界 base64 marshalling）
- mediaSession 替身 + 音频外壳（play/pause/seek/volume/position 上报）

### 桩实现 / 明确不支持（会抛 `EUNSUPPORTED`，**不静默**）

| 项 | 现状 | 原因 |
|---|---|---|
| `fs.*Sync()` 全家族 | 抛 `EUNSUPPORTED` | 同步 IO 会阻塞 UI 线程 |
| `fs.createReadStream/createWriteStream/open` | 抛 `EUNSUPPORTED` | WebView 无文件句柄流；`fileSha256` 已改成整读+增量 hash |
| `createDirSync` / `checkAndCreateDirSync` | 抛 `EUNSUPPORTED` | 同上；调用方已改 `checkAndCreateDir()`（异步） |
| `http.createServer` / `net` 监听 | 抛 `EUNSUPPORTED` | 服务端在 Kotlin |
| `child_process.exec/execSync/spawn` | 抛 `EUNSUPPORTED` | 日志读取改走 `LogPort` |
| `module.createRequire` | 抛 `EUNSUPPORTED` | 无 CJS |
| `zlib.createGzip`（流式） | 未提供 | 上游未使用 |
| `tar` 的 `opts.filter` / `opts.strip` | 抛 `EUNSUPPORTED` | 已与 native 对齐：**不加**。桥只能过 JSON，`encodeRequest` 只把**顶层函数**换成 `func_<n>_<rand>`（回调通道），`filter: (name) => boolean` 这种谓词无法过桥。真需要过滤只能是声明式参数（`stripComponents: number` + `include/exclude: string[]`），暂不做 |
| `AudioEngineRouter` 的播放队列/音效 | 只有单曲 load/play/pause/seek | 队列在 core-worker 的 `player` 模块，UI 接线在下一批次 |
| `AudioEngineRouter` 与上游播放器并存 | 上游 `player` 模块自己创建 `<audio>` 并驱动 `navigator.mediaSession`；`AudioEngineRouter` 只在 `mediaSession.onControl` 的 play/pause/seek 上用，**不是唯一出声源** | 本批次目标是"壳层可用"，播放链路仍走上游。两者的 `setPlaybackState` 都经 shim 有序发布，不会互相打架 |

### 已按 team-lead / arch 结论落地的两条语义

1. `host/app/modules/music/local.ts`：`meta.deviceId !== appState.machineId` **不再静默返回 `null`**，
   改为抛 `MusicDeviceMismatchError`（`code = 'MUSIC_DEVICE_MISMATCH'`，message 前缀带 `[MUSIC_DEVICE_MISMATCH]`
   以便 message2call 序列化后仍可识别）。上层据此提示「该歌曲需要重新绑定本地目录」。
   > ✅ **已接（Phase 5）**：`entries/main.ts` 的 `installGlobalRejectionNotify()` 监听
   > `unhandledrejection`，只对 `message.includes('MUSIC_DEVICE_MISMATCH')` 弹 toast
   > （`tm('mobile__music_device_mismatch')`），其余 rejection 仍打 `console.error`
   > —— 不把第三方脚本的 rejection 也变成噪音。
2. 悬浮窗不做、通知栏歌词 MVP 单行（`lyricNext` 预留不实装）——`MediaSessionPort` 未预留悬浮窗接口。

---

## 8. 产物与体积

```
dist/
├─ spa/                                          204 个文件 / 49 MB（含 18.5 MB sourcemap）
│  ├─ index.html
│  ├─ wasm/sql-wasm-browser.wasm                 669 kB   sql.js（名字由 exports 的 browser 条件决定）
│  └─ assets/                                    202 个文件（其中 90 个 .map）
│     ├─ main.<hash>.js                        1 352 kB   UI 主线程（含上游全部 Svelte 视图的入口）
│     ├─ core.worker-<hash>.js                 1 742 kB   AndroidShell
│     ├─ db.worker-<hash>.js                   1 113 kB   SQLite
│     ├─ util.worker-<hash>.js                 1 060 kB   元数据/文件/网络
│     ├─ ext.worker-<hash>.js                  1 759 kB   扩展沙箱
│     ├─ emscripten-module-*.wasm   507 / 1 046 / 1 525 / 6 468 kB   quickjs 4 个变体
│     ├─ *.wav.bin / *.mp3.bin        15 个 / 7.07 MB   卷积混响 IR + 静音样本（见 §8.1）
│     ├─ Inter-*VariableFont*.ttf      2 个 / 1.70 MB   上游字体
│     └─ *Parser-*.js / jschardet / fxp / 各视图懒加载 chunk
└─ extension-preload/extension-preload.js         59 kB   IIFE，注入 QuickJS 沙箱
```

去掉 sourcemap 后进包的是 **29.8 MB / 114 个文件**。

### 8.1 进包体积构成（debug APK 实测）

| 分类 | 未压缩 | 进包（deflate 后） | 说明 |
|---|---|---|---|
| `classes*.dex` | — | **10.2 MiB** | 原生侧，与本层无关（release 开 R8 会显著下降） |
| `.wav` / `.mp3` | 7.07 MiB | **2.3 MiB** | 上游卷积混响 IR，靠 §8.2 的改名才压得动 |
| quickjs `emscripten-module-*.wasm` ×4 | 9.5 MiB | **2.3 MiB** | 只有 `release-sync` 在用，见 §9 第 1 条 |
| 其余 JS（4 个 worker + UI chunk + 解析器） | 10.9 MiB | **~3.5 MiB** | |
| Inter 字体 ×2 | 1.70 MiB | **0.94 MiB** | 正常 + 斜体变量字体 |
| **APK 合计** | | **23.2 MiB / 24.3 MB** | |

### 8.2 为什么 `.wav` 要改名成 `.wav.bin`

aapt2 对 `.wav`/`.mp3` 这类"看起来已压缩"的扩展名直接 `Stored`（0% 压缩）。而上游
`view-main/src/assets/medias/filters/*.wav` 是**卷积混响的脉冲响应**，14 个文件 7.07 MB，
原样进包占 APK 的 27%。实测这些 IR 的 deflate 压缩率是 **31%～33%**，一点问题都没有。

`scripts/shrink-assets.mjs` 在 `vite build` 之后把它们改名成 `*.wav.bin` 并同步改写产物里的引用
（本次 15 处），aapt2 不认识 `.bin` 就正常压缩。这是**无损**的：

- 消费端 `soundEffect.ts` 用 `XMLHttpRequest` + `responseType='arraybuffer'` + `decodeAudioData()`，
  **按内容嗅探 RIFF 头**，不看扩展名也不看 MIME；
- 原生 `LocalHttpServer.handleStatic` 用 `assets.open()` 读（AssetManager 自动解压），
  `guessMime` 对未知扩展名回落 `application/octet-stream`；
- 改名后会**复核**：任何产物文件里残留旧引用就 `exit 1`；每个资源必须至少被引用一次，否则 warn（死文件）。

`pnpm smoke` 里有一条门禁断言 `dist/spa/assets` 下不允许存在 `.wav`/`.mp3`（漏做 shrink 会静默亏 4.7 MiB）。

---

## 9. 已知限制（按优先级）

1. **quickjs wasm 未裁剪（进包 -1.3 MiB）**。`quickjs-emscripten` 的默认入口会带上
   `debug-sync / debug-asyncify / release-asyncify / release-sync` 四个变体，
   按文件名没法看出哪个在用 —— 实际只有 `release-sync`（6.4 MB 未压缩 / 0.97 MiB 进包）在跑。
   改成 `import releaseSyncVariant from '@jitl/quickjs-wasmfile-release-sync'` +
   `newQuickJSWASMModuleFromVariant(releaseSyncVariant)` 即可只留一个，另三个进包合计 1.33 MiB。
   **需要把 `@jitl/quickjs-wasmfile-release-sync` 提升为直接依赖并重跑冒烟**
   （QuickJS 沙箱有 3 项冒烟覆盖：`createContext`/`runInContext`/超时中断）——本批次为控制风险未改。
2. **music-metadata 的解析器 chunk 在每个 worker 里重复**（`core-*.js`、`index-*.js`、`*Parser-*.js` 各两份）。
   嵌套 worker 构建不共享 chunk。可用 `worker.rollupOptions.output.manualChunks` 或
   把元数据解析收敛到单一 worker 里缓解。
3. **`typecheck` 不覆盖上游文件**。上游是 Node program（`MessagePort.on`、无 DOM），
   移植层必须带 DOM/WebWorker，两套 globals 在同一 program 里必然冲突（当前 41 条，全部来自
   `source/packages`）。门禁只对移植层文件生效；上游由它自己的构建保证。
4. **`host/app/shared/store.ts` 依赖预载顺序**：`SafeFS` 是「内存同步 + 异步落盘」，
   未 `preloadDir(<dataPath>/app)` 之前读到的设置是空的。`bootstrap.ts` 已把预载放在 `initAppEnv()` 之前，
   后续新增 Store 时必须沿用同一顺序。
5. **`MediaSessionPort` 是发出即忘**：4 个方法都是同步签名、内部丢弃 Promise 只记日志
   （为了让上游 `mediaSessionInfo.ts` 零改动）。因此 Kotlin 侧失败不会回传给业务层，
   只能在日志里看到。
   缓解：三个更新（metadata / playbackState / actions）**在 `host/mediasession-shim.ts` 里攒到
   微任务末尾、按固定顺序发一次**（见 §11.4），所以业务层即使漏调某一项，也不会把通知栏
   留在半更新状态。`setPosition` 仍走即时通道，它的失败只能看日志。
6. **SAF 模式下 `realpath` 语义退化**：`/saf/...` 虚拟路径没有符号链接概念，
   `safeResolve()` 的 symlink 校验对 SAF 路径不生效（对 `MANAGE_EXTERNAL_STORAGE` 真实路径仍有效）。
7. **`emscripten-module-*.wasm` 的 `locateFile` 需要 Kotlin 保证可访问**：
   quickjs 会按相对路径取 wasm；务必确认 `http://127.0.0.1:17930/assets/*` 可读。
8. ~~`vite` 的 `emptyOutDir` 被关掉导致产物累积~~ —— **已修（Phase 5，字节级验证）**：
   `pnpm build` 第一步跑 `scripts/clean.mjs`。三级兜底：`rmSync` → 逐文件 `unlinkSync`+`rmdirSync`
   （带 3 次退避重试）→ `renameSync` 到 `porting/js/.trash/<name>.old.<ts>`。
   实测连续三次 `pnpm run build:all`：`assets=202 files=204 sizesum=50589368`，三次**字节级一致**，
   `dist/` 顶层只剩 `spa/` + `extension-preload/`。原生侧 `-PcleanJsDist=true` 保留为兜底但不再必需。
   > ⚠️ **垃圾目录必须落在 `dist/` 之外**：第一版把垃圾改名成 `dist/spa.old.<ts>`，结果被
   > Gradle 的 `syncWebAssets`（`from(dist) { exclude("spa/**") }`）当成 SPA 静态资源拷进 APK ——
   > 实测 `app/src/main/assets/web/spa/spa.old.<ts>` 有 89 个文件 / 26 MB。已改到 `.trash/`，
   > 并建议 native 侧补 `exclude("**/*.old.*", ".trash/**")` 防御。
   > `clean.mjs` 的退出码只对「目标目录仍在原位」报失败；遗留垃圾清不掉只 warn
   > （早期版本把两者混在一个计数里，导致 `pnpm verify` 在第一步就误报失败）。

---

## 10. 与 native-engineer 对齐结论（Phase 5 收口）

| 点 | 结论 |
|---|---|
| 帧格式 | **已对齐**：message2call v2 数组帧，见 §6.1。JS 侧 `ports/m2c-frame.ts` 与 Kotlin `Message2CallFrames.kt` 逐字段对应；早期 `{v,id,name,args}` 设计稿作废 |
| 回程入口 | **已对齐**：`window.__anylisten_bridge_recv__(json)`；旧名 `__anylisten_native_dispatch__` 已删除 |
| `postMessage` 参数 | **已对齐**：`postMessage(token, frameJson)` 两个参数，token 取自 `window.__ANYLISTEN_TOKEN__` |
| 二进制 | **已对齐**：`{"$b64":"<base64>"}` 信封，严格单键判定；JS 侧分块编码，与 Kotlin `JsonBinary` 互通 |
| 模块名 | **以 Kotlin 为准**：13 个（`fs/http/log/settings/power/lifecycle/audio/mediaSession/notification/theme/clipboard/intent/tar`）。`notification` 没有 `postMedia`/`updateMedia` —— MediaStyle 通知由 `PlaybackService` 维护，JS 侧只调 `updateLyric/showToast/showMessageBox/clear` |
| `mediaSession.onControl` 的 `value` | **毫秒**（Kotlin `onSeekTo(pos: Long)`）；JS 转 `seekTime` 时 `/1000`。已实装（原来完全没接，通知栏按钮/耳机键/锁屏全部无效） |
| `FsEntry.displayPath` | **字段已加、SAF 未实现**：native 已在 `FsEntry` 加 `displayPath`，但仅在 `displayPath != path` 时才下发（省流量），而 SAF 遍历尚未实现 → 当前恒为 `null`。JS 侧一律 `displayPath ?? path`，**无需改动**即可在 SAF 批次自动生效 |
| `mediaSession.setActions` | **补齐**：原生通知栏的上一首/下一首按钮读 `MediaSession.supportedActions()`，只调 `setMetadata` 会让按钮停在上一次状态。JS 侧在 shim 里做**有序发布**（metadata → playbackState → actions，见 §11.4），不依赖调用点顺序。副作用：一次切歌 Kotlin 会收到三条，Kotlin 侧需保持幂等 |
| `notification.postMedia/updateMedia` | **Kotlin 侧已删除**，JS 侧不再引用。降级路径 = `mediaSession` 三连（PlaybackService 从 MediaSession 状态渲染 MediaStyle 通知） |
| `fs.getEnv()` 目录布局 | **已对齐**：`dataPath=filesDir`，`app=filesDir/app`（`config.json` 落这里）、`cache=filesDir/cache`（**不是** `context.cacheDir` —— 系统会清那个，而上游把 cache 当应用自管缓存含数据库备份）、`temp` 每次进程启动清空。JS 侧只从 `dataPath` 拼子目录，不写 `filesDir` 字面量 |
| `TarPort.unpack` 的 `filter` / `strip` | **已对齐**：两参 `unpack(archive, dist)`，不加 opts。桥只能过 JSON，`encodeRequest` 只把顶层函数换成回调名，`opts.filter: (name) => boolean` 这种谓词无法过桥（声明式参数如 `stripComponents` 可加但暂不做） |
| `SandboxPort` / `shims/vm.ts` 边界 | `node:vm` 完全在 JS 侧用 QuickJS 实现；`extension-preload.js` 由 Kotlin 作为 asset 读成字符串注入。**不需要原生注入**：JS 直接 `fetch('/extension-preload/extension-preload.js')`，静态资源不校验 token |
| `mediaSession.setPosition` 精度 | 毫秒，播放中每秒最多上报一次（`timeupdate` 里按整秒去重） |
| `settings` 模块 | Kotlin 已实现（debounce 300ms + 原子写 + 损坏自愈），**JS 侧本轮不接**：设置仍走 `SafeFS` 的 `<dataPath>/app/*.json`，避免两套真相源。迁移是 Phase 6 的独立动作 |

---

## 11. UI 壳层与触控适配（Phase 5 任务 3）

### 11.1 在「不改 source」的前提下把 Svelte 接起来

三处非显而易见的地方，都是踩过坑之后才定下来的：

| 问题 | 做法 | 为什么不能走"常规"路线 |
|---|---|---|
| 依赖来源 | `scripts/link-vendor.mjs` 用 `symlinkSync(target, linkPath, 'junction')` 把 **上游同一份** svelte 5.57 / `@sveltejs/vite-plugin-svelte` 7.3 / `vite-plugin-svg-icons` / `less` / `postcss` / `postcss-pxtorem` 联到 `porting/js/node_modules` | `porting/js` 不在 `source/` 的 pnpm workspace 内，`pnpm add svelte` 会装到**另一个版本**，和上游 `view-main` 混用就会 `Cannot read properties of undefined (reading 'ctx')` 之类的运行期炸裂 |
| 预处理器 | `svelte(mobileSvelteConfig)`，`preprocess: vitePreprocess()`，`configFile: false` | 复用上游 `svelte.config.js` 的 `sveltePreprocess({typescript:{tsconfigFile: view-main/tsconfig.json}})` 会 `TS6059: File ... is not under rootDir`（我们的组件在 view-main 之外）；再加 `transpileOnly` 也没用 —— 那个包内部用 `source/` 的 **TypeScript 6**，对旧 `moduleResolution` 抛 deprecation 诊断并当致命错误。`vitePreprocess()` 让 `<script lang="ts">` 走 esbuild 剥类型、`<style lang="less">` 走 vite CSS 管线，两者的 less `modifyVars` 与 pxtorem **都会生效** |
| 模块 id | `resolveId` 返回值一律 `norm(p)`（反斜杠 → 正斜杠） | Windows 上 `path.join` 出反斜杠，而 svelte 插件按模块 id 建编译缓存。缓存了 `A\x.svelte`、加载时请求 `A/x.svelte` → 虚拟 CSS 模块 `x.svelte?svelte&type=style&lang=css` 找不到 → **整个 style 块静默丢失**，只报一句 `Unknown word </style>` |

样式链路刻意复制了上游 `vite.config` 的 `css.preprocessorOptions.less.modifyVars`（注入 `mixin.less`）
与 `postcss.pxtorem`，**`rootValue` 保持 16 不动**：改它会同时缩放宽度/内边距，411dp 屏必溢出。
`selectorBlackList` 里带 `'html'`，所以 `html.mobile { ... }` 块里的 px 保持 px（1px == 1dp）。

挂载点是 `#root` 而不是 `#app`：上游 `app.less` 的规则全部挂在 `#root` 上。
`initNotify()` 也 `mount(App, {target: #root})`，Svelte 5 的 `mount` 是**追加**而非替换，
所以「移动端壳层」与「全局 Toast 层」两个 app 实例共存，后者天然在上层。

### 11.2 壳层结构

```
<MobileApp>                      ← 只在这里 onMount，装 .mobile 类 + 长按
  <Icons />                      ← 上游 svg 精灵注册
  <MobileAppShell>
    <MobileAppBar />             ← 路由感知：首页显示标题，二级页显示返回
    <Router>                     ← 上游 view-main 的 6 个视图，懒加载
    <MiniPlayer />               ← 60px 吸底条；主体进 <PlayDetail>，右端打开底部播放队列
    <MobileTabBar />             ← 3 个 Tab，56px + safe-area-inset-bottom
  </MobileAppShell>
  <PlayDetail />                 ← 上游播放详情（全屏纵排布局由 mobile.less 调整）
  <Loading />
```

**关键设计：`MobileApp` 不渲染上游的 `AppLayout`。** 上游 `AppLayout` 会带出 Aside（左侧曲库树）、
Header（桌面顶栏）、PlayBar（桌面底栏）三个组件 —— 在 411dp 上它们要么挤压内容区、要么需要
一堆 `display:none` 才能藏掉。不渲染是最干净的"消失"方式：DOM 里根本不存在这些节点，
连带它们的定时器、resize 监听、拖拽逻辑都不会启动。

TabBar 是 **3 个**而不是 uiux 规格里的 4 个：`/search` 对应的上游 `views/Search/index.svelte`
是 5 行空壳（真正的搜索 UI 在兄弟组件里且依赖尚未定义的 IPC 搜索契约），放上去就是死链。
详见 §3.5 的裁剪表。

### 11.3 触控令牌与门禁

`ui/mobile.less` 顶部定义 22 个令牌，全部挂在 `html.mobile` 上，随 `<html>` 生效：

```less
--touch-min: 44px;       // 最小命中区（硬底线，uiux 门禁）
--touch-comfort: 48px;   // 常规图标按钮
--touch-primary: 56px;   // 主按钮
--touch-play: 72px;      // 播放页主播放键
--gap-min: 8px;          // 相邻可点元素最小间距（硬底线）
--row-music: 72px;       // 歌曲行，与 List/index.svelte 的 useListItemHeight(4.5) 对齐
--appbar-h / --tabbar-h: 56px;
--miniplayer-h: 60px;
--sheet-radius: 16px;  --sheet-max-h: 60dvh;
--safe-top / --safe-bottom: env(safe-area-inset-*);
```

四条落地要点：

1. **`html.mobile` 前缀是双保险**：特异性 `0,2,1` 必赢 Svelte scoped 的 `0,2,0`（`html.mobile .x` vs `.x.svelte-hash`），
   同时让 pxtorem 的 `selectorBlackList:['html']` 命中 → px 不被转成 rem。
2. **`class="mobile"` 直接写在 `index.html` 的 `<html>` 上**，而不是只靠 `MobileApp` 的 `onMount` 加。
   理由：`onMount` 到首次绘制之间理论上不留空隙，但 WebView 首屏慢，慢设备上真的会闪一帧桌面布局；
   而 22 个触控令牌全挂在 `html.mobile` 上，越早生效越安全。`MobileApp` 里仍然再加一次（幂等）。
   原生 `injectTokenIntoHtml` 按 `<head>` 定位注入，改 `<html>` 那一行不影响它。
3. **不缩放字号换空间**。411dp 上要靠"减少一列/减少一行"腾地方，不能靠缩字号 —— 一旦低于 14sp 中文就不好读。
4. **`--row-music: 72px` 与 JS 侧的双向绑定**：`ui/overrides/.../MusicList/List/index.svelte` 用
   `useListItemHeight(4.5)` 让可视区正好显示 4.5 行（半行是"还有更多"的暗示），CSS 变量必须同值，
   否则行高会由 JS 内联样式覆盖、列表与吸底条错位。

### 11.4 `mediaSession` 的**有序发布**（原生通知栏按钮不卡住的根因）

原生通知栏的上/下一首按钮读的是 `MediaSession.supportedActions()`，**来自 `setActions` 而不是 metadata**。
只调 `setMetadata` 时，从单曲循环列表切到有上一首的列表，按钮不会亮起来。

上游 `mediaSessionInfo.ts` 有 200 行、8 个 handler，改它就是改 `source/`。所以顺序保证放在中间层
`host/mediasession-shim.ts`：三个更新**攒到微任务末尾，按固定顺序发一次**

```
set metadata / playbackState / setActionHandler   →  标记 pending + queueMicrotask
                                                          ↓
flush():  setMetadata → setPlaybackState → setActions
```

这样无论上游按什么顺序调、甚至只调其中一个，到 Kotlin 侧永远是"三连、actions 最后"。
`setPositionState` 走**即时通道**不参与攒批（它每秒都在变，攒批会让进度条聚堆跳变）。
副作用：一次切歌 Kotlin 会收到三条，已要求 native 侧对 `setActions` 保持幂等。

同一个 shim 还负责：`Object.defineProperty(navigator, 'mediaSession')` 覆盖成替身
（Android WebView 有这个对象但**不注册**到系统 `MediaSessionManager`，不覆盖就没有通知栏/锁屏/耳机键），
以及 `onControl` 的**毫秒 → 秒**换算（`seekto` 的 `value` 是 ms，`MediaSessionActionDetails.seekTime` 是 s，
不换算会跳到 1000 倍位置）。

### 11.5 长按 → 合成 `contextmenu`（34 处右键菜单零改造）

上游的多选/批量操作全部挂在 `contextmenu` 事件上（桌面右键）。移动端没有右键，如果去改每一处，
就是 34 个文件的侵入式改造。

`ui/compositions/longPress.ts` 在 **document 层**监听 pointer 事件：

- `pointerdown` 起 500ms 定时器；位移超过 10px、`pointercancel`、`pointerup` 都取消
- 到点后 `dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, cancelable:true, clientX, clientY}))`
- 不传 `pageX/pageY`（`MouseEventInit` 不接受这两个字段，浏览器会按 `clientX + scrollX` 自动推导）
- 合成事件之后的一次性 `click` 被吞掉，避免"长按选中 + 顺带点开歌曲"
- `navigator.vibrate?.(15)` 给一个短反馈（没有振动马达就静默跳过）
- `IGNORE_SELECTOR` 跳过输入框/文本域，否则长按选词会被吃掉

因此 `MusicList/ListItem.svelte` **不需要覆盖**（uiux 规格里的 O-1b 因此不成立）。

### 11.6 本批次的验证边界

| 已自动验证（`pnpm verify`） | 只能人工/真机验证 |
|---|---|
| 移植层类型检查 0 错误（strict） | 实际渲染效果、字号观感、滚动惯性 |
| 构建通过；产物含 TabBar/MiniPlayer/长按/桥入口等标记（防"UI 被 tree-shake 或退回占位页"） | 触控命中区在真实手指下是否够大（44dp 是规格值，不是实测） |
| 媒体资源已改名为 `.bin`（`mediaSession`/产物门禁） | 安全区（`env(safe-area-inset-*)`）在刘海屏上的实际取值 |
| 连线/帧格式/回调释放/`$b64` 往返（冒烟 17+ 项） | BottomSheet 弹出/下滑手感 |
| Ports 4 次真实原生调用走通 | 通知栏按钮随切歌变化（需 native 侧确认收到三连） |
