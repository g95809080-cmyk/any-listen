/**
 * core-worker 的启动流程（AndroidShell 的「主进程等价物」）。
 *
 * 顺序不能变：
 * 1. `getEnv()`            —— 数据目录、外部存储根、OS 版本
 * 2. `preloadDir(dataPath/app)` —— 把 config.json / data.json 等预载进同步缓存
 *                                （我们的 Store 是「内存同步 + 异步落盘」，未预载 = 读到空设置）
 * 3. `initAppEnv()`        —— deviceId + 设置 + 事件联动
 * 4. `await initServerIPC()` —— rendererEvent 的 IPC 注册表就绪（**必须 await**，见 ERR-002）
 * 5. worker 工厂 + 3 个子 worker
 * 6. `initModules()`       —— 各业务模块（**必须在接入 UI 之前**，见 ERR-003）
 * 7. `connectClient(port)` —— 接入 WebView 虚拟客户端
 * 8. `sendInitedEvent()`
 */

import { createCache } from '@any-listen/common/cache'
import { formatExtensionGHMirrorHosts } from '@any-listen/common/tools'

import { BridgeClient, ports, setBridgeClient } from '@porting/ports'
import { flushAll as flushSyncFiles, preloadDir } from '@porting/nodejs/SafeFS'

import { initAppEnv, appState, sendInitedEvent } from '@/app/app'
import { i18n, initI18n } from '@/app/i18n'
import { appEvent } from '@/app/app'
import { initModules } from '@/app/modules'
import { exposedFuncs } from '@/app/modules/extension/exposeFuncs'
import { startCommonWorkers, startExtensionServiceWorker } from '@/app/worker'
import defaultConfig from '@/shared/defaultConfig'
import { appLog } from '@/shared/log4js'

import { initServerIPC, connectClient } from '@porting/host/ipc/server'
import { configureWorkerFactory } from '@porting/host/worker/index'

declare global {
  // eslint-disable-next-line no-var
  var anylisten: {
    dataPath: string
    config: typeof defaultConfig
    publicStaticPaths: ReturnType<typeof createCache<string>>
  }
}

export interface BootstrapOptions {
  /** 与 UI 主线程的 message2call 通道（core 侧） */
  ipcPort: MessagePort
  /** core 自己的 Ports 通道（core 侧） */
  portsChannel: MessagePort
  /** 子 worker 脚本 URL（主线程用 `new URL(...).href` 算好） */
  workerScripts: { db: string; util: string; extension: string }
  /**
   * 子 worker Ports 通道的**控制通道**（不是通道本身）。
   *
   * core 每次 `spawn()` 自己新建一对 `MessageChannel`，把 worker 端转给子 worker、
   * 把 UI 端经这条控制通道转给主线程 hub。早期是主线程一次性建好三条再转交，
   * 但 `MessagePort` 只能转移一次 —— 重启扩展宿主时第二次转移直接抛 `DataCloneError`，
   * 之后宿主永久不可用（ERR-010）。
   */
  workerPortsControl: MessagePort
}

/**
 * 在 core-worker 里接上 Ports 通道。
 * 与 `host/worker/expose.ts` 里的实现同构，但 core 不需要 message2call 的 expose 语义。
 */
function attachPortsChannel(portsChannel: MessagePort): void {
  portsChannel.start()
  const client = new BridgeClient((frameJson) => {
    portsChannel.postMessage(frameJson)
  })
  portsChannel.addEventListener('message', (event: MessageEvent) => {
    if (typeof event.data !== 'string') {
      console.error('[bootstrap] Ports 通道只接受 JSON 字符串帧，收到:', typeof event.data)
      return
    }
    client.handleFrame(event.data)
  })
  setBridgeClient(client)
}

function installGlobalAnyListen(dataPath: string): void {
  const config = { ...defaultConfig }
  config['extension.ghMirrorHosts'] = formatExtensionGHMirrorHosts(['https://cdn.jsdelivr.net', 'https://fastly.jsdelivr.net'])
  globalThis.anylisten = {
    dataPath,
    config,
    publicStaticPaths: createCache<string>({ max: 1000, ttl: 1000 * 60 * 60 * 24 * 2, updateAgeOnGet: true }),
  }
}

export async function bootstrapCoreWorker(options: BootstrapOptions): Promise<void> {
  // 必须最先：后面所有模块都可能用到 ports.*
  attachPortsChannel(options.portsChannel)

  const env = await appStateEnv()
  const dataPath = env.dataPath

  installGlobalAnyListen(dataPath)
  await preloadDir(`${dataPath}/app`)

  await initAppEnv()
  initI18n()
  appLog.info(`[bootstrap] dataPath=${dataPath}, externalRoot=${env.externalRoot ?? 'none'}`)

  // 必须 await：`initServerIPC()` 内部是动态 import，且 `socketEvent.emit` 走 setImmediate
  // 异步派发。不 await 就 connectClient → new_socket 派发时 rendererEvent 的监听器还不存在
  // → `socket.onMessage` 永远 undefined → UI 发出的帧全部被静默丢弃（ERR-002）。
  await initServerIPC()

  configureWorkerFactory({
    scripts: options.workerScripts,
    workerPortsControl: options.workerPortsControl,
  })

  appEvent.on('updated_config', (keys) => {
    if (keys.includes('common.langId')) i18n.setLanguage(appState.appSetting['common.langId'])
  })

  await startCommonWorkers(appState.dataPath)
  await startExtensionServiceWorker()
  await initModules()

  // **接入 UI 必须在 `initModules()` 之后**（ERR-003）。
  // UI 主线程与 core 并行启动，一连上就 fire `getSetting` / `getThemeSetting` /
  // `getPlayInfo` / `getHotKey` / …；若此刻模块还没 init 完，它们读到的是**初始化前**状态：
  // - `getThemeSetting` 返回 `themeState` 的初值 `{id:'',name:'',isDark:false,colors:{}}`
  //   → UI 调 `setTheme({})` → `:root {}` → 一个 `--color-*` 都写不进去（整站无主题色）；
  // - `getPlayInfo` 走 `initPlayInfo()` → `getPlayTime()`，而 `initPlayerModule()` 还没跑
  //   → 抛 `Data path is not set`，并把 `playTimeStore` 的 `initState` 永久毒化成 1
  //   （此后 `savePlayTime` 命中 `if (initState == 1) return`，播放时长再也不会落盘）。
  // 桌面版的 IPC 服务本来就在模块 init 之后才起，这里只是把次序对齐。
  // `connectClient()` 内部对「接入前已到达的帧」有缓冲补投，不会丢帧。
  connectClient({ port: options.ipcPort })

  sendInitedEvent()
  appLog.info('[bootstrap] core worker ready')
}

/** 提前拿 env（`initAppEnv` 内部还会再取一次，成本可忽略） */
async function appStateEnv(): Promise<Awaited<ReturnType<typeof import('../ports').ports.fs.getEnv>>> {
  const { ports } = await import('../ports')
  return ports.fs.getEnv()
}

export function createCoreWorkerBridgeClient(send: (frameJson: string) => void): BridgeClient {
  const client = new BridgeClient(send)
  setBridgeClient(client)
  return client
}

/** 生命周期：后台/退出前强制刷设置文件与 SQLite（SQLite 由 db-worker 自己订阅） */
export function registerCoreLifecycleFlush(): void {
  void import('../ports').then(({ ports }) => {
    ports.lifecycle.onBackground(() => {
      void flushSyncFiles().catch((error: unknown) => console.error('[lifecycle] background flush failed', error))
    })
    ports.lifecycle.onTrimMemory(() => {
      void flushSyncFiles().catch((error: unknown) => console.error('[lifecycle] memory flush failed', error))
    })
    ports.lifecycle.onBeforeTerminate((id) => {
      void flushSyncFiles()
        .then(() => ports.lifecycle.acknowledgeTermination(id, 'core'))
        .catch((error: unknown) => console.error('[lifecycle] termination flush failed', error))
    })
  })
}
