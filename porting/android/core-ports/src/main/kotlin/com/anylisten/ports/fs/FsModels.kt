package com.anylisten.ports.fs

/** 与 `porting/js/ports/types.ts` 的 `FsEntry` 字段一一对应（字段只增不改）。 */
data class FsEntry(
  /** 内部路径。SAF 模式下是 `/saf/<treeId>/...` 虚拟路径，**不可直接展示给用户** */
  val path: String,
  val name: String,
  val isFile: Boolean,
  val isDirectory: Boolean,
  val size: Long,
  val mtimeMs: Long,
  /**
   * 给用户看的路径。SAF 模式下填可读名（如 `内部存储/Music`），
   * 真实文件路径下保持 null（JS 侧规则 `displayPath ?? path`）。
   * 由 bridge 的 `Serialize.entry` 决定是否下发，不与 path 重复传输。
   */
  val displayPath: String? = null,
)

data class FsStat(
  val isFile: Boolean,
  val isDirectory: Boolean,
  val size: Long,
  val ctimeMs: Long,
  val mtimeMs: Long,
)

data class FsWatchEvent(
  val action: String, // 'add' | 'change' | 'unlink'
  val path: String,
  val ctimeMs: Long? = null,
  val mtimeMs: Long? = null,
  val size: Long? = null,
)

data class FsEnv(
  val dataPath: String,
  val cachePath: String,
  val tempPath: String,
  val externalRoot: String?,
  val platform: String = "android",
  val arch: String,
  val osVersion: String,
  val hasAllFilesAccess: Boolean,
)

data class ListTreeOptions(
  /** 对应 watcher 的 `depth: recursive ? 5 : 0`；<=0 表示只列一层 */
  val maxDepth: Int = Int.MAX_VALUE,
  /** 对应 `isMusicFile` 白名单；空 = 不过滤 */
  val fileExtFilter: List<String> = emptyList(),
  /** 每批条目数，默认 500（一次跨线程往返的推荐上限） */
  val batchSize: Int = 500,
)

data class ListTreeResult(
  val total: Int,
  val canceled: Boolean,
  val id: String,
)

data class DirPickResult(
  val path: String,
  val displayName: String,
)
