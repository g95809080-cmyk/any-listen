package com.anylisten.ports.lifecycle

import org.junit.Assert.assertEquals
import org.junit.Test

class LifecycleHubTest {
  @Test
  fun `termination event and acknowledgements retain their request id`() {
    val hub = LifecycleHub()
    val events = mutableListOf<String>()
    hub.onBeforeTerminate { id -> events.add("event:$id") }
    hub.setTerminationAckListener { id, source -> events.add("ack:$id:$source") }

    hub.dispatchBeforeTerminate("42")
    hub.acknowledgeTermination("42", "db")
    hub.clear()
    hub.acknowledgeTermination("42", "core")

    assertEquals(listOf("event:42", "ack:42:db"), events)
  }
}
