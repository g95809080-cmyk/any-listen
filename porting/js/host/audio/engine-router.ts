/**
 * 音频引擎外壳（UI 主线程）。
 *
 * 为什么音频必须在 UI 主线程（arch D-05 / §9.1）：
 * 1. `AudioContext` / `AudioWorklet` 只能在 window 作用域创建，Worker 里没有；
 * 2. MediaSession 的原生控制（蓝牙耳机、锁屏、通知栏）由 Kotlin 侧驱动，
 *    与"实际出声的 audio 元素"必须同线程，否则 `setPositionState` 会与播放进度漂移；
 * 3. AudioFocus 丢失时要在**同一帧**里暂停并上报，跨线程做不到。
 *
 * 本外壳只负责"把播放地址塞进 audio 元素并把状态回报给 MediaSessionPort"。
 * 真正的播放队列 / 音效 / 淡入淡出仍在 core-worker 的 `player` 模块里，
 * 通过 IPC 下发 `load/play/pause/seek`（下一批次接 Svelte 时接入）。
 *
 * 播放地址必须是 `FileSystemPort.toPlayableUrl()` 产出的 loopback HTTP URL：
 * `file://` 下 AudioWorklet 与 `createMediaElementSource` 均不可用（R-06）。
 */

import { ports } from '@porting/ports'
import { getMediaSessionShim } from '@porting/host/mediasession-shim'

export interface AudioEngineSnapshot {
  url: string | null
  playing: boolean
  position: number
  duration: number
  volume: number
  muted: boolean
}

type Listener = (snapshot: AudioEngineSnapshot) => void

export class AudioEngineRouter {
  private readonly audio: HTMLAudioElement
  private readonly listeners = new Set<Listener>()
  private lastReportedSecond = -1

  constructor() {
    const audio = new Audio()
    audio.preload = 'auto'
    // 关键：同源 loopback HTTP 才能拿到 Range + 允许 AudioWorklet 挂接
    audio.crossOrigin = 'anonymous'
    this.audio = audio

    audio.addEventListener('play', () => this.emit())
    audio.addEventListener('pause', () => this.emit())
    audio.addEventListener('ended', () => {
      this.emit()
      this.reportState('none')
    })
    audio.addEventListener('loadedmetadata', () => {
      this.emit()
      this.reportPosition()
    })
    audio.addEventListener('timeupdate', () => {
      // 每秒最多上报一次，避免 IPC 被打爆（MediaSession 只需要秒级精度）
      const second = Math.floor(audio.currentTime)
      if (second === this.lastReportedSecond) return
      this.lastReportedSecond = second
      this.reportPosition()
    })
    audio.addEventListener('error', () => {
      console.error('[audio] 播放失败', audio.src, audio.error?.message ?? 'unknown')
    })
  }

  private emit(): void {
    const snapshot = this.snapshot()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch (err) {
        console.error('[audio] listener threw', err)
      }
    }
  }

  snapshot(): AudioEngineSnapshot {
    return {
      url: this.audio.src || null,
      playing: !this.audio.paused && !this.audio.ended,
      position: this.audio.currentTime,
      duration: Number.isFinite(this.audio.duration) ? this.audio.duration : 0,
      volume: this.audio.volume,
      muted: this.audio.muted,
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async load(url: string): Promise<void> {
    this.audio.src = url
    this.lastReportedSecond = -1
    this.emit()
  }

  async play(): Promise<void> {
    try {
      await this.audio.play()
      this.reportState('playing')
    } catch (err) {
      // 自动播放策略 / AudioFocus 被抢都会走到这里，必须记录下来（不能吞）
      console.error('[audio] play() 被拒绝', err)
      this.reportState('paused')
      throw err
    }
  }

  pause(): void {
    this.audio.pause()
    this.reportState('paused')
  }

  seek(position: number): void {
    if (!Number.isFinite(position) || position < 0) {
      console.error('[audio] seek 参数非法', position)
      return
    }
    this.audio.currentTime = position
    this.lastReportedSecond = -1
    this.reportPosition()
  }

  setVolume(volume: number): void {
    this.audio.volume = Math.min(1, Math.max(0, volume))
    this.emit()
  }

  setMuted(muted: boolean): void {
    this.audio.muted = muted
    this.emit()
  }

  private reportState(state: MediaSessionPlaybackState): void {
    // 走 shim 的有序发布通道（metadata → playbackState → actions）。
    // 直接 `ports.mediaSession.setPlaybackState(...)` 会绕过重发 actions 的那一步，
    // 原生通知栏的上一首/下一首按钮就会停在上一次的状态。
    const shim = getMediaSessionShim()
    if (shim) {
      shim.playbackState = state
      return
    }
    ports.mediaSession.setPlaybackState(state)
  }

  private reportPosition(): void {
    const duration = Number.isFinite(this.audio.duration) ? this.audio.duration : 0
    if (duration <= 0) return
    ports.mediaSession.setPosition({
      durationMs: duration * 1000,
      positionMs: this.audio.currentTime * 1000,
      playbackRate: this.audio.playbackRate,
    })
  }
}

/** MediaSession 的 4 个动作。`lyricNext` 预留但 MVP 不实装（team-lead 已确认单行歌词）。 */
export const MEDIA_SESSION_ACTIONS: MediaSessionAction[] = [
  'play',
  'pause',
  'previoustrack',
  'nexttrack',
  'seekto',
  'seekbackward',
  'seekforward',
  'stop',
]

export function createAudioEngineRouter(): AudioEngineRouter {
  return new AudioEngineRouter()
}
