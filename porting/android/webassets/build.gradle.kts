import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
  alias(libs.plugins.android.library)
  alias(libs.plugins.kotlin.android)
}

android {
  namespace = "com.anylisten.webassets"
  compileSdk = 35

  defaultConfig {
    minSdk = 29
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  buildFeatures {
    buildConfig = false
  }
}

kotlin {
  compilerOptions {
    jvmTarget.set(JvmTarget.JVM_17)
  }
}

/**
 * 本模块没有源码，只有两个 Gradle 任务：
 *  - `syncWebAssets`：调用 pnpm 构建 `porting/js`，把产物拷进 `:app` 的 `assets/web/spa`
 *
 * 设计要点（任务书要求「优雅跳过」）：
 *  1. `porting/js` 由 fullstack 并行开发，可能还没跑通 `vite build` → **产物不存在时只警告不失败**；
 *  2. 产物不存在时用仓库内的占位 SPA（[PLACEHOLDER_DIR]）顶替，保证 `assembleDebug` 独立可跑；
 *  3. `-PskipWeb=true` 完全跳过 pnpm（CI 只验原生壳时用）；
 *  4. 不把产物写进 VCS（见 .gitignore）。
 */
val projectRoot = rootProject.projectDir                 // porting/android
val jsProjectDir = projectRoot.resolve("../js")          // porting/js
val jsDistDir = jsProjectDir.resolve(providers.gradleProperty("jsDistDir").orElse("dist").get())
val placeholderDir = projectDir.resolve("placeholder")
val appWebAssetsDir = projectRoot.resolve("app/src/main/assets/web")
val targetSpaDir = appWebAssetsDir.resolve("spa")

val skipWeb = providers.gradleProperty("skipWeb").map { it.toBoolean() }.orElse(false)
if (providers.gradleProperty("jsDistDir").isPresent && !skipWeb.get()) {
  throw GradleException("自定义 jsDistDir 必须配合 -PskipWeb=true，并事先完成前端构建")
}

/**
 * `-PcleanJsDist=true`：跑 pnpm 之前先删掉 `porting/js/dist`。
 *
 * 为什么需要：`vite build` 的 `outDir` 不清空，每次 `pnpm build:all` 都会把**一整套新的 hash
 * 产物追加**到 `dist/spa/assets`，而 `index.html` 只引用最新那一套 —— 旧的 `index-*.js`/
 * `main.*.js`/各个 parser chunk 全是死文件。实测连续构建两次后 `dist/spa/assets` 有 188 个文件、
 * APK 从 17MB 涨到 20MB+，其中 ~11.5MB 是这类冗余（见 `syncWebAssets` 的体积体检日志）。
 *
 * 默认 **关**：dist 是 fullstack 的产物目录，原生侧不擅自删；等 JS 侧的 build 脚本自己
 * `rimraf dist`（或给每个入口配独立 outDir）之后这个开关就永久不需要了。
 */
val cleanJsDist = providers.gradleProperty("cleanJsDist").map { it.toBoolean() }.orElse(false)

/**
 * `-PrequireWeb=true`：产物缺失时**直接失败**，而不是静默降级成占位 SPA。
 *
 * 交付/装机用的包必须带真实前端，否则装上去是白屏，而且 APK 体积会小得「看起来很好」
 * （实测占位包 988 KB）。日常开发保持默认 false（占位包能跑桥，不卡构建）。
 */
val requireWeb = providers.gradleProperty("requireWeb").map { it.toBoolean() }.orElse(false)

/**
 * `-PskipWebCheck=true`：把「引用一致性校验」降级为 warn。
 *
 * 默认 **关**（校验生效并 fail）。只在明确知道产物不一致、又急着验原生侧别的东西时临时用；
 * 用它构建出来的包装机大概率白屏。
 */
val skipWebCheck = providers.gradleProperty("skipWebCheck").map { it.toBoolean() }.orElse(false)

val isWindows = System.getProperty("os.name").lowercase().contains("win")

// 独立任务，而不是 buildWebJs 的 doFirst 里 delete()：
// Exec 任务执行期直接删目录会和 Gradle 的文件监听/并行任务抢句柄，
// 实测报 "New files were found. This might happen because a process is still writing"。
val cleanJsDistTask = tasks.register<Delete>("cleanJsDist") {
  group = "webassets"
  description = "删除 porting/js/dist（仅 -PcleanJsDist=true 时生效）"
  delete(jsDistDir)
  onlyIf { cleanJsDist.get() }
}

tasks.register<Exec>("buildWebJs") {
  group = "webassets"
  description = "在 porting/js 里执行 pnpm build:all（产物缺失/依赖未装时跳过，不使构建失败）"
  workingDir = jsProjectDir
  onlyIf {
    if (skipWeb.get()) {
      logger.lifecycle("[webassets] -PskipWeb=true -> skip JS build")
      return@onlyIf false
    }
    val pkg = jsProjectDir.resolve("package.json")
    if (!pkg.exists()) {
      logger.warn("[webassets] package.json not found at ${pkg.path} -> skip JS build (placeholder SPA will be used)")
      return@onlyIf false
    }
    if (!jsProjectDir.resolve("node_modules").exists()) {
      logger.warn("[webassets] porting/js/node_modules missing -> skip JS build (run `pnpm install`; placeholder SPA will be used)")
      return@onlyIf false
    }
    true
  }
  if (isWindows) {
    commandLine("cmd", "/c", "pnpm", "run", "build:all")
  } else {
    commandLine("pnpm", "run", "build:all")
  }
  // JS 侧由 fullstack 并行开发，可能正处于半成品状态：
  // 失败不阻断原生构建（否则 native 侧被 JS 的中间态卡死），但必须**大声**告警。
  isIgnoreExitValue = true
  dependsOn(cleanJsDistTask)
  doLast {
    val code = executionResult.get().exitValue
    if (code != 0) {
      logger.warn(
        "[webassets] pnpm build:all exited with code $code -- frontend artifacts may be incomplete. " +
          "Using whatever already exists in dist (placeholder SPA if none). This is NOT a native-side failure.",
      )
    }
  }
}

tasks.register<Sync>("syncWebAssets") {
  group = "webassets"
  description = "把 porting/js/dist 的产物同步到 app/src/main/assets/web/spa（缺失时放占位 SPA）"
  dependsOn("buildWebJs")

  into(targetSpaDir)
  // 占位与真实产物会有同名文件（index.html）；按 from 顺序覆盖，后加入的 dist 生效
  duplicatesStrategy = DuplicatesStrategy.INCLUDE

  // 1) 占位 SPA 始终先拷：产物存在时会被 dist 里的同名文件覆盖，产物不存在时它就是首屏
  from(placeholderDir)

  // 2) 真实产物。dist 的布局是 dist/spa/**（SPA 本体）+ 可选的 dist/wasm、dist/extension-preload.js。
  //    统一拍平到 assets/web/spa 下，保证 SPA 里的相对路径（./assets/xxx.js、./wasm/*.wasm）可直接命中。
  if (jsDistDir.resolve("spa").isDirectory) {
    from(jsDistDir.resolve("spa")) {
      // sourcemap 只对桌面调试有用，打进 APK 白占 3–5MB
      exclude("**/*.map", "**/*.ts")
    }
  }
  if (jsDistDir.isDirectory) {
    from(jsDistDir) {
      // 这里是把 dist 根「拍平」进 assets/web/spa，凡是 dist 根出现的东西都会被原样带走，
      // 所以必须挡死垃圾区：vite 清目录失败时的兜底会把旧产物改名成 `spa.old.<ts>`，
      // 实测被这份 flat copy 塞进 APK 89 个文件 / 26MB（`assets/web/spa/spa.old.1793678981054`）。
      // 无论谁在 dist 根放临时/备份目录，都不该进包。
      exclude(
        "spa/**",
        // 兜底：`spa` 的变体目录（`spa.old.<ts>`、以及任何手工 copy 出来的 `spa.xxx`）都不是合法产物。
        // 实测把 dist/spa 临时改名成 dist/spa.__f5test 做缺产物演练时，`spa/**` 匹配不到它，
        // 整个目录被拍平进 assets/web/spa 当垃圾带走 —— 排除规则要按「spa 前缀」而不是精确名。
        "spa.*/**",
        "**/*.map",
        "**/*.old.*",
        "**/.trash/**",
        // `pnpm` 的 smoke 测试脚本会落到 dist/smoke/smoke.mjs（Node 脚本，不是运行时资源）
        "smoke/**",
        "**/.DS_Store",
      )
    }
  }

  onlyIf {
    if (!jsDistDir.isDirectory) {
      logger.warn(
        "[webassets] ${jsDistDir.path} does not exist -> placeholder SPA. The APK installs and the bridge works, " +
          "but there is no real UI. Re-run ./gradlew :app:assembleDebug once porting/js builds successfully.",
      )
    }
    // 最容易踩的坑：`Sync` 会把 assets/web/spa 与「当前 dist」对齐。JS 侧 `pnpm build:all` 一开跑就先
    // `clean:spa`，如果这时原生侧刚好在构建，`dist/spa` 不在 → 占位 SPA 覆盖掉整套真实产物，
    // 得到一个小得可疑的 APK（实测 988 KB），装机白屏，而且构建日志里只有一条容易被忽略的 warn。
    if (!jsDistDir.resolve("spa").isDirectory) {
      val existing = if (targetSpaDir.isDirectory) {
        targetSpaDir.walkTopDown().filter { it.isFile }.count()
      } else {
        0
      }
      val placeholderFiles = if (placeholderDir.isDirectory) {
        placeholderDir.walkTopDown().filter { it.isFile }.count()
      } else {
        0
      }
      /* `-PrequireWeb=true` 的判定必须在 `existing > placeholderFiles` **之外**（F-5）。
       *
       * 原来 throw 写在那个 if 里面，导致两种场景静默通过：
       *   1) 干净检出：`targetSpaDir` 还没有任何文件 → existing=0，`0 > 1` 为假 → 不抛；
       *   2) 之前被打成过占位包：existing=1 == placeholderFiles → `1 > 1` 为假 → 不抛，
       *      而且此后**永久失效**（占位包自己把 existing 钉在 1，条件再也不会成立）。
       * 也就是说这个"防白屏包"的开关在最需要它的时候（干净环境 / 已污染环境）恰好不生效。
       * `requireWeb` 的语义就是"产物必须真实存在"，与目标目录当前有什么无关，所以判定独立。 */
      if (requireWeb.get()) {
        val extra = if (existing > placeholderFiles) {
          " (target currently holds $existing real files that this sync would have replaced with the placeholder)"
        } else {
          ""
        }
        val msg = "[webassets] -PrequireWeb=true but ${jsDistDir.resolve("spa").path} does not exist; " +
          "refusing to package the placeholder SPA (installs to a blank screen / stuck at Loading...). " +
          "Run `pnpm -C ../../js build:all` to completion, then rebuild." + extra
        // Gradle 会把 onlyIf 里抛的异常包成「Could not evaluate onlyIf predicate」，真正的
        // 原因只在 --stacktrace 里才看得到 —— 门禁失败的输出必须自己说明原因，所以先 error 一行。
        logger.error(msg)
        throw GradleException(msg)
      }
      if (existing > placeholderFiles) {
        val msg = "[webassets] dist/spa is missing while ${targetSpaDir.path} still holds $existing files of " +
          "REAL artifacts. This sync will replace them with the placeholder SPA (no UI!). " +
          "Most likely `pnpm build:all` is running right now and already deleted dist/spa -- " +
          "never build the APK while the JS build is in flight."
        logger.warn(msg)
      }
    }
    true
  }

  doLast {
    val indexPath = targetSpaDir.resolve("index.html")
    if (!indexPath.exists()) {
      throw GradleException("[webassets] no index.html after sync; check placeholder dir: ${placeholderDir.path}")
    }
    logger.lifecycle("[webassets] web assets synced to ${targetSpaDir.path}")

    // ---- 引用一致性校验（真机白屏的根因就是这个，所以是 fail 而不是 warn）---------------
    // 事故现场：index.html / main.js 来自一次完整构建，但 worker 只写出一半时就被 sync 了 ——
    // 包里缺 core.worker-* / db.worker-*，`new Worker()` 404 后 event.message 是 undefined，
    // UI 永远停在 Loading...，日志只有一句「core worker 崩溃 undefined undefined」。
    // 这种「引用存在、实体不在」的错在打包阶段完全看不出来，所以这里逐条对账：
    //   1) index.html 引用的入口 js 必须在；
    //   2) 入口 + 各 worker 里提到的所有 `*.worker-<hash>.js` 必须在；
    //   3) 反过来，没有任何文件引用的 worker 是上一代残留，报出来（不失败）。
    val spaAssetsDir = targetSpaDir.resolve("assets")
    if (spaAssetsDir.isDirectory) {
      // 递归扫：vite 目前把 chunk 平铺在 assets/ 下，但换成 assets/chunks/ 之类也不必改这里
      val jsFiles = spaAssetsDir.walkTopDown().filter { it.isFile && it.name.endsWith(".js") }.toList()
      val workerNameRegex = Regex("""([A-Za-z0-9_$][A-Za-z0-9_$.-]*worker-[A-Za-z0-9_-]{8}\.js)""")
      val presentWorkers = jsFiles.map { it.name }.filter { workerNameRegex.matches(it) }.toSet()

      // 入口：优先取 index.html 里 <script src>，拿不到再回落到 main.<hash>.js
      val entryNames = Regex("""<script[^>]+src="([^"]+\.js)"""")
        .findAll(indexPath.readText())
        .map { it.groupValues[1].substringAfterLast('/') }
        .filter { it.isNotBlank() }
        .toList()
        .ifEmpty {
          jsFiles.map { it.name }.filter { Regex("""^main\.[A-Za-z0-9_-]{8}\.js$""").matches(it) }
        }

      if (entryNames.isNotEmpty()) {
        val jsByName = jsFiles.associateBy { it.name }
        val missingEntries = entryNames.filterNot { jsByName.containsKey(it) }
        // 入口 + 所有 worker 都可能再引用别的 worker，整体扫一遍引用
        val referenced = sortedSetOf<String>()
        var preloadReferenced = false
        jsFiles.forEach { f ->
          runCatching { f.readText() }.getOrNull()?.let { text ->
            workerNameRegex.findAll(text).forEach { referenced.add(it.groupValues[1]) }
            if (text.contains("extension-preload/extension-preload.js")) preloadReferenced = true
          }
        }
        val missingWorkers = (referenced - presentWorkers).sorted()
        val orphanWorkers = (presentWorkers - referenced).sorted()
        // extension-preload：JS 侧 `fetch('/extension-preload/extension-preload.js')` 是硬依赖
        // （LocalHttpServer 走 handleStatic 提供），缺了 core worker 会报「preload 加载失败：HTTP 404」
        val preloadRelPath = "extension-preload/extension-preload.js"
        val missingPreload = preloadReferenced && !targetSpaDir.resolve(preloadRelPath).isFile

        if (missingEntries.isNotEmpty() || missingWorkers.isNotEmpty() || missingPreload) {
          val msg = buildString {
            append("[webassets] INCONSISTENT web assets -- the APK would show a blank screen (stuck at Loading...).\n")
            append("  entries referenced by index.html: ${entryNames.joinToString()}\n")
            if (missingEntries.isNotEmpty()) append("  MISSING entries: ${missingEntries.joinToString()}\n")
            if (missingWorkers.isNotEmpty()) append("  MISSING workers: ${missingWorkers.joinToString()}\n")
            if (missingPreload) append("  MISSING asset: $preloadRelPath (referenced by the SPA bundle)\n")
            append("  present workers: ${presentWorkers.sorted().joinToString().ifEmpty { "(none)" }}\n")
            append("  Cause: `porting/js/dist` was captured mid-build (pnpm build:all empties dist/spa first).\n")
            append("  Fix: run `pnpm -C ../../js build:all` to completion, then rebuild the APK.")
          }
          if (skipWebCheck.get()) {
            logger.warn("$msg\n  (-PskipWebCheck=true -> downgraded to warning)")
          } else {
            throw GradleException(msg)
          }
        } else {
          logger.lifecycle(
            "[webassets] reference check OK: ${entryNames.size} entry / ${presentWorkers.size} worker, " +
              "${referenced.size} worker references" + if (preloadReferenced) ", extension-preload ok" else "",
          )
        }
        if (orphanWorkers.isNotEmpty()) {
          logger.warn(
            "[webassets] unreferenced worker files (leftover from a previous build?): ${orphanWorkers.joinToString()}. " +
              "Nothing references them, they only inflate the APK; `pnpm -C ../../js build:all` should clean dist first.",
          )
        }
      }
    }

    // 防御性体检：dist 根**只该**有 spa/ 与 extension-preload(/)。收到其他条目就要警觉 ——
    // dist 根是被拍平拷进 assets/web/spa 的，历史事故：vite 清目录兜底把旧产物改名成
    // `dist/spa.old.<ts>`，89 个文件 / 26MB 原样进了 APK。上面已按 `**/*.old.*`、`.trash/**`
    // 挡掉已知形态，但任何**新命名**的临时目录仍会被拷进去，所以这里报出来。
    if (jsDistDir.isDirectory) {
      val allowedRootEntries = setOf("spa", "extension-preload", "extension-preload.js")
      val unexpected = jsDistDir.listFiles()
        ?.filterNot { it.name in allowedRootEntries }
        ?.sortedByDescending { it.length() }
        .orEmpty()
      if (unexpected.isNotEmpty()) {
        val detail = unexpected.joinToString { e ->
          val size = if (e.isDirectory) {
            e.walkTopDown().filter { it.isFile }.sumOf { it.length() }
          } else {
            e.length()
          }
          "${e.name} (${"%.1f".format(size / 1048576.0)} MB)"
        }
        logger.warn(
          "[webassets] unexpected entries in dist root: $detail. `dist` root is flattened into " +
            "assets/web/spa, so a temp/backup dir here ends up inside the APK. Known junk patterns " +
            "(*.old.*, .trash/) are excluded; anything else must be moved outside dist by the JS build.",
        )
      }
    }

    // 体积体检：APK 里 ~20MB 都是这块，出问题要能在构建日志里第一眼看到。
    // 顺手统计「同内容不同 hash」的重复产物（vite 多入口写同一 outDir 且未清空时会这样），
    // 这类文件对运行没有任何用，纯占 APK 体积。
    val files = targetSpaDir.walkTopDown().filter { it.isFile }.toList()
    val totalBytes = files.sumOf { it.length() }
    val hashSuffix = Regex("-[A-Za-z0-9_-]{8}(\\.[A-Za-z0-9]+)$")
    val groups = files.groupBy { it.name.replace(hashSuffix, "$1") }
    val dupGroups = groups.filter { it.value.size > 1 }
    val redundantBytes = dupGroups.values.sumOf { g -> g.drop(1).sumOf { it.length() } }
    logger.lifecycle(
      "[webassets] web assets: ${files.size} files / ${"%.1f".format(totalBytes / 1048576.0)} MB",
    )
    if (redundantBytes > 0) {
      logger.warn(
        "[webassets] ${dupGroups.size} duplicate artifact groups (same content, different hash), ~" +
          "${"%.1f".format(redundantBytes / 1048576.0)} MB wasted (e.g. ${dupGroups.keys.take(3).joinToString()}). " +
          "Cause: porting/js vite emits into an outDir that is not emptied.",
      )
    }
  }
}
