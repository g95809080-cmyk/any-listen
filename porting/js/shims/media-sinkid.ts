/**
 * `HTMLMediaElement.setSinkId` 能力补丁。
 *
 * 背景（真机 `TypeError: audio$1.setSinkId is not a function`）：
 * `view-main/src/plugins/player/index.ts:509` 是**无条件**调用
 * `await audio.setSinkId(mediaDeviceId)`，而同函数 511 行对 `audioContext.setSinkId`
 * 是探测过的 —— 上游这个判断只写了一半。`setSinkId` 是 Chrome/WebView **110+** 的 API，
 * 设备 WebView 低于该版本时它不存在，调用直接抛。
 *
 * 为什么表现为 unhandled rejection：`view-main/src/modules/player/init/mediaDevice.ts:45-56`
 * 里第一次调用有 `.catch`，但 catch 里的**兜底重试** `setMediaDeviceId('default')` 只挂了
 * `.finally`、没有 `.catch` → 第二次同样抛、无人接。所以真机那条日志不是"首次失败"，
 * 是"兜底也失败"。
 *
 * ## 语义（三条都不能改）
 *
 * - `'default'` → **resolve**：让 `mediaDevice.ts:52` 的兜底重试成功，从而消掉那条
 *   unhandled rejection，并把设备偏好落成 `'default'`（手机上的正确语义就是"跟随系统"）。
 * - `''` / 其它 id → **reject**：保持 509 行原来的抛错行为。这样**不会**继续往下走到
 *   511 的 else 分支去执行 `initAudioOutputDestination()` —— 那里会把 `audioOutput.srcObject`
 *   接到一个 `MediaStreamDestination`，在手机上会产生「音频进了没人消费的流」的新风险。
 *   宁可让"切设备"失败，也不要引入一条没验证过的音频路由。
 * - **绝不给 `AudioContext.prototype` 补 `setSinkId`**：511 行是 `if (audioContext.setSinkId)`
 *   探测式分支，补上就会改走 context 分支、跳过 `initAudioOutputDestination()`，
 *   行为差异比现在更大。
 *
 * 影响面：只在 API 缺失的环境生效；WebView 升到 110+ 后 `typeof !== 'function'` 不成立，
 * 本补丁自动短路，桌面 Chrome 完全走原路径。
 */

type SinkIdCapable = { setSinkId?: (sinkId: string) => Promise<void> }

const proto = HTMLMediaElement.prototype as unknown as SinkIdCapable

if (typeof proto.setSinkId !== 'function') {
  proto.setSinkId = function setSinkId(sinkId: string): Promise<void> {
    if (sinkId === 'default') return Promise.resolve()
    return Promise.reject(
      new DOMException('setSinkId is not supported on this platform', 'NotSupportedError')
    )
  }
}
