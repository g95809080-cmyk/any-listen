# 移植决策记录（Porting Decision Record）

> 项目：Any Listen（AGPL v3 + 附加禁止商用条款）→ Android
> 测试机：小米13（骁龙 8 Gen2，1080×2400，Android 13 / HyperOS）
> 验收替补环境：AVD `MotoIntercom_Graphics_API36`（x86_64 / API 36 / 1080×2400 @420dpi = 411dp / WebView Chromium 133）—— 用户不在电脑前时改用它，触控与安全区结论需在真机复核
> 工作区：`C:/Users/kuma/WorkBuddy/Any Listen移植apk`
> 源码：`source/`（any-listen dev 分支，commit `c8f40eab`，**零改动**）

---

## PDR-001 使用形态：独立 App（本地模式）

- **决定**：Android 版为独立 App，服务端逻辑与 UI 均运行在手机上；离线可用；支持手机本地音乐 + WebDAV 远程列表。
- **否决项**：纯远程遥控器模式不作为主形态（可作为后续附加能力）。
- **理由**：用户选择。桌面版即为一体形态，移植应保持功能等价。
- **影响**：需要解决 SQLite、文件系统访问、后台播放保活、扩展沙箱在 Android 的等价实现。

## PDR-002 扩展生态：必须保留

- **决定**：必须保留第三方扩展能力（在线音源 / 歌单 / 榜单等）。
- **理由**：用户明确要求；扩展生态是 any-listen 的核心价值之一。
- **影响**：`node:vm` 沙箱在 Android WebView 不可用，必须选型 WASM JS 沙箱（候选：quickjs-emscripten 等）或等价隔离方案。**这是 Phase 2 最高优先级架构决策点。**
- **连带要求**：扩展 API 面（`require('any-listen')` 提供的 common/request/storage/configuration/musicList/player/musicUtils/command/utils/crypto/dataConverter/iconv）与 grant 权限模型需在新沙箱中 1:1 或等价提供。

## PDR-003 许可证用途：个人自用 / 学习

- **决定**：本项目仅个人使用与学习，不分发、不商用。
- **合规边界**：AGPL v3 允许使用、修改、自用；附加条款「禁止商用」不影响个人使用。
- **若后续变更用途**：衍生代码需以 AGPL v3 开源；商用需取得原作者书面授权。

## PDR-004 平台约束（基线）

| 项 | 值 | 说明 |
|---|---|---|
| 最低 API | ~~26（Android 8.0）~~ → **29（Android 10）** | 基线草案为 26；经 PDR-008 裁决上调为 29，已在 `app/build.gradle.kts` 落地（真正约束是 WebView 版本而非 API 级别） |
| 目标 / 编译 API | **35** | `compileSdk = 35`、`targetSdk = 35` |
| ABI | **arm64-v8a（单一）** | 小米13 为 arm64；v7a 在 PDR-008 中裁掉，不在 MVP 范围 |
| 屏幕 | 1080×2400，约 411dp 宽 | 触控设计基准宽度 |
| 网络 | 仅 HTTPS（生产） | 代理/WebDAV 需允许自签或 http 内网场景需评估 |
| 框架许可 | 允许混合方案（WebView/JS 沙箱 + 原生桥） | 用户未要求纯原生 |

## PDR-005 音频链路：复用 Web Audio

- **决定**：优先复用 `view-main/src/plugins/player` 的纯 Web 音频引擎（Web Audio + AudioWorklet + pitch-shifter）。
- **待验证**：小米13 WebView 上 AudioWorklet / ConvolverNode / setSinkId 实际表现（对应规格包 A-01/A-02，Phase 5 前必须实测）。
- **兜底**：若 WebView 音频图不可用，退化到原生 ExoPlayer + 简化音效。

## PDR-006 桌面歌词：不做悬浮窗（复核后改判）

- **最终决定（2026-11-02 复核）**：**不做悬浮常驻歌词窗**。Android 端歌词能力为两层：应用内全屏歌词页（深度阅读）+ 通知栏歌词（MediaSession，默认开、零权限）。
- **改判理由**：① Android 上「任意界面置顶看歌词」无等价体验，需 `SYSTEM_ALERT_WINDOW` 特殊权限 + 常驻 View；② 通知栏方案已有现成实现（`mediaSessionInfo.ts` 将歌词写入 title，200 行可零改动复用）；③ UI 侧论证：40dp 浮层内控件无法满足 44dp 触控规范，需大量触控折中记账。
- **风险变化**：R-05 由 [高] 降为 **[低]**。
- **连带影响**：
  - `:app` **不建** `WindowManager` / `TYPE_APPLICATION_OVERLAY` 浮层模块
  - `desktopLyric.*` 44 项**全部不迁移**（不保留 key）；歌词样式复用 `playDetail.*` 5 项 + 新增 `lyricView.style.lineGap` 等共 6 项
  - 规格 `docs/phase3-uiux-overlay-supplement.md` 保留为 **P2 可选功能备档**，不投入实现
- **历史**：曾于同日早前拍板「要做」并计入 MVP，经团队技术论证后由用户复核改判。

## PDR-007 设置项处置：隐藏桌面专属项

- **决定**：133 项中桌面专属的 61 项在手机端**隐藏但保留 key**，配置可跨端互通；可见 55 项 + 音效 17 项迁移到播放页。
- **例外**：`desktopLyric.*` 中与悬浮窗相关的样式/行为项随 PDR-006 保留约 12 项。
- **理由**：用户在 Phase 3 门禁 Q-01 中选择「按设计隐藏」。

## PDR-008 平台基线裁决（主理人裁定）

- **minSdk 29**（Android 10）：真正约束是 WebView 版本而非 API 级别；用户自用小米13（Android 13）无兼容影响；避免维护 legacy 存储分支。
- **targetSdk / compileSdk 35**，`arm64-v8a` 单一 ABI。
- **ExoPlayer 兜底引擎**：Phase 4 仅冻结 `AudioEngineRouter` 接口，具体实现延后到 Phase 5 真机 spike 结论之后。
- **平板/折叠屏**：P2 后置，MVP 只保证 phone 竖屏（411dp 基准）+ 横屏可用。

---

## 勘误记录

### ERR-001（2026-11-02）Phase 1 结论 E-13 不成立

- **原结论**：`E-13 UI 已具备移动适配基础（device-width viewport + postcss-pxtorem rootValue:16）`
- **复核结论**：**错误**。`pxtorem rootValue:16` + `document.documentElement.style.fontSize='16px'`（`view-main/src/modules/app/init.ts:130`、`setting/init.ts:50`）构成**恒等映射**（px/16 = rem，1rem = 16px），缩放系数 1.000，实际零适配效果。
- **真实设计基准**：`view-main/src/shared/browser/widnow.svelte.ts:54,70` 设置 `document.body.style.width='1020px'`；`PlayDetail/RightLyric/LyricPlayer.svelte` 用 `winRadio = clientWidth/1020`。411dp 视口下 `winRadio ≈ 0.40`，且仅局部生效。
- **连带修正**：风险 R-13「桌面 UI 信息密度」由 **[中] 上调为 [高]**；「布局重排」从优化项变为**必要条件**。
- **约束**：禁止通过改 `pxtorem.rootValue` 或 `common.fontSize` 做适配（会同时缩放 width/height/padding，411dp 下必然溢出）。必须走布局重排 + 断点媒体查询。
- **修正落点**：`docs/phase2-architecture.md` §2.5 / §7 / §9.0 已同步。

---

### ERR-002（2026-11-03）core-worker 侧 `socket.onMessage` 从未装配 → UI→core 帧全丢

- **现象**：五条启动判据（token 注入 offset 正确、`origin` 正确、`[db.worker] sqlite ready preloaded=true`、`db inited`、无 `SQLITE_CANTOPEN` / 无 wasm `magic word` 错）全过，页面仍停在 `Loading...`。CDP 取证：`html.mobile` 已加、5 个 worker 全活、资源零 404、`window.setTheme` 是函数，但 `documentElement.style` 为空串、`--color-primary-light-1000` 仍是 `#ffffff`、`querySelectorAll('*').length` 仅 9。
- **传播链**：`appReady.appAeady` 恒 false ← 仅 `settingEvent.on('inited')` 能置 true ← 唯一发出点 `initSetting$1()` ← 其首行 `await getSetting()` **永不 settle**（`createMessage2Call({ timeout: 0 })` 让挂死既无 reject 也无日志）。
- **根因**：`porting/js/host/bootstrap.ts` 里 `initServerIPC()` 与 `connectClient()` 是**同步连续调用**，而 `initServerIPC()` 内部是 `void import('@/app/renderer/winMain').then(...)`。唯一给 `socket.onMessage` 赋值的地方是 `rendererEvent/index.ts:97-99`，它在 `socketEvent.on('new_socket')` 回调里；该回调由 `initWinMain()` → `initRendererEvent()` → `init()` 注册。动态 import 的 chunk 加载必然晚于同 tick 的 `connectClient()`。
- **放大因素（关键）**：`@any-listen/nodejs/Event.emit()` 是 `setImmediate` **异步派发**，且派发时才读监听表。这让 bug 具备「时序上看似有机会」的假象，实测必然错过。
- **为什么全绿**：入向路径 `socket.onMessage?.(event.data)` 用了可选链 —— `undefined` 时静默 no-op，不抛错、不打日志。出向路径（`socket.remote.*`）与 Ports 通道（发往 Kotlin 的 `fs.*` / `log.write` / `lifecycle.*` / `http.setProxy`）不受影响，于是探针看到「48 出 / 42 入」，误以为双向都通；那 42 条回帧其实全是 Kotlin 对 Ports 帧的应答。
- **修复**：① `initServerIPC()` 改为 memoized `Promise<void>`，`initWinMain()` 后断言 `socketEvent` 的 `new_socket` 监听器数 ≥ 1，否则 throw；② `bootstrap.ts` 改 `await initServerIPC()` 再 `connectClient()`；③ `connectClient()` 把 `port.start()` 移到 `message` 监听器之后（`start()` 立即派发排队消息），并对 `socket.onMessage` 做一次宏任务复核，未装配则 `appLog.error`；④ **缓冲补投**：仅 ②③ 仍不够 —— UI 在 core 启动完成前已把 6 帧排进 MessagePort，`port.start()` 立刻派发这批已排队消息，仍早于 `new_socket` 的定时器。`connectClient()` 内加 `pending` 缓冲，等 `onMessage` 装配完成后再按序补投，并打 `[ipc] 补投 N 帧` 作为可观测证据。
- **约束**：任何「注册 handler」与「派发事件」分属不同异步阶段的地方，**接线必须先 await 完成再连客户端**，且**客户端在接线完成前到达的帧必须缓冲**。该类断链在可选链 + `timeout: 0` 下完全无痕，验收不能只看日志无错。
- **修正落点**：`porting/js/host/ipc/server.ts`、`porting/js/host/bootstrap.ts`；本条同时把「`init*/setup*/install*/register*/connect*` 是否有定义无调用、调用是否早于依赖就绪」列为**需普查的 bug 类别**。

---

### ERR-003（2026-11-03）`connectClient()` 早于 `initModules()` → UI 读到模块初始化前状态

- **现象**（ERR-002 修复后）：UI 已能渲染（`Loading...` 消失、TabBar 三 tab 出现、DOM 节点 429），但 `--color-primary-light-1000` 仍是 `#ffffff`、`dom_style` 是 `":root {}"`，整站无主题色。另有 `Data path is not set`、`Cannot read properties of undefined (reading 'getDislikeListInfo')` 两条 unhandled rejection。
- **根因**：UI 主线程与 core-worker 并行启动，`connectClient()` 一接上，UI 立即 fire `getSetting` / `getThemeSetting` / `getPlayInfo` / `getHotKey` / …；而此时 `initModules()` 尚未开始。三个症状同一根因：
  1. `getThemeSetting` 返回 `themeState` 的**初始值** `{id:'',name:'',isDark:false,colors:{}}`（`shared/app/modules/theme/state.ts:1` 逐字符相同）。赋值发生在 `initTheme()` 的 `Object.assign(themeState, getTheme())`，属 `initModules()`。UI 拿 `{}` 调 `setTheme` → `:root {}`。
  2. `getPlayInfo` → `initPlayInfo()` → `getPlayTime()`，而 `initPlayTimeStore(dataPath)` 由 `initPlayerModule()` 调用、同属 `initModules()` → `playTimeStore.ts:18` 的 `if (!dataPath) throw 'Data path is not set'`。**更严重**：抛之前已置 `initState = 1`，此后 `savePlayTime` 命中 `if (initState == 1) return` —— 整个会话播放时长静默不落盘。
  3. `getDislikeListInfo()` 读模块级 `dbService`（`shared/app/modules/dislikeList/index.ts:12`），在 `initDislikeList()` 之前是 `undefined`。
- **为什么桌面版没有**：桌面/web-server 的 IPC 服务在进程启动、模块 init 完成之后才监听端口，浏览器连上时一切已就绪。Android 把 UI 与 core 并行化后，次序假设被打破。
- **修复**：`bootstrap.ts` 把 `connectClient()` 从 `initServerIPC()` 之后移到 `await initModules()` 之后（`sendInitedEvent()` 之前）。`connectClient()` 的缓冲补投保证接入前已到达的帧不丢（ERR-002 ④）。
- **新失败特征（必须记住）**：若 `initModules()` 任一 init reject，`connectClient()` 永不执行 → UI 永久 Loading **且日志里完全没有 `[ipc] webview client connected`**。反过来，看到该行即证明 11 个 init 全部成功。
- **约束**：**「客户端可连接」的语义是「后端可服务」，不是「后端已实例化」**。任何把 UI 与后端并行启动的架构，都必须把 `connect` 放在业务 init 之后；否则所有「读模块级状态」的接口都会返回初始化前快照，且失败形态是静默的（空对象 / undefined / 毒化的一次性 flag）。
- **修正落点**：`porting/js/host/bootstrap.ts`。
- **判据勘误（同日复验时发现，主理人原判据有误）**：ERR-003 的验收判据最初写成「`--color-primary-light-1000` 不再是 `#ffffff`」，**这条是错的**。`light-1000` 是浅色主题色阶的最亮端，默认主题 `blue2`（清热板蓝）里它本来就定义为 `rgb(255,255,255)`。按原判据会一直假红。正确的三条判据：
  1. `window.dom_style.innerText !== ':root {}'`（修复后实测 13217 字）；
  2. `getThemeSetting` 响应的 `id !== ''`（实测 `blue2`）、`colors` 非空（实测 242 个 `--color-*`）；
  3. `--color-primary === rgb(79, 98, 208)`，与响应体逐字符一致。
- **观测纠正**：`[ipc] 补投 N 帧` 的 **N 恒为 1 属结构性正常**，不是「缓冲没生效」。UI 的六个请求是在收到 `appEvent.connected`（其触发点就在 `connectClient()` 之后）才发出的，因此不可能早于接入；队列里能有的只有 msg2call 的那一发握手帧。它恰好落在 `addEventListener → flushed` 那 13 ms 窗口内 —— 丢掉它照样卡死初始化。要验证大批次缓冲只能人为构造。

---

### ERR-004（2026-11-03）移动壳不渲染 `AppShell` → 以 Aside 为锚的初始化链全部是死的

- **现象**：ERR-003 修复后 UI 已渲染（TabBar 三 tab、DOM 429 节点），但**内容区一个节点都没有**（纯白、控制台无错），点击 tab 一个都不高亮。
- **根因一（曲库初始化断链）**：`setUserListInited(true)` 全仓只有 `view-main/src/modules/musicLibrary/store/commit.ts:43` 一处，唯一到达路径是 `store/actions.ts:51-58` 的 `getUserLists()`，而它**唯一消费者**是桌面左侧歌单栏 `components/layout/Aside/MyList/List.svelte:30` 的 `{#await getAllList()}`。移动壳不渲染 `AppShell` → Aside 不存在 → `userListInited` 恒 false →
  - `views/Library/index.svelte:146` 的 `$effect` 首行 `if (!$userListInited) return` → hash 永远为空；
  - 同文件 `:157-161` 只有 `{#if listInfo}`、**没有 else 分支** → `listInfo` 是 `undefined` → 内容区一个节点都不渲染。
- **根因二（路由初值）**：首帧 URL 无 hash → `plugins/svelte-spa-router/navigator.ts:44-58` 的 `getLocation()` 返回 `'/'` → `routes.ts` 落到 `'*'` 兜底渲染 Library，但 `$location` 仍是 `'/'` → `MobileTabBar` 的 `isActive('/library')` 判 false。而且 `navigator.ts:71-78` 的 `readable(getLocation(), …)` **初始值是模块求值时算定的**，归一化必须发生在它被 import 之前。副带污染：`views/Online/index.svelte:33-35` 会把 `'/'` 写进「上次位置」，`modules/resource/actions.ts:66-77` 的 `toOnlineSearch()` 之后会拿它当 fallback `push('/')`。
- **根因三（导入入口为零）**：`importLocalFile()` 全仓只有两个调用点 —— 定义处 `Aside/MyList/action.ts:43` 与桌面右键菜单 `Aside/MyList/Menu.svelte:98`。两者都在 Aside 里。**移动壳上用户没有任何入口能把歌加进曲库**，所以空态里的导入按钮不是装饰，是唯一路径。
- **另一条独立断链**：`host/app/modules/fileSystem/index.ts` 的 `getRootDirs()` 下发 `{ name: '内部存储' }` 这种**显示名**，而 `AnyListen.FileSystem.File` 只有 `name`/`isFile` 两个字段，上游把 `name` 兼职当路径用（`web-server/src/app/modules/fileSystem/index.ts:85-90` 的 `readRootDir()` 返回绝对路径）。UI 侧 `material/fileExplorerModal/shared.ts:47-52` 的 `buildFilesPath('', [file])` 直接拿 `file.name` 当路径 → `readDir('内部存储')` → **导入在第一层就失败**。
- **修复**：① `entries/main.ts` 在 `connectIPC()` 后补 `getUserLists()`；② 新增 `ui/boot/route.ts` 并作为 `main.ts` 第一条 import，用 `replaceState` 把空 hash 归一化成 `#/library`（不新增历史条目，后退语义不变）；③ `getRootDirs()` 改下发 `env.externalRoot` 绝对路径；④ 新增 O-2 覆写 `views/Library/index.svelte` + `ui/pages/MobileEmptyState.svelte`，补「空列表 / 载入中 / 未选歌单」三态，空态带「导入本地音乐」按钮。
- **约束（本条最重要）**：**移动壳替换的不仅仅是布局，还有挂在被替换布局上的副作用链**。凡是以 `AppShell` / `Aside` / `Header` 等桌面容器为挂载点的 `#await`、`$effect`、`onMount`，在移动壳下都要逐条核对是否有替代触发点。这类断链的共同特征是**静默**：没有异常、没有日志、界面只是"少了一块"。
- **修正落点**：`porting/js/entries/main.ts`、`porting/js/ui/boot/route.ts`、`porting/js/host/app/modules/fileSystem/index.ts`、`porting/js/ui/overrides/views/Library/index.svelte`、`porting/js/ui/pages/MobileEmptyState.svelte`、`porting/js/vite.config.mjs`（OVERRIDES 加 O-2）。

---

### ERR-005（2026-11-03）构建陷阱：`emitFile` 早于 tree-shaking → 9.3 MB 孤儿 wasm 进包

- **现象**：quickjs 接进 `ext.worker` 之后，`dist/spa/assets` 里有 **4 个** `emscripten-module-*.wasm`，合计 9.3 MB；而全产物只有 **1 个**被真正引用（`"/assets/emscripten-module-NWak2PoB.wasm"`，518 KB，release-sync 变体）。另外 3 个会随 `syncWebAssets` 整目录拷进 APK。
- **根因**：`@jitl/quickjs-wasmfile-*` 四个变体模块里都写着 `new URL('emscripten-module.wasm', import.meta.url)`。vite 在 **transform 阶段**就执行 `emitFile`，而「哪个变体最终被引用」要等 tree-shaking 才定。我们只用 `release-sync`（`quickjs-emscripten` 的默认参数），另外三个变体的 JS 被摇掉了，wasm 资产却已经落盘 —— **资产与代码不同步的孤儿**。
- **修复**：`scripts/shrink-assets.mjs` 加「1.5 删除未被引用的 wasm」。安全边界三条：只扫 `assets/` 下的 `.wasm`（不碰 `public/wasm/` 的 `locateFile` 约定）；**一个引用都没扫到时不删任何东西**（产物形态变了宁可留着）；每次删除都打日志。
- **配套门禁**：`scripts/smoke.mjs` 加**反向断言**「assets/ 下不能有未被引用的 wasm」。此前只有正向断言（代码要的磁盘上要有），它与这条是互补的：正向防「404 → 把错误页当 wasm 喂给 instantiate」（sql.js 踩过），反向防「体积白占」。
- **两处门禁误判（已修）**：
  1. emscripten glue 里有一条**没被改写**的 `locateFile` fallback 字面量 `"emscripten-module.wasm"`（vite 只改写 `new URL(...)` 那一支，运行期走不到 fallback）。判据改为：裸文件名找不到精确文件时，只要 `assets/` 里有**同 stem 的 hashed 变体**即视为满足。
  2. 孤儿检查最初拿「原始引用串」和「文件名」比，导致真文件被当成孤儿。必须拿 `resolveWasmRef()` 解析后的 **basename** 去比。
- **教训**：凡是「构建期副作用产物」与「tree-shaking 结果」分处两个阶段的地方，都要假设**产物会比代码多**。wasm / worker chunk / `new URL()` 资源都是这一类。`pnpm smoke` 必须同时有正向与反向两条断言，只会「检查缺失」的门禁拦不住体积浪费。
- **收益**：dist 瘦 8.83 MB。
- **勘误（必须记住自己的错）**：本条最初写着「APK 从 24.34 MB 预期降到 ~15.5 MB」，打包后实测 **24,343,330 字节，与上一版 24,343,344 只差 14 字节**。查明：`syncWebAssets` 从来没把孤儿 wasm 拷进过 APK（上一版包内就只有 1 个 emscripten wasm）。所以这 8.83 MB 的收益是 **dist 瘦身，不是 APK 瘦身** —— 顺带说明「构建产物小了」与「安装包小了」是两件事，中间隔着一层白名单同步，报收益前必须核对包内容。

---

## 决策时间线

| 日期 | 事件 |
|---|---|
| 2026-11-02 | PDR-001~003 由用户拍板；Phase 1 规格包交付（docs/phase1-spec.md） |
| 2026-11-03 | ERR-001 复核成立，UI 布局重排升为必要条件 |
| 2026-11-03 | ERR-002 定位并修复：core-worker 侧 `socket.onMessage` 装配时序竞态（UI 卡 Loading 的真正根因） |
| 2026-11-03 | 首屏打通：`Loading...` 消失、TabBar 三 tab 渲染、DOM 429 节点；`补投 1 帧` 实测救回首帧 |
| 2026-11-03 | ERR-003 定位并修复：`connectClient()` 早于 `initModules()`，UI 读到模块初始化前快照（主题空 / playTime 毒化 / dislikeList undefined） |
| 2026-11-03 | ERR-004 定位并修复：移动壳不渲染 `AppShell` → 以 Aside 为锚的曲库初始化链、路由初值、导入入口全部是死的 |
| 2026-11-03 | 连续排除 5 类历史白屏：`__dirname`、extension-preload 404、`workers.main` 未初始化、token 注入进注释、boot script 缺失、`initSqlite`/`preloadDatabase` 零调用、sql.js wasm 命名不一致 |
| 2026-11-03 | 模拟器首轮验收：包体与启动链路全通，但内容区仍不可用 → 连查 ERR-006（容器高 0）/ ERR-007（`SQLITE_RANGE`）/ ERR-008（顶栏未挂载 + 按钮文字同色） |
| 2026-11-03 | 三项修复后复验：顶栏 `Library`、空态居中、按钮可读、TabBar 高亮正确；`preloaded=true`、无 unhandled rejection |
| 2026-11-03 | ERR-009 定位并修复：Android WebView 的 `safe-area-inset-bottom` 恒为 0，改由原生注入 insets；TabBar 回到白色区域、系统导航栏不再压住它 |
| 2026-11-03 | 空态「导入本地音乐」实测报 `showOpenDialog is not defined`：上游 web-server 版故意注释掉了该 IPC（网页版走内置文件浏览器）。改走 `showFileSelectModal`/`showFileSaveModal` 路线（见待办） |
| 2026-11-03 | ERR-010：子 worker Ports 通道改为按次创建 —— 原来一次性建好三条，重启扩展宿主第二次 `postMessage` 转移必然抛 `DataCloneError`，宿主永久不可用 |

---

### ERR-006（2026-11-03）移动壳缺一条上游 `Main.svelte` 的规则 → `.view-container` 高度塌成 0

- **现象**：ERR-004 修好后曲库页不再空白，但空态被顶出视口：图标和标题完全不可见，只剩副标题的一条残影贴在屏幕最上沿，下面孤零零一个蓝色圆角条（其实是按钮）。没有任何报错。
- **量出来的证据**（CDP）：`.view-container` 的 `height` 是 **0**；`.empty`（`position: absolute; inset: 0`）的 `height` 只有 **49.46px** —— 恰好等于它的 `padding-bottom: max(12%, 24px)`（12% × 412.19 宽 = 49.46）。也就是说 `inset: 0` 的四向拉伸**没有生效**：绝对定位元素按包含块高度解析，而包含块高度是 0，于是只剩 padding 撑出的那点高度，`justify-content: center` 把内容挤出上下两边。
- **根因**：`.view-container` 自带 `flex: 1 1 auto`，但它并不是 flex 子项 —— 它的父级 `main.content` 是 `display: block`，所以 `flex` 声明无效、`height` 退化为 `auto`；而它唯一的内容是绝对定位的空态（脱离文档流），于是高度自然塌成 0。
- **上游为什么没事**：`view-main/src/components/layout/Main.svelte` 里有一条
  ```less
  .view { position: relative; flex: auto;
    > :global(.view-container) { position: absolute !important; top:0; left:0; width:100%; height:100%; } }
  ```
  我们写 `ui/shell/MobileAppShell.svelte` 时只复刻了 `#view{flex:auto}`，**漏掉了这条子选择器**。
- **修复**：在 `MobileAppShell.svelte` 的 `.content` 里逐字补回 `> :global(.view-container) { position: absolute !important; inset 四向 + 100%×100% }`。
- **判据修正**：判断这类问题**不能看「元素在不在」**，要看 `getBoundingClientRect()` 的高度和包含块高度。`inset: 0` + `height: auto` 在包含块高度为 0 时是「合法但无意义」的，浏览器不会报任何错。
- **同类风险**：所有靠 `height: 100%` / `inset: 0` 撑满的内容（虚拟列表、播放页、设置页滚动容器）都依赖这条规则。少了它，列表还会因为「容器高 0」而只渲染首屏若干行。

---

### ERR-007（2026-11-03）同名命名参数被按「出现次数」展开 → `SQLITE_RANGE`，曲库列表永远加载不出来

- **现象**：UI 起来后立刻一条 unhandled rejection：
  ```
  Error: column index out of range
  ```
  它不带任何 SQL 上下文，栈也只有 message2call 的转发帧（错误在 db worker 里抛出、序列化回 UI），完全无法定位。
- **定位手法**：给 `ports/sqlite.ts` 的 `Statement.run/get/all` 加失败时打印 `this.sql`（SQLite 抛的裸错必须补上下文），一次构建就拿到了原文：
  ```sql
  SELECT mInfo."id", ... FROM my_list_music_info mInfo
  LEFT JOIN my_list_music_info_order O ON mInfo.id=O.music_id AND O.list_id=@list_id
  WHERE mInfo.list_id=@list_id
  ORDER BY O."order" ASC
  ```
  参数是对象 `{ list_id: 'love' }`。
- **根因**：SQLite 对**同名**命名参数只分配**一个**序号 —— `@list_id` 出现两次仍然只有 **1** 个参数。而移植层的 `parseParams()` 按**出现次数**收集名字，`bindValues()` 于是展开成 **2** 个位置参数；`stmt.bind([v, v])` 的第二个落到不存在的序号上 → `SQLITE_RANGE` → 错误文案就是 `column index out of range`。better-sqlite3 按名字绑参，天然没有这个问题，所以表现为「桌面一切正常、Android 查询必炸」。
- **修复**：参数归一化改为**按序号**建槽位（`ports/sql-params.ts`）：
  - 命名参数首次出现分配 `auto+1`，同名重复出现**复用同一序号**、不新增参数；
  - `?` 取 `auto+1`；`?NNN` 把游标推到 NNN（后续新命名参数于是落到 NNN+1，与 SQLite 一致）；
  - 对象模式下按 `slot.index - 1` 落位，最后把稀疏空洞补成 `null`（sql.js 会把 `undefined` 当成非法绑定）。
- **顺带修掉的两个隐患**：① 原实现对 `?` / `?NNN` **直接跳过**，导致「`?` 与命名参数混用」时后面所有命名参数整体错位；② 引号内与注释里的 `?` / `@x` 需要排除（原实现已处理，重构后保持）。
- **回归门禁**：把参数归一化抽成不依赖 wasm 的纯模块 `ports/sql-params.ts`，冒烟用例直接拿**上游那条真 SQL** 断言 `{list_id:'love'}` → `['love']`（1 个值，不是 2 个），另加 8 条边界（四种键前缀、引号、行注释、块注释、`?` 混用、`?NNN`、数组透传、单 `Uint8Array`）。这条用例是本次唯一能防住「以为修好了其实换了个地方再炸」的手段。
- **教训**：**SQL 方言差异不会以「语法错误」的形式出现，而是以「越界 / 参数缺失 / 静默返回空」的形式出现**。凡是把 `better-sqlite3` 换掉的适配器，都必须对「同名参数、位置参数、混合参数」三类逐一写测试，不能只跑一条 `SELECT ?`。

---

### ERR-008（2026-11-03）顶栏组件写完从未挂载 + 主色填充按钮文字同色不可见

- **现象**：曲库页顶部没有标题栏（`bodyText` 里只有空态文案 + 三个 tab），空态按钮是一条纯蓝圆角条、**没有任何文字**。
- **根因一**：`ui/shell/MobileAppBar.svelte` 早就写好了，但**全仓没有任何一处 import 它**。`entries/main.ts` 里的挂载日志「AppBar + Router + MiniPlayer + TabBar」是照着设计写的文案，与实际 DOM 不符 —— 这类"日志描述了不存在的结构"比缺功能更危险，它会让人跳过验证。
- **根因二**：按钮用了 `color: var(--color-button-font, #fff)` + `background: var(--color-primary)`。但主题里
  `--color-button-font: var(--color-primary-alpha-100)`（**就是主色本身**，上游用它做主色文字配浅色底），
  于是文字色 = 底色 = `rgba(79, 98, 208, 0.9)`，字彻底消失。
- **为什么不能简单改成白字**：实测 15 个内置主题的 `--color-primary` 亮度跨度 0.24（`mid_autumn rgb(74,55,82)`）到 0.70（`orange rgb(245,171,53)`）。白字压在 orange 上对比度约 **1.9:1**，等于看不见；而主题里**没有**「主色之上的前景色」这种变量，任何单一前景色都无法同时适配两端。
- **修复**：按上游自己的按钮语言做**描边款**（`transparent` 底 + `--color-primary-font` 文字 + `--color-primary-alpha-200` 1.5px 描边，高 52dp），任何主题都成立。同时把顶栏真正挂进 `MobileAppShell`，标题按 `$location` **路径前缀**解析（`$location` 带查询串，等值比较会全部落空）。
- **教训**：主题色 token 的语义是**成对**的（底色/前景色必须来自同一套）。跨主题取色前先量一遍所有主题该 token 的实际值域，不要凭一个主题的观感就写死 `#fff`。

---

### ERR-009（2026-11-03）Android WebView 不上报 `safe-area-inset-bottom` → TabBar 被系统导航栏压住

- **现象**：底部三个 tab 背景发灰、标签像蒙了一层；系统三键导航条（返回/主页/最近）**画在 tab 上面**，把 56dp 的 TabBar 吃掉约 48dp。
- **量出来的证据**：`html { viewport-fit=cover }` + `--safe-top` 有值（48px，`env(safe-area-inset-top)` 生效），但
  `env(safe-area-inset-bottom)` **恒为 0**；同时 `window.innerHeight` = 915 = 整屏，说明 WebView 确实是边到边。
  即：**顶部 insets 上报、底部不上报**，`env()` 完全不可依赖。
- **修复**：原生侧接管。`MainActivity.installInsetsBridge()` 用
  `ViewCompat.setOnApplyWindowInsetsListener(webView)` 取 `systemBars() | displayCutout()`，
  按 density 换算成 CSS px 后 `evaluateJavascript` 注入：
  ```js
  window.__anylisten_pendingInsets__ = [top, bottom];
  window.__anylisten_applyInsets__ && window.__anylisten_applyInsets__(top, bottom);
  ```
  页面侧 `ui/boot/insets.ts` 把它写成 `--inset-top` / `--inset-bottom`；
  `ui/mobile.less` 里 `--safe-top/--safe-bottom: max(env(...), var(--inset-*))` ——
  取最大值，所以「有 env 无原生」「有原生无 env」都成立，两者同时存在时也不会重复叠加。
- **两个必须遵守的细节**：
  1. insets 通常在本文档 JS 求值**之前**就派发过一次，那次 `applyInsets` 必然落空。所以原生要无条件记下最近值（`__anylisten_pendingInsets__`），并在 `onPageFinished` 重推一次。
  2. **不能 consume insets**（监听器要原样 `return windowInsets`），否则 WebView 自己算不出 `env(safe-area-inset-top)` 与视口。
- **教训**：`env(safe-area-inset-*)` 是 **iOS Safari 的语义**，Android WebView 只部分实现（本项目实测：top 有、bottom 无）。任何「靠 CSS 环境变量做安全区」的方案，在上真机前都必须先用 `getComputedStyle` 量一次实际值，不能以「写了就生效」结案。

---

### ERR-010（2026-11-03）子 worker 的 Ports 通道只创建一次 → 重启扩展宿主第二次转移必抛 `DataCloneError`

- **触发点**：设置页的「重启扩展宿主」→ `host/app/modules/extension/index.ts` 的 `restartExtensionHost()` → `startExtensionServiceWorker()` → `spawn()`。
- **根因**：三条子 worker 的 Ports 通道在 `entries/main.ts` 里**启动时一次性建好**，随 bootstrap 消息转交给 core，再由 `host/worker/index.ts` 的 `spawn()` 用 `worker.postMessage(msg, [portsChannel, subChannel.port1])` 转给各自 worker。
  但 **`MessagePort` 只能被转移一次**：转移后原对象即失效。第二次 `spawn()` 再把它放进 transfer list → 抛 `DataCloneError`；`createExtensionServiceWorker` 同步抛出 → `startExtensionServiceWorker` 的 Promise 既不 resolve 也不 reject（`void _start(...)` 后面接的 `.catch(reject)` 接的是 Promise，而这里是**同步**抛在 `new Promise` 执行器里 → 实际会 reject，但 `restartExtensionHost` 没有 catch）→ 界面表现为「点了重启，之后扩展全没了」，必须杀进程重启 App。
- **为什么只有扩展宿主暴露**：`dbService` / `utilService` 在生命周期内**从不重启**，通道只被转移一次，永远踩不到；只有扩展宿主有「重启」入口。
- **修复**：通道改为**按次创建**。
  - `entries/main.ts`：不再预建三条通道，改建一条常驻的 `workerPortsControl`；它的 port1 上监听 `{type:'workerPortsChannel'}` 并 `portsHub.registerPort(event.ports[0])`。
  - `host/worker/index.ts` 的 `spawn()`：每次 `new MessageChannel()`，worker 端随首条消息转移，UI 端 `control.postMessage({type:'workerPortsChannel'}, [port2])` 交给主线程 hub。
  - `BootstrapOptions` 的 `workerPortsChannels: {db,util,extension}` → `workerPortsControl: MessagePort`；bootstrap 消息的 transfer list 从 5 项降到 3 项。
- **附带收益**：`spawn()` 不再依赖「主线程预先分配好每个 worker 一条通道」这种隐式约定，db/util/extension 三处调用点统一；`registerPort()` 本来就支持后注册（`Set` + `start()`），hub 侧零改动。
- **教训（可推广）**：**`MessagePort` / `ArrayBuffer` 这类「一次性所有权」的对象不能进"启动时建好、运行时复用"的池子。** 凡是 transfer list 里的东西，生命周期都必须等于它所属的那次 spawn；写成单例就必然在重启路径上炸，而且只在第二次才炸 —— 单次冒烟测试永远测不出来。

---

### ERR-011（2026-11-03）并发重启扩展宿主 → 第一个 Promise 永不 settle（宿主其实活着）

- **现象**：连点两次「重启扩展宿主」，两个调用都卡住（12s 后仍未 settle），但扩展列表本身仍可读 —— 即**宿主没死，调用方永远卡在 waiting**。
- **量出来的证据**（实测）：串行调用时 `restart#1` 152 ms 返回、`restart#2` 165 ms 返回，均正常；`const a=restart(); const b=restart()` 并发发起时，两个 Promise 等 12 s 仍不结束。
- **根因**：上游 `shared/app/modules/worker/worker.ts:37-52` 隐含假设「同一时刻只有一个 restart 在进行」：
  ```ts
  let oldService = extensionService
  extensionService = createExtensionServiceWorker(onWorkerInited, exposedFuncs)   // 新实例 S1
  extensionService.worker.on('exit', () => { extensionService?.worker.removeAllListeners(); extensionService = null })
  if (oldService) { oldService.worker.removeAllListeners(); await oldService.worker.terminate() }
  ```
  并发时第二次的 `oldService` 拿到的不是「跑热的老 worker」，而是**第一次刚 spawn、还没发出 `inited` 的 S1** → 第二次同步把 S1 `terminate()` → S1 永远没机会回 `inited` → 第一次调用的 `resolve` 永不执行（`startExtensionServiceWorker` 是 `new Promise(resolve => _start(..., resolve))`）。
- **与 ERR-010 的区别（别混）**：ERR-010 是**复用同一条 MessagePort** 导致第二次转移抛 `DataCloneError`，已在 `spawn()` 改为每次 `new MessageChannel()`，实测两次重启都不再复现；本条是**调用时序**问题，与通道无关 —— 即使每次新建通道，并发重启依然卡死。
- **修复**：`host/app/modules/extension/index.ts` 把 restart 排成一条串行链（`restartChain`）：后来的请求等前一个完整结束（spawn + `setupExtension`）再开始，链上失败不会断链、错误仍抛给本次调用方。修复后实测两次重启 448 ms 串联完成，`getExtensionList()` 可读。
- **顺带排除的一条**：「旧 exit 回调把新实例清空」在本移植层**不可复现** —— `WorkerHandle.terminate()` 同步触发 exit，而上游在 `terminate()` 之前已 `removeAllListeners()`，那个会写 `extensionService = null` 的闭包没有执行窗口。上游 Node 版存在「worker 自行 crash 的 exit 插在赋值之后、removeAllListeners 之前」的窄窗口，但本移植层的 `WorkerHandle` 只有 `terminate()` 一个 exit 来源。
- **教训**：**「幂等」不等于「并发安全」**。一个操作重复调用结果正确（串行 152ms/165ms 都返回），不代表同时调用也正确 —— 尤其当它内部持有「旧实例 → 新实例」的替换语义时，第二个调用会把第一个的新实例当成旧实例销毁。凡是「先建新的、再拆旧的」的重启/热更逻辑，入口必须串行化。

---

### ERR-012（2026-11-03）设置页二级导航 `width: 18%` → 411dp 下只剩 74px，整块竖排

- **现象**：设置 → 扩展设置，右侧内容区左侧那条二级导航（WebDAV / 扩展列表 …）被压成一列单字，`WebDAV` 竖着排，几乎不可读；主内容区被它挤到右边。
- **量出来的证据**（CDP）：`.settings-extension-list` 计算宽度 **74.19px**，父级 `.settings-extension-container` 是 `flex-flow: row nowrap`，内容区总宽 412.19px。
- **根因**：上游 `views/Setting/ExtensionSetting/ExtenstionList.svelte` 写的是
  ```less
  .settings-extension-list { flex: none; width: 18%; max-width: 200px; }
  ```
  桌面 1020px 基准下 `18% = 183px` 正好；**411dp 下 `18% × 412 = 74px`**，连一个 "WebDAV" 都放不下。`flex: none` 保证它不会被压得更窄，但 `width: 18%` 也不允许它变宽 —— 于是字被逐字换行。
- **为什么之前没发现**：`ui/mobile.less` §9 只处理了**一级**导航（`html.mobile .settings-app-list`），而二级导航的类名是 `.settings-extension-list`，不在同一条规则里；且早期验收只看了设置页首屏（一级 + 基本信息面板），没进扩展设置。
- **修复**：`ui/mobile.less` 新增 §9.1，与一级导航统一处理 —— `.settings-extension-container` 改纵向、`.settings-extension-list` 去宽度约束、`.list` 变横滑 flex、`.list-item` 44dp 药丸。
- **教训**：**百分比宽度 + 桌面基准的组合在移动端等于硬编码**。`18% / 200px / 1020px` 这类三件套必须逐个检查；凡是 `width: N%` 的侧栏，都要在 411dp 下量一次实际像素值，而不是看桌面截图觉得"比例合适"。

---

### ERR-013（2026-11-03）迁移过来的桌面五列表头没有跟着列表一起重排

- **现象**：曲库列表在手机上已经是「封面 + 歌名/歌手双行」卡片（§4 的 grid 重排），但上方仍横着 `# / Song name / Artist / Album name / Duration` 五列表头，列宽与卡片完全对不上，纯占位。
- **量出来的证据**：表头 `.view-container > .header` 位于 y=284、高 36，直接子元素是 5 个 `<span>`；卡片行在 y=320 起，二者无任何对齐关系。
- **根因**：§4 只重排了 `.my-list .container`（行内 5 个子元素 → grid 两行），**表头是另一个组件**（`components/common/MusicList/List` 的 `.header`），不在同一条规则里。
- **修复**：`ui/mobile.less` §9.2 用 `html.mobile .view-container > .header:has(> span)` 隐藏。用 `:has(> span)` 而不是 `.header`，是为了不误伤设置页的 `.header`（其直接子是 `.list`，一级导航要保留）。
- **教训**：**列表重排必须成对检查「行 + 表头 + 空态 + 分页/加载更多」四个部件**。只改行，表头就会以桌面列宽横在卡片上方；反过来只改表头，行会更乱。

---

### 判据勘误（2026-11-03）同一版本测三次得到两种结论 —— 临界态布局不能"测一次就结案"

这条记的是**我自己的一次误判**，留痕是因为它比缺陷本身更有价值。

- **第一次（21:41，截图）**：文件浏览器弹窗刚打开，画面上文案竖排、工具条被裁、底部按钮被导航栏压住 → 判 P0 布局缺陷。
- **第二次（21:57，我的 DOM 测量）**：`.modal` 412×915、`.content` 412×824、`.header` 412×92、`.footer` 412×101，底部按钮 `bottom = 867 = innerHeight - insetBottom`；全文扫描「宽 < 60 且高 > 40 且有文字」的元素命中 **0 个** → 我据此**推翻**了第一次的结论，判定"那张图是打开动画的中间帧，布局没问题"，并把结论写进了本条勘误。
- **第三次（fullstack-dev-2 的 DOM 审计，最终定案）**：缺陷真实存在，且给出了机制 —— `.header` 是单行 flex（h2 + 3×44dp 图标键 + Input），上游 `.header h2 { word-break: break-all }` 让 h2 的 min-content 宽度只有 1 个字符，flex 收缩把 h2 压成 **8.3px 宽 × 218.4px 高**（逐字竖排、上下溢出 56px 的 header，盖到曲库空态上）；`.header` 的 `scrollWidth 413 > clientWidth 412`；`.main` 内 `.list` 的 `min-width: 460px` 在 382dp 上每行多出 78px 被 `overflow:hidden` 裁掉；`.footer` 实测 `bottom = 900`，而可视区下界是 `915 - 48 = 867` → 被导航栏压住。修法是 §14（header 改两行栅格、标题独占一行、footer 吃 `--inset-bottom`）。
- **为什么会测出两种结论**：h2 的宽度处在 flex 收缩的**临界点**附近 —— 图标键 3×44 + gap + Input 的最小宽度已经把 412dp 吃满，h2 拿到的剩余宽度在「够放几个字」与「只剩 1 个字」之间摆动，取决于当时的列表是否已加载、有没有滚动条、标题文案长度。**它不是"动画中间帧"，是临界态抖动**：同一份 CSS，多打开几次可能一次正常一次竖排。
- **校正后的结论**：第一次的判断是对的，第二次的"推翻"是错的 —— 而错因不是"截图骗人"，是**我用一次测量去否证一个不稳定现象**。
- **仍然成立的另一处**：`li.click()` 点不动 ≠ 功能坏了。事件处理器挂在 `li` 的子元素 `div[role=button].container` 上，`li.click()` 派发的事件从 `li` **向上**冒泡、永远不经过子元素。改用 `[role=button].click()` 后立刻正常进入 `/storage/emulated/0/Music`。
- **约束（写进验收规范）**：
  1. 判"布局坏了"必须给 `getBoundingClientRect()` 数值；判"布局没坏"必须**重复测量 ≥ 3 次**（不同状态：列表空/有内容、滚动条有无、键盘收起/弹出），单次"没复现"不构成否证；
  2. 凡是 `flex` 收缩 + `word-break: break-all` 组合的文字容器，天然是临界态，一律按"可能竖排"对待，直接改成可容纳整行的栅格；
  3. 程序化点击要打在**绑定了 handler 的元素**上；点击无反应时先用 `elementFromPoint` + 父链确认目标，不要直接推断功能坏了。

---

### ERR-014（2026-11-04）播放详情页整屏白：`bind:this` 在「第三种环境取值」下永不赋值

- **现象**：点迷你播放器进入播放详情 → 整屏白，无封面、无歌词、无控制条；关闭键也不存在，只能靠系统返回键退出。
- **量出来的证据**：`.play-detail` 是 412×915、`z-index:10`、`background: rgb(255,255,255)`、`opacity:1` —— **白色是它自己画的**；子块 `.left-info` 高 **8px**（内容 `scrollHeight 234`）；暂停键 `y=1695`、上一首 `y=1746`、循环键 `y=2793`，而视口只有 915；点开瞬间 logcat `Uncaught TypeError: Cannot read properties of undefined (reading 'addEventListener') @main.*.js:36304`。
- **根因（两层，缺一不可）**：
  1. 上游 `PlayDetail/Header.svelte` 的模板是 `{#if VITE_IS_DESKTOP}…{/if}{#if VITE_IS_WEB}…{/if}` 两段互斥分支。本移植把两个开关**同时置为 false**（Android 是第三种取值），于是两段都不渲染 → `bind:this={domBtns}` **永远不会被赋值**；而 `onMount` 里写的是 `domBtns!.addEventListener(…)`（非空断言）→ 抛 TypeError → 组件树后续刷新中断 → 整页白 + 关闭键一并消失。
  2. 即便不抛异常，桌面版纵向尺寸（封面 234 + 歌词 + 控制条）在 412×915 下也装不下：`.left-info` 因「子元素绝对定位、父级无显式高度」退化成 8px（与 **ERR-006 同族**），控制条被推到 y≈2793。
- **修复**：新增覆写 **O-7**（`ui/overrides/components/layout/PlayDetail/Header.svelte`）—— ① 挂监听前判空，并把清理函数改成「只 `unsub()`」，避免提前 return 漏掉 `appEvent.on('focus')` 的订阅；② 补 `{#if VITE_IS_ANDROID}` 分支真正渲染顶栏（关闭键 44dp，uiux §5 要求）。布局侧在 `mobile.less` 新增 §15：封面定比、歌词 `flex:1 1 auto; min-height:0`、控制条 `flex:none` 且吃 `--safe-bottom`。修复后 `.left-info` 231.2px、歌词区 291.85px、暂停键 y=683、视口外按钮 0/11、未捕获异常 0。
- **教训**：**三段式环境分支（desktop / web / android）在引入第三种取值时会出现「两边都不渲染」的空洞**——上游按 `if/else if` 之外的两段 `{#if}` 写，天然不覆盖第三种。凡是 `VITE_IS_*` 控制渲染的地方，都要问一句「两个都为 false 时渲染出什么」。另外，Svelte 5 的 `bind:this` 不保证早于 `onMount`，`!` 非空断言在这里是把「可能为空」变成「必崩」。

---

### ERR-015（2026-11-04）设置页 13 项里 10 项永久不可达：`width:auto` 让滚动容器「自己不溢出」

- **现象**：设置页只能看到前 3 项（Basic / Playback / Play Details Page），后面的列表设置、快捷键、扩展服务、在线资源、网络、数据同步、备份恢复、其他、更新、关于**全部被裁在屏幕外，且滑不动**。
- **量出来的证据**：`.settings-app-list` 计算宽 **1793.12px**，父级 `.settings-app-container` 仅 412、`overflow-x: visible`；内层 `.list` 的 `scrollWidth == clientWidth == 1793` → **它自身不溢出，`overflow-x:auto` 形同虚设**；外层 `.content` 是 `overflow-x:hidden` → 全部裁掉；真实滑动 14 步 `scrollLeft` 恒 0。
- **根因**：移动端把左栏改成横滑 chip 条时，给容器写了 `width: auto !important`。`auto` 让容器**按内容撑开**到 1793px —— 滚动容器（`.list`）于是永远有足够空间、永远不产生溢出，滚动条与手势都失效；真正的裁剪发生在更外层的 `overflow:hidden` 上，所以「看得见一部分、滑不动」。
- **修复**：`mobile.less` §9 改为 `width: 100% !important; max-width: 100% !important; min-width: 0 !important`。修复后容器 412.19px、`.list` `412 / 1793`、两次真实横滑 `scrollLeft` 272.4 → 565.7，13 项逐一可点并进入面板。
- **教训**：**「给子元素设 `overflow-x:auto`」必须同时把父级宽度钉死**（百分比或 `min-width:0`）。`width:auto` + 内容宽度 = 永不溢出，滚动容器会安静地退化成普通容器，而报错为零。这条与 ERR-012（`width:18%`）是一体两面：一个是太窄，一个是太宽，**共同点是「百分比/auto 在桌面基准下都不等于移动端可用宽度」**。

---

### ERR-016（2026-11-04）扩展管理页在移动壳零入口（ERR-004 同类第二次）

- **现象**：装完 App 遍历 3 个 Tab 与设置页全部条目，**没有任何入口**能进入扩展管理（安装/启用/禁用/扩展商店/本地安装）。
- **证据**：`grep -rn "extenstion" porting/js/ui` = **0 命中**；上游唯一入口在 `Aside/Nav.svelte:82,151` 与 `Header/ControlBtnsDesktop.svelte:47`，这两个都是移动壳**不渲染**的桌面组件；直接改 hash 到 `#/extenstion` 页面可正常渲染。
- **根因**：与 **ERR-004（导入本地音乐入口为零）** 完全同构 —— 入口挂在桌面壳（Aside / Header）上，而移动端只渲染 `MobileAppShell`，换壳时把「入口」和「页面」一起搬丢了，页面还在路由表里。PDR-002 明确要求保留第三方扩展能力，这条直接违反。
- **修复**：`MobileAppBar` 本来就有 `actions` snippet 槽位（此前是空实现），在 `/settings` 路径下渲染一个 44dp 文字按钮「扩展管理」→ `push('/extenstion')`；不加第 4 个 Tab（3 Tab 的 IA 已冻结）。
- **教训**：**换壳时必须做一次「入口清点」而不是「页面清点」**：把上游所有 `navigate/push` 的调用点列出来，逐个确认它在移动壳里是否有承载元素。同一个错误在导入、扩展两处各犯一次，说明当时只验了「页面能不能渲染」，没验「用户能不能到达」。

---

### ERR-017（2026-11-04）交付 APK 落后 dist 一次构建，门禁两个模式全绿

- **现象**：返回键在「访问过 2 个 Tab 之后」出现一次完全无反应的按击，随后 `hash` 变空、Activity 退到后台（WebView 被导航出 SPA）；「再按一次退出」的 toast 永不出现。
- **证据**：APK 内是 `assets/web/spa/assets/main.CgvrA_B_.js`（1,370,688 B / sha256 `b0392edd…`），磁盘 `dist/spa/assets/main.DF1m3J24.js`（1,372,012 B / `8e363856…`）；在 APK 全部 `.js` 里搜 `__anylisten_canGoBack__ / __anylisten_goBack__ / __anylisten_back_debug__` → **NONE**，dist 里 → 全命中；运行时 `typeof window.__anylisten_canGoBack__ === 'undefined'`。
- **根因**：dist 在 22:50 重建（把 `main.ts:23` 的 `import '../ui/boot/androidBack'` 编了进去），APK 是 22:32 的产物。契约缺失后 `MainActivity` 走 `JS_BACK` 的回退分支 `if (history.length > 1) history.back()`，而 `history.length` **只增不减**（`androidBack.ts` 文件头早已注明）→ 空返回 → 把 SPA 导航出栈。
- **为什么门禁没拦住**：`check-webdist.mjs` 的两种模式都只校验「**目录内部**引用自洽」（index 引用的 `main.*.js` 在同目录存在、worker 引用完整）。dist 自洽、assets 也自洽，但**两者不是同一次构建** —— 门禁全绿。
- **修复**：重跑 `build:all` → `syncWebAssets` → `assembleDebug`；并给 `check-webdist.mjs` 补 **F-7**：`index.html`、`main.*.js`、`extension-preload.js` 三项指纹 dist↔assets 全等，不一致即 `INCONSISTENT` + exit 1（已用 D-13 的真实数据复现红、还原后复绿）。
- **教训**：**「产物自洽」不等于「交付物与产物一致」**。凡是「先构建 A、再把它复制进 B 打包」的链路，门禁必须有一条**跨目录全等比对**，否则「最后一次构建没进包」这种事故永远只能靠人肉发现。另一个陷阱：本包与前后两轮的**字节数完全相同**（24,343,591），比对大小会得出「没换包」的错误结论 —— 判身份只能用 sha256 + 包内文件名。

---

### ERR-018（2026-11-04）返回键：Tab 切换入栈 + 缺「覆盖层」档，一次按键连关两层

- **现象**：① 访问 2 个 Tab 后按返回，出现空返回并最终白屏（与 ERR-017 叠加）；② 播放详情 + 声音设置弹窗时按返回，**两者一起消失**；③ 播放详情 + 评论弹窗时按返回，播放详情关了、**弹窗仍在**并跟随路由重渲染，全屏悬停在 `#/settings` 上。
- **根因**：`androidBack.ts` 用 hash 栈记账，最初**每次 hash 变化都入栈**，Tab 切换也算「一层」。而 Android 的顶层目的地（bottom nav 的 tab）按平台规范**不应进入返回栈** —— 用户期望「任何 Tab 上按返回 = 退出」而不是「逐级退回上一个 Tab」。同时 `goBack()` 的优先级只有「播放详情 → hash 栈」，缺「最上层弹层」一档，于是弹窗与覆盖层被同一次按键一起处理。
- **修复**：① 根级路径（`/library`、`/online`、`/search`、`/settings`，判定前先去查询串）命中时**把栈截断为 1**，于是任何顶层 Tab 上 `canGoBack` 恒 false → 原生走「再按一次退出」；② 优先级改为 **最上层弹层 → 播放详情 → hash 栈**，`canGoBack()` 同步加弹层档（否则原生先弹退出 toast，`goBack()` 根本没机会执行）；③ `debug()` 增加 `popup` 字段。
- **残余（D-27，P2）**：第 1 档只认 `.popup` / `.menu`，**不含 `.modal`**，所以「声音设置弹窗 + 播放详情」仍会一起关、评论弹窗仍会留一个可点遮罩关闭的孤儿。这条登记为遗留，不阻断交付。
- **教训**：**返回键是「层」的问题，不是「历史长度」的问题**。`history.length` 只增不减，永远不能当「能否回退」的判据；必须由 SPA 自己维护语义栈。而且每新增一种覆盖层（播放详情、弹层、模态框、抽屉），都要把它**显式排进优先级链**，否则新层会自动落到「和别的层一起被关」或「关不掉」两个极端。

---

### ERR-019（2026-11-04）底部弹层只能开不能关：`!important` 把过渡钉死 → `transitionend` 永不触发

- **现象**：倍速/音量/循环/播放列表任一浮层打开后，**6 种关闭方式全败**（再点触发器、点外部两次、鼠标点外部、下滑手势、点弹层空白区）；`elementFromPoint` 在 (206,300)(206,150)(382,76)(206,719) 四点**全部**返回 `DIV.popup`。副作用：点「收藏」的位置实际落在倍速滑块上，把倍速静默改成 **1.24x**。
- **根因（两层）**：
  1. **指针层**：`mobile.less` §3 给 `.popup` 加了 `pointer-events:auto !important` + `::before { position:fixed; inset:0 }` 的全屏 scrim。伪元素的命中目标是宿主元素，于是**整个视口都算「点在弹层上」**。而上游 `Popup.svelte` 根节点只有 `onclick={e=>e.stopPropagation()}`，**没有任何关闭处理**；关闭只来自 `onmouseleave={handlMsLeave}`，触屏没有 hover；`PopupBtn.svelte:34-41` 在 `autoshow=true` 时「再点触发器」直接 `return`。三条叠加 = 没有关闭路径。
  2. **卸载层（补第一层后仍然关不掉）**：派发 `mouseleave` 后状态确实变了（`class` 从 `popup top active` 变 `popup top`、`inert` 已加），但 `opacity` 仍是 1、`getBoundingClientRect().height` 仍是 168。因为 §3 的 `opacity:1 !important` + `transform:none !important` **把过渡两端钉成同一个值 → 过渡不成立 → 上游唯一的卸载信号 `ontransitionend` 永不触发 → `render` 恒 true**。元素留在 DOM 且继续 `pointer-events:auto` 吃整个视口，这就是「状态关了、像素没变」。
- **修复**：新增 `ui/boot/popupDismiss.ts`（capture 阶段 `pointerdown` → 用 `.popup-content` 的 rect 判内外 → 外部派发 `mouseleave`），外加三条兜底：`html.mobile .popup[inert], .menu[inert] { display:none !important }`（用组件自己的关闭信号，不依赖过渡）、关闭后补发合成 `transitionend`（让上游按原设计 `render=false` 卸载）、`inert` 的 `MutationObserver`（兜住「上游自己关」的路径，例如点循环选项走 `popup.hide()`）。
- **验证**：四个浮层 × 3 轮开合，每轮 `.popup` DOM 计数 `1 → 0`（不是 opacity 变化）；重开 3 轮正常；点选项生效并自动关闭；串台消失（点收藏只切收藏、倍速恒 1.48x）。
- **教训**：**用 `!important` 覆盖 `opacity` / `transform` 会破坏依赖 `transitionend` 的组件契约** —— 视觉上「已经在了」，但组件内部永远收不到「过渡结束」，于是一切「卸载/清理」逻辑都不执行，留下继续吃指针的僵尸节点。排查这类问题不能只看 `visible` 状态或截图，必须看 **DOM 计数**与 `inert`。第二条：**上游用 hover 语义做的交互，触屏上必须补一条替代关闭路径（点空白/返回键），否则功能等于不可用**。

---

### ERR-020（2026-11-03）构建事故：`MainActivity.kt` 出现两个 `companion object`，源码树编译不过而交付包仍是旧的

- **现象**：本轮第一次 `./gradlew assembleDebug` 直接 `compileDebugKotlin FAILED`：`Unresolved reference 'TAG'` + `Only one companion object is allowed per class`。
- **根因**：`MainActivity.kt` 在 22:48 被改出**两个** `private companion object`（第 507 行与第 587 行，后者多一个 `const val TAG`）。Kotlin 只允许一个伴生对象，第二个里的 `TAG` 解析不到。而 22:32 那个 APK 是「改坏之前」的产物 —— 于是出现最危险的状态：**包能装、能跑，但源码树已经构建不出它**。
- **修复**：删掉冗余的第一块，保留含 `TAG` + `JS_BACK` 的那块，未改任何逻辑。
- **教训**：**「装上去能用」不能作为「源码是可构建的」的证据**。交付前必须做一次 clean 环境构建（`-PrequireWeb=true`），否则「最后一次改动把源码改坏、但没人重新构建」会一直潜伏到下一次发版。这条与 ERR-017 是同一个母题的两面：**交付物的身份必须由「从当前源码重新构建一次」来锚定，而不是由「手上这个包能跑」来锚定**。

### ERR-021（2026-11-04）自动备份「从未生效」：垫片把 `createReadStream` 判死，首份之后每次都败在去重

- **现象**：真机每次冷启动必打 `[dbService] backup failed init PortError: fs.createReadStream is not available on Android…`；备份目录里只有一份 11-03 15:02 的 `.bak`，此后 30 小时再无新文件。
- **排查误区**：这条被当成「备份功能不可用」报了 P2，但真实形态更窄也更隐蔽 —— **首份备份是成功的**。`backupTask/index.ts` 的流程是「先 `db.backup(temp)`，若已有上一份则算两边 sha256 比对去重」；首份没有 `latestFile`，所以根本不走哈希；从第二份起才进 `hashFileSha256`，而它用的正是被移植层判死的 `createReadStream`。于是失败点落在**去重**，而不是备份本身。
- **次生影响**：`saveMetadataLastBackupTime` 只在成功分支调用 → 元数据永远为空 → 每次启动都认为「今天还没备份」→ 每次重试、每次失败，形成静默死循环。「备份与恢复」页看似正常，实则没有任何新数据。
- **修复**：`shims/fs.ts` 提供最小 `FsReadStream`：异步 `readFile` → 按 `start`/`end` 切片 → 依次 `emit('data'|'end'|'close')`，带 `pipe`/`destroy`。实测本轮冷启动产出 `anylisten.data.db.20261104-093003313.bak`（114,688 B），同日第二次冷启动不再新增（去重生效）。
- **教训**：**「某个 API 没人用」和「某个 API 只在失败路径上被用」是两种完全不同的判断**。当初把 `createReadStream` 一律判 `EUNSUPPORTED` 是合理的保守选择，但它的消费者恰好是「第二份备份」这种不常触发的分支 —— 于是错误只在运行一段时间后才出现，且不影响任何主流程，很容易被当作噪声。判死一个 API 前，应把调用点连同**触发条件**一起读（这里是「仅当已有上一份备份」）。

### ERR-022（2026-11-04）日志页永远 ENOENT：写入路径与读取路径各自「合理」，但从未对齐

- **现象**：进入「日志输出」页每次抛 `Uncaught (in promise) Error: ENOENT: log file not found, '/data/user/0/com.anylisten.android/files/app/logs/app.log'`；页面空白。
- **根因**：**不是容错缺失，是两条路径从来不是同一个文件**。
  - Kotlin `LogPort` 写 `files/logs/anylisten-<yyyy-MM-dd>.log`（按日期分文件）；
  - JS 侧按上游约定读 `joinPath(dataPath, 'logs') + 'app.log'`，即 `files/app/logs/app.log`。
  两者目录差一层 `app/`、文件名与分片策略也完全不同，所以「写得很勤」与「读不到」可以同时成立。真机上能看到直接证据：`files/logs/anylisten-2026-11-04.log` 已 274 KB，而同一天的 `files/app/logs/` 是空目录。
- **修复**：写入端向读取端对齐 —— `LogPort.logDir` 改为 `filesDir/app/logs`、文件名固定 `app.log`（滚动改名为 `app.<ts>.log`）；`readLastLines` 对不存在的文件返回空列表（日志文件本就惰性创建，缺失是正常态而非错误）；JS 桥接层再加一层降级。实测日志页读到 3,943 字符真实日志、进出两轮 0 未捕获异常。
- **教训**：**跨语言边界上的路径约定必须有单一事实来源**。`LogPort` 的 KDoc 当时写着「对应上游 `@any-listen/nodejs/logs` 的落盘行为」，但「对应」只写在注释里，没有任何断言把它钉住；而 UI 读取端又是按上游常量拼的。两边各自都能自证「我是对的」，中间没有人比对。这类缺陷不会在启动判据里暴露，也不会在功能主链路上暴露 —— 只有真的点开那一页才会看到。凡是跨边界（Kotlin↔JS、进程↔进程）共享的路径/文件名，都应在启动时做一次「读到自己刚写的那一行」的自检。

### ERR-023（2026-11-04）「单击不播放」不是坏键，是上游手写的 400ms 双击窗口被搬到了触屏

- **现象**：真机上单击曲库里的歌，什么都不发生；只有快速点两下才起播。播放列表（队列）同样。对音乐播放器而言，这等价于主功能不可用。
- **先纠错**：我最初写的是「Chromium 对触摸有 `dblclick` 合成，所以是双击语义」——**这句话是错的**，触屏并不会因为两次点击就自动播放。真实原因在上游业务代码里：
  ```ts
  // MusicList/List/action.ts:48-66
  let clickTime = 0, clickInfo = null
  export const musicClick = async (...) => {
    if (performance.now() - clickTime > 400 || clickInfo !== musicInfo) {
      clickTime = performance.now(); clickInfo = musicInfo
      return                 // 第一次：只记录，不播放
    }
    ...void playMusic(...)   // 400ms 内再点同一首：才播放
  }
  ```
  另一个入口 `PlaylistBtn/shared.ts` 是同一形态的 `createClickHandle(() => {}, index => playIndex(index))`。桌面端「单击选中 / 双击打开」是合理惯例，触屏没有这个惯例。
- **取证难点**：一开始两次点击落在**不同坐标**（单击在 y=312、双击脚本在 y=436），「单击不播、双击才播」的结论其实混了两个变量。重做时固定同一行、先暂停播放、用 `play_time` 是否增长与迷你播放器按钮文案做判据，才得到干净的 A/B。
- **修复**：移动端覆写两处 —— 曲库列表单击直接 `playMusic`（保留 `setSelectIndex` 与多选分支），队列 `musicClick` 直接 `playIndex`。实测：单击第 2 首立即起播；队列单击 03→01 一次到位；多选态点行只累加选中数、当前曲不变。
- **教训**：**看到「点一下没反应」时，先分清是「没绑 handler」还是「handler 里主动 return」**。这次两者都不是坏键、也不是事件丢失，而是业务代码把「第一次点击」定义成了「记时间」。如果只测「点一下有没有反应」而不读源码，很容易得出「触控坏了」的错误结论，进而去改根本不需要改的事件层。

---

## 本轮验收结论（2026-11-04 v3）

| 门禁 | 结论 | 证据位置 |
|---|---|---|
| 功能等价性 | 通过 | `docs/phase5-acceptance-report.md` §9/§10 |
| 移动端触控可用性 | 通过 | 同上 §10（浮层 12 轮 DOM 归零、控件 0 个 <44×44） |
| 许可证合规 | 有条件通过 | `docs/phase6-compliance.md` §4（C-1/C-2 需用户书面裁决） |
| 构建可复现性 | 通过（F-5 四场景 + F-7 dist↔assets 全等） | `artifacts/f5-gate-verify.md`、`check-webdist.mjs` |

交付物 sha256 `9c9b186e…d41d9874`（24,343,888 B，包内 `main.Z6HMLjsc.js`）；上游 `source/` 零改动（HEAD `c8f40eab`，`git status` 0 行）。D-16 / D-29 / D-30 修复后已按验收报告 §12 / §13 真机复验；新增 D-31（长时息屏后 WebView 渲染进程被回收 → 恢复显示 `chrome-error://`）待排期。


