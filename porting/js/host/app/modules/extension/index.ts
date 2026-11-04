/**
 * 覆写 `web-server/src/app/modules/extension/index.ts`。
 *
 * ## 唯一动机：上游第 40 行用了 Node 的 `__dirname`
 *
 * ```ts
 * preloadScript: (await readFile(joinPath(__dirname, 'extension-preload.js'))).toString(),
 * ```
 *
 * Web Worker 里没有 `__dirname`，所以 `core.worker` 在 **启动阶段**就抛
 * `ReferenceError: __dirname is not defined`，`bootstrap` 走不完，UI 永远停在 `Loading...`。
 * 真机日志只有一行：
 *
 * ```
 * E/AnyListen/webview: [core.worker] 启动失败 Error: __dirname is not defined
 * ```
 *
 * ## 为什么不能"造一个假 `__dirname`"了事
 *
 * 就算给 `__dirname` 一个值（`shims/globals.ts` 里确实有兜底），
 * `joinPath('', 'extension-preload.js')` 也只能得到相对路径 `extension-preload.js`，
 * 而 worker 里的相对路径基准在构建后是**不可靠**的（产物是 `assets/core.worker-<hash>.js`，
 * 相对基准变成 `assets/`，而 preload 在 `extension-preload/`）。所以必须换绝对 URL。
 *
 * ## 新做法：走 LocalHttpServer 的静态目录
 *
 * `extension-preload.js` 由 Gradle 的 `syncWebAssets` 拷到 `assets/web/spa/extension-preload/`，
 * 而 `LocalHttpServer` 的静态根就是 `assets/web/spa`，所以 `fetch('/extension-preload/extension-preload.js')`
 * 直接命中。以 `/` 开头 → 在 worker 里按 `self.location` 解析成
 * `http://127.0.0.1:17930/extension-preload/extension-preload.js`，与 worker 在哪个目录无关。
 *
 * native 已确认：**静态资源不校验 token**（只有 `/stream/` `/p_url/` `/p_static/` 校验），
 * 所以这个 `fetch` 不需要带凭据。
 *
 * ## 为什么不把整个文件抄一遍
 *
 * 这个模块有 60 多个导出，绝大多数是 `workers.extensionService.*` 的薄转发。
 * 全抄一遍就等于把上游的转发层复制粘贴，以后上游加一个导出我们就漂了。
 * 所以：
 * - `export * from '@porting-uplink/web-server/app/modules/extension'` —— 其余全部沿用上游；
 * - 只本地重写 `initExtension` / `restartExtensionHost` 两个函数
 *   （它们各自调用模块内的私有 `setupExtension`，所以没法只替换 `setupExtension`）。
 *
 * `@porting-uplink/...` 是 `vite.config.mjs` 的 `RAW_TARGETS` 里的**绕过覆写**别名，
 * 直指上游原文件 —— 否则这里 `export *` 会指回自己，形成自引用。
 *
 * ## 回归门禁
 *
 * `pnpm smoke` 会断言 `dist/spa/assets/core.worker-*.js` 里**不再出现 `__dirname`**。
 * 这条一旦变红，说明这个覆写失效了（或上游又新加了一处），必须回来修。
 */

import { commandEvent } from '@any-listen/app/modules/command/event'
import { extensionEvent, extensionState, initExtensionModule } from '@any-listen/app/modules/extension'
import { musicListEvent } from '@any-listen/app/modules/musicList'
import { workers } from '@any-listen/app/modules/worker'
import { DEFAULT_LANG, EXTENSION, STORE_NAMES } from '@any-listen/common/constants'
import { checkAndCreateDir, joinPath } from '@any-listen/nodejs'

import { appEvent, appState } from '@/app/app'
import { playerEvent } from '@/app/modules/player'
import { startExtensionServiceWorker } from '@/app/worker'
import { extensionLog } from '@/shared/log4js'

// 其余全部导出沿用上游（`extensionEvent` / `extensionState` / 各 install*/start*/get* 转发）
export * from '@porting-uplink/web-server/app/modules/extension'

/**
 * preload 的绝对路径。**不要**改成相对路径，也不要改成从 `fs` 读 —— 见文件头注释。
 */
const EXTENSION_PRELOAD_URL = '/extension-preload/extension-preload.js'

const handleExtensionLog = (info: AnyListen.Extension.LogInfo) => {
  switch (info.type) {
    case 'info':
      extensionLog.info(`[${info.id}] ${info.message}`)
      break
    case 'warn':
      extensionLog.warn(`[${info.id}] ${info.message}`)
      break
    case 'error':
      extensionLog.error(`[${info.id}] ${info.message}`)
      break
    case 'debug':
      extensionLog.debug(`[${info.id}] ${info.message}`)
      break
  }
}

/**
 * 取 preload 源码。失败要**抛出**而不是返回空串 —— 空 preload 会让扩展沙箱里
 * 拿不到 `anylisten` 宿主对象，扩展全部静默失效，比启动失败更难排查。
 */
const loadPreloadScript = async (): Promise<string> => {
  let res: Response
  try {
    res = await fetch(EXTENSION_PRELOAD_URL)
  } catch (err) {
    throw new Error(`[extension] preload 请求失败：${EXTENSION_PRELOAD_URL}（${String(err)}）`)
  }
  if (!res.ok) {
    throw new Error(`[extension] preload 加载失败：HTTP ${res.status} ${EXTENSION_PRELOAD_URL}`)
  }
  const text = await res.text()
  if (!text) {
    throw new Error(`[extension] preload 内容为空：${EXTENSION_PRELOAD_URL}`)
  }
  return text
}

const setupExtension = async () => {
  await workers.extensionService.setExtensionState({
    locale: appState.appSetting['common.langId'] ?? DEFAULT_LANG,
    'proxy.host': appState.proxy.host,
    'proxy.port': appState.proxy.port,
    clientType: 'web',
    configFilePath: joinPath(extensionState.extensionDir, EXTENSION.configFileName),
    extensionDir: joinPath(extensionState.extensionDir, EXTENSION.extDirName),
    tempDir: joinPath(extensionState.extensionDir, EXTENSION.tempDirName),
    dataDir: joinPath(extensionState.extensionDir, EXTENSION.dataDirName),
    // ← 唯一与上游不同的地方
    preloadScript: await loadPreloadScript(),
    onlineExtensionHost: appState.appSetting['extension.onlineExtensionHost'],
    gHMirrorHosts: global.anylisten.config['extension.ghMirrorHosts'].join('\n'),
    enableDebug: appState.appSetting['common.enableDebug'],
  })
  await initExtensionModule()
  await workers.extensionService.loadLocalExtensions()
  await workers.extensionService.startExtensions()
  extensionEvent.setup(workers.extensionService)
}

export const initExtension = async () => {
  extensionState.extensionDir = joinPath(appState.dataPath, STORE_NAMES.EXTENSION)
  await checkAndCreateDir(extensionState.extensionDir)
  await setupExtension()

  extensionEvent.on('extensionEvent', (event) => {
    switch (event.action) {
      case 'logOutput':
        handleExtensionLog(event.data)
        break

      default:
        break
    }
  })
  appEvent.on('updated_config', (keys, setting) => {
    if (keys.includes('extension.onlineExtensionHost')) {
      try {
        void workers.extensionService.updateOnlineExtensionListHost(setting['extension.onlineExtensionHost']!)
      } catch {}
    }
    if (keys.includes('common.enableDebug')) {
      try {
        void workers.extensionService.updateEnableDebug(setting['common.enableDebug']!)
      } catch {}
    }
  })
  appEvent.on('locale_change', (locale) => {
    try {
      void workers.extensionService.updateLocale(locale)
    } catch {}
  })
  appEvent.on('proxy_changed', (host, port) => {
    try {
      void workers.extensionService.updateProxy(host, port)
    } catch {}
  })
  playerEvent.on('playerEvent', (event) => {
    try {
      void workers.extensionService.playerEvent(event)
    } catch {}
  })
  playerEvent.on('playListAction', async (action) => {
    try {
      void workers.extensionService.playListAction(action)
    } catch {}
  })
  playerEvent.on('playHistoryListAction', async (action) => {
    try {
      void workers.extensionService.playHistoryListAction(action)
    } catch {}
  })
  musicListEvent.on('listAction', async (action) => {
    try {
      void workers.extensionService.musicListAction(action)
    } catch {}
  })

  commandEvent.register('extensionCommand', async (command, ...args) => {
    return workers.extensionService.executeCommand(command, args)
  })
}

/**
 * 重启串行化 —— 修「连点两次重启」时**第一个 Promise 永不 settle**（ERR-011）。
 *
 * ## 现象（实测）
 *
 * 连续调用两次（UI 上就是连点）：
 * - `restart#1` 152 ms 返回、`restart#2` 165 ms 返回 —— **串行**时都正常；
 * - 两次**并发**发起（`const a=restart(); const b=restart()`）→ 两个 Promise 等 12 s 仍不结束，
 *   而扩展列表本身仍可读（宿主没死）。也就是「宿主活着，调用方永远卡在 waiting」。
 *
 * ## 根因（上游 `shared/app/modules/worker/worker.ts:37-52` 的隐含前提）
 *
 * ```ts
 * let oldService = extensionService
 * extensionService = createExtensionServiceWorker(onWorkerInited, exposedFuncs)  // 新实例 S1
 * extensionService.worker.on('exit', () => { extensionService?.worker.removeAllListeners(); extensionService = null })
 * if (oldService) { oldService.worker.removeAllListeners(); await oldService.worker.terminate() }
 * ```
 *
 * 这段代码假设「同一时刻只有一个 restart 在进行」。两个 restart 并发时，第二次的
 * `oldService` 拿到的不是「上一个已跑热的老 worker」，而是**第一次刚 spawn、还没发出 `inited`
 * 的 S1**，于是第二次同步地把 S1 `terminate()` 掉 →
 * S1 永远没有机会回 `inited` → 第一次调用的 `resolve` 永不执行（`web-server` 侧
 * `startExtensionServiceWorker(exposedFuncs)` 是 `new Promise(resolve => _start(..., resolve))`）。
 *
 * 注意与 ERR-010 区分：ERR-010 是**复用同一条 MessagePort** 导致第二次转移 `DataCloneError`，
 * 已在 `host/worker/index.ts` 的 `spawn()` 里改成每次 `new MessageChannel()`，那一条不再复现
 * （实测两次重启均无 `DataCloneError`）。这里是**调用时序**问题，与通道无关。
 *
 * ## 关于「旧 exit 回调把新实例清空」
 *
 * 该路径在本移植层**不可复现**，理由：`WorkerHandle.terminate()` 是**同步**触发 exit 回调的，
 * 而上游在 `terminate()` 之前先 `oldService.worker.removeAllListeners()`，被清掉的正是那个
 * 会写 `extensionService = null` 的闭包；`removeAllListeners()` 清的就是 `terminate()` 要遍历
 * 的那个 Set，因此旧回调没有执行窗口（实测连续重启后 `getExtensionList()` 一直可读，
 * 从未出现 `Extension host not available`）。上游 Node 版存在「worker 自行 crash 的 exit
 * 恰好插在 `extensionService = S1` 赋值之后、`removeAllListeners()` 之前」的窄窗口，
 * 但 `WorkerHandle` 只有 `terminate()` 一个 exit 来源，没有该窗口。
 *
 * ## 修法（本文件，最小改动）
 *
 * 把 restart 排成一条链：后来的请求等前一个**完整**结束（spawn + setupExtension）再开始。
 * 这样第二次的 `oldService` 一定是已经 inited 的实例，`terminate()` 掉的也不再是"尚未就绪"的
 * 新 worker。链上任何一次失败都不会断链（`catch` 吞掉后继续），失败仍会原样抛给调用方。
 */
let restartChain: Promise<void> = Promise.resolve()

export const restartExtensionHost = (): Promise<void> => {
  const run = restartChain.then(async () => {
    await startExtensionServiceWorker()
    await setupExtension()
  })
  // 链本身不能因为某次失败而卡死；错误通过 `run` 抛给本次调用方
  restartChain = run.catch(() => {})
  return run
}
