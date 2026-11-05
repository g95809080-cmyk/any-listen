package com.anylisten.ports.media

import org.junit.Assert.assertEquals
import org.junit.Test

class MediaSessionPortTest {
  @Test
  fun `clearing page callbacks prevents dispatch to a destroyed page`() {
    val port = MediaSessionPortImpl()
    val events = mutableListOf<String>()
    port.onControl { _, _ -> events.add("old") }
    port.clearControlListeners()
    port.onControl { _, _ -> events.add("new") }

    port.dispatchControl(MediaAction.PLAY)

    assertEquals(listOf("new"), events)
  }

  @Test
  fun `playback position advances and freezes on pause`() {
    var now = 1_000L
    val port = MediaSessionPortImpl { now }
    port.setPosition(durationMs = 100_000, positionMs = 10_000, playbackRate = 1f)
    port.setPlaybackState("playing")
    now += 15_000

    assertEquals(25_000L, port.snapshot().positionMs)
    port.setPlaybackState("paused")
    now += 8_000
    assertEquals(25_000L, port.snapshot().positionMs)

    port.setPlaybackState("playing")
    now += 10_000
    assertEquals(35_000L, port.snapshot().positionMs)
    port.setPosition(durationMs = 100_000, positionMs = 98_000, playbackRate = 2f)
    now += 5_000
    assertEquals(100_000L, port.snapshot().positionMs)
  }
}
