/**
 * 扩展沙箱 worker 入口。
 *
 * 承载 `@any-listen/app/modules/worker/extensionService`（插件下载、启用、`node:vm` 沙箱执行）。
 * 沙箱由 `shims/vm.ts` 用 QuickJS(WASM) 实现 —— 扩展是**不可信代码**，
 * 绝不能跑在 core-worker 里（否则一个死循环卡死整个 IPC 层）。
 *
 * ---
 *
 * ## 为什么必须在这里调 `initVmShim()`
 *
 * `shims/vm.ts` 的 `initVmShim()` 曾经**全仓零调用点**，后果不是"沙箱起不来"这么简单：
 *
 * 1. `initVmShim()` 没人调 → 它里面的 `await getQuickJS()` 不可达 → 被 tree-shaking 删；
 * 2. `quickjs-emscripten` 里唯一引用变体模块的地方是
 *    `newQuickJSWASMModule(variantOrPromise = import_quickjs_wasmfile_release_sync.default)`
 *    这个**默认参数** → 4 个变体模块整片被摇掉；
 * 3. 但变体模块在 **transform 阶段**的 `new URL('emscripten-module.wasm', import.meta.url)`
 *    已经 `emitFile` 了 4 个 wasm 资产 → **资产留下、代码没了**。
 *
 * 真机表现：`dist/spa/assets` 里有 4 个 `emscripten-module-*.wasm`（合计 9.84 MB），
 * 而全 bundle 的 `.wasm` 字面量只有 `sql-wasm-browser.wasm`，`QTS_NewRuntime` /
 * `importModuleLoader` 零命中 —— 一个"体积占了、功能没有"的孤儿。
 *
 * 判据（压缩器不会改的字符串字面量，构建后可直接 grep）：
 * - `QTS_NewRuntime`（`module.cwrap("QTS_NewRuntime", …)` 的第一个参数）
 * - `importModuleLoader`（变体对象的字段名）
 *
 * ## 契约（与 `entries/db.worker.ts` 同一套，别改）
 *
 * `setBeforeExpose()` 必须在**模块体里同步执行**，前面不能有顶层 `await`；钩子本身可以是
 * async。原因见 `host/worker/expose.ts`：`exposeWorker()` 在静态 import 阶段就发起了
 * `receiveChannels()`，顶层 await 会让 wasm 加载期间到达的握手消息在 `obj` 被包之前进来。
 * quickjs 的 wasm 有几百 KB，这个窗口是实打实存在的，不能赌。
 */

import '../shims/globals'

import { initVmShim } from '../shims/vm'
import { setBeforeExpose } from '../host/worker/expose'

import '@any-listen/app/modules/worker/extensionService/index'

setBeforeExpose(async () => {
  // **不能让它 reject**：`exposeWorker()` 在钩子 reject 时会整体失败（`beforeExposeHook` 那一行没有
  // try/catch），上游是 `void exposeWorker({...})` → 本 worker 永远发不出 `inited` →
  // `startExtensionServiceWorker()` 的 await 挂死 → **core bootstrap 卡住、UI 永久 Loading**。
  // quickjs 的 wasm 加载是这一环里最可能失败的一步（404 / MIME 不是 application/wasm），
  // 让它把整个 App 带下水不成比例。
  //
  // 所以这里降级为「响亮失败 + 局部可用」：扩展沙箱起不来，但曲库/播放/IPC 全部正常。
  // 真去执行扩展时，`shims/vm.ts:212` 的守卫会抛
  // `vm: QuickJS module is not initialized, call initVmShim() at worker startup` —— 错误不会消失，
  // 只是从"启动即死"变成"用到才报"。
  try {
    await initVmShim()
    console.log('[ext.worker] quickjs ready')
  } catch (err) {
    console.error('[ext.worker] quickjs 初始化失败：扩展沙箱不可用（其余功能不受影响）', err)
  }
})
