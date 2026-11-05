package com.anylisten.app

import android.content.Context
import android.content.MutableContextWrapper
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.view.ViewCompat
import com.anylisten.bridge.AndroidBridge
import com.anylisten.bridge.FrameSender

/** 播放中的 WebView 可以暂时脱离 Activity，重新打开界面时再接回。 */
class WebPlaybackRuntime(context: Context) {
  val contextWrapper = MutableContextWrapper(context)
  private val handler = Handler(Looper.getMainLooper())
  @Volatile var webView: WebView? = null
    private set

  val bridge = AndroidBridge(
    registry = AppGraph.registry,
    tokenProvider = { AppGraph.token },
    debugEnabled = BuildConfig.DEBUG,
    sender = FrameSender { frameJson ->
      val deliver = Runnable {
        val target = webView ?: return@Runnable
        val literal = org.json.JSONObject.quote(frameJson)
        runCatching {
          target.evaluateJavascript(
            "window.__anylisten_bridge_recv__ && window.__anylisten_bridge_recv__($literal)",
            null,
          )
        }.onFailure { Log.w(TAG, "frame drop: ${it.message}") }
      }
      if (Looper.myLooper() == Looper.getMainLooper()) deliver.run() else handler.post(deliver)
    },
  )

  fun attachContext(context: Context) {
    contextWrapper.baseContext = context
  }

  fun installView(view: WebView?) {
    webView = view
  }

  fun enterBackground() {
    val view = webView ?: return
    ViewCompat.setOnApplyWindowInsetsListener(view, null)
    // 旧页面的客户端引用 Activity，后台改用不持有 Activity 的客户端。
    view.webViewClient = object : WebViewClient() {
      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val url = request.url
        return url.host != "127.0.0.1" && url.scheme != "about" && url.scheme != "data"
      }

      override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        Log.e(TAG, "background renderer gone: didCrash=${detail.didCrash()}")
        AppGraph.onBackgroundRendererGone(this@WebPlaybackRuntime)
        return true
      }
    }
    view.webChromeClient = WebChromeClient()
    contextWrapper.baseContext = AppGraph.app
  }

  fun destroy() {
    val view = webView ?: return
    webView = null
    runCatching {
      (view.parent as? ViewGroup)?.removeView(view)
      view.stopLoading()
      view.destroy()
    }.onFailure { Log.w(TAG, "destroy WebView failed: ${it.message}") }
    contextWrapper.baseContext = AppGraph.app
  }

  private companion object {
    const val TAG = "AnyListen/WebRuntime"
  }
}
