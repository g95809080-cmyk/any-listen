# @JavascriptInterface 的方法名与签名一定不能被混淆（WebView 通过反射查找）
-keepclassmembers class com.anylisten.bridge.AndroidBridge {
    public *;
}
-keep class com.anylisten.bridge.AndroidBridge { *; }
