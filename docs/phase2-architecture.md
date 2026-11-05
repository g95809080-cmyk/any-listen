# Any Listen → Android 移植架构（Phase 2：架构解耦与资产盘点）

> 上游：`any-listen` dev 分支，pnpm monorepo，源码只读位于 `source/`
> 输入：`docs/phase1-spec.md`（规格包，E-01~E-14 / A-01~A-09 / R-01~R-17）、`docs/porting-decision-record.md`（PDR-001~005）
> 本文所有结论均带源码位置；推断处标 `[假设]`。
> **本阶段不修改 `source/` 任何文件**，所有改造以「新增 `porting/` 目录 + 构建期 alias 重定向」实现（见 §6.2）。
> **实现更新（2026-11-04）**：播放中的 WebView 由 `WebPlaybackRuntime` 在 Activity 销毁后暂时持有；停止播放后的退出会等待 core 和 db worker 的落盘回执，超时上限 10 秒。下文 §4.9 是当时的接口设计，现行 `LifecyclePort` 在 `onBeforeTerminate` 中传退出请求 ID，并增加 `acknowledgeTermination(id, source)`；实现与验收分别见 `porting/js/ports/types.ts`、`docs/phase5-acceptance-report.md` §17。

---

## 0. 结论摘要（给主理人 / fullstack / native）

**架构形态：`WebView 内分层 + Kotlin 端口层`（Mode C 的工程化形态，记为 Mode C+）。**

```
┌──────────────────────── Kotlin 宿主进程（:main） ────────────────────────┐
│  MainActivity(WebView)  ←── 同源加载 http://127.0.0.1:<固定端口>/        │
│    │ renderer 线程                                                       │
│    ├─ UI 主线程: view-main(Svelte5) + plugins/player(Web Audio/AudioWorklet)
│    │      │ MessagePort                                                  │
│    │      └────────────► core-worker   ← AndroidShell + @shared/app 全部模块
│    │                        ├─► db-worker    (WASM SQLite + dbService 4773 行)
│    │                        ├─► util-worker  (scan/metadata/download 556 行)
│    │                        └─► ext-worker   (QuickJS 沙箱 + extensionService 4642 行)
│    │      │ (仅在需要原生能力时) @JavascriptInterface AndroidBridge（异步）
│    ├─ LocalHttpServer(127.0.0.1:PORT): SPA 静态 / /stream/<id> 音频 Range / /proxy
│    ├─ PlaybackService 前台服务 + MediaSession（Android 通知栏/锁屏/耳机键）
│    └─ Ports(Kotlin): FS / SAF / Settings / Log / Http / Notification / Audio焦点
└──────────────────────────────────────────────────────────────────────────┘
```

**五个核心决策的推荐（详见 §3）**

| 编号 | 决策 | 推荐 | 一句话理由 |
|---|---|---|---|
| D1 | 业务层运行位置 | **(d) 混合分层**：`@shared/app` 以 TS 原样编译进 4 个 Web Worker，Node API 由 shim 包经 Port 落到 Kotlin | 实测改造面仅 **37 处 `node:*` + 73 处 `@any-listen/nodejs`**，且全部集中在 5 个文件与 1 个 131 行的 worker 工厂；重写量≈1.5k 行，远小于 Kotlin 重写 21k 行的代价 |
| D2 | SQLite | **sql.js(WASM) 在 db-worker 内，同步 API，全库内存 + 事务后异步原子落盘** | 292 处同步调用零改造；`tables.ts` DDL 与 `verifyDB` 的 `sqlite_master` 比对证明 schema 可 1:1；A-08 = **可以直开桌面 .db** |
| D3 | 扩展沙箱 | **quickjs-emscripten**，并实现一个 `node:vm` 兼容 shim | 实测 vm 边界**只传 JSON 字符串与原始值**（14 个 host 函数全部只收 primitive），无跨上下文函数传递 → QuickJS 映射成本远低于预期；`extension-preload` 产物零 `Buffer`/零 `process` 依赖 |
| D4 | 本地文件 | **主：`MANAGE_EXTERNAL_STORAGE`（真实路径）；备：SAF 虚拟挂载 `/saf/<treeId>/`** | 真实路径 = 与桌面 `meta.filePath` 语义完全一致，DB/扫描/监听零改造；分区存储限制见 §3.3 |
| D5 | 后台播放 | **前台服务(type=mediaPlayback) + AudioFocus + MediaSession + 固定 origin WebView 保活**；ExoPlayer 作兜底 | R-09 唯一可靠解；音频图仍留在 WebView（PDR-005） |

**最大的三个未决风险**（需 Phase 5 真机 spike 收敛）
1. **A-01/后台音频存活**：WebView 在锁屏/后台时 AudioContext 是否持续运行未被验证。若失败，Web Audio 音效链整套不可用（PDR-005 兜底：原生 ExoPlayer + 简化音效）。
2. **D3 沙箱的 `timeout`/中断语义**：`vm.runInContext(..., {timeout:5000})` 在 QuickJS 侧要靠 `setInterruptHandler`，无法像 V8 那样"在任意指令边界安全中止"，且宿主回调重入期间的死循环保护需实测。
3. **D2 全量落盘的崩溃窗口**：sql.js 无 WAL，只能"内存库 + 导出整文件"。10k 歌库约 10–30 MB，若落盘 debounce 过大则丢数据、过小则抖动。需真机标定（建议 1.5s debounce + 生命周期强制 flush + A/B 双文件）。

---

## 1. 量化基线（本阶段实测，`rg`/`wc` 只读统计）

### 1.1 代码体量

| 包 | 文件数 | 行数 | 备注 |
|---|---:|---:|---|
| `shared/app` | 182 | 16,419 | 业务核心，需移植主体 |
| └ `modules/worker` | 101 | 10,154 | `dbService` 4,773 / `extensionService` 4,642 / `utilService` 556 / `utils` 131 |
| └ `modules/sync` | 23 | 1,524 | |
| └ `modules/resources` | 14 | 1,427 | |
| └ `modules/musicList` | 3 | 1,276 | |
| └ `modules/extension` | 6 | 602 | |
| └ 其余（player 304 / proxyServer 372 / backup 177 / dislikeList 121 / logs 107 / command 65 / hotkey 54 / music 7 / theme 27） | 35 | 1,234 | |
| `shared/nodejs` | 29 | 3,589 | Node 封装层，改造集中区 |
| `shared/common` | 11 | 1,263 | **零 `node:*` 依赖** |
| `shared/web` | 10 | 1,426 | **零 `node:*` 依赖** |
| `shared/types` | 33 | 3,753 | 纯类型 |
| `shared/theme` | 3 | 513 | 纯资源/JS |
| `shared/i18n` | 1 | 105 | |
| `shared/extension-preload` | 41 | 3,213 | 沙箱内运行的宿主 API 垫片，构建为 IIFE 单文件 |
| `view-main` | 533 | 46,009 | **零 `node:*` 依赖**，已用 `new Worker(new URL(...))` |
| └ `plugins/player/index.ts` | 1 | 627 | Web Audio 引擎（PDR-005 复用目标） |
| `view-lyric` | 127 | 9,496 | 桌面歌词窗，移动端裁剪 |
| `desktop` | 112 | 7,290 | 壳层参考 |
| `web-server` | 118 | 7,463 | **壳层参考（Android 壳最接近它）** |

### 1.2 `@shared/app` 对 Node 内建模块的依赖（37 条 import 语句，逐点）

```
node:path (11)          playTimeStore.ts:1 | backupTask/{index:1, naming:1, storage:4} | db.ts:1
                        extensionApis/storage.ts:2(sep) | manage.ts:2 | shared/manifest.ts:2
                        vm/hostContext/apis/isolateContext.ts:2 | utilService/scanMusics.ts:2
                        worker/utils/index.ts:1
node:fs (8)             logs/index.ts:1 | proxyServer/proxy.ts:1 | proxyServer/state.ts:1(type)
                        backupTask/storage.ts:2 | extensionService/manage.ts:1
                        extensionService/shared/index.ts:2 | extensionService/vm/index.ts:1
                        utilService/scanMusics.ts:1
node:fs/promises (6)    common/deviceId.ts:2 | proxyServer/{index:1, shared:1}
                        backupTask/storage.ts:3 | extensionApis/storage.ts:1
                        vm/hostContext/apis/isolateContext.ts:1
node:vm (3)             extensionService/vm/index.ts:2 | vm/hostContext/index.ts:1
                        vm/hostContext/apis/isolateContext.ts:3
node:crypto (3)         common/deviceId.ts:1(randomUUID) | backupTask/storage.ts:1(createHash)
                        vm/hostContext/hostFuncs.ts:2
node:zlib (2)           modules/sync/webdav/modules/shared.ts:1 | extensionApis/utils.ts:1
node:worker_threads (2) worker/utils/index.ts:1 | worker/utils/worker.ts:1
node:stream (1)         modules/proxyServer/proxy.ts:3 (PassThrough)
node:http (1)           modules/proxyServer/proxy.ts:2 (type IncomingHttpHeaders only)
```
（合计 = 11+8+6+3+3+2+2+1+1 = **37**）
> **关键观察**：`node:fs` 全部走 `fs.promises`（异步），`@shared/app` 内**没有任何同步 fs 调用**（`grep -rn "Sync("` 仅命中业务函数名 `runSync`）。这是 Worker 化能成立的前提。
> 另有 8 处 `process.*`（`db.ts:82 process.on('exit')`、`errorHandler.ts:5,13`、`vm/index.ts:61-62` platform/arch）与 1 处 `setImmediate`（`scanMusics.ts:65`），全部可 1 行 shim。

### 1.3 `@shared/app` 对 `@any-listen/nodejs` 的依赖（73 处导入 / 71 静态 + 2 动态）

| 目标子模块 | 导入点 | 判定 |
|---|---:|---|
| 根 `index.js`（路径/文件/哈希工具） | 25 | [适配] |
| `Event` | 10 | [复用] |
| `request`（undici） | 5 | [重写] |
| `webdav-client` | 4 | [适配] |
| `tools`（md5/removeDB/backupPath） | 4 | [适配] |
| `music`（music-metadata） | 4 | [适配] |
| `logs`（fs + child_process） | 4 | [适配] |
| `mirrorReuqest`（undici） | 3 | [适配] |
| `watcher`（chokidar） | 2 | [重写] |
| `lrcTool` | 2 | [复用] |
| `char`（iconv + jschardet） | 2 | [适配] |
| `strm` / `sign` / `download` / `Store` / `SimpleSingleEvent` / `AsyncFS` | 各 1 | 见 §2 |
| `tar`（动态 `import()`，`shared/index.ts:268,294`） | 2 | [适配]→原生解包 |

根 `index` 被用到的 27 个 API 名（46 次）：`joinPath`10、`toMD5`6、`checkAndCreateDir`5、`extname`4、`checkFile`4、`toSha256`3、`normalizePath`3、`dirname`3、`removePath`2、`basename`2、其余各 1（`writeFile/toSha1/toSha512/sleep/sep/saveStrToFile/saveAnyListenConfigFile/removeFileIgnoreError/removeFile/readFile/readAnyListenConfigFile/randomUUID/randomBytes/isAbsolute/getFileStats/extnameRaw/copyFile/checkPath`）。

### 1.4 better-sqlite3 同步 API 使用规模（决定 D2）

`dbService/` 共 **292 处**同步 DB 调用：`.run(` 92、`.transaction(` 41、`.get(` 37、`.all(` 15、`dbPrepare(` 12、`.exec(` 5、`.prepare(` 3、`.backup(` 2、`.pragma(` 1。
**未使用**：`lastInsertRowid`、`changes`、`.pluck()`、`.raw()`、`.iterate()`、`.columns()`、`.safeIntegers`（全仓 0 命中）。
→ 需实现的 API 面只有 6 个方法，且语义简单。**这是 D2 风险从[高]降到[中]的决定性证据。**

### 1.5 `web-server` 壳层结构（Android 壳的直接模板）

`packages/web-server/src/app/` 共 4,806 行：
- `app/` 413 行（`state.ts` 数据目录布局、`data.ts` 设置读写、`index.ts` 初始化）
- `modules/` 1,730 行（19 文件；`music/local.ts` 155、`extension/` 471、`player` 221、`fileSystem` 141…）
- `renderer/` 1,881 行（**IPC 桥，Android 需等价替换为 postMessage/Worker 版**）
- `shared/` 394 行（`defaultSetting`、`request`、`store`、`update`）
- `worker/` 100 行（3 个 worker 的启动封装）

对比 `desktop/src/modules/` 2,198 行（含 `tray` 399、`appMenu` 55 等桌面专有）→ **Android 壳可实现约 1,300 行复用 + 400~500 行新写**。

`initModules`（`web-server/src/app/modules/index.ts:19-41`）几乎全部 import 自 `@any-listen/app/modules/*`，确认壳层只是薄胶水。

---

## 2. 模块清单

判定口径：**[复用]** 源码零改动（仅构建期 alias/打包）；**[适配]** 保留调用面，替换实现（含写 shim）；**[重写]** 该能力必须换一套实现/交互，源码逻辑不再保留。

### 2.1 `@shared/common` / `types` / `i18n` / `theme` / `web`

| 模块 | 判定 | 理由 | 证据 |
|---|---|---|---|
| `common`（constants/tools/utils/Action/ExecEvent/cache/mime/command/defaultSetting） | **[复用]** | 零 `node:*` 依赖；`defaultSetting.ts` 133 项是设置基线 | 实测 grep 0 命中 |
| `types`（33 文件，含全部 IPC 契约 ~1,549 行） | **[复用]** | 纯 `.d.ts` | — |
| `i18n` | **[复用]** | 纯 JSON + 纯 JS | — |
| `theme` | **[复用]** | 纯 JS + 图片资源 | — |
| `web`（含 `lyric-font-player`、`fonts`、`crypto.ts`） | **[复用]** | 零 `node:*` 依赖 | 实测 grep 0 命中 |

### 2.2 `@shared/app` 业务模块

| 模块 | 判定 | 理由 | 关联证据 |
|---|---|---|---|
| `modules/music` | **[复用]** | 7 行，仅 re-export | E-01 |
| `modules/musicList`（1,276 行） | **[复用]** | 只依赖 `@any-listen/nodejs` 的 `checkPath`/`watcher` 类型，走 alias 后可零改动 | E-01 |
| `modules/player`（304 行） | **[复用]** | 仅 `playTimeStore.ts` 用 `node:path` + `AsyncFS` | E-03 |
| `modules/resources`（1,427 行） | **[复用]** | 纯 TS 业务（搜索/榜单/音源调度），无 Node 直连 | E-01 |
| `modules/extension`（602 行） | **[复用]** | 仅是主进程侧事件胶水 | E-06 |
| `modules/sync`（1,524 行） | **[复用]** | 仅 `webdav/modules/shared.ts` 用 `node:zlib`（→fflate shim）与 `webdav-client` | E-07 |
| `modules/dislikeList` | **[复用]** | 仅 `Event` | — |
| `modules/theme` | **[复用]** | 27 行 | — |
| `modules/logs` | **[适配]** | 用 `node:fs` 落日志文件；Android 改为同时写 `logcat`（LogPort） | R-07 |
| `modules/backup` | **[复用]** | `exportData`/`importData` 全走 `@any-listen/nodejs` 抽象（alias 后可用） | — |
| `modules/proxyServer`（372 行） | **[适配]** | 依赖 `node:stream`(PassThrough)、`node:http` 类型、`@any-listen/nodejs/request`；Android 上改为「本地代理服务」的实现细节（见 §4 HttpPort） | R-10 |
| `modules/hotkey`（54 行） | **[裁剪]** | 桌面全局热键在 Android 无对应；保留数据结构让设置页不崩，注册动作 no-op；耳机键由 MediaSession 接管 | R-07、E-10 |
| `modules/worker`（10,154 行） | 见 2.3 | | R-02 |

### 2.3 `@shared/app/modules/worker`

| 模块 | 判定 | 理由 | 关联证据 |
|---|---|---|---|
| `worker/utils/index.ts`（131 行，3 个 worker 工厂） | **[适配]** | `new Worker(path.join(__dirname,'./x.worker'))` → `new Worker(new URL('./x.worker.js', import.meta.url))`；`MessageChannel` 浏览器原生支持，`port.on('message')` → `port.onmessage`。**改动约 10 行** | R-02 |
| `worker/utils/worker.ts`（27 行） | **[适配]** | `parentPort` → `self`，`port.postMessage` 相同 | R-02 |
| `worker/dbService`（4,773 行，43 文件） | **[适配]** | 只依赖 `better-sqlite3` 6 个方法；`tables.ts`/`migrate.ts`/`verifyDB.ts`/8 个 `statements.ts` 全部保留；`backupTask` 的 `db.backup()` 改由 Port 复制文件实现 | R-01、E-04 |
| `worker/utilService`（556 行，9 文件） | **[适配]** | `scanMusics.ts`(130 行) 与 `list.ts`(watcher) 落在性能热路径 → **改调原生批量扫描/监听**；`music.ts` 元数据解析改 `parseBuffer` | R-03 |
| `worker/extensionService`（4,642 行，45 文件） | **[适配]** | `vm/` 3 个文件通过 `node:vm` shim 映射到 QuickJS；`shared/index.ts` 的 `tar` 改原生解包；其余（manifest 解析 453 行、onlineList 201 行、extensionApis 全部分组）**零改动复用** | R-04、E-06 |

### 2.4 `@shared/nodejs`（逐文件）

| 文件 | 行数 | 判定 | 理由 |
|---|---:|---|---|
| `Event.ts` / `SimpleSingleEvent.ts` | 71 / 42 | **[复用]** | 纯 JS 事件实现，被 11 处依赖 |
| `lrcTool.ts` | 152 | **[复用]** | 纯字符串/LRC 解析 |
| `music.ts` | 72 | **[适配]** | 内部 `parseFile` 依赖 `node:fs`；改走 `parseBuffer`（WebView 无 fs 直接解析） |
| `music-metadata.ts` | 164 | **[适配]** | `music-metadata` v12 为纯 JS；`import('music-metadata')` 的 `parseFile` 分支改 `readFile→parseBuffer` |
| `char.ts` | 13 | **[适配]** | `iconv-lite`(纯 JS，体积大) + `jschardet`(纯 JS)；建议懒加载 + 仅保留 gbk/big5/utf 支持 |
| `strm.ts` | 215 | **[适配]** | 依赖 `request` + `readFile` |
| `tools.ts` | 21 | **[适配]** | `unlink` + `path`（DB 备份路径） |
| `sign.ts` | 54 | **[适配]** | `crypto.createVerify('SHA256')` → WebCrypto `RSASSA-PKCS1-v1_5`（PEM 为 SPKI，可直接 `importKey('spki')`）；签名是 hex，转 Uint8Array 即可，**无需原生** |
| `env.ts` | 27 | **[重写]** | 解析 `process.argv` 命令行参数，Android 无意义 → 返回空 |
| `watcher.ts` | 70 | **[重写]** | chokidar 在 Android 不可用 → FileObserver/ContentObserver 原生实现（WatchPort） |
| `request.ts`（undici，320 行） | **[重写]** | undici 的 `ProxyAgent`/`interceptors.retry`/`body.bytes()` 无 `fetch` 等价物；改「JS 侧 fetch 走本地 HttpPort」或「整包直落 Kotlin OkHttp」 | R-10 |
| `request_node16.ts` / `request.bak.ts` | 260 / 197 | **[删除]** | 历史备份，仓内无引用 |
| `download/`（Downloader 等 4 文件） | — | **[重写]** | `node:http` 直写文件 + `EventEmitter`；改走 HttpPort 流式下载 + 进度回调 |
| `logs.ts` | 77 | **[适配]** | `fs.appendFile` 保留；`child_process.exec`（打开日志目录）删除 |
| `mirrorReuqest.ts` | 152 | **[适配]** | 基于 `request`，跟随其替换 |
| `webdav-client/index.ts` | — | **[适配]** | `readFile` + `node:stream` 类型；WebDAV 协议纯 HTTP，改 fetch |
| `tar.ts` | 10 | **[适配]** | 扩展包解包改原生（Apache Commons Compress）或纯 JS `fflate` |
| **`SafeFS.ts`** | 56 | **[重写]** | **全同步** `readFileSync/writeFileSync/renameSync/existsSync`。Worker 内无法同步访问原生 → 改「启动时异步预载进内存 + 变更后异步原子落盘」 |
| **`Store.ts`** | 61 | **[重写]** | 建立在 SafeFS 之上（同步读） → 同步内存 Store + 异步 flush |
| `AsyncStore.ts` | 72 | **[适配]** | 本身异步，仅需 alias |
| `AsyncFS.ts` | 90 | **[适配]** | 本身异步（`fs.promises`），alias 到 FS shim 即可 |
| `index.ts`（317 行，路径/文件/哈希工具） | **[适配]** | 27 个 API 全部可移植：`joinPath/dirname/basename/extname/isAbsolute/normalizePath/sep` 用 posix-path shim；`toMD5/toSha1/toSha256/toSha512` 用 `hash-wasm`/纯 JS；`randomUUID` 用 `crypto.randomUUID()`；`gzip/gunzip` 用 `fflate`；`getPlatform/getOSVersion/getNativeName` 由 NativeInfoPort 注入 | R-11 |

### 2.5 `view-main` / `view-lyric`

| 模块 | 判定 | 理由 | 关联证据 |
|---|---|---|---|
| `view-main`（46,009 行） | **[复用]** | 零 `node:*`；已 `<meta viewport width=device-width>`；已用 `new Worker(new URL(...))`；已配 `postcss-pxtorem` 但**恒等映射、无缩放效果**（§9.0 修正 E-13） | E-13（修正）、§9.0 |
| `view-main/src/plugins/player/index.ts`（627 行） | **[复用]** | 纯 Web Audio；`audioWorklet.addModule(url)` 在 **`file://` 下会失败**（非安全上下文）→ 必须用 `https://appassets…` 或 `http://127.0.0.1`（见 §3.3 同源方案） | E-03、R-08 |
| `view-main/src/worker/*` | **[复用]** | 标准 Web Worker（markdown/列表计算） | — |
| `view-main` 交互层（触控目标/手势/布局密度） | **[重写]** | R-13；设计基准实为 **1020px 宽**（`shared/browser/widnow.svelte.ts:54,70`、`PlayDetail/RightLyric/LyricPlayer.svelte:16,56`），411dp 下为 0.40 倍密度 → 风险由 [中] 上调为 **[高]**，见 §9.0 | R-13、§9.0 |
| `view-lyric`（9,496 行，桌面歌词独立窗 SPA） | **[裁剪]** | Android 无第二窗口。歌词能力回落为「应用内播放详情页 + 通知栏歌词」；`desktopLyric.*` 45 项设置基本失效 | R-05、E-10 |

### 2.6 桌面专有能力

| 能力 | 源码 | Android 结论 |
|---|---|---|
| 托盘 + 托盘菜单 + 状态栏歌词 | `desktop/src/modules/tray/index.ts`(399) | **[重写]** → MediaStyle 常驻通知 + 通知栏歌词（`NotificationPort`）。`tray.*` 3 项设置裁剪 |
| 全局快捷键 | `desktop/src/modules/hotKey/globalHotkey.ts`(61) | **[裁剪]** → MediaSession（耳机键/锁屏键/通知按钮）。`hotKey` 模块保留结构、注册 no-op |
| 桌面歌词窗（透明/置顶/穿透/跨屏） | `desktop/src/renderer/winLyric/*`(1,899)+`view-lyric` | **[重写]** → 「应用内歌词页（主形态）」；悬浮窗为**可选增强**，需 `SYSTEM_ALERT_WINDOW`（`<activity>` + `WindowManager` + `TYPE_APPLICATION_OVERLAY`），因权限门槛高、体验不等价，列入 P1 可选 |
| 应用级代理 `session.setProxy` | `desktop/src/app/index.ts:134-137,242-253` | **[适配]** → `HttpPort` 在 OkHttp 侧按请求设置 `Proxy`；`network.proxy.*` 4 项设置保留生效 |
| 自动更新 `electron-updater` | `shared/electronUpdate.ts`、`winMain/autoUpdate.ts` | **[裁剪]** → 个人自用不分发，不做自更新。`common.tryAutoUpdate`/`common.allowPreRelease` 设置置灰 |
| 单实例锁 / 深链 `anylisten://` | `desktop/src/app/index.ts:45-63,114-131` | **[适配]** → `singleTask` launchMode + `intent-filter`（可选，非必须） |
| 字体枚举 `font-list` | `desktop/src/shared/fontManage.ts` | **[适配]** → 内置字体清单 + `@shared/web/fonts`；`common.font` 改为枚举内置项 |
| 系统主题跟随 `nativeTheme` | `desktop/src/app/index.ts:200-205` | **[适配]** → Kotlin `uiMode` 变化 → `ThemePort.onSystemThemeChanged`（与 web 版 CSS 媒体查询等价） |
| 文件对话框 `dialog.*` | preload `fs`、错误弹窗 | **[重写]** → SAF `ActivityResultContracts.OpenDocumentTree/OpenDocument` + 原生 AlertDialog（`DialogPort`） |

---

## 3. 核心架构决策

### 3.0 D1 — 业务层运行位置

#### 候选对比

| 候选 | 说明 | `@shared/app` 改动量 | 需新写/重写 | 进程与内存 | 结论 |
|---|---|---|---|---|---|
| (a) WebView JS + 原生插件桥 | app 层 TS 跑在 WebView（Worker），Node API 由 shim → Kotlin Port | 37 + 73 处导入点，**全部经 alias 覆盖，源码 0 改动** | ~1.5k 行 shim + ~5 个替换实现 | 1 renderer 进程 + 4 线程 | 可行 |
| (b) Kotlin 原生重写 | 用 Kotlin 重写 16.4k 行 app + 4.6k 行扩展服务 | 丢弃 100% | **≥21k 行 Kotlin** | 最省 | 否决：工期与行为偏差不可控 |
| (c) nodejs-mobile 打包 Node | 交叉编译 Node 运行时，跑 `web-server` | 0 行 | `better-sqlite3` 需 NDK 交叉编译；Node 二进制 ~40MB/ABI | Node 堆 + WebView 堆 ≈ 250MB+ | 否决：原生模块交叉编译与长期维护风险最高；UI 仍需 WebView，双 JS 引擎 |
| **(d) 混合分层 = (a) 的工程化形态** | 见下 | 同 (a) | 同 (a) | 可控（Worker 隔离） | **推荐** |

#### 推荐方案：Mode C+（WebView 内分层 + Kotlin 端口层）

**运行时拓扑与线程模型**

| 执行体 | 承载内容 | 说明 |
|---|---|---|
| **UI 主线程**（WebView 主 frame） | `view-main` Svelte 5 + `plugins/player`（`<audio>` + `AudioContext` + `AudioWorklet`）+ `window.__anylisten_ipc_init__` 的客户端实现 | 音频必须在主线程（`createMediaElementSource` 需 DOM 元素） |
| **core-worker** | 「主进程」等价物：AndroidShell 的 `appState`/`appSetting`/`initModules`/`ServerIPC exposeObj` + `@shared/app/modules/*` | 对应 desktop 主进程 / web-server `src/app` |
| **db-worker** | `dbService` + WASM SQLite | 同步 WASM 调用只阻塞自己 |
| **util-worker** | `utilService`（扫描/元数据/歌词/下载） | CPU 密集（`music-metadata` 解析） |
| **ext-worker** | `extensionService` + QuickJS 沙箱 | 不可信代码隔离在此线程 |

- core-worker 内部通过 `new Worker(new URL(...), {type:'module'})` **创建后三个子 worker**（Chromium 支持嵌套 worker），并用 `MessageChannel` 传端口 → **与 Node 版拓扑 1:1 同构**。若真机发现嵌套 worker 受限，降级方案：主线程做端口代理（`core.postMessage({cmd:'spawn',name},[port])`），主线程多约 40 行胶水。**[假设]** 嵌套 worker 在 WebView 可用（Chromium 规范支持，需 Phase 5 验证）。
- UI ↔ core-worker：`MessagePort` + `message2call`，与现状一致（`view-main/src/shared/ipc/ipc.ts:14-49` 的注入点不动）。
- Worker → 原生：Worker **无法使用 `@JavascriptInterface`**（该接口只注入主 frame）。因此 Port 调用路径固定为 `worker --postMessage--> UI主线程 --AndroidBridge.method()--> Kotlin`，纯异步。
  **推论：Port 必须是粗粒度批量的**（见 §4 FileSystemPort `listTree`），不能做 `node:fs` 的 1:1 透传，否则 1 万首歌要 2 万次跨线程往返。

**为什么这个方案成本可控（量化）**

| 改造点 | 数量 | 处置 |
|---|---|---|
| `@any-listen/nodejs` 纯 JS 模块（`Event`/`lrcTool`/`AsyncFS`/`AsyncStore`/`tools`…） | 约 20 个 | 直接 `import` 原文件（构建时 paths 指向 `source/`），0 重写 |
| `node:path` | 11 条语句 | 1 个 posix-path shim（~90 行） |
| `node:fs` + `node:fs/promises` | 14 条语句 | 1 个 async fs shim（~220 行）→ FileSystemPort |
| `node:crypto` | 3 条语句 | `randomUUID`(原生) + `hash-wasm` md5/sha + WebCrypto AES/RSA（~160 行） |
| `node:zlib` | 2 条语句 | `fflate` 直接替换（0 行自写） |
| `node:worker_threads` | 2 条语句 | Web Worker shim（~60 行） |
| `node:vm` | 3 条语句 | `node:vm` 兼容 shim → QuickJS（~350 行，D3 核心） |
| `node:stream` / `node:http` | 2 条语句 | 代理模块重写时一并去掉 |
| 真实替换实现 | 5 个文件 | `request.ts`(~180)、`download/*`(~220)、`watcher.ts`(→原生)、`SafeFS`+`Store`(~110)、`tar`(→原生) |
| **合计新写 JS** | | **≈ 1.4k～1.6k 行** |

对比 Kotlin 重写 ≥21k 行 → **决策明确**。

**否决 (c) 的具体理由**：`desktop/package.json:44`、`web-server/package.json:21` 使用 `better-sqlite3 ^13`，其为 N-API 原生绑定，Android 交叉编译需 NDK + node headers + 每个 ABI 单独产物；且应用仍需 WebView 承载 UI/音频 → 双 JS 引擎、双堆、双 GC，内存与崩溃面翻倍。

---

### 3.1 D2 — SQLite

#### 必须满足的硬约束（源码实测）

1. **同步语义**：292 处同步调用；41 处 `db.transaction(fn)` 返回可调用的包装函数（`modules/dislike_list/dbHelper.ts:27` 等），它是**函数式事务**，内部同步执行多次 `.run()`。异步 DB 会强迫把整个 dbHelper 层改成 Promise 链 → 影响 4,773 行。
2. **schema 1:1**：`verifyDB.ts:8-18` 用 `SELECT type,name,tbl_name,sql FROM sqlite_master` 与 `tables.ts` 文本比对，任何 DDL 偏差直接判库损坏并触发备份重建。
3. **只用 6 个 API**（§1.4）。

#### 候选对比

| 候选 | 同步 API | schema 1:1 | WAL/并发 | 万首性能 | 打开桌面 `.db`(A-08) | 体积 | 风险 |
|---|---|---|---|---|---|---|---|
| **sql.js（WASM，内存库）** | ✅ 全同步 | ✅（DDL 文本不变） | ❌ 无 WAL；持库=整文件导出 | 好（内存 B-tree；10k 歌全表查询 <200ms `[假设]`） | ✅ **字节兼容** | +1.3MB wasm | 崩溃丢最近 flush 窗口 |
| wa-sqlite（WASM，多 VFS） | ⚠️ 异步 VFS 为主；同步需 memory VFS | ✅ | 部分 | 好 | ✅ | +1.2MB | API 层更复杂，收益不明确 |
| `@sqlite.org/sqlite-wasm` + OPFS SAHPool VFS | ✅ 真同步句柄 | ✅ | ✅ 真 WAL | 最好 | ✅ | +1.4MB | 依赖固定 origin（端口变了就丢库）+ WebView ≥108 |
| Room / `android.database.sqlite` | ❌ 全异步 | ✅ | ✅ | 最好 | ✅ | 0 | 需改 292 处 + 改写 41 个事务函数；否 |
| `@JavascriptInterface` 同步透传 | ⚠️「JS 阻塞等 Java」理论可行 | ✅ | ✅ | 中（每次往返 50–200µs） | ✅ | 0 | Worker 拿不到 JS Interface（§3.0），需经主线程 → 主线程阻塞，否决 |

#### 推荐：sql.js + 「内存库 + 原子落盘」

```
db-worker:
  wasm → sql.js Database(bytes)        // 同步 API
  每次 .transaction()/批量写结束 → 标记 dirty，debounce 1.5s
  落盘: const data = db.export()       // Uint8Array
        FileSystemPort.writeFileAtomic(dbPath, data)   // 写 .tmp → rename
  立即 flush 时机: LifecyclePort.onStop / onTrimMemory / 扩展安装后 / 卸载前 / 手动备份
适配层 (SqliteAdapter，~180 行) 实现:
  prepare(sql) -> { run(...p), get(...p), all(...p) }
  transaction(fn) -> (...args) => { BEGIN; try{fn(...args);COMMIT}catch{e;ROLLBACK;throw e} }
  exec(sql) / pragma(name,value)(WAL 请求降级为 no-op) / backup(path)(-> 复制当前导出)
  .name 属性（backupTask/naming.ts:16 依赖 db.name 取目录）
```

**为什么可行**
- `tables.ts` 是标准 SQLite DDL，`UNIQUE(...) ON CONFLICT REPLACE` / `PRIMARY KEY` / `CREATE INDEX` 全部在 sql.js（SQLite 3.4x）支持范围 → schema 1:1 成立。
- `migrate.ts:20,28` 用 `@name` 命名参数 → sql.js 支持 `:name/@name/$name`。
- **A-08 结论：可以直开桌面 `.db`。** 依据：① DDL 文本一致；② `verifyDB` 只比对 `sqlite_master.sql`；③ sql.js 读的就是标准 SQLite 文件字节。
  **但有一个必须处理的前提**：桌面 DB 处于 **WAL 模式**（`db.ts:65`），`.db` 旁可能有未 checkpoint 的 `-wal`。sql.js 无法读 WAL。→ **迁移必须用「已 checkpoint 的单文件」**：优先取桌面 `backup/daily/anylisten.data.db.<ts>.bak`（由 `db.backup()` 生成，`backupTask/index.ts:36`，天然是 checkpoint 后的完整文件）；或退出桌面版后再拷贝（退出时 `db.ts:82 process.on('exit')` 关闭 → SQLite 自动 checkpoint）。详见 §5.3。

**风险与缓解**
| 风险 | 缓解 |
|---|---|
| 整库导出开销（10–30MB 每次） | debounce 1.5s + 合并多次写；加「距上次 flush 增量 < 1MB 则跳过」阈值 `[假设，需真机标定]` |
| 崩溃/被杀丢数据 | `onStop`/`onTrimMemory(TRIM_MEMORY_UI_HIDDEN)`/每次事务后 1.5s 强制 flush；双文件 A/B + rename 原子替换 |
| 冷启加载 | 10–30MB → `new SQL.Database(bytes)` 约 100–300ms（在 db-worker 内，不阻塞 UI）`[假设]` |
| 若 flush 成为瓶颈（如扩展每 200ms 写配置） | 升级路径：`@sqlite.org/sqlite-wasm` + OPFS SAHPool + **固定端口 origin**，Shim 接口不变，只换 `SqliteAdapter` 内部 |

---

### 3.2 D3 — 扩展沙箱（最高优先级）

#### 扩展实际用到的宿主 API 面（逐项盘点）

**通道结构（`vm/hostContext/index.ts`）**
- 宿主 → 沙箱：`vmContext.__ext_preload__(key, 'message'|action, dataString)`（`:43,:79-90`）
- 沙箱 → 宿主：`vmContext.__ext_host_call__(_key, action, dataString)`（`:79-90`）+ 14 个 `__ext_host_call__*` 直呼函数（`:47-65`，来自 `EXTENSION_VM_IPC_FUNC_NAMES`，`common/constants.ts:139-153`）

**14 个 host 回调（`vm/hostContext/hostFuncs.ts`）逐项可行性**

| 回调 | 签名（实测） | 参数类型 | WASM 沙箱可行性 |
|---|---|---|---|
| `set_timeout(extId, id, ms)` / `clear_timeout(id)` | 不传回调！宿主只存 timer，到期回 `triggerTimeout(extId,id)`，回调表在**沙箱侧**（`extension-preload/src/apis/global.ts`） | number | ✅ 完全无跨上下文函数传递 |
| `set_interval(extId, id, ms)` / `clear_interval(id)` | 同上 | number | ✅ |
| `utils_str2b64(str)` / `utils_b642buf(str)` | string ⇄ Uint8Array | string/bytes | ✅（Buffer→base64 用 `atob/btoa` 或 Uint8Array 实现） |
| `utils_str2md5(str)` | string → hex | string | ✅（`hash-wasm` md5 是 async⚠️ → 改纯 JS md5，~80 行） |
| `utils_buf2str` / `utils_str2buf(buf)` | bytes ⇄ string | bytes | ✅ |
| `utils_aes_encrypt` | `AES/CBC/PKCS7Padding`、`AES`(ECB/noPad) | string/bytes | ✅ WebCrypto（CBC 支持；ECB 需自行分块用 CBC 退化实现，~40 行） |
| `utils_rsa_encrypt` | `RSA/ECB/OAEPWithSHA1AndMGF1Padding`、`NoPadding` | string | ✅ WebCrypto `RSA-OAEP`(SHA-1)；`NoPadding` 需 `BigInt` 手工实现（QuickJS 支持 BigInt，~60 行）⚠️ |
| `utils_iconv_decode/encode` | string ⇄ bytes，编码名来自 `iconv-lite` | string/bytes | ✅ 保留 `iconv-lite`（纯 JS，宿主侧运行，不进沙箱） |

> **决定性发现**：`createSimpleLogcat`（`:75`）、`createExposeObject`（`:37`）与所有 host 函数**只处理字符串/数字/Uint8Array**；`message2call` 走 `isSendErrorStack:true` 的 JSON 序列化帧。**整个沙箱边界没有任何函数/闭包跨上下文传递**。这是 QuickJS 方案风险大幅低于预期的核心证据。

**`require('any-listen')` 的 API 分组（`extension-preload/src/apis/exposeAPI.ts:24-63`）**

| 分组 | 实现位置 | 沙箱内还是宿主 | 可行性 |
|---|---|---|---|
| `env` / `app` / `constants` | preload 内常量 + host 事件 | 沙箱内 | ✅ |
| `logcat` | 沙箱内 → hostCall('logcat') | 混合 | ✅ |
| `storage`（文件式 KV） | 宿主 `extensionApis/storage.ts`（fs） | 宿主 | ✅ 走 FileSystemPort |
| `configuration` | 宿主 + 事件订阅 | 宿主 | ✅ |
| `musicUtils` | 宿主 dbService 调用 | 宿主 | ✅ |
| `registerResourceAction` / `registerListProviderAction` | 沙箱内注册，调用时走 message2call | 混合 | ✅ |
| `command` | 宿主 | 宿主 | ✅ |
| `utils.{dataConverter,crypto,iconv,zlib}` | `iconv`/`zlib` 走 `__ext_host_call__`；`crypto` 分 host 调用 | 混合 | ✅ |
| `utils.createIsolateContext`（grant=`isolate_context`） | **第二个 vm 上下文**，最多 5 个/扩展（`isolateContext.ts:17`） | 沙箱 | ✅ QuickJS 可建多 runtime/context |
| `request`（grant=`internet`） | 宿主 `extensionApis/request.ts` → `@any-listen/nodejs/request` | 宿主 | ✅ 走 HttpPort |
| `musicList` / `player`（grant，当前是 TODO 注释） | 未启用 | — | ✅ 与本决策无关 |

#### 候选对比

| 候选 | 隔离真实性 | 同步 `runInContext` | 超时中断 | 多上下文 | 体积 | 结论 |
|---|---|---|---|---|---|---|
| **quickjs-emscripten**（QuickJS→WASM） | ✅ 独立 JS 引擎/realm | ✅ `ctx.evalCode` 同步 | ✅ `runtime.setInterruptHandler` | ✅ 多 runtime/context | ~1MB wasm | **推荐** |
| 主线程/Worker + 只读 global（无引擎隔离） | ❌ 同 realm，可原型链逃逸；Web Worker 无法禁 `eval` | ✅ | ❌ | ✅ | 0 | 否决：扩展是第三方不可信代码（PDR-002） |
| `ShadowRealm` | ✅ | ✅ | ⚠️ 无超时 API | ✅ | 0 | 否决：WebView 未实现（`[假设]` 至 Chromium 13x 仍未发布） |
| `isolated-vm`（V8 isolate，原生插件） | ✅ | ✅ | ✅ | ✅ | — | 否决：需 NDK 编译 V8 绑定；Node-API 绑定在 WebView 内不可加载 |
| 每个扩展一个隐藏 WebView（跨进程隔离） | ✅ 最强 | ❌ 跨进程只能异步 | ⚠️ | 成本极高 | — | 否决：内存 ×N，同步 API 全崩 |

#### 推荐实现：`node:vm` 兼容 shim（~350 行），不改 `extensionService/vm/*`

```ts
// porting/js/shims/node-vm.ts —— 对外签名与 node:vm 子集一致
export function createContext(sandbox?: object, opts?: {
  codeGeneration?: { strings?: boolean; wasm?: boolean }
}): VmContext
export function runInContext(code: string, ctx: VmContext, opts?: {
  filename?: string; timeout?: number; breakOnSigint?: boolean
}): unknown
export function isContext(v: unknown): boolean
```
映射规则（`vm/index.ts:40-46,105-114` 与 `hostContext/index.ts:76-98` 是唯一调用点）：

| 原 Node 语义 | QuickJS 映射 |
|---|---|
| `vm.createContext(obj, {codeGeneration})` | `newQuickJSWASMModule().newRuntime()` + `runtime.setMemoryLimit(64MB)` + `newContext()`；`obj` 每个属性：`typeof f === 'function'` → `vm.newFunction(name, (...args) => handle)`（**参数与返回值仅 string/number/Uint8Array/undefined**，已实测），否则 `ctx.setProp(global, name, ctx.newString/newNumber(...))` |
| `vm.runInContext(code, ctx, {filename, timeout})` | `ctx.evalCode(code, filename)`；`timeout` 用 `runtime.setInterruptHandler(() => Date.now() > deadline)`；返回 `{error}` 时 `runtime.dumpError(error)` 抛出 |
| `codeGeneration.strings=false` | QuickJS `eval`/`Function` 移除：unset `globalThis.eval`、`delete globalThis.Function` 的构造能力（QuickJS 编译 `QUICKJS_...` 默认支持 eval；shim 里覆盖 `eval`/`Function` 抛错即可达到同等级别限制 `[假设：非硬隔离，仅 API 级]`） |
| `context.__ext_preload__(...)`（沙箱内调） | 直接是注入的 host function |
| `destroyContext` | `ctx.dispose()` + `runtime.dispose()` |
| isolate context（`isolateContext.ts`） | 每个隔离上下文独立 `newRuntime()+newContext()`，`MAX_ISOLATE_CONTEXTS=5` 不变 |

#### 性能预期与 5s 超时是否够

- 计时口径（`vm/index.ts:105-114`）：`runExtension` 只计 **入口脚本执行** 时间，不含 preload（preload 在 `createVmConetxt` 里先跑），所以 5,000ms 是"入口注册阶段的 5s"。
- QuickJS 是解释执行（无 JIT），纯计算约 **V8 的 1/5～1/10**。扩展入口通常只做 `registerResourceAction/registerListProviderAction` 注册 + 读取 storage，计算量小 → **5s 足够** `[假设：需抽样 3–5 个真实扩展实测]`。
- 冷启动：`newRuntime()` + 加载 preload bundle（IIFE，约 100–300KB `[假设，需构建后实测]`）预计 20–60ms/扩展；建议**首次启动时预热一个空 runtime** 分摊 wasm 实例化成本。
- 若个别扩展超时：把 `runExtension` 的 timeout 改为可配置（默认仍 5000），并在 UI 报"扩展加载超时"——不改变默认语义。
- 额外收益：`runtime.setMemoryLimit` 给了 Node `node:vm` 没有的内存上限，**安全性提升**。

#### 扩展包在 Android 的存放与加载路径

`setExtensionState`（`extensionService/index.ts:56-77`）由壳注入 4 个路径，Android 侧定为：

| 字段 | Android 路径 | 说明 |
|---|---|---|
| `extensionDir` | `/data/data/<pkg>/files/any-listen/ext/datas` | 解包后的扩展目录（每个扩展一个子目录），与桌面 `{dataPath}/ext/datas` 同构 |
| `configFilePath` | `…/ext/extensions.json` | 扩展启用/设置（`EXTENSION.configFileName`） |
| `dataDir` | `…/ext/storage` | 扩展 storage KV（`EXTENSION.storageDirName`） |
| `tempDir` | `…/ext/temp` | 下载临时包 `ext.tgz`（`EXTENSION.extBundleFileName`） |
| `preloadScript` | assets 内构建产物 `extension-preload.js` 全文（启动时读入字符串） | 原样传入 `createVmConetxt` |

- 安装流程（`manage.ts:140-160`）：下载 `ext.tgz` → `unpackExtension` → **`tar` 改由 `TarPort.unpack(archivePath, distDir)` 原生实现** → `verifyExtension`（`sign` 改 WebCrypto 验签）→ `parseExtension` 读 `manifest.json`。
- **沙箱不需要文件系统**：`runExtension` 的 `fs.promises.readFile(extension.enter)`（`vm/index.ts:106`）在宿主侧（ext-worker）执行，走 FileSystemPort。沙箱内文件访问全部经 `storage` 分组的 host 函数（`extensionApis/storage.ts` 用 `normalizePath/safeResolve` 限制在扩展目录内）→ **沙箱无需虚拟 FS**。

---

### 3.3 D4 — 本地文件访问

#### 候选对比

| 候选 | 目录树递归扫描 | 变更监听 | 给 WebView 的播放 URL | Android 11+ 分区存储 | 路径语义 | 改造量 |
|---|---|---|---|---|---|---|
| **`MANAGE_EXTERNAL_STORAGE`（所有文件访问）** | ✅ `java.io.File` 直读，1 万文件约 2–5s `[假设]` | ✅ `FileObserver`（递归需逐目录注册） | ✅ 本地 HTTP `/stream/<id>` | 需用户在「设置→所有文件访问」手动授权（一次性） | **真实绝对路径，与桌面完全一致** | **最小**：`meta.filePath` 语义不变，扫描/监听/DB 全部零改动 |
| SAF（`ACTION_OPEN_DOCUMENT_TREE` + persistable URI） | ⚠️ 可行但慢：`DocumentFile.listFiles` 每次 10–30ms/目录 | ⚠️ `ContentObserver` 只能监听 tree root，需自行 diff | ✅ 复制/流转发 | 完全合规，无需特殊权限 | 需虚拟路径体系 | 大：新写路径映射 + 扫描 + diff |
| MediaStore（`MediaStore.Audio`） | ✅ 快（索引查询） | ✅ `ContentObserver` | ✅ `content://` 可直接给 `<audio>` | 合规（Android 13+ 用 `READ_MEDIA_AUDIO`） | **无路径概念**，只有 `_data`/`RELATIVE_PATH` | 大：破坏"文件夹=歌单"的核心语义 |
| `READ_MEDIA_AUDIO`（33+，仅媒体） | ✅ 仅音频文件 | ⚠️ | ✅ | 合规 | 无路径 | 大，且不含 `.strm`/歌词/图片等伴随文件 |

#### 推荐：主 `MANAGE_EXTERNAL_STORAGE`，备 SAF

**主方案（默认路径，推荐）**
- `AndroidManifest.xml` 声明 `MANAGE_EXTERNAL_STORAGE`，启动时检查 `Environment.isExternalStorageManager()`，未授权则引导 `ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION`。
- Port 实现直接用 `java.io.File` → **`meta.filePath` 就是 `/storage/emulated/0/Music/xx.flac`，与桌面语义 100% 一致**。
- 理由：PDR-003「个人自用、不分发」→ 不受 Google Play「所有文件访问」政策限制；这一条让 D4 的改造量从"高"降到"低"，是整个 D1 决策成立的关键前提。
- 需注意的边界：`/Android/data`、`/Android/obb` 在 11+ 即便有该权限也不可读（音乐库通常不在其中）。

**备方案（SAF，虚拟挂载，作为 P2）**
- 用户选树后持久化 URI 权限（`takePersistableUriPermission`），在虚拟路径空间挂载为 `/saf/<treeId>/<rel...>`。
- `FileSystemPort` 内部把 `/saf/` 前缀路径翻译成 `DocumentsContract` 调用；`path`/`extname`/`joinPath` 等纯 JS 路径运算**照常工作**（POSIX 语义）。
- 变更监听：`ContentObserver.registerContentObserver(treeUri, true, cb)` + 自行做一次轻量 diff（比较 `lastModified`/`size`）。
- 播放 URL：`toPlayableUrl` 返回 `http://127.0.0.1:PORT/stream/<token>`，由 LocalHttpServer 用 `ContentResolver.openFileDescriptor` 流式读取并支持 `Range`。

#### `content://`/`file://` 音频给 WebView 播放的桥接方案（R-06）

**不能用 `file://`**：`view-main` 的 SPA 若以 `file://` 加载，① `AudioWorklet.addModule` 在非安全上下文失败（`plugins/player/index.ts:412`）；② `createMediaElementSource`（`:211`）对 `file://` 视频/音频会变静音；③ 跨源请求无法发。

**推荐：本地 loopback HTTP 服务器同时托管 SPA 与音频 → 同源，零 CORS**
```
LocalHttpServer  (Kotlin, 绑定 127.0.0.1:17930 固定端口)
  GET /                       → assets 内 SPA（index.html + js/css）
  GET /stream/<sha256>.<ext>  → 映射表 → 文件/URI；支持 Range: bytes=；ACAO:* 备用
  GET /p_url/<url>            → 代理转发（对应 web-server 的 /api/p_url）
  POST /bridge/<port>/<method> → 可选：Worker 直连原生的备用通道
```
- `http://127.0.0.1` 属 Chromium「可信来源」→ **安全上下文成立** → `AudioWorklet`/WebCrypto/OPFS 全部可用。
- 同源 → `createMediaElementSource` 静音问题消失。
- `Range` 支持 → `<audio>` 拖动进度条可用（桌面 `file://` 也依赖 Range）。
- 端口固定（用于 OPFS 备选方案的数据归属稳定 + 用户书签），被占用时选择邻近端口并在 DB 中记录一次（OPFS 未启用时无副作用）。
- 安全：仅绑定 `127.0.0.1` + 每次启动生成 32 字节随机 token，SPA 首屏由 Kotlin 注入 token，`/stream` 与 `/bridge` 校验 token。

**备选（更简单，但放弃 WebAudio 音效）**：`WebViewAssetLoader` 走 `https://appassets.androidplatform.net/` + `shouldInterceptRequest` 处理 `/stream/*`。缺点：仍属跨源，需给 `<audio>` 加 `crossOrigin="anonymous"`（要改 `plugins/player`，破坏"零改动复用"），且大文件 Range 需要自己实现 `WebResourceResponse` 分片。→ **不推荐**。

#### Android 11+ 分区存储限制说明（写进文档避免踩坑）

1. `targetSdk ≥ 30`：即便有 `READ_EXTERNAL_STORAGE`，也**不能**读其他 App 目录与任意路径，只能读媒体集合 + 自己目录。要读任意路径必须 `MANAGE_EXTERNAL_STORAGE`。
2. `targetSdk ≥ 33`（Android 13+，本项目必然）：`READ_EXTERNAL_STORAGE` 对媒体失效，改用 `READ_MEDIA_AUDIO`/`READ_MEDIA_IMAGES`（按类型）；且**媒体权限不授予非媒体文件**（`.lrc`、`.strm`、`.jpg` 封面在 `Music/` 下可能读不到）→ 又一个必须用 `MANAGE_EXTERNAL_STORAGE` 的理由。
3. 应用私有目录（`/data/data/<pkg>/files`）始终可读写，DB/配置/扩展放这里，无需任何权限。
4. 卸载即清空私有目录 → 「数据迁移」与「备份」必须支持导出到公共目录或 SAF（§4）。
5. 小米13 / HyperOS 额外注意（`[假设]`，需真机确认）：`MANAGE_EXTERNAL_STORAGE` 在部分国产 ROM 上需在「特殊权限」二级页面单独开启；且「后台弹出界面」「自启动」可能影响前台服务存活。

---

### 3.4 D5 — 后台播放与生命周期

**必备清单（全部为硬性要求，缺一即被杀）**

| 项 | 实现要点 | 依据 |
|---|---|---|
| 前台服务 | `android:foregroundServiceType="mediaPlayback"` + `FOREGROUND_SERVICE_MEDIA_PLAYBACK` 权限；`startForeground()` 必须在 5s 内调用 | R-09 |
| 音频焦点 | `AudioManager.requestAudioFocus(AudioFocusRequest.Builder(AUDIOFOCUS_GAIN).setAudioAttributes(USAGE_MEDIA/CONTENT_TYPE_MUSIC))`；`AUDIOFOCUS_LOSS_TRANSIENT` → 暂停；`LOSS` → 暂停；`DUCK` → 降音量。JS 侧暴露 `AudioPort.onFocusChange(type)`，由 `plugins/player` 的 `audio.pause()` 响应（**不改播放器内部，只在壳层监听**） | R-09 |
| MediaSession | Kotlin `MediaSessionCompat`/`Media3 Session`：`setMetadata`（标题/歌手/封面/时长）、`setPlaybackState`（位置/速度）；`MediaButtonReceiver` 接管耳机键/蓝牙键 | R-07、E-10 |
| 通知 | `Notification.MediaStyle` + `MediaSession.sessionToken` + 上一首/播放暂停/下一首/关闭；通知栏歌词用 `setStyle(MediaStyle).setShowActionsInCompactView` + 副标题滚动（`tray`/状态栏歌词的移动等价物） | E-10 |
| WebView 保活 | `WebSettings.setMediaPlaybackRequiresUserGesture(false)`；`setJavaScriptEnabled(true)`；`setDomStorageEnabled(true)`；`setDatabaseEnabled`（不用）；`setMixedContentMode`（不需要，同源）；`WebView.setWebContentsDebuggingEnabled(false)`（发布） | A-01 |
| 唤醒锁 | `PARTIAL_WAKE_LOCK` 仅在播放中持有（`PowerPort.setWakeLock(on)`） | R-09 |
| 状态回灌 | WebView 播放状态经 `core-worker`→主线程→`AndroidBridge.updatePlaybackState()`→Kotlin，节流 500ms；Kotlin 通知点按 → `AndroidBridge.jsOnMediaButton(action)`→ JS `player` 控制 | — |
| 生命周期 | `onPause`（Activity 不可见但音频在放）**不暂停音频**；`onStop` 触发 `LifecyclePort.onBackground()`（强制 DB flush）；`onTrimMemory(UI_HIDDEN)` 同样 flush；`onDestroy` 停止前台服务并 flush | D2 缓解 |
| 进程被杀恢复 | `START_STICKY` + 从 DB 恢复播放队列/位置（`playTimeStore`、`play_list_music_info` 已具备） | E-04 |

**A-01 未验证的现实风险与处置**
- 风险：Chromium 在页面不可见时会节流定时器；WebView 是否给后台页面继续跑 audio 线程未经验证。
- 处置 1（首选）：前台服务 + wake lock 覆盖"播放中"时段，实测 30min 后台播放。
- 处置 2（兜底，PDR-005 已授权）：**双引擎**。前台/亮屏 → WebView Web Audio 全音效；后台/锁屏 → 交棒原生 Media3 `ExoPlayer`（从同一 `LocalHttpServer /stream` 取音源），音效降级为 ExoPlayer 的内置 `Equalizer`/`BassBoost`。切换由 `PlaybackCoordinator` 状态机决定（同一 `audio session id` 保连贯）。这是**必须在 Phase 4 就预留接口**的设计，不能留到 Phase 6。

---

## 4. 适配层 Port 接口定义

**通用约束（所有 Port）**
1. **调用方一律在 JS 侧**（core/db/util/ext 四个 Worker），**实现方一律在 Kotlin 侧**，唯一例外是 `SandboxPort`/`SqlitePort`（纯 JS/WASM 实现）。
2. **仅异步**（返回 `Promise`），因为 Worker 无法同步触达原生。唯一的同步边界在 db-worker 内部的 WASM SQLite。
3. **粗粒度**：单个 Port 方法必须能在一次跨线程往返内完成一个业务动作（例外：`listTree` 流式分批）。
4. **错误语义统一**：成功返回数据；失败 `reject` 一个 `PortError { code: 'ENOENT'|'EACCES'|'EIO'|'EUNSUPPORTED'|'ECANCELED'|'EUNKNOWN'; message; detail? }`。`code` 必须与 Node 的 `NodeJS.ErrnoException.code` 同名映射，因为 `manage.ts:36` 依赖 `e.code != 'ENOENT'` 判断日志。
5. **线程模型**：Kotlin 侧所有 Port 方法在 `Dispatchers.IO`（`view-post` 除外），绝不占用主线程；JS 侧 Promise resolve 后回到调用 Worker。
6. 可注入：Port 通过 `globalThis.__anylisten_ports__` 在 4 个 Worker 启动时由主线程 `postMessage` 注入就绪标志，避免竞态。

### 4.1 FileSystemPort（Kotlin 实现，JS 调用）

```ts
interface FileSystemPort {
  /** 递归列举（批量，唯一高性能入口）。流式分批回调，避免一次返回 10 万条目 */
  listTree(root: string, opts: {
    maxDepth?: number                 // 对应 watcher depth: recursive?5:0
    fileExtFilter?: string[]          // 对应 isMusicFile 白名单
    followSymlinks?: false            // 恒 false
    batchSize?: number                // 默认 500
  }, onBatch: (entries: FsEntry[]) => void): Promise<{ total: number; canceled: boolean; id: string }>
  cancelScan(id: string): Promise<void>

  stat(path: string): Promise<FsStat | null>          // null = 不存在（对齐 getFileStats 的 catch→null）
  exists(path: string): Promise<boolean>
  readFile(path: string, range?: { start: number; end: number }): Promise<Uint8Array>
  writeFile(path: string, data: Uint8Array): Promise<void>
  writeFileAtomic(path: string, data: Uint8Array): Promise<void>  // .tmp + fsync + rename，DB/store 用
  appendFile(path: string, text: string): Promise<void>           // logs
  mkdirp(path: string): Promise<void>
  remove(path: string, recursive?: boolean): Promise<void>        // 不存在不报错（对齐 removePath/removeFileIgnoreError）
  rename(from: string, to: string): Promise<boolean>              // 返回是否成功（对齐 renamePath）
  copy(from: string, to: string): Promise<void>

  /** 变更监听：替代 chokidar。返回订阅 id */
  watch(root: string, opts: { recursive?: boolean; extFilter?: string[] },
        onEvent: (e: { action: 'add'|'change'|'unlink'; path: string; ctimeMs?: number; mtimeMs?: number; size?: number }) => void,
        onReady: () => void, onError: (msg: string) => void): Promise<string>
  unwatch(id: string): Promise<void>

  /** 文件 → WebView 可播放/可引用的 URL（R-06 出口） */
  toPlayableUrl(path: string): Promise<string | null>   // → http://127.0.0.1:PORT/stream/<sha256>.<ext>
  revokePlayableUrl(url: string): Promise<void>

  /** 目录选择（Android：MANAGE_EXTERNAL_STORAGE 下用原生目录选择器；SAF 模式下返回 treeId） */
  pickDirectory(title?: string): Promise<{ path: string; displayName: string } | null>

  /** 环境信息（替代 node:os / process.platform） */
  getEnv(): Promise<{ dataPath: string; cachePath: string; tempPath: string; externalRoot: string | null;
                      platform: 'android'; arch: 'arm64'|'armv7'|'x86_64'; osVersion: string; hasAllFilesAccess: boolean }>

  getFreeSpace(path: string): Promise<number>
}
interface FsEntry { path: string; name: string; isFile: boolean; isDirectory: boolean; size: number; mtimeMs: number }
interface FsStat { isFile: boolean; isDirectory: boolean; size: number; ctimeMs: number; mtimeMs: number }
```
- **实现方**：`core-ports/src/main/kotlin/.../fs/FileSystemPortImpl.kt`（`java.io.File` 或 `DocumentsContract`）。
- **调用方**：core-worker / db-worker / util-worker / ext-worker 的 `node:fs` shim。
- **热路径注记**：`scanMusics.ts` **不改调用面**（仍是 `workers.utilService.scanFolderMusics(...)`），但其内部（`utilService/scanMusics.ts` 的 `fs.readdir/stat` 循环）**替换为单次 `listTree`**。`watchMusicDir`（`shared/nodejs/watcher.ts`）替换为 `watch`。

### 4.2 SqlitePort（JS 实现，db-worker 内）

```ts
interface SqlitePort {
  open(path: string): Promise<void>          // 读 bytes → new SQL.Database；path 不存在则新建并建表
  prepare(sql: string): SqlStatement
  exec(sql: string): void                    // 多语句
  pragma(name: string, value?: unknown): void  // journal_mode=WAL → no-op
  transaction<T extends (...a: any[]) => any>(fn: T): T   // BEGIN/COMMIT/ROLLBACK 包装
  backup(destPath: string): Promise<void>    // export() → FileSystemPort.writeFileAtomic
  close(): void
  readonly name: string                      // backupTask/naming.ts:16 依赖
  flush(): Promise<void>                     // 强制落盘
  isDirty(): boolean
}
interface SqlStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number } | void
  get(...params: unknown[]): unknown | undefined
  all(...params: unknown[]): unknown[]
}
```
- **实现方**：`porting/js/ports/sqlite.ts`（sql.js + FileSystemPort 落盘）。
- **调用方**：`dbService/db.ts` 的 `getDB()`/`dbPrepare()` 返回该对象（源码 `db.ts` 只有 8 行需要适配：`new Database(...)` 两处 + `nativeBinding` 参数忽略）。
- **线程模型**：仅 db-worker 线程；`flush()` 期间 `db.export()` 同步占满该 worker（可接受，UI 不受影响）。

### 4.3 SandboxPort（JS 实现，ext-worker 内）

```ts
interface SandboxPort {
  create(opts: { memoryLimitBytes?: number; filename?: string }): SandboxContext
  destroy(ctx: SandboxContext): void
}
interface SandboxContext {
  /** 注入宿主函数：只允许 primitive / Uint8Array 出入参，否则抛 EUNSUPPORTED */
  defineHostFunction(name: string, fn: (...args: Primitive[]) => Primitive | void): void
  defineGlobal(name: string, value: Primitive): void
  /** 同步求值，超时由 runtime 中断处理器实现 */
  eval(code: string, opts?: { filename?: string; timeoutMs?: number }): unknown
  dispose(): void
}
```
- **实现方**：`porting/js/shims/node-vm.ts`（对 `extensionService/vm/*` 暴露成 `node:vm` 的 `createContext/runInContext`）。
- **调用方**：`extensionService/vm/index.ts`、`vm/hostContext/index.ts`、`vm/hostContext/apis/isolateContext.ts`（**源码零改动**）。
- **线程模型**：ext-worker 独占；不可信代码不得进入其它 worker。
- **错误语义**：沙箱内异常 → `eval` 抛 `SandboxError{ message, stack }`，由 `extensionService/errorHandler.ts`（`:5,:13` 的 `process.on` 换成 worker 的 `error`/`unhandledrejection`）上报 `extensionEvent('crash')`。

### 4.4 HttpPort（Kotlin 实现，JS 调用）

```ts
interface HttpPort {
  /** 单次请求；body 小于 4MB 时直接返回 bytes，否则落临时文件返回 filePath */
  request(url: string, opts: {
    method?: string; headers?: Record<string,string>; query?: Record<string, unknown>
    body?: string | Uint8Array; bodyFilePath?: string
    timeoutMs?: number; retryNum?: number; maxRedirect?: number
    needRaw?: boolean; needBodyStream?: boolean
    proxy?: { host: string; port: string } | null
    signal?: string  // 取消令牌 id
  }): Promise<{ statusCode: number; headers: Record<string,string>;
                body?: string; raw?: Uint8Array; filePath?: string; history: string[] }>
  downloadTo(url: string, destPath: string, opts: {
    headers?: Record<string,string>; timeoutMs?: number; proxy?: {host:string;port:string}|null
    onProgress: (p: { downloaded: number; total: number; speed: number }) => void
  }): Promise<{ filePath: string; size: number; sha256: string }>
  cancel(id: string): Promise<void>
  /** 应用级代理设置（对应 Electron session.setProxy / undici ProxyAgent） */
  setProxy(proxy: { host: string; port: string } | null): Promise<void>
}
```
- **实现方**：`core-ports/src/main/kotlin/.../http/HttpPortImpl.kt`（OkHttp，`Proxy` 按请求注入）。
- **调用方**：`@any-listen/nodejs/request` 的替换实现（`porting/js/nodejs/request.ts`）、`download/*`、`webdav-client`、`mirrorReuqest`、扩展 `extensionApis/request.ts`。
- **备选**：JS 侧直接用 `fetch`（同源 SPA + Kotlin 侧 `shouldInterceptRequest` 补 CORS），但**无法按请求设代理**且大文件 `bytes()` 占内存 → 仅作降级。
- **注意**：`request.ts:243-296` 的 `needBody` 返回 `Dispatcher.ResponseData['body']`（可流式读取）——`strm.ts` 用于解析 `.strm` 里的远端流。Android 侧统一用 `filePath` 落盘后读文件，语义等价。

### 4.5 SettingsPort（JS 实现 + FileSystemPort 持久化）

```ts
interface SettingsPort {
  load(): Promise<Record<string, unknown>>                    // 启动时一次性读 config.json
  get<K extends string>(key: K): unknown                       // 同步（内存）
  getAll(): Record<string, unknown>                            // 同步
  set(patch: Record<string, unknown>): void                    // 同步改内存 + 异步 flush（debounce 300ms）
  flush(): Promise<void>
  migrateFrom(legacy: Record<string, unknown>): { applied: string[]; skipped: string[] }
}
```
- **实现方**：`porting/js/ports/settings.ts`（替换 `@any-listen/nodejs/Store` 与 `SafeFS`）。
- **理由**：`Store`/`SafeFS`（`SafeFS.ts:30-47`）是**全同步**实现，Worker 内无法同步落盘 → 必须"内存同步 + 异步 flush"。
- **调用方**：`appSetting`（core-worker 内 `appState.appSetting`）、`extensionService/shared/configStore.ts`（扩展配置，同样语义）。

### 4.6 NotificationPort / MediaSessionPort（Kotlin 实现）

```ts
interface NotificationPort {
  postMedia(n: { title: string; artist: string; album?: string; coverUrl?: string;
                 durationMs: number; positionMs: number; isPlaying: boolean;
                 canPrev: boolean; canNext: boolean; lyricLine?: string }): Promise<void>
  updateMedia(p: Partial<{ positionMs: number; isPlaying: boolean; lyricLine: string; title: string }>): Promise<void>
  clear(): Promise<void>
  showToast(msg: string): Promise<void>
  /** 简单确认/输入对话框（替换 Electron dialog.showMessageBox / boxTools） */
  showMessageBox(key: string, msg: string, opts?: { modal?: boolean; type?: 'info'|'warn'|'error' }): Promise<number>
}
interface MediaSessionPort {
  /** Kotlin → JS 的控制回调（耳机键/通知按钮/锁屏/蓝牙） */
  onControl(cb: (action: 'play'|'pause'|'toggle'|'prev'|'next'|'seek'|'seekBackward'|'seekForward'|'stop', value?: number) => void): void
  /** JS → Kotlin 的播放状态同步（节流 500ms） */
  updateState(s: { isPlaying: boolean; positionMs: number; durationMs: number; rate: number }): void

  // ⚠️ 下面 4 个方法是 §9.1 冻结的**权威签名**（与 `navigator.mediaSession` 替身一一对应）。
  //    `updateState` 保留给"原生兜底引擎"用；走 Web 引擎时优先用 setPlaybackState + setPosition。
  setMetadata(m: { title: string; artist: string; album: string; artworkUrl: string | null } | null): void
  setPlaybackState(s: 'none'|'paused'|'playing'): void
  setPosition(p: { durationMs: number; positionMs: number; playbackRate: number }): void
  setActions(actions: Array<'play'|'pause'|'stop'|'seekbackward'|'seekforward'
                        |'seekto'|'previoustrack'|'nexttrack'>): void
}
```
- **实现方**：`core-ports/.../notify/`、`.../media/`（Media3 `MediaSessionService` 或 `MediaSessionCompat`）。
- **对应裁剪项**：`tray`（R-07）、状态栏歌词（`player.isShowStatusBarLyric`）、`desktopLyric.pauseHide` 等由 NotificationPort 吸收。
- **与 JS 的接法**：`view-main` **零改动**——运行时用 `navigator.mediaSession` 替身承接 `mediaSessionInfo.ts` 的 200 行调用（详见 §9.1）。

### 4.7 AudioPort（兜底播放 + 音频焦点）

```ts
interface AudioPort {
  /** A-01 失败时启用：原生 ExoPlayer 兜底播放 */
  nativePlay(url: string, opts: { volume: number; rate: number; preservesPitch: boolean }): Promise<void>
  nativePause(): Promise<void>
  nativeSeek(ms: number): Promise<void>
  nativeSetVolume(v: number): Promise<void>
  nativeStop(): Promise<void>
  /** 音频焦点（Kotlin 请求/释放，JS 响应变化） */
  requestFocus(): Promise<void>
  abandonFocus(): Promise<void>
  onFocusChange(cb: (t: 'gain'|'loss'|'loss_transient'|'duck') => void): void

  /** 引擎选择：'web'（默认）| 'native'（A-01 兜底） */
  setEngine(engine: 'web'|'native'): Promise<void>
  getEngine(): Promise<'web'|'native'>

  /**
   * 能力位查询（供 UI 置灰/隐藏不支持的功能，避免"看起来能用其实没生效"）
   * 必须在 SPA 首帧后、UI 渲染音效面板前调用一次并缓存
   */
  getCapabilities(): Promise<{
    engine: 'web'|'native'
    audioWorklet: boolean        // false → 变调（pitch-shifter）不可用
    convolver: boolean           // false → 卷积混响不可用
    panner3d: boolean            // false → 3D 环绕不可用
    equalizer: boolean           // false → 10 段 EQ 不可用
    setSinkId: boolean           // Android 基本恒 false → player.mediaDeviceId 设置项隐藏
    backgroundAudio: 'unverified'|'ok'|'suspend'  // A-01 实测结论回填
    maxConvolverIrBytes: number  // 卷积脉冲文件大小上限（移动端内存约束）
    supportedSampleRates: number[]
  }>
}
```
- **双引擎切换**在 `plugins/player` 外层包一层 `AudioEngineRouter`（新增文件，不改 `plugins/player/index.ts` 内部）。
- `player.mediaDeviceId`/`isMediaDeviceChangedPausePlay`（`setSinkId`，`index.ts:248,509-511`）在 Android 失效 → 由 `getCapabilities().setSinkId === false` 驱动设置页隐藏。
- `getCapabilities()` 是 **UI 与音频引擎之间的契约**：uiux 要求"不支持即置灰/隐藏"，fullstack 据此渲染。冻结签名，字段只增不改。

### 4.8 LogPort

```ts
interface LogPort {
  write(level: 'debug'|'info'|'warn'|'error', tag: string, message: string): void  // 同步 fire-and-forget
  logcat(level: {debug:3;info:4;warn:5;error:6}[keyof any], tag: string, msg: string): void
  readLastLines(filePath: string, lines: number): Promise<string[]>   // 替换 @any-listen/nodejs/logs
  openLogFolder(): Promise<void>                                       // 删除 child_process.exec，改 Intent
}
```
- **实现方**：Kotlin `Log.i/w/e` + `@JavascriptInterface` 同步调用（日志允许同步，短）。

### 4.9 LifecyclePort / PowerPort / ThemePort / ClipboardPort / IntentPort / NavPort

```ts
interface LifecyclePort {
  onBackground(cb: () => void): void      // Activity.onStop → 强制 DB flush
  onForeground(cb: () => void): void
  onTrimMemory(cb: (level: number) => void): void
  onBeforeTerminate(cb: () => void): void
  isInForeground(): boolean
}
interface PowerPort {
  setWakeLock(on: boolean): Promise<void>
  startForegroundService(): Promise<void>
  stopForegroundService(): Promise<void>
  getBatteryOptimizationStatus(): Promise<'ignored'|'not_ignored'>
  requestIgnoreBatteryOptimization(): Promise<void>
}
interface ThemePort {
  getSystemIsDark(): Promise<boolean>
  onSystemThemeChanged(cb: (isDark: boolean) => void): void
}
interface ClipboardPort { getText(): Promise<string>; setText(t: string): Promise<void> }
interface IntentPort {
  openUrl(url: string): Promise<void>              // shell.openExternal
  shareFile(path: string, mime: string): Promise<void>   // 导出备份/日志
  openDocument(mime: string[]): Promise<{ path: string; name: string } | null>  // SAF 选文件（导入备份）
  saveDocument(suggestName: string, mime: string): Promise<{ path: string } | null>
}
interface TarPort { pack(dir: string, out: string): Promise<void>; unpack(archive: string, dist: string): Promise<void> }
interface CryptoPort {   // 仅当 WebCrypto 不足时使用（RSA NoPadding、iconv）
  sha1/256/512(bytes): string; rsaEncryptNoPadding(key: string, data: Uint8Array): Promise<Uint8Array>
}
/** 返回键契约（§9.7 冻结）。注意只有 setCanGoBack 是 Port；其余是 JS 侧 window 对象 */
interface NavPort {
  /** JS 主动推送，Kotlin 缓存，供 onBackPressed 同步判断（不可用 evaluateJavascript 的异步返回值） */
  setCanGoBack(canGoBack: boolean): void
  /** Kotlin → JS：触发返回（注入的 __anylisten_android_nav__.goBack()） */
  dispatchBack(): void
}
```

**Port 汇总表**

| Port | 实现方 | 调用方 | 线程 | 错误语义 |
|---|---|---|---|---|
| FileSystemPort | Kotlin | 4 个 Worker 的 `node:fs` shim | IO | `PortError.code` = errno 名 |
| SqlitePort | JS（sql.js） | db-worker | db-worker 线程，同步 | SQLite 错误透传 |
| SandboxPort | JS（QuickJS） | ext-worker | ext-worker 线程，同步 eval | `SandboxError` |
| HttpPort | Kotlin | core/db/util/ext worker | IO | HTTP 层异常 → `EIO`；超时 → `ETIMEDOUT` |
| SettingsPort | JS + FileSystemPort | core-worker | 同步读 / 异步写 | 写入失败只记日志不阻塞 |
| NotificationPort / MediaSessionPort | Kotlin | core-worker → 主线程 | Main | 失败降级为静默（不打断播放） |
| AudioPort | Kotlin | UI 主线程（`AudioEngineRouter`） | Main（ExoPlayer 内部线程） | 失败切换引擎 |
| LogPort | Kotlin | 所有 | IO（fire-and-forget） | 吞掉 |
| LifecyclePort / PowerPort / ThemePort | Kotlin | core-worker | Main | 同名 |
| NavPort | Kotlin ⇄ JS 双向 | UI 主线程 | Main | 吞掉（返回键不能抛） |
| ClipboardPort / IntentPort / TarPort / CryptoPort | Kotlin | 各 Worker | IO | 同上 |

---

## 5. 数据迁移方案

### 5.1 桌面数据现状（复核）

| 数据 | 桌面位置/格式 | 源码 |
|---|---|---|
| 应用设置（136 key，含 1 组重复 `theme.id`；实际 135 唯一） | `{dataPath}/config.json`（JSON，`SafeFS` 原子写） | `desktop/src/app/data.ts:68-97`、`desktop/src/shared/store.ts:20-46`、`common/defaultSetting.ts` |
| 歌单/歌曲/歌词/下载/黑名单/播放计数/日志 | `{dataPath}/anylisten.data.db`（SQLite，**WAL**，`DB_VERSION='3'`） | `dbService/db.ts:65`、`dbService/tables.ts:216` |
| 自动备份 | `{dataPath}/backup/{daily,event}/anylisten.data.db.<YYYYMMDD>-<HHmmssSSS>.bak`（`db.backup()` 产物，**单文件已 checkpoint**） | `backupTask/naming.ts:26-40`、`backupTask/index.ts:36` |
| 扩展本体 + 配置 | `{dataPath}/ext/datas/<extId>/`、`{dataPath}/ext/extensions.json`、`{dataPath}/ext/storage/` | `extensionService/state.ts:16-19`、`common/constants.ts:155-170` |
| 当前播放队列/位置 | SQLite `play_list_music_info` + `playTimeStore` 文件 | `player/playTimeStore.ts` |
| UI 本地偏好 | `localStorage`（WebView 内可整体迁移） | `view-main/src/shared/localStore.ts` |
| 缓存/临时 | `{dataPath}/cache`、`{dataPath}/temp` | 不迁移 |

> 桌面 `dataPath` = `userData/AnyListenDatas`（`desktop/src/app/index.ts:92-112`），实际子结构为 `{dataPath}/app/`（`web-server/src/app/index.ts:34-36` 的 `setUserDataPath`，desktop 同构）。

### 5.2 Android 目标布局（与桌面同构，便于双向搬运）

```
/data/data/com.anylisten.mobile/files/any-listen/          ← dataPath (FileSystemPort.getEnv().dataPath)
  ├── app/                     appState.dataPath
  │    ├── config.json         设置（SettingsPort）
  │    ├── anylisten.data.db   主库（sql.js 落盘）
  │    ├── deviceid             设备 id（common/deviceId.ts）
  │    └── playTime.json        播放位置
  ├── cache/
  ├── temp/                    启动清空（对齐 app/index.ts:35）
  ├── backup/{daily,event}/    DB 自动备份
  └── ext/
       ├── extensions.json
       ├── datas/<extId>/      解包扩展
       ├── storage/            扩展 KV
       └── temp/               下载中的 ext.tgz
```

### 5.3 可执行迁移步骤

**Step 0 前置**：桌面版**完全退出**（否则 WAL 未 checkpoint）。若不确定，直接用 `backup/daily/` 里最新的 `.bak`。

**路径 A（推荐，先做）：应用内 JSON 备份 → 导入**
1. 桌面：`设置 → 数据备份` → 勾选「歌单」「设置」→ 导出（走 `modules/backup/exportData`，得到 JSON；`BackupData` 见 `types/common.d.ts:125-136`）。
2. Android：`设置 → 数据备份 → 导入` → `IntentPort.openDocument(['application/json'])` 选文件 → `modules/backup/importData`。
3. 验证：歌单数量、`loveList` 条目数、`设置` 中 `player.*`/`sync.webdav.*` 生效。
4. **已知损失**：`meta.filePath` 是桌面绝对路径 → 本地音乐条目全部失效，需在 Android 重新添加目录并扫描（`musicList` 会按 `id` 去重，不会重复插入 `[假设，需验证]`）。

**路径 B（完整，拿到全部历史/播放计数/歌词缓存）**
1. 桌面退出 → 取 `{dataPath}/app/backup/daily/` 中最新的 `anylisten.data.db.*.bak`；若无备份，取 `{dataPath}/app/anylisten.data.db` 且**确认同目录无残留 `-wal`（有则说明未 checkpoint，改用路径 A）**。
2. 通过 `adb push` 或「导出到下载目录」把该文件送到 Android：
   `adb push anylisten.data.db.<ts>.bak /sdcard/Android/data/com.anylisten.mobile/files/any-listen/app/anylisten.data.db`
   （或用 `设置 → 导入数据库`：`IntentPort.openDocument` → 拷贝到 `dataPath/app/anylisten.data.db`）
3. 首次启动时 `dbService.init` 流程（`db.ts:50-75`）：
   - `fileMustExist:true` 打开成功 → `migrateData(db, machineId)`（`migrate.ts`，DB_VERSION 3 已是最新 → 无操作）
   - `verifyDB(db)`（`verifyDB.ts:8-18`）逐表比对 `sqlite_master.sql` 与 `tables.ts` → **必须通过**；不通过则自动备份并重建（`worker/dbService.ts:14-21` 的 existing 逻辑）
4. **`machineId` 必须重新绑定**：桌面 DB 的本地音乐 `meta.deviceId` 是桌面机器 id（`desktop/src/app/data.ts`），Android 的 `machineId` 不同 → `getMusicUrl` 会因 `musicInfo.meta.deviceId !== appState.machineId` 返回 null（`desktop/src/modules/music/local.ts:20`）。处置：迁移后跑一次「本地音乐重扫/重绑定」，把 `meta.deviceId` 刷成 Android 的 `machineId`（复用 `migrate.ts` 的 `migrateV2` 模式，写一个 `migrateV4`）。**这是路径 B 必做的一步。**
5. 验证：`SELECT COUNT(*) FROM my_list_music_info`、`play_list_music_info`、`lyric` 与桌面一致；随机抽 3 首本地歌重新扫描后能播放。

**路径 C（扩展）**
1. 桌面 `{dataPath}/ext/` 整目录拷贝到 Android `files/any-listen/ext/`。
2. 扩展 `datas/<extId>/manifest.json` 里含 `publicKey`，`extensions.json` 含启用状态 → 直接复用，无需重新下载与验签。
3. 验证：扩展列表条数、启用状态、扩展设置项（`storage/`）一致；`ext-worker` 能否 `runExtension` 成功（D3 验证点）。

### 5.4 `config.json` 136 项分类（含移动端无意义项标注）

按前缀统计（`shared/common/defaultSetting.ts`）：`desktopLyric` 45、`player` 42、`common` 14、`sync` 8、`playDetail` 7、`theme` 4、`network` 4、`tray` 3、`onlineResource` 2、`list` 2、`extension` 2、`download` 2、`backup` 1。

| 类别 | 键（示例/全量） | Android 处置 |
|---|---|---|
| **直接保留**（约 70 项） | `player.*`（42，含 `soundEffect.*` 17）、`sync.webdav.*`(8)、`playDetail.*`(7)、`theme.*`(4)、`list.*`(2)、`onlineResource.*`(2)、`extension.*`(2)、`backup.backupPath`(1)、`common.langId/isShowAnimation/isAgreePact/fontSize/playBarProgressStyle/enableTrash/enableDebug`(7) | 原值迁入 `config.json` |
| **改语义保留**（约 12 项） | `common.font`（字体枚举→内置清单）、`download.savePath`/`backup.backupPath`（→ SAF 目录 URI）、`network.proxy.*`(4)（→ HttpPort.setProxy）、`player.volume/isMute/playbackRate/preservesPitch/togglePlayMethod/playQuality`（保留）、`player.isShowStatusBarLyric`（→ 通知栏歌词开关） | 迁移时做值映射 |
| **移动端无意义，删除/忽略**（约 54 项） | `common.windowSizeId`、`common.startInFullscreen`、`common.transparentWindow`、`common.tryAutoUpdate`、`common.allowPreRelease`、`common.showChangeLog`、`tray.*`(3)、`player.mediaDeviceId`、`player.isMediaDeviceChangedPausePlay`、`player.isShowTaskProgess`、`desktopLyric.*` 中窗口几何相关（`classic.x/y/widthByFontNum`、`multiLine.width/height/x/y/direction/lineGap`、`isAlwaysOnTop*`、`isShowTaskbar`、`fullscreenHide`、`isLockScreen`、`isHoverHide`、`pauseHide`、`mode`、`isLock`、`enable`…约 30 项）、`player.isShowTitleLyric`（标题栏不存在） | 迁移时丢弃，Android 侧读取时不存在即用默认值（`defaultSetting` 已给默认） |
| **桌面歌词 → 应用内歌词页（保留样式子集）**（约 12 项） | `desktopLyric.classic.style.*`、`desktopLyric.multiLine.style.*` 中的字号/颜色/字重/对齐 → 映射到「播放详情页歌词样式」 | 值迁移 + 键重命名（新键 `lyricView.style.*`）`[建议与 uiux 对齐]` |

**迁移执行方式**：`SettingsPort.migrateFrom(legacy)` 返回 `{applied, skipped}`，写入日志并在设置页「迁移报告」展示，避免静默丢弃。

---

## 6. 构建分层与工程结构

### 6.1 Gradle 模块

| Gradle 模块 | 构建系统 | 内容 | 依赖 |
|---|---|---|---|
| `:app` | AGP | `MainActivity`（WebView 宿主）、`PlaybackService`（前台服务 + MediaSession）、Application、权限引导、`assets` 打包入口 | `:core-ports`、`:bridge`、`:webassets`、`:native-audio`(可选) |
| `:core-ports` | AGP（library） | Port 的 Kotlin 接口与实现：FS/SAF/Settings/Log/Http/Notification/MediaSession/Power/Theme/Clipboard/Intent/Tar | AndroidX、OkHttp、Apache Commons Compress |
| `:bridge` | AGP（library） | `AndroidBridge`（`@JavascriptInterface`）、Port RPC 编解码（与 `message2call` 帧兼容）、token 校验、`LocalHttpServer`（NanoHTTPD 或 `ServerSocket` 自研） | `:core-ports` |
| `:native-audio` | AGP（library，可选） | Media3 `ExoPlayer` + `AudioEngineRouter` 原生侧 | AndroidX Media3 |
| `:webassets` | 自定义 Gradle 任务（`NodeTask`/`Exec`） | 触发 pnpm 构建 → 把 `spa/`、`workers/`、`wasm/`、`extension-preload.js` 拷进 `assets/web/` | pnpm、Node 20+ |

**minSdk 结论：26 → 维持 26 不现实，建议上调到 29（Android 10）。**
理由：① `sql.js`/`quickjs` 只需 WebAssembly（WebView 57+ 即支持），不构成约束；② **真正的约束是 WebView 版本而非 API 级别**——OPFS/SAHPool（D2 升级路径）需 WebView 108+、`FileSystemSyncAccessHandle` 需在 Worker 中、`AudioWorklet` 需 Chromium 66+；③ `MANAGE_EXTERNAL_STORAGE` 是 API 30（Android 11）概念，API 29 上走 `requestLegacyExternalStorage` 更简单；④ Android 13（API 33）起 `READ_MEDIA_*` 体系，本项目实际目标机就是 13。
**推荐：`minSdk 29`、`targetSdk 35`、`compileSdk 35`、ABI 仅 `arm64-v8a`（个人自用，可减小包体约 40%）。** 若必须保 26，则 D2 只能选 sql.js（不能选 OPFS 方案），且需在 `MANAGE_EXTERNAL_STORAGE` 分支额外维护 legacy 路径 —— 收益不抵成本。

### 6.2 JS 侧工程结构（关键：**不修改 `source/`**）

```
porting/
├── package.json                     # pnpm workspace（独立于 source 的 workspace）
├── pnpm-workspace.yaml
├── tsconfig.json
├── js/
│   ├── shims/                       # @anylisten/node-shims
│   │   ├── path.ts                  # node:path (posix)
│   │   ├── fs.ts / fs-promises.ts   # node:fs → FileSystemPort
│   │   ├── crypto.ts                # node:crypto → WebCrypto + hash-wasm
│   │   ├── zlib.ts                  # node:zlib → fflate
│   │   ├── worker_threads.ts        # node:worker_threads → Web Worker
│   │   ├── stream.ts                # PassThrough 最小实现
│   │   ├── vm.ts                    # node:vm → QuickJS（SandboxPort）
│   │   ├── process.ts               # process.platform/arch/on/env
│   │   └── setImmediate.ts
│   ├── nodejs/                      # @anylisten/nodejs-android（替换 @any-listen/nodejs）
│   │   ├── index.ts                 # 27 个 API 的 Android 实现（复用纯 JS 部分 re-export 自 source）
│   │   ├── request.ts               # → HttpPort
│   │   ├── download.ts              # → HttpPort.downloadTo
│   │   ├── watcher.ts               # → FileSystemPort.watch
│   │   ├── Store.ts / SafeFS.ts     # → SettingsPort（内存同步 + 异步 flush）
│   │   ├── AsyncFS.ts / AsyncStore.ts   # alias 到 source 原文件（仅换 node:fs）
│   │   ├── Event.ts / SimpleSingleEvent.ts / lrcTool.ts   # 直接 re-export source
│   │   ├── music.ts / music-metadata.ts  # parseFile → readFile+parseBuffer
│   │   ├── char.ts / sign.ts / tools.ts / env.ts / strm.ts / webdav-client.ts / mirrorReuqest.ts
│   │   └── tar.ts                   # → TarPort
│   ├── ports/                       # Port 的 JS 消费端
│   │   ├── index.ts                 # 从 window.__anylisten_ports_bridge__ 取 Port（经主线程代理）
│   │   ├── sqlite.ts                # SqlitePort（sql.js）
│   │   └── bridge-client.ts         # Worker → 主线程 → AndroidBridge 的 RPC 客户端
│   ├── host/                        # @anylisten/host-android（AndroidShell）
│   │   ├── app/                     # 对位 web-server/src/app：state/data/index/event
│   │   ├── modules/                 # initModules + music/local.ts + fileSystem + extension/exposeFuncs
│   │   └── ipc/                     # ServerIPC 组装（复用 @any-listen/app/modules/*）
│   ├── entries/                     # 4 个入口
│   │   ├── main.ts                  # UI 主线程：端口代理 + window.__anylisten_ipc_init__ + 音频引擎路由
│   │   ├── core.worker.ts
│   │   ├── db.worker.ts
│   │   ├── util.worker.ts
│   │   └── ext.worker.ts
│   └── vite.config.mjs              # 多入口构建（1 个 spa + 4 个 worker）
└── android/                          # Gradle 工程（:app/:core-ports/:bridge/:webassets）
```

**构建期 alias（`porting/js/vite.config.mjs`，这是"零改源码"的关键）**

```js
const SRC = '../source/packages'
export default defineConfig({
  resolve: {
    alias: [
      { find: /^node:path$/,       replacement: 'porting/js/shims/path.ts' },
      { find: /^node:fs$/,         replacement: 'porting/js/shims/fs.ts' },
      { find: /^node:fs\/promises$/i, replacement: 'porting/js/shims/fs-promises.ts' },
      { find: /^node:crypto$/,     replacement: 'porting/js/shims/crypto.ts' },
      { find: /^node:zlib$/,       replacement: 'porting/js/shims/zlib.ts' },
      { find: /^node:vm$/,         replacement: 'porting/js/shims/vm.ts' },
      { find: /^node:worker_threads$/, replacement: 'porting/js/shims/worker_threads.ts' },
      { find: /^node:stream$/,     replacement: 'porting/js/shims/stream.ts' },
      { find: /^node:http$/,       replacement: 'porting/js/shims/http-types.ts' },
      { find: /^node:os$/,         replacement: 'porting/js/shims/os.ts' },
      // @any-listen/nodejs 各子路径 → Android 实现
      { find: /^@any-listen\/nodejs$/,            replacement: 'porting/js/nodejs/index.ts' },
      { find: /^@any-listen\/nodejs\/(.*)$/,      replacement: 'porting/js/nodejs/$1.ts' },
      // 共享源码（原样复用）
      { find: /^@any-listen\/app\/(.*)$/,         replacement: `${SRC}/shared/app/$1` },
      { find: /^@any-listen\/(common|web|types|theme|i18n)\/(.*)$/, replacement: `${SRC}/shared/$1/$2` },
      { find: /^view-main\/(.*)$/,                replacement: `${SRC}/view-main/$1` },
    ],
  },
  build: { target: 'esnext', rollupOptions: { input: { spa: '...', 'core.worker': ..., ... } } },
})
```

### 6.3 构建顺序（`:webassets` 任务的依赖图）

```
1. pnpm -C source install && pnpm -C source build:shared        # 若上游有产物（types/i18n/theme 多为源码直引，可能不需要）
2. pnpm -C porting/js build:extension-preload                   # 产出 extension-preload.js（IIFE）
   ↳ 复制 source/packages/shared/extension-preload，只改 vite output 到 porting/dist
3. pnpm -C porting/js build                                     # 产出 spa/ + 4 个 *.worker.js + wasm/
4. :webassets copy → app/src/main/assets/web/{spa,workers,wasm,extension-preload.js}
5. :app assembleDebug/Release
```

SPA 与音频同源要求（§3.3）→ `LocalHttpServer` 从 `assets/web/spa` 提供静态文件，端口固定（`17930`），首帧注入 `<script>window.__ANYLISTEN_TOKEN__='...'</script>`。

### 6.4 跟随上游 dev 分支的升级/rebase 成本评估

| 变更类型 | 影响面 | 成本 |
|---|---|---|
| `@shared/app` 业务逻辑改动 | 零（alias 直引源码，`git pull` 即生效） | **0** |
| 新增/改动 `@any-listen/nodejs` 导出的 API | 需同步 `porting/js/nodejs/index.ts` | 低（每次 patch 级，~10–30 行） |
| `tables.ts` DDL / `DB_VERSION` 变更 | SqliteAdapter 无需改（migrate/verifyDB 随源码走） | **0** |
| `better-sqlite3` API 用法扩展（如开始用 `lastInsertRowid`/`pluck`） | 需扩 SqliteAdapter | 低–中（每次增加约 20 行） |
| 新增 `node:*` 内建依赖 | 需加 shim + alias | 中（需人工评估） |
| 新增 `@any-listen/nodejs` 子模块 | 需实现 Android 版 | 中 |
| `extensionService/vm/*` 改动（host 函数签名变化） | 需同步 `shims/vm.ts` 的 primitive 白名单 | 中–高（最脆弱点） |
| `view-main` UI 改动 | 零，但会与 uiux 的触控重写冲突 → **需维护 UI patch 栈** | 中（长期最大维护成本） |
| `extension-preload` 改动 | 零（直接复用其构建流程） | 0 |

**缓解策略**
1. 把 `source/` 作为 **git submodule / 固定 commit 引入**（不是 fork 长期漂移），升级 = 换 submodule 指针 + 跑 `porting` 的回归清单（约 12 项冒烟测试）。
2. `shims/vm.ts` 加**契约测试**：断言所有 `EXTENSION_VM_IPC_FUNC_NAMES`（`common/constants.ts:139-153`）都能被映射，任一未覆盖立即构建失败 —— 这样上游新增 host 函数不会静默失效。
3. UI 重写部分**独立成 `porting/js/host/ui-overrides/`**，只对必要的 Svelte 组件做条件覆盖（vite alias 单文件级），尽量避免 patch 上游 `view-main`。

---

## 7. 阶段门禁自检（对 R-01~R-17 逐条）

| 编号 | 风险 | 是否有明确适配策略 | 平台差异是否收敛到 Port | 说明 |
|---|---|---|---|---|
| R-01 | `better-sqlite3` | ✅ D2 | ✅ `SqlitePort`（JS/WASM，非跨语言） | 292 处同步调用零改造；仅 6 个 API |
| R-02 | `worker_threads`（3 worker） | ✅ D1 | ✅ 改 Web Worker，**不是 Port**（纯同进程线程） | 改 `worker/utils/index.ts` 约 10 行 + `worker.ts` 约 3 行 |
| R-03 | 本地扫描 + `chokidar` | ✅ D4 + FileSystemPort | ✅ `listTree`/`watch` | 热路径改原生批量，冷路径走 async fs shim |
| R-04 | `node:vm` 沙箱 | ✅ D3 | ✅ `SandboxPort`（JS/QuickJS） | vm 边界只传 primitive（已实测）→ 可行性高 |
| R-05 | 桌面歌词悬浮窗 | ⚠️ 部分 | ✅ 主形态为应用内歌词页（无 Port 需求）；悬浮窗为可选 `SYSTEM_ALERT_WINDOW` 增强，需 P1 决策 | **未决：是否做悬浮窗需 team-lead/用户确认** |
| R-06 | `file://` 播放 URL | ✅ D4 + LocalHttpServer | ✅ `FileSystemPort.toPlayableUrl` | 同源 loopback HTTP 同时解决 CORS/AudioWorklet/Range |
| R-07 | 托盘/热键/标题栏歌词 | ✅ `NotificationPort` + `MediaSessionPort` | ✅ | 形态不同但功能等价（PDR 已接受） |
| R-08 | AudioWorklet/`setSinkId` | ⚠️ 需真机（A-01/A-02） | ✅ `AudioPort` 双引擎切换 | `setSinkId` 在 Android 基本不可用 → 设置项隐藏；`AudioWorklet` 靠同源安全上下文保障 |
| R-09 | 后台保活 | ✅ D5 | ✅ `PowerPort`/`LifecyclePort`/`MediaSessionPort` | 三级保活 + 原生兜底 |
| R-10 | 应用级代理 | ✅ D5 + `HttpPort.setProxy` | ✅ | OkHttp 按请求注入 `Proxy` |
| R-11 | `font-list` | ✅ | ✅ `FileSystemPort.getEnv` 提供内置字体清单；`common.font` 改枚举 | — |
| R-12 | 文件对话框/外部链接 | ✅ | ✅ `IntentPort`/`FileSystemPort.pickDirectory`/`NotificationPort.showMessageBox` | — |
| R-13 | 桌面 UI 信息密度 | ⏳ 交 uiux（Phase 3 已出稿），**等级由 [中] 上调为 [高]** | n/a（UI 层允许重写，见本文档边界声明） | 设计基准 1020px，411dp 下 0.40 倍密度；`pxtorem` 恒等映射等于没做适配（§9.0 修正 E-13） || R-14 | `music-metadata` | ✅ | ✅ 纯 JS 复用，仅换 `parseFile`→`parseBuffer` | — |
| R-15 | 音频解码 | ✅ | n/a（Chromium 内置解码器） | — |
| R-16 | Koa/ws/jsonwebtoken | ✅ | n/a（不复用 web-server 网络层；鉴权无意义——单机单用户） | 本机 `ServerIPC` 不经 WS，直接 postMessage |
| R-17 | 许可证 AGPL+禁商用 | ⚠️ 合规，非技术 | — | PDR-003 个人自用不分发；**建议在 README 中显式声明衍生来源与 AGPL v3 义务**，避免后续误分发 |

### 7.1 平台差异泄漏自检（核心逻辑是否被污染）

| 检查项 | 结论 | 依据 |
|---|---|---|
| `@shared/app` 内是否有 `android`/`webview`/`kotlin` 字样 | ✅ 无 | 全文 grep 无命中 |
| `@shared/app` 是否直接读写文件路径以外的系统资源 | ✅ 无（全部经 `@any-listen/nodejs`） | §1.3 的 73 处导入点即为全部出口 |
| `view-main` 是否含平台分支 | ✅ 无 `node:*`、无 `electron`；仅 `import.meta.env.VITE_IS_DESKTOP` 等构建期开关 | 实测 |
| 音频引擎是否被 Android 特化 | ✅ 引擎文件不改；特化在新增的 `AudioEngineRouter` 外层 | §4.7 |
| 数据库逻辑是否被 Android 特化 | ✅ `dbService` 43 文件不改，仅 `db.ts` 8 行适配 + `SqlitePort` | §1.4 |
| 扩展沙箱代码是否被 Android 特化 | ✅ `extensionService/vm/*` 零改动，`node:vm` shim 吸收全部差异 | §3.2 |
| 是否有「桌面能用、Android 静默失效」的路径 | ⚠️ 1 处已知：`getMusicUrl` 的 `meta.deviceId !== machineId` 判定（`desktop/src/modules/music/local.ts:20`）→ 迁移后必须重绑 deviceId（§5.3 Step B4） | — |

---

## 8. 交付边界（给 fullstack / native / uiux 的对齐清单）

### 8.1 可立即交由 fullstack-dev 实现（接口已冻结）
1. `porting/js/shims/*`（path/fs/fs-promises/crypto/zlib/worker_threads/stream/process/setImmediate/http-types/os）——签名见 §4 与 §6.2。
2. `porting/js/nodejs/*`（`index/request/download/watcher/Store/SafeFS/tar/sign/env/char/music/strc/webdav-client/mirrorReuqest`）。
3. `porting/js/ports/{sqlite,settings,bridge-client}.ts` + `SqliteAdapter`（§4.2）。
4. `porting/js/host/**`（AndroidShell：`app/`、`initModules`、`music/local.ts`、`fileSystem/`、`extension/exposeFuncs`）。
5. `porting/js/entries/*`（4 个 worker + main 的端口代理）+ `vite.config.mjs` alias 表。

### 8.2 可立即交由 native（Kotlin）实现
1. `:core-ports` 全部 Port 实现（§4.1/4.4/4.6/4.7/4.8/4.9）。
2. `:bridge`：`AndroidBridge`（`@JavascriptInterface`）+ `message2call` 帧编解码 + `LocalHttpServer`（SPA 静态 / `/stream` Range / `/p_url` 代理 / token）。
3. `:app`：`MainActivity`（WebView + 权限引导 + token 注入）、`PlaybackService`（前台服务 + MediaSession + 音频焦点 + 通知）、`LifecyclePort` 桥接。
4. `:webassets` 的 Gradle 构建任务。

### 8.3 依赖 uiux 规格才能定稿（**Phase 3 已答复，见 §9**）

| 原待定项 | 状态 |
|---|---|
| 1. 播放详情页/歌词页替代桌面歌词窗 → `desktopLyric.*` 45 项键映射 | ⏳ **仍待 uiux 给样式子集清单**（§9.9 第 4 条） |
| 2. 触控重写范围（哪些 `view-main` 页面走 alias 覆盖） | ✅ 方案已定（§9.0 两级策略 + §6.4 patch 栈）；具体页面清单仍待 uiux |
| 3. 通知栏歌词排版密度 → `NotificationPort.postMedia` 参数 | ✅ 已定（§9.2：歌词写进 `title` 单行 + 省略号，不做滚动），仅需 uiux 确认 |
| 4. 竖屏 411dp 信息密度 → 默认值调整 | ✅ **E-13 已修正**（§9.0）：`rootValue`/`common.fontSize` 保持 16 不改，改走布局重排 |
| 5. 悬浮歌词窗（R-05）是否 P1 | ⏳ **仍待 team-lead 裁决**（§8.4 第 1 条） |

**新增待回填（来自 §9）**：① `html.mobile` 断点值；② Tab 切换是否计入返回栈；③ `desktopLyric.*` 样式子集键清单。

### 8.4 本阶段未决、需 team-lead 裁决
1. **R-05 悬浮歌词窗**：做 / 不做（推荐不做，主形态走应用内歌词页）。
2. **minSdk**：推荐 29（见 §6.1 理由），若坚持 26 需接受 OPFS 升级路径不可用 + legacy 存储分支维护。
3. **A-01 兜底引擎**：是否在 Phase 4 就并行实现 `:native-audio`（ExoPlayer）作为 PDR-005 兜底。推荐**做接口预留、实现延后到 Phase 5 的 spike 结论之后**，但 `AudioEngineRouter` 的接口必须在 Phase 4 冻结。

---

## 9. 与 uiux 的接口对齐（Phase 3 答复 D-01~D-07）

> 输入：`docs/phase3-uiux.md` 与柯悦屏 2026-11-02 的 7 项提问。
> 本节所有签名均为**冻结**，fullstack/native 可直接按此实现；只允许新增字段，不允许改名或改语义。

### 9.0 先修正一条规格：E-13「已具备移动适配基础」不成立

规格包 E-13 基于 `vite.config.js` 的 pxtorem 配置判定"已具备移动适配基础"，**该结论需要修正**。复核证据：

| 事实 | 证据 |
|---|---|
| pxtorem `rootValue: 16` | `view-main/vite.config.js:159` |
| 根字号被显式设为 `16px` | `view-main/src/modules/app/init.ts:130`：`document.documentElement.style.fontSize = '16px'` |
| 且随后由设置项覆盖 | `view-main/src/modules/setting/init.ts:50`：`` `${setting['common.fontSize']}px` ``，`common.fontSize` 默认 **16**（`shared/common/defaultSetting.ts`） |
| 结论 | `px / 16 = rem`，而 `1rem = 16px` → **恒等映射，缩放系数 = 1.000，没有任何移动适配效果** |

**推论 1（重要）**：不能通过调 `rootValue` 或 `common.fontSize` 来做移动适配。`common.fontSize` 是"桌面端用户调字号"的旋钮，它同时缩放所有 `width/height/padding`（因为都进了 `propList`），在 411dp 视口上放大必然溢出。**`rootValue` 必须保持 16，`common.fontSize` 默认值必须保持 16。**

**推论 2（关键风险）**：真实设计基准是 **1020px 宽**，来源：
- `view-main/src/shared/browser/widnow.svelte.ts:54` `document.body.style.width = '1020px'`、`:70` `width: 1020`
- `view-main/src/components/layout/PlayDetail/RightLyric/LyricPlayer.svelte:16,56` `winRadio = clientWidth / 1020`

→ 在 411dp 视口上，`clientWidth ≈ 411`，`winRadio ≈ 0.40`。凡是用 `winRadio` 的地方会自动缩，**没用它的地方（绝大多数布局）保持桌面尺寸**。因此 R-13 不是"信息密度略高"，而是**桌面布局直接塞进 40% 宽度**。等级由 [中] 上调为 **[高]**，并确认 uiux 的"重排"结论是必要条件而非优化项。

**给 uiux 的支持性发现（我复核了你的两条）**：
1. ✅ 确认 `selectorBlackList: ['html', 'ignore-to-rem']`（`vite.config.js:185`）——`html` 选择器不会被转 rem，安全区 / `100dvh` 改造写在 `html`/`:root` 上不会与 pxtorem 冲突。
2. ✅ 确认 1020px 基准（见上）。补充一个你没提的：`html` 的 `font-size` 由 **JS 在运行时写**（`init.ts:130` + `setting/init.ts:50`），不是 CSS 里写死的 → 我们的 `html.mobile` 类若在 `<head>` 早期注入，JS 之后仍会覆盖 `fontSize`，两者不冲突（`class` 与 `style.fontSize` 是独立通道）。

**建议 uiux 采用的两级策略**（比"改 rootValue"安全）：
- **A 级（首选）**：不碰 rem 体系，靠**布局重排 + 断点媒体查询**消化 1020→411 的落差。`html` 上打 `class="mobile"`，用 `.mobile` 前缀做布局覆盖。
- **B 级（局部）**：个别组件用 `clamp()` / `min()` 做流式尺寸，不引入第二套 rem 基准。
- **禁止**：改 `rootValue`、改 `common.fontSize` 默认值、在 `body` 上加 `transform: scale(0.4)`（会破坏 `clientWidth` 计算与 `winRadio`，且触控命中区不被缩放）。

---

### 9.1 D-01 媒体会话归属：**原生持有**，用 `navigator.mediaSession` 替身桥接（`mediaSessionInfo.ts` 零改动）

**结论：原生持有（采纳你的推荐）。**

理由（比"推荐"更硬的依据）：`view-main/src/modules/player/init/mediaSessionInfo.ts` 已经用 `navigator.mediaSession` 完整实现了 8 个 action handler + metadata + positionState + playbackState（`:35,55,65,78,93,108-143,149-156,181,187`）。但 **Android WebView 不是 Chrome**：`navigator.mediaSession` 对象在 Blink 里存在，**不会**向系统 `MediaSessionManager` 注册（无媒体通知、无锁屏控件、无耳机键联动）。所以必须由 Kotlin 的 `MediaSessionCompat`/Media3 持有系统会话。

**实现方式：不覆盖文件、运行时替换 `navigator.mediaSession` 对象。**

```ts
// porting/js/host/mediasession-shim.ts —— 在 SPA 入口最早期同步执行
type ActionName = 'play'|'pause'|'stop'|'seekbackward'|'seekforward'
                | 'seekto'|'previoustrack'|'nexttrack'
type ActionHandler = ((details?: { action?: string; seekOffset?: number; seekTime?: number; fastSeek?: boolean }) => void) | null

class BridgeMediaSession {
  private handlers = new Map<ActionName, ActionHandler>()
  private _metadata: MediaMetadata | null = null
  private _playbackState: 'none'|'paused'|'playing' = 'none'

  get metadata() { return this._metadata }
  set metadata(v: MediaMetadata | null) {
    this._metadata = v
    Ports.mediaSession.setMetadata(v == null ? null : {
      title: v.title ?? '',
      artist: v.artist ?? '',
      album: v.album ?? '',
      artworkUrl: v.artwork?.[0]?.src ?? null,
    })
  }

  get playbackState() { return this._playbackState }
  set playbackState(s: 'none'|'paused'|'playing') {
    this._playbackState = s
    Ports.mediaSession.setPlaybackState(s)
  }

  setPositionState(p?: { duration?: number; playbackRate?: number; position?: number }) {
    if (!p || !Number.isFinite(p.duration) || p.duration! <= 0) return
    Ports.mediaSession.setPosition({
      durationMs: Math.round(p.duration! * 1000),
      positionMs: Math.round((p.position ?? 0) * 1000),
      playbackRate: p.playbackRate ?? 1,
    })
  }

  setActionHandler(name: ActionName, fn: ActionHandler) {
    if (fn) this.handlers.set(name, fn); else this.handlers.delete(name)
    Ports.mediaSession.setActions([...this.handlers.keys()])   // 只把"已注册"的按钮交给通知栏
  }

  /** Kotlin → JS：转发系统/耳机键/通知按钮 */
  _dispatch(name: ActionName, details?: unknown) {
    const fn = this.handlers.get(name); if (!fn) return
    try { fn(details as never) } catch (e) { console.error('[mediaSession]', name, e) }
  }
}

export function installMediaSessionShim() {
  // MediaMetadata 在旧 WebView 可能缺失，补一个最小构造器
  if (typeof window.MediaMetadata === 'undefined') {
    ;(window as any).MediaMetadata = class MediaMetadata implements MediaMetadata {
      title = ''; artist = ''; album = ''; artwork: MediaImage[] = []
      constructor(init: MediaMetadataInit = {}) { Object.assign(this, init) }
    }
  }
  const shim = new BridgeMediaSession()
  Object.defineProperty(navigator, 'mediaSession', { configurable: true, get: () => shim })
  ;(window as any).__anylisten_media_session_shim__ = shim  // 供 AndroidBridge 回调
}
```

**桥签名（冻结）**

```ts
interface MediaSessionPort {
  setMetadata(m: { title: string; artist: string; album: string; artworkUrl: string | null } | null): void
  setPlaybackState(s: 'none'|'paused'|'playing'): void
  setPosition(p: { durationMs: number; positionMs: number; playbackRate: number }): void
  setActions(actions: Array<'play'|'pause'|'stop'|'seekbackward'|'seekforward'
                        |'seekto'|'previoustrack'|'nexttrack'>): void
}
```
Kotlin 侧回调（`AndroidBridge` 上的 `@JavascriptInterface`）：
```
jsMediaSessionDispatch(action: String, seekOffsetMs: String?, seekTimeMs: String?)
  → webView.evaluateJavascript(
      `window.__anylisten_media_session_shim__._dispatch('${action}', ${detailsJson})`, null)
```
`NotificationPort.postMedia` 与 `MediaSessionPort` 由同一个 Kotlin `PlaybackService` 驱动（`MediaSession` 的 callback 里同时更新通知）。

**对 `mediaSessionInfo.ts` 的改造量 = 0 行。** 它已有的 8 个 handler、`updatePositionState`、`playbackState` 全部原样生效；`emptyAudio` 那个"保活静音音频"（`:22-30`）在 WebView 里同样有效（用于让 Chromium 认为页面在播放媒体）。

**需要实测的 1 个假设**：`Object.defineProperty(navigator, 'mediaSession', {...})` 在 WebView 中是否可覆盖（若 Blink 把该属性定义为不可 configurable，则降级为**单文件 alias 覆盖** `mediaSessionInfo.ts`，复制 200 行 + 改 2 处出口，成本仍很低）。**Phase 5 第一件事就验证这一条。**

### 9.2 D-02 后台保活与「后台与通知」设置分组

技术方案见 §3.4（前台服务 `mediaPlayback` + AudioFocus + MediaSession + `PARTIAL_WAKE_LOCK` + `onStop` 强制 DB flush），全部**原生做**，不依赖 JS 存活。

**建议「后台与通知」分组放这 5 个开关**（都已存在，不需要新建设置项）：

| 设置键 | 类型 | 移动端语义 |
|---|---|---|
| `player.isShowMediaSessionLyric` | bool | 通知/锁屏是否显示歌词（对应 `mediaSessionInfo.ts:44-47` 把歌词写进 `title` 的分支） |
| `player.isShowStatusBarLyric` | bool | 通知栏常驻歌词（原"状态栏歌词"的移动等价物，`tray` 裁剪后的落点） |
| `player.waitPlayEndStop` + `player.waitPlayEndStopTime` | bool + string | 播完自动停 + 定时停止（后台保活场景常见的省电诉求） |
| `player.autoSkipOnError` | bool | 播放出错自动下一首（网络/文件失效场景） |
| `player.isSavePlayTime` | bool | 退出/被杀后恢复播放位置（配合 §3.4 的进程恢复） |

**建议额外加 1 个"非设置项"入口**（不是 `AppSetting`，是引导按钮）：电池优化白名单跳转（`PowerPort.requestIgnoreBatteryOptimization()`）。理由：HyperOS 上这是后台被杀的头号原因，但它是系统权限不是应用偏好，不应该污染 133 项设置表。

`common.tryAutoUpdate` / `common.allowPreRelease` / `common.showChangeLog` 在「关于」页置灰或隐藏（§2.6 自动更新已裁剪）。

### 9.3 D-03 `fileSystemAction` 在 Android 的语义映射

`AnyListen.FileSystem.Actions` 只有 4 个动作（`shared/types/types/file_system.d.ts:39-44`），映射如下：

| IPC 动作 | 桌面/web 语义 | Android 语义（`MANAGE_EXTERNAL_STORAGE` 主方案） |
|---|---|---|
| `read_root_dir` | 返回 `allowPublicDir` 白名单目录列表 | 返回一个**伪根**：`[{ name: '内部存储', isFile:false }, { name:'SD 卡', isFile:false }]`（若已授权）；SAF 模式下返回已授权的 tree 列表。**注意**：桌面版 `read_root_dir` 直接读 `config.allowPublicDir`（`web-server/src/app/modules/fileSystem/index.ts:97-102`），Android 上该配置无意义（DB 里没有 `allowPublicDir`，它是 web-server 的 `config.json` 字段，桌面端也不同源） |
| `read_dir` | `fs.readdir(withFileTypes)` + `isDirOnly`/`fileFilter` 过滤 | 走 `FileSystemPort.listTree(root, {maxDepth:1})`（复用同一个批量接口，避免新增 Port 方法）；过滤逻辑原样保留 |
| `rename` | `fs.rename` | `FileSystemPort.rename` → `java.io.File.renameTo`；**SAF 模式下改名需 `DocumentsContract.renameDocument`**，部分 provider 不支持 → 返回 `EUNSUPPORTED`，UI 需能提示"该系统文件夹不支持重命名" |
| `create_dir` | `fs.mkdir` | `FileSystemPort.mkdirp`；SAF 模式用 `createDocument(MIME_TYPE_DIR)` |

**"配置音源"流程（`extension` 的 listProvider `form` 里选目录）**：桌面用 `dialog.showOpenDialog`，Android 用 `FileSystemPort.pickDirectory(title)`：
- 主方案：原生目录选择器（`ACTION_OPEN_DOCUMENT_TREE` 也可复用，但直接返回真实路径更省事：自绘一个目录浏览 Activity，基于 `File.listFiles`）。
- 返回 `{ path: '/storage/emulated/0/Music', displayName: 'Music' }`，写进扩展配置的 `form` 值里，**与桌面格式完全一致**（都是字符串路径）。

**「存储与缓存」分组建议**：
| 项 | 数据来源 | 操作 |
|---|---|---|
| 当前音乐目录（可多个） | 来自 `musicList` 的 local list 的 `meta.dir` 集合 | 添加（`pickDirectory`）/ 移除 / 重新扫描 |
| 已用空间（DB / 缓存 / 扩展 / 备份） | `FileSystemPort.getFreeSpace` + 目录 `stat` 汇总 | 清理缓存 / 清理备份 |
| `download.savePath` | `IntentPort.openDocument`（选目录） | 显示为可读名称而非原始路径 |
| `backup.backupPath` | 同上 | 同上 |
| 数据库手动备份 / 恢复 | `FileSystemPort` + `IntentPort.saveDocument/openDocument` | 立即备份 / 从文件恢复 |

> 提醒：SAF 模式下目录会呈现为 `content://…` 长串，**建议 UI 隐藏原始路径只显示 `displayName`**。所以请在设计上避免任何"展示完整路径"的控件（桌面版有，移动端应去掉）。主方案（真实路径）下可以显示，但建议统一按"只显示名字"设计，两套实现都能跑。

### 9.4 D-04 本地音乐播放 URL 与加载态

**结论：不用 `file://`、不用自定义 scheme、不用 `shouldInterceptRequest`，统一用本地 HTTP。**

```
filePath  ──FileSystemPort.toPlayableUrl()──►  http://127.0.0.1:17930/stream/<sha256(path)>.<ext>
                                              （LocalHttpServer 查映射表 → FileInputStream / ContentResolver
                                                支持 GET + HEAD + Range: bytes=，Cache-Control: no-store）
```

**为什么必须同源**（这条直接影响你的架构可行性，不只是 URL 格式）：
1. `plugins/player/index.ts:412` 的 `audioWorklet.addModule(url)` 要求**安全上下文**；`file://` 不是，`http://127.0.0.1` 是（Chromium 把 loopback 视为 potentially trustworthy）。
2. `plugins/player/index.ts:211` 的 `createMediaElementSource(audio)` 对**跨源**媒体元素会输出静音（CORS 静音保护）。SPA 与 `/stream` 同源时无此问题；若 SPA 走 `https://appassets.androidplatform.net` 而音频走 `http://127.0.0.1`，就是跨源 → 必须改 `plugins/player` 加 `crossOrigin="anonymous"`，破坏"零改源码复用"。**所以 SPA 与音频必须同一个 origin。**
3. `Range` 支持 → 进度条拖动/seek 可用（桌面 `file://` 也依赖它）。

**对「本地」入口加载态设计的直接影响（3 条，请据此设计）**：
1. **URL 获取是异步的，但很快**：`getMusicUrl` 是一次 `ServerIPC` RPC（跨 Worker）+ 一次 hash 计算，实测预期 < 30ms（`[假设]`，Phase 5 标定）。→ **不需要"加载中"骨架页**，只在"首次进入本地列表"时需要一个扫描进度态。
2. **首次失败重试一次**：`LocalHttpServer` 若端口被占会换端口，SPA 会在启动时从 `/__bridge/config` 拿到当前 `origin`。播放器不需要处理这个（URL 由后端给），但**你设计的"播放失败提示"要区分**：`MEDIA_ERR_SRC_NOT_SUPPORTED`（文件不存在/编码不支持）vs 网络错误（本地服务异常）。建议提示语分开。
3. **`Range` 未就绪时不要显示可拖动进度条**：`<audio>` 的 `duration` 在拿到首字节后才有值。建议播放页在 `duration` 未知时显示 loading 态的进度条（这点桌面版其实也有，可沿用）。

**一个已知的静默失效点**（请 UI 侧配合）：`getMusicUrl` 只在 `musicInfo.meta.deviceId === appState.machineId` 时返回 URL（`desktop/src/modules/music/local.ts:20`）。迁移后 `deviceId` 不匹配会让"本地歌"点了没反应。→ **建议本地列表对 `deviceId` 不匹配的条目显示"需重新扫描"标记**（我会在 `music/local.ts` 里改成一个显式状态而不是返回 null，届时给你字段）。

### 9.5 D-05 扩展 `contributes.settings` 在 WASM 沙箱下是否 100% 一致：**是，完全一致**

理由（结构性保证，不是推断）：
1. `contributes.settings?: FormItems[]` 是 **`manifest.json` 里的纯 JSON**（`shared/types/types/extension.d.ts:129`）。
2. 它由 **宿主侧** 的 `extensionService/shared/manifest.ts`（453 行）解析，读文件走 FileSystemPort。**这一步完全不进沙箱**。
3. 沙箱（QuickJS）只负责 `runExtension` 执行扩展入口 JS（`vm/index.ts:105-114`）。`contributes`、`grant`、`i18nMessages`、`publicKey` 全部在 `parseExtension` 阶段由宿主读出（`manage.ts:33-46`）。
4. `ExtensionSetting` 运行时结构 `{ id, name, internal, settingItems: FormValueItem[] }`（`extension.d.ts:146-152`）由宿主 `buildExtensionSettings` 生成，也与桌面一致。

→ **「设置 › 扩展」的 `Setting/ExtensionSetting/*` 组件可 100% 复用，不需要任何字段映射。** 你唯一要注意的是：`FormItems` 里若有 `type: 'file'`/目录选择类控件，其值在 SAF 模式下会是 `content://`，展示需按 §9.3 的"只显示名字"规则处理。

### 9.6 D-06 桥注入时机与宿主判定：**双保险可行，但要注意 `VITE_IS_ANDROID` 需要我们自己构建 SPA**

**注入时机（精确到字节）**

`LocalHttpServer` 返回 `/` 时，对 `assets/web/spa/index.html` 做一次字符串替换，把桥脚本插到 `<head>` 最前面（**必须在任何 module script 之前**，因为 SPA 入口会同步读 `window.__anylisten_ipc_init__`）：

```html
<head><script src="/__anylisten_bridge.js"></script><!-- 原 head 内容 -->
```
`__anylisten_bridge.js`（约 3–5KB，普通 script、非 module、`defer` 都不要）内部依次：
1. 定义 `window.__anylisten_android__ = { ports, token, version, origin }`
2. 安装 `installMediaSessionShim()`（§9.1）
3. 安装 `window.__anylisten_android_nav__`（§9.7）
4. **定义 `window.__anylisten_ipc_init__`**（这是 `view-main/src/shared/ipc/ipc.ts:14-49` 唯一读取的注入点，签名必须逐字匹配）
5. 打 `document.documentElement.classList.add('mobile', 'android')`（`documentElement` 在 `<head>` 里已存在，可安全操作）
6. 写 `window.__ANYLISTEN_TOKEN__`、向 `/__bridge/boot` 拉配置（端口/版本/能力位）

**为什么不用 `WebViewClient.shouldInterceptRequest` / `addJavascriptInterface` 注入桥**：`addJavascriptInterface` 只在页面导航完成前后可用，且我们本来就要改 HTML，服务端注入更可控、可测试（浏览器里也能跑）。

**`html.mobile` + `VITE_IS_ANDROID` 双保险：可行，但有一个前提要纠正**

`VITE_IS_ANDROID` 是**编译期**常量，只有「我们自己用 vite 构建 SPA」时才存在。所以 **不能直接复用上游 `pnpm build:web` 的产物**，必须走 `porting/js/vite.config.mjs` 的 `android` target。必须显式 `define` 的变量（实测使用频次）：

| 变量 | view-main 使用次数 | Android 取值 |
|---|---:|---|
| `import.meta.env.VITE_IS_DESKTOP` | 44 | `false` |
| `import.meta.env.VITE_IS_WEB` | 36 | `true` |
| `import.meta.env.VITE_IS_MAC` | 7 | `false` |
| `import.meta.env.VITE_COMMIT_ID` | 1 | 构建时注入 git 短 hash 或 `'android'` |
| `import.meta.env.VITE_IS_ANDROID`（**新增**） | — | `true` |

> ⚠️ **陷阱**：`VITE_IS_DESKTOP`/`VITE_IS_WEB` 未定义时是 `undefined`（falsy），代码会静默走"既不是桌面也不是 web"的第三分支，行为不可预测。必须全部显式 define，并在构建脚本里加断言：`grep -c "VITE_IS_" 产物` 为 0（未替换则构建失败）。

**双保险的正确用法（建议给 uiux）**：
- **`html.mobile`（运行时）**：用于**布局/CSS** 分支。优点：浏览器 DevTools 里也能手动加 class 复现手机布局，调试成本低。
- **`VITE_IS_ANDROID`（编译期）**：只用于**无法运行时切换**的东西——① 裁剪桌面专有组件（`desktopLyric` 全套、`tray` 相关、`hotKey` 全局键 UI）；② 决定是否 `import` 某个模块（tree-shaking 减包体）；③ 能力位默认值。
- **不要**用 `VITE_IS_ANDROID` 做布局判断（会因为无法在浏览器调试而拖慢迭代）。

### 9.7 D-07 返回键契约（冻结）

```ts
// 由 /__anylisten_bridge.js 注入（早于 SPA）
declare global {
  interface Window {
    __anylisten_android_nav__: {
      /** 供 Kotlin 在 onBackPressed 里同步判断（值由 JS 主动推送） */
      canGoBack: boolean
      /** Kotlin 调用：执行返回 */
      goBack(): void
      /** UI 侧注册更高优先级的返回处理器（ActionSheet/弹窗/编辑器）。
       *  返回 true = 已消费，不再走路由返回。
       *  返回 unsubscribe 函数。栈式：后注册的先执行。 */
      pushBackHandler(fn: () => boolean): () => void
    }
  }
}
```

**Kotlin 侧（`MainActivity`）**：
```kotlin
override fun onBackPressed() {
  // 同步读缓存值，避免 evaluateJavascript 的异步延迟导致返回键"迟滞"
  if (bridge.canGoBackCached) {
    webView.evaluateJavascript("window.__anylisten_android_nav__.goBack()", null)
  } else if (playbackService.isPlaying) {
    moveTaskToBack(true)        // 音乐在播 → 退到后台不退出（符合音乐 App 惯例）
  } else {
    super.onBackPressed()       // 结束
  }
}
```
```java
@JavascriptInterface fun setCanGoBack(v: Boolean) { bridge.canGoBackCached = v }
```

**JS 侧（bridge 内实现）**——用 `svelte-spa-router` 的 `$location` 与自己的深度栈：
```ts
const stack: string[] = []           // ['/', '/library', '/songList/abc']
const backHandlers: Array<() => boolean> = []
location.subscribe((loc) => {
  if (loc === stack[stack.length - 1]) return
  const i = stack.lastIndexOf(loc)
  if (i >= 0) stack.length = i + 1   // 后退
  else stack.push(loc)               // 前进
  androidBridge.setCanGoBack(stack.length > 1)
})
window.__anylisten_android_nav__ = {
  get canGoBack() { return stack.length > 1 || backHandlers.length > 0 },
  goBack() {
    for (let i = backHandlers.length - 1; i >= 0; i--) if (backHandlers[i]()) return
    if (stack.length > 1) history.back()
  },
  pushBackHandler(fn) { backHandlers.push(fn); androidBridge.setCanGoBack(true)
                        return () => { const i = backHandlers.indexOf(fn); if (i>=0) backHandlers.splice(i,1) } },
}
```

**给 uiux 的对应关系（你的 5 级返回链）**

已自查确认的两个事实（**你不用再回填这两点**）：
- **PlayDetail 不是路由，是 overlay**：路由表只有 12 条（`plugins/routes.ts:15-27`：`/online`、`/online/songlist`、`/online/topSongs`、`/library`、`/songList/list`、`/songList/detail`、`/topSongs`、`/list`、`/download`、`/settings`、`/extenstion`、`*`），`PlayDetail` 由 `components/layout/index.svelte:6,17` 平级渲染 → 它必须走 `pushBackHandler`，不能靠 `history.back()`。
- **路由是 hash 模式**：`plugins/svelte-spa-router/navigator.ts:144,209` 写 `window.location.hash`，`:73` 听 `hashchange`，`:156` 用 `history.back()`。→ `history.back()` 可用；`history.length` 不可靠（跨 reload），所以用自定义栈。

| 你的层级 | 由谁处理 | 实现方式 |
|---|---|---|
| ① ActionSheet / 弹窗 / 输入框 | UI 组件 | `pushBackHandler(() => { close(); return true })`，`onMount` 注册、`onDestroy` 注销 |
| ② 播放详情页 PlayDetail（overlay） | UI 组件（已确认非路由） | `pushBackHandler(() => { playerState.showPlayDetail = false; return true })` |
| ③ 二级页（`/songList/detail`、`/topSongs`、`/list`、`/download`、`Settings` 子页） | 路由 | `history.back()` |
| ④ Tab 首页（`/online`、`/library`、`/settings`、`/extenstion`） | 路由栈深度 1 | `canGoBack=false` |
| ⑤ 退出 | Kotlin | `isPlaying ? moveTaskToBack : finish()` |

> 注：Tab 之间的切换在 `view-main` 里是否写历史（`push` vs `replace`）我没逐条确认 —— 若 Tab 切换走 `push`，栈深会 >1，返回键会先回到上一个 Tab（这是 iOS/Android 常见行为，可接受）；若你希望返回键从任意 Tab 直接退到"默认 Tab 再退出"，需要额外在 bridge 里把 `stack` 过滤为只保留非 Tab 路由。**这条按你的交互意愿定，告诉我我改 bridge 即可。**

### 9.8 澄清：「复用 WebView UI」与「ExoPlayer 兜底」不冲突

你担心的点（我的 ExoPlayer 兜底会不会导致播放页控件层级变化）——**不会**，因为控制流方向是单向的：

```
JS playerState ──(唯一真相源)──► UI 控件
      │
      └─► AudioEngineRouter ──► [A] Web Audio 引擎（默认）
                              └─► [B] 原生 ExoPlayer（仅 A-01 失败时）
```
- **UI 永远读 JS 的 `playerState`**（`view-main/src/modules/player/store/state.ts`），不看引擎是谁；播放页组件、进度条、歌词滚动全部不变。
- 引擎切换时 `AudioEngineRouter` 负责把 `positionMs` 交接过去（同一 `audio session id`），UI 只可能看到一次 < 200ms 的短暂 loading。
- **MediaSession 恒由原持**（§9.1），不随引擎切换而变。

**唯一需要你在 UI 上配合的**：`getCapabilities()`（§4.7 已冻结）返回 `audioWorklet:false` 时，`player.soundEffect.pitchShifter.*` 相关控件置灰；`convolver:false` 时混响置灰。建议设计成"整组音效面板顶部一条提示 + 不支持项置灰"，而不是整块隐藏（否则切引擎时面板布局会跳）。

### 9.9 本轮答复后仍需你回填的 3 项

1. **通知栏歌词行数与超长处理**（§9.2 的 `lyricLine` 字段语义）。补充背景：`mediaSessionInfo.ts:44-47` 的做法是把**整句歌词写进 `title`、歌手写进 `artist`**（`if (lrc != null) { mediaMetadata.title = lrc; mediaMetadata.artist = playerState.title }`），所以"通知栏显示歌词"当前是免费得到的，不需要额外实现。但**滚动/双行**需要定时切片（`title` 是单行，系统会 ellipsis）。建议：正常态单行 + 省略号，不做滚动（省电、不引起通知频繁重建）。
2. **`html.mobile` 的布局断点值**（我先按 `max-width: 640px` 预置，你可覆盖）。
3. **Tab 切换是否应计入返回栈**（§9.7 末尾那条）。

> 另：`desktopLyric.*` 45 项 → 约 12 项样式子集的**具体键清单**仍需你给（§8.3 第 1 项）。我这边已按"A 级布局重排 + B 级 clamp"的方案预留了键映射空间，你给清单我就能出 `migrateV3`。
