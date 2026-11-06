import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.kotlin.android)
}

android {
  namespace = "com.anylisten.app"
  compileSdk = 35

  defaultConfig {
    applicationId = "com.anylisten.android"
    minSdk = 29
    targetSdk = 35
    versionCode = 1
    versionName = "1.0.0-android.1"

    // PDR-008：仅 arm64-v8a（用户自用机为骁龙 8 Gen2）。多 ABI 只会让包体翻倍。
    ndk {
      abiFilters += "arm64-v8a"
    }

    // 资源裁剪：只保留中文与英文，其余语言不打进包
    resourceConfigurations += listOf("zh", "en")

    // 明文流量策略：默认严格，只放行回环地址、Online Metadata 和用户 LX 源的精确主机
    // （逐条列在 res/xml/network_security_config.xml，无通配、无 includeSubdomains）。
    // `-PallowCleartext=true` 切到宽松配置，仅用于「用户在线音源是 http」的临时排查/自用场景。
    // 用 manifestPlaceholders 而不是覆盖同名资源：两个 XML 同时存在于 res/xml，由 manifest 选一个。
    val allowCleartext = providers.gradleProperty("allowCleartext")
      .map { it.toBoolean() }
      .orElse(false)
    manifestPlaceholders["networkSecurityConfig"] = if (allowCleartext.get()) {
      "@xml/network_security_config_loose"
    } else {
      "@xml/network_security_config"
    }
  }

  buildTypes {
    debug {
      isMinifyEnabled = false
      applicationIdSuffix = ""
    }
    release {
      isMinifyEnabled = true
      isShrinkResources = true
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
      // 个人自用不分发（PDR-003）；debug 签名即可安装。真发布前再补 release keystore。
      signingConfig = signingConfigs.getByName("debug")
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  buildFeatures {
    buildConfig = true
  }

  packaging {
    resources {
      excludes += setOf(
        "/META-INF/{AL2.0,LGPL2.1}",
        "/META-INF/DEPENDENCIES",
        "/META-INF/versions/9/previous-compilation-data.bin",
      )
    }
  }

  lint {
    // Phase 4 目标是"构建通过"；lint 报告留待 Phase 5 逐条收敛
    abortOnError = false
  }
}

kotlin {
  compilerOptions {
    jvmTarget.set(JvmTarget.JVM_17)
  }
}

dependencies {
  implementation(project(":bridge"))
  implementation(project(":core-ports"))

  implementation(libs.androidx.core.ktx)
  implementation(libs.androidx.activity.ktx)
  implementation(libs.androidx.lifecycle.runtime.ktx)
  // 媒体会话与 MediaStyle 通知（见 README「媒体栈选型」说明为什么不是 Media3）
  implementation(libs.androidx.media)
  implementation(libs.kotlinx.coroutines.android)
}

/**
 * 关键接线：让 `:webassets:syncWebAssets` 先于任何 assets 合并任务执行。
 * 这样 `./gradlew :app:assembleDebug` 一条命令就能带上（可能不存在的）前端产物，
 * 且产物缺失时只降级为占位 SPA，不中断构建。
 */
tasks.matching { it.name.startsWith("merge") && it.name.endsWith("Assets") }.configureEach {
  dependsOn(":webassets:syncWebAssets")
}
tasks.matching { it.name == "preBuild" }.configureEach {
  dependsOn(":webassets:syncWebAssets")
}
