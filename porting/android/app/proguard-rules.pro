# WebView 通过反射查找 @JavascriptInterface 方法
-keepclassmembers class com.anylisten.bridge.AndroidBridge {
    public *;
}
-keep class com.anylisten.bridge.AndroidBridge { *; }

# Port 的数据类会被 JSON 反射（org.json 手工构造，无反射依赖），但保留公开名便于排错
-keep class com.anylisten.ports.** { *; }

# OkHttp / Okio 官方规则（避免 R8 后 TlsSocketFactory 类缺失的经典崩溃）
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

# commons-compress 里有可选的 XZ/Brotli 依赖，未引入 → 忽略
-dontwarn org.tukaani.xz.**
-dontwarn com.github.luben.zstd.**
-dontwarn org.brotli.**
