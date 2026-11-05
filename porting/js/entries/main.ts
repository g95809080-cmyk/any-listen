/**
 * UI 主线程入口。
 *
 * 职责（严格按 arch §6.2 的 entries 说明）：
 * 1. **Ports 代理**：创建 `PortsHub`，把 4 条 Ports 通道登记进 hub，
 *    并挂 `window.__anylisten_bridge_recv__`（Kotlin 的**唯一**回帧入口）让原生能打进帧。
 * 2. **IPC 注入**：实现 `window.__anylisten_ipc_init__`
 *    —— `view-main/src/shared/ipc/ipc.ts` 是**唯一**读取点，签名见
 *    `AnyListen.IPC.ConnectIPCSrivice`：`{ clientCall, onConnected, onDisconnected, onFailed, onLogout, pwd }`。
 * 3. **AudioEngineRouter 外壳**：音频必须在 UI 线程（AudioWorklet / MediaSession / AudioFocus 同帧）。
 * 4. **`navigator.mediaSession` 替身**：转发到 `MediaSessionPort`，
 *    让上游 `mediaSessionInfo.ts` 零改动复用（arch D-01 冻结结论）。
 *
 * 关于 `import.meta.url`：**只有本文件**用它来算 4 个 worker 的脚本地址，
 * 再以字符串下发给 core-worker。worker 内部一律不拼路径（构建后基准会变）。
 */

// **必须第一条**：router 的 `loc` 初始值在模块求值时就算定，归一化晚一步就白改。
// 详见 `ui/boot/route.ts` 的头注释（空 hash → `$location === '/'` → tab 全不高亮 + 后退链污染）。
import '../ui/boot/route'
// 返回键契约：必须在 route 之后 —— route 的 `replaceState` 会把首帧 hash 归一成 `#/library`，
// 晚于它挂载才能把归一后的地址当作栈底（见 ui/boot/androidBack.ts）。
import '../ui/boot/androidBack'
// 底部弹层的触屏关闭契约（D-22）：上游只靠 `onmouseleave` 关闭，触屏没有这条路径。
// 这里在 document 上 capture 阶段挂 `pointerdown`，按**几何位置**判定"点了弹层外面"并派发
// `mouseleave`。必须在 UI 挂载前装配，否则首个弹层的第一次点按永远落在监听之前。
// 与 androidBack 共用 `findOpenPopup()`，避免两处判据漂移（见 ui/boot/popupDismiss.ts）。
import '../ui/boot/popupDismiss'
// 安全区注入钩子：越早装配越好，原生可能在任何时刻推 insets（见 ui/boot/insets.ts）
import '../ui/boot/insets'
import '../shims/globals'
// 必须在任何播放器代码之前求值：补 `HTMLMediaElement.setSinkId`（WebView < 110 缺失）
import '../shims/media-sinkid'

// —— 样式与 UI 必须在业务模块之前求值：`@ui/app.less` 定义主题变量，`./ui/mobile.less` 覆盖它。
// 顺序颠倒会让 mobile.less 的变量引用在定义前求值（less 编译期报错 / 运行期变量为空）。
import 'virtual:svg-icons-register'
import '@ui/app.less'
import '../ui/mobile.less'

import { mount } from 'svelte'
import { createMessage2Call, type ReadObj } from 'message2call'

import { initNotify, showNotify } from '@ui/components/apis/notify'
import { connectIPC, registerModules } from '@ui/modules'
import { initWorkers } from '@ui/worker'

import MobileApp from '../ui/MobileApp.svelte'
import { tm } from '../ui/i18n'
import { withIpcCallbacks } from '../ui/ipc/callback-client'
import { installPlaybackErrorNotify } from '../ui/player/errorNotice'

// 3 个子 worker 用 `?worker&url`：让 vite 把它们**各自打成独立的 worker chunk**，
// 只把 URL 交给 core-worker。不能写成 `new URL('./x.ts', import.meta.url)` 再取 `.href`
// —— 那个形式 vite 会当成静态资源直接拷源文件（产物是未编译的 .ts，浏览器无法执行）。
import dbWorkerUrl from './db.worker.ts?worker&url'
import extWorkerUrl from './ext.worker.ts?worker&url'
import utilWorkerUrl from './util.worker.ts?worker&url'

import { PortsHub } from '@porting/host/ipc/ports-hub'
import { installMediaSessionShim } from '@porting/host/mediasession-shim'
import { createAudioEngineRouter } from '@porting/host/audio/engine-router'
import {
  BRIDGE_PROTOCOL_VERSION,
  installBridgeReceiver,
  pingNative,
  ports,
  setBridgeClient,
  type MediaSessionAction,
} from '@porting/ports'

import type { BootstrapMessage } from './bootstrap-message'

/* ------------------------------------------------------------------ *
 * 1. Ports
 * ------------------------------------------------------------------ */

const portsHub = new PortsHub()
// 主线程自己也要能调原生（mediaSession / 音频 / 生命周期）
setBridgeClient(portsHub.client)

/** Kotlin → JS 的单一入口（`evaluateJavascript` 调用，名字是硬约定） */
installBridgeReceiver((frameJson: string): void => {
  portsHub.handleNativeFrame(frameJson)
})

// 探活 + 版本对齐。不匹配只告警不阻断：帧格式错了会在第一次调用时报错，比这里拦下更好定位
const pong = pingNative()
if (!pong) {
  console.warn('[main] 未检测到 AndroidBridge：当前不在 Android 壳里（纯浏览器调试模式）')
} else if (pong.version !== BRIDGE_PROTOCOL_VERSION) {
  console.error(`[main] 桥协议版本不一致：native=${pong.raw} js=${BRIDGE_PROTOCOL_VERSION}`)
} else {
  console.info(`[main] 桥已就绪（${pong.raw}），origin=${window.__ANYLISTEN_BRIDGE_ORIGIN__ ?? 'n/a'}`)
}

/**
 * 供调试面板 / 主线程手工调用。不是公开 API —— 主线程自己的原生调用一律走 `ports.*`。
 */
Object.defineProperty(window, '__anylisten_ports_bridge__', {
  value: {
    call: (path: string | string[], args: unknown[] = []) => portsHub.client.call(path, args),
    ping: pingNative,
  },
  configurable: true,
  writable: false,
})

/* ------------------------------------------------------------------ *
 * 2. MediaSession 替身 + 音频外壳
 * ------------------------------------------------------------------ */

const mediaSessionShim = installMediaSessionShim()
const audioEngine = createAudioEngineRouter()

/*
 * Kotlin → JS 的系统媒体控制（通知栏按钮 / 锁屏 / 蓝牙耳机键）。
 * `seekto` 的 `value` 是**毫秒**（Kotlin `onSeekTo(pos: Long)`），
 * 而 `MediaSessionActionDetails.seekTime` 是秒 —— 必须在这里换算，
 * 否则拖进度条会跳到 1000 倍位置。
 */
ports.mediaSession.onControl((action, value) => {
  const details = action === 'seekto' && typeof value === 'number' ? { seekTime: value / 1000 } : undefined
  mediaSessionShim.dispatch(action as MediaSessionAction, details)
})

mediaSessionShim.setActionHandler('play', () => {
  // 失败也要把状态改回去 —— 走 shim 而不是直接调 port，
  // 这样 `setPlaybackState` 之后还会补一次 `setActions`，通知栏按钮不会卡在 "playing"。
  void audioEngine.play().catch(() => {
    mediaSessionShim.playbackState = 'paused'
  })
})
mediaSessionShim.setActionHandler('pause', () => audioEngine.pause())
mediaSessionShim.setActionHandler('stop', () => audioEngine.pause())
mediaSessionShim.setActionHandler('seekto', (details) => {
  // `MediaSessionActionDetails` 的字段全是可选的，非 seekto 动作时 seekTime 为 undefined
  const seekTime = details?.seekTime
  if (typeof seekTime === 'number') audioEngine.seek(seekTime)
})

/* ------------------------------------------------------------------ *
 * 3. 启动 core-worker
 * ------------------------------------------------------------------ */

/**
 * core-worker 必须用 vite 能识别的**字面量**形式创建
 * （`new Worker(new URL('./x.ts', import.meta.url), { type: 'module' })`），
 * 它才会被当作 worker entry 编译；换成变量传参会退化成"拷贝源文件"。
 */
const coreWorker = new Worker(new URL('./core.worker.ts', import.meta.url), {
  type: 'module',
  name: 'anylisten-core',
})

/** UI ⇄ core 的业务 IPC 通道 */
const ipcChannel = new MessageChannel()
/** core 自己的 Ports 通道 */
const corePortsChannel = new MessageChannel()
/**
 * 子 worker 的 Ports 通道**按次创建**，不能再像早期那样一次性建好三条再转交给 core。
 *
 * 为什么（ERR-010）：`MessagePort` 只能被 `postMessage` 转移**一次**，转移后原对象即失效。
 * 而 `restartExtensionHost()` 会重新 `startExtensionServiceWorker()` → 再次 `spawn()` →
 * 再次转移同一条通道 → 抛 `DataCloneError`，之后扩展宿主永远起不来（按钮点一次就废）。
 *
 * 现在的分工：core 每次 `spawn()` 自己 `new MessageChannel()`，port1 转给子 worker，
 * port2 通过这条控制通道转给主线程 hub。控制通道本身常驻，只传「新通道的 UI 端」，不重复转移。
 */
const workerPortsControl = new MessageChannel()
workerPortsControl.port1.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type?: string } | null
  const port = event.ports[0]
  if (data?.type !== 'workerPortsChannel' || !port) {
    console.error('[main] 控制通道收到非法消息', data, event.ports.length)
    return
  }
  portsHub.registerPort(port)
})
workerPortsControl.port1.start()

portsHub.registerPort(corePortsChannel.port1)

const bootstrapMessage: BootstrapMessage = {
  type: 'bootstrap',
  scripts: {
    db: dbWorkerUrl,
    util: utilWorkerUrl,
    extension: extWorkerUrl,
  },
}

coreWorker.postMessage(bootstrapMessage, [
  ipcChannel.port2,
  corePortsChannel.port2,
  workerPortsControl.port2,
])

coreWorker.addEventListener('error', (event: ErrorEvent) => {
  console.error('[main] core worker 崩溃', event.message, event.error)
})
coreWorker.addEventListener('messageerror', (event: MessageEvent) => {
  console.error('[main] core worker messageerror', event.data)
})

/* ------------------------------------------------------------------ *
 * 4. `window.__anylisten_ipc_init__`
 * ------------------------------------------------------------------ */

/**
 * 与 `view-main/src/shared/ipc/ipc.ts` 的约定：
 *  - 传入 `clientCall`（UI 侧可被服务端调用的函数集）—— core 侧作为 msg2call 的 exposeObj
 *  - 返回 `onConnected(serverIPCProxy)` —— UI 侧拿到的服务端代理
 *  - `pwd` 在单机版无意义（无鉴权），保留参数以兼容签名
 */
window.__anylisten_ipc_init__ = (options: {
  onConnected: (ipc: unknown) => void
  onDisconnected: () => void
  onFailed: (message: string) => void
  onLogout: () => void
  pwd: string
  clientCall: Record<string, unknown>
}): void => {
  try {
    const msg2call = createMessage2Call({
      exposeObj: options.clientCall as unknown as ReadObj,
      isSendErrorStack: true,
      timeout: 0,
      sendMessage(data) {
        ipcChannel.port1.postMessage(data)
      },
    })

    ipcChannel.port1.addEventListener('message', (event: MessageEvent) => {
      msg2call.message(event.data as never)
    })
    ipcChannel.port1.start()

    coreWorker.addEventListener('error', () => {
      options.onDisconnected()
    })

    // 单机版没有登录态：`onLogout` 永不触发，仅保留签名
    void options.pwd
    void options.onLogout
    void options.onFailed

    options.onConnected(withIpcCallbacks(msg2call.remote as unknown as AnyListen.IPC.ServerIPC))
  } catch (err) {
    options.onFailed(err instanceof Error ? err.message : String(err))
  }
}

/* ------------------------------------------------------------------ *
 * 5. 挂载 UI
 * ------------------------------------------------------------------ */

/**
 * 与上游 `view-main/src/main.ts` 的差异：
 * - **不调 `initIpcDesktopLyric()`** —— PDR-006 已取消桌面歌词（悬浮窗不做）；
 * - **不调 `initTooltips()`** —— hover 提示在触摸设备上没有意义，只留 `initNotify()`（Toast 要用）。
 *
 * ⚠️ 但 **`initWorkers()` 必须调**（踩过，见下）。上游有**两套完全不同的 worker**：
 * 1. `view-main/src/worker/*` —— **渲染进程内**的列表计算 worker（排序 / 去重 / 搜索匹配），
 *    由 `initWorkers()` 创建，`workers.main` 是它的 msg2call 代理；
 * 2. `entries/core.worker.ts` —— 本移植层的 AndroidShell worker，由本文件上面的 PortsHub 装配。
 *
 * 早期把两者当成"同一套、会重复启动"而跳过了 `initWorkers()`，后果是
 * `workers.main` 永远是 `undefined` —— `ListSortModal` / `DuplicateMusicModal` /
 * `SearchList` / `Header/SearchInput` 这些组件一调用 `workers.main.xxx` 就
 * `Cannot read properties of undefined`。构建产物里也能看到症状：`main.worker-<hash>.js`
 * 被 emit 出来却没有任何 chunk 引用它（`createWorkers` 被 tree-shaken 掉了，只剩 emitFile 的副作用）。
 *
 * `pnpm smoke` 有一条断言盯着"每个 worker chunk 都必须被某个产物引用"，就为了抓这类事。
 */
const root = document.getElementById('root')
if (!root) {
  console.error('[main] 找不到 #root 挂载点，index.html 与入口不匹配')
} else {
  // 必须在 mount 之前：视图组件在首次求值时就会读 `workers.main`
  void initWorkers()

  mount(MobileApp, { target: root })
  window.__anylisten_app_started__ = true
  console.info('[main] MobileApp 已挂载（mobile 壳：AppBar + Router + MiniPlayer + TabBar）')

  // UI 侧模块注册与 IPC 接线：必须在 mount 之后，组件求值时依赖这些单例已就绪
  initNotify()
  installPlaybackErrorNotify()
  registerModules()
  try {
    connectIPC()
  } catch (err) {
    console.error('[main] connectIPC 失败（IPC 不通，凡走 @/shared/ipc 的功能都会退化）', err)
  }

  // 曲库初始化：上游只有 `components/layout/Aside/MyList/List.svelte:30` 的 `{#await getAllList()}`
  // 会调 `getUserLists()`，而它是**唯一**能走到 `store/commit.ts:43 setUserListInited(true)` 的路径。
  // 移动壳不渲染 `AppShell`（没有 Aside）→ `userListInited` 恒 false →
  //   · `views/Library/index.svelte:146` 的 `$effect` 在 `if (!$userListInited) return` 直接退出，hash 永远为空；
  //   · 同文件 `:157` 只有 `{#if listInfo}`、**没有 else 分支**，`listInfo` 是 undefined
  //     → 内容区**一个节点都不渲染**（表现为纯白，且控制台不报任何错）。
  // 必须放在 `connectIPC()` 之后：`getUserLists()` 要走 IPC 拿歌单。
  void import('@ui/modules/musicLibrary/store/actions')
    .then(({ getUserLists }) => getUserLists())
    .catch((err: unknown) => {
      console.error('[main] 曲库初始化失败（Library 将空白且无提示）', err)
    })

  installGlobalRejectionNotify()
}

/**
 * 上游有些 Promise reject 没有 catch 点，最典型的是 `getMusicUrl()`
 * 在「歌曲绑定的设备与当前机器不一致」时抛 `MusicDeviceMismatchError`
 * （见 `host/app/modules/music/local.ts`）。播放器那条链在 core-worker 里，
 * 不 catch 就是 unhandled rejection —— 用户看到的是"点了没反应"。
 *
 * 这里兜一层全局提示：只对**已知的可解释错误**弹 toast，其余仍然交给控制台，
 * 避免把所有未处理异常都变成噪音（尤其是 WebView 里各种第三方脚本的 rejection）。
 */
function installGlobalRejectionNotify(): void {
  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    const reason: unknown = event.reason
    const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : ''
    if (!message) return
    if (message.includes('MUSIC_DEVICE_MISMATCH')) {
      showNotify(tm('mobile__music_device_mismatch'), 4)
      console.warn('[main] 已拦截 MUSIC_DEVICE_MISMATCH 并提示用户', reason)
      return
    }
    console.error('[main] unhandled rejection', reason)
  })
}
