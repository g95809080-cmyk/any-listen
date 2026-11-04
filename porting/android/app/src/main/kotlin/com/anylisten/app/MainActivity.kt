package com.anylisten.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.lifecycleScope
import com.anylisten.bridge.AndroidBridge
import com.anylisten.bridge.FrameSender
import com.anylisten.ports.PortErrorCode
import com.anylisten.ports.PortException
import com.anylisten.ports.fs.DirPickResult
import com.anylisten.ports.fs.DirectoryPicker
import com.anylisten.ports.ui.DocumentPicker
import com.anylisten.ports.ui.PickedDocument
import com.anylisten.ports.ui.SaveSource
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.lang.ref.WeakReference

/**
 * 唯一的 Activity：全屏 WebView 宿主。
 *
 * 硬要求（来自 uiux，破坏任一条都会让 44dp 触控规格整体失准）：
 * 1. `setSupportZoom(false)` + `setTextZoom(100)` —— 设计约定 1 CSS px = 1 dp，
 *    系统字体放大若被 WebView 二次应用，会让 rem 与触控目标一起放大。
 * 2. **不设置 `setOnLongClickListener`，也不 `isLongClickable=false`** ——
 *    34 处桌面右键菜单的移动端改造依赖 WebView 派发 `contextmenu` 事件。
 * 3. 边到边 + 刘海区延伸：**不能只靠 `env(safe-area-inset-*)`** —— Android WebView 的
 *    `safe-area-inset-bottom` 实测恒为 0（见 ERR-009），所以由 `installInsetsBridge()`
 *    把真实 systemBars+displayCutout insets 以 CSS px 注入成 `--inset-top/--inset-bottom`。
 */
class MainActivity : ComponentActivity() {

  private lateinit var webView: WebView
  private lateinit var rootLayout: FrameLayout
  private lateinit var errorView: TextView

  /** 桥在进程内只建一份（`ensureBridge()`），重建 WebView 时复用它 */
  private var bridgeRef: AndroidBridge? = null

  private var lastBackAt = 0L

  /**
   * 当前 WebView 是否处于「可安全 evaluateJavascript」的状态（D-31）。
   *
   * 渲染进程被系统回收后，旧 WebView 实例上的任何调用都会抛
   * `IllegalStateException: Cannot use this WebView... after it has been destroyed`。
   * 而 Bridge 的响应是异步从 IO 线程发回的，重建窗口内必然有在途帧 —— 用这个标志挡掉，
   * 不靠 try/catch 兜（那样会掩盖真正的契约错误）。
   */
  @Volatile private var webViewAttached = false

  /** 重建进行中（onRenderProcessGone 可能与其他路径并发触发，只允许一次） */
  private var rebuilding = false

  /**
   * 自动重载的时间戳窗口（D-31）。只允许 **60s 内最多 3 次** ——
   * 用滑动窗口而不是「一次性标志」，是因为成功后无需显式复位也不会被永久锁死：
   * 十分钟后再出问题，窗口里自然已经空了。
   */
  private val reloadTimestamps = ArrayDeque<Long>()

  /** 最近一次安全区（CSS px）；-1 表示还没收到 insets */
  private var lastInsetTopPx = -1f
  private var lastInsetBottomPx = -1f

  private val registry get() = AppGraph.registry

  // ---------------------------------------------------------------- SAF 选择器

  private var pendingDirPick: CompletableDeferred<DirPickResult?>? = null
  private var pendingOpenDoc: CompletableDeferred<PickedDocument?>? = null
  private var pendingSaveDoc: CompletableDeferred<PickedDocument?>? = null
  /** saveDocument 待写入的内容（与 pendingSaveDoc 成对，结果回调里消费掉） */
  private var pendingSaveSource: SaveSource? = null

  private val pickDirectoryLauncher = registerForActivityResult(
    ActivityResultContracts.OpenDocumentTree(),
  ) { uri ->
    val deferred = pendingDirPick
    pendingDirPick = null
    if (uri == null) {
      deferred?.complete(null)
      return@registerForActivityResult
    }
    val realPath = SafPathResolver.resolvePrimaryTreePath(uri)
    if (realPath == null) {
      // 用户选了个解析不了的卷（SD 卡 / U 盘）。**不能返回 null** —— 那样上层会当成
      // 「用户取消」，用户点了却什么都没发生。用 EUNSUPPORTED + detail 标记，
      // JS 侧 `e.detail === 'UNSUPPORTED_VOLUME'` 就能给出「请换内部存储目录或复制到本机」的提示。
      val volume = SafPathResolver.volumeId(uri) ?: "unknown"
      Log.w(TAG, "unsupported SAF volume: $volume ($uri)")
      deferred?.completeExceptionally(
        PortException(
          PortErrorCode.EUNSUPPORTED,
          "目录所在存储卷暂不支持（volume=$volume）：目前只能扫描内部存储。请改选「内部存储」下的目录，或先复制到本机。",
          "UNSUPPORTED_VOLUME:$volume",
        ),
      )
      return@registerForActivityResult
    }
    deferred?.complete(
      DirPickResult(
        path = realPath,
        displayName = SafPathResolver.displayName(uri),
      ),
    )
  }

  private val openDocumentLauncher = registerForActivityResult(
    ActivityResultContracts.OpenDocument(),
  ) { uri ->
    val deferred = pendingOpenDoc
    pendingOpenDoc = null
    if (uri == null) {
      deferred?.complete(null)
      return@registerForActivityResult
    }
    // SAF 只能给 content://，但 JS 需要真实 path 才能走 FileSystemPort → 复制进 cache/import
    lifecycleScope.launch {
      val result = runCatching { copyIntoCache(uri) }.getOrNull()
      deferred?.complete(result)
    }
  }

  /**
   * `ACTION_CREATE_DOCUMENT` 的结果处理。
   *
   * 关键：**用户选好位置后由原生自己写入**，不把空 uri 丢回 JS。否则调用方忘记第二步，
   * 用户设备上就留一个 0 字节文件、还以为是导出成功（早期实现就是只有第一步）。
   */
  private val saveDocumentLauncher = registerForActivityResult(
    ActivityResultContracts.StartActivityForResult(),
  ) { result ->
    val deferred = pendingSaveDoc
    val source = pendingSaveSource
    pendingSaveDoc = null
    pendingSaveSource = null

    val uri = result.data?.data
    if (result.resultCode != android.app.Activity.RESULT_OK || uri == null || source == null) {
      deferred?.complete(null) // 用户取消
      return@registerForActivityResult
    }
    lifecycleScope.launch {
      val doc = withContext(Dispatchers.IO) {
        runCatching {
          val out = contentResolver.openOutputStream(uri)
            ?: throw PortException(PortErrorCode.EIO, "openOutputStream returned null: $uri")
          out.use { os ->
            when (source) {
              is SaveSource.Bytes -> os.write(source.data)
              is SaveSource.File -> File(source.path).inputStream().use { it.copyTo(os) }
            }
            os.flush()
          }
          PickedDocument(
            path = uri.toString(),
            name = SafPathResolver.displayName(uri),
            written = true,
          )
        }.getOrElse { e ->
          Log.e(TAG, "saveDocument write failed: ${e.message}", e)
          null
        }
      }
      if (doc == null) {
        deferred?.completeExceptionally(PortException(PortErrorCode.EIO, "写入目标文件失败（可能空间不足或已被删除）"))
      } else {
        deferred?.complete(doc)
      }
    }
  }

  private val notificationPermissionLauncher = registerForActivityResult(
    ActivityResultContracts.RequestPermission(),
  ) { granted ->
    Log.i(TAG, "POST_NOTIFICATIONS granted=$granted")
    if (!granted) {
      Toast.makeText(this, "未授予通知权限，播放控制将不会显示在通知栏", Toast.LENGTH_LONG).show()
    }
  }

  // ---------------------------------------------------------------- lifecycle

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    AppGraph.currentActivity = WeakReference(this)
    WindowCompat.setDecorFitsSystemWindows(window, false)

    rootLayout = FrameLayout(this)
    errorView = TextView(this).apply {
      text = getString(R.string.webview_load_failed)
      setPadding(48, 320, 48, 0)
      visibility = View.GONE
    }
    // 先放错误页、再把 WebView 插到 index 0：FrameLayout 后加的画在上面，
    // 于是错误页盖住 WebView 而不是被它盖住（重建时同样按这个叠放顺序插入）。
    rootLayout.addView(
      errorView,
      FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT,
      ),
    )
    setContentView(rootLayout)

    webView = createWebView()
    rootLayout.addView(
      webView,
      0,
      FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT,
      ),
    )
    webViewAttached = true

    installInsetsBridge(webView)
    bindPortsToActivity()
    setupBackHandling()
    requestCorePermissions()
    loadApp()
  }

  override fun onStart() {
    super.onStart()
    // 事件源头：JS 侧通过 `lifecycle.onForeground(cb)` 注册，Kotlin 持有回调名，
    // LifecycleHub 分发时由 LifecycleModule 转成 `[2, cbName, []]` 推回去。
    registry.lifecycle.dispatchForeground()
  }

  override fun onResume() {
    super.onResume()
    AppGraph.currentActivity = WeakReference(this)
    // D-31：息屏/后台久了，渲染进程可能已被系统回收。**有些机型不会回调
    // onRenderProcessGone**（或在页面已经进了错误页之后才回调），回来时 WebView
    // 停在 `chrome-error://chromewebdata`。本地 HTTP 服务在 Kotlin 侧、还活着，
    // 所以这里只要重新导航一次就能自愈，不必让用户去设置里强杀进程。
    val url = runCatching { webView.url }.getOrNull()
    if (url != null && url.startsWith(ERROR_PAGE_PREFIX)) {
      Log.w(TAG, "onResume: webview stuck on $url")
      recoverPage("onResume chrome-error")
    }
  }

  override fun onStop() {
    super.onStop()
    // onBackground 是 DB 强制 flush 的触发点（sql.js 无 WAL，靠这里收敛崩溃窗口）
    registry.lifecycle.dispatchBackground()
  }

  override fun onTrimMemory(level: Int) {
    super.onTrimMemory(level)
    registry.lifecycle.dispatchTrimMemory(level)
  }

  override fun onDestroy() {
    // beforeTerminate 要在 WebView 还活着时推，否则帧发不出去
    registry.lifecycle.dispatchBeforeTerminate()
    if (AppGraph.currentActivity?.get() === this) AppGraph.currentActivity = null
    webViewAttached = false
    runCatching {
      rootLayout.removeView(webView)
      webView.stopLoading()
      webView.destroy()
    }
    super.onDestroy()
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    // singleTask + 通知点击：回到前台即可，路由由 JS 处理
  }

  // ---------------------------------------------------------------- webview

  /**
   * 新建一个装配完毕的 WebView（D-31 的重建路径与 `onCreate` 共用这一处）。
   *
   * 为什么必须能"再建一个"：`onRenderProcessGone` 返回 `true` 之后，旧实例即不可再用
   * （再调任何方法都会抛），框架要求 app 自己把它从视图树摘掉、destroy，然后换一个新的。
   * 装配内容（设置 / 两个 client / JS 接口 / 背景色）只在这一个函数里写一份，
   * 避免"初建"和"重建"两套配置慢慢漂移 —— 这正是 D-31 修完之后最容易回归的地方。
   */
  private fun createWebView(): WebView {
    val wv = WebView(this)
    configureWebView(wv)
    wv.addJavascriptInterface(ensureBridge(), JS_INTERFACE_NAME)
    return wv
  }

  private fun configureWebView(wv: WebView) {
    val settings: WebSettings = wv.settings
    settings.javaScriptEnabled = true
    settings.domStorageEnabled = true
    settings.databaseEnabled = true
    settings.mediaPlaybackRequiresUserGesture = false
    settings.javaScriptCanOpenWindowsAutomatically = false
    // 音频能否在后台继续播是 A-01 的核心；下面两项保证 WebView 不因切后台立即挂起渲染
    settings.setSupportMultipleWindows(false)
    settings.cacheMode = WebSettings.LOAD_DEFAULT
    settings.allowFileAccess = false
    settings.allowContentAccess = false
    settings.allowFileAccessFromFileURLs = false
    settings.allowUniversalAccessFromFileURLs = false
    settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
    settings.loadsImagesAutomatically = true
    settings.blockNetworkImage = false

    // === 硬要求 1：禁止缩放与字体二级放大 ===
    settings.setSupportZoom(false)
    settings.builtInZoomControls = false
    settings.displayZoomControls = false
    settings.textZoom = 100

    // === 硬要求 2：不接管长按 ===
    // 不设置 setOnLongClickListener，也不把 isLongClickable 设为 false；
    // WebView 的默认长按会派发 contextmenu 给 JS（34 处右键菜单改造依赖它）。
    wv.isLongClickable = true
    wv.isHapticFeedbackEnabled = false

    wv.webViewClient = object : WebViewClient() {
      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val url = request.url
        // 本地服务与 about:blank 交给 WebView；其余交给系统浏览器（openUrl 语义）
        if (url.host == "127.0.0.1" || url.scheme == "about" || url.scheme == "data") return false
        if (url.scheme == "http" || url.scheme == "https") {
          lifecycleScope.launch { runCatching { registry.intent.openUrl(url.toString()) } }
          return true
        }
        return true
      }

      override fun onReceivedError(
        view: WebView,
        request: WebResourceRequest,
        error: WebResourceError,
      ) {
        // 只有主文档失败才显示错误页，子资源失败不该盖住 UI
        if (!request.isForMainFrame) return
        Log.e(TAG, "main frame error: ${error.errorCode} ${error.description}")
        errorView.visibility = View.VISIBLE
        // D-31：本地服务偶发不可达（进程被压到极限后 socket 关掉、或渲染进程刚重建）
        // 时自愈一次。**不无限重试** —— recoverPage 自带 60s/3 次的滑动窗口预算。
        if (request.url.host == "127.0.0.1") recoverPage("main frame error ${error.errorCode}")
      }

      override fun onPageFinished(view: WebView, url: String) {
        errorView.visibility = View.GONE
        // 新文档拿不到上一次注入的 CSS 变量，重推一遍已缓存的安全区
        if (lastInsetTopPx >= 0f) pushInsetsToPage(view, lastInsetTopPx, lastInsetBottomPx)
      }

      /**
       * D-31 主修点：渲染进程被系统回收（长时间息屏、后台被压内存、GPU 进程崩溃连带）。
       *
       * 两个必须知道的约束：
       * 1. **返回 `false` 会让系统直接杀掉整个 app 进程**（框架默认语义），所以这里返回 `true`
       *    表示"我自己处理"；
       * 2. 返回 `true` 之后旧实例就废了，必须立刻从视图树摘掉并 `destroy()`，再建新的 ——
       *    否则下一次触摸/求值就会抛 `Cannot use this WebView...`。
       *
       * 重建放到 `post{}` 里：回调发生在框架清理渲染进程的过程中，此时立刻 new 一个
       * WebView 有概率和内部状态打架（实测偶发 `AwContents` 空指针）；让出一帧再建最稳。
       */
      override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        Log.e(TAG, "onRenderProcessGone: didCrash=${detail.didCrash()} exitStatus=${detail.rendererPriorityAtExit()}")
        if (isFinishing || isDestroyed) return true
        rootLayout.post { rebuildWebView("renderer gone (crash=${detail.didCrash()})") }
        return true
      }
    }

    wv.webChromeClient = object : WebChromeClient() {
      override fun onConsoleMessage(message: android.webkit.ConsoleMessage): Boolean {
        val level = when (message.messageLevel()) {
          android.webkit.ConsoleMessage.MessageLevel.ERROR -> com.anylisten.ports.log.LogLevel.ERROR
          android.webkit.ConsoleMessage.MessageLevel.WARNING -> com.anylisten.ports.log.LogLevel.WARN
          android.webkit.ConsoleMessage.MessageLevel.DEBUG -> com.anylisten.ports.log.LogLevel.DEBUG
          else -> com.anylisten.ports.log.LogLevel.INFO
        }
        registry.log.write(level, "webview", "${message.message()} @${message.sourceId()}:${message.lineNumber()}")
        return true
      }

      override fun onPermissionRequest(request: android.webkit.PermissionRequest) {
        // 本项目不需要摄像头/麦克风；显式拒绝，避免 AppOps 记录异常请求
        request.deny()
      }
    }
    wv.setBackgroundColor(0xFF101014.toInt())
  }

  /**
   * 渲染进程死亡后的重建（D-31）。
   *
   * 顺序不能变：**先摘视图、再 destroy、最后才 new**。反过来会在部分 ROM 上触发
   * `IllegalStateException: Cannot create a WebView while another is being destroyed`。
   *
   * 同时清掉 `lifecycle` 的订阅：那四个列表是"注册即追加"的，JS 每次重载都会再注册一遍，
   * 不清就会按"重建次数"线性叠加（`onBeforeTerminate` 里的 DB flush 被调 N 次）。
   * 其余订阅（mediaSession / audio focus / theme）的回调名是每页随机生成的，
   * 旧名字在新页面里查不到，桥接层直接 `console.warn` 丢弃，不会重复触发业务逻辑 —— 故不在此清理。
   */
  private fun rebuildWebView(reason: String) {
    if (isFinishing || isDestroyed) return
    if (rebuilding) return
    rebuilding = true
    Log.w(TAG, "rebuildWebView: $reason")

    webViewAttached = false
    runCatching {
      rootLayout.removeView(webView)
      webView.stopLoading()
      webView.destroy()
    }.onFailure { Log.w(TAG, "destroy of the dead webview failed: ${it.message}") }

    registry.lifecycle.clear()
    lastInsetTopPx = -1f
    lastInsetBottomPx = -1f

    val fresh = createWebView()
    webView = fresh
    rootLayout.addView(
      fresh,
      0,
      FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT,
      ),
    )
    webViewAttached = true
    installInsetsBridge(fresh)
    errorView.visibility = View.GONE

    fresh.post {
      loadApp()
      rebuilding = false
    }
  }

  /**
   * 页面自愈：重新导航到本地服务（D-31 的 `chrome-error://` 场景）。
   *
   * 预算用**滑动窗口**而不是计数器：60s 内最多 3 次。窗口式的好处是成功后不需要
   * 任何"复位"动作（复位点漏一个就会变成永久不重试），而失败时也不会无限刷。
   */
  private fun recoverPage(reason: String) {
    if (isFinishing || isDestroyed || !webViewAttached) return
    val now = SystemClock.elapsedRealtime()
    while (reloadTimestamps.isNotEmpty() && now - reloadTimestamps.first() > RELOAD_WINDOW_MS) {
      reloadTimestamps.removeFirst()
    }
    if (reloadTimestamps.size >= MAX_RELOADS_PER_WINDOW) {
      Log.e(TAG, "recoverPage($reason) skipped: reload budget exhausted")
      return
    }
    // 同一批错误会连着来好几条（主文档 + 关键子资源），去抖掉重复触发
    if (now - (reloadTimestamps.lastOrNull() ?: 0L) < RELOAD_DEBOUNCE_MS) return
    reloadTimestamps.addLast(now)
    Log.w(TAG, "recoverPage: $reason (${reloadTimestamps.size}/$MAX_RELOADS_PER_WINDOW)")
    errorView.visibility = View.GONE
    webView.postDelayed({ if (webViewAttached) loadApp() }, RELOAD_DELAY_MS)
  }

  /**
   * 桥只建一次：`AndroidBridge` 的模块注册、协程作用域都是进程级的。
   *
   * `sender` 内部引用的是 `webView` **字段**而不是某个具体实例 —— 重建后字段指向新实例，
   * 帧自然发到新页面；`webViewAttached` 挡掉重建窗口内的在途帧（此时调 evaluateJavascript
   * 会抛），这类帧本来也没有接收方（旧页面已经没了）。
   */
  private fun ensureBridge(): AndroidBridge {
    bridgeRef?.let { return it }
    val created = AndroidBridge(
      registry = registry,
      tokenProvider = { AppGraph.token },
      debugEnabled = BuildConfig.DEBUG,
      sender = FrameSender { frameJson ->
        // 回到主线程；用 JSON 字面量注入，避免帧内的引号破坏 evaluateJavascript。
        // 函数名是**硬约定**：`porting/js/ports/bridge-client.ts` 的
        // `installBridgeReceiver()` 挂的就是 `window.__anylisten_bridge_recv__`，改了两边都收不到。
        runOnUiThread {
          if (!webViewAttached) return@runOnUiThread
          val literal = org.json.JSONObject.quote(frameJson)
          runCatching {
            webView.evaluateJavascript(
              "window.__anylisten_bridge_recv__ && window.__anylisten_bridge_recv__($literal)",
              null,
            )
          }.onFailure { Log.w(TAG, "frame drop: ${it.message}") }
        }
      },
    )
    bridgeRef = created
    Log.i(TAG, "bridge installed, modules=${created.registeredModules()}")
    return created
  }

  private fun bindPortsToActivity() {
    registry.bindUiPorts(
      directoryPicker = object : DirectoryPicker {
        override suspend fun pickDirectory(title: String?): DirPickResult? {
          val deferred = CompletableDeferred<DirPickResult?>()
          pendingDirPick = deferred
          pickDirectoryLauncher.launch(null)
          return deferred.await()
        }
      },
      documentPicker = object : DocumentPicker {
        override suspend fun openDocument(mime: List<String>): PickedDocument? {
          val deferred = CompletableDeferred<PickedDocument?>()
          pendingOpenDoc = deferred
          openDocumentLauncher.launch(mime.toTypedArray())
          return deferred.await()
        }

        override suspend fun saveDocument(
          suggestName: String,
          mime: String,
          source: SaveSource?,
        ): PickedDocument? {
          if (source == null) {
            // 兼容旧调用（没给内容）：只在私有 exports 目录占一个路径，由调用方自己后续写入。
            // 新代码不要走这条 —— 返回值里 written=false 就是提示。
            val dir = File(filesDir, "exports").apply { if (!exists()) mkdirs() }
            return PickedDocument(File(dir, suggestName).absolutePath, suggestName, written = false)
          }
          val deferred = CompletableDeferred<PickedDocument?>()
          pendingSaveDoc = deferred
          pendingSaveSource = source
          // 用 StartActivityForResult + 手写 intent，而不是 CreateDocument(mime)：
          // mime 是每次调用动态传入的，CreateDocument 在构造期就把 type 定死了。
          saveDocumentLauncher.launch(
            Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
              addCategory(Intent.CATEGORY_OPENABLE)
              type = mime
              putExtra(Intent.EXTRA_TITLE, suggestName)
            },
          )
          return deferred.await()
        }
      },
      foregroundServiceController = object : com.anylisten.ports.power.ForegroundServiceController {
        override fun start(action: String) {
          PlaybackService.start(this@MainActivity, action)
        }

        override fun stop() {
          stopService(Intent(this@MainActivity, PlaybackService::class.java))
        }
      },
    )
  }

  private fun installInsetsBridge(wv: WebView) {
    ViewCompat.setOnApplyWindowInsetsListener(wv) { view, windowInsets ->
      // 重建后旧实例的监听器可能还会收到一次 insets；此时 `webView` 已指向新实例，
      // 往里推等于往新页面注入旧窗口的值。直接放行，不消费。
      if (view !== webView) return@setOnApplyWindowInsetsListener windowInsets
      val bars = windowInsets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
      )
      val density = resources.displayMetrics.density
      val topDp = bars.top / density
      val bottomDp = bars.bottom / density
      if (topDp != lastInsetTopPx || bottomDp != lastInsetBottomPx) {
        lastInsetTopPx = topDp
        lastInsetBottomPx = bottomDp
        pushInsetsToPage(view, topDp, bottomDp)
      }
      // **不能 consume**：WebView 自己还要拿 insets 算 `env(safe-area-inset-top)` 与视口
      windowInsets
    }
    wv.requestApplyInsets()
  }

  /**
   * 把安全区以 CSS px 推给页面（契约见 `porting/js/ui/boot/insets.ts`）。
   *
   * 为什么要写 `__anylisten_pendingInsets__`：insets 通常在本文档 JS 还没求值时
   * 就派发过一次，那次调用必然落空；记下最近值让页面装配好钩子后能补应用。
   *
   * `target` 显式传入而不是用 `webView` 字段：D-31 重建后两个实例会短暂共存，
   * 往错的实例求值会抛 "Cannot use this WebView after it has been destroyed"。
   */
  private fun pushInsetsToPage(target: WebView, topDp: Float, bottomDp: Float) {
    if (!webViewAttached || target !== webView) return
    val js = "window.__anylisten_pendingInsets__=[$topDp,$bottomDp];" +
      "window.__anylisten_applyInsets__&&window.__anylisten_applyInsets__($topDp,$bottomDp)"
    runOnUiThread { runCatching { target.evaluateJavascript(js, null) } }
  }

  private fun loadApp() {
    if (!AppGraph.ensureHttpServerStarted()) {
      errorView.text = "本地服务启动失败：${AppGraph.httpServer.lastError ?: "未知错误"}"
      errorView.visibility = View.VISIBLE
      return
    }
    val url = "${AppGraph.httpServer.baseUrl}/?t=${AppGraph.token}"
    Log.i(TAG, "loading $url")
    webView.loadUrl(url)
  }

  // ---------------------------------------------------------------- back handling

  /**
   * 返回键（uiux D-07）：**每次按下都现问一次 JS**，不做任何缓存。
   *
   * 早先版本把「能否回退」缓存在 `canGoBackCached` 里，只在 `onPageFinished` 与一次返回后刷新。
   * 而 SPA 只加载一次页面 —— 那份缓存永远停在首帧的 `false`，于是**不管在哪个页面按返回，
   * 都会走到"再按一次退出"的分支**（P1-1）。省下的那次 evaluate 往返（实测 5–20ms）
   * 换不来这个代价，缓存整个删掉。
   *
   * JS 契约见 `porting/js/ui/boot/androidBack.ts`：`__anylisten_goBack__()` 返回 `true` 表示
   * 它已经处理（压栈后退），返回 `false` 表示已到栈底、该由原生退出。
   * 若 JS 没装（占位 SPA），退化成 `history.length > 1` + `history.back()`，至少不整体失效。
   *
   * 为什么把「问」和「做」合并进一次 evaluate：分两次要串行等两个回调，
   * 手感上会多出约 120ms 的空窗；合并后只有一次往返。
   */
  private fun setupBackHandling() {
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        webView.evaluateJavascript(JS_BACK) { result ->
          if (result?.trim('"') != "handled") confirmExit()
        }
      }
    })
  }

  /** 二次返回退出（spec §9.7：不堆历史，最多一次确认） */
  private fun confirmExit() {
    val now = System.currentTimeMillis()
    if (now - lastBackAt < 2000) {
      finish()
      return
    }
    lastBackAt = now
    Toast.makeText(this@MainActivity, R.string.toast_press_again_to_exit, Toast.LENGTH_SHORT).show()
  }

  // ---------------------------------------------------------------- permissions

  private fun requestCorePermissions() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
        notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
      }
    }
    // 本地音乐库：Android 11+ 需要「所有文件访问」；API 29 走 requestLegacyExternalStorage
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && !Environment.isExternalStorageManager()) {
      showAllFilesRationale()
    }
  }

  private fun showAllFilesRationale() {
    android.app.AlertDialog.Builder(this)
      .setTitle(R.string.permission_all_files_title)
      .setMessage(R.string.permission_all_files_message)
      .setPositiveButton(R.string.permission_go_settings) { _, _ ->
        openAllFilesAccessSettings()
      }
      .setNegativeButton(R.string.permission_cancel, null)
      .show()
  }

  private fun openAllFilesAccessSettings() {
    val candidates = listOf(
      Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:$packageName")),
      Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION),
      Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")),
    )
    for (intent in candidates) {
      val resolved = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        packageManager.resolveActivity(intent, PackageManager.ResolveInfoFlags.of(0))
      } else {
        @Suppress("DEPRECATION")
        packageManager.resolveActivity(intent, 0)
      }
      if (resolved != null) {
        runCatching { startActivity(intent) }
        return
      }
    }
    Toast.makeText(this, "无法打开权限设置页，请在系统设置中手动授予", Toast.LENGTH_LONG).show()
  }

  // ---------------------------------------------------------------- helpers

  private suspend fun copyIntoCache(uri: Uri): PickedDocument? {
    val name = queryDisplayName(uri) ?: "import-${System.currentTimeMillis()}"
    val dir = File(cacheDir, "import").apply { if (!exists()) mkdirs() }
    val target = File(dir, name)
    contentResolver.openInputStream(uri)?.use { input ->
      target.outputStream().use { output -> input.copyTo(output, 64 * 1024) }
    } ?: return null
    return PickedDocument(path = target.absolutePath, name = name)
  }

  private fun queryDisplayName(uri: Uri): String? {
    if (uri.scheme != "content") return uri.lastPathSegment
    return runCatching {
      contentResolver.query(uri, null, null, null, null)?.use { cursor ->
        val index = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
        if (index >= 0 && cursor.moveToFirst()) cursor.getString(index) else null
      }
    }.getOrNull()
  }

  private companion object {
    const val TAG = "AnyListen/Main"

    /** JS 侧 `bridge-client.ts` 约定的全局对象名，改了两边都收不到 */
    const val JS_INTERFACE_NAME = "AndroidBridge"

    /** WebView 内置错误页的 URL 前缀（D-31 的判据） */
    const val ERROR_PAGE_PREFIX = "chrome-error"

    /** 自愈重载预算：60s 内最多 3 次 */
    const val RELOAD_WINDOW_MS = 60_000L
    const val MAX_RELOADS_PER_WINDOW = 3
    const val RELOAD_DEBOUNCE_MS = 1_500L
    const val RELOAD_DELAY_MS = 400L

    /**
     * 返回键表达式。返回值只有两种：`handled`（JS 已处理）与 `root`（已到根，交回原生）。
     * 注意 `evaluateJavascript` 回调拿到的是 JSON 字面量，字符串会带双引号，调用方要 trim。
     */
    const val JS_BACK =
      "(function(){try{" +
        "if(typeof window.__anylisten_goBack__==='function')return window.__anylisten_goBack__()?'handled':'root';" +
        "if(window.history.length>1){history.back();return 'handled'}" +
        "return 'root'}catch(e){return 'root'}})()"
  }
}
