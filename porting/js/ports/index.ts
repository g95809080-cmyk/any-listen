/**
 * 统一 Port 获取入口 —— JS 侧对 Kotlin `:core-ports` 的**唯一**门面。
 *
 * ## 命名与参数必须与 Kotlin 逐字对齐
 * 调用名直接映射成帧里的 `pathname`：`'fs.readFile'` → `['fs','readFile']`，
 * Kotlin 侧 `path[0]` 选模块、其余 join 成方法名。**没有映射表**，
 * 所以改名必须在 `ports/types.ts`、本文件、`FsModule.kt`/`PortModules.kt`/`MediaModules.kt`
 * 三处同时改，否则会得到 `EUNSUPPORTED: bridge module not found` 或 `... is not implemented`。
 *
 * ## 双向回调
 * 流式接口（`listTree`/`watch`/`downloadTo`）与订阅接口（`lifecycle.on*`/`audio.onFocusChange`/
 * `theme.onSystemThemeChanged`/`mediaSession.onControl`）都是「JS 传函数实参」，
 * 由 `BridgeClient` 换成 `func_<n>_<rand>` 名字，Kotlin 之后用 `[2,cbName,args]` 反推。
 * 一次性回调（扫描批次、下载进度）在请求结束时会自动释放；订阅类必须 `keepCallbacks: true`。
 *
 * ## 同步签名 vs 异步实现
 * `MediaSessionPort` / `NotificationPort` / `LogPort` 的上游调用点是同步的
 * （`navigator.mediaSession.metadata = ...`、`log4js` 包装器），但桥只能异步。
 * 因此这类方法一律**发出即忘**，失败只记日志，绝不向调用方抛异常 —— 否则会打断
 * 上游 `mediaSessionInfo.ts` / 播放循环的同步路径。
 */

import {
  BridgeClient,
  installBridgeReceiver,
  pingNative,
  sendToNative,
  BRIDGE_PING_PREFIX,
  BRIDGE_PROTOCOL_VERSION,
  type CallHandle,
} from '@porting/ports/bridge-client'
import {
  PortError,
  type AudioCapabilities,
  type AudioPort,
  type ClipboardPort,
  type FileSystemPort,
  type FsEntry,
  type FsEnv,
  type FsStat,
  type FsWatchEvent,
  type HttpPort,
  type HttpRequestOptions,
  type HttpResponse,
  type IntentPort,
  type LifecyclePort,
  type LogPort,
  type MediaSessionAction,
  type MediaSessionPort,
  type NotificationPort,
  type PowerPort,
  type TarPort,
  type ThemePort,
} from '@porting/ports/types'

export * from '@porting/ports/types'
export * from '@porting/ports/m2c-frame'
export {
  BridgeClient,
  installBridgeReceiver,
  sendToNative,
  pingNative,
  BRIDGE_PING_PREFIX,
  BRIDGE_PROTOCOL_VERSION,
  type CallHandle,
}

/* ------------------------------------------------------------------ *
 * 客户端持有
 * ------------------------------------------------------------------ */

let client: BridgeClient | null = null

export function setBridgeClient(next: BridgeClient): void {
  client = next
}

export function hasBridgeClient(): boolean {
  return client != null
}

/**
 * 发起一次 Port 调用。
 *
 * 桥未就绪时返回**已 reject 的 Promise**（而不是同步抛）：
 * 大量调用点是 `void callPort(...).catch(...)` 形态，同步抛会让 `.catch` 来不及挂上去。
 */
export function callPort<T = unknown>(
  path: string | readonly string[],
  args: readonly unknown[] = [],
  options: { timeoutMs?: number; keepCallbacks?: boolean; handle?: CallHandle } = {}
): Promise<T> {
  if (!client) {
    return Promise.reject(new PortError('EUNSUPPORTED', 'ports bridge is not initialized'))
  }
  return client.call<T>(path, args, options)
}

/** 同步签名端口用：发出即忘，失败只记日志 */
function fireAndForget(path: string, args: readonly unknown[] = []): void {
  void callPort(path, args).catch((err: unknown) => {
    console.error(`[ports] ${path} failed`, err)
  })
}

/* ------------------------------------------------------------------ *
 * FileSystemPort
 * ------------------------------------------------------------------ */

function createFileSystemPort(): FileSystemPort {
  /** watch 的 id → 释放句柄（`unwatch` 时释放回调注册） */
  const watchHandles = new Map<string, CallHandle>()

  return {
    // 契约：listTree(root, opts, onBatch) -> { total, canceled, id }
    // onBatch 是回调实参，不能塞 subId（native 的 args[0] 是 root）
    listTree(root, opts, onBatch) {
      return callPort('fs.listTree', [root, opts, onBatch], { timeoutMs: 0 })
    },
    cancelScan(id) {
      return callPort('fs.cancelScan', [id])
    },
    stat(path) {
      return callPort<FsStat | null>('fs.stat', [path])
    },
    exists(path) {
      return callPort<boolean>('fs.exists', [path])
    },
    readFile(path, range) {
      return callPort<Uint8Array>('fs.readFile', range ? [path, range] : [path], { timeoutMs: 0 })
    },
    writeFile(path, data) {
      return callPort('fs.writeFile', [path, data])
    },
    writeFileAtomic(path, data) {
      return callPort('fs.writeFileAtomic', [path, data])
    },
    appendFile(path, text) {
      return callPort('fs.appendFile', [path, text])
    },
    mkdirp(path) {
      return callPort('fs.mkdirp', [path])
    },
    remove(path, recursive) {
      return callPort('fs.remove', [path, recursive ?? true])
    },
    rename(from, to) {
      return callPort<boolean>('fs.rename', [from, to])
    },
    copy(from, to) {
      return callPort('fs.copy', [from, to])
    },
    readdir(path) {
      return callPort<FsEntry[]>('fs.readdir', [path])
    },
    realpath(path) {
      return callPort<string>('fs.realpath', [path])
    },
    // 契约：watch(root, opts, onEvent, onReady, onError) -> string(id)
    // 三个回调是**订阅**，必须保留到 unwatch
    async watch(root, opts, onEvent, onReady, onError) {
      const handle: CallHandle = { release: () => undefined }
      const id = await callPort<string>('fs.watch', [root, opts, onEvent, onReady, onError], {
        keepCallbacks: true,
        handle,
      })
      watchHandles.set(id, handle)
      return id
    },
    unwatch(id) {
      watchHandles.get(id)?.release()
      watchHandles.delete(id)
      return callPort('fs.unwatch', [id])
    },
    toPlayableUrl(path) {
      return callPort<string | null>('fs.toPlayableUrl', [path])
    },
    revokePlayableUrl(url) {
      return callPort('fs.revokePlayableUrl', [url])
    },
    pickDirectory(title) {
      return callPort<{ path: string; displayName: string } | null>('fs.pickDirectory', [title ?? ''])
    },
    getEnv() {
      return callPort<FsEnv>('fs.getEnv', [])
    },
    getFreeSpace(path) {
      return callPort<number>('fs.getFreeSpace', [path])
    },
  }
}

/* ------------------------------------------------------------------ *
 * HttpPort
 * ------------------------------------------------------------------ */

function createHttpPort(): HttpPort {
  return {
    request(url, opts) {
      return callPort<HttpResponse>('http.request', [url, normalizeRequestOptions(opts)], {
        timeoutMs: 0,
      })
    },
    // 契约：downloadTo(url, destPath, opts, onProgress) -> { filePath, size, sha256 }
    downloadTo(url, destPath, opts) {
      const { onProgress, ...rest } = opts
      return callPort('http.downloadTo', [url, destPath, rest, onProgress], { timeoutMs: 0 })
    },
    cancel(id) {
      return callPort('http.cancel', [id])
    },
    setProxy(proxy) {
      return callPort('http.setProxy', [proxy])
    },
    registerProxyTarget(name, url, headers, cacheEnabled = false) {
      return callPort('http.registerProxyTarget', [name, url, headers, cacheEnabled])
    },
    unregisterProxyTarget(name) {
      return callPort('http.unregisterProxyTarget', [name])
    },
  }
}

/**
 * 上游 `request` 的 `body` 允许是 `string | Uint8Array`，Kotlin 侧按
 * `opts["body"] as? ByteArray` 取二进制、按 `bodyFilePath` 取文件。
 * 这里把 `Uint8Array` 的 body 显式留在原字段（编码层会转成 `$b64` 信封），
 * 对象/数组类 body 由调用方自己序列化 —— 与上游 `request.ts` 的行为一致。
 */
function normalizeRequestOptions(opts: HttpRequestOptions): Record<string, unknown> {
  const out: Record<string, unknown> = { ...opts }
  // `signal` 在 Kotlin 侧是 `signalId: String`（用于 `http.cancel`），不是 AbortSignal 实例
  if (out.signal != null && typeof out.signal !== 'string') delete out.signal
  return out
}

/* ------------------------------------------------------------------ *
 * 简单 Port：方法名与参数一一对应，用 Proxy 直接映射到 `<port>.<method>`
 * ------------------------------------------------------------------ */

function createProxyPort<T extends object>(prefix: string): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined
      return (...args: unknown[]) => callPort(`${prefix}.${prop}`, args)
    },
  })
}

const fsPort = createFileSystemPort()
const httpPort = createHttpPort()
const tarPort = createProxyPort<TarPort>('tar')
const intentPort = createProxyPort<IntentPort>('intent')
const clipboardPort = createProxyPort<ClipboardPort>('clipboard')
const powerPort = createProxyPort<PowerPort>('power')

/* ------------------------------------------------------------------ *
 * LogPort（同步签名，发出即忘）
 * ------------------------------------------------------------------ */

const logPort: LogPort = {
  write(level, tag, message) {
    fireAndForget('log.write', [level, tag, message])
  },
  readLastLines(filePath, lines) {
    return callPort<string[]>('log.readLastLines', [filePath, lines])
  },
  openLogFolder() {
    return callPort('log.openLogFolder', [])
  },
}

/* ------------------------------------------------------------------ *
 * LifecyclePort（订阅 + 本地前后台缓存）
 * ------------------------------------------------------------------ */

function createLifecyclePort(): LifecyclePort {
  let foreground = true
  let subscribed = false

  function ensureSubscribed(): void {
    if (subscribed) return
    subscribed = true
    // 4 个订阅一次性登记；失败只告警（例如桥未注入的浏览器调试场景）
    void callPort('lifecycle.onBackground', [() => {
      foreground = false
    }], { keepCallbacks: true }).catch(logSubscribeError('lifecycle.onBackground'))
    void callPort('lifecycle.onForeground', [() => {
      foreground = true
    }], { keepCallbacks: true }).catch(logSubscribeError('lifecycle.onForeground'))
    void callPort('lifecycle.onTrimMemory', [
      (level: unknown) => {
        console.info(`[lifecycle] onTrimMemory level=${String(level)}`)
      },
    ], { keepCallbacks: true }).catch(logSubscribeError('lifecycle.onTrimMemory'))
    void callPort('lifecycle.onBeforeTerminate', [() => {
      console.info('[lifecycle] onBeforeTerminate')
    }], { keepCallbacks: true }).catch(logSubscribeError('lifecycle.onBeforeTerminate'))
  }

  return {
    onBackground(cb) {
      ensureSubscribed()
      void callPort('lifecycle.onBackground', [cb], { keepCallbacks: true }).catch(
        logSubscribeError('lifecycle.onBackground')
      )
    },
    onForeground(cb) {
      ensureSubscribed()
      void callPort('lifecycle.onForeground', [cb], { keepCallbacks: true }).catch(
        logSubscribeError('lifecycle.onForeground')
      )
    },
    onTrimMemory(cb) {
      void callPort('lifecycle.onTrimMemory', [cb], { keepCallbacks: true }).catch(
        logSubscribeError('lifecycle.onTrimMemory')
      )
    },
    onBeforeTerminate(cb) {
      void callPort('lifecycle.onBeforeTerminate', [cb], { keepCallbacks: true }).catch(
        logSubscribeError('lifecycle.onBeforeTerminate')
      )
    },
    acknowledgeTermination(id, source) {
      return callPort('lifecycle.acknowledgeTermination', [id, source])
    },
    isInForeground() {
      // 本地缓存：Kotlin 侧的 `lifecycle.isInForeground()` 是异步的，而上游调用点是同步的
      ensureSubscribed()
      return foreground
    },
  }
}

const lifecyclePort = createLifecyclePort()

/* ------------------------------------------------------------------ *
 * ThemePort
 * ------------------------------------------------------------------ */

const themePort: ThemePort = {
  getSystemIsDark() {
    return callPort<boolean>('theme.getSystemIsDark', [])
  },
  onSystemThemeChanged(cb) {
    void callPort('theme.onSystemThemeChanged', [cb], { keepCallbacks: true }).catch(
      logSubscribeError('theme.onSystemThemeChanged')
    )
  },
  setSystemBarAppearance(darkIcons) {
    return callPort('theme.setSystemBarAppearance', [darkIcons])
  },
}

/* ------------------------------------------------------------------ *
 * NotificationPort（同步签名，发出即忘）
 * ------------------------------------------------------------------ */

const notificationPort: NotificationPort = {
  updateLyric(line) {
    // MVP 单行歌词：`lyricNext` 字段预留，Kotlin 侧收 null 就不展示第二行
    fireAndForget('notification.updateLyric', [
      {
        lyricLine: line.lyricLine ?? null,
        lyricNext: line.lyricNext ?? null,
        lyricEnabled: line.lyricEnabled ?? true,
      },
    ])
  },
  clear() {
    fireAndForget('notification.clear')
  },
  showToast(message) {
    fireAndForget('notification.showToast', [message])
  },
  showMessageBox(key, message, options) {
    return callPort<number>('notification.showMessageBox', [
      key,
      message,
      { type: options?.type ?? 'info', modal: options?.modal ?? true },
    ])
  },
}

/* ------------------------------------------------------------------ *
 * AudioPort
 * ------------------------------------------------------------------ */

const audioPort: AudioPort = {
  nativePlay(url, opts) {
    return callPort('audio.nativePlay', [url, opts])
  },
  nativePause() {
    return callPort('audio.nativePause', [])
  },
  nativeSeek(ms) {
    return callPort('audio.nativeSeek', [ms])
  },
  nativeSetVolume(volume) {
    return callPort('audio.nativeSetVolume', [volume])
  },
  nativeStop() {
    return callPort('audio.nativeStop', [])
  },
  requestFocus() {
    return callPort('audio.requestFocus', [])
  },
  abandonFocus() {
    return callPort('audio.abandonFocus', [])
  },
  onFocusChange(cb) {
    void callPort('audio.onFocusChange', [cb], { keepCallbacks: true }).catch(
      logSubscribeError('audio.onFocusChange')
    )
  },
  setEngine(engine) {
    return callPort('audio.setEngine', [engine])
  },
  getEngine() {
    return callPort<'web' | 'native'>('audio.getEngine', [])
  },
  getCapabilities() {
    return callPort<AudioCapabilities>('audio.getCapabilities', [])
  },
}

/* ------------------------------------------------------------------ *
 * MediaSessionPort（同步签名，发出即忘）
 * ------------------------------------------------------------------ */

const mediaSessionPort: MediaSessionPort = {
  setMetadata(metadata) {
    fireAndForget('mediaSession.setMetadata', [metadata])
  },
  setPlaybackState(state) {
    fireAndForget('mediaSession.setPlaybackState', [state])
  },
  setPosition(position) {
    fireAndForget('mediaSession.setPosition', [position])
  },
  setActions(actions) {
    fireAndForget('mediaSession.setActions', [actions])
  },
  onControl(cb) {
    // 契约：onControl(callback(action, value?))；seekto 的 value 是**毫秒**
    void callPort('mediaSession.onControl', [cb], { keepCallbacks: true }).catch(
      logSubscribeError('mediaSession.onControl')
    )
  },
  updateLyricLine(line) {
    fireAndForget('mediaSession.updateLyricLine', [line])
  },
  snapshot() {
    return callPort('mediaSession.snapshot', [])
  },
}

/* ------------------------------------------------------------------ *
 * 统一导出
 * ------------------------------------------------------------------ */

export const ports = {
  get fs(): FileSystemPort {
    return fsPort
  },
  get http(): HttpPort {
    return httpPort
  },
  get tar(): TarPort {
    return tarPort
  },
  get intent(): IntentPort {
    return intentPort
  },
  get clipboard(): ClipboardPort {
    return clipboardPort
  },
  get power(): PowerPort {
    return powerPort
  },
  get log(): LogPort {
    return logPort
  },
  get lifecycle(): LifecyclePort {
    return lifecyclePort
  },
  get theme(): ThemePort {
    return themePort
  },
  get notification(): NotificationPort {
    return notificationPort
  },
  get audio(): AudioPort {
    return audioPort
  },
  get mediaSession(): MediaSessionPort {
    return mediaSessionPort
  },
}

/** 供 `MEDIA_SESSION_ACTIONS` 之类的常量引用，避免各文件重复写字符串字面量 */
export const ALL_MEDIA_SESSION_ACTIONS: readonly MediaSessionAction[] = [
  'play',
  'pause',
  'stop',
  'seekbackward',
  'seekforward',
  'seekto',
  'previoustrack',
  'nexttrack',
]

function logSubscribeError(channel: string): (err: unknown) => void {
  return (err: unknown) => {
    console.error(`[ports] subscribe ${channel} failed`, err)
  }
}

/** 类型再导出，方便 `import type { FsEntry } from '@porting/ports'` */
export type {
  AudioCapabilities,
  AudioPort,
  ClipboardPort,
  FileSystemPort,
  FsEntry,
  FsEnv,
  FsStat,
  FsWatchEvent,
  HttpPort,
  HttpResponse,
  IntentPort,
  LifecyclePort,
  LogPort,
  MediaSessionAction,
  MediaSessionPort,
  NotificationPort,
  PowerPort,
  TarPort,
  ThemePort,
}
