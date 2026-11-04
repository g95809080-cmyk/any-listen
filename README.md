# Any Listen → Android

把桌面版 [Any Listen](https://github.com/lyswhut/any-listen)（Electron + Koa + better-sqlite3）移植成可在 Android 手机上独立运行的本地音乐播放器：**服务端逻辑与 UI 都跑在手机上**，离线可用，保留第三方扩展生态。

> **许可证与用途**：上游为 **AGPL v3 + 附加禁止商用条款**。本项目按 PDR-003 **仅个人使用与学习，不分发、不商用**。
> 一旦改变用途（发给他人 / 上架 / 商用），必须先读 `docs/phase6-compliance.md` §4.2 的 C-1 ~ C-7，其中 C-1（整体以 AGPL v3 开源）与 C-2（附加条款呈现方式需用户/法务拍板）是**不满足则不可分发**的硬条件。

---

## 目录结构

| 路径 | 内容 | 是否改动上游 |
|---|---|---|
| `source/` | 上游 any-listen 源码（branch `dev`，commit `c8f40eab`） | **零改动**，`git status --porcelain` 必须为空 |
| `porting/js/` | 移植层：vite 构建的 SPA + 4 个 worker + Ports 适配层 + 移动端 UI 覆写 | — |
| `porting/android/` | Android 壳：Kotlin 桥（message2call）、本地 HTTP 服务、WebView 宿主、文件系统/音频/通知 Port | — |
| `docs/` | 阶段规格、架构决策、UI/UX 规格、移植决策记录（PDR）、合规报告 | — |
| `artifacts/` | 实测截图、logcat、CDP 探针脚本 | — |

## 运行形态

```
UI 主线程（Svelte + Web Audio/AudioWorklet）
  ↕ MessagePort
core.worker（@any-listen/app 全部业务模块 + 本地 HTTP 服务）
  ├─ db.worker    SQLite → sql.js(WASM)
  ├─ util.worker  元数据解析 / 文件遍历
  └─ ext.worker   扩展沙箱 node:vm → QuickJS(WASM)
  ↕ Ports 帧（message2call v2）
Kotlin 端口层（FileSystem / Http / Sqlite / Audio / Notification / Lifecycle）
```

WebView 通过 `http://127.0.0.1:<随机端口>?t=<token>` 加载 SPA，与 `/stream/<id>` 音源同源，因此 AudioWorklet 可用。

## 覆写清单（`vite.config.mjs` 的 `OVERRIDES`）

**`source/` 零改动是硬约束**，上游任何文件都不改。所有「必须换实现」的落点集中在
`porting/js/vite.config.mjs` 的覆写表（解析期重定向，key = 相对 `source/packages` 的路径）。
`vite.config.mjs` 文件头要求：**任何被 `OVERRIDES` 命中的条目，都必须在下表有一条对应说明。**

| # | 上游文件（key） | 覆写实现 | 为什么必须覆盖 |
|---|---|---|---|
| A-1 | `shared/nodejs/index` | `nodejs/index.ts` | 只替换 `fileSha256`/`*Sync`/`getPlatform` 等 6 个函数，其余 `export *` 沿用上游（Node 文件 API → `FileSystemPort`） |
| A-2 | `shared/nodejs/request` | `nodejs/request.ts` | undici → `HttpPort` |
| A-3 | `shared/nodejs/download`(+`/index`) | `nodejs/download.ts` | `node:http` 流式下载 → `HttpPort.downloadTo` |
| A-4 | `shared/nodejs/watcher` | `nodejs/watcher.ts` | chokidar → `FileSystemPort.watch` |
| A-5 | `shared/nodejs/Store` | `nodejs/Store.ts` | 同步 IO → 内存同步 + 异步原子落盘 |
| A-6 | `shared/nodejs/SafeFS` | `nodejs/SafeFS.ts` | Node `fs` → `FileSystemPort` |
| A-7 | `shared/nodejs/music` | `nodejs/music.ts` | `parseFile` → `readFile` + `parseBuffer` |
| A-8 | `shared/nodejs/music-metadata` | `nodejs/music-metadata.ts` | 同上，去掉 Node 专有入口 |
| A-9 | `shared/nodejs/tar` | `nodejs/tar.ts` | tar 包 → `TarPort`（Kotlin 侧解压） |
| A-10 | `shared/nodejs/logs` | `nodejs/logs.ts` | `child_process.exec` → `LogPort` |
| A-11 | `shared/app/modules/worker/utils/index` | `host/worker/index.ts` | `new Worker(path.join(__dirname, …))` → `new Worker(url, {type:'module'})`；每次 spawn 新建 `MessageChannel`（ERR-010/ERR-011） |
| A-12 | `shared/app/modules/worker/utils/worker` | `host/worker/expose.ts` | `parentPort.once('message')` / `port instanceof MessagePort` → 原生 `MessagePort` |
| A-13 | `view-main/src/components/common/MusicList/List/index.svelte` | `ui/overrides/components/common/MusicList/List/index.svelte` | **O-1** 曲库歌曲行：行高 72dp + 长按多选操作条 |
| A-14 | `view-main/src/components/layout/PlayDetail/Header.svelte` | `ui/overrides/components/layout/PlayDetail/Header.svelte` | **O-7**（本轮新增，D-10）：上游顶栏只在 `VITE_IS_DESKTOP`/`VITE_IS_WEB` 分支渲染，本构建两者皆 false → `domBtns` 永不绑定 → `onMount` 里 `domBtns!.addEventListener` 抛 TypeError，播放详情整页白屏。覆写补「挂监听前判空」+「`VITE_IS_ANDROID` 分支渲染顶栏（关闭键 44dp，uiux §5 要求）」 |
| A-15 | `view-main/src/views/Library/index.svelte` | `ui/overrides/views/Library/index.svelte` | **O-2** 曲库页空态：上游 `{#if listInfo}` 无 else → `$query.id` 为空时内容区零节点（纯白、不报错）；空态里的「导入本地音乐」是手机上加歌唯一入口 |
| A-16 | `view-main/src/shared/ipc/app/index` | `ui/overrides/shared/ipc/app/index.ts` | **O-6** 只替换 `showOpenDialog`/`showSaveDialog`（Android 无原生对话框 IPC，改走内置文件浏览器），其余 30+ 转发函数 `export *` 继承 |
| A-17 | `web-server/src/app/modules/extension/index` | `host/app/modules/extension/index.ts` | 上游 `readFile(joinPath(__dirname,'extension-preload.js'))` 在 Worker 里 `ReferenceError`（core.worker 启动失败 → 永久 Loading），改为 fetch 静态资源；另加 restart 串行链（ERR-011） |
| A-18 | `view-main/src/components/common/PlaylistBtn/shared` | `ui/overrides/components/common/PlaylistBtn/shared.ts` | **O-8**（D-16 第二入口）：播放列表（队列）用 `createClickHandle` 做 400ms 双击窗口，首击空转；触屏改为单击即切歌。配套 A-13 的曲库列表单击即播 |

> 另有反向通道 `RAW_TARGETS`（`@any-listen/nodejs/uplink`、`@porting-uplink/web-server/app/modules/extension`、
> `@ui-raw/shared/ipc/app`），仅供覆写文件内部引用「上游原版本」，不改变任何上游文件的解析结果；
> Node 内建模块 → `shims/*` 的映射见 `NODE_SHIMS`，不属于覆写表。

## 构建

前置：Node ≥ 22、pnpm ≥ 10、JDK 17、Android SDK（compileSdk 35 / minSdk 29 / arm64-v8a）。

```bash
# 1. JS 产物（约 17-25 分钟，取决于 .trash 清理是否顺畅）
cd porting/js
pnpm install
pnpm typecheck      # 只对移植层设门禁（strict）
pnpm build:all      # dist/spa + dist/**/*.worker.js + dist/extension-preload
pnpm smoke          # 产物与行为冒烟（对标 Node 原生实现）

# 2. APK（gradle 会自动把 dist 同步进 assets，任务 :webassets:syncWebAssets）
cd ../android
./gradlew assembleDebug -PrequireWeb=true
#   ⚠️ :webassets:syncWebAssets **dependsOn buildWebJs**，会再跑一次 `pnpm build:all`。
#   刚手动跑过 build:all 的话加 -PskipWeb=true：只同步不重跑，22 秒完成（实测）。
#   反之若直接 `./gradlew assembleDebug`，总耗时 = JS 一次 + Kotlin 一次。
# 产物：app/build/outputs/apk/debug/app-debug.apk

# 2.5 产物一致性门禁（F-7）：单侧自洽 + dist↔assets 逐文件指纹比对
node scripts/check-webdist.mjs            # 查 porting/js/dist（默认）
node scripts/check-webdist.mjs --assets   # 查 app/src/main/assets/web/spa（打包后复查）
# 不一致 → `VERDICT: INCONSISTENT` + exit 1，并把两侧的值都打出来

# 3. 装到设备
export MSYS_NO_PATHCONV=1                                  # Windows Git Bash 必需
ADB=/c/Users/kuma/AppData/Local/Android/Sdk/platform-tools/adb.exe
"$ADB" install -r app/build/outputs/apk/debug/app-debug.apk
"$ADB" shell am force-stop com.anylisten.android
# ⚠️ 启动组件是 com.anylisten.app.MainActivity（**不是** .MainActivity —— 后者会
# `Error type 3: Activity class does not exist`，包名与 applicationId 不同名，见 D-21）
"$ADB" shell am start -n com.anylisten.android/com.anylisten.app.MainActivity
```

**构建期别踩的坑**

- `pnpm run build:all` 的 `clean` 阶段会把旧 `dist` **rename 进 `.trash/`**（不是删除）。有删除配额的环境会在 `shrink-assets` 阶段报 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`，此时删除失败降级为告警，可单独补跑 `node scripts/shrink-assets.mjs`。
- **不要并发构建**。两个 `build:all` 同时跑会互相把 `dist` rename 走，谁先完成谁拿到半成品。构建窗口必须独占。
- 判断产物是否换代，看 `dist/spa/index.html` 引用的 `main.*.js` hash，而不是看 worker 文件在不在（worker hash 常年不变）。
- `dist/spa/assets` 里约 90 个 `.map` 会被 gradle `exclude("**/*.map")` 挡掉，文件数对不上时先扣掉 sourcemap。

## 运行时排障

| 现象 | 先看什么 |
|---|---|
| 永久 `Loading...` | logcat 里有没有 `[ipc] webview client connected`。**没有** = `initModules()` 有 init reject；**有** = 看 `[ipc] 补投 N 帧` 与主题注入 |
| 白屏无报错 | 六条启动判据缺哪条：`[bootstrap] dataPath` → `[db.worker] sqlite ready preloaded=true` → `[ext.worker] quickjs ready` → `[ipc] webview client connected` → `[bootstrap] core worker ready` → `[ipc] 补投 1 帧` |
| 主题无色（`:root {}`） | `getThemeSetting` 响应 `id` 是否为空；空 = UI 早于 `initModules()` 连上了 |
| 曲库列表空 | `fs.listTree` 的 `total` 是否 > 0；> 0 而 UI 空，查 `onBatch` 回调是否被 response 抢先释放 |
| 弹窗/侧栏被压成单字竖排 | 该容器是不是 `width: N%`（桌面基准）——411dp 下要量实际像素 |

调试：`adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>`（本机 9222 常被占），然后 `artifacts/cdp-eval.mjs` / `cdp-console.mjs` / `cdp-tap.mjs` 直接对页面求值与抓 console。

## 文档索引

| 文档 | 内容 |
|---|---|
| `docs/phase1-spec.md` | 上游形态、依赖清单、功能地图、风险标记 |
| `docs/phase2-architecture.md` | 模块 [复用/适配/重写] 判定、Port 接口、构建分层 |
| `docs/phase3-uiux.md` | 触控交互规格、布局重排、断点与尺寸 |
| `docs/phase3-uiux-impl-spec.md` | 逐组件实现规格（含 tab、MiniPlayer、空态） |
| `docs/porting-decision-record.md` | **PDR-001~008 决策 + ERR-001~023 勘误**（每个坑的现象、量出来的证据、根因、修法、可推广教训） |
| `docs/phase5-acceptance-report.md` | **验收报告**：三重门禁签字、用例矩阵、触控实测、缺陷清单（D-1~D-31）、v1/v2/v3 三轮复验 + 真机验收 + D-29/D-30/D-16 修复复验（§12/§13）+ D-27/D-31 修复复验（§14） |
| `docs/phase6-compliance.md` | 上游零改动验证、许可证清单与义务、产物泄露检查、许可证门禁签字 |

## 当前状态

**交付物**：`porting/android/app/build/outputs/apk/debug/app-debug.apk`
**sha256 `ceb58fa9aa138cd71388c79004e32b870b2064062b86f8fb6e0d1e0312708df6`**，24,343,888 B，包内入口 `assets/web/spa/assets/main.CJYsJ0I6.js`。

> ⚠️ 连续几轮的包**字节数完全相同**（都是 24,343,888，更早是 24,343,591）—— 判身份一律用 **sha256 + 包内 `main.*.js` 文件名**，比对大小会误判成「没换包」（D-13 就是这么漏出去的）。Kotlin 侧改动还要额外用 `unzip -p … classes*.dex | grep` 确认真进了包。

> 本包在真机复验过 D-27/D-31：连按返回键「弹层 → 弹窗 → 播放详情」逐级关闭且未误触弹窗内的「重置」；`Page.crash` 连杀三次渲染进程（含后台态）均自动重建，冷启动到首帧 790ms，0 崩溃 0 ANR。

**三道门禁（QA 独立实测，`docs/phase5-acceptance-report.md` §10）**

| 门禁 | 结论 | 依据 |
|---|---|---|
| 功能等价性 | **通过** | 启动六判据、导入→播放→时长落盘→自动切歌、设置 13 项全可达、扩展管理可用、返回键三层语义正确 |
| 移动端触控可用性 | **通过** | 可见控件 0 个低于 44×44；浮层开合 12 轮 DOM 归零；无穿透/串台 |
| 许可证合规 | **有条件通过** | 上游零改动（`git status` 0 行）；C-1/C-2 需用户书面裁决 |

> **技术门禁通过 ≠ 可商用分发。** 上游为 AGPL v3 + 附加禁止商用条款，本项目按 PDR-003 仅个人使用与学习；一旦改变用途（发给他人 / 上架 / 商用），必须先满足 `docs/phase6-compliance.md` §4.2 的 C-1（整体以 AGPL v3 开源）与 C-2（附加条款呈现方式），这两条工程侧不得自行裁定。

**已实测通过**：启动链路六条判据；主题注入（242 色 / `--color-primary = rgb(79,98,208)`）；曲库列表（**单击即播**）；导入本地音乐端到端（选目录 → 双击进入 → 多选 → 确认 → 入库，实测 3 首 WAV）；播放链路（AAudio 开流 + `play_time` 每 250ms 落盘 + 自动切歌 + MiniPlayer）；播放详情页 11 个控制键全部真实触摸可达；设置页 13 项横滑可达；扩展管理页入口与五个分区；返回键「弹层 → 弹窗 → 播放详情 → 子页 → 根页退出」五层语义（增补 D-27 的弹窗档）；冷启动 `Displayed` 790ms（< 1.5s）；**每日自动备份真实落盘**（`files/app/backup/db_backups/daily/…bak`）；**日志页可读**（3,943 字符真实日志、进出两次零异常）；**渲染进程被回收后自动重建**（连杀三次含后台态，573/679ms 恢复、进程号不变、订阅不叠加）。

**已知遗留（均不阻断交付）**

| 编号 | 内容 | 级别 |
|---|---|---|
| D-28 | 文件浏览器首层只有「路径即目录项」一行，双击进入无提示 → 容易被误判为「空目录」（QA 已证伪「导入坏了」的说法） | 提示 |
| D-24 | 扩展页 chip 行高 96dp（桌面 2 倍）；循环浮层无选中态（上游本就无 active 分支） | P2 |
| D-19 | 无歌词文件时播放页/迷你播放器显示内部文案 `Failed to obtain lyrics` | P2 |
| D-15~D-18 | 双击进目录、文件行高 42px、迷你播放器 0 gap | P2 |
| — | 搜索 Tab（上游 Search 视图为空壳，缺 IPC 搜索契约）、SAF 遍历（`displayPath` 恒为绝对路径）、quickjs 4 个 wasm 变体未裁剪（约 1.3 MiB）、release 未开 R8 | 待排期 |
| — | `porting/js/.trash/` 里累积了 9 个 old 目录（约 200 MB）。每次构建的 `clean` 阶段会把旧 `dist` rename 进去、删除又因配额失败，实测让 `build:all` 从 17 分钟涨到 25 分钟。手工清空该目录即可恢复 | 构建体验 |

**D-16 / D-27 / D-29 / D-30 / D-31 已修（本包，真机实测）**

| 编号 | 原现象 | 根因 | 修法与实测 |
|---|---|---|---|
| D-16 | 曲库行**单击不播放**、必须 400ms 内点两次；播放列表（队列）同样 | 上游 `MusicList/List/action.ts:48-66` 与 `PlaylistBtn/shared.ts` 都用手写的 400ms 双击窗口（桌面「单击选中 / 双击播放」语义），触屏没有双击概念 | 移动端覆写改为单击即播（`ui/overrides/.../MusicList/List/index.svelte`、新增 `.../PlaylistBtn/shared.ts`），多选走「多选」按钮、长按仍出右键菜单。实测：暂停态单击第 2 首 → 立即起播；再点第 3 首 → 换歌；队列浮层单击 03→01 一次到位；多选态点行只选中（已选 1→2 项）且当前曲不变 |
| D-29 | 每次冷启动 `[dbService] backup failed init PortError: fs.createReadStream is not available`；自动备份自 11-03 15:02 后再未产生文件 | `shims/fs.ts` 把 `createReadStream` 直接判为不支持，而上游 `backupTask/storage.ts:33` 用它算 sha256 做去重 | 在垫片里实现最小 `FsReadStream`（异步读全文件 → 按 start/end 切片 → `data`/`end`/`error`；带 `pipe`/`destroy`）。实测：本轮冷启动新建 `anylisten.data.db.20261104-093003313.bak`（114,688 B）、`backup failed` 0 次；第二次冷启动备份文件数仍为 2（同日去重生效） |
| D-30 | 进「日志输出」页抛 `ENOENT: log file not found …/files/app/logs/app.log`，页面无内容 | **写入与读取路径不一致**：Kotlin 写 `files/logs/anylisten-<日期>.log`，UI 按上游约定读 `files/app/logs/app.log` | `LogPort` 落盘改为 `files/app/logs/app.log`；`readLastLines` 文件不存在时返回空列表而非抛 ENOENT；JS 桥接层再加一层降级。实测：日志页读到 3,943 字符真实日志、进出两次 0 未捕获异常、旧目录停写 |
| D-27 | 返回键第 1 档只认 `.popup` / `.menu`，不含 `.modal` → 「播放详情 + 声音设置」时按返回把播放详情关掉、弹窗留成孤儿 | Modal 是居中对话框，既不是 `.popup` 也不是整屏覆盖层，原三档优先级里没有它的位置 | `androidBack.ts` 改为四档：**弹层 → 弹窗 → 播放详情 → hash 栈**，第 2 档走 `dismissModal()`。关闭入口不是「点关闭键」而是给 `.content` 派发 Escape（上游 `onkeydown` 处理，`keyclose` 默认 true）——因为本构建 `VITE_IS_DESKTOP/WEB` 皆 false，Modal 的 header 根本不渲染。**踩坑**：`querySelector('.header button')` 会命中弹窗内容区自带的「重置」按钮（音效面板有两个），一开始按返回等于重置用户配置；改为 `:scope > .content > header > button` 严格作用域。实测：三次返回依次关「倍速浮层 → 音效弹窗 → 播放详情」，探针 `__resetClicked=false` |
| D-31 | 长时间息屏/后台后 WebView 渲染进程被系统回收，回来页面变 `chrome-error://`，只能强杀 App | 从未实现 `WebViewClient.onRenderProcessGone`：框架默认返回 false 即**杀整个 app 进程**；页面进了错误页也没有任何自愈路径 | `MainActivity` 把 WebView 装配抽成 `createWebView()`（初建与重建共用一份配置），`onRenderProcessGone` 返回 true 并在 `post{}` 里「摘视图 → destroy → 新建 → loadApp」；`onResume` 检测 `chrome-error` 前缀走 `recoverPage()`；主文档加载失败也自愈。重建时 `LifecycleHub.clear()` 作废旧订阅（否则监听器按重建次数叠加）。实测：`Page.crash` 连杀三次（含后台态）进程号不变、679/573ms 恢复、`am send-trim-memory` 只收到 1 条回调（未叠加）、0 FATAL |

**已验证平台**：412×915 竖屏模拟器（x86_64 / API 36 / WebView Chromium 133）+ **arm64 真机 Xiaomi 2211133C / Android 16（393×872 CSS / dpr 2.75）**。真机复验结论见验收报告 §11：冷启动 490ms、六条判据齐全、D-10/D-11/D-22/D-23 全部成立、0 崩溃 0 ANR；因包内**无任何 `.so`（ABI 无关）**，「arm64 缺库」风险不成立。

**未覆盖范围（签字边界，别当担保用）**：横屏、平板/折叠屏、外接指针、release 构建、离线扩展商店（取证机无外网）、Android 版本跨度（仅 16 与 API 36 模拟器）。
