# Any Listen → Android

把桌面版 [Any Listen](https://github.com/lyswhut/any-listen)（Electron + Koa + better-sqlite3）移植成可在 Android 手机上独立运行的本地音乐播放器：**服务端逻辑与 UI 都跑在手机上**，离线可用，保留第三方扩展生态。

> **许可证**：上游为 **AGPL v3 + 附加禁止商用条款**。许可全文原样保留在根目录 `LICENSE`
> （`sha256 86e79e49…cf52c2`，与上游文件逐字节相同）；移植层的许可状态、AGPL §5 修改声明、
> 对应源码获取方式见 `NOTICE`。
>
> **用途**：当前按 PDR-003 **仅个人使用与学习，不分发、不商用**。
>
> **分发前**：必须闭环 `docs/phase6-compliance.md` §4.2 的 C-1 ~ C-7。其中 **C-1** 的工程材料
> 已就绪（`LICENSE` / `NOTICE` / 可 `git clone` 的源码树 / `docs/BUILD-from-source.md`），
> 且**干净目录从零重建已实测通过**（约 2.5 分钟出包、门禁 `VERDICT: OK`）；
> **C-2**（附加条款的呈现方式）仍需你书面裁决。

---

## 使用

1. 在 Android 10 或更新版本的手机上安装 `porting/android/app/build/outputs/apk/debug/app-debug.apk`。
2. 打开「曲库」导入本地音乐；需要在线资源时，在「设置 → 扩展」安装并启用**支持播放的音源扩展**（例如 `GD音乐台`），再到「在线」搜索。只提供搜索、封面或歌词能力的元数据扩展（例如 `Online Metadata`）不含 `musicUrl`，不能单独用于播放。
3. 曲库和设置可以在「设置 → 备份与恢复」一起导出；恢复时会保留备份中的歌单与设置项。

30 分钟息屏长测已由用户验收通过。当前 Debug 包在 Xiaomi 2211133C / Android 16 真机复验了本地与在线播放、GD 网易云搜索与单曲播放、歌词制作信息过滤与可读性、无歌词状态、设置备份恢复、文件选择、内置酷我/网易搜索和媒体会话；模拟器还覆盖了扩展设置保存、后台媒体键和歌单合并。`release` 包仍为此前构建并使用调试签名。详细进度见 `docs/phase5-acceptance-report.md` §16–24。

## 目录结构

| 路径 | 内容 | 是否改动上游 |
|---|---|---|
| `source/` | 上游 any-listen 源码（branch `dev`，commit `c8f40eab`） | **零改动**，`git status --porcelain` 必须为空 |
| `porting/js/` | 移植层：vite 构建的 SPA + 4 个 worker + Ports 适配层 + 移动端 UI 覆写 | — |
| `porting/android/` | Android 壳：Kotlin 桥（message2call）、本地 HTTP 服务、WebView 宿主、文件系统/音频/通知 Port | — |
| `docs/` | 阶段规格、架构决策、UI/UX 规格、移植决策记录（PDR）、合规报告 | — |
| `artifacts/` | 实测截图、logcat、CDP 探针脚本（**不入库**，见 `.gitignore`） | — |
| `LICENSE` / `NOTICE` | 上游许可全文（逐字节复制）+ 移植层许可状态与修改声明 | — |

> 本仓库只含**移植层**。`source/` 由使用者按 `NOTICE` §5 的地址与 commit 检出到**仓库根目录内**
> （与 `porting/` 并列），已被 `.gitignore` 排除 —— 因此 `git clone` 之后还需一步取上游，
> 见 `docs/BUILD-from-source.md`。

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
| A-13 | `view-main/src/components/common/MusicList/List/index.svelte` | `ui/overrides/components/common/MusicList/List/index.svelte` | **O-1** 曲库歌曲行：行高 72dp + 列表外多选操作条；长按保留右键菜单，单击即播 |
| A-14 | `view-main/src/components/layout/PlayDetail/Header.svelte` | `ui/overrides/components/layout/PlayDetail/Header.svelte` | **O-7**（本轮新增，D-10）：上游顶栏只在 `VITE_IS_DESKTOP`/`VITE_IS_WEB` 分支渲染，本构建两者皆 false → `domBtns` 永不绑定 → `onMount` 里 `domBtns!.addEventListener` 抛 TypeError，播放详情整页白屏。覆写补「挂监听前判空」+「`VITE_IS_ANDROID` 分支渲染顶栏（关闭键 44dp，uiux §5 要求）」 |
| A-15 | `view-main/src/views/Library/index.svelte` | `ui/overrides/views/Library/index.svelte` | **O-2** 曲库页空态：上游 `{#if listInfo}` 无 else → `$query.id` 为空时内容区零节点（纯白、不报错）；空态提供「导入本地音乐」入口 |
| A-16 | `view-main/src/shared/ipc/app/index` | `ui/overrides/shared/ipc/app/index.ts` | **O-6** 只替换 `showOpenDialog`/`showSaveDialog`（Android 无原生对话框 IPC，改走内置文件浏览器），其余 30+ 转发函数 `export *` 继承 |
| A-17 | `web-server/src/app/modules/extension/index` | `host/app/modules/extension/index.ts` | 上游 `readFile(joinPath(__dirname,'extension-preload.js'))` 在 Worker 里 `ReferenceError`（core.worker 启动失败 → 永久 Loading），改为 fetch 静态资源；另加 restart 串行链（ERR-011） |
| A-18 | `view-main/src/components/common/PlaylistBtn/shared` | `ui/overrides/components/common/PlaylistBtn/shared.ts` | **O-8**（D-16 第二入口）：播放列表（队列）用 `createClickHandle` 做 400ms 双击窗口，首击空转；触屏改为单击即切歌。配套 A-13 的曲库列表单击即播 |
| A-19 | `view-main/src/views/Extenstion/OnlineList.svelte` | `ui/overrides/views/Extenstion/OnlineList.svelte` | **O-9**（D-33）：扩展商店是桌面双列网格 `minmax(300px,1fr)` + 卡片 `min-width:300px`，393px 视口下 pxtorem 把 300px 压到 ~174px → 排两列、卡片互相压盖。改单列 |
| A-20 | `view-main/src/views/Extenstion/Header.svelte` | `ui/overrides/views/Extenstion/Header.svelte` | **O-10**（D-33）：顶栏 5 个中文 Tab 放进 393px 被压成竖排（「已/安/装」）。改为横向滚动 + 标签不换行 |
| A-21 | `view-main/src/views/Extenstion/InstalledList.svelte` | `ui/overrides/views/Extenstion/InstalledList.svelte` | **O-11**（D-33）：与 O-9 同一张桌面双列网格，用在「已安装」列表上；装完扩展即复现压盖，一并改单列 |
| A-22 | `view-main/src/views/Extenstion/ListItemOnline.svelte` | `ui/overrides/views/Extenstion/ListItemOnline.svelte` | **O-12**（D-33）：卡片 `height:100px` 经 pxtorem 只剩 58px，而内容需 ~94px → 描述压到版本行上；改高度自适应 + 宽度交给网格列 |
| A-23 | `view-main/src/components/material/fileExplorerModal/ListItem.svelte` | `ui/overrides/components/material/fileExplorerModal/ListItem.svelte` | 手机上文件夹统一单击进入；不再要求桌面式双击 |
| A-24 | `view-main/src/components/material/fileExplorerModal/Save.svelte` | `ui/overrides/components/material/fileExplorerModal/Save.svelte` | 把目录选择模式传给列表项；进入目标目录后可直接确认当前目录 |
| A-25 | `shared/app/modules/worker/extensionService/shared/configStore` | `host/app/modules/worker/extensionService/shared/configStore.ts` | 在扩展 Worker 内按需读取配置，保存时等待落盘，卸载时清除缓存 |
| A-26 | `shared/app/modules/worker/extensionService/shared/index` | `host/app/modules/worker/extensionService/shared/index.ts` | 同一扩展的并发配置更新按顺序执行，避免覆盖彼此的字段 |
| A-27 | `view-main/src/components/layout/PlayDetail/Footer/PlayStatusText.svelte` | `ui/overrides/components/layout/PlayDetail/Footer/PlayStatusText.svelte` | 把 `source not found`、`No script found`、超时和明文网络异常映射为可行动的中文提示；播放失败后显示常驻原因，切歌或成功播放时清除；无歌词错误不再直接铺到播放页 |
| A-28 | `view-main/src/components/layout/PlayBar/components/PlayInfo.svelte` | `ui/overrides/components/layout/PlayBar/components/PlayInfo.svelte` | 无歌词时迷你播放器显示歌手，而不是 `Failed to obtain lyrics` 内部文案；播放失败时优先显示常驻错误原因 |
| A-29 | `view-main/src/components/common/MusicList/List/action` | `ui/overrides/components/common/MusicList/List/action.ts` | 搜索结果是快照，不调用只支持 `songlist` / `topSongs` 的完整列表补全；修复 `Play all` / `Shuffle` 的 `unsupported source`，其他来源继续走上游实现 |
| A-30 | `view-main/src/modules/lyric/init` | `ui/overrides/modules/lyric/init.ts` | 过滤带时间戳的中英文制作人员行，以及开头 3 秒内形如「歌名 - 歌手」的标题行；正常唱词仍保留 |
| A-31 | `@any-listen/app/modules/backup`（`PACKAGE_OVERRIDES`） | `host/app/modules/backup/index.ts` | 上游备份只导出歌单。移植层把设置快照一起写入并在恢复时校验、合并，恢复后重启仍保留 |
| A-32 | `view-main/src/views/Setting/AppSetting/Backup/typeSelectModal/App.svelte` | `ui/overrides/views/Setting/AppSetting/Backup/typeSelectModal/App.svelte` | 上游把备份类型里的「设置」勾选框写死为 disabled；覆写恢复选择与回调 |
| A-33 | `view-main/src/components/layout/PlayDetail/RightLyric/index.svelte` | `ui/overrides/components/layout/PlayDetail/RightLyric/index.svelte` | 无歌词时上游歌词区完全空白；先显示「歌词加载中…」，1.5 秒后显示「暂无歌词」，有歌词时继续使用上游 `LyricPlayer` |
| A-34 | `view-main/src/components/material/fileExplorerModal/FileListModal.svelte` | `ui/overrides/components/material/fileExplorerModal/FileListModal.svelte` | 窄屏下「文件名 + 新建文件夹 + 取消/确定」原本挤成一行并重叠；改为可换行底栏 |

> 另有反向通道 `RAW_TARGETS`（`@any-listen/nodejs/uplink`、`@porting-uplink/web-server/app/modules/extension`、
> `@ui-raw/shared/ipc/app`、文件浏览器列表项和搜索列表 action），仅供覆写文件内部引用「上游原版本」，不改变任何上游文件的解析结果；
> Node 内建模块 → `shims/*` 的映射见 `NODE_SHIMS`，不属于覆写表。

## 构建

前置：Node ≥ 22、pnpm 10.34.5、JDK 17、Android SDK（compileSdk 35 / minSdk 29）。

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

- `pnpm run build:all` 的 `clean` 阶段可能把旧 `dist` 移进 `.trash/`。孤儿 wasm 删除受限时，`shrink-assets` 会将其隔离到 `.trash/`；无法隔离时构建会报错。
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
| `docs/phase5-acceptance-report.md` | 验收报告、历史缺陷与最新实测边界（§16–24） |
| `docs/phase6-compliance.md` | 上游零改动验证、许可证清单与义务、产物泄露检查、许可证门禁签字 |

## 当前状态

**交付物**：`porting/android/app/build/outputs/apk/debug/app-debug.apk`
SHA-256：`5CB0AD5958D2CFA1C3FC1EF0CD3014A895D9617B8114AE588207F5DA24C92315`；20,942,053 B；入口 `assets/web/spa/assets/main.i-PlVHwT.js`。设备内 `base.apk` 与本地指纹一致，`lastUpdateTime` 为 2026-11-05 13:04:25。

30 分钟息屏长测已由用户验收通过。当前 Debug 包已在 Xiaomi 2211133C / Android 16 真机复验本地播放、GD 网易云搜索与在线单曲播放、`Play all` / `Shuffle`、播放页歌词过滤与高亮滚动、无歌词提示、播放失败 Toast 与常驻状态、搜索操作区、设置备份与恢复、文件选择弹窗、内置酷我/网易搜索和系统媒体会话；模拟器验收覆盖列表备份恢复、后台媒体键和两个独立用户通过本地 WebDAV 测试服务合并歌单。第三方音源的可用性取决于其服务和网络。详情见 `docs/phase5-acceptance-report.md` §16–24。

仍待处理：在线专辑/歌手搜索缺少扩展能力、宿主 IPC 和页面实现；下载功能被上游关闭；评论只能只读；部分触控行高不足 44dp；Android 10–15、横屏、平板/折叠屏和外接指针尚未覆盖。当前文件选择依赖文件路径与所有文件访问权限；第三方音源持续 400/503 或无法匹配播放地址时无法由应用侧保证恢复，后者仍可能等待上游两轮超时后才显示失败。明文网络只按 `Online Metadata 0.4.8` 实际使用的 34 个精确主机放行，`example.com` 等未列入域名仍被拒绝；扩展升级后必须重新核对白名单。

**历史修复记录**（对应当时的包与设备；最新包的验收范围以上文和报告 §16–24 为准）

| 编号 | 原现象 | 根因 | 修法与实测 |
|---|---|---|---|
| D-16 | 曲库行**单击不播放**、必须 400ms 内点两次；播放列表（队列）同样 | 上游 `MusicList/List/action.ts:48-66` 与 `PlaylistBtn/shared.ts` 都用手写的 400ms 双击窗口（桌面「单击选中 / 双击播放」语义），触屏没有双击概念 | 移动端覆写改为单击即播（`ui/overrides/.../MusicList/List/index.svelte`、新增 `.../PlaylistBtn/shared.ts`），多选走「多选」按钮、长按仍出右键菜单。实测：暂停态单击第 2 首 → 立即起播；再点第 3 首 → 换歌；队列浮层单击 03→01 一次到位；多选态点行只选中（已选 1→2 项）且当前曲不变 |
| D-29 | 每次冷启动 `[dbService] backup failed init PortError: fs.createReadStream is not available`；自动备份自 11-03 15:02 后再未产生文件 | `shims/fs.ts` 把 `createReadStream` 直接判为不支持，而上游 `backupTask/storage.ts:33` 用它算 sha256 做去重 | 在垫片里实现最小 `FsReadStream`（异步读全文件 → 按 start/end 切片 → `data`/`end`/`error`；带 `pipe`/`destroy`）。实测：本轮冷启动新建 `anylisten.data.db.20261104-093003313.bak`（114,688 B）、`backup failed` 0 次；第二次冷启动备份文件数仍为 2（同日去重生效） |
| D-30 | 进「日志输出」页抛 `ENOENT: log file not found …/files/app/logs/app.log`，页面无内容 | **写入与读取路径不一致**：Kotlin 写 `files/logs/anylisten-<日期>.log`，UI 按上游约定读 `files/app/logs/app.log` | `LogPort` 落盘改为 `files/app/logs/app.log`；`readLastLines` 文件不存在时返回空列表而非抛 ENOENT；JS 桥接层再加一层降级。实测：日志页读到 3,943 字符真实日志、进出两次 0 未捕获异常、旧目录停写 |
| D-27 | 返回键第 1 档只认 `.popup` / `.menu`，不含 `.modal` → 「播放详情 + 声音设置」时按返回把播放详情关掉、弹窗留成孤儿 | Modal 是居中对话框，既不是 `.popup` 也不是整屏覆盖层，原三档优先级里没有它的位置 | `androidBack.ts` 改为四档：**弹层 → 弹窗 → 播放详情 → hash 栈**，第 2 档走 `dismissModal()`。关闭入口不是「点关闭键」而是给 `.content` 派发 Escape（上游 `onkeydown` 处理，`keyclose` 默认 true）——因为本构建 `VITE_IS_DESKTOP/WEB` 皆 false，Modal 的 header 根本不渲染。**踩坑**：`querySelector('.header button')` 会命中弹窗内容区自带的「重置」按钮（音效面板有两个），一开始按返回等于重置用户配置；改为 `:scope > .content > header > button` 严格作用域。实测：三次返回依次关「倍速浮层 → 音效弹窗 → 播放详情」，探针 `__resetClicked=false` |
| D-31 | 长时间息屏/后台后 WebView 渲染进程被系统回收，回来页面变 `chrome-error://`，只能强杀 App | 从未实现 `WebViewClient.onRenderProcessGone`：框架默认返回 false 即**杀整个 app 进程**；页面进了错误页也没有任何自愈路径 | `MainActivity` 把 WebView 装配抽成 `createWebView()`（初建与重建共用一份配置），`onRenderProcessGone` 返回 true 并在 `post{}` 里「摘视图 → destroy → 新建 → loadApp」；`onResume` 检测 `chrome-error` 前缀走 `recoverPage()`；主文档加载失败也自愈。重建时 `LifecycleHub.clear()` 作废旧订阅（否则监听器按重建次数叠加）。实测：`Page.crash` 连杀三次（含后台态）进程号不变、679/573ms 恢复、`am send-trim-memory` 只收到 1 条回调（未叠加）、0 FATAL |
| D-32 | **扩展商店永远是「列表竟然是空的...」**，8 个在线扩展一个都看不到（点安装也无从谈起） | `porting/js/nodejs/request.ts` 的 `parseBody` 用**响应头** Content-Type 判断是否 `JSON.parse`；上游 `request.ts:286` 用的是**请求头**（GET 无 body → 无该头 → 一律先试解析）。GitHub raw 对 `.json` 返回 `text/plain` → 移植层把 JSON 当字符串返回 → `body.all` undefined → 抛 `Invalid list data`。而 `eachMirror` 只在**请求 reject** 时换镜像，数据校验失败不换 → **能连上 raw 的网络反而必挂，连不上（走 jsdelivr）才正常** | 改为传请求头（`parseBody(text, headers)`），语义与上游逐字对齐。实测：商店列出 4–8 个扩展、名称/描述/版本/安装按钮齐全，`Invalid list data` 归零 |
| D-33 | 商店有数据后卡片**双列挤压重叠**、描述压到版本行上、顶部 5 个中文 Tab 被压成竖排 | 三处桌面尺寸叠加：① `mobile.less` 的 `html.mobile ul` 强制两列 `minmax(150px,1fr) !important`；② 卡片 `min-width:300px` + `height:100px`（pxtorem 后只剩 58px，内容要 94px）；③ `mobile.less` 的「封面 96dp」规则 `html.mobile .view-container > .header .left{width:96px!important}` 误命中 Tab 条（Tab 的对齐类也叫 `.left`）→ 标签条被钉成 96px | ① 全局规则改 `ul:not(.ext-list)`，两个扩展列表加 `ext-list` 类并改单列；② 卡片高度自适应、宽度交给网格；③ 封面规则加 `:not([role='tablist'])`；④ 顶栏改两行（标签条整行 + 操作区右对齐）。实测：单列 361px、卡片无重叠、4 个 Tab 完整横排、`本地安装` 独立一行 |

**已验证平台**：412×915 竖屏模拟器（x86_64 / API 36 / WebView Chromium 133）+ **arm64 真机 Xiaomi 2211133C / Android 16（393×872 CSS / dpr 2.75）**。真机复验结论见验收报告 §11：冷启动 490ms、六条判据齐全、D-10/D-11/D-22/D-23 全部成立、0 崩溃 0 ANR；因包内**无任何 `.so`（ABI 无关）**，「arm64 缺库」风险不成立。

**未覆盖范围**：横屏、平板/折叠屏、外接指针，以及 Android 10–15 的版本跨度（目前真机为 Android 16，模拟器为 API 36）。

> **扩展商店（本轮已覆盖）**：此前记的「离线扩展商店（取证机无外网）」是误判 —— 设备网络其实能到 GitHub raw（实测 339ms / 200），商店为空是 D-32 的解析缺陷。修完后已在真机列出 4–8 个扩展并截图。
> 但该网络下首屏偶发很慢（OkHttp 侧 raw 不通时会按 15s×3 重试再换 jsdelivr，最坏要几分钟，期间显示「加载中」；此时 i18n 未取到会让描述显示成 `description` 键名）。这是**网络与重试策略**问题，不是渲染缺陷，已记入待排期。
