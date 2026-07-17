package dev.nitrostack.coach.phone

import android.content.Context
import android.os.SystemClock
import com.google.android.gms.wearable.PutDataMapRequest
import com.google.android.gms.wearable.Wearable
import dev.nitrostack.pulse.contracts.PulseContract
import dev.nitrostack.pulse.contracts.PulseDataLayer
import dev.nitrostack.pulse.contracts.PulseLog
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.UUID
import java.util.concurrent.TimeUnit

private const val STALE_AFTER_MS = 10_000L
private const val ACK_TIMEOUT_MS = 10_000L
private const val HIGH_RESTING_HEART_RATE_BPM = 160.0
private const val HIGH_HEART_RATE_SUSTAINED_MS = 10_000L
private const val HIGH_HEART_RATE_MAX_SAMPLE_GAP_MS = 5_000L
private const val HIGH_HEART_RATE_ALERT_COOLDOWN_MS = 5 * 60_000L

// Alerts require contiguous high readings so a delayed sensor update cannot trigger one.
class HighHeartRateAlertGate {
    private var elevatedSinceEpochMs: Long? = null
    private var lastSampleEpochMs: Long? = null
    private var lastAlertEpochMs: Long? = null

    fun shouldAlert(bpm: Double, exerciseMode: Boolean, nowEpochMs: Long): Boolean {
        if (exerciseMode || bpm <= HIGH_RESTING_HEART_RATE_BPM) {
            elevatedSinceEpochMs = null
            lastSampleEpochMs = nowEpochMs
            return false
        }
        val sampleGap = lastSampleEpochMs?.let { nowEpochMs - it }
        // Restart the sustained-reading window after a gap in sensor delivery.
        if (sampleGap == null || sampleGap > HIGH_HEART_RATE_MAX_SAMPLE_GAP_MS) {
            elevatedSinceEpochMs = nowEpochMs
        }
        lastSampleEpochMs = nowEpochMs
        val elevatedSince = elevatedSinceEpochMs ?: nowEpochMs.also { elevatedSinceEpochMs = it }
        if (nowEpochMs - elevatedSince < HIGH_HEART_RATE_SUSTAINED_MS) return false
        if (lastAlertEpochMs?.let { nowEpochMs - it < HIGH_HEART_RATE_ALERT_COOLDOWN_MS } == true) return false
        lastAlertEpochMs = nowEpochMs
        return true
    }

    fun reset() {
        elevatedSinceEpochMs = null
        lastSampleEpochMs = null
        lastAlertEpochMs = null
    }
}

fun isReadingStale(receivedAtEpochMs: Long?, nowEpochMs: Long = System.currentTimeMillis()): Boolean =
    receivedAtEpochMs == null || nowEpochMs - receivedAtEpochMs > STALE_AFTER_MS

data class PhoneVitalsState(
    val sessionId: String? = null,
    val sessionStatus: String = "created",
    val source: String = BuildConfig.VITALS_SOURCE,
    val latestBpm: Double? = null,
    val availability: String = "unknown",
    val latestSessionElapsedMs: Long? = null,
    val latestReceivedAtEpochMs: Long? = null,
    val watchConnected: Boolean = false,
    val backendConnected: Boolean = false,
    val pendingEvents: Int = 0,
    val simulatorRunning: Boolean = false,
    val exerciseMode: Boolean = false,
    val message: String = "Start a session to capture vitals"
)

class VitalPipeline(
    private val context: Context,
    private val onHighHeartRateAlert: () -> Unit = {}
) {
    private val prefs = context.getSharedPreferences("pulse_vital_pipeline", Context.MODE_PRIVATE)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val client = OkHttpClient.Builder().pingInterval(15, TimeUnit.SECONDS).build()
    private val lock = Any()
    private val pending = loadPending().toMutableList()
    private val processedWatchEvents = prefs.getStringSet("processed_watch_events", emptySet()).orEmpty().toMutableSet()
    private val mutableState = MutableStateFlow(restoredState())
    val state = mutableState.asStateFlow()
    private var socket: WebSocket? = null
    private var inFlightEventId: String? = null
    private var reconnectJob: Job? = null
    private var acknowledgementTimeoutJob: Job? = null
    private var reconnectAttempt = 0
    private var simulatorJob: Job? = null
    private var sessionStartElapsedRealtimeMs = restoreSessionStart()
    private val highHeartRateAlertGate = HighHeartRateAlertGate()

    init {
        updateState { copy(pendingEvents = pending.size) }
        if (pending.isNotEmpty()) ensureConnected()
    }

    fun startSession() {
        if (mutableState.value.sessionStatus in setOf("calibrating", "active")) return
        val sessionId = "android-${UUID.randomUUID()}"
        val now = Instant.now().toString()
        sessionStartElapsedRealtimeMs = SystemClock.elapsedRealtime()
        highHeartRateAlertGate.reset()
        val event = PulseContract.envelope(
            type = "session_started",
            sessionId = sessionId,
            payload = JSONObject().put("session", JSONObject()
                .put("sessionId", sessionId)
                .put("status", "calibrating")
                .put("startedAt", now)
                .put("endedAt", JSONObject.NULL)
                .put("simulatedVitals", BuildConfig.VITALS_SOURCE == "simulated")
                .put("audioInputRoute", BuildConfig.AUDIO_INPUT))
        )
        prefs.edit()
            .putString("session_id", sessionId)
            .putString("session_status", "calibrating")
            .putLong("session_start_elapsed", sessionStartElapsedRealtimeMs)
            .putLong("session_start_wall", System.currentTimeMillis())
            .putLong("session_boot_epoch", System.currentTimeMillis() - SystemClock.elapsedRealtime())
            .commit()
        updateState {
            copy(
                sessionId = sessionId,
                sessionStatus = "calibrating",
                latestBpm = null,
                latestReceivedAtEpochMs = null,
                availability = "acquiring",
                exerciseMode = false,
                message = "Session started"
            )
        }
        enqueue(event)
        publishSessionState("calibrating")
    }

    fun endSession() {
        val sessionId = mutableState.value.sessionId ?: return
        if (mutableState.value.sessionStatus !in setOf("calibrating", "active")) return
        stopSimulator()
        highHeartRateAlertGate.reset()
        val endedAt = Instant.now().toString()
        enqueue(PulseContract.envelope(
            type = "session_ended",
            sessionId = sessionId,
            payload = JSONObject().put("endedAt", endedAt).put("reason", "completed")
        ))
        prefs.edit().putString("session_status", "completed").apply()
        updateState { copy(sessionStatus = "completed", exerciseMode = false, message = "Session ending; queued events will finish uploading") }
        publishSessionState("completed")
    }

    fun acceptTranscriptSegment(segment: FinalTranscriptSegment) {
        val sessionId = mutableState.value.sessionId ?: return
        if (mutableState.value.sessionStatus !in setOf("calibrating", "active")) return
        enqueue(PulseContract.envelope(
            type = "transcript_segment_received",
            sessionId = sessionId,
            payload = JSONObject()
                .put("sessionId", sessionId)
                .put("segmentId", UUID.randomUUID().toString())
                .put("speaker", "unknown")
                .put("text", segment.text)
                .put("startMs", segment.startMs)
                .put("endMs", segment.endMs)
                .put("providerTimestamp", Instant.now().toString())
                .put("confidence", segment.confidence ?: JSONObject.NULL)
                .put("isFinal", true)
        ))
        updateState { copy(message = "Final transcript queued") }
    }

    fun currentSessionElapsedMs(): Long = sessionElapsedMs()

    fun reportMessage(message: String) {
        updateState { copy(message = message) }
    }

    fun toggleExerciseMode() {
        if (mutableState.value.sessionStatus !in setOf("calibrating", "active")) return
        // Changing activity context invalidates any partially accumulated alert window.
        highHeartRateAlertGate.reset()
        updateState {
            copy(
                exerciseMode = !exerciseMode,
                message = if (!exerciseMode) "Exercise mode enabled; high-rate alerts paused" else "Exercise mode disabled; high-rate alerts active"
            )
        }
    }

    fun acceptWatchEvent(eventJson: String): Boolean {
        val event = try {
            PulseContract.validateEnvelope(eventJson)
        } catch (_: Exception) {
            return false
        }
        val eventId = event.getString("eventId")
        synchronized(lock) {
            if (eventId in processedWatchEvents) return true
        }
        if (event.getString("sessionId") != mutableState.value.sessionId) {
            if (mutableState.value.sessionId == null) return false
            rememberWatchEvent(eventId)
            updateState { copy(message = "Discarded acknowledged event from an ended session") }
            return true
        }
        if (BuildConfig.VITALS_SOURCE != "watch" || mutableState.value.sessionStatus !in setOf("calibrating", "active")) {
            rememberWatchEvent(eventId)
            return true
        }

        when (event.getString("type")) {
            "heart_rate_sample" -> {
                val backendEvent = JSONObject(event.toString()).put("type", "vital_sample_received")
                acceptVitalEvent(backendEvent)
            }
            "heart_rate_availability" -> {
                val availability = event.getJSONObject("payload").getString("availability")
                updateState { copy(availability = availability, message = "Watch sensor $availability") }
            }
            else -> return false
        }
        rememberWatchEvent(eventId)
        return true
    }

    fun setWatchConnected(connected: Boolean) {
        if (mutableState.value.watchConnected == connected) return
        updateState { copy(watchConnected = connected) }
        if (connected) publishSessionState(mutableState.value.sessionStatus)
        publishConnectionState()
    }

    fun startSimulator() {
        if (!BuildConfig.DEBUG || BuildConfig.VITALS_SOURCE != "simulated" || simulatorJob?.isActive == true) return
        if (mutableState.value.sessionStatus !in setOf("calibrating", "active")) startSession()
        val values = listOf(72, 74, 78, 84, 92, 101, 108, 112, 110, 102, 94, 86, 79)
        simulatorJob = scope.launch {
            updateState { copy(simulatorRunning = true, message = "SIMULATED scripted heart rate active") }
            for (bpm in values) {
                if (!isActive) break
                val sessionId = mutableState.value.sessionId ?: break
                val event = PulseContract.envelope(
                    type = "vital_sample_received",
                    sessionId = sessionId,
                    payload = JSONObject()
                        .put("sessionId", sessionId)
                        .put("bpm", bpm)
                        .put("availability", "available")
                        .put("sessionElapsedMs", sessionElapsedMs())
                        .put("deviceTimestamp", Instant.now().toString())
                        .put("source", "simulator")
                )
                acceptVitalEvent(event)
                delay(1_000)
            }
            updateState { copy(simulatorRunning = false, message = "SIMULATED sequence complete") }
        }
    }

    fun stopSimulator() {
        simulatorJob?.cancel()
        simulatorJob = null
        updateState { copy(simulatorRunning = false) }
    }

    private fun acceptVitalEvent(event: JSONObject) {
        val payload = event.getJSONObject("payload")
        val bpm = payload.getDouble("bpm")
        updateState {
            copy(
                latestBpm = bpm,
                availability = payload.getString("availability"),
                source = payload.getString("source"),
                latestSessionElapsedMs = payload.getLong("sessionElapsedMs"),
                latestReceivedAtEpochMs = System.currentTimeMillis(),
                message = if (payload.getString("source") == "simulator") "SIMULATED vital received" else "Live watch vital received"
            )
        }
        enqueue(event)
        if (highHeartRateAlertGate.shouldAlert(bpm, mutableState.value.exerciseMode, System.currentTimeMillis())) {
            updateState { copy(message = "High heart rate alert sent: ${bpm.toInt()} BPM") }
            sendHighHeartRateHaptic()
            onHighHeartRateAlert()
        }
    }

    private fun sendHighHeartRateHaptic() {
        scope.launch {
            // Reuse the established phone-to-watch command so vibration works without the watch UI open.
            val nodes = Wearable.getNodeClient(context).connectedNodes.await()
            nodes.forEach { Wearable.getMessageClient(context).sendMessage(it.id, "/phase0/haptic", byteArrayOf()).await() }
        }
    }

    private fun enqueue(event: JSONObject) {
        synchronized(lock) {
            if (pending.any { it.getString("eventId") == event.getString("eventId") }) return
            pending += event
            savePending()
            updateState { copy(pendingEvents = pending.size) }
        }
        PulseLog.boundary("phone", "phone_to_backend_queue", event, "Persisted event for delivery")
        ensureConnected()
        flushNext()
    }

    private fun ensureConnected() {
        synchronized(lock) {
            if (socket != null) return
            val request = Request.Builder().url(websocketUrl()).build()
            socket = client.newWebSocket(request, StreamListener())
            updateState { copy(message = "Connecting to backend") }
        }
    }

    private fun flushNext() {
        synchronized(lock) {
            val activeSocket = socket ?: return
            if (!mutableState.value.backendConnected || inFlightEventId != null) return
            val event = pending.firstOrNull() ?: return
            if (activeSocket.send(event.toString())) {
                inFlightEventId = event.getString("eventId")
                PulseLog.boundary("phone", "phone_to_backend_stream", event, "Streamed queued event")
                startAcknowledgementTimeout(activeSocket, inFlightEventId!!)
            }
        }
    }

    private inner class StreamListener : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            synchronized(lock) {
                if (webSocket != socket) return
                reconnectAttempt = 0
                inFlightEventId = null
            }
            updateState { copy(backendConnected = true, message = "Backend stream connected") }
            publishConnectionState()
            flushNext()
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val acknowledgement = try { JSONObject(text) } catch (_: Exception) { return }
            val eventId = acknowledgement.optString("eventId")
            synchronized(lock) {
                if (eventId != inFlightEventId) return
                acknowledgementTimeoutJob?.cancel()
                if (!acknowledgement.optBoolean("accepted")) {
                    val rejected = pending.firstOrNull { it.getString("eventId") == eventId }
                    if (rejected != null) rememberRejectedEvent(rejected, acknowledgement.optString("error"))
                    pending.removeAll { it.getString("eventId") == eventId }
                    inFlightEventId = null
                    savePending()
                    updateState { copy(pendingEvents = pending.size) }
                    updateState { copy(message = "Backend rejected event: ${acknowledgement.optString("error")}") }
                } else {
                    pending.removeAll { it.getString("eventId") == eventId }
                    inFlightEventId = null
                    savePending()
                    updateState { copy(pendingEvents = pending.size) }
                }
            }
            flushNext()
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = disconnected(webSocket)

        override fun onFailure(webSocket: WebSocket, error: Throwable, response: Response?) = disconnected(webSocket)
    }

    private fun disconnected(webSocket: WebSocket) {
        synchronized(lock) {
            if (webSocket != socket) return
            socket = null
            inFlightEventId = null
            acknowledgementTimeoutJob?.cancel()
        }
        updateState { copy(backendConnected = false, message = "Backend offline; ${pending.size} event(s) queued") }
        publishConnectionState()
        scheduleReconnect()
    }

    private fun scheduleReconnect() {
        if (reconnectJob?.isActive == true) return
        reconnectJob = scope.launch {
            val waitMs = (1_000L shl reconnectAttempt.coerceAtMost(5))
            reconnectAttempt++
            delay(waitMs)
            ensureConnected()
        }
    }

    private fun startAcknowledgementTimeout(activeSocket: WebSocket, eventId: String) {
        acknowledgementTimeoutJob?.cancel()
        acknowledgementTimeoutJob = scope.launch {
            delay(ACK_TIMEOUT_MS)
            val timedOut = synchronized(lock) { inFlightEventId == eventId && socket == activeSocket }
            if (timedOut) activeSocket.cancel()
        }
    }

    private fun publishSessionState(status: String) {
        if (BuildConfig.VITALS_SOURCE != "watch") return
        val sessionId = mutableState.value.sessionId ?: return
        val event = PulseContract.envelope(
            type = "session_state",
            sessionId = sessionId,
            payload = JSONObject().put("status", status)
        )
        putWatchState(PulseDataLayer.SESSION_STATE_PATH, event, sessionElapsedMs())
    }

    private fun publishConnectionState() {
        val sessionId = mutableState.value.sessionId ?: return
        val event = PulseContract.envelope(
            type = "connection_status",
            sessionId = sessionId,
            payload = JSONObject()
                .put("phoneConnected", mutableState.value.watchConnected)
                .put("backendConnected", mutableState.value.backendConnected)
        )
        putWatchState(PulseDataLayer.CONNECTION_STATE_PATH, event)
    }

    private fun putWatchState(path: String, event: JSONObject, sessionElapsedMs: Long? = null) {
        val request = PutDataMapRequest.create(path).apply {
            dataMap.putString(PulseDataLayer.EVENT_JSON, event.toString())
            dataMap.putLong("changedAt", System.currentTimeMillis())
            if (sessionElapsedMs != null) dataMap.putLong("sessionElapsedMs", sessionElapsedMs)
        }.asPutDataRequest().setUrgent()
        Wearable.getDataClient(context).putDataItem(request)
    }

    private fun rememberWatchEvent(eventId: String) {
        synchronized(lock) {
            processedWatchEvents += eventId
            while (processedWatchEvents.size > 500) processedWatchEvents.remove(processedWatchEvents.first())
            prefs.edit().putStringSet("processed_watch_events", processedWatchEvents.toSet()).commit()
        }
    }

    private fun savePending() {
        check(prefs.edit().putString("pending_events", JSONArray(pending).toString()).commit()) {
            "Unable to persist the vital upload queue"
        }
    }

    private fun rememberRejectedEvent(event: JSONObject, error: String) {
        val rejected = JSONArray(prefs.getString("rejected_events", "[]"))
        rejected.put(JSONObject().put("event", event).put("error", error).put("rejectedAt", Instant.now().toString()))
        while (rejected.length() > 50) rejected.remove(0)
        prefs.edit().putString("rejected_events", rejected.toString()).commit()
    }

    private fun loadPending(): List<JSONObject> {
        val array = JSONArray(prefs.getString("pending_events", "[]"))
        return (0 until array.length()).map { array.getJSONObject(it) }
    }

    private fun restoredState() = PhoneVitalsState(
        sessionId = prefs.getString("session_id", null),
        sessionStatus = prefs.getString("session_status", "created") ?: "created",
        pendingEvents = pending.size
    )

    private fun websocketUrl(): String = BuildConfig.BACKEND_URL.trimEnd('/')
        .replaceFirst("http://", "ws://")
        .replaceFirst("https://", "wss://") + "/v1/session-stream"

    private fun restoreSessionStart(): Long {
        val savedElapsed = prefs.getLong("session_start_elapsed", 0)
        val savedBootEpoch = prefs.getLong("session_boot_epoch", 0)
        val currentBootEpoch = System.currentTimeMillis() - SystemClock.elapsedRealtime()
        if (savedElapsed > 0 && kotlin.math.abs(savedBootEpoch - currentBootEpoch) < 5_000) return savedElapsed
        val savedWall = prefs.getLong("session_start_wall", 0)
        return if (savedWall > 0) {
            SystemClock.elapsedRealtime() - (System.currentTimeMillis() - savedWall).coerceAtLeast(0)
        } else {
            SystemClock.elapsedRealtime()
        }
    }

    private fun sessionElapsedMs() =
        (SystemClock.elapsedRealtime() - sessionStartElapsedRealtimeMs).coerceAtLeast(0)

    private inline fun updateState(update: PhoneVitalsState.() -> PhoneVitalsState) {
        mutableState.value = mutableState.value.update()
    }
}
