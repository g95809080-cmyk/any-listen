package com.anylisten.bridge

import android.util.Log
import android.webkit.JavascriptInterface
import com.anylisten.bridge.modules.AudioModule
import com.anylisten.bridge.modules.FsModule
import com.anylisten.bridge.modules.HttpModule
import com.anylisten.bridge.modules.LifecycleModule
import com.anylisten.bridge.modules.LogModule
import com.anylisten.bridge.modules.MediaSessionModule
import com.anylisten.bridge.modules.NotificationModule
import com.anylisten.bridge.modules.PowerModule
import com.anylisten.bridge.modules.SettingsModule
import com.anylisten.bridge.modules.UiModule
import com.anylisten.ports.PortRegistry
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * `@JavascriptInterface` 入口 —— 整个 Kotlin↔JS 的**唯一**同步边界。
 *
 * **线程模型**（任务书硬要求）：
 * JS 调用发生在 WebView 的 JavaBridge 线程 → 这里只做「校验 + 投递」，绝不做 IO；
 * 实际处理在 [BridgeRouter] 的 `Dispatchers.IO.limitedParallelism(8)`；
 * 响应/事件通过 [FrameSender]（:app 用 `webView.post { evaluateJavascript(...) }`）回到 **主线程**。
 *
 * **为什么只暴露一个方法**：`@JavascriptInterface` 每个方法都是一个攻击面，且 Web Worker
 * 拿不到 Interface（只能由主 frame 代理）。统一成 `postMessage(token, frameJson)`，
 * 与 `message2call` 的 `sendMessage(data)` 一一对应。
 *
 * JS 侧对应实现：`porting/js/ports/bridge-client.ts` 的 `sendToNative()` / `installBridgeReceiver()`。
 */
class AndroidBridge(
  registry: PortRegistry,
  private val tokenProvider: () -> String,
  private val debugEnabled: Boolean,
  private val sender: FrameSender,
) {
  private val emitter = NativeEmitter(sender)
  private val router = BridgeRouter(emitter).also { registerAllModules(it, registry) }
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

  fun registeredModules(): List<String> = router.registeredModules()

  /**
   * @param token 首帧注入的 `window.__ANYLISTEN_TOKEN__`。校验失败直接丢弃 ——
   *              防止注入到 WebView 的第三方页面（`shouldOverrideUrlLoading` 已拦外链，
   *              这里只是纵深防御，代价为零）。JS 侧空 token 会显式抛 `EACCES`，
   *              所以"桥静默不响应"通常意味着 token 注入环节漏了。
   * @param frameJson message2call v2 数组帧，见 [Message2CallFrames]
   */
  @JavascriptInterface
  fun postMessage(token: String, frameJson: String) {
    if (token != tokenProvider()) {
      Log.w(TAG, "bridge call rejected: invalid token")
      return
    }
    if (frameJson.isEmpty() || frameJson.length > MAX_FRAME_CHARS) {
      Log.w(TAG, "bridge call rejected: frame size ${frameJson.length}")
      return
    }
    if (debugEnabled) Log.d(TAG, "frame in: ${frameJson.take(240)}")
    scope.launch {
      val response = router.dispatch(frameJson)
      if (response != null) {
        if (debugEnabled) Log.d(TAG, "frame out: ${response.toString().take(240)}")
        sender.send(response.toString())
      }
    }
  }

  @JavascriptInterface
  fun ping(): String = PING_VALUE

  private companion object {
    const val TAG = "AnyListen/Bridge"
    /** 单帧上限 16MB：大文件走 `/stream/<id>` 而不是桥 */
    const val MAX_FRAME_CHARS = 16 * 1024 * 1024
    /** JS 侧 `BRIDGE_PING_PREFIX = 'anylisten-bridge/'`，后缀解析成协议版本号 */
    const val PING_VALUE = "anylisten-bridge/1"
  }
}

/**
 * 模块注册表 —— **模块名必须与 `porting/js/ports/index.ts` 的 `ports.<name>` 一一对应**，
 * 这样 JS 侧 `ports.fs.readFile()` 直接映射到 path `["fs","readFile"]`，无需映射表
 * （`ports/index.ts` 顶部注释也写了这条：改名要在三处同时改）。
 * 放在 :bridge 而不是 :app，是为了让这条契约与实现同处一个文件、易于 review。
 */
fun registerAllModules(router: BridgeRouter, registry: PortRegistry) {
  router.register(FsModule(registry))
  router.register(HttpModule(registry))
  router.register(LogModule(registry))
  router.register(SettingsModule(registry))
  router.register(PowerModule(registry))
  router.register(LifecycleModule(registry))
  router.register(AudioModule(registry))
  router.register(MediaSessionModule(registry))
  router.register(NotificationModule(registry))
  router.register(UiModule(registry, "theme"))
  router.register(UiModule(registry, "clipboard"))
  router.register(UiModule(registry, "intent"))
  router.register(UiModule(registry, "tar"))
}
