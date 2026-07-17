package dev.nitrostack.coach.phone

import dev.nitrostack.pulse.contracts.PulseContract
import dev.nitrostack.pulse.contracts.PulseLog
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.time.Instant
import java.util.UUID

class FoundationClient(private val scope: CoroutineScope) {
    private val client = OkHttpClient()
    private val mutableStatus = MutableStateFlow("Backend not checked")
    val status = mutableStatus.asStateFlow()

    fun checkHealth() = scope.launch(Dispatchers.IO) {
        val request = Request.Builder().url("${BuildConfig.BACKEND_URL}/health").build()
        mutableStatus.value = try {
            client.newCall(request).execute().use { response ->
                if (response.isSuccessful) "Backend healthy" else "Backend unavailable (${response.code})"
            }
        } catch (error: Exception) {
            "Backend unavailable: ${error.message}"
        }
    }

    fun sendMockSequence() = scope.launch(Dispatchers.IO) {
        val sessionId = "android-${UUID.randomUUID()}"
        val correlationId = UUID.randomUUID().toString()
        val now = Instant.now().toString()
        val session = JSONObject()
            .put("sessionId", sessionId)
            .put("status", "calibrating")
            .put("startedAt", now)
            .put("endedAt", JSONObject.NULL)
            .put("simulatedVitals", true)
            .put("audioInputRoute", "phone")
        val events = listOf(
            PulseContract.envelope("session_started", sessionId, JSONObject().put("session", session), correlationId = correlationId),
            PulseContract.envelope("vital_sample_received", sessionId, JSONObject()
                .put("sessionId", sessionId).put("bpm", 82).put("availability", "available")
                .put("sessionElapsedMs", 2_000).put("deviceTimestamp", Instant.now().toString())
                .put("source", "simulator"), correlationId = correlationId),
            PulseContract.envelope("transcript_segment_received", sessionId, JSONObject()
                .put("sessionId", sessionId).put("segmentId", UUID.randomUUID().toString())
                .put("speaker", "wearer").put("text", "This is a mock transcript event.")
                .put("startMs", 2_100).put("endMs", 2_900).put("providerTimestamp", Instant.now().toString())
                .put("confidence", 0.98).put("isFinal", true), correlationId = correlationId)
        )

        mutableStatus.value = try {
            events.forEach(::post)
            "Mock vitals + transcript accepted"
        } catch (error: Exception) {
            "Mock event failed: ${error.message}"
        }
    }

    private fun post(event: JSONObject) {
        PulseLog.boundary("phone", "phone_to_backend", event, "Sending mock event")
        val request = Request.Builder()
            .url("${BuildConfig.BACKEND_URL}/v1/events")
            .post(event.toString().toRequestBody("application/json".toMediaType()))
            .build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) error("${response.code}: ${response.body?.string()}")
        }
    }
}
