# Any Listen → Android 移植规格（Phase 1：源码规格提取）

> 分析对象：`any-listen`（GitHub `any-listen/any-listen`，dev 分支，pnpm monorepo）
> 源码位置：`C:/Users/kuma/WorkBuddy/Any Listen移植apk/source`
> 分析方法：纯源码静态分析（开源项目，无需二进制逆向）。每条结论标注 `[证据]`（源码路径 + 关键行）或 `[假设]`（写推断依据）。
> 分析范围：packages/{desktop, web-server, view-main, view-lyric, shared/*}（`extensions/*` 源码树不存在，扩展为运行时从 GitHub 商店安装，见 §5）。
> 授权说明：AGPL v3 + 附加「禁止商用」条款；本规格仅用于合规移植评估，闭源重写需遵守该许可（见 §7 风险 R-LIC）。

---

## 0. 结论摘要（给架构/UI 团队）

1. **架构非常利于移植**：业务逻辑 100% 收敛在 `@shared/app`（与壳无关），UI（`view-main`，Svelte 5）通过 `message2call` RPC 调用后端；桌面与 web-server 两个壳共用同一套 app 层。RPC 边界清晰、且**壳可替换**（`window.__anylisten_ipc_init__` 注入点）。`[证据]` §3。
2. **音频播放引擎是纯 Web 技术**（HTMLAudioElement + Web Audio API + AudioWorklet），不依赖原生解码器/ffmpeg，可原样跑在 Android WebView（Chromium 内核）里。`[证据]` `view-main/src/plugins/player/index.ts`。**这是本项目能低成本上 Android 的最大利好。**
3. **三大「桌面/Node 强耦合」硬骨头**：① `better-sqlite3`（C++ 原生模块，跑不了 WebView）；② Node `worker_threads`（业务 worker 拆分）；③ 本地音乐扫描 `node:fs` + `chokidar` 文件监听（Android 分区存储/SAF 差异）。`[证据]` §4。
4. **Web 版就是「浏览器 SPA + 远程 WebSocket 服务」**：Web 客户端与 web-server 之间是 WS（`/socket?m=<jwt>&t=<winType>`）+ message2call，鉴权用 `jsonwebtoken`。由此 Android 有三条落地路线（§6.4），推荐 **Mode C：复用 view-main SPA + WebView + 自研本地桥接后端**。
5. **数据层可移植性中等**：设置/配置是纯 JSON 文件（`Store`，可平移），核心歌单/元数据全在 SQLite（需要换实现）。`[证据]` §7。

---

## 1. 功能地图

| 功能 | 输入 | 输出 | 状态变化（写入） | 用户可见行为 | 源码模块（相对 `packages/`） | 证据 |
|------|------|------|------------------|--------------|-------------------------------|------|
| 本地音乐库（扫描/播放列表/文件） | 本地目录、音频文件 | 歌曲列表、播放数据 | SQLite `my_list`/`my_list_music_info`/`music_library`；watcher 监听目录 | 添加本地目录、扫描歌曲、播放 | `shared/app/modules/musicList/localListProvider.ts`、`shared/app/modules/worker/utilService/scanMusics.ts`、`desktop/src/modules/music/local.ts` / `web-server/src/app/modules/music/local.ts` | [证据] |
| 本地音频播放 | 音频 URL（桌面=`file://`路径，web=`/p_static/...`） | 声音输出 | 播放状态经 RPC 通知 UI | 播放/暂停/进度/音量/倍速 | 播放引擎 `view-main/src/plugins/player/index.ts`；播放逻辑 `view-main/src/modules/player/*`、`shared/app/modules/player/*` | [证据] |
| WebDAV 远程列表 | WebDAV 服务器地址/账号 | 远程歌曲列表 | SQLite（remote 列表）；扩展配置 | 配置 WebDAV、拉取远端目录、同步 | `shared/app/modules/worker/extensionService/internalExtension/extensions/webdav/*`、`shared/nodejs/webdav-client/*` | [证据] |
| 在线资源/扩展系统 | 扩展（GitHub 商店安装） | 搜索/歌单/榜单/评论/音源 | 扩展目录、扩展配置 | 在线搜索歌曲、歌单、排行榜、换源播放 | `shared/app/modules/resources/*`、`shared/app/modules/worker/extensionService/*` | [证据] |
| 歌词（含卡拉OK/桌面歌词） | 内嵌/在线歌词（LRC） | 逐行歌词、卡拉OK 高亮、桌面悬浮歌词 | 歌词缓存（SQLite `lyric`） | 歌词滚动、逐字高亮、桌面歌词窗 | `shared/nodejs/lrcTool.ts`、`view-main/src/modules/lyric/*`、`shared/web/lyric-font-player/*`、`view-lyric/*`、`desktop/src/renderer/winLyric/*` | [证据] |
| 音频特效（EQ/环绕/混响/变调） | 设置项 | 实时音频处理 | AppSetting `player.soundEffect.*` | 均衡器、3D 环绕、混响、音调微调 | `view-main/src/plugins/player/index.ts`、`view-main/src/modules/player/init/soundEffect.ts`、`view-main/src/plugins/player/pitch-shifter/*` | [证据] |
| 元数据匹配/解析 | 音频文件/在线歌曲 | 名称/歌手/专辑/封面/时长 | SQLite `my_list_music_info.meta`、`music_info_other_source` | 显示歌曲信息、封面 | `shared/nodejs/music-metadata.ts`、`shared/nodejs/music.ts`、`views/Online` + `resources/*` | [证据] |
| 下载管理 | 在线歌曲 URL | 下载文件 | SQLite `download_list` | 下载列表/进度 | `shared/nodejs/download/*`、`view-main/src/modules/...`（下载视图） | [证据] |
| 数据同步（WebDAV 同步 disliked/列表） | 快照 | 合并后的列表/黑名单 | `shared/app/modules/sync/*` | 多设备同步歌单/不喜欢列表 | `shared/app/modules/sync/webdav/*`、`sync/shared/*` | [证据] |
| 主题/外观 | 主题包 | CSS/字体 | `shared/app/modules/theme/*` | 换肤、字体 | `shared/app/modules/theme/*`、`shared/theme` | [证据] |
| 全局快捷键 | 键盘快捷键 | 播放控制 | `shared/app/modules/hotkey/*` | 全局热键（**桌面专有**） | `desktop/src/modules/hotKey/*`（`globalShortcut`） | [证据] |
| 托盘/标题栏歌词（**桌面专有**） | 播放状态 | 托盘菜单、状态栏歌词 | — | 托盘控制、任务栏歌词 | `desktop/src/modules/tray/index.ts` | [证据] |

**视图路由**（`view-main/src/plugins/routes.ts`）：`/online`（在线）、`/library`（曲库）、`/settings`（设置）、`/extenstion`（扩展）、`/search` `/list` `/download` `/songList/*` `/topSongs` 复用 `Search` 视图。`[证据]`

---

## 2. 架构分层与 RPC 边界

### 2.1 分层结构

```
┌──────────────────────────────────────────────────────────────────────┐
│  壳层（可替换）                                                        │
│  desktop/src (Electron 主进程)        web-server/src (Node/Koa+ws)      │
│   - 窗口/托盘/歌词窗/热键/更新           - HTTP 服务 + WebSocket + 静态托管 │
│   - preload: window.__anylisten_ipc_init__（message2call over IPC）      │
│   - renderer/preload/* 实现 ServerIPC    - preload/* 实现 ServerIPC(WS)   │
└───────────────┬───────────────────────────────┬──────────────────────┘
                │ 都实现同一套 ServerIPC 类型        │
                ▼                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│  核心业务层 @shared/app（apps 无关，desktop/web-server 完全共用）        │
│  modules/{music, musicList, player, resources, extension, sync,        │
│           dislikeList, theme, logs, backup, proxyServer, worker}       │
│  worker/{dbService(→SQLite), utilService(→fs/网络), extensionService}   │
│  ↕ Node 依赖封装 @shared/nodejs (fs/请求/元数据/webdav/下载/Store)       │
└───────────────┬───────────────────────────────────────────────┬───────┘
                │ message2call RPC                              │
                ▼                                               ▼
┌──────────────────────────────────┐        ┌──────────────────────────────┐
│ UI: view-main (Svelte 5, SPA)     │        │ 另窗口 UI: view-lyric（桌面歌词）│
│  plugins/player (Web Audio 引擎)  │        │  （Web 端也复用同一 SPA 构建）    │
│  通过 window.__anylisten_ipc_init__ │       └──────────────────────────────┘
└──────────────────────────────────┘
```

- **app 层与壳解耦的关键**：`@shared/app` 只在 `worker/` 和 `@shared/nodejs` 里碰 Node API；UI 侧完全不碰 Node。`[证据]` `shared/app/package.json`（依赖仅 common/nodejs/theme/web + better-sqlite3/ws/message2call）。`[证据]`
- **两壳共用验证**：`desktop/src/worker/extenstion.ts` 与 `web-server/src/app/worker/extenstion.ts` **内容完全一致**，都 `import ... from '@any-listen/app/modules/worker'`。`[证据]`

### 2.2 message2call RPC 边界（UI ↔ 后端）

- **RPC 类型契约**：`AnyListen.IPC.ServerIPC`（后端→UI 可被 UI 调用）与 `ClientIPC`（UI→后端事件/回调）。`ServerIPC = ServerCommonActions & IPCMusic & IPCResource & IPCTheme & IPCPlayer & IPCList & IPCDislikeList & IPCExtension & IPCDesktopLyric & IPCSoundEffect & IPCSync`。`[证据]` `shared/types/types/ipc.d.ts:36-46,79-80`
  - 分组覆盖：通用、音乐、音源资源、主题、播放器、列表、不喜欢列表、扩展、桌面歌词、音效、同步。`[证据]`
- **UI 侧连接入口（唯一注入点）**：`view-main/src/shared/ipc/ipc.ts:14-49`，读 `window.__anylisten_ipc_init__`，把 UI 的 `ClientIPC` 函数集注册进去，拿回 `ServerIPC` 代理。`[证据]`
- **桌面壳实现**：`desktop/src/renderer/winMain/preload/index.ts:39-77`，用 `ipcRenderer` + `createMainCall`（message2call），把 `ServerIPC` 暴露为 `window.__anylisten_ipc_init__`。`[证据]`
- **Web 壳实现**：`web-server/src/preload/ws.ts:228-396`，`new WebSocket('/socket?m=<token>&t=<winType>')` + `createMessage2Call`；分组用 `createRemoteGroup('player'|'list'|...)`。`[证据]`
- **worker 内 RPC（Node `worker_threads` + MessageChannel + message2call）**：`shared/app/modules/worker/utils/index.ts:12-102` 创建 dbService/utilService/extensionService 三个 Worker；`shared/app/modules/worker/utils/worker.ts:6-27` worker 侧 `exposeWorker`。`[证据]`
- **扩展 VM 内 RPC**：主进程 ↔ node:vm 上下文用 message2call（`shared/app/modules/worker/extensionService/vm/hostContext/index.ts:36-113`）。`[证据]`

**RPC 调用面规模**：契约类型文件合计约 900+ 行（`ipc.d.ts` 90、`player_ipc.d.ts` 119、`list_ipc.d.ts` 149、`extension_ipc.d.ts` 512 等）。`[证据]` — 即「后端要移植/重实现的方法面」规模量级。

### 2.3 desktop vs web-server 两种壳差异

| 维度 | desktop（Electron） | web-server（Koa+ws） | 证据 |
|------|--------------------|----------------------|------|
| 进程模型 | Electron 主进程 + renderer + Node Worker | 单 Node 进程 + Node Worker | [证据] `desktop/src/index.ts`、`web-server/src/index.ts` |
| UI 传输 | `ipcRenderer` + `MessagePort` + message2call | `WebSocket` + message2call | [证据] §2.2 |
| 数据目录 | `userData/AnyListenDatas`（便携版 `portable/userData`） | `DATA_PATH` 环境变量 或 `../data` | [证据] `desktop/src/app/index.ts:92-112`；`web-server/src/index.ts:39` |
| 设置默认值 | `desktop/src/shared/defaultSetting.ts` | `web-server/src/shared/defaultSetting.ts` | [证据] |
| 本地文件播放 URL | `file://`（`encodePath(path)`） | `/p_static/<sha256>.<ext>`（受 `allowPublicDir` 白名单限制） | [证据] `desktop/src/modules/music/local.ts:30`；`web-server/src/app/modules/music/local.ts:37` |
| 鉴权 | 无（本机单例） | 密码 → JWT（见 §6） | [证据] |
| 桌面专有能力 | 托盘/全局热键/桌面歌词窗/自动更新 | 无（`ServerIPC` 中这些方法被 Omit） | [证据] `desktop/.../preload/index.ts:24-33` 显式 Omit 登录设备/桌面歌词等 |

---

## 3. message2call 机制要点（平台适配层现状）

平台的「业务逻辑 ↔ UI」解耦完全依赖第三方库 `message2call`，理解它才能判断移植时哪些需要重实现：

- **本质**：把「对象上的异步方法」序列化成一个消息通道里的请求/响应（类似 Comlink）。`exposeObj` 暴露的方法集在远端变成 `remote` 代理；`createRemoteGroup(name, {queue,timeout})` 可把方法分组、支持排队与超时。
  `[证据]` `desktop/src/shared/ipc/renderer.ts`、`web-server/src/preload/ws.ts:248-285`
- **传输可插拔**：每个使用点都自定义 `sendMessage(data)`——桌面是 `ipcRenderer/MessagePort`，Web 是 `WebSocket.send`，Worker 是 `postMessage`，扩展 VM 是 `vmContext.__ext_preload__`。
  `[证据]` `desktop/.../preload/index.ts:55`、`web-server/.../ws.ts:252-262`、`shared/app/modules/worker/utils/index.ts:24-30`、`extensionService/vm/hostContext/index.ts:41-44`
- **错误透传**：`isSendErrorStack: true`，远端方法异常会带栈回传；`timeout: 0` 表示不超时（长任务）。
- **对 Android 的启示**：只要新壳提供一个 `sendMessage` 的传输实现（WebView 里可用 `window.postMessage` / 原生 `@JavascriptInterface` / 本地 WebSocket），**不必改动 `@shared/app` 的调用代码**即可接入——这是 Mode C「替换壳」的技术基础（见 §6.4）。
  `[假设]` 低改造量，但需实测桥接延迟对大列表同步（每首歌一条 RPC）的影响。

---

## 4. 桌面/Node 专有依赖清单（移植风险核心）

### 4.1 better-sqlite3（C++ 原生模块）— 核心数据存储

- **性质**：同步 SQLite 绑定，需编译原生 `.node`；可在桌面/web-server 的 Node 侧编译，**无法在 Android WebView 的 JS 环境直接运行**。`[证据]` `desktop/package.json:44`、`web-server/package.json:21`、`shared/app/package.json:11`。
- **使用范围**：歌曲库、歌单、播放信息、歌词缓存、下载列表、不喜欢列表、播放次数、日志——**几乎全部持久化业务**。`[证据]` `shared/app/modules/worker/dbService/db.ts:5,50-64`（`new Database(...)`，`nativeBinding` 参数指向预编译绑定）。
- **Schema 位置**：`shared/app/modules/worker/dbService/tables.ts`（`DB_VERSION = '3'`，表见下）。`[证据]`
  - 表清单：`metadata`（KV，含 `db_version`）、`my_list`（歌单）、`my_list_music_info`、`my_list_music_info_order`、`play_list_music_info`（当前播放队列）、`music_info_other_source`（在线歌曲其它音源）、`lyric`、`music_url`、`download_list`、`dislike_list`、`play_count`、`log`。`[证据]` `tables.ts:1-216`
- **DB 文件**：`anylisten.data.db`（`DB_NAME`），WAL 模式（`db.pragma('journal_mode = WAL')`）。`[证据]` `shared/common/constants.ts:12`、`db.ts:65`
- **迁移/备份**：`dbService/migrate.ts`、`backupTask/*`（自动备份到 `cache` 目录）。`[证据]`
- **移植建议**：Android 侧换 `wa-sqlite`/`sql.js`（WASM，跑 WebView）或封装原生 `android.database.sqlite`/Room；**schema 可 1:1 复用 SQL 文本**（`tables.ts` 就是标准 SQLite DDL）。风险 [高]。

### 4.2 Electron 主进程 API 使用点

`[证据]` 在各 shell 代码中统计的 Electron API 频次：`app`(38)、`session`(15)、`dialog`(15)、`screen`(14)、`shell`(8)、`BrowserWindow`(7)、`Menu`(6)、`globalShortcut`(5)、`nativeTheme`(4)、`Tray`(3)、`ipcMain`(3)、`clipboard`/`Notification`/`nativeImage`/`MessageChannelMain` 各若干。核心使用点：

| 能力 | 使用点 | 移植影响 | 证据 |
|------|--------|----------|------|
| 主窗口（无边框/透明/自定义标题栏） | `desktop/src/renderer/winMain/main.ts:120-154`（`frame:false`、`transparent`、`contextIsolation:false`、`sandbox:false`） | Android 无「窗口」，退化全屏 Activity | [证据] |
| 桌面歌词窗（透明/置顶/穿透点击/跨屏） | `desktop/src/renderer/winLyric/main.ts:105,241-291`、`winLyric/config.ts`（`setIgnoreMouseEvents`/`setAlwaysOnTop('screen-saver')`） | Android 需 **悬浮窗权限**（`SYSTEM_ALERT_WINDOW` / `TYPE_APPLICATION_OVERLAY`）；体验不等价 | [证据] |
| 托盘 + 托盘菜单 + 状态栏歌词 | `desktop/src/modules/tray/index.ts`（`Tray`/`Menu`/`setTitle`/`setToolTip`） | Android 用常驻通知（MediaStyle + 通知栏歌词）替代 | [证据] |
| 全局快捷键 | `desktop/src/modules/hotKey/globalHotkey.ts`（`globalShortcut.register`） | Android 无全局热键；退化为应用内快捷键/耳机按键 MediaSession | [证据] |
| 系统主题跟随 | `desktop/src/app/index.ts:200-205`（`nativeTheme.shouldUseDarkColors`） | Android 可用 `uiMode` 配置/CSS 媒体查询 | [证据] |
| 网络代理（应用级） | `session.setProxy`、`app.setProxy`（`desktop/src/app/index.ts:134-137,242-253`） | Android 走系统代理或应用内代理控制器 | [证据] |
| 文件对话框 | `dialog.showOpenDialog`/`showMessageBox`（preload `fs`、错误弹窗） | Android 用 SAF/`ActivityResultContracts` | [证据] |
| 外部打开链接/文件 | `shell.openExternal`/`showItemInFolder` | Android `Intent` | [证据] |
| 单实例/深链 | `app.requestSingleInstanceLock`、`setAsDefaultProtocolClient('anylisten')`、`open-url`（`desktop/src/app/index.ts:45-63,114-131`） | Android `Intent`/App Links | [证据] |
| 自动更新 | `electron-updater`（`shared/electronUpdate.ts`、`winMain/autoUpdate.ts`） | Android 换应用商店/自更新 channel | [证据] |

> 注：`powerSaveBlocker` **未使用**（全仓无引用）；`powerSaveBlocker` 相关后台保活需在 Android 侧另做（前台服务）。`[证据]` grep 无结果。

### 4.3 Node `fs` / `path` / 下载器 / 网络

- **本地音乐扫描**：`shared/app/modules/worker/utilService/scanMusics.ts`（`fs.promises.readdir/stat` 递归 BFS）。`[证据]`
- **目录监听**：`shared/nodejs/watcher.ts`（`chokidar`）用于本地歌单目录变更自动同步。`[证据]` `shared/nodejs/package.json`（`chokidar`）。
- **文件读写/安全写**：`shared/nodejs/{AsyncFS,SafeFS,Store}.ts`（`SafeFS` 用原子写保护 JSON 配置）。`[证据]`
- **下载器**：`shared/nodejs/download/{Downloader,index,request,util}.ts`（写文件到磁盘，桌面下载目录 / web-server 允许目录）。`[证据]`
- **HTTP 客户端**：`shared/nodejs/request.ts` 基于 `undici`（`ProxyAgent`、retry、redirect 拦截器），**不是** `node:http` 手写，可较容易替换为 `fetch`。`[证据]` `shared/nodejs/request.ts:1-67`
- **文件类型/元数据**：`shared/nodejs/music.ts`（`isMusicFile`）、`music-metadata.ts`（`music-metadata` 纯 JS 解析，无 ffmpeg）。`[证据]`
- **移植影响**：Android 本地文件访问须走 **SAF（Storage Access Framework）/ MediaStore**，`fs` 语义不等价；chokidar 在 Android 不可用，需 `ContentObserver`/手动刷新。风险 [高]。

### 4.4 Worker（Node worker_threads）

- 业务被拆为 3 个 Node Worker：`dbService`（SQLite）/`utilService`（fs/网络）/`extensionService`（扩展 VM）。`[证据]` `shared/app/modules/worker/utils/index.ts:12-102`
- 传输：`MessageChannel` + `message2call`。`[证据]` 同上。
- **Android 侧**：无 `worker_threads`；可用 **Web Worker**（跑在 WebView）替代 UI 侧计算，但 DB/扩展 VM 逻辑若放在 JS 主线程会卡顿，建议放原生线程或 WASM Worker。风险 [高]。
- UI 侧另有独立 Web Worker（`view-main/src/worker/*`，做 markdown 解析/列表处理），**这是标准 Web Worker，WebView 原生支持**（低风险）。`[证据]`

### 4.5 字体（font-list）/ ffmpeg / 其它

- `font-list`：**仅** `desktop/src/shared/fontManage.ts` 使用，用于主题自定义字体枚举。`[证据]`。Android 无法枚举系统字体文件，需 `FontManager`/内置字体；`@shared/web/fonts` 已有捆绑 Inter 字体可复用。风险 [中]。
- **ffmpeg：运行时未依赖**。`child_process`/`spawn` 仅在**构建脚本**（`build-config/*`）和打开日志目录（`shared/nodejs/logs.ts`）中出现，不在音频链路。`[证据]` grep 结果。→ 音频解码完全靠 Chromium 内置解码器。风险 [低]。
- `sharp`/`canvas` 等图片原生库：未发现依赖。
- `jsonwebtoken`、`koa`、`ws`：仅 web-server 壳使用（若 Android 不复用 web-server 则无关）。

---

## 5. 扩展系统机制（在线资源/音源扩展）

- **运行环境**：扩展代码在 **Node `node:vm` 沙箱上下文** 中运行（`codeGeneration.strings=false, wasm=false` 禁动态代码），由独立的 `extensionService` Worker 承载。`[证据]` `shared/app/modules/worker/extensionService/vm/index.ts:40-114`、`vm/hostContext/index.ts:76-98`
- **加载流程**：扩展包（bundle）解包到 `extensionState.extensionDir`（=数据目录下扩展目录），`fs.readdir` 逐个 `parseExtension` 解析 manifest → `createVmConetxt` 注入 preload → `env_setup` → `runExtension` 执行入口（5s 超时）。`[证据]` `extensionService/manage.ts:33-46,140-216`、`vm/index.ts:48-114`
- **preload 注入面**：扩展通过 `require('any-listen')` 拿到宿主 API；宿主把能力经 `createExposeObject(extension)` 通过 message2call 暴露。`[证据]` `shared/extension-preload/src/index.ts:15-43`、`extensionService/vm/hostContext/apis/exposeFuncs.ts:16-35`
  - API 分组：`common`、`request`（需 `internet` grant）、`storage`、`configuration`、`musicList`、`player`、`musicUtils`、`command`、`utils`、`crypto`、`dataConverter`、`iconv`。`[证据]` `exposeFuncs.ts`
  - grant 控制：如 `music_list`/`player`/`internet` 等权限位决定注入哪些 API/事件。`[证据]` `vm/index.ts:73-102`
  - Host 回调（`__ext_host_call__*`）：`setTimeout/setInterval`、`str2b64/md5/aes/rsa`、`iconv` 编解码等。`[证据]` `hostContext/index.ts:47-65`
- **扩展清单（Manifest）**：`contributes` 描述 `settings`、`listProviders`（远程列表提供者，如 WebDAV）、`resourceProviders`（在线音源）等。`[证据]` `internalExtension/extensions/webdav/index.ts:4-40`（含 `settings` 贡献点）
- **内置扩展**：WebDAV 是内置「internal 扩展」（`internal.webdav`），与第三方扩展走同一机制。`[证据]` 同上
- **在线商店**：扩展市场数据来自 `https://raw.githubusercontent.com/any-listen/any-listen-extension-store/main/datas`。`[证据]` `extensionService/onlineExtension/onlineList.ts:10`
- **移植影响**：`node:vm` **在 WebView 不可用**。要保留扩展生态需引入 JS 沙箱（如 `quickjs-emscripten` 跑 WASM，或 isolate）。这是 Android 端最大架构决策点之一。风险 [高]。

---

## 6. web-server 模式分析（决定 Android 落地路线）

### 6.1 HTTP 接口（Koa，前缀 `/api`）

`[证据]` `web-server/src/modules/index.ts`（`router.prefix(API_PREFIX)`，`API_PREFIX='/api'`，`constants.ts:224`）。路由清单：

| 路由 | 方法 | 作用 | 证据 |
|------|------|------|------|
| `/api/ipc/hello` | GET | 返回 `IPC_CODE.helloMsg`（握手探测） | `modules/ipc/index.ts:9-11` |
| `/api/ipc/id` | GET | 返回 `idPrefix + serverId` | `modules/ipc/index.ts:12-14` |
| `/api/ipc/ah` | POST | 密码鉴权，成功在响应头 `token` 返回 JWT | `modules/ipc/index.ts:15-17`、`ipc/auth.ts:41-90` |
| `/api/p_static/:name` | GET | 代理转发命名资源（`proxyRequest`） | `modules/proxyServer.ts:9-26` |
| `/api/proxyUrlToken` | GET | 换发 `PROXY_URL_KEY` cookie | `modules/proxyServer.ts:27-42` |
| `/api/p_url/:url` | GET | 按 URL 代理转发（受 cookie 校验） | `modules/proxyServer.ts:43-71` |
| 静态资源 | GET/HEAD | 托管 SPA（`public/`）+ `/p_static` 映射的本地文件流 | `middleware/static-file.ts` |

> **注意**：web-server **没有** REST 化业务接口——所有业务方法都通过 **WebSocket 上的 message2call** 调用，HTTP 只负责握手/鉴权/静态/代理。`[证据]` 路由仅上述几类。

### 6.2 WebSocket 通道

- 路径：`/socket?m=<jwt_token>&t=<winType>`（`winType ∈ {main, desktopLyric}`）。`[证据]` `preload/ws.ts:237`、`modules/ipc/websocket.ts:71-79`
- 升级前鉴权：`onUpgrade → authConnect → verifyByKey`（JWT 校验 + clientId 存活校验）。失败回 `401 Unauthorized`。`[证据]` `websocket.ts:230-263`、`auth.ts:92-108`
- 心跳：服务端每 30s ping、45s 无响应 terminate；客户端 46s 兜底断开并重连。`[证据]` `websocket.ts:208-224`、`ws.ts:71-91`
- 业务传输：message2call 分 8 个 remote group（common/theme/player/list/dislike/sync/extension/extension_q）。`[证据]` `ws.ts:278-285`
- 加密：`encryptMsg/decryptMsg` 当前是**明文直传**（AES 逻辑被注释掉）。`[证据]` `modules/ipc/tools.ts:85-106`

### 6.3 鉴权（jsonwebtoken）

- 密码以 `sha256(pwd+salt)` 比对（`verifyByCode`），成功后 `sign({clientId, timestamp}, tokenSecret)` 发 JWT。`[证据]` `ipc/auth.ts:27-39`、`ipc/tools.ts:141-161`
- 后续每次请求/连接用 `verify(token)` 校验，并校验 clientInfo 存在。`[证据]` `auth.ts:18-25`
- 服务端 `serverId/tokenSecret/password` 存于数据目录的 `serverInfo`/`clientInfos` JSON 文件。`[证据]` `web-server/src/shared/data.ts:23-105`
- 代理 URL 用 cookie `PROXY_URL_KEY` 保护 `/p_url/:url`（防盗链）。`[证据]` `proxyServer.ts:43-49`

### 6.4 Android 落地路线对比（结论）

| 路线 | 描述 | 优点 | 缺点 | 风险 |
|------|------|------|------|------|
| **Mode A：App 内嵌 Node 服务 + WebView** | 打包 nodejs-mobile/Node 运行时，跑 web-server，WebView 连 `localhost` | UI 100% 复用；业务 0 改动 | 需为 Android 交叉编译 `better-sqlite3` 等原生模块；包体大；进程/内存/后台管理复杂 | [高] |
| **Mode B：WebView 直连远程 web-server** | App 只做「遥控器/客户端」，WebView 加载远程 any-listen web-server，WS 连接 | 开发量最小；零原生 | 必须有服务器；离线不可用；本地音乐不可用；本质是 Web 前端 | [低—技术] / 但功能残缺 |
| **Mode C：复用 view-main SPA + WebView + 本地桥接后端（推荐）** | 复用 Svelte UI 与 `window.__anylisten_ipc_init__` 注入点；用 Capacitor/Cordova 桥把 `ServerIPC` 映射到原生（SQLite/Room、SAF、Web Audio 用 WebView 自带） | UI/交互/播放引擎几乎全复用；可离线；可访问本地音乐 | 需重写后端（`ServerIPC` ~900 行接口）与 DB、扩展 VM | [中] |
| **Mode D：全原生重写** | Kotlin/Compose 重写 UI + 业务 | 最佳移动体验 | 工作量最大，弃用现有 UI | [中—高工作量] |

> 推荐 **Mode C 为主、Mode B 作为「远程连接」附加能力**。关键复用点：`view-main` 已是 device-width 响应式（`<meta viewport width=device-width>`）且已启用 `postcss-pxtorem`（`vite.config.js:158-190`，`rootValue:16`），移动适配基础已具备。`[证据]`

---

## 7. 数据存储盘点

| 数据 | 存储位置/格式 | 源码 | 可移植性 | 证据 |
|------|---------------|------|----------|------|
| 应用设置（133 项，`player.soundEffect.*`/`desktopLyric.*`/`tray.*`/`network.proxy.*` 等） | `{dataPath}/config.json`（纯 JSON，`Store` 原子写） | `desktop/src/app/data.ts:68-97`、`desktop/src/shared/store.ts:20-46`、`common/defaultSetting.ts` | 高（JSON 平移） | [证据] |
| 歌单/歌曲/歌词/下载/黑名单/播放计数/日志 | `{dataPath}/anylisten.data.db`（SQLite，WAL） | `dbService/db.ts`、`dbService/tables.ts` | 中（换 SQLite 实现） | [证据] |
| 服务器信息（serverId/tokenSecret/password） | `{dataPath}/serverInfo.json`、`clientInfos.json` | `web-server/src/shared/data.ts:23-105` | 高（仅 web-server） | [证据] |
| 当前播放队列/播放位置 | SQLite `play_list_music_info` + `playTimeStore`（文件） | `shared/app/modules/player/playTimeStore.ts` | 中 | [证据] |
| 扩展本体 + 扩展配置 | `{dataPath}/extensions/*`（解包目录）+ 扩展 storage（JSON） | `extensionService/manage.ts:33-46`、`extensionService/extensionApis/storage.ts` | 中 | [证据] |
| 缓存/临时（封面、代理缓存、备份） | `{dataPath}/cache`、`{dataPath}/temp` | `desktop/src/app/index.ts:107-111`、`dbService/backupTask/*` | 高 | [证据] |
| UI 本地偏好（窗口信息等） | 浏览器 `localStorage` | `view-main/src/shared/localStore.ts` | 高（WebView localStorage） | [证据] |
| 数据目录根 | 桌面 `userData/AnyListenDatas`；Web `DATA_PATH`/`../data` | 见 §2.3 | — | [证据] |

---

## 8. 移植风险标记

| 编号 | 风险项 | 等级 | 类别 | 说明 | 关联证据 |
|------|--------|------|------|------|----------|
| R-01 | `better-sqlite3` 原生模块 | [高] | 触控无关/平台耦合 | C++ 绑定无法在 WebView 运行；全部持久化业务依赖它；需换 wa-sqlite(WASM)/Room，并复用现有 SQL DDL | §4.1 |
| R-02 | Node `worker_threads`（db/util/extension 三 worker） | [高] | 平台耦合/性能 | WebView 无 worker_threads；需用原生线程或 Web Worker/WASM 重排 | §4.4 |
| R-03 | 本地音乐扫描 + `chokidar` 文件监听 | [高] | 平台耦合 | Android 分区存储/SAF/MediaStore 语义不同，`fs` 不可直接用 | §4.3 |
| R-04 | 扩展系统 `node:vm` 沙箱 | [高] | 平台耦合 | WebView 无 `node:vm`；保留扩展生态需引 WASM 沙箱（quickjs-emscripten 等）或放弃扩展 | §5 |
| R-05 | 桌面歌词悬浮窗（透明置顶穿透） | [高] | 触控不友好/特殊权限 | 需 `SYSTEM_ALERT_WINDOW` 悬浮窗；权限门槛与体验不等价 | §4.2 |
| R-06 | 本地文件 -> 播放 URL（`file://`） | [高] | 平台耦合 | WebView 不能直接播 `file://` 跨域资源；需 content:// 或本地 http/自定义 scheme | §2.3 |
| R-07 | 托盘/全局热键/标题栏歌词 | [中] | 桌面交互依赖 | 用常驻通知(MediaStyle)/MediaSession/应用内键替代，功能可用但形态不同 | §4.2 |
| R-08 | Web Audio 高级特性（AudioWorklet/setSinkId/环绕） | [中] | 性能敏感/兼容性 | Chromium WebView 支持 AudioWorklet（需安全上下文）；`setSinkId` 选输出设备在 Android 支持有限 | `plugins/player/index.ts:407-445,508-517` |
| R-09 | 后台播放保活 | [中] | 性能敏感/系统限制 | 无 powerSaveBlocker；Android 需前台服务 + 音频焦点 + 通知，否则锁屏/切后台被杀 | §4.2 注 |
| R-10 | 网络代理（应用级 setProxy） | [中] | 平台耦合 | Electron `session.setProxy` 无对应；需应用内代理控制器（undici→fetch 改造时同步处理） | §4.2 |
| R-11 | 字体枚举 `font-list` | [中] | 桌面依赖 | Android 无法枚举系统字体，需内置/`FontManager` | §4.5 |
| R-12 | Electron 文件对话框/打开外部链接 | [中] | 桌面交互依赖 | 换 SAF + Intent | §4.2 |
| R-13 | 桌面 UI 布局信息密度 | [中] | 触控不友好 | 现有 UI 为桌面信息密集型；虽已 pxtorem 但交互需重设计（触控目标尺寸、手势） | §6.4 |
| R-14 | `music-metadata` 元数据解析 | [低] | 可移植 | 纯 JS，无原生依赖，可复用/或换原生 tag 库 | §4.3 |
| R-15 | 音频解码 | [低] | 可移植 | 完全依赖 Chromium 内置解码；无 ffmpeg 运行时依赖 | §4.5 |
| R-16 | Koa/ws/jsonwebtoken（仅在复用 web-server 时） | [低] | 平台无关 | Mode C 不使用；Mode A 需要 Node 运行时 | §6 |
| R-17 | 许可证（AGPL v3 + 禁止商用） | [高] | 许可证敏感 | 分发/联网使用需开源衍生代码；「禁止商用」为附加限制，商用需取得授权；闭源重写仍受 AGPL 约束需法务确认 | `LICENSE`、README |

---

## 9. 待探查假设列表（证据不足 / 需实测确认）

| 编号 | 假设/待查项 | 为何证据不足 | 下一步探查计划 |
|------|-------------|--------------|----------------|
| A-01 | Android WebView 是否稳定支持 `AudioWorklet` + `ConvolverNode` + 多节点音频图（R-08） | 源码只能证明用了这些 Web API，无法证明目标机（小米13 / HyperOS WebView 内核版本）运行表现 | 小米13 真机 WebView 基准：加载 `plugins/player` 音频图，测 EQ/混响/变调延迟与 CPU |
| A-02 | `setSinkId`（音频输出设备切换）在 Android WebView 的实际可用性 | 属 Chromium 能力，Android 实现不完整 | 真机 + `MediaDevices.enumerateDevices` 实测 |
| A-03 | 若走 Mode C，`ServerIPC` 全部方法的 Android 重实现工作量与取舍 | 需逐方法判定「必须原生实现 / 可用 Web Worker 复用 / 可砍」 | Phase 2 逐个 Interface 做能力矩阵（原生/JS/砍） |
| A-04 | 扩展生态是否必须保留 | 取决于产品定位，源码无法判断 | 与 team-lead/产品确认；若不保留，R-04 直接消除 |
| A-05 | Android 本地音乐访问方案（SAF vs MediaStore vs 全盘权限） | 需结合目标 Android 版本与合规 | Phase 2 补 Android 存储方案设计 |
| A-06 | `ServerIPC` 中 `fileSystemAction` 等在 Android 的语义（文件选择/目录扫描） | 桌面依赖原生对话框 | Phase 2 定义原生文件桥 |
| A-07 | 桌面版 `D:/any-listen` 安装包与 dev 分支行为差异 | 未做二进制交叉验证（按要求以源码为准） | 仅在源码与现网不一致时，抽样对照 asar 内 config/schema |
| A-08 | 数据库迁移：现有桌面用户 `.db` 能否被 Android 侧新 SQLite 实现直接打开 | 取决于是否同 schema/version | Phase 2 用示例库验证跨实现兼容 |
| A-09 | pxtorem 在 430~500dp 宽度的实际视觉密度是否可接受 | 仅看到配置，未渲染 | Phase 3 UI 阶段做真机/模拟器走查 |

---

## 10. 证据日志（关键结论 → 依据）

| 编号 | 结论 | 类型 | 依据 | 置信度 |
|------|------|------|------|--------|
| E-01 | 业务逻辑与壳完全解耦，desktop/web-server 共用 `@shared/app` | [证据] | `desktop/src/worker/extenstion.ts` ≡ `web-server/src/app/worker/extenstion.ts`；两壳均 import `@any-listen/app/modules/worker` | 高 |
| E-02 | UI 与后端唯一 RPC 入口是 `window.__anylisten_ipc_init__`（可替换） | [证据] | `view-main/src/shared/ipc/ipc.ts:14-49`；`desktop/.../preload/index.ts:76-77`；`web-server/src/preload/*` | 高 |
| E-03 | 音频引擎纯 Web（HTMLAudioElement + Web Audio + AudioWorklet） | [证据] | `view-main/src/plugins/player/index.ts:93-250,407-445` | 高 |
| E-04 | 持久化几乎全在 SQLite（better-sqlite3），schema 见 tables.ts | [证据] | `dbService/db.ts:5,40-93`；`dbService/tables.ts:1-216` | 高 |
| E-05 | 设置是全 JSON 文件（`config.json`），原子写 | [证据] | `desktop/src/shared/store.ts:20-46`；`desktop/src/app/data.ts:68-97` | 高 |
| E-06 | 扩展在 node:vm 沙箱跑，经 message2call 注入宿主 API | [证据] | `extensionService/vm/index.ts:40-114`；`vm/hostContext/index.ts:36-113`；`extension-preload/src/index.ts:15-43` | 高 |
| E-07 | Web 客户端 = WS(`/socket?m=jwt&t=winType`) + message2call，鉴权 jsonwebtoken | [证据] | `web-server/src/preload/ws.ts:228-396`；`modules/ipc/websocket.ts:71-79,230-263`；`ipc/auth.ts:27-90`；`ipc/tools.ts:141-161` | 高 |
| E-08 | HTTP 仅握手/鉴权/静态/代理，业务全走 WS | [证据] | `web-server/src/modules/{index,ipc,proxyServer}.ts` | 高 |
| E-09 | 本地文件播放 URL：桌面 `file://`、web `/p_static`（白名单） | [证据] | `desktop/src/modules/music/local.ts:30`；`web-server/src/app/modules/music/local.ts:37`；`web-server/src/middleware/static-file.ts` | 高 |
| E-10 | 桌面歌词为透明置顶穿透窗；托盘/全局热键为 Electron 专有 | [证据] | `desktop/src/renderer/winLyric/main.ts:105,241-291`；`modules/tray/index.ts`；`modules/hotKey/globalHotkey.ts` | 高 |
| E-11 | 运行时无 ffmpeg/child_process 依赖（仅构建脚本/开日志目录） | [证据] | grep `child_process|ffmpeg` 命中仅 `build-config/*` 与 `nodejs/logs.ts` | 高 |
| E-12 | 扩展市场数据来自 GitHub raw 仓库 | [证据] | `onlineExtension/onlineList.ts:10` | 高 |
| E-13 | UI 已具备移动适配基础（device-width viewport + postcss-pxtorem rootValue:16） | [证据] | `view-main/vite.config.js:77-80,156-190` | 高 |
| E-14 | web-server 支持把本地/media 文件以虚拟路径 `/p_static` 流式暴露（受 allowPublicDir 限制） | [证据] | `web-server/src/app/modules/fileSystem/index.ts:14-60`；`middleware/static-file.ts` | 高 |

---

## 11. 可直接进入架构阶段 vs 需先确认

**可直接进入 Phase 2 架构设计（证据充分）**：
- 分层与 RPC 边界（§2）、数据存储清单（§7）、音频引擎可移植性（E-03）、扩展机制原理（§5）、web-server 接口面（§6）、桌面依赖清单（§4）。

**需先与产品/用户确认后再定架构**：
- A-04（扩展生态是否保留）——直接决定 R-04 是否需要 WASM 沙箱，工作量差异巨大。
- 落地路线 A/B/C/D 的取舍（§6.4）——建议主推 Mode C，需 team-lead 拍板。
- R-17 许可证合规——商用/闭源需法务先行确认（AGPL v3 + 禁止商用）。

**需真机实测（Phase 5 前必须完成）**：
- A-01/A-02（WebView 音频高级特性在小米13 的实际表现）。
