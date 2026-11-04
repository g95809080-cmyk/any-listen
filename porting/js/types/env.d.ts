/// <reference path="../../../source/packages/shared/types/index.d.ts" />
/// <reference path="../../../source/packages/shared/app/types.d.ts" />

/**
 * 编译期常量（由 vite `define` 注入，见 vite.config.mjs）。
 *
 * 为什么必须显式声明：arch §6.3 指出，上游 `VITE_IS_ANDROID / VITE_IS_DESKTOP / VITE_IS_WEB`
 * 是三段式条件分支，任何未定义的值都会静默落入第三分支（web），必须在 define 里显式给 `false`。
 */
declare const __GIT_COMMIT__: string
declare const __GIT_COMMIT_DATE__: string
declare const __ANYLISTEN_APP_VERSION__: string

declare global {
  /** `os.version` —— 由 Kotlin 侧在 `FileSystemPort.getEnv()` 里提供 */
  // eslint-disable-next-line no-var
  var __anylisten_os_version__: string | undefined
  /** 外部存储根（MANAGE_EXTERNAL_STORAGE 下的 `/storage/emulated/0`），SAF 模式下为 null */
  // eslint-disable-next-line no-var
  var __anylisten_external_root__: string | undefined

  interface Window {
    /**
     * Kotlin 注入的端口桥（`@JavascriptInterface`）。**只有两个方法**：
     * `postMessage(token, frameJson)` 与 `ping()`。
     * token 由 `LocalHttpServer` 注入到 HTML 的 `window.__ANYLISTEN_TOKEN__`。
     * 见 `ports/bridge-client.ts` 的帧格式说明。
     */
    AndroidBridge?: {
      postMessage: (token: string, frameJson: string) => void
      ping: () => string
    }
    /** Kotlin → JS 的**唯一**回程入口，由 `installBridgeReceiver()` 挂载（主线程） */
    __anylisten_bridge_recv__?: (frameJson: string) => void
    /** 桥与本地 HTTP 共用的鉴权 token（`LocalHttpServer` 首帧注入） */
    __ANYLISTEN_TOKEN__?: string
    /** 本地 HTTP 的 origin，用于判断"跑在壳里还是纯浏览器里" */
    __ANYLISTEN_BRIDGE_ORIGIN__?: string
    /** 主线程的 Ports 集线器（Worker 帧 → 原生） */
    __anylisten_ports_hub__?: unknown
    /** MediaSession 运行时替身 */
    __anylisten_media_session_shim__?: unknown
    /** 旧版 view-main 读取的 IPC 入口（source/packages/view-main/src/shared/ipc/ipc.ts 唯一读取点） */
    __anylisten_ipc_init__?: unknown
    /** `MobileApp` 挂载成功的标记（调试 / 冒烟用） */
    __anylisten_app_started__?: boolean
  }
}

export {}
