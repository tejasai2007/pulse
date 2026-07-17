package dev.nitrostack.pulse.contracts

import android.util.Log
import org.json.JSONObject
import java.time.Instant

object PulseLog {
    fun boundary(component: String, boundary: String, event: JSONObject, message: String) {
        Log.i("Pulse", JSONObject()
            .put("timestamp", Instant.now().toString())
            .put("level", "info")
            .put("component", component)
            .put("message", message)
            .put("boundary", boundary)
            .put("sessionId", event.optString("sessionId"))
            .put("eventId", event.optString("eventId"))
            .put("correlationId", event.optString("correlationId"))
            .put("eventType", event.optString("type"))
            .toString())
    }
}
