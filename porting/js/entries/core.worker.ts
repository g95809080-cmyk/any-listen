/**
 * core-worker 入口 —— AndroidShell 的"主进程等价物"。
 *
 * 上游 `web-server` 是一个 Node 进程：Koa + ws + 全部 `@any-listen/app` 业务模块。
 * Android 上这一层整体搬进一个 Web Worker，于是：
 * - **可以用 `MessagePort` 代替 WebSocket**：`host/ipc/websocket.ts` 提供虚拟 socket，
 *   `app/renderer/winMain/rendererEvent/*`（883 行 IPC 胶水）零改动复用
 * - **UI 线程只做渲染与音频**：Svelte + Web Audio / AudioWorklet
 *
 * 首条消息由主线程 `entries/main.ts` 发出：
 * ```ts
 * worker.postMessage({ type: 'bootstrap', scripts }, [ipcPort, portsChannel, dbPort, utilPort, extPort])
 * ```
 * 监听器在模块求值期间就注册（静态 import 链），不存在竞态。
 */

import '../shims/globals'

import { bootstrapCoreWorker, registerCoreLifecycleFlush } from '@porting/host/bootstrap'
import { isBootstrapMessage } from '@porting/entries/bootstrap-message'

self.addEventListener(
  'message',
  (event: MessageEvent) => {
    const [ipcPort, portsChannel, workerPortsControl] = event.ports
    if (!ipcPort || !portsChannel || !workerPortsControl) {
      console.error('[core.worker] bootstrap 缺少必要通道，收到 ports 数量:', event.ports.length)
      return
    }
    if (!isBootstrapMessage(event.data)) {
      console.error('[core.worker] 首条消息不是 bootstrap 指令:', event.data)
      return
    }

    void bootstrapCoreWorker({
      ipcPort,
      portsChannel,
      workerScripts: event.data.scripts,
      workerPortsControl,
    })
      .then(() => {
        registerCoreLifecycleFlush()
      })
      .catch((err: unknown) => {
        console.error('[core.worker] 启动失败', err)
        throw err
      })
  },
  { once: true },
)
