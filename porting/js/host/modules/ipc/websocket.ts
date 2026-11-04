/**
 * `@/modules/ipc/websocket` 的 Android 替身。
 *
 * 桌面/web 版这里是 `ws` WebSocket 服务端 + 鉴权 + 多客户端。Android 是**单 WebView 单客户端**（R-16），
 * 因此只保留「虚拟 socket」抽象：
 * - 服务端（core-worker）侧的 `socket.remote` 是 message2call 的 client 代理
 * - `socket.sendMessage` 把帧投递到 UI 主线程的 MessagePort
 *
 * 这样 `app/renderer/winMain/rendererEvent/*`（883 行 IPC 组装）可以**原样复用**。
 */

export interface KeyInfo {
  clientId: string
  timestamp: number
}

export interface ServerSocketBase {
  aliveTime: number
  isReady: boolean
  isInited: boolean
  keyInfo: KeyInfo
  winType: 'main' | 'desktopLyric'
  sendMessage: (message: unknown) => void
  onMessage?: (message: unknown) => void
  onClose: (handler: (err: Error) => void | Promise<void>) => () => void
}

export interface ServerSocketWinMain extends ServerSocketBase {
  remote: AnyListen.IPC.ClientICPCommonActions
  remoteQueueTheme: AnyListen.IPCTheme.ClientIPCActions
  remoteQueuePlayer: AnyListen.IPCPlayer.ClientIPCActions
  remoteQueueList: AnyListen.IPCList.ClientIPCActions
  remoteQueueDislike: AnyListen.IPCDislikeList.ClientIPCActions
  remoteQueueSync: AnyListen.IPCSync.ClientIPCActions
  remoteQueueExtension: AnyListen.IPCExtension.ClientIPCActions
  remoteExtension: AnyListen.IPCExtension.ClientIPCActions
}

export type ServerSocket = ServerSocketWinMain

const sockets = new Set<ServerSocket>()

export const registerSocket = (socket: ServerSocket): void => {
  sockets.add(socket)
}

export const removeSocket = (socket: ServerSocket): void => {
  sockets.delete(socket)
}

export const getSockets = (): ServerSocket[] => [...sockets]

export const broadcast = (handler: (client: ServerSocket) => void): void => {
  for (const socket of sockets) handler(socket)
}

export const destroySockets = (): void => {
  for (const socket of sockets) socket.onMessage = undefined
  sockets.clear()
}

export const onUpgrade = (): never => {
  throw new Error('WebSocket upgrade is not available on Android: IPC runs over MessagePort')
}
