plugins {
  alias(libs.plugins.android.application) apply false
  alias(libs.plugins.android.library) apply false
  alias(libs.plugins.kotlin.android) apply false
}

/**
 * 统一编译参数。各模块 apply from 这里，避免三份重复配置漂移。
 * 说明：Kotlin 2.x 用 `compilerOptions`，不再用已废弃的 `kotlinOptions`。
 */
tasks.register("cleanAll") {
  group = "build"
  description = "清理全部模块的 build 目录"
  dependsOn(subprojects.map { "${it.path}:clean" })
}
