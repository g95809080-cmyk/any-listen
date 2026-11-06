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

### 使用 LX Music 自定义源

1. 把 `artifacts/lx-loader/` 中生成的 `.alix` 安装包和需要的 `.js` 音源复制到手机。
2. 在「设置 → 扩展管理 → 本地安装」安装适配版，再进入「设置 → 扩展设置 → LX Music API Source Loader (Android)」。
3. 选择「导入本地自定义源」，可以多选或全选当前目录；结果页的「继续选择」可以接着导入其他目录。导入后勾选需要使用的源，目前同时启用上限为 3 个。
4. 安装 `Online Metadata` 等支持搜索的扩展后，在「在线」搜索并播放。导入表示文件已保存，第三方音源能否播放还取决于其服务状态。

适配扩展使用独立 ID，与官方扩展的数据分别保存；已有官方扩展的音源可先导出，再导入适配版。扩展源码和构建方式见 `porting/extensions/lx-api-source-loader/README.md`。

30 分钟息屏长测已由用户验收通过。此前的 Debug 包已在 Xiaomi 2211133C / Android 16 真机复验本地与在线播放、备份恢复和媒体会话；本轮 LX 自定义源已在 API 36 模拟器完成 24 个源批量导入、10 轮覆盖更新和代表源播放，并在 Xiaomi 2211133C / Android 16 真机完成最终 APK 与适配扩展的安装加载。`release` 包仍为此前构建并使用调试签名，不含本轮 LX 功能。详细进度见 `docs/phase5-acceptance-report.md` §16–29。

## 目录结构

| 路径 | 内容 | 是否改动上游 |
|---|---|---|
| `source/` | 上游 any-listen 源码（branch `dev`，commit `c8f40eab`） | **零改动**，`git status --porcelain` 必须为空 |
| `porting/js/` | 移植层：vite 构建的 SPA + 4 个 worker + Ports 适配层 + 移动端 UI 覆写 | — |
| `porting/android/` | Android 壳：Kotlin 桥（message2call）、本地 HTTP 服务、WebView 宿主、文件系统/音频/通知 Port | — |
| `porting/extensions/lx-api-source-loader/` | 基于上游 0.1.7 的 LX 自定义源 Android 适配扩展 | — |
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
| A-15 | `view-main/src/views/Library/index.svelte` | `ui/overrides/views/Library/index.svelte` | **O-2**（D-35）曲库分两级：`/library` 无 `id` 时显示「我的歌单」一级列表（默认列表 + 顶层用户歌单），点击进入 `/library?id=…` 二级歌曲页；空歌单仍提供「导入本地音乐」入口 |
| A-16 | `view-main/src/shared/ipc/app/index` | `ui/overrides/shared/ipc/app/index.ts` | **O-6** 只替换 `showOpenDialog`/`showSaveDialog`（Android 无原生对话框 IPC，改走内置文件浏览器），其余 30+ 转发函数 `export *` 继承 |
| A-16b | `view-main/src/shared/ipc/app/remote` | `ui/overrides/shared/ipc/app/remote.ts` | 扩展的打开、保存对话框接入 Android 内置文件浏览器，其余扩展事件沿用上游；文件路径授权仍由扩展服务处理 |
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
| A-35 | `shared/app/modules/worker/extensionService/vm/hostContext/apis/isolateContext` | `host/app/modules/worker/extensionService/vm/hostContext/apis/isolateContext.ts` | 修正隔离上下文的定时器归属，并在销毁或停用扩展时释放 QuickJS 资源 |
| A-36 | `shared/app/modules/worker/extensionService/vm/hostContext/index` | `host/app/modules/worker/extensionService/vm/hostContext/index.ts` | 扩展停止后释放主 QuickJS 上下文 |
| A-37 | `@any-listen/app/modules/proxyServer`（`PACKAGE_OVERRIDES`） | `host/app/modules/proxyServer/index.ts` | 上游生成代理地址后同步注册到 Android 本地 HTTP 服务，保留请求头和查询参数 |
| A-38 | `view-main/src/components/material/PopupBtn.svelte` | `ui/overrides/components/material/PopupBtn.svelte` | **D-34**：上游同时用 click 与 mouseenter/mouseleave 控制弹层；触屏在 click 后会补发兼容 mouse 事件，合成 mouseleave 的 100ms 定时器把刚打开的抽屉关掉。按钮 hover 仅在 fine pointer 下启用；`Popup` 的 mouseleave 保留给遮罩关闭 |
| A-39 | `view-main/src/views/Setting/AppSetting/settings` | `ui/overrides/views/Setting/AppSetting/settings.ts` | **D-36**：以原设置表为数据源过滤 Android 无意义的入口——移除「快捷键设置」「软件更新」两段，以及窗口尺寸、播放栏样式、字体、任务栏进度、标题栏歌词、媒体设备、透明窗口。底层配置 key 全部保留 |
| A-40 | `view-main/src/views/Setting/AppSetting/Network.svelte` | `ui/overrides/views/Setting/AppSetting/Network.svelte` | **D-36**：上游把代理开关和主机/端口输入框锁在 `VITE_IS_DESKTOP` 后面，但 Android Kotlin 侧已实现应用级 HTTP 代理；解除禁用，让手机设置真正生效 |
| A-41 | `view-main/src/views/Setting/index.svelte` | `ui/overrides/views/Setting/index.svelte` | **D-38**：设置改为移动端一级分组首页 + 二级详情页；保留旧 `?type=…&id=…` 地址兼容，并让扩展设置、日志输出复用同一路由解析 |
| A-42 | `view-main/src/views/Setting/AppSetting/SettingView.svelte` | `ui/overrides/views/Setting/AppSetting/SettingView.svelte` | **D-38**：二级设置页去掉桌面左栏和重复标题，内容改为独立纵向滚动区与单列卡片 |
| A-43 | `view-main/src/views/Setting/AppSetting/SettingCommonItem.svelte` | `ui/overrides/views/Setting/AppSetting/SettingCommonItem.svelte` | **D-38**：布尔项改为整行可点 + 右侧开关，单选、输入与选择项改成适合触屏的纵向布局 |
| A-44 | `view-main/src/views/Setting/ExtensionSetting/ExtensionSetting.svelte` | `ui/overrides/views/Setting/ExtensionSetting/ExtensionSetting.svelte` | **D-38**：扩展设置接新的 `section` 路由，补无扩展空态，并把扩展切换条改为可横滑触摸导航 |

> 另有反向通道 `RAW_TARGETS`（`@any-listen/nodejs/uplink`、`@porting-uplink/web-server/app/modules/extension`、
> `@ui-raw/shared/ipc/app`、文件浏览器列表项、搜索列表 action 和设置表），仅供覆写文件内部引用「上游原版本」，不改变任何上游文件的解析结果；
> Node 内建模块 → `shims/*` 的映射见 `NODE_SHIMS`，不属于覆写表。

QuickJS 适配会先复制句柄再读取 Promise 结果，并在执行任务后重新读取内存指针，避免内存扩容使旧视图失效；隔离上下文的定时器和退出清理有对应冒烟检查。

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
| `docs/porting-decision-record.md` | **PDR-001~009 决策 + ERR-001~023 勘误**（每个坑的现象、量出来的证据、根因、修法、可推广教训） |
| `docs/phase5-acceptance-report.md` | 验收报告、历史缺陷与最新实测边界（§16–29） |
| `docs/phase6-compliance.md` | 上游零改动验证、许可证清单与义务、产物泄露检查、许可证门禁签字 |

## 当前状态

**交付物**：`porting/android/app/build/outputs/apk/debug/app-debug.apk`
SHA-256：`331767D1E1C9207C230135EBD786CA4899E312A7BBB5EA75543B949D668B5CE3`；20,368,909 B；构建时间 2026-11-06 14:51:25 +08:00；入口 `assets/web/spa/assets/main.5msTpYQQ.js`、样式 `assets/web/spa/assets/style.Dh0GvC50.css`。

30 分钟息屏长测已由用户验收通过。此前的 Debug 包已在 Xiaomi 2211133C / Android 16 真机复验本地播放、在线播放、歌词、备份恢复、文件选择和媒体会话；LX 自定义源的批量导入、10 轮覆盖更新与代表源播放已在 API 36 模拟器验收。当前包进一步收口了移动端视觉与曲库入口：文件选择器避开 AppBar 和安全区，More 菜单只保留单层 44dp 抽屉且点遮罩可关闭，自定义源 Remove 键统一右对齐，播放详情元数据与辅控图标恢复可读性，深/浅主题状态栏图标随主题切换，在线来源条在精确 392dp 视口下完整显示 5 个内置来源。D-35 补上了曲库一级歌单列表与二级歌曲页；D-36 清理了设置页的桌面残留；D-37 把在线歌单卡从桌面横向定尺改为手机单列信息卡，拆开歌单页一级 Tab 与筛选区，并修复关闭态标签抽屉常驻底部；D-38 把设置页重构为 4 组一级入口与独立二级详情，补齐移动端触控控件、扩展横滑导航和 Android 返回栈；D-39 把 MiniPlayer 右侧按钮从播放详情改为向上展开当前播放队列，点击歌曲行即可切歌。最终 APK 已分别覆盖安装到 API 36 模拟器和 Xiaomi 2211133C / Android 16 真机，设备内 `base.apk` 与本地 SHA-256 一致；真机在 392×872 视口完成复验。详情见 `docs/phase5-acceptance-report.md` §16–29。

仍待处理：在线专辑/歌手搜索缺少扩展能力、宿主 IPC 和页面实现；下载功能被上游关闭；评论只能只读；LX 扩展的歌曲缓存开关尚未接通 Android 代理；部分触控行高不足 44dp；Android 10–15、横屏、平板/折叠屏和外接指针尚未覆盖。当前文件选择依赖文件路径与所有文件访问权限；第三方音源持续 400/503 或无法匹配播放地址时无法由应用侧保证恢复，后者仍可能等待上游两轮超时后才显示失败。明文网络按 `Online Metadata 0.4.8` 与本轮 LX 音源的 45 个精确主机放行，`example.com` 等未列入的主机仍被拒绝；音源或扩展升级后需要重新核对白名单。

**历史修复记录**（对应当时的包与设备；最新包的验收范围以上文和报告 §16–29 为准）

| 编号 | 原现象 | 根因 | 修法与实测 |
|---|---|---|---|
| D-16 | 曲库行**单击不播放**、必须 400ms 内点两次；播放列表（队列）同样 | 上游 `MusicList/List/action.ts:48-66` 与 `PlaylistBtn/shared.ts` 都用手写的 400ms 双击窗口（桌面「单击选中 / 双击播放」语义），触屏没有双击概念 | 移动端覆写改为单击即播（`ui/overrides/.../MusicList/List/index.svelte`、新增 `.../PlaylistBtn/shared.ts`），多选走「多选」按钮、长按仍出右键菜单。实测：暂停态单击第 2 首 → 立即起播；再点第 3 首 → 换歌；队列浮层单击 03→01 一次到位；多选态点行只选中（已选 1→2 项）且当前曲不变 |
| D-29 | 每次冷启动 `[dbService] backup failed init PortError: fs.createReadStream is not available`；自动备份自 11-03 15:02 后再未产生文件 | `shims/fs.ts` 把 `createReadStream` 直接判为不支持，而上游 `backupTask/storage.ts:33` 用它算 sha256 做去重 | 在垫片里实现最小 `FsReadStream`（异步读全文件 → 按 start/end 切片 → `data`/`end`/`error`；带 `pipe`/`destroy`）。实测：本轮冷启动新建 `anylisten.data.db.20261104-093003313.bak`（114,688 B）、`backup failed` 0 次；第二次冷启动备份文件数仍为 2（同日去重生效） |
| D-30 | 进「日志输出」页抛 `ENOENT: log file not found …/files/app/logs/app.log`，页面无内容 | **写入与读取路径不一致**：Kotlin 写 `files/logs/anylisten-<日期>.log`，UI 按上游约定读 `files/app/logs/app.log` | `LogPort` 落盘改为 `files/app/logs/app.log`；`readLastLines` 文件不存在时返回空列表而非抛 ENOENT；JS 桥接层再加一层降级。实测：日志页读到 3,943 字符真实日志、进出两次 0 未捕获异常、旧目录停写 |
| D-27 | 返回键第 1 档只认 `.popup` / `.menu`，不含 `.modal` → 「播放详情 + 声音设置」时按返回把播放详情关掉、弹窗留成孤儿 | Modal 是居中对话框，既不是 `.popup` 也不是整屏覆盖层，原三档优先级里没有它的位置 | `androidBack.ts` 改为四档：**弹层 → 弹窗 → 播放详情 → hash 栈**，第 2 档走 `dismissModal()`。关闭入口不是「点关闭键」而是给 `.content` 派发 Escape（上游 `onkeydown` 处理，`keyclose` 默认 true）——因为本构建 `VITE_IS_DESKTOP/WEB` 皆 false，Modal 的 header 根本不渲染。**踩坑**：`querySelector('.header button')` 会命中弹窗内容区自带的「重置」按钮（音效面板有两个），一开始按返回等于重置用户配置；改为 `:scope > .content > header > button` 严格作用域。实测：三次返回依次关「倍速浮层 → 音效弹窗 → 播放详情」，探针 `__resetClicked=false` |
| D-31 | 长时间息屏/后台后 WebView 渲染进程被系统回收，回来页面变 `chrome-error://`，只能强杀 App | 从未实现 `WebViewClient.onRenderProcessGone`：框架默认返回 false 即**杀整个 app 进程**；页面进了错误页也没有任何自愈路径 | `MainActivity` 把 WebView 装配抽成 `createWebView()`（初建与重建共用一份配置），`onRenderProcessGone` 返回 true 并在 `post{}` 里「摘视图 → destroy → 新建 → loadApp」；`onResume` 检测 `chrome-error` 前缀走 `recoverPage()`；主文档加载失败也自愈。重建时 `LifecycleHub.clear()` 作废旧订阅（否则监听器按重建次数叠加）。实测：`Page.crash` 连杀三次（含后台态）进程号不变、679/573ms 恢复、`am send-trim-memory` 只收到 1 条回调（未叠加）、0 FATAL |
| D-32 | **扩展商店永远是「列表竟然是空的...」**，8 个在线扩展一个都看不到（点安装也无从谈起） | `porting/js/nodejs/request.ts` 的 `parseBody` 用**响应头** Content-Type 判断是否 `JSON.parse`；上游 `request.ts:286` 用的是**请求头**（GET 无 body → 无该头 → 一律先试解析）。GitHub raw 对 `.json` 返回 `text/plain` → 移植层把 JSON 当字符串返回 → `body.all` undefined → 抛 `Invalid list data`。而 `eachMirror` 只在**请求 reject** 时换镜像，数据校验失败不换 → **能连上 raw 的网络反而必挂，连不上（走 jsdelivr）才正常** | 改为传请求头（`parseBody(text, headers)`），语义与上游逐字对齐。实测：商店列出 4–8 个扩展、名称/描述/版本/安装按钮齐全，`Invalid list data` 归零 |
| D-33 | 商店有数据后卡片**双列挤压重叠**、描述压到版本行上、顶部 5 个中文 Tab 被压成竖排 | 三处桌面尺寸叠加：① `mobile.less` 的 `html.mobile ul` 强制两列 `minmax(150px,1fr) !important`；② 卡片 `min-width:300px` + `height:100px`（pxtorem 后只剩 58px，内容要 94px）；③ `mobile.less` 的「封面 96dp」规则 `html.mobile .view-container > .header .left{width:96px!important}` 误命中 Tab 条（Tab 的对齐类也叫 `.left`）→ 标签条被钉成 96px | ① 全局规则改 `ul:not(.ext-list)`，两个扩展列表加 `ext-list` 类并改单列；② 卡片高度自适应、宽度交给网格；③ 封面规则加 `:not([role='tablist'])`；④ 顶栏改两行（标签条整行 + 操作区右对齐）。实测：单列 361px、卡片无重叠、4 个 Tab 完整横排、`本地安装` 独立一行 |
| D-34 | 真机**手指点 More，菜单出现约 100ms 后就自己消失**；DOM `button.click()` 却能保持打开 | `PopupBtn.svelte` 同时把 click 与 mouseenter/mouseleave 当作开关。触屏 Chrome 在 click 后仍会补发一套兼容 mouse 事件，实测序列为 `click → mouseenter → 约 100ms 后 mouseleave → 再 100ms visible=false`；`PopupDismiss` 不是本次关闭来源 | 新增 `ui/overrides/components/material/PopupBtn.svelte`：保留 click 逻辑，按钮 hover 仅在 `matchMedia('(hover: hover) and (pointer: fine)').matches` 时启用；**`Popup` 的 `mouseleave` 不加门禁**，因为遮罩关闭依赖它派发合成事件。真机 `Input.dispatchTouchEvent` 实测：触摸 `(261.8,256.5)` 后 1.2s 抽屉仍为 `popup active`、`inert=false`、392.7×72；点 `(20,100)` 后弹层数为 0，路由、多选、当前曲均未变；倍速弹层同样稳定 |
| D-35 | 曲库第一屏固定是「我喜欢」；导入或收藏的歌单没有一级入口 | 移动壳不渲染桌面 `Aside`，上游 `Library` 又在没有 `$query.id` 时把路由补成上次选择或 `love`，因此 `/library` 必然变成二级「我喜欢」，桌面侧的「我的歌单」根本不存在 | 新增 `MobileLibraryLists.svelte` / `MobileLibraryListItem.svelte`，一级直接使用 `defaultLists + useUserList(null)`，只列默认列表和顶层用户歌单；曲库覆写改为无 `id` 显示一级、有合法 `id` 显示原 `MusicList`；`MobileAppShell` 和 `androidBack.ts` 仅在无 `id` 时把曲库视为根级。真机实测冷启动停在 `#/library`，一级 11 行（2 个默认 + 9 个用户歌单），不混入播放历史；点「周杰伦」收藏歌单进入 `#/library?id=hxs2wb6eja`，65 首正常显示。一级无返回键，二级有返回键；AppBar 返回、Android 返回键和再次点「曲库」Tab 都回到一级，底部「曲库」始终高亮 |
| D-36 | 设置页仍把桌面版当主场景：有快捷键、软件更新、窗口尺寸、字体、任务栏/标题栏进度、透明窗口等手机无意义入口；网络代理反而被锁成只读 | 上游设置表被桌面、网页、移动共用，PDR-007 要求的隐藏此前只在文档里，没有落到构建；`Network.svelte` 又把代理开关和主机/端口都写成 `disabled={!VITE_IS_DESKTOP}`，与 Android 已实现代理的实际情况相反 | 新增 A-39 设置表覆写，从原表过滤 2 个整段和 7 个桌面项，保留全部配置 key；新增 A-40 网络页覆写，解除代理控件禁用。真机与 API 36 模拟器设置导航均为 11 项，各页文本无上述桌面项，代理 3 个控件 `disabled=false`；0 未捕获异常、0 `FATAL EXCEPTION`、0 ANR |
| D-37 | 在线「歌单」列表在手机上仍是桌面横向卡，两列时右侧文字被裁；歌单页资源 Tab 与「打开歌单 / 标签 / 排序」压在同一行；标签弹层关闭后仍被全局 BottomSheet 规则钉在底部 | 上游歌单卡按 `min-width:300px` + 定高排版，移动端全局网格又强制两列；头部过滤区没有独立换行；关闭态 `.popup` 只有 `aria-hidden` 信号，却被 `html.mobile .popup` 强制 `display:flex` | 在 `ui/mobile.less` 只对包含 `.songlist-info` 的歌单卡改单列、96dp 封面和自适应文字，排行榜保持两列；带 `.online-songlist-header-right` 的头部拆成资源类型与筛选两行；标签弹层按 `aria-hidden` 显式隐藏/展开，并补遮罩和标签纵向换行。真机 392dp 下歌单卡宽 360.7dp，排行榜仍为 174.4dp 两列，关闭态弹层为 0×0；冷启动、分页、收藏和播放入口均正常。`smoke` 新增 6 项“选择器 + 关键声明”守卫 |
| D-38 | 设置页仍是桌面双栏和密集表单，手机上找不到清晰的一级入口；从二级页按 Android 返回还会直接退出 | 上游 `Setting/index.svelte` 依赖桌面左侧导航，设置项也按鼠标点击密度排版。移动壳虽然隐藏了左栏，但没有一级/二级路由，顶栏和返回栈都无法判断当前位置 | 设置改为 4 组 13 个一级入口，`?section=…` 进入二级页并保留旧 `type/id` 地址兼容；布尔项改整行开关，单选、输入、选择项改纵向布局。真机实测：二级页返回首页、深链直达二级页再返回首页均成立，首页 `canGoBack=false` 且连续按两次返回退到桌面；切换「显示切换动画」后刷新仍保留，扩展切换条可横滑，日志头部两行排列且按钮不相压；设置首页滚到底最后一行仍留 16.9dp 空白，MiniPlayer 不遮挡 |
| D-39 | MiniPlayer 右侧「播放列表」键实际打开播放详情，无法直接查看或切换当前队列 | `MiniPlayer.svelte` 第三个按钮复用了详情页跳转，没有接上游已有的 `PlaylistBtn`；上游队列组件本身已适配移动端 BottomSheet | 将第三键替换为 `div.mini-btn.mini-queue` 内嵌 `PlaylistBtn`，保持 44×44dp 命中区和 24dp 图标。真机 392×872 实测：触摸队列键后从 `y=360.7` 向上展开 `392.7×512` 的底部抽屉，队列可滚动；触摸「Bounce」后 MiniPlayer 由「红色石头 - 李智楠」切为「Bounce - Sarah Connor」，队列保持打开且无页面异常；Android 返回键关闭队列后路由仍为 `#/library`，当前曲不变 |

**已验证平台**：412×915 竖屏模拟器（x86_64 / API 36 / WebView Chromium 133）+ **arm64 真机 Xiaomi 2211133C / Android 16（392×872 CSS / dpr 2.75）**。真机复验结论见验收报告 §11：冷启动 490ms、六条判据齐全、D-10/D-11/D-22/D-23 全部成立、0 崩溃 0 ANR；因包内**无任何 `.so`（ABI 无关）**，「arm64 缺库」风险不成立。

**未覆盖范围**：横屏、平板/折叠屏、外接指针，以及 Android 10–15 的版本跨度（目前真机为 Android 16，模拟器为 API 36）。

> **扩展商店（本轮已覆盖）**：此前记的「离线扩展商店（取证机无外网）」是误判 —— 设备网络其实能到 GitHub raw（实测 339ms / 200），商店为空是 D-32 的解析缺陷。修完后已在真机列出 4–8 个扩展并截图。
> 但该网络下首屏偶发很慢（OkHttp 侧 raw 不通时会按 15s×3 重试再换 jsdelivr，最坏要几分钟，期间显示「加载中」；此时 i18n 未取到会让描述显示成 `description` 键名）。这是**网络与重试策略**问题，不是渲染缺陷，已记入待排期。
