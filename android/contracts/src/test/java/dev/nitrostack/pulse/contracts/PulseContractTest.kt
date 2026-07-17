package dev.nitrostack.pulse.contracts

import org.junit.Assert.assertEquals
import org.junit.Test

class PulseContractTest {
    @Test
    fun sharedEventFixturesUseTheSupportedEnvelope() {
        listOf(
            "events/session-started.json",
            "events/vital-sample.json",
            "events/transcript-segment.json"
        ).forEach { name ->
            val fixture = requireNotNull(javaClass.classLoader?.getResource(name)).readText()
            val event = PulseContract.validateEnvelope(fixture)
            assertEquals(PulseContract.VERSION, event.getString("version"))
        }
    }
}
