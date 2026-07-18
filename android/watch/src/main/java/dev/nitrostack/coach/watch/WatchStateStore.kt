package dev.nitrostack.coach.watch

import android.content.Context
import android.os.SystemClock
import kotlin.math.abs
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

data class WatchState(
    val sessionId: String? = null,
    val sessionStatus: String = "created",
    val sessionStartElapsedRealtimeMs: Long = 0,
    val sessionClockSynchronized: Boolean = false,
    val phoneConnected: Boolean = false,
    val backendConnected: Boolean = false,
    val pendingEvents: Int = 0,
    val copilotState: String = "completed"
)

data class HeartRateState(
    val bpm: Double? = null,
    val availability: String = "unknown",
    val sensorSupported: Boolean? = null
)

object WatchStateStore {
    private const val PREFS = "pulse_watch_bridge"
    private const val PENDING = "pending_event_ids"
    private val mutableState = MutableStateFlow(WatchState())
    val state = mutableState.asStateFlow()
    private val mutableHeartRate = MutableStateFlow(HeartRateState())
    val heartRate = mutableHeartRate.asStateFlow()

    fun restore(context: Context) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val currentBootEpochMs = System.currentTimeMillis() - SystemClock.elapsedRealtime()
        val savedBootEpochMs = prefs.getLong("boot_epoch", 0)
        val validMonotonicAnchor = savedBootEpochMs > 0 && abs(currentBootEpochMs - savedBootEpochMs) < 5_000
        mutableState.value = mutableState.value.copy(
            sessionId = prefs.getString("session_id", null),
            sessionStatus = prefs.getString("session_status", "created") ?: "created",
            sessionStartElapsedRealtimeMs = if (validMonotonicAnchor) prefs.getLong("session_start_elapsed", 0) else 0,
            sessionClockSynchronized = validMonotonicAnchor && prefs.getBoolean("session_clock_synchronized", false),
            pendingEvents = prefs.getStringSet(PENDING, emptySet()).orEmpty().size,
            copilotState = prefs.getString("copilot_state", "completed") ?: "completed"
        )
    }

    fun updateSession(context: Context, sessionId: String, status: String, sessionElapsedAtSyncMs: Long) {
        val current = mutableState.value
        val sessionChanged = current.sessionId != sessionId
        val resetCopilot = sessionChanged || status !in setOf("calibrating", "active")
        val alreadySynchronized = current.sessionId == sessionId && current.sessionClockSynchronized
        val startElapsed = if (alreadySynchronized) {
            current.sessionStartElapsedRealtimeMs
        } else {
            SystemClock.elapsedRealtime() - sessionElapsedAtSyncMs
        }
        val editor = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("session_id", sessionId)
            .putString("session_status", status)
            .putLong("session_start_elapsed", startElapsed)
            .putLong("boot_epoch", System.currentTimeMillis() - SystemClock.elapsedRealtime())
            .putBoolean("session_clock_synchronized", true)
        if (resetCopilot) editor.putString("copilot_state", "completed")
        editor.apply()
        mutableState.value = mutableState.value.copy(
            sessionId = sessionId,
            sessionStatus = status,
            sessionStartElapsedRealtimeMs = startElapsed,
            sessionClockSynchronized = true,
            copilotState = if (resetCopilot) "completed" else current.copilotState
        )
        if (sessionChanged || status !in setOf("calibrating", "active")) {
            updateHeartRate(
                availability = if (status in setOf("calibrating", "active")) "acquiring" else "inactive",
                clearBpm = true
            )
        }
        HeartRateService.reconcile(context, status)
    }

    fun updateHeartRate(
        bpm: Double? = null,
        availability: String? = null,
        sensorSupported: Boolean? = null,
        clearBpm: Boolean = false
    ) {
        val current = mutableHeartRate.value
        mutableHeartRate.value = current.copy(
            bpm = if (clearBpm) null else bpm ?: current.bpm,
            availability = availability ?: current.availability,
            sensorSupported = sensorSupported ?: current.sensorSupported
        )
    }

    fun updateConnection(phoneConnected: Boolean? = null, backendConnected: Boolean? = null) {
        mutableState.value = mutableState.value.copy(
            phoneConnected = phoneConnected ?: mutableState.value.phoneConnected,
            backendConnected = backendConnected ?: mutableState.value.backendConnected
        )
    }

    fun updateCopilotState(context: Context, state: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("copilot_state", state).apply()
        mutableState.value = mutableState.value.copy(copilotState = state)
    }

    fun addPending(context: Context, eventId: String) = updatePending(context) { it + eventId }

    fun acknowledge(context: Context, eventId: String) = updatePending(context) { it - eventId }

    private fun updatePending(context: Context, update: (Set<String>) -> Set<String>) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val pending = update(prefs.getStringSet(PENDING, emptySet()).orEmpty().toSet())
        prefs.edit().putStringSet(PENDING, pending).apply()
        mutableState.value = mutableState.value.copy(pendingEvents = pending.size)
    }
}
