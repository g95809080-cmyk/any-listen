// Any Listen Android 宿主工程（Phase 4）
// 仓库说明：目标机处于国内网络，Google Maven / Maven Central 直连不可用，
// 因此把阿里云镜像放在首位；google()/mavenCentral() 保留为海外环境的兜底。
// 若需要完全离线构建，可加 --offline（依赖已缓存在 ~/.gradle/caches 时可行）。
pluginManagement {
  repositories {
    maven("https://maven.aliyun.com/repository/gradle-plugin")
    maven("https://maven.aliyun.com/repository/google")
    maven("https://maven.aliyun.com/repository/public")
    gradlePluginPortal()
    google()
    mavenCentral()
  }
}

dependencyResolutionManagement {
  repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
  repositories {
    maven("https://maven.aliyun.com/repository/google")
    maven("https://maven.aliyun.com/repository/public")
    google()
    mavenCentral()
  }
}

rootProject.name = "anylisten-android"

include(":app")
include(":core-ports")
include(":bridge")
include(":webassets")
