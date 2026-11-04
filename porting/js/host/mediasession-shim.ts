/**
 * `navigator.mediaSession` 替身（Phase 2 §9.1 冻结方案）。
 *
 * Android WebView 的 `navigator.mediaSession` 对象存在，但**不会**向系统
 * `MediaSessionManager` 注册（无媒体通知、无锁屏控件、无耳机键联动）。
 * 因此由 Kotlin 的 MediaSession 持有系统会话，这里只做双向转发：
 * - JS → Kotlin：metadata / playbackState / positionState / 已注册的 action 集合
 * - Kotlin → JS：`window.__anylisten_media_session_shim__._dispatch(action, details)`
 *
 * 这样 `view-main/src/modules/player/init/mediaSessionInfo.ts`（200 行，8 个 handler）**零改动**。
 *
 * ⚠️ 前提假设：`Object.defineProperty(navigator, 'mediaSession', ...)` 在目标 WebView 上可覆盖。
 * 若不可覆盖，降级方案是以单文件 alias 覆盖 `mediaSessionInfo.ts`（Phase 5 第一个验证项）。
 */

import { ports, type MediaSessionAction } from '@porting/ports'

type ActionName = MediaSessionAction | 'seekto' | 'seekbackward' | 'seekforward'

interface MediaSessionDetails {
  action?: string
  seekOffset?: number
  seekTime?: number
  fastSeek?: boolean
}

type ActionHandler = ((details?: MediaSessionDetails) => void) | null

interface MediaMetadataLike {
  title?: string
  artist?: string
  album?: string
  artwork?: Array<{ src: string }>
}

/**
 * 原生通知栏的按钮集合读的是 **`setActions`**（`MediaSession.supportedActions()`），
 * 而不是 metadata。三个调用的**顺序有语义**：
 *
 *   setMetadata → setPlaybackState → setActions
 *
 * 只调 `setMetadata` 不调 `setActions` 时，切歌后通知栏的上一首/下一首会停在上一次的状态
 * （例如从单曲循环的列表切到有上一首的列表，按钮不会亮起来）。上游 `mediaSessionInfo.ts`
 * 的调用顺序是它自己的事（且 `setActionHandler` 只在初始化时注册一次），所以这里不能
 * 依赖调用方顺序：**把三个更新攒到微任务末尾，按固定顺序统一发一次**。
 *
 * 代价是每次变更多发 2 条 `postMessage`（JSON 字符串，量级几百字节），换来的是
 * 通知栏状态永远与 JS 侧一致，不再需要让每个调用点都记住顺序。
 */
export class BridgeMediaSession {
  private readonly handlers = new Map<ActionName, NonNullable<ActionHandler>>()
  private metadataValue: MediaMetadataLike | null = null
  private playbackStateValue: 'none' | 'paused' | 'playing' = 'none'

  private pendingMetadata = false
  private pendingPlaybackState = false
  private pendingActions = false
  private flushScheduled = false

  get metadata(): MediaMetadataLike | null {
    return this.metadataValue
  }

  set metadata(value: MediaMetadataLike | null) {
    this.metadataValue = value
    this.pendingMetadata = true
    this.scheduleFlush()
  }

  get playbackState(): 'none' | 'paused' | 'playing' {
    return this.playbackStateValue
  }

  set playbackState(state: 'none' | 'paused' | 'playing') {
    this.playbackStateValue = state
    this.pendingPlaybackState = true
    this.scheduleFlush()
  }

  setPositionState(state?: { duration?: number; playbackRate?: number; position?: number }): void {
    if (!state || !Number.isFinite(state.duration) || (state.duration ?? 0) <= 0) return
    // position 走即时通道：它每秒都在变，且与 metadata/actions 无顺序耦合，
    // 攒到微任务反而会让进度条跳变聚堆。
    ports.mediaSession.setPosition({
      durationMs: Math.round((state.duration ?? 0) * 1000),
      positionMs: Math.round((state.position ?? 0) * 1000),
      playbackRate: state.playbackRate ?? 1,
    })
  }

  setActionHandler(name: ActionName, handler: ActionHandler): void {
    if (handler) this.handlers.set(name, handler)
    else this.handlers.delete(name)
    // 解析式绑定 `navigator.mediaSession.setActionHandler(...)` 会丢 this，
    // 所以标记位放在实例上、每次调用都重新算 handlers 快照即可。
    this.pendingActions = true
    this.scheduleFlush()
  }

  /** 主动重发一次完整状态（Activity 回前台、引擎重建时用） */
  resync(): void {
    this.pendingMetadata = true
    this.pendingPlaybackState = true
    this.pendingActions = true
    this.scheduleFlush()
  }

  /** Kotlin → JS：转发系统/耳机键/通知按钮 */
  dispatch(name: ActionName, details?: MediaSessionDetails): void {
    const handler = this.handlers.get(name)
    if (!handler) return
    try {
      handler(details)
    } catch (err) {
      console.error(`[mediaSession] handler for "${name}" failed`, err)
    }
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return
    this.flushScheduled = true
    queueMicrotask(() => this.flush())
  }

  private flush(): void {
    this.flushScheduled = false
    // 顺序不能变：metadata → playbackState → actions（原因见类注释）
    if (this.pendingMetadata) {
      this.pendingMetadata = false
      const value = this.metadataValue
      ports.mediaSession.setMetadata(
        value == null
          ? null
          : {
              title: value.title ?? '',
              artist: value.artist ?? '',
              album: value.album ?? '',
              artworkUrl: value.artwork?.[0]?.src ?? null,
            }
      )
    }
    if (this.pendingPlaybackState) {
      this.pendingPlaybackState = false
      ports.mediaSession.setPlaybackState(this.playbackStateValue)
    }
    if (this.pendingActions) {
      this.pendingActions = false
      ports.mediaSession.setActions([...this.handlers.keys()] as MediaSessionAction[])
    }
  }
}

declare global {
  interface Window {
    __anylisten_media_session_shim__?: BridgeMediaSession
  }
}

export function installMediaSessionShim(): BridgeMediaSession {
  const globalScope = window as unknown as { MediaMetadata?: unknown }
  if (typeof globalScope.MediaMetadata === 'undefined') {
    // 旧 WebView 可能缺失 MediaMetadata 构造器
    globalScope.MediaMetadata = class MediaMetadata implements MediaMetadataLike {
      title = ''
      artist = ''
      album = ''
      artwork: Array<{ src: string }> = []
      constructor(init: MediaMetadataLike = {}) {
        Object.assign(this, init)
      }
    }
  }

  const shim = new BridgeMediaSession()
  // 上游可能解构后单独调用（`const { setActionHandler } = navigator.mediaSession`），
  // 那样 `this` 就丢了 —— 而本实现依赖实例上的攒批标记。四个方法一律绑死实例。
  shim.setActionHandler = shim.setActionHandler.bind(shim)
  shim.setPositionState = shim.setPositionState.bind(shim)
  shim.resync = shim.resync.bind(shim)
  shim.dispatch = shim.dispatch.bind(shim)
  Object.defineProperty(navigator, 'mediaSession', {
    configurable: true,
    get: () => shim,
  })
  window.__anylisten_media_session_shim__ = shim
  return shim
}

/** 已安装的 shim（未安装时返回 undefined）——供引擎层复用有序发布通道 */
export function getMediaSessionShim(): BridgeMediaSession | undefined {
  return window.__anylisten_media_session_shim__
}
