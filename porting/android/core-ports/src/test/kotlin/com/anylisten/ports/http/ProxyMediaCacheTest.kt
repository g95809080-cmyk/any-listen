package com.anylisten.ports.http

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class ProxyMediaCacheTest {

  @get:Rule
  val temporaryFolder = TemporaryFolder()

  @Test
  fun `serves full file and byte ranges from disk`() {
    val cache = ProxyMediaCache(temporaryFolder.newFolder("proxy"))
    val bytes = "0123456789".toByteArray()
    assertTrue(cache.install("track.mp3", bytes))

    val full = cache.buildResponse("track.mp3", null)
    assertNotNull(full)
    assertEquals(200, full!!.statusCode)
    assertEquals("10", full.headers["Content-Length"])
    assertEquals("audio/mpeg", full.headers["Content-Type"])
    assertTrue(File(full.filePath!!).isFile)

    val range = cache.buildResponse("track.mp3", "bytes=2-5")
    assertNotNull(range)
    assertEquals(206, range!!.statusCode)
    assertEquals("4", range.headers["Content-Length"])
    assertEquals("bytes 2-5/10", range.headers["Content-Range"])

    val suffix = cache.buildResponse("track.mp3", "bytes=-3")
    assertNotNull(suffix)
    assertEquals("bytes 7-9/10", suffix!!.headers["Content-Range"])
  }

  @Test
  fun `rejects unsatisfiable range and unsafe names`() {
    val cache = ProxyMediaCache(temporaryFolder.newFolder("proxy"))
    cache.install("track.flac", "0123456789".toByteArray())

    val unsatisfiable = cache.buildResponse("track.flac", "bytes=20-30")
    assertNotNull(unsatisfiable)
    assertEquals(416, unsatisfiable!!.statusCode)
    assertEquals("bytes */10", unsatisfiable.headers["Content-Range"])

    assertNull(cache.buildResponse("../track.flac", null))
    assertFalse(cache.install("../track.flac", byteArrayOf(1)))
  }
}
