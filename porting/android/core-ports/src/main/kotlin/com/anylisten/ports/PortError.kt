package com.anylisten.ports

import java.io.FileNotFoundException
import java.io.IOException
import java.nio.file.AccessDeniedException

/**
 * 跨语言边界的错误码。必须与 Node 的 `NodeJS.ErrnoException.code` 同名 —— 上游
 * `shared/app/modules/worker/extensionService/manage.ts:36` 依赖 `e.code != 'ENOENT'`
 * 判断"日志目录缺失"与"权限失败"。
 *
 * 与 `porting/js/ports/types.ts` 的 `PortErrorCode` 一一对应（含 EEXIST/EISDIR/... 超集）。
 */
enum class PortErrorCode {
  ENOENT,
  EEXIST,
  EACCES,
  EISDIR,
  ENOTDIR,
  ENOTEMPTY,
  EIO,
  ETIMEDOUT,
  EUNSUPPORTED,
  ECANCELED,
  EUNKNOWN,
}

/**
 * 唯一允许穿过桥的异常类型。bridge 层把它序列化为
 * `{ code, message, detail? }`（= JS 侧 `PortErrorPayload`）。
 */
class PortException(
  val code: PortErrorCode,
  message: String,
  val detail: String? = null,
  cause: Throwable? = null,
) : Exception(message, cause)

/** 把任意异常规整为 PortException，保证 JS 侧永远拿到可判定的 `code`。 */
fun Throwable.toPortException(): PortException = when (this) {
  is PortException -> this
  is FileNotFoundException -> PortException(PortErrorCode.ENOENT, message ?: "file not found", pathOrNull(), this)
  is AccessDeniedException -> PortException(PortErrorCode.EACCES, message ?: "permission denied", pathOrNull(), this)
  is java.nio.file.NoSuchFileException -> PortException(PortErrorCode.ENOENT, message ?: "no such file", pathOrNull(), this)
  is java.nio.file.FileAlreadyExistsException -> PortException(PortErrorCode.EEXIST, message ?: "already exists", pathOrNull(), this)
  is java.nio.file.DirectoryNotEmptyException -> PortException(PortErrorCode.ENOTEMPTY, message ?: "directory not empty", pathOrNull(), this)
  is SecurityException -> PortException(PortErrorCode.EACCES, message ?: "security exception", null, this)
  is java.net.SocketTimeoutException -> PortException(PortErrorCode.ETIMEDOUT, message ?: "timeout", null, this)
  is java.util.concurrent.CancellationException -> PortException(PortErrorCode.ECANCELED, message ?: "canceled", null, this)
  is IOException -> PortException(PortErrorCode.EIO, message ?: javaClass.simpleName, null, this)
  else -> PortException(PortErrorCode.EUNKNOWN, message ?: javaClass.simpleName, null, this)
}

private fun Throwable.pathOrNull(): String? = (this as? FileNotFoundException)?.message

/**
 * 工具：`File` 操作的最小 errno 映射。Android 的 `File.delete()` 不抛异常只返回 false，
 * 因此需要显式判断 errno，否则 JS 侧无法区分"文件不存在"与"权限失败"。
 */
internal fun requireFile(file: java.io.File): java.io.File {
  if (!file.exists()) {
    throw PortException(PortErrorCode.ENOENT, "ENOENT: no such file or directory, '${file.absolutePath}'", file.absolutePath)
  }
  return file
}

internal fun directoryIsEmpty(dir: java.io.File): Boolean =
  dir.listFiles()?.isEmpty() ?: true
