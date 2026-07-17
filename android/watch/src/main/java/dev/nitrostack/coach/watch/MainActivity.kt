package dev.nitrostack.coach.watch

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.Text
import com.google.android.gms.wearable.PutDataMapRequest
import com.google.android.gms.wearable.Wearable
import dev.nitrostack.pulse.contracts.PulseContract
import dev.nitrostack.pulse.contracts.PulseDataLayer
import dev.nitrostack.pulse.contracts.PulseLog
import kotlinx.coroutines.delay
import kotlinx.coroutines.tasks.await
import org.json.JSONObject
import java.util.UUID

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WatchStateStore.restore(this)
        setContent { MaterialTheme { VitalsScreen() } }
    }

    @Composable
    private fun VitalsScreen() {
        val reading by WatchStateStore.heartRate.collectAsStateWithLifecycle()
        val bridge by WatchStateStore.state.collectAsStateWithLifecycle()
        var permitted by remember {
            mutableStateOf(ContextCompat.checkSelfPermission(this, Manifest.permission.BODY_SENSORS) == PackageManager.PERMISSION_GRANTED)
        }
        var backgroundPermitted by remember {
            mutableStateOf(
                Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
                    ContextCompat.checkSelfPermission(this, Manifest.permission.BODY_SENSORS_BACKGROUND) == PackageManager.PERMISSION_GRANTED
            )
        }
        val backgroundPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
            backgroundPermitted = it
        }
        val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
            permitted = it
            if (it && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !backgroundPermitted) {
                backgroundPermission.launch(Manifest.permission.BODY_SENSORS_BACKGROUND)
            }
        }

        LaunchedEffect(Unit) {
            if (!permitted) permission.launch(Manifest.permission.BODY_SENSORS)
            else if (!backgroundPermitted && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                backgroundPermission.launch(Manifest.permission.BODY_SENSORS_BACKGROUND)
            }
            while (true) {
                val connected = Wearable.getNodeClient(this@MainActivity).connectedNodes.await().isNotEmpty()
                WatchStateStore.updateConnection(phoneConnected = connected)
                delay(2_000)
            }
        }
        LaunchedEffect(permitted, bridge.sessionStatus) {
            if (permitted) HeartRateService.reconcile(this@MainActivity, bridge.sessionStatus)
        }

        Column(
            modifier = Modifier.fillMaxSize(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center
        ) {
            Text(reading.bpm?.let { "${it.toInt()} BPM" } ?: "-- BPM", style = MaterialTheme.typography.titleLarge)
            Text(if (permitted) availabilityLabel(reading) else "Sensor permission required")
            Text("Phone ${if (bridge.phoneConnected) "connected" else "offline"}")
            Text("Backend ${if (bridge.backendConnected) "connected" else "offline"}")
            Text("Session ${bridge.sessionStatus}")
            if (bridge.pendingEvents > 0) Text("${bridge.pendingEvents} reading(s) queued")
            if (BuildConfig.COPILOT_ENABLED) Text("Copilot ${bridge.copilotState}")
            Button(
                onClick = { sendSessionAction(if (bridge.sessionStatus in setOf("calibrating", "active")) "end" else "start") },
                enabled = bridge.phoneConnected
            ) {
                Text(if (bridge.sessionStatus in setOf("calibrating", "active")) "End session" else "Start session")
            }
            if (BuildConfig.COPILOT_ENABLED) {
                Button(
                    onClick = ::requestAdvice,
                    enabled = bridge.phoneConnected && bridge.sessionStatus == "active" &&
                        bridge.copilotState !in setOf("requested", "thinking", "queued", "playing")
                ) { Text("Ask copilot") }
            }
        }
    }

    private fun sendSessionAction(action: String) {
        val eventId = UUID.randomUUID().toString()
        val event = PulseContract.envelope(
            type = "session_action",
            sessionId = WatchStateStore.state.value.sessionId ?: "watch-request-$eventId",
            eventId = eventId,
            payload = JSONObject().put("action", action)
        )
        val request = PutDataMapRequest.create(PulseDataLayer.sessionActionPath(eventId)).apply {
            dataMap.putString(PulseDataLayer.EVENT_JSON, event.toString())
        }.asPutDataRequest().setUrgent()
        Wearable.getDataClient(this).putDataItem(request).addOnSuccessListener {
            WatchStateStore.addPending(this, eventId)
            PulseLog.boundary("watch", "watch_to_phone", event, "Queued session action")
        }
    }

    private fun requestAdvice() {
        val eventId = UUID.randomUUID().toString()
        val requestId = UUID.randomUUID().toString()
        val sessionId = WatchStateStore.state.value.sessionId ?: return
        val event = PulseContract.envelope(
            type = "advice_requested",
            sessionId = sessionId,
            eventId = eventId,
            payload = JSONObject().put("requestId", requestId)
        )
        val request = PutDataMapRequest.create(PulseDataLayer.adviceRequestPath(eventId)).apply {
            dataMap.putString(PulseDataLayer.EVENT_JSON, event.toString())
        }.asPutDataRequest().setUrgent()
        Wearable.getDataClient(this).putDataItem(request).addOnSuccessListener {
            WatchStateStore.addPending(this, eventId)
            WatchStateStore.updateCopilotState(this, "requested")
            PulseLog.boundary("watch", "watch_to_phone", event, "Queued advice request")
        }
    }

    private fun availabilityLabel(state: HeartRateState) = when (state.sensorSupported) {
        false -> "Heart rate unsupported"
        null -> "Checking sensor"
        true -> "Sensor ${state.availability.replace('_', ' ')}"
    }

}
