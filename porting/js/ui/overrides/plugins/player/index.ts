/**
 * 播放器淡入淡出覆写。
 *
 * 上游把 `HTMLAudioElement` 封装在 `plugins/player` 内，外部只能通过 `setVolume` 改音量。
 * 这里保留上游全部导出，只在播放边界调用 `setVolume` 做 220–320ms 的音量包络：
 * - 新曲 `setResource` 先把音量压到 0，`playing` 事件后淡入；
 * - 暂停先淡出，结束后才真正 `pause()`；
 * - 恢复播放重新淡入；
 * - 停止/切歌立即收口并恢复目标音量，避免异步淡出与下一次 `src` 赋值竞态。
 *
 * 不使用 Web Audio GainNode：那会把音频元素永久接进音频图，和上游的高级音效、
 * `setSinkId` 降级链、后台播放互相影响。元素音量在有无音效链时都有效，且改动面最小。
 */

import * as upstream from '@porting-uplink/plugins/player'

export * from '@porting-uplink/plugins/player'

const FADE_IN_MS = 320
const FADE_OUT_MS = 220
const FADE_STEP_MS = 16

type FadePhase = 'idle' | 'in' | 'out'

let targetVolume = 1
let appliedVolume = 1
let fadePhase: FadePhase = 'idle'
let fadeTimer: number | null = null
let fadeGeneration = 0
let fadeFrom = 0
let fadeTo = 0
let fadeStartedAt = 0
let fadeDuration = 0

let playbackActive = false
let pauseCommitted = true
let pendingFadeIn = false
let listenersInstalled = false

const clampVolume = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value)

const applyVolume = (value: number) => {
  appliedVolume = clampVolume(value)
  upstream.setVolume(appliedVolume)
}

const cancelFade = () => {
  fadeGeneration++
  if (fadeTimer != null) {
    window.clearTimeout(fadeTimer)
    fadeTimer = null
  }
  fadePhase = 'idle'
}

const startFade = (
  from: number,
  to: number,
  duration: number,
  phase: Exclude<FadePhase, 'idle'>,
  done?: () => void
) => {
  cancelFade()
  fadePhase = phase
  fadeFrom = clampVolume(from)
  fadeTo = clampVolume(to)
  fadeStartedAt = performance.now()
  fadeDuration = duration
  const generation = fadeGeneration

  const step = () => {
    if (generation !== fadeGeneration) return
    const progress = duration <= 0 ? 1 : Math.min(1, (performance.now() - fadeStartedAt) / duration)
    // 人耳对音量接近线性感知，短包络不必做等响度指数曲线。
    applyVolume(fadeFrom + (fadeTo - fadeFrom) * progress)
    if (progress < 1) {
      fadeTimer = window.setTimeout(step, FADE_STEP_MS)
      return
    }
    fadeTimer = null
    fadePhase = 'idle'
    done?.()
  }

  step()
}

const skipAnimation = () => document.visibilityState !== 'visible'

const commitPause = () => {
  pauseCommitted = true
  playbackActive = false
  pendingFadeIn = false
  applyVolume(0)
  upstream.setPause()
}

const handleAudioPlaying = () => {
  playbackActive = true
  pauseCommitted = false
  if (!pendingFadeIn) return
  pendingFadeIn = false
  startFade(appliedVolume, targetVolume, FADE_IN_MS, 'in')
}

const handleAudioPause = () => {
  if (pauseCommitted) return
  playbackActive = false
  pauseCommitted = true
}

const installListeners = () => {
  if (listenersInstalled) return
  listenersInstalled = true
  upstream.onPlaying(handleAudioPlaying)
  upstream.onPause(handleAudioPause)
}

export const createAudio = () => {
  upstream.createAudio()
  upstream.setVolume(appliedVolume)
  installListeners()
}

export const releasePlayer = async () => {
  cancelFade()
  playbackActive = false
  pauseCommitted = true
  pendingFadeIn = false
  listenersInstalled = false
  await upstream.releasePlayer()
}

export const setPlay = () => {
  const canResumeWithoutPlayEvent = playbackActive && !pauseCommitted
  cancelFade()
  pendingFadeIn = true
  playbackActive = true
  pauseCommitted = false

  if (canResumeWithoutPlayEvent) {
    pendingFadeIn = false
    startFade(appliedVolume, targetVolume, FADE_IN_MS, 'in')
  } else {
    applyVolume(0)
  }
  upstream.setPlay()
}

export const setPause = () => {
  if (!playbackActive) {
    pendingFadeIn = false
    upstream.setPause()
    return
  }

  pendingFadeIn = false
  cancelFade()
  if (skipAnimation() || appliedVolume <= 0.001) {
    commitPause()
    return
  }
  startFade(appliedVolume, 0, FADE_OUT_MS, 'out', commitPause)
}

export const setStop = () => {
  cancelFade()
  pendingFadeIn = false
  playbackActive = false
  pauseCommitted = true
  upstream.setStop()
  applyVolume(targetVolume)
}

export const setResource = (src: string) => {
  cancelFade()
  pendingFadeIn = true
  playbackActive = true
  pauseCommitted = false
  applyVolume(0)
  upstream.setResource(src)
}

export const setVolume = (volume: number) => {
  const next = clampVolume(volume)
  const previousTarget = targetVolume
  targetVolume = next

  if (fadePhase === 'out') {
    // 淡出目标始终是 0；这里只更新下次恢复播放要到达的音量。
    return
  }
  if (fadePhase === 'in') {
    if (next === previousTarget) return
    startFade(appliedVolume, next, FADE_IN_MS, 'in')
    return
  }

  cancelFade()
  applyVolume(next)
}
