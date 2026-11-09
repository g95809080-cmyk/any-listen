# Any Listen — Android 宿主工程（Phase 4 原生侧）

把 Any Listen（Electron/Node 桌面版）的**原生能力**在 Android NDK/JDK 工具链下重新实现为 Kotlin 端口层，
Web 前端（`porting/js` 构建出的 SPA）跑在 `WebView` 里，通过 `message2call` 帧协议 + 本地 HTTP 服务与原生侧通信。

设计原则（见 `docs/phase2-architecture.md` §4/§6/§8.2）：

- **不移植进程模型，只移植能力**。Node 的 `fs`/`net`/`worker_threads` 不进 Android，换成 Kotlin 端口 + 协程。
- **所有端口方法都在 `Dispatchers.IO` 上执行**，主线程只做 View 操作。JS 侧只允许异步调用。
- **错误码与 Node `errno` 同名**（`ENOENT`/`EACCES`/`EIO`/`EUNSUPPORTED`/`ECANCELED`…），因为上游代码里有 `if (e.code != 'ENOENT')` 这类分支，名字对不上就会走错路径。
- **不修改 `source/` 下任何文件**。上游源码只读引用。

---

## 1. 目录与模块

```
porting/android/
├── settings.gradle.kts          阿里云镜像优先 + google()/mavenCentral() 兜底
├── build.gradle.kts             根工程（只声明插件，不 apply）
├── gradle.properties            jvmargs / AndroidX / overridePathCheck（路径含中文必须）
├── local.properties             SDK 路径（不入库，见 .gitignore）
├── gradle/libs.versions.toml    版本目录：AGP 8.13.2 / Kotlin 2.2.10 / OkHttp 4.12 / commons-compress 1.27
├── gradlew(.bat) + gradle/      Gradle Wrapper 8.14.3
│
├── core-ports/                  【纯 Kotlin 库，无 Android UI 依赖】17 个文件
├── bridge/                      【@JavascriptInterface + 本地 HTTP 服务】8 个文件
├── webassets/                   只有 Gradle 任务，把 porting/js/dist 同步进 app 的 assets
└── app/                         APK 壳：Activity / Service / Manifest / 资源
```

### `:core-ports` — 端口接口与实现

| 文件 | 内容 |
|------|------|
| `PortError.kt` | `PortErrorCode` 枚举、`PortException`、`Throwable.toPortException()`（Java 异常 → Node errno 映射表） |
| `PortRegistry.kt` | **唯一装配入口**：`lazy` 初始化 fs/settings/log/power/intent，`bindUiPorts(...)` 注入 Activity 级能力 |
| `fs/FsModels.kt` | `FsEntry`/`FsStat`/`FsWatchEvent`/`ListTreeOptions`/`ListTreeResult`/`DirPickResult` |
| `fs/FileSystemPort.kt` | 接口：`listTree`(分批+可取消) / `stat` / `readFile` / `writeFileAtomic` / `mkdirp` / `remove` / `rename` / `copy` / `readdir` / `realpath` / `watch` / `toPlayableUrl` / `getEnv` / `getFreeSpace` |
| `fs/FileSystemPortImpl.kt` | 显式栈 DFS（避免深目录爆栈）+ 每批 500 条回调 + 逐批检查取消；`writeFileAtomic` = `.tmp → fd.sync() → rename`；`FileObserver` 逐目录注册（上限 1024 目录/深度 8/事件 250ms 合并） |
| `fs/StreamRegistry.kt` | 路径 → `http://127.0.0.1:17930/stream/<id>`，id = `sha256(path\|mtime\|size)` 前 32 hex + 原扩展名，LRU 8192 条 |
| `http/HttpPort.kt` / `HttpPortImpl.kt` / `ProxyMediaCache.kt` | OkHttp + `suspendCancellableCoroutine`（协程取消时自动 `call.cancel()`）；>4MB 响应落临时文件返回 `filePath`；`downloadTo` 写 `.part` + SHA-256 + 200ms 节流进度；`proxyRequestByUrl/ByName` 对齐上游 `proxy.ts` 的请求/响应头白名单；`/p_static` 开启缓存时写 `files/cache/proxy`，命中后支持 Range 并允许跨重启离线播放 |
| `media/MediaSessionPort.kt` | `MediaSessionCompat` 封装：metadata / playbackState / position / actions / `updateLyricLine` / `onControl` 回调 |
| `notify/NotificationPort.kt` | `updateLyric(line, next, enabled)` / `showToast` / `showMessageBox` / `clear` |
| `log/LogPort.kt` | logcat + `filesDir/logs/anylisten-<date>.log`，DEBUG 开关（release 关闭）、8MB 滚动、7 天清理 |
| `power/PowerPort.kt` | `PARTIAL_WAKE_LOCK`（12h 兜底）+ 电池优化白名单检测/跳转；`ForegroundServiceController` 由 `:app` 注入 |
| `settings/SettingsStore.kt` | 内存同步读 + 300ms debounce 异步 `writeFileAtomic`；JSON 损坏时备份 `.corrupted` 后从空配置启动 |
| `ui/UiPorts.kt` | `ThemePort` / `ClipboardPort` / `IntentPort`(openUrl·shareFile·openDocument·saveDocument·openAppSettings) + `DirectoryPicker`/`DocumentPicker` 接口 |
| `tar/TarPort.kt` | commons-compress，`LONGFILE_POSIX`+`BIGNUMBER_POSIX`；解包做**路径穿越防护**（canonicalFile + startsWith 校验）；`.gz`/`.tgz` 自动 gzip |
| `lifecycle/LifecycleHub.kt` | 前后台/`onTrimMemory`/终止前回调，供 JS 侧做缓存清理 |
| `audio/AudioPorts.kt` | `AudioFocusManager`（`AUDIOFOCUS_GAIN`、USAGE_MEDIA/CONTENT_TYPE_MUSIC）、`AudioEngine` 枚举、`AudioCapabilities`、`AudioEngineRouter` 接口 + `WebOnlyAudioEngineRouter`（native* 全抛 `EUNSUPPORTED`）—— **`:native-audio` 本阶段不实现，接口先冻结** |

### `:bridge` — WebView 与本地 HTTP 的入口

| 文件 | 内容 |
|------|------|
| `Message2CallFrames.kt` | message2call v2 的 4 种帧的编解码 + `JsonBinary`（`{"$b64": "..."}` 二进制信封） |
| `BridgeContext.kt` | `Args`（类型安全取参，缺参抛错而不是静默 null）、`BridgeContext.callbackAt(order)`、`emit(frame)`、`BridgeModule` 接口 |
| `BridgeRouter.kt` | 模块注册表 + `Dispatchers.IO.limitedParallelism(8)` 派发，异常统一转 `errorPayload(code, message, detail)` |
| `modules/FsModule.kt` | `fs.*` 全部方法；`listTree`/`watch` 用回调（`callbackAt(0)` = onBatch / onEvent） |
| `modules/PortModules.kt` | `http` / `log` / `settings` / `power` / `theme` / `clipboard` / `intent` / `tar` / `lifecycle` / `audio` |
| `modules/MediaModules.kt` | `mediaSession` / `notification` |
| `LocalHttpServer.kt` | 固定 17930 端口、绑 `127.0.0.1`、SPA 静态 + Range 流 + 代理 + token |
| `AndroidBridge.kt` | **只暴露两个方法**：`postMessage(token, frameJson)` 和 `ping()` |

### `:webassets` — 前端产物同步（只有 Gradle 任务，无源码）

| 任务 | 内容 |
|------|------|
| `buildWebJs` | 在 `../js` 跑 `pnpm build:all`；`-PskipWeb=true` 跳过、退出码非 0 只 warn（不卡原生构建） |
| `cleanJsDist` | 兜底清 `../js/dist`（仅 `-PcleanJsDist=true`） |
| `syncWebAssets` | `Sync` 到 `app/src/main/assets/web/spa`；排除 `.map`/`.ts`/垃圾目录；结束后做**引用一致性校验**（缺 worker 直接 fail）、dist 根异常入口告警、体积体检 |

### `:app` — APK 壳

| 文件 | 内容 |
|------|------|
| `AppGraph.kt` | 全局装配：token（`SecureRandom` 32 hex）、`PortRegistry`、`LocalHttpServer`、当前 Activity 弱引用 |
| `AnyListenApp.kt` | 启动即开 HTTP 服务、装崩溃日志、后台预热 `fs.getEnv()` |
| `MainActivity.kt` | 全屏 WebView + 桥注入 + 权限引导 + 返回键 |
| `PlaybackService.kt` | 前台服务（`mediaPlayback`）+ `MediaSessionCompat` + AudioFocus + `MediaStyle` 通知 |
| `AppNotificationPort.kt` | 通知端口的 Activity 相关部分（Toast / AlertDialog） |
| `SafPathResolver.kt` | SAF `tree/primary:Music` → 真实文件路径（仅 primary 卷，见「已知限制」） |

---

## 2. 构建

### 环境要求

| 项 | 版本 |
|----|------|
| JDK | 17（AGP 8.13 硬要求） |
| Android SDK | compileSdk 35 / build-tools 35.x |
| Gradle | 8.14.3（Wrapper 自带，无需本机安装） |
| Node / pnpm | Node 22 + pnpm 10（只在需要构建前端产物时用） |

`local.properties` 需要指向本机 SDK（**不入库**）：

```properties
sdk.dir=C\:\\Users\\<you>\\AppData\\Local\\Android\\Sdk
```

`gradle.properties` 里的 `android.overridePathCheck=true` 是因为工程路径含中文（`Any Listen移植apk`），去掉会直接构建失败。
更稳的替代：给工程建一个**纯 ASCII 的目录联接**再构建，就能彻底绕开所有工具链的 ANSI 路径问题：

```bat
mklink /J C:\al-android "%CD%\porting\android"
cd /d C:\al-android && gradlew.bat :app:assembleDebug
```

### 常用命令

```bash
cd porting/android

# 完整构建（会先跑 pnpm build:all 再同步前端产物）
./gradlew :app:assembleDebug --console=plain

# 推荐：构建前先清掉 porting/js/dist，避免 APK 被历史产物撑大（见下方说明）
./gradlew :app:assembleDebug --console=plain -PcleanJsDist=true

# 只验原生壳（跳过 pnpm，最快，~20s）
./gradlew :app:assembleDebug --console=plain -PskipWeb=true

# 装机/交付用的包：前端产物缺失时直接失败，避免拿到占位 SPA 的包（见下方「并发构建」）
./gradlew :app:assembleDebug --console=plain -PskipWeb=true -PrequireWeb=true

# 发布级体积（R8 裁剪，8.6 MB；用 debug keystore 签名，个人自用可直接装）
./gradlew :app:assembleRelease --console=plain -PskipWeb=true -PrequireWeb=true

# 只同步前端产物，不打包
./gradlew :webassets:syncWebAssets

# 干净重建（qa 验证用）
./gradlew clean :app:assembleDebug --console=plain --no-daemon

# 安装到设备
./gradlew :app:installDebug
# 或 adb install -r app/build/outputs/apk/debug/app-debug.apk
```

### 真机部署（`scripts/deploy.sh` / `deploy.ps1`）

比手动 `installDebug` 多做了三件事：查设备、动态解析组件名、挂上过滤好的 logcat。

```bash
./scripts/deploy.sh              # 装已构建好的 APK 并跟日志
./scripts/deploy.sh --build      # 先跑 gradlew :app:assembleDebug 再装
./scripts/deploy.sh --clear      # 装之前 pm clear（会清掉 localStorage/IndexedDB，慎用）
./scripts/deploy.sh --loose      # 用 -PallowCleartext=true 构建（见 §4，仅排查在线音源用）
./scripts/deploy.sh --no-log     # 只装不跟日志
```

PowerShell 同参数：`./scripts/deploy.ps1 [-Build] [-Clear] [-Loose] [-NoLog]`。

脚本要点（都是踩过的坑）：

- **adb 定位顺序**：`$ADB` 环境变量 → `local.properties` 里的 `sdk.dir` → `PATH`。Android Studio 没配环境变量时也能跑。
- **组件名动态解析**：`applicationId`（`com.anylisten.android`）与 `namespace`（`com.anylisten.app`）不一致，
  写死 `am start -n com.anylisten.android/.MainActivity` 必然失败。改用
  `cmd package resolve-activity --brief <pkg>` 取实际组件（当前是 `com.anylisten.android/com.anylisten.app.MainActivity`）。
- **没有设备时给排查清单**：USB 调试授权、`adb kill-server && adb start-server`、无线调试地址失效等，不静默退出。
- **logcat 只留必要 tag**：`AnyListen/*`、`AndroidRuntime:E`、`chromium:E`、`DEBUG:E`，避免被系统日志淹掉。
- **`--build` 是安全的路径**：它让**同一次** Gradle 调用里先跑完 `pnpm build:all`、再 `syncWebAssets`，
  天然不会踩到并发构建的坑（这也是当前 fullstack 还在改 UI 时推荐的装机方式）。

> 当前设备状态：APK 曾安装成功（`Performing Streamed Install / Success`），
> 但随后设备变为 `offline`（`cannot connect to 192.168.1.16:43305: ... (10060)`），
> **首屏渲染、Range 拖动、后台播放、通知栏按钮均未在真机上验证**（见 §7.1）。

### ⚠️ 不要和 `pnpm build:all` 并发构建

`syncWebAssets` 是 `Sync` 任务：它把 `assets/web/spa` 与**当前** `dist/` 对齐。
而 JS 侧 `build` 的第一道工序就是 `clean:spa` —— 这两个动作撞在一起会出现：

1. JS 刚删掉 `dist/spa`，原生侧开始 sync → `dist/spa` 不在 → 占位 SPA 覆盖整套真实产物；
2. 得到一个体积小得「可疑得好」的包（实测 release 988 KB），装机后白屏；
3. 构建日志里只有一条很容易划过去的 `warn`。

现有两道防线：

| 开关 | 作用 |
|------|------|
| 默认 | 只 **warn**（日志含 `will replace them with the placeholder SPA`），构建继续 |
| `-PrequireWeb=true` | 同样条件下 **直接失败**。交付/装机用的包一律带它：`./gradlew :app:assembleDebug -PskipWeb=true -PrequireWeb=true` |
| `-PskipWeb=true` | 只跳过 pnpm，仍会同步现有 `dist`（验原生壳时用），所以也要配 `-PrequireWeb=true` 才安全 |

单纯 `dist` 不存在（第一次 clone、从未跑过前端）时仍只 warn 不失败，占位 SPA 是**预期**行为。

### 引用一致性校验（`syncWebAssets` 之后，**失败即中断构建**）

真机白屏的根因不是「dist 缺失」，而是**产物代次错配**：`index.html` / `main.<hash>.js` 来自一次完整构建，
而 worker 只写出了一半时就被 sync 了。实测现场：

```
E/AnyListen/webview: [main] core worker 崩溃 undefined undefined
@http://127.0.0.1:17930/assets/main.CBDppg_e.js:40955
```

UI 停在 `Loading...`。注意这段日志**不会说 404**：`new Worker()` 加载失败时 `event.message` 是 `undefined`，
`onerror` 里拼出来的就是「崩溃 undefined undefined」。

所以 `syncWebAssets` 结束后会做三条对账（`webassets/build.gradle.kts` 的 `doLast`）：

1. `index.html` 的 `<script src>` 指向的入口 js 必须存在；
2. **入口 + 每个 worker 自己**里出现的所有 `*.worker-<hash>.js` 引用必须都能在 `assets/web/spa/assets/` 找到；
3. 产物里引用了 `/extension-preload/extension-preload.js` 时，`assets/web/spa/extension-preload/extension-preload.js` 必须在
   （缺了 core worker 会报 `[extension] preload 加载失败：HTTP 404`）；该文件由 `LocalHttpServer.handleStatic` 从 assets 提供，
   和 index.html 一样需要 token/cookie，SPA 首屏拿到的 `Set-Cookie` 会让同源 `fetch` 自动带上；
4. 反过来，没有任何文件引用的 worker 是上一代残留 → **warn**（只占体积，不报错）。

成功时打一行：

```
[webassets] reference check OK: 1 entry / 5 worker, 5 worker references
```

缺失时 **fail**，报错直接列出缺失清单：

```
[webassets] INCONSISTENT web assets -- the APK would show a blank screen (stuck at Loading...).
  entries referenced by index.html: main.CBDppg_e.js
  MISSING workers: core.worker-C8G_tyNB.js
  present workers: db.worker-..., ext.worker-..., ...
  Cause: `porting/js/dist` was captured mid-build (pnpm build:all empties dist/spa first).
  Fix: run `pnpm -C ../../js build:all` to completion, then rebuild the APK.
```

`-PskipWebCheck=true` 可把这条降级为 warn —— 只在明确知道产物不一致、又急着验别的东西时用，那个包装机大概率白屏。

打包前的**只读**自检（不动 dist、不跑 gradle，A/B 交接时用）：`node scripts/check-webdist.mjs`，
输出 entry / worker / 缺失清单 / orphan / `index.html` 与 main bundle 的 SHA1，不一致时退出码 1。

> ⚠️ `extension-preload` 的取法：SPA 用 `fetch('/extension-preload/extension-preload.js')`，
> 走 `LocalHttpServer.handleStatic` + 统一 `isAuthorized()`（query `t=` / header / **cookie** 三者之一）。
> 首屏 `index.html` 响应带 `Set-Cookie: <TOKEN_COOKIE>=…; Path=/`，同源 `fetch` 默认带 cookie 所以能过。
> **如果哪天把它改成 `credentials: 'omit'`，就会拿到 403**（不是 404，别找错方向）。

### ⚠️ 当前构建纪律（fullstack 还在改 UI）

JS 侧随时可能 `clean:spa`，所以**不要并发构建**。装机流程固定成两步：

```bash
cd porting/js && pnpm build:all          # 单独跑完，确认 dist/spa 完整（应有 5 个 worker + main）
cd ../android && ./gradlew :app:assembleDebug -PrequireWeb=true
```

先前的失败样本：`assets/web/spa/assets/` 里 `ext/utils.worker-*` 在、`core/db.worker-*` 不在，
而 `main.js` 同时引用这四个 —— 就是在 `pnpm build:all` 写到一半时 sync 的。

### APK 体积构成（实测）

| 构建 | 体积 | 说明 |
|------|------|------|
| `assembleDebug` | **24.3 MB** | `classes.dex` 10.2 MB 是大头：debug 不跑 R8，AndroidX + Kotlin stdlib + coroutines 全量未裁剪 |
| `assembleRelease` | **10.2 MB** | `isMinifyEnabled=true` + `isShrinkResources=true`（用 debug keystore 签名，个人自用可直接装） |

结论：**不要为了体积去删 wasm / worker**。前端 assets 原始 29.8 MB、压缩后约 10 MB；
4 个 `emscripten-module-*.wasm` 压缩后合计约 2.2 MB，md5 各异（不同解析器，删了对应格式就废）；
5 个 worker 里 `core.worker-*` 1.78 MB + `db.worker-*` 1.14 MB 是核心逻辑，删了直接白屏。
真要压体积就走 release —— R8 已经把 dex 从 10.2 MB 压到 0.74 MB。

产物：`app/build/outputs/apk/debug/app-debug.apk`（带真实前端 24.3 MB；`-PskipWeb=true` 且 dist 缺失时是占位包约 1 MB）；
发布级 `app/build/outputs/apk/release/app-release.apk` 约 10.2 MB。

### `-PskipWeb=true` 的语义

| 情形 | 行为 |
|------|------|
| `-PskipWeb=true` | 完全跳过 `pnpm build:all`，直接同步 `porting/js/dist` 里**已有**的内容（没有就用占位 SPA） |
| `porting/js/package.json` 不存在 | 警告并跳过，用占位 SPA |
| `porting/js/node_modules` 不存在 | 警告并跳过（提示先 `pnpm install`），用占位 SPA |
| `pnpm build:all` 退出码非 0 | **只警告不失败** —— JS 侧并行开发，不能让它把原生构建卡死。当前实测退出码为 0（`vite.extension-preload.config.mjs` 已由 fullstack 补齐） |
| `porting/js/dist` 不存在 | 用 `webassets/placeholder/index.html` 顶替，APK 可安装可跑桥 |

### `-PcleanJsDist=true`（兜底，平常不用传）

跑 pnpm 之前先删掉 `porting/js/dist`，然后全新构建一次。**默认关闭**（dist 是 fullstack 的产物目录，原生侧不擅自删）。

**根因已由 JS 侧修复**：`porting/js/scripts/clean.mjs` 现在是 `build` 的第一道工序
（`build` = `link-vendor && clean:spa && copy-wasm && vite build`），`build:all` 天然带上，
连跑三次产物字节级一致（204 文件 / 50.6 MB，含 `.map`）。所以这个开关降级为**兜底**：
只在怀疑 `dist` 被别的分支/历史产物污染时手动加一次。

历史原因（留档）：`vite.config.mjs` 里 `emptyOutDir: false`（沙箱的 `rmSync` 被换成 trash 实现，清目录会抛错），
每次 `pnpm build:all` 都追加一整套新 hash 产物，而 `index.html` 只引用最新那套 —— 旧的 `index-*.js` / `main.*.js`
全是死文件。实测连续构建两次后 `dist` 堆到 188 文件、APK 从 17 MB 涨到 20 MB 以上。

`syncWebAssets` 结尾会打印体积体检，出现下面这行就说明 `dist` 不干净：

```
[webassets] 19 duplicate artifact groups (same content, different hash), ~4.0 MB wasted
```

> 注意这 4 MB 里有一部分**不是**历史残留：`vite` 的每个 Web Worker 都是独立 rollup 构建，主图和 worker 图会各自 emit
> 一份内容相同的共享 chunk（`core-*`/`index-*`/各 parser）。这是 Vite 的正常行为，只能靠 JS 侧做「同内容去重 + 引用改写」解决，
> 原生侧不改写 hash 引用（改了必然 404）。

### `dist` 根被拍平进 assets —— 不要把临时目录放进去

`syncWebAssets` 的第二个 `from(jsDistDir)` 是**拍平拷贝**：`dist/` 根下除 `spa/` 之外的一切都会被倒进
`app/src/main/assets/web/spa`。历史上真实踩过：JS 侧清目录兜底把旧产物改名成 `dist/spa.old.<ts>`，
结果 89 个文件 / 26 MB 原样进了 APK（`assets/web/spa/spa.old.1793678981054`）。

现在的防御是两道：

1. `exclude("spa/**", "**/*.map", "**/*.old.*", "**/.trash/**", "smoke/**", "**/.DS_Store")` —— 挡掉已知垃圾形态
   （`smoke/**` 是 `pnpm` 的 smoke 测试脚本 `dist/smoke/smoke.mjs`，Node 脚本，不是运行时资源）；
2. `syncWebAssets` 结尾扫描 `dist` 根，出现 `spa/`、`extension-preload/`、`extension-preload.js` 之外的条目就**告警并给出体积**
   （不失败，避免被 JS 侧中间态卡住），日志关键字 `unexpected entries in dist root`。
   这条已经真抓到过一次：`dist/smoke` 121 KB 被拍平进包。

临时/备份目录应该放 `porting/js/.trash/`（`dist` 之外，已 gitignore），不是 `dist/` 里。

占位 SPA 会显示 `window.__ANYLISTEN_BRIDGE_ORIGIN__`、token 与 `AndroidBridge` 探测结果，并带一个「测试桥链路」按钮，可直接验证 WebView→Kotlin→WebView 往返。

**前端产物不入库**：`app/src/main/assets/web/{spa,workers,wasm,extension-preload.js}` 在 `.gitignore` 里，每次构建由 `syncWebAssets` 重新生成。
`sourcemap`（`**/*.map`）与 `**/*.ts` 在同步时被排除，否则 APK 白涨 3–5 MB。

---

## 3. 桥协议（联调必读）

### 3.1 帧格式 —— message2call v2 数组帧

实测 `message2call@2.0.3/dist/message2call.js` 得出，**不是** `{id,name,args}` 对象帧。
Kotlin 侧实现 `bridge/Message2CallFrames.kt`，JS 侧实现 `porting/js/ports/m2c-frame.ts` ——
两个文件注释互相引用，**改动必须成对**。

```
CALL_TYPES = { REQUEST: 0, RESPONSE: 1, CALLBACK_REQUEST: 2, CALLBACK_RESPONSE: 3 }

请求     [0, eventName, pathname: [String], args: [Any],  callbacks: [Int]]
响应     [1, eventName, error: {code,message,detail?} | null, result?]
回调请求 [2, callbackName, args: [Any]]
回调响应 [3, callbackName, error | null, result?]
```

- `eventName = pathname.join('.') + '_' + rand`，**JS 生成**，Kotlin 只回填（用它把响应配回请求）。
- `pathname` 首段是模块名，其余 join 成方法名 —— 无映射表，改名要三处同步（见 §3.3）。
- `error.code` 用 Node errno 同名值：`ENOENT|EACCES|EIO|EUNSUPPORTED|ECANCELED|EUNKNOWN|ETIMEDOUT`。
- **二进制**走信封 `{"$b64":"<base64>"}`（`Uint8Array` 直接 `JSON.stringify` 会退化成
  `{"0":12,...}`，体积膨胀 5–8 倍）。实际只有 `fs.readFile`（出）/ `fs.writeFile`·`writeFileAtomic`（入）
  用到；大文件走 `/stream/<id>`，不过桥。

### 3.2 双向回调是怎么过桥的

`@JavascriptInterface` 只能传字符串，函数实参不可能真的跨语言。JS 侧 `BridgeClient.call()`
在编码时把**顶层函数实参替换成 `func_<n>_<rand>` 字符串**（`n` 是实参下标），并把下标写进
`callbacks` 数组；Kotlin 用 `BridgeContext.callbackAt(order)`（按声明顺序）或
`callbackArg(index)`（按下标）把名字取出来，之后随时可以推 `[2, cbName, args]` 回去，
JS 侧 `BridgeClient` 用回调名反推成本地函数调用。

**回调名对 Kotlin 完全不透明，不要解析它。** 一次性回调（`onBatch`/`onProgress`）在请求响应到达时
由 JS 侧自动释放；订阅类（`onEvent`/`onControl`/`onBackground`/`onFocusChange`/`onSystemThemeChanged`）
必须 `keepCallbacks: true`，Kotlin 侧也不该假设它们会消失。

| 调用（JS → Kotlin） | 回调实参位置 | Kotlin 侧取法 |
|---------------------|-------------|--------------|
| `fs.listTree(root, opts, onBatch)` | 第 3 个（`callbacks` order 0） | `ctx.callbackAt(0)` |
| `fs.watch(root, opts, onEvent, onReady, onError)` | 第 3/4/5 个 | `ctx.callbackArg(2/3/4)`，回退 `callbackAt(0/1/2)` |
| `http.downloadTo(url, destPath, opts, onProgress)` | 第 4 个 | `ctx.callbackArg(3)`，回退 `callbackAt(0)` |
| `lifecycle.onBackground/onForeground/onBeforeTerminate(cb)` | 第 1 个 | `ctx.callbackArg(0)` |
| `lifecycle.onTrimMemory(cb(level))` | 第 1 个 | `ctx.callbackArg(0)`，推 `[level]` |
| `theme.onSystemThemeChanged(cb(isDark))` | 第 1 个 | `ctx.callbackArg(0)`，推 `[isDark]` |
| `audio.onFocusChange(cb(type))` | 第 1 个 | `ctx.callbackArg(0)`，推 `['gain'\|'loss'\|'loss_transient'\|'duck']` |
| `mediaSession.onControl(cb(action, value?))` | 第 1 个 | `ctx.callbackArg(0)`，推 `[action, value]`（`seekto` 的 value 是**毫秒**） |

`fs.listTree` 的分批推送是 `onBatch(entries)`，最后请求本身返回 `{total, canceled, id}`，
`id` 再交给 `fs.cancelScan(id)` —— 这样扫描途中就能取消，不需要额外握手。

### 3.3 方法名对照表（改名要三处同步）

`ports/index.ts` 顶部注释写得很明确：**没有映射表**。改名必须同时改
`porting/js/ports/types.ts` + `ports/index.ts` + Kotlin 的 `FsModule.kt` / `PortModules.kt` / `MediaModules.kt`，
否则会得到 `EUNSUPPORTED: bridge module not found` 或 `... is not implemented`。

| 模块 | 方法 |
|------|------|
| `fs` | `listTree` `cancelScan` `stat` `exists` `readFile` `writeFile` `writeFileAtomic` `appendFile` `mkdirp` `remove` `rename` `copy` `readdir` `realpath` `watch` `unwatch` `toPlayableUrl` `revokePlayableUrl` `pickDirectory` `getEnv` `getFreeSpace` |
| `http` | `request` `downloadTo` `cancel` `setProxy` `registerProxyTarget` `unregisterProxyTarget` |
| `log` | `write` `readLastLines` `openLogFolder` |
| `settings` | `load` `get` `getAll` `set` `flush` |
| `power` | `setWakeLock` `startForegroundService` `stopForegroundService` `getBatteryOptimizationStatus` `requestIgnoreBatteryOptimization` |
| `lifecycle` | `isInForeground` `getEnv` + `onBackground` `onForeground` `onTrimMemory` `onBeforeTerminate` |
| `audio` | `setEngine` `getEngine` `getCapabilities` `requestFocus` `abandonFocus` `onFocusChange` `nativePlay` `nativePause` `nativeSeek` `nativeSetVolume` `nativeStop`（`native*` 当前一律 `EUNSUPPORTED`，见 PDR-008） |
| `mediaSession` | `setMetadata` `setPlaybackState` `setPosition` `setActions` `onControl` `updateLyricLine` `snapshot` |
| `notification` | `updateLyric`（单参对象 `{lyricLine,lyricNext,lyricEnabled}`）`showToast` `showMessageBox` `clear`。**故意没有 `postMedia`/`updateMedia`** —— 通知栏本体由 PlaybackService 从 MediaSession 状态渲染，JS 侧靠 `mediaSession.setMetadata/setPlaybackState/setPosition/setActions` 驱动 |
| `theme` | `getSystemIsDark` `onSystemThemeChanged` |
| `clipboard` | `getText` `setText` |
| `intent` | `openUrl` `shareFile` `openDocument` `saveDocument` `openAppSettings` |
| `tar` | `pack` `unpack`（**2 参，无 opts**） |

### 3.4 入口

```kotlin
// JS 侧（只注入到主 frame 的这两个方法）
AndroidBridge.postMessage(token: String, frameJson: String)
AndroidBridge.ping(): String          // 返回 "anylisten-bridge/1"，JS 侧用来解析协议版本
```

回程由 Kotlin 主动调（主线程）：

```js
window.__anylisten_bridge_recv__(frameJson)   // 名字是硬约定，改了收不到任何响应
```

`token` 从首帧注入的 `window.__ANYLISTEN_TOKEN__` 取（JS 侧空 token 会显式抛 `EACCES`，
所以"桥静默不响应"通常意味着 token 注入环节漏了）。同时注入结构化的
`window.__anylisten_android__ = { version, token, origin }` 供调试与后续扩展。

> **Web Worker 拿不到 `@JavascriptInterface`**（Android WebView 硬限制）。
> 固定路径：`Worker --MessagePort--> UI 主线程(PortsHub) --AndroidBridge--> Kotlin`。
> `PortsHub` 用 `eventRoutes`（请求 eventName）与 `callbackRoutes`（回调名）两张表把帧精确路由回
> 对应 Worker，**不做广播** —— 帧在整条链路上始终是同一个 JSON 字符串，转发时零重编码。

### 3.5 本地 HTTP 服务（`LocalHttpServer`）

| 路由 | 说明 |
|------|------|
| `/` `/<path>` | SPA 静态资源；找不到且无扩展名时回退 `index.html`（history 路由） |
| `/__health` | 探活 |
| `/stream/<id>` | 音频流。**必须支持 HTTP Range**：`bytes=start-end` / `start-` / `-suffix`，命中返 `206` + `Content-Range`，越界返 `416`；否则音频拖动进度条会整段重下 |
| `/p_url/<...>` | 按 URL 代理（音源请求），比 `<audio>` 直连更可控 |
| `/p_static/<...>` | 按名称代理（已注册的代理目标）；`cacheEnabled` 为真时写 `files/cache/proxy`，缓存命中直接流式返回并支持 Range |
| `/proxyUrlToken` | 下发 `p_urlkey` cookie，后续 `/p_url/*` 靠它鉴权 |

- 端口**固定 17930**、只绑 `127.0.0.1`。**不要改成随机端口** —— origin 一变，`localStorage`/`IndexedDB`/`OPFS` 全部丢失（D2 升级路径依赖固定 origin）。
- 鉴权三种载体都支持：`?t=<token>`、请求头 `x-anylisten-token`、cookie `altk`。
- HTML 响应会被注入 `window.__ANYLISTEN_TOKEN__`、`window.__ANYLISTEN_BRIDGE_ORIGIN__` 与 `window.__anylisten_android__={version,token,origin}`，前端据此初始化桥。

---

## 4. 权限与 Manifest

| 权限 | 用途 |
|------|------|
| `INTERNET` / `ACCESS_NETWORK_STATE` | 音源请求、代理、流式播放 |
| `MANAGE_EXTERNAL_STORAGE` | 音乐目录扫描（API 30+ 主路径） |
| `READ_EXTERNAL_STORAGE`(maxSdk 32) / `WRITE_EXTERNAL_STORAGE`(maxSdk 29) | 老系统兜底 |
| `READ_MEDIA_AUDIO` | 媒体库查询 |
| `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_MEDIA_PLAYBACK` | 后台播放 |
| `WAKE_LOCK` | 熄屏续播 |
| `POST_NOTIFICATIONS` | 通知栏播放控制（API 33+ 需运行时申请） |
| `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | 引导用户加白，减少被杀 |
| `BLUETOOTH_CONNECT` | 蓝牙耳机按键/元数据 |

`MainActivity` 的 `configChanges` 覆盖 `orientation|screenSize|smallestScreenSize|screenLayout|keyboard|keyboardHidden|navigation|uiMode|density|fontScale|locale|layoutDirection`，`launchMode=singleTask` —— 旋转/切输入法不重建 Activity，避免 WebView 重新加载导致播放中断。

`PlaybackService` 声明 `foregroundServiceType="mediaPlayback"`，并注册 `MEDIA_BUTTON` intent-filter + `androidx.media.session.MediaButtonReceiver`。

### 启动图标

启动图标沿用上游桌面版 `source/packages/desktop/resources/icons/icon.png`，不是另画的新素材。`AndroidManifest.xml` 接入 `@mipmap/ic_launcher` 与 `@mipmap/ic_launcher_round`；`mipmap-anydpi-v26` 使用 adaptive icon，背景取原图蓝色 `#4F62D0`，前景是提取出的白色波形，并提供 `monochrome` 供 Android 13+ 主题图标使用。`mipmap-mdpi`–`mipmap-xxxhdpi` 保留原图缩放后的 PNG，供非 adaptive 路径兜底。

### 明文流量策略（`network_security_config`，已收口）

**不再使用全局 `usesCleartextTraffic="true"`**，改由 `res/xml/network_security_config.xml` 控制：

| 域 | 明文 | 原因 |
|----|------|------|
| `127.0.0.1` / `localhost` | 允许 | 本地回环服务（SPA + `/stream` + 代理），且 `AudioWorklet` / `createMediaElementSource` 要求 secure context —— `file://` 与 `asset://` 都不满足，只有 localhost 算安全上下文 |
| `Online Metadata 0.4.8` 的 34 个精确主机 | 允许 | 内置酷我 / 网易 / 酷狗 / QQ 音乐 / 咪咕的搜索、歌词、封面、歌单与评论仍硬编码为 http；逐域名放行，全部 `includeSubdomains="false"`，没有通配符 |
| 其他全部 | **禁止** | 在线音源/插件源/封面默认必须 https；`http://example.com/` 实测仍被拒绝 |

⚠️ **这条策略对 OkHttp 同样生效**（`NetworkSecurityPolicy` 在连接前检查），所以"原生代发 http 请求"也会被拦，不是只影响 WebView。`/p_url` 代理对 http 源站一样会失败。

需要 http 音源时两条路：

1. **（推荐）加具体域名**：在 `network_security_config.xml` 的 `<domain-config cleartextTrafficPermitted="true">` 里写域名，**不要 includeSubdomains、不要通配**；
2. **临时排查**：`./gradlew :app:assembleDebug -PallowCleartext=true`，会通过 `manifestPlaceholders` 切到
   `network_security_config_loose.xml`（全放行）。这条路径只用于自己机器上验证，别当成默认交付形态。

两种 XML 同时存在于 `res/xml/`，由 `build.gradle.kts` 的 `manifestPlaceholders["networkSecurityConfig"]` 选一个 ——
不是覆盖同名资源，所以不会出现「两份都在包里」的歧义。

---

## 5. WebView 的三个硬性约束（改动前务必看）

这三条是上游前端行为决定的，不是随手写的：

1. **禁用缩放** —— `setSupportZoom(false)` + `builtInZoomControls=false` + `displayZoomControls=false` + `setTextZoom(100)`。
   `textZoom` 尤其关键：系统字体放大设置会让 WebView 缩放文本，导致虚拟列表行高计算错位、滚动条跳。
2. **不拦截长按** —— 不设 `setOnLongClickListener`、不把 `isLongClickable` 设成 `false`。上游有 34 处 `contextmenu` 监听（歌词、歌曲列表的右键菜单），拦了长按就等于把这 34 处全废掉。
3. **返回键走 JS 的 `canGoBack()`** —— 前端路由有自己的一层历史栈，`WebView.canGoBack()` 经常不准。
   Kotlin 侧缓存 JS 推来的 `__anylisten_canGoBack__`，`onPageFinished` 时主动探一次；缺失时才退化为 `webView.canGoBack()`。**不要在 `onBackPressed` 里同步 `evaluateJavascript`**（异步回调来不及），2 秒内二次返回才退出 App。

另外：`mediaPlaybackRequiresUserGesture=false` 必须开，否则自动连播被拦；`shouldOverrideUrlLoading` 只放行 `127.0.0.1`，其余交给 `IntentPort.openUrl` 出门。

---

## 6. 已实现 / 未实现

**已实现**

- 4 模块 Gradle 工程，`assembleDebug` 通过，干净构建 APK 17 MB
- message2call v2 全帧编解码 + 双向回调 + `$b64` 二进制
- `fs.*` 全量（含分批 `listTree`、`writeFileAtomic`、`watch`、`toPlayableUrl`、`FsEntry.displayPath`）
- 应用数据目录与桌面版同构：`<dataPath>/{app,cache,temp}`，设置落 `app/config.json`，**启动清空 `temp`**（`StorageLayout.kt`）
- 本地 HTTP：SPA 静态 + `/stream` Range + `/p_url` + `/p_static` + token/cookie
- `http`（OkHttp，含取消、大响应落盘、下载进度）
- `settings`（debounce + 原子写 + 损坏自愈）、`log`（分级 + 滚动 + 清理）
- `mediaSession` + `notification`（歌词行折叠进通知 title / subText）
- `power`（WakeLock + 电池优化）、`lifecycle`、`intent`、`clipboard`、`theme`、`tar`
- 前台播放服务 + AudioFocus + MediaStyle 通知 + 媒体按键
- 权限引导：`POST_NOTIFICATIONS`、`MANAGE_EXTERNAL_STORAGE`（三级 Intent 兜底）、API 29 legacy 存储
- 崩溃日志落 `filesDir/logs/crash-<ts>.log`

**未实现（有意为之，非漏项）**

| 项 | 原因 |
|----|------|
| `:native-audio`（ExoPlayer / Oboe / 音效链） | PDR-008 决定 Phase 4 只冻结 `AudioEngineRouter` 接口，音频仍走 Web Audio（`WebOnlyAudioEngineRouter`）。`getCapabilities()` 已按前端要求返回 `pitchShifter=false`、`playbackRateRange=[0.5,2.0]`、`supportsPreservesPitch=true`、`convolverIrLoadable=false` |
| 悬浮窗 / 桌面歌词 | PDR-006 改判取消，`SYSTEM_ALERT_WINDOW` 相关检测与跳转全部不做，`desktopLyric.*` 44 项不迁移 |
| 多 ABI | 只打 `arm64-v8a`。无原生 so 时本可省，但 `abiFilters` 先定死方便后续加 native lib |
| JS 侧全部内容（`sql.js`、worker 重写、`node:vm` 替代等） | 属 fullstack 侧职责 |

---

## 7. 已知限制

1. **无真机验证**。开发环境没有连接设备（`adb devices` 为空），APK 只验证了 `assembleDebug` 通过、assets 层级与体积，**未在真机/模拟器上跑过首屏与播放链路**。首次装机后要重点看：流媒体 Range 拖动、后台播放存活、通知栏按钮、外置存储授权。
2. **媒体栈选 `MediaSessionCompat` 而非 Media3**。Media3 `MediaSession` 必须绑定 `Player`，用 `SimpleBasePlayer` 伪装时单 item playlist 会导致通知栏「上一首/下一首」按钮不出现；而实际播放器是 Web Audio，没有 ExoPlayer 实例可绑。`MediaSessionCompat` 可以只声明 actions 不绑 player，正好匹配本架构。
3. **`saveDocument` 已改成原生自写闭合，但仍有一个分支要调用方配合**。
   `DocumentPicker.saveDocument(suggestName, mime, source: SaveSource?)` 现在接收 `Bytes(ByteArray)` 或 `File(path)`，
   Kotlin 侧在 `ACTION_CREATE_DOCUMENT` 返回后自己 `openOutputStream(uri)` 写完再返回
   `PickedDocument(path = uri.toString(), name, written = true)` —— 调用方拿到 `written == true` 就完事。
   **唯一例外**：`source == null` 时退回旧的私有 exports 目录，返回 `written = false`，
   表示"文件已放到那里但没写内容"。导出/备份功能接进来时必须传 `source`，否则会拿到 `written=false`。
4. **SAF 遍历尚未实现**，当前 `MANAGE_EXTERNAL_STORAGE` 拿到的是真实路径，SAF 只是兜底。
   因此 **`/saf/<treeId>/...` 形式的虚拟路径不会出现**，`FsEntry.displayPath` 在有真实可读路径时与 `path` 同值
   （`MANAGE_EXTERNAL_STORAGE` 模式下两者相等是预期行为，不是 bug），JS 侧 `displayPath ?? path` 兜底即可。
   虚拟路径要等下一批次（DocumentFile 遍历比 File 遍历慢一个量级，需单独设计分批）。
5. **`cachePath` 故意指向 `filesDir/cache` 而不是 `context.cacheDir`**（架构决策，已确认保留）。
   系统能在存储紧张时清 `cacheDir`，而上游把 cache 当"应用自己管的缓存"——封面、在线歌曲缓存，
   **以及 `dbService/backupTask` 的数据库备份**。放 `cacheDir` 等于随时可能莫名丢备份，所以宁可占 `filesDir` 配额。
   要改的话得先让上游把"可丢弃"与"不可丢弃"的缓存分两个目录。
   `tempPath` 语义上是纯可丢弃（下载中转、解压临时），后续批次会改成 `context.cacheDir`；
   现在放 `filesDir/temp` 只是白占配额，配合每次进程启动的 `StorageLayout.clearTemp()` 无正确性风险。
6. **`SafPathResolver` 只支持 primary 卷，非 primary 卷返回可识别错误码**。
   `tree/primary:Music` 能还原成 `/storage/emulated/0/Music`；SD 卡/U 盘的 `tree/1A2B-3C4D:xxx` 无法从 tree Uri 反解真实路径，
   此时 `pickDirectory` 不再返回裸 `null`，而是抛
   `PortException(code = EUNSUPPORTED, message = "...目前只能扫描内部存储...请改选「内部存储」下的目录，或先复制到本机。", detail = "UNSUPPORTED_VOLUME:<volumeId>")`。
   JS 侧可据 `detail` 前缀区分「用户取消」（返回 `null`）与「卷不支持」（抛错）。
7. **`porting/js/dist` 曾随构建次数膨胀 —— JS 侧已根治**。`scripts/clean.mjs` 已进 `build` 链（`build:all` 天然带上），
   连跑三次产物字节级一致。原生侧的 `-PcleanJsDist=true` 保留为兜底，平常不用传。
   附带教训：`syncWebAssets` 把 `dist` 根**拍平**拷贝，JS 侧曾把旧产物改名成 `dist/spa.old.<ts>`，
   26 MB 垃圾进了 APK。现已按 `**/*.old.*`、`.trash/**` 挡住，并在构建日志里告警 `dist` 根的异常条目（见 §2）。
8. **APK 里有约 4 MB 的 worker 重复 chunk**。`vite` 的每个 Web Worker 都是独立 rollup 构建，主图与 worker 图会各自 emit 一份内容相同的共享 chunk（`core-*`/`index-*`/各 parser）。Vite 正常行为，要瘦身得 JS 侧做「同内容去重 + 引用改写」；原生侧不改 hash 引用（改了必然 404）。
9. **`backgroundAudio` 能力标记为 `"unverified"`**。后台音频能否在目标机型上稳定存活（厂商省电策略差异大）没实测，不敢先写 `true` 让前端乐观分支。
10. **`listTree` 大目录性能未压测**。已按「原生递归 + 500 条一批 + 逐批可取消」实现（1 万首歌不再 2 万次往返），但真实曲库规模下的耗时与内存占用尚无基准数据。
11. **明文流量按扩展实际域名精确放行**。`usesCleartextTraffic="true"` 已删除，默认只放行
    `127.0.0.1` / `localhost` 和 `Online Metadata 0.4.8` 实际使用的 34 个主机名；其余域名一律禁明文
    （含 OkHttp 请求）。这 34 项全部在 `app/src/main/res/xml/network_security_config.xml` 里逐条列出，
    没有通配符、没有 `includeSubdomains`，也没有兜底开关。扩展升级后要重新核对端点；临时排查可用
    `-PallowCleartext=true` 切到 `_loose.xml`（全放行，**不要进发布包**）。详见 §4。
12. **构建脚本的 `logger` 消息一律用英文**。Windows 控制台默认 GBK，中文日志在 `--console=plain` 下会变成 `������`，排障时反而看不出问题。源码注释与文档仍用中文。
13. **原生构建不能与 `pnpm build:all` 并发**。`syncWebAssets` 是 `Sync` 语义，会把 `assets/web/spa` 对齐到**当前** `dist`；
    JS 侧 `clean:spa` 刚删完目录时构建，就会把占位 SPA 写进 assets，得到「体积小得可疑」的白屏包（实测 release 988 KB）。
    装机前一律带 `-PrequireWeb=true`，或先确认 `porting/js/dist/spa` 存在（见 §2「不要和 pnpm build:all 并发构建」）。
14. **release 包（10.2 MB）尚未在真机验证过 R8**。`proguard-rules.pro` 已保留 `AndroidBridge` 全量成员、`@JavascriptInterface` 与
    `com.anylisten.ports.**`，理论上桥不会被裁；但首次装机仍建议先用 debug 包确认链路，再试 release 包。
15. **静态资源访问日志默认关闭**。`-PhttpAccessLog=true` 构建时 `LocalHttpServer` 会为每个命中的静态资源打一行
    `I/AnyListen/Http: 200 GET /wasm/sql-wasm.wasm 685235B 12ms`，用于确认某个文件到底有没有被请求
    （默认构建只在 404 时打 `asset not found`，成功请求完全无日志 —— 所以「日志里没有 wasm 请求」推不出「没请求过」）。
    **红线**：只记 `path`（已去掉 query），绝不记原始 URI / `Cookie` / `x-anylisten-token` ——
    页面是 `/?t=<token>` 加载的，打原串等于把 token 写进 logcat。交付包永远走默认（关）。

---

## 8. 排错

| 症状 | 原因 / 处理 |
|------|-------------|
| `Your project path contains non-ASCII characters` | `gradle.properties` 缺 `android.overridePathCheck=true` |
| `Test of distribution url ... failed` / 下载 Gradle 卡住 | Wrapper 需要访问 `services.gradle.org`。国内可先用腾讯镜像生成：`./gradlew wrapper --gradle-distribution-url https://mirrors.cloud.tencent.com/gradle/gradle-8.14.3-bin.zip`，之后改回官方 URL 也能命中缓存 |
| `Connect to 127.0.0.1:xxxxx failed: Connection refused` | `~/.gradle/gradle.properties` 里残留 `systemProp.http(s).proxyHost/Port` 指向已失效的代理。删掉这几行（本工程走阿里云镜像直连） |
| `Entry index.html is a duplicate ...` | `syncWebAssets` 的 `duplicatesStrategy` 被改掉了，应为 `DuplicatesStrategy.INCLUDE` |
| APK 里出现 `assets/web/spa/spa/...` | `Sync` 的 `into()` 叠加了 `dist` 根。必须分两个 `from`：`from(dist/spa)` 与 `from(dist){ exclude("spa/**") }` |
| 前端白屏但 APK 能装 | 先看 `assets/web/spa/index.html` 是否存在；再看 logcat 里 `LocalHttpServer` 是否 17930 绑定成功、token 是否注入 |
| 装机停在 `Loading...`，日志 `core worker 崩溃 undefined undefined` | **产物代次错配**：`main.js` 引用的 worker 不在包里（`new Worker()` 404 时 `event.message` 是 `undefined`，所以日志不会说 404）。现在 `syncWebAssets` 的引用一致性校验会直接让构建失败并列出缺失文件；重新 `pnpm -C porting/js build:all` 跑完再打包（见 §2） |
| APK 只有 1 MB 左右 | 打的是占位 SPA 包：`dist/spa` 在构建时不存在。用 `-PrequireWeb=true` 重新构建 |
| APK 比预期大好几 MB | `porting/js/dist` 里堆了历史产物，加 `-PcleanJsDist=true` 重建。构建日志里那行 `duplicate artifact groups` 会告诉你冗余多少 |
| `Unable to delete directory ... New files were found` | 不要在 `Exec` 任务的 `doFirst` 里 `delete()` dist（会和文件监听/并行任务抢句柄）。本工程用独立的 `cleanJsDist` Delete 任务 + `dependsOn` |
| 构建日志里中文变 `������` | Windows 控制台 GBK 与 Gradle 的 UTF-8 输出不匹配。构建脚本的 `logger` 消息统一用英文（见 §7.12），不影响功能 |
| 长按没反应 | 检查是否有人加了 `setOnLongClickListener` 或把 `isLongClickable` 设成 `false`（见 §5） |
| 首屏停在 `Loading...`，日志里**没有** `[ipc] webview client connected` | `core` 的 `initModules()` 里有 init reject，`connectClient()` 因此永远执行不到 → UI 收不到 `connected`、`settingEvent.inited()` 不发、`appAeady` 一直 false（就是 `<Loading/>`）。**这是刻意的顺序**：`connected` 出现 = 11 个 init 全过。去 logcat 搜 `Uncaught (in promise)` 找第一条 reject |
| 首屏停在 `Loading...`，但 `connected` 在 | UI→core 方向的帧被吞了（ERR-002/ERR-003 系列）：`connectClient()` 内部的 `socket.onMessage` 装配是异步的，`port.start()` 会立刻派发已排队的帧。现在靠 `pending` 缓冲 + `new_socket` 后置监听兜底，正常会打 `[ipc] 补投 N 帧（到达时间早于 onMessage 装配）`。**N 恒为 1 是正常值** —— UI 的请求只能在 `onConnected` 之后发出，队列里最多只有 msg2call 的握手那一发；N 变大才说明有别的代码在 connected 之前就往端口里写过东西 |
| 页面起来了但完全没主题色（`--color-*` 全是空/默认），`dom_style.innerText` 是 `":root {}"` | `setTheme()` 收到的是空对象 = `getThemeSetting()` 读到了初始化前的空壳（`themeState` 初值 `{id:'',name:'',isDark:false,colors:{}}`）。根因是 `connectClient()` 早于 `initModules()`；已修（`host/bootstrap.ts` 把 `connectClient()` 移到 `initModules()` 之后）。**注意 `--color-primary-light-1000` 在浅色主题（如 `blue2`）里本来就等于白色，不能用它当「主题是否生效」的判据**；看 `dom_style` 长度（≈13 KB / 242 个 `--color-*`）或 `getThemeSetting().id` 是否非空 |
| 日志 `Error: Data path is not set` | `playTimeStore` 的 `initPlayTimeStore(dataPath)` 没被调用（它挂在 `initPlayer(dbService, dataPath)` 里）。**严重后果**：抛之前已置 `initState = 1`，之后 `savePlayTime` 会命中 `if (initState == 1) return`，整个会话的播放时长不再落盘且不报错 |
| 想把真机 WebView 内部状态挖出来（不改一行业务代码） | 用 `scripts/cdp-probe.mjs` / `scripts/cdp-frames.mjs`。步骤：`adb -s <serial> forward tcp:9333 localabstract:webview_devtools_remote_<pid>` → `curl -s 127.0.0.1:9333/json/list` 拿页面 `webSocketDebuggerUrl` → `node scripts/cdp-frames.mjs <ws-url>`。`cdp-frames` 会在 `Page.addScriptToEvaluateOnNewDocument` 里包一层 `MessagePort`，reload 后按 callId 把 UI→core 请求与 core→UI 响应**配对**，逐个点名 `getAppInfo/getSetting/getThemeSetting/...` 有没有回帧、`err` 是否 null —— 比单纯数 `out:/in:` 有用得多。只读：不注入持久脚本、不改业务逻辑 |
