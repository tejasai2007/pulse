package dev.nitrostack.coach.watch

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.wear.compose.material3.MaterialTheme
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
        setContent {
            MaterialTheme {
                Box(Modifier.fillMaxSize().background(WatchBackground)) {
                    VitalsScreen()
                }
            }
        }
    }

    @Composable
    private fun VitalsScreen() {
        val reading by WatchStateStore.heartRate.collectAsStateWithLifecycle()
        val bridge by WatchStateStore.state.collectAsStateWithLifecycle()
        val copilotDisabledReason = when {
            !bridge.phoneConnected -> "Copilot unavailable: connect the phone"
            !bridge.backendConnected -> "Copilot unavailable: connect the backend"
            bridge.sessionStatus != "active" -> "Copilot unavailable: start a session"
            bridge.copilotState in setOf("requested", "thinking", "queued", "playing") -> "Copilot request in progress"
            else -> null
        }
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

        val sessionActive = bridge.sessionStatus in setOf("calibrating", "active")
        val readingLive = permitted && reading.bpm != null && reading.availability == "available"
        BoxWithConstraints(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            val dialSize = minOf(maxWidth, maxHeight) - 16.dp
            HeartRateDial(
                reading = reading,
                permitted = permitted,
                live = readingLive,
                sessionActive = sessionActive,
                enabled = bridge.phoneConnected,
                copilotEnabled = BuildConfig.COPILOT_ENABLED,
                copilotAvailable = copilotDisabledReason == null,
                copilotLabel = if (copilotDisabledReason == null) "ASK COPILOT" else "COPILOT",
                size = dialSize,
                onSessionClick = { sendSessionAction(if (sessionActive) "end" else "start") },
                onCopilotClick = ::requestAdvice
            )
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
}

private val WatchBackground = Color(0xFF06141C)
private val WatchSurface = Color(0xFF102630)
private val WatchAccent = Color(0xFF72E7D1)
private val WatchMuted = Color(0xFFA8BAC1)
private val WatchOffline = Color(0xFF6F8087)
private val WatchStop = Color(0xFFFF8A80)

@Composable
private fun HeartRateDial(
    reading: HeartRateState,
    permitted: Boolean,
    live: Boolean,
    sessionActive: Boolean,
    enabled: Boolean,
    copilotEnabled: Boolean,
    copilotAvailable: Boolean,
    copilotLabel: String,
    size: Dp,
    onSessionClick: () -> Unit,
    onCopilotClick: () -> Unit
) {
    val actionColor = when {
        !enabled -> WatchOffline
        sessionActive -> WatchStop
        else -> WatchAccent
    }
    val compact = size < 180.dp
    Box(
        modifier = Modifier
            .size(size)
            .clip(CircleShape)
            .background(WatchSurface.copy(alpha = 0.45f)),
        contentAlignment = Alignment.Center
    ) {
        Canvas(Modifier.fillMaxSize()) {
            drawCircle(
                color = WatchSurface,
                style = Stroke(width = 7.dp.toPx())
            )
            drawArc(
                color = actionColor,
                startAngle = -90f,
                sweepAngle = if (enabled) 320f else 72f,
                useCenter = false,
                style = Stroke(width = 7.dp.toPx(), cap = StrokeCap.Round)
            )
        }
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(if (compact) 1.dp else 3.dp)
        ) {
            Text(
                "PULSE",
                color = WatchAccent,
                fontSize = if (compact) 10.sp else 12.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 2.2.sp
            )
            Text(
                if (permitted) reading.bpm?.toInt()?.toString() ?: "--" else "!",
                color = if (live) WatchAccent else Color.White,
                fontSize = if (compact) 48.sp else 54.sp,
                lineHeight = if (compact) 50.sp else 56.sp,
                fontWeight = FontWeight.Light
            )
            Text(
                when {
                    !permitted -> "SENSOR ACCESS"
                    reading.sensorSupported == false -> "UNSUPPORTED"
                    live -> "BPM / LIVE"
                    sessionActive -> "ACQUIRING"
                    else -> "BPM"
                },
                color = WatchMuted,
                fontSize = if (compact) 8.sp else 10.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.2.sp
            )
            Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                DialAction(
                    label = when {
                        !enabled -> "PHONE OFFLINE"
                        sessionActive -> "STOP"
                        else -> "START"
                    },
                    color = actionColor,
                    enabled = enabled,
                    compact = compact,
                    onClickLabel = if (sessionActive) "End session" else "Start session",
                    onClick = onSessionClick
                )
                if (copilotEnabled) {
                    DialAction(
                        label = copilotLabel,
                        color = if (copilotAvailable) WatchAccent else WatchOffline,
                        enabled = copilotAvailable,
                        compact = compact,
                        onClickLabel = "Ask copilot",
                        onClick = onCopilotClick
                    )
                }
            }
        }
    }
}

@Composable
private fun DialAction(
    label: String,
    color: Color,
    enabled: Boolean,
    compact: Boolean,
    onClickLabel: String,
    onClick: () -> Unit
) {
    Box(
        Modifier
            .clip(RoundedCornerShape(50))
            .background(color.copy(alpha = 0.16f))
            .clickable(enabled = enabled, onClickLabel = onClickLabel, role = Role.Button, onClick = onClick)
            .padding(horizontal = if (compact) 7.dp else 10.dp, vertical = 4.dp)
    ) {
        Text(
            label,
            color = color,
            fontSize = if (compact) 7.sp else 8.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 0.6.sp
        )
    }
}
