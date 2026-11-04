package com.anylisten.ports.fs

import java.io.File

/**
 * 文件系统端口。设计约束见 `docs/phase2-architecture.md` §4.1：
 * - **粗粒度**：`listTree` 是唯一高性能入口，用分批回调替代 `readdir/stat` 循环；
 *   1 万首歌若走 1:1 透传需要 2 万次跨线程往返（每次 50–200µs → 秒级抖动）。
 * - **仅异步**：Worker 无法同步触达原生。
 * - **错误语义**：失败抛 `PortException`，`code` 与 Node errno 同名。
 */
interface FileSystemPort {
  suspend fun listTree(
    id: String,
    root: String,
    opts: ListTreeOptions,
    onBatch: (List<FsEntry>) -> Unit,
  ): ListTreeResult

  suspend fun cancelScan(id: String)

  suspend fun stat(path: String): FsStat?
  suspend fun exists(path: String): Boolean
  suspend fun readFile(path: String, start: Long?, end: Long?): ByteArray
  suspend fun writeFile(path: String, data: ByteArray)
  /** `.tmp` + fsync + rename：DB 与 config.json 落盘必须原子，否则崩溃会留半截文件 */
  suspend fun writeFileAtomic(path: String, data: ByteArray)
  suspend fun appendFile(path: String, text: String)
  suspend fun mkdirp(path: String)
  suspend fun remove(path: String, recursive: Boolean)
  suspend fun rename(from: String, to: String): Boolean
  suspend fun copy(from: String, to: String)
  suspend fun readdir(path: String): List<FsEntry>
  suspend fun realpath(path: String): String

  /**
   * 变更监听（替代 chokidar）。Android 侧用 [android.os.FileObserver] 逐目录挂载，
   * 因此对目录数有上限保护（[FileSystemPortImpl.MAX_WATCH_DIRS]）。
   */
  suspend fun watch(
    id: String,
    root: String,
    recursive: Boolean,
    extFilter: List<String>,
    onEvent: (List<FsWatchEvent>) -> Unit,
    onReady: () -> Unit,
    onError: (String) -> Unit,
  ): String

  suspend fun unwatch(id: String)

  /** 文件 → WebView 可播放 URL（R-06 出口），形如 `http://127.0.0.1:17930/stream/<sha>.<ext>` */
  suspend fun toPlayableUrl(path: String): String?
  suspend fun revokePlayableUrl(url: String)

  suspend fun pickDirectory(title: String?): DirPickResult?
  suspend fun getEnv(): FsEnv
  suspend fun getFreeSpace(path: String): Long
}

/**
 * 目录选择器：`MANAGE_EXTERNAL_STORAGE` 下用系统文件管理器（SAF）选目录，
 * 需要 Activity 参与 → 由 :app 注入实现，:core-ports 不依赖 activity。
 */
interface DirectoryPicker {
  /**
   * @return 真实路径（`/storage/emulated/0/Music`）与展示名；取消返回 null。
   *         若只能拿到 SAF treeId，则 path 形如 `content://.../tree/<treeId>`。
   */
  suspend fun pickDirectory(title: String?): DirPickResult?
}

/** 供 `toPlayableUrl` 使用：让 :bridge 的 LocalHttpServer 能反查文件路径。 */
interface StreamUrlProvider {
  fun buildStreamUrl(path: String): String
}
