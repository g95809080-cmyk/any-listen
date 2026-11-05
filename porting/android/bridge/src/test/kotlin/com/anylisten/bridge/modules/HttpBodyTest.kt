package com.anylisten.bridge.modules

import com.anylisten.ports.PortException
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class HttpBodyTest {
  @Test
  fun `request body preserves utf8 text and binary`() {
    assertArrayEquals("歌单 ✓".toByteArray(Charsets.UTF_8), decodeHttpBody("歌单 ✓"))
    val bytes = byteArrayOf(0, 1, -1)
    assertArrayEquals(bytes, decodeHttpBody(bytes))
    assertNull(decodeHttpBody(null))
    assertThrows(PortException::class.java) { decodeHttpBody(mapOf("unexpected" to true)) }
  }
}
