import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
  alias(libs.plugins.android.library)
  alias(libs.plugins.kotlin.android)
}

android {
  namespace = "com.anylisten.bridge"
  compileSdk = 35

  defaultConfig {
    minSdk = 29
    consumerProguardFiles("consumer-rules.pro")

    // 静态资源访问日志开关：`-PhttpAccessLog=true` 才生效，**默认 false**（交付包不带日志噪音）。
    // Kotlin/JVM 在运行时读不到 Gradle property，只能构建期固化成常量，这是唯一路径；
    // 关键点是「由 property 驱动 + 默认关」，而不是把 true 写死在源码里。
    val httpAccessLog = providers.gradleProperty("httpAccessLog").map { it.toBoolean() }.orElse(false)
    buildConfigField("boolean", "HTTP_ACCESS_LOG", httpAccessLog.get().toString())
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  buildFeatures {
    buildConfig = true
  }
}

kotlin {
  compilerOptions {
    jvmTarget.set(JvmTarget.JVM_17)
  }
}

dependencies {
  api(project(":core-ports"))
  implementation(libs.androidx.core.ktx)
  implementation(libs.kotlinx.coroutines.android)
  // /p_static、/p_url 的代理转发复用 core-ports 的 HttpPort 实现，
  // 但 :core-ports 用 implementation 引入 okhttp，因此这里需要再声明一次。
  implementation(libs.okhttp)

  testImplementation(libs.junit)
}
