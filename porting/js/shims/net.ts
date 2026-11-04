/**
 * `node:net` 替身 —— 上游只在 `WebSocketServer` 的 upgrade 回调里用到 `Socket` 类型。
 * Android 侧 IPC 走 MessagePort，没有 TCP 监听，因此这里只提供类型。
 */

export interface Socket {
  write: (data: string) => void
  destroy: () => void
  addListener: (event: string, handler: (err: Error) => void) => void
  removeListener: (event: string, handler: (err: Error) => void) => void
}

export default {}
