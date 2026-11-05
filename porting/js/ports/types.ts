/**
 * Port 契约（与 Kotlin 侧 :core-ports 一一对应）。
 *
 * 约束（来自 docs/phase2-architecture.md §4）：
 * 1. 调用方在 JS 侧（4 个 Worker），实现方在 Kotlin 侧；SandboxPort/SqlitePort 是纯 JS 实现，不在此文件。
 * 2. 全部异步（Worker 无法同步触达原生）。
 * 3. 粗粒度：一次方法调用完成一个业务动作（listTree 例外，用分批事件）。
 * 4. 错误统一为 PortError，`code` 与 Node 的 errno 同名（ENOENT/EACCES/EIO/...）。
 */

export type PortErrorCode =
  | 'ENOENT'
  | 'EEXIST'
  | 'EACCES'
  | 'EISDIR'
  | 'ENOTDIR'
  | 'ENOTEMPTY'
  | 'EIO'
  | 'ETIMEDOUT'
  | 'EUNSUPPORTED'
  | 'ECANCELED'
  | 'EUNKNOWN'

export interface PortErrorPayload {
  code: PortErrorCode
  message: string
  detail?: string
}

/** 跨语言边界的错误对象。Node 侧的 `err.code` 判定（如 `e.code != 'ENOENT'`）依赖它。 */
export class PortError extends Error {
  readonly code: PortErrorCode
  readonly detail: string | undefined

  constructor(code: PortErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'PortError'
    this.code = code
    this.detail = detail
  }

  static from(payload: unknown): PortError {
    const p = payload as Partial<PortErrorPayload> | null
    const code = (p?.code ?? 'EUNKNOWN') as PortErrorCode
    const message = typeof p?.message === 'string' ? p.message : 'port call failed'
    const detail = typeof p?.detail === 'string' ? p.detail : undefined
    return new PortError(code, message, detail)
  }

  toPayload(): PortErrorPayload {
    return this.detail == null
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, detail: this.detail }
  }
}

export interface FsEntry {
  /** 内部路径。SAF 模式下是 `/saf/<treeId>/...` 虚拟路径，**不可直接展示给用户** */
  path: string
  /**
   * 给用户看的路径（team-lead 2026-xx 约束）。
   *
   * SAF 模式下 Kotlin 侧把它填成可读目录名（如 `内部存储/Music`），
   * MANAGE_EXTERNAL_STORAGE 模式下与 `path` 相同。
   * UI 侧（设置页 / 歌曲信息）**必须**优先显示 `displayPath ?? path`，
   * 否则会把 `/saf/primary%3AMusic` 这种内部标识暴露给用户。
   */
  displayPath?: string
  name: string
  isFile: boolean
  isDirectory: boolean
  size: number
  mtimeMs: number
}

export interface FsStat {
  isFile: boolean
  isDirectory: boolean
  size: number
  ctimeMs: number
  mtimeMs: number
}

export interface FsWatchEvent {
  action: 'add' | 'change' | 'unlink'
  path: string
  ctimeMs?: number
  mtimeMs?: number
  size?: number
}

export interface FsEnv {
  dataPath: string
  cachePath: string
  tempPath: string
  externalRoot: string | null
  platform: 'android'
  arch: 'arm64' | 'armv7' | 'x86_64'
  osVersion: string
  hasAllFilesAccess: boolean
}

export interface FileSystemPort {
  listTree(
    root: string,
    opts: { maxDepth?: number; fileExtFilter?: string[]; batchSize?: number },
    onBatch: (entries: FsEntry[]) => void
  ): Promise<{ total: number; canceled: boolean; id: string }>
  cancelScan(id: string): Promise<void>

  stat(path: string): Promise<FsStat | null>
  exists(path: string): Promise<boolean>
  readFile(path: string, range?: { start: number; end: number }): Promise<Uint8Array>
  writeFile(path: string, data: Uint8Array): Promise<void>
  /** .tmp + fsync + rename，DB / 设置文件落盘用 */
  writeFileAtomic(path: string, data: Uint8Array): Promise<void>
  appendFile(path: string, text: string): Promise<void>
  mkdirp(path: string): Promise<void>
  remove(path: string, recursive?: boolean): Promise<void>
  rename(from: string, to: string): Promise<boolean>
  copy(from: string, to: string): Promise<void>
  readdir(path: string): Promise<FsEntry[]>
  realpath(path: string): Promise<string>

  watch(
    root: string,
    opts: { recursive?: boolean; extFilter?: string[] },
    onEvent: (e: FsWatchEvent) => void,
    onReady: () => void,
    onError: (msg: string) => void
  ): Promise<string>
  unwatch(id: string): Promise<void>

  toPlayableUrl(path: string): Promise<string | null>
  revokePlayableUrl(url: string): Promise<void>
  pickDirectory(title?: string): Promise<{ path: string; displayName: string } | null>
  getEnv(): Promise<FsEnv>
  getFreeSpace(path: string): Promise<number>
}

export interface HttpRequestOptions {
  method?: string
  headers?: Record<string, string>
  query?: Record<string, unknown>
  body?: string | Uint8Array
  bodyFilePath?: string
  timeoutMs?: number
  retryNum?: number
  maxRedirect?: number
  needRaw?: boolean
  proxy?: { host: string; port: string } | null
}

export interface HttpResponse {
  statusCode: number
  headers: Record<string, string>
  body?: string
  raw?: Uint8Array
  filePath?: string
  history: string[]
}

export interface HttpPort {
  request(url: string, opts: HttpRequestOptions): Promise<HttpResponse>
  downloadTo(
    url: string,
    destPath: string,
    opts: {
      headers?: Record<string, string>
      timeoutMs?: number
      proxy?: { host: string; port: string } | null
      onProgress: (p: { downloaded: number; total: number; speed: number }) => void
    }
  ): Promise<{ filePath: string; size: number; sha256: string }>
  cancel(id: string): Promise<void>
  setProxy(proxy: { host: string; port: string } | null): Promise<void>
}

/**
 * 通知栏端口。**没有 `postMedia`/`updateMedia`** —— MediaStyle 通知本体
 * （标题/封面/播放暂停上一首下一首）由 `:app` 的 `PlaybackService` 自己维护，
 * 这里只补它做不到的事：通知栏歌词、Toast、原生对话框。
 *
 * 方法全部是**同步签名 + 发出即忘**（上游调用点没有 await 的机会）。
 */
export interface NotificationPort {
  /**
   * 通知栏歌词。MVP **单行**（team-lead 确认）：`lyricNext` 字段预留但不实装。
   * @param line.lyricLine  当前行；null = 清空
   * @param line.lyricNext  下一行，Kotlin 侧收 null 就不展示（预留）
   * @param line.lyricEnabled 用户是否开启通知栏歌词
   */
  updateLyric(line: { lyricLine?: string | null; lyricNext?: string | null; lyricEnabled?: boolean }): void
  clear(): void
  showToast(message: string): void
  showMessageBox(
    key: string,
    message: string,
    options?: { modal?: boolean; type?: 'info' | 'warn' | 'error' }
  ): Promise<number>
}

export type MediaSessionAction =
  | 'play'
  | 'pause'
  | 'stop'
  | 'seekbackward'
  | 'seekforward'
  | 'seekto'
  | 'previoustrack'
  | 'nexttrack'

/**
 * §9.1 冻结签名：与 `navigator.mediaSession` 替身一一对应。
 *
 * 4 个 setter 是**同步发出即忘**（替身的 setter 不能返回 Promise）。
 * `onControl` 是 Kotlin → JS 的唯一反向通道：通知栏按钮 / 锁屏 / 蓝牙耳机键
 * 全从 `MediaSessionCompat.Callback` 走到这里。
 */
export interface MediaSessionPort {
  setMetadata(m: { title: string; artist: string; album: string; artworkUrl: string | null } | null): void
  setPlaybackState(s: 'none' | 'paused' | 'playing'): void
  setPosition(p: { durationMs: number; positionMs: number; playbackRate: number }): void
  setActions(actions: MediaSessionAction[]): void
  /**
   * 订阅系统媒体控制。
   * `value` 只在 `seekto` 时有意义，单位是**毫秒**（Kotlin `onSeekTo(pos: Long)`）。
   * 调用方转成 `MediaSessionActionDetails.seekTime` 时要 `/1000`。
   */
  onControl(cb: (action: MediaSessionAction | string, value?: number) => void): void
  /** 通知栏歌词行（MediaSession 侧的另一条通路，`PlaybackService` 决定用不用） */
  updateLyricLine(line: string | null): void
  snapshot(): Promise<{
    isPlaying: boolean
    positionMs: number
    durationMs: number
    playbackRate: number
    actions: string[]
    lyricLine: string | null
  }>
}

export interface AudioPort {
  nativePlay(url: string, opts: { volume: number; rate: number; preservesPitch: boolean }): Promise<void>
  nativePause(): Promise<void>
  nativeSeek(ms: number): Promise<void>
  nativeSetVolume(v: number): Promise<void>
  nativeStop(): Promise<void>
  requestFocus(): Promise<void>
  abandonFocus(): Promise<void>
  onFocusChange(cb: (t: 'gain' | 'loss' | 'loss_transient' | 'duck') => void): void
  setEngine(engine: 'web' | 'native'): Promise<void>
  getEngine(): Promise<'web' | 'native'>
  getCapabilities(): Promise<AudioCapabilities>
}

/**
 * 与 Kotlin `Serialize.capabilities()` 的字段**完全一致**。
 * 缺字段会让前端的降级分支读到 `undefined` 然后当成 `false`，比多字段危险得多。
 */
export interface AudioCapabilities {
  engine: 'web' | 'native'
  audioWorklet: boolean
  convolver: boolean
  panner3d: boolean
  equalizer: boolean
  setSinkId: boolean
  backgroundAudio: 'unverified' | 'ok' | 'suspend'
  maxConvolverIrBytes: number
  supportedSampleRates: number[]
  /** PDR-008：`:native-audio` 本阶段不实现，以下 4 项由 `WebOnlyAudioEngineRouter` 按前端要求返回 */
  pitchShifter: boolean
  playbackRateRange: [number, number]
  supportsPreservesPitch: boolean
  convolverIrLoadable: boolean
}

export interface LogPort {
  write(level: 'debug' | 'info' | 'warn' | 'error', tag: string, message: string): void
  readLastLines(filePath: string, lines: number): Promise<string[]>
  openLogFolder(): Promise<void>
}

export interface LifecyclePort {
  onBackground(cb: () => void): void
  onForeground(cb: () => void): void
  onTrimMemory(cb: (level: number) => void): void
  onBeforeTerminate(cb: (id: string) => void): void
  acknowledgeTermination(id: string, source: string): Promise<void>
  isInForeground(): boolean
}

export interface PowerPort {
  setWakeLock(on: boolean): Promise<void>
  startForegroundService(): Promise<void>
  stopForegroundService(): Promise<void>
  getBatteryOptimizationStatus(): Promise<'ignored' | 'not_ignored'>
  requestIgnoreBatteryOptimization(): Promise<void>
}

export interface ThemePort {
  getSystemIsDark(): Promise<boolean>
  onSystemThemeChanged(cb: (isDark: boolean) => void): void
}

export interface ClipboardPort {
  getText(): Promise<string>
  setText(t: string): Promise<void>
}

export interface IntentPort {
  openUrl(url: string): Promise<void>
  shareFile(path: string, mime: string): Promise<void>
  openDocument(mime: string[]): Promise<{ path: string; name: string } | null>
  /**
   * ⚠️ 已知半实现（native README §7.3）：返回的路径是 App 私有 `files/exports/` 下的目标文件，
   * **不会**自动写进用户选的 SAF 位置 —— 调用方拿到路径后仍需自己写入。
   */
  saveDocument(suggestName: string, mime: string): Promise<{ path: string; name: string } | null>
  openAppSettings(): Promise<void>
}

export interface TarPort {
  pack(dir: string, out: string): Promise<void>
  unpack(archive: string, dist: string): Promise<void>
}
