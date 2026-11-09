package com.anylisten.ports.http

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.BufferedReader
import java.io.Closeable
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

class HttpPortCacheIntegrationTest {

  @get:Rule
  val temporaryFolder = TemporaryFolder()

  @Test
  fun `range playback fills cache and survives source shutdown`() = runBlocking {
    val media = "abcdefghij".toByteArray()
    val cacheDir = temporaryFolder.newFolder("proxy")
    val source = RangeServer(media)
    val port = HttpPortImpl(
      tempDir = temporaryFolder.newFolder("http"),
      userAgent = "AnyListenTest",
      proxyCacheDir = cacheDir,
    )
    try {
      port.registerProxyTarget(
        name = "track.mp3",
        url = source.url,
        headers = emptyMap(),
        cacheEnabled = true,
      )

      val first = port.proxyRequestByName("track.mp3", mapOf("range" to "bytes=0-1"))
      assertNotNull(first)
      assertEquals(206, first!!.statusCode)
      assertArrayEquals("ab".toByteArray(), first.raw)

      val cache = ProxyMediaCache(cacheDir)
      await(5_000) { cache.find("track.mp3")?.length() == media.size.toLong() }
      source.close()

      val restartedPort = HttpPortImpl(
        tempDir = temporaryFolder.newFolder("http-restarted"),
        userAgent = "AnyListenTest",
        proxyCacheDir = cacheDir,
      )
      val offline = restartedPort.proxyRequestByName("track.mp3", mapOf("range" to "bytes=2-5"))
      assertNotNull(offline)
      assertEquals(206, offline!!.statusCode)
      assertEquals("bytes 2-5/10", offline.headers["Content-Range"])
      assertArrayEquals(media, File(offline.filePath!!).readBytes())
    } finally {
      source.close()
    }
  }

  @Test
  fun `large range response is marked as a partial file`() = runBlocking {
    val media = ByteArray(5 * 1024 * 1024) { (it % 251).toByte() }
    val end = 4 * 1024 * 1024 + 100
    val source = RangeServer(media)
    val port = HttpPortImpl(
      tempDir = temporaryFolder.newFolder("http"),
      userAgent = "AnyListenTest",
    )
    try {
      port.registerProxyTarget(
        name = "large.mp3",
        url = source.url,
        headers = emptyMap(),
      )

      val response = port.proxyRequestByName("large.mp3", mapOf("range" to "bytes=0-$end"))
      assertNotNull(response)
      assertEquals(206, response!!.statusCode)
      assertNull(response.raw)
      assertFalse(response.fileContainsFullResource)
      assertEquals(
        "bytes 0-$end/${media.size}",
        response.headers.entries.first { it.key.equals("Content-Range", ignoreCase = true) }.value,
      )
      val partial = File(response.filePath!!)
      assertTrue(partial.isFile)
      assertEquals(end + 1L, partial.length())
    } finally {
      source.close()
    }
  }

  private fun await(timeoutMs: Long, condition: () -> Boolean) {
    val deadline = System.currentTimeMillis() + timeoutMs
    while (System.currentTimeMillis() < deadline) {
      if (condition()) return
      Thread.sleep(25)
    }
    error("condition not met within ${timeoutMs}ms")
  }

  private class RangeServer(private val body: ByteArray) : Closeable {
    private val closed = AtomicBoolean(false)
    private val socket = ServerSocket(0, 16, InetAddress.getLoopbackAddress())
    val url: String = "http://127.0.0.1:${socket.localPort}/track.mp3"

    init {
      thread(isDaemon = true, name = "range-test-server") {
        while (!closed.get()) {
          val client = runCatching { socket.accept() }.getOrNull() ?: break
          thread(isDaemon = true) { handle(client) }
        }
      }
    }

    private fun handle(client: Socket) {
      client.use {
        val input = client.getInputStream().bufferedReader()
        val requestLine = input.readLine() ?: return
        if (!requestLine.startsWith("GET ")) return
        val headers = readHeaders(input)
        val range = parseRange(headers["range"])
        val start = range?.first ?: 0
        val end = range?.second ?: (body.size - 1)
        val payload = body.copyOfRange(start, end + 1)
        val head = buildString {
          append("HTTP/1.1 ").append(if (range == null) "200 OK" else "206 Partial Content").append("\r\n")
          append("Content-Type: audio/mpeg\r\n")
          append("Accept-Ranges: bytes\r\n")
          append("Content-Length: ").append(payload.size).append("\r\n")
          if (range != null) append("Content-Range: bytes $start-$end/${body.size}\r\n")
          append("Connection: close\r\n\r\n")
        }
        client.getOutputStream().use { output ->
          output.write(head.toByteArray(Charsets.US_ASCII))
          output.write(payload)
          output.flush()
        }
      }
    }

    private fun readHeaders(input: BufferedReader): Map<String, String> {
      val headers = linkedMapOf<String, String>()
      while (true) {
        val line = input.readLine() ?: break
        if (line.isEmpty()) break
        val idx = line.indexOf(':')
        if (idx > 0) headers[line.substring(0, idx).trim().lowercase()] = line.substring(idx + 1).trim()
      }
      return headers
    }

    private fun parseRange(header: String?): Pair<Int, Int>? {
      if (header == null || !header.startsWith("bytes=")) return null
      val spec = header.removePrefix("bytes=").substringBefore(',')
      val parts = spec.split('-', limit = 2)
      val start = parts.getOrNull(0)?.toIntOrNull() ?: 0
      val end = parts.getOrNull(1).takeUnless { it.isNullOrEmpty() }?.toIntOrNull() ?: (body.size - 1)
      return start.coerceAtLeast(0) to end.coerceAtMost(body.size - 1)
    }

    override fun close() {
      if (!closed.compareAndSet(false, true)) return
      runCatching { socket.close() }
    }
  }
}
