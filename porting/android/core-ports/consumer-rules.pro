# 本模块的公开 API 只暴露 Port 接口与数据类；实现类可被混淆，接口名不可。
-keep public interface com.anylisten.ports.** { *; }
-keep class com.anylisten.ports.PortErrorCode { *; }
-keep class com.anylisten.ports.fs.FsEntry { *; }
-keep class com.anylisten.ports.fs.FsStat { *; }
-keep class com.anylisten.ports.fs.FsEnv { *; }
-keep class com.anylisten.ports.http.HttpResponseData { *; }
-keep class com.anylisten.ports.http.DownloadResult { *; }
