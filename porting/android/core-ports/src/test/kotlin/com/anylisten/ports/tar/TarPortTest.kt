package com.anylisten.ports.tar

import kotlinx.coroutines.runBlocking
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveOutputStream
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.zip.GZIPOutputStream

class TarPortTest {
  @get:Rule val temp = TemporaryFolder()

  @Test
  fun `unpacks a gzip extension bundle without a gzip suffix`() = runBlocking {
    val archive = archive("extension.alix", gzip = true)
    val target = temp.newFolder("extension")

    TarPortImpl().unpack(archive.path, target.path)

    assertEquals("extension manifest", File(target, "manifest.json").readText())
  }

  @Test
  fun `unpacks an uncompressed tar`() = runBlocking {
    val archive = archive("backup.tar", gzip = false)
    val target = temp.newFolder("backup")

    TarPortImpl().unpack(archive.path, target.path)

    assertEquals("extension manifest", File(target, "manifest.json").readText())
  }

  private fun archive(name: String, gzip: Boolean): File {
    val file = temp.newFile(name)
    val bytes = "extension manifest".toByteArray()
    val output = file.outputStream().let { if (gzip) GZIPOutputStream(it) else it }
    TarArchiveOutputStream(output).use { tar ->
      tar.putArchiveEntry(TarArchiveEntry("manifest.json").apply { size = bytes.size.toLong() })
      tar.write(bytes)
      tar.closeArchiveEntry()
    }
    return file
  }
}
