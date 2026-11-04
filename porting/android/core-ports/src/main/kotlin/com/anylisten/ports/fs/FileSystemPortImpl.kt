package com.anylisten.ports.fs

import android.content.Context
import android.os.Build
import android.os.Environment
import android.os.FileObserver
import android.os.StatFs
import android.os.storage.StorageManager
import android.util.Log
import com.anylisten.ports.PortErrorCode
import com.anylisten.ports.PortException
import com.anylisten.ports.requireFile
import com.anylisten.ports.toPortException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.util.concurrent.ConcurrentHashMap

class FileSystemPortImpl(
  private val context: Context,
  private val streamRegistry: StreamRegistry,
  private val directoryPicker: DirectoryPicker? = null,
) : FileSystemPort {

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val cancelFlags = ConcurrentHashMap<String, Boolean>()
  private val watchers = ConcurrentHashMap<String, WatchHandle>()

  // ---------------------------------------------------------------- listTree

  override suspend fun listTree(
    id: String,
    root: String,
    opts: ListTreeOptions,
    onBatch: (List<FsEntry>) -> Unit,
  ): ListTreeResult = withContext(Dispatchers.IO) {
    val rootFile = File(root)
    if (!rootFile.exists()) {
      throw PortException(PortErrorCode.ENOENT, "ENOENT: no such file or directory, '$root'", root)
    }
    if (!rootFile.isDirectory) {
      throw PortException(PortErrorCode.ENOTDIR, "ENOTDIR: not a directory, '$root'", root)
    }
    cancelFlags[id] = false
    val filter = opts.fileExtFilter
      .asSequence()
      .filter { it.isNotEmpty() }
      .map { it.removePrefix(".").lowercase() }
      .toSet()
    val batchSize = opts.batchSize.coerceIn(1, 5000)
    val batch = ArrayList<FsEntry>(batchSize)
    var total = 0
    var canceled = false

    // 显式栈 DFS：递归深度受目录树限制，用栈避免爆栈；不用 File.walkTopDown 因为无法逐批取消
    val stack = ArrayDeque<Pair<File, Int>>()
    stack.addLast(rootFile to 0)
    while (stack.isNotEmpty()) {
      if (cancelFlags[id] == true) {
        canceled = true
        break
      }
      val (dir, depth) = stack.removeLast()
      val children = dir.listFiles()
      if (children == null) {
        // 权限不足或无读权限：不中断整次扫描（外部存储里这种目录很常见）
        continue
      }
      for (child in children) {
        if (cancelFlags[id] == true) {
          canceled = true
          break
        }
        val name = child.name
        val isDir = child.isDirectory
        val isFile = child.isFile
        if (isFile && filter.isNotEmpty() && !filter.contains(name.substringAfterLast('.', "").lowercase())) {
          continue
        }
        // 隐藏目录/文件仍返回（上游扫描依赖 ".nomedia 判断"在 JS 侧做，这里不替它决定）
        if (!isDir && !isFile) continue
        batch.add(
          FsEntry(
            path = child.absolutePath,
            name = name,
            isFile = isFile,
            isDirectory = isDir,
            size = if (isFile) child.length() else 0L,
            mtimeMs = child.lastModified(),
            // MANAGE_EXTERNAL_STORAGE 模式下 path 本身就是可读的真实路径，直接同值下发；
            // SAF 虚拟路径（/saf/<treeId>/...）落地后这里换成 displayName 拼出的可读路径。
            displayPath = child.absolutePath,
          ),
        )
        total++
        if (batch.size >= batchSize) {
          onBatch(ArrayList(batch))
          batch.clear()
        }
        if (isDir && depth < opts.maxDepth) {
          stack.addLast(child to depth + 1)
        }
      }
    }
    if (batch.isNotEmpty() && !canceled) onBatch(ArrayList(batch))
    cancelFlags.remove(id)
    ListTreeResult(total = total, canceled = canceled, id = id)
  }

  override suspend fun cancelScan(id: String) {
    cancelFlags[id] = true
  }

  // ---------------------------------------------------------------- basics

  override suspend fun stat(path: String): FsStat? = withContext(Dispatchers.IO) {
    val file = File(path)
    // 对齐上游 `getFileStats` 的 catch → null 语义：不存在就返回 null 而不是抛
    if (!file.exists()) return@withContext null
    FsStat(
      isFile = file.isFile,
      isDirectory = file.isDirectory,
      size = if (file.isFile) file.length() else 0L,
      ctimeMs = file.lastModified(),
      mtimeMs = file.lastModified(),
    )
  }

  override suspend fun exists(path: String): Boolean = withContext(Dispatchers.IO) { File(path).exists() }

  override suspend fun readFile(path: String, start: Long?, end: Long?): ByteArray = withContext(Dispatchers.IO) {
    val file = requireFile(File(path))
    if (file.isDirectory) {
      throw PortException(PortErrorCode.EISDIR, "EISDIR: illegal operation on a directory, '$path'", path)
    }
    if (start == null && end == null) {
      file.readBytes()
    } else {
      val rangeStart = (start ?: 0L).coerceAtLeast(0L)
      RandomAccessFile(file, "r").use { raf ->
        val length = raf.length()
        if (rangeStart > length) {
          throw PortException(PortErrorCode.EIO, "EIO: range start $rangeStart beyond EOF $length", path)
        }
        val rangeEnd = (end ?: (length - 1)).coerceAtMost(length - 1)
        if (rangeEnd < rangeStart) return@use ByteArray(0)
        val size = (rangeEnd - rangeStart + 1).toInt()
        val buffer = ByteArray(size)
        raf.seek(rangeStart)
        raf.readFully(buffer)
        buffer
      }
    }
  }

  override suspend fun writeFile(path: String, data: ByteArray) = withContext(Dispatchers.IO) {
    try {
      val file = File(path)
      file.parentFile?.let { if (!it.exists()) it.mkdirs() }
      FileOutputStream(file).use { out ->
        out.write(data)
        out.flush()
        out.fd.sync()
      }
    } catch (e: Exception) {
      throw e.toPortException()
    }
  }

  override suspend fun writeFileAtomic(path: String, data: ByteArray) = withContext(Dispatchers.IO) {
    val target = File(path)
    target.parentFile?.let { if (!it.exists()) it.mkdirs() }
    val tmp = File(target.parentFile, "${target.name}.tmp")
    try {
      FileOutputStream(tmp).use { out ->
        out.write(data)
        out.flush()
        out.fd.sync()
      }
      if (!tmp.renameTo(target)) {
        // rename 在跨挂载点会失败；同目录内理论上不会，兜底做一次 copy
        data.let { target.writeBytes(it) }
        tmp.delete()
      }
    } catch (e: Exception) {
      tmp.delete()
      throw e.toPortException()
    }
  }

  override suspend fun appendFile(path: String, text: String) = withContext(Dispatchers.IO) {
    try {
      val file = File(path)
      file.parentFile?.let { if (!it.exists()) it.mkdirs() }
      file.appendBytes(text.toByteArray(Charsets.UTF_8))
    } catch (e: Exception) {
      throw e.toPortException()
    }
  }

  override suspend fun mkdirp(path: String) = withContext(Dispatchers.IO) {
    val dir = File(path)
    if (dir.isDirectory) return@withContext
    if (!dir.mkdirs() && !dir.isDirectory) {
      throw PortException(PortErrorCode.EACCES, "EACCES: cannot create directory '$path'", path)
    }
  }

  override suspend fun remove(path: String, recursive: Boolean) = withContext(Dispatchers.IO) {
    val file = File(path)
    // 对齐 removePath/removeFileIgnoreError：不存在不报错
    if (!file.exists()) return@withContext
    if (file.isDirectory && !recursive) {
      if (!file.delete()) {
        throw PortException(PortErrorCode.ENOTEMPTY, "ENOTEMPTY: directory not empty, '$path'", path)
      }
      return@withContext
    }
    val ok = file.deleteRecursively()
    if (!ok && file.exists()) {
      throw PortException(PortErrorCode.EACCES, "EACCES: cannot remove '$path'", path)
    }
  }

  override suspend fun rename(from: String, to: String): Boolean = withContext(Dispatchers.IO) {
    val src = File(from)
    if (!src.exists()) return@withContext false
    val dest = File(to)
    dest.parentFile?.let { if (!it.exists()) it.mkdirs() }
    src.renameTo(dest)
  }

  override suspend fun copy(from: String, to: String) = withContext(Dispatchers.IO) {
    val src = requireFile(File(from))
    val dest = File(to)
    dest.parentFile?.let { if (!it.exists()) it.mkdirs() }
    try {
      src.copyTo(dest, overwrite = true)
      Unit
    } catch (e: Exception) {
      throw e.toPortException()
    }
  }

  override suspend fun readdir(path: String): List<FsEntry> = withContext(Dispatchers.IO) {
    val dir = requireFile(File(path))
    if (!dir.isDirectory) {
      throw PortException(PortErrorCode.ENOTDIR, "ENOTDIR: not a directory, '$path'", path)
    }
    (dir.listFiles() ?: emptyArray()).map { child ->
      FsEntry(
        path = child.absolutePath,
        name = child.name,
        isFile = child.isFile,
        isDirectory = child.isDirectory,
        size = if (child.isFile) child.length() else 0L,
        mtimeMs = child.lastModified(),
        displayPath = child.absolutePath,
      )
    }
  }

  override suspend fun realpath(path: String): String = withContext(Dispatchers.IO) {
    try {
      requireFile(File(path)).canonicalPath
    } catch (e: Exception) {
      throw e.toPortException()
    }
  }

  // ---------------------------------------------------------------- watch

  override suspend fun watch(
    id: String,
    root: String,
    recursive: Boolean,
    extFilter: List<String>,
    onEvent: (List<FsWatchEvent>) -> Unit,
    onReady: () -> Unit,
    onError: (String) -> Unit,
  ): String = withContext(Dispatchers.IO) {
    unwatch(id)
    val rootFile = File(root)
    if (!rootFile.isDirectory) {
      onError("ENOENT: watch root is not a directory: $root")
      return@withContext id
    }
    val filter = extFilter
      .asSequence()
      .filter { it.isNotEmpty() }
      .map { it.removePrefix(".").lowercase() }
      .toSet()
    val handle = WatchHandle(id, filter, onEvent, onError)
    watchers[id] = handle
    handle.start(rootFile, recursive)
    onReady()
    id
  }

  override suspend fun unwatch(id: String) {
    watchers.remove(id)?.stop()
  }

  /**
   * 一个 watch 订阅 = N 个 FileObserver（Android 的 FileObserver 不递归）+ 一个事件合并通道。
   * 事件必须合并：一次「拷入 500 首歌」会产生上千条 CLOSE_WRITE，逐条跨线程回 JS 会打爆桥。
   */
  private inner class WatchHandle(
    private val id: String,
    private val extFilter: Set<String>,
    private val onEvent: (List<FsWatchEvent>) -> Unit,
    private val onError: (String) -> Unit,
  ) {
    private val observers = ConcurrentHashMap<String, FileObserver>()
    private val pending = LinkedHashMap<String, FsWatchEvent>()
    private val channel = Channel<Unit>(Channel.CONFLATED)
    private var flushJob: Job? = null
    @Volatile private var stopped = false

    fun start(root: File, recursive: Boolean) {
      flushJob = scope.launch {
        for (tick in channel) {
          delay(EVENT_DEBOUNCE_MS)
          flush()
        }
      }
      if (recursive) {
        addRecursive(root, 0)
      } else {
        addObserver(root)
      }
    }

    private fun addRecursive(dir: File, depth: Int) {
      if (stopped || depth > MAX_WATCH_DEPTH || observers.size >= MAX_WATCH_DIRS) return
      addObserver(dir)
      dir.listFiles()?.forEach { child ->
        if (child.isDirectory && !child.name.startsWith(".")) addRecursive(child, depth + 1)
      }
    }

    private fun addObserver(dir: File) {
      val path = dir.absolutePath
      if (observers.containsKey(path)) return
      val mask = FileObserver.CREATE or FileObserver.DELETE or FileObserver.MODIFY or
        FileObserver.CLOSE_WRITE or FileObserver.MOVED_FROM or FileObserver.MOVED_TO or
        FileObserver.ATTRIB
      val observer = object : FileObserver(dir, mask) {
        override fun onEvent(event: Int, path: String?) {
          if (stopped) return
          val name = path ?: return
          val child = File(dir, name)
          val abs = child.absolutePath
          val action = when (event and FileObserver.ALL_EVENTS) {
            FileObserver.CREATE, FileObserver.MOVED_TO -> "add"
            FileObserver.DELETE, FileObserver.MOVED_FROM -> "unlink"
            else -> "change"
          }
          if (action != "unlink" && child.isDirectory) {
            // 新目录出现 → 补挂观察器，否则递归监听会漏掉后续变化
            if (observers.size < MAX_WATCH_DIRS) addObserver(child)
            return
          }
          val ext = name.substringAfterLast('.', "").lowercase()
          if (extFilter.isNotEmpty() && ext.isNotEmpty() && !extFilter.contains(ext)) return
          synchronized(pending) {
            pending[abs] = FsWatchEvent(
              action = action,
              path = abs,
              ctimeMs = if (action == "unlink") null else child.lastModified(),
              mtimeMs = if (action == "unlink") null else child.lastModified(),
              size = if (action == "unlink" || child.isDirectory) null else child.length(),
            )
          }
          channel.trySend(Unit)
        }
      }
      observers[path] = observer
      try {
        observer.startWatching()
      } catch (e: Exception) {
        // Android 对 inotify watch 数量有限制（默认 8192）；超限时降级为部分监听并告知 JS
        observers.remove(path)
        onError("watch limit reached or unsupported: $path (${e.message})")
      }
    }

    private fun flush() {
      val batch: List<FsWatchEvent>
      synchronized(pending) {
        if (pending.isEmpty()) return
        batch = ArrayList(pending.values)
        pending.clear()
      }
      try {
        onEvent(batch)
      } catch (e: Exception) {
        Log.w(TAG, "watch event dispatch failed: ${e.message}")
      }
    }

    fun stop() {
      stopped = true
      observers.values.forEach { runCatching { it.stopWatching() } }
      observers.clear()
      channel.close()
      flushJob?.cancel()
    }
  }

  // ---------------------------------------------------------------- urls / pickers / env

  override suspend fun toPlayableUrl(path: String): String? = withContext(Dispatchers.IO) {
    val file = File(path)
    if (!file.isFile) return@withContext null
    streamRegistry.buildUrl(file)
  }

  override suspend fun revokePlayableUrl(url: String) {
    streamRegistry.unregister(url)
  }

  override suspend fun pickDirectory(title: String?): DirPickResult? {
    val picker = directoryPicker
      ?: throw PortException(PortErrorCode.EUNSUPPORTED, "directory picker is not available (no Activity bound)")
    return picker.pickDirectory(title)
  }

  override suspend fun getEnv(): FsEnv = withContext(Dispatchers.IO) {
    // 目录布局与桌面版同构：<dataPath>/{app,cache,temp}（见 StorageLayout）。
    // getEnv 是 JS 启动第一步，顺手把目录建好 —— 之后 fs.mkdirp 就不用每处都判父目录。
    val layout = StorageLayout(context).ensureDirs()
    FsEnv(
      dataPath = layout.dataPath,
      cachePath = layout.cachePath.absolutePath,
      tempPath = layout.tempPath.absolutePath,
      externalRoot = externalRootPath(),
      arch = currentArch(),
      osVersion = Build.VERSION.RELEASE ?: "unknown",
      hasAllFilesAccess = hasAllFilesAccess(),
    )
  }

  override suspend fun getFreeSpace(path: String): Long = withContext(Dispatchers.IO) {
    try {
      val target = File(path)
      val stat = StatFs(if (target.exists()) target.absolutePath else context.filesDir.absolutePath)
      stat.availableBytes
    } catch (e: Exception) {
      throw e.toPortException()
    }
  }

  private fun hasAllFilesAccess(): Boolean {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      return Environment.isExternalStorageManager()
    }
    // API 29 走 requestLegacyExternalStorage：有 READ/WRITE_EXTERNAL_STORAGE 即视为可用
    return context.checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE) ==
      android.content.pm.PackageManager.PERMISSION_GRANTED
  }

  private fun externalRootPath(): String? = try {
    val sm = context.getSystemService(Context.STORAGE_SERVICE) as? StorageManager
    val volumes = sm?.storageVolumes?.filter { it.isRemovable || it.isPrimary }
    volumes?.firstOrNull { it.isPrimary }?.directory?.absolutePath
      ?: Environment.getExternalStorageDirectory()?.absolutePath
  } catch (e: Exception) {
    Log.w(TAG, "read external storage root failed: ${e.message}")
    null
  }

  private fun currentArch(): String = when {
    Build.SUPPORTED_ABIS.any { it == "arm64-v8a" } -> "arm64"
    Build.SUPPORTED_ABIS.any { it == "armeabi-v7a" } -> "armv7"
    Build.SUPPORTED_ABIS.any { it.contains("x86_64") } -> "x86_64"
    else -> "arm64"
  }

  fun dispose() {
    watchers.keys.toList().forEach { watchers.remove(it)?.stop() }
    scope.cancel()
  }

  private companion object {
    const val TAG = "AnyListen/FsPort"
    const val MAX_WATCH_DIRS = 1024
    const val MAX_WATCH_DEPTH = 8
    const val EVENT_DEBOUNCE_MS = 250L
  }
}
