package com.anylisten.ports.tar

import com.anylisten.ports.PortErrorCode
import com.anylisten.ports.PortException
import com.anylisten.ports.toPortException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.archivers.tar.TarArchiveOutputStream
import org.apache.commons.compress.compressors.gzip.GzipCompressorInputStream
import org.apache.commons.compress.compressors.gzip.GzipCompressorOutputStream
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Path

/**
 * tar 端口（§4.9）。上游用途有两处：
 * 1. 扩展包解包（`extensionService/shared/index.ts:268,294` 的动态 `import('tar')`）
 * 2. 数据备份导出（`backup` 模块）
 *
 * 选型：Apache Commons Compress（Java 生态事实标准），而非纯 JS `fflate` ——
 * 解包要在同一目录下创建上万个小文件，纯 JS 只能在 Worker 里经 FileSystemPort 逐个写，
 * 每条都是一次跨线程往返；原生实现是本地 IO，快一个数量级。
 */
interface TarPort {
  suspend fun pack(dir: String, out: String)
  suspend fun unpack(archive: String, dist: String)
}

class TarPortImpl : TarPort {

  override suspend fun pack(dir: String, out: String) = withContext(Dispatchers.IO) {
    val root = File(dir)
    if (!root.isDirectory) {
      throw PortException(PortErrorCode.ENOTDIR, "ENOTDIR: not a directory, '$dir'", dir)
    }
    val target = File(out)
    target.parentFile?.let { if (!it.exists()) it.mkdirs() }
    val gzip = target.name.endsWith(".gz") || target.name.endsWith(".tgz")
    try {
      val fileOut = FileOutputStream(target)
      val stream = if (gzip) GzipCompressorOutputStream(BufferedOutputStream(fileOut)) else BufferedOutputStream(fileOut)
      TarArchiveOutputStream(stream).use { tar ->
        tar.setLongFileMode(TarArchiveOutputStream.LONGFILE_POSIX)
        tar.setBigNumberMode(TarArchiveOutputStream.BIGNUMBER_POSIX)
        val rootPath: Path = root.toPath()
        root.walkTopDown().forEach { file ->
          val rel = rootPath.relativize(file.toPath()).toString().replace(File.separatorChar, '/')
          if (rel.isEmpty()) return@forEach
          if (file.isDirectory) {
            tar.putArchiveEntry(TarArchiveEntry(file, "$rel/"))
            tar.closeArchiveEntry()
          } else {
            val entry = TarArchiveEntry(file, rel)
            tar.putArchiveEntry(entry)
            file.inputStream().use { it.copyTo(tar) }
            tar.closeArchiveEntry()
          }
        }
        tar.finish()
      }
    } catch (e: Exception) {
      target.delete()
      throw e.toPortException()
    }
  }

  override suspend fun unpack(archive: String, dist: String) = withContext(Dispatchers.IO) {
    val source = File(archive)
    if (!source.isFile) {
      throw PortException(PortErrorCode.ENOENT, "ENOENT: archive not found, '$archive'", archive)
    }
    val destRoot = File(dist).canonicalFile
    if (!destRoot.exists() && !destRoot.mkdirs()) {
      throw PortException(PortErrorCode.EACCES, "EACCES: cannot create '$dist'", dist)
    }
    val gzip = source.name.endsWith(".gz") || source.name.endsWith(".tgz")
    try {
      val raw = BufferedInputStream(source.inputStream())
      val input = if (gzip) GzipCompressorInputStream(raw) else raw
      TarArchiveInputStream(input).use { tar ->
        var entry: TarArchiveEntry? = tar.nextEntry
        while (entry != null) {
          val outFile = File(destRoot, entry.name).canonicalFile
          // 路径穿越防护（CVE 类问题）：条目名里出现 `..` 时拒绝解包
          if (!outFile.path.startsWith(destRoot.path + File.separator) && outFile.path != destRoot.path) {
            throw PortException(
              PortErrorCode.EACCES,
              "EACCES: archive entry escapes target dir: ${entry.name}",
              entry.name,
            )
          }
          if (entry.isDirectory) {
            outFile.mkdirs()
          } else {
            outFile.parentFile?.let { if (!it.exists()) it.mkdirs() }
            FileOutputStream(outFile).use { out -> tar.copyTo(out, 64 * 1024) }
            if (entry.mode and 0b001_000_000 != 0) outFile.setExecutable(true, false)
          }
          entry = tar.nextEntry
        }
      }
    } catch (e: PortException) {
      throw e
    } catch (e: Exception) {
      throw e.toPortException()
    }
  }
}
