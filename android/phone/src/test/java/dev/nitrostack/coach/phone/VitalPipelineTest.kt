package dev.nitrostack.coach.phone

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VitalPipelineTest {
    @Test
    fun readingBecomesStaleAfterTenSeconds() {
        assertFalse(isReadingStale(receivedAtEpochMs = 1_000, nowEpochMs = 11_000))
        assertTrue(isReadingStale(receivedAtEpochMs = 1_000, nowEpochMs = 11_001))
        assertTrue(isReadingStale(receivedAtEpochMs = null, nowEpochMs = 1_000))
    }

    @Test
    fun highRestingHeartRateAlertsOnlyAfterSustainedElevation() {
        val gate = HighHeartRateAlertGate()

        assertFalse(gate.shouldAlert(bpm = 161.0, exerciseMode = false, nowEpochMs = 0))
        assertFalse(gate.shouldAlert(bpm = 161.0, exerciseMode = false, nowEpochMs = 5_000))
        assertTrue(gate.shouldAlert(bpm = 161.0, exerciseMode = false, nowEpochMs = 10_000))
        assertFalse(gate.shouldAlert(bpm = 161.0, exerciseMode = false, nowEpochMs = 10_001))
    }

    @Test
    fun highHeartRateDoesNotAlertDuringExerciseMode() {
        val gate = HighHeartRateAlertGate()

        assertFalse(gate.shouldAlert(bpm = 170.0, exerciseMode = true, nowEpochMs = 0))
        assertFalse(gate.shouldAlert(bpm = 170.0, exerciseMode = true, nowEpochMs = 20_000))
    }

    @Test
    fun delayedHeartRateSampleDoesNotCountAsSustainedElevation() {
        val gate = HighHeartRateAlertGate()

        assertFalse(gate.shouldAlert(bpm = 161.0, exerciseMode = false, nowEpochMs = 0))
        assertFalse(gate.shouldAlert(bpm = 161.0, exerciseMode = false, nowEpochMs = 10_000))
    }
}
