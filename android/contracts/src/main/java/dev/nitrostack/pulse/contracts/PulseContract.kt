package dev.nitrostack.pulse.contracts

import org.json.JSONObject
import java.time.Instant
import java.util.UUID

object PulseContract {
    const val VERSION = "1.0"

    val eventTypes = setOf(
        "heart_rate_sample", "heart_rate_availability", "watch_status", "session_action",
        "session_state", "haptic_command", "connection_status", "session_started",
        "session_ended", "session_context_updated", "vital_sample_received",
        "transcript_segment_received", "audio_route_changed", "consent_updated",
        "playback_completed", "play_tts", "cancel_tts", "send_watch_haptic", "report_ready"
    )

    fun envelope(
        type: String,
        sessionId: String,
        payload: JSONObject,
        eventId: String = UUID.randomUUID().toString(),
        correlationId: String = UUID.randomUUID().toString(),
        timestamp: String = Instant.now().toString()
    ): JSONObject {
        require(type in eventTypes) { "Unknown Pulse event type: $type" }
        require(sessionId.isNotBlank()) { "sessionId is required" }
        return JSONObject()
            .put("version", VERSION)
            .put("type", type)
            .put("sessionId", sessionId)
            .put("eventId", eventId)
            .put("timestamp", timestamp)
            .put("correlationId", correlationId)
            .put("payload", payload)
    }

    fun validateEnvelope(json: String): JSONObject {
        val event = JSONObject(json)
        require(event.getString("version") == VERSION) { "Unsupported contract version" }
        require(event.getString("type") in eventTypes) { "Unknown event type" }
        listOf("sessionId", "eventId", "timestamp", "correlationId").forEach {
            require(event.getString(it).isNotBlank()) { "$it is required" }
        }
        event.getJSONObject("payload")
        return event
    }
}
