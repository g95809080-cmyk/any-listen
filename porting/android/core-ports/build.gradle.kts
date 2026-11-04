import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
  alias(libs.plugins.android.library)
  alias(libs.plugins.kotlin.android)
}

android {
  namespace = "com.anylisten.ports"
  compileSdk = 35

  defaultConfig {
    minSdk = 29
    consumerProguardFiles("consumer-rules.pro")
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
    // 显式开启：任何 API 误用都要在编译期被拦下
    allWarningsAsErrors.set(false)
  }
}

dependencies {
  implementation(libs.androidx.core.ktx)
  implementation(libs.kotlinx.coroutines.android)
  implementation(libs.okhttp)
  implementation(libs.commons.compress)

  // 依赖 UI 的 Port（Notification/MediaSession/Intent 选择器）只在此模块定义接口，
  // 实现在 :app —— 因此这里不引入 media3 / activity，保持 :core-ports 可被单测。

  testImplementation(libs.junit)
  testImplementation(libs.kotlinx.coroutines.android)
}
