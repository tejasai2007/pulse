package dev.nitrostack.coach.phone

import android.Manifest
import android.content.pm.PackageManager
import android.media.AudioDeviceInfo
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.activity.compose.setContent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await

fun heartRateDisplay(bpm: Double?, stale: Boolean, source: String): String = when {
    bpm == null -> "No heart-rate reading"
    stale -> "No live heart-rate reading - STALE - $source"
    else -> "${bpm.toInt()} BPM - LIVE - $source"
}

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            MaterialTheme(
                colorScheme = darkColorScheme(
                    primary = Color(0xFF72E7D1),
                    onPrimary = Color(0xFF00382F),
                    secondary = Color(0xFF9FC9FF),
                    background = Color(0xFF07131C),
                    surface = Color(0xFF0E202B),
                    surfaceVariant = Color(0xFF172D38),
                    onSurface = Color(0xFFE8F2F5),
                    onSurfaceVariant = Color(0xFFA9BBC3),
                    error = Color(0xFFFF8A80)
                )
            ) {
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    PulseScreen()
                }
            }
        }
    }

    @Composable
    private fun PulseScreen() {
        val application = remember { PulseApplication.instance(this) }
        val probe = application.audioProbe
        val pipeline = application.vitalPipeline
        val audio by probe.state.collectAsStateWithLifecycle()
        val vitals by pipeline.state.collectAsStateWithLifecycle()
        var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
        var permissionGranted by remember {
            mutableStateOf(
                ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED &&
                    ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
            )
        }
        val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
            permissionGranted = it[Manifest.permission.RECORD_AUDIO] == true && it[Manifest.permission.BLUETOOTH_CONNECT] == true
        }
        LaunchedEffect(Unit) {
            if (!permissionGranted) permission.launch(arrayOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.BLUETOOTH_CONNECT))
            while (true) {
                pipeline.setWatchConnected(Wearable.getNodeClient(this@MainActivity).connectedNodes.await().isNotEmpty())
                now = System.currentTimeMillis()
                delay(1_000)
            }
        }
        val stale = isReadingStale(vitals.latestReceivedAtEpochMs, now)
        val latestBpm = vitals.latestBpm
        val sessionActive = vitals.sessionStatus in setOf("calibrating", "active")
        val liveReading = latestBpm != null && !stale
        Column(
            Modifier
                .fillMaxSize()
                .windowInsetsPadding(androidx.compose.foundation.layout.WindowInsets.safeDrawing)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp, vertical = 18.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column {
                    Text(
                        "PULSE",
                        color = MaterialTheme.colorScheme.primary,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold,
                        letterSpacing = 2.4.sp
                    )
                    Text("Session monitor", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold)
                }
                StatusPill(
                    label = if (BuildConfig.VITALS_SOURCE == "simulated") "SIMULATED" else "WATCH",
                    healthy = BuildConfig.VITALS_SOURCE != "simulated"
                )
            }

            Card(
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                shape = RoundedCornerShape(28.dp)
            ) {
                Column(Modifier.padding(22.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.Top
                    ) {
                        Column {
                            Text("HEART RATE", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Row(verticalAlignment = Alignment.Bottom) {
                                Text(
                                    latestBpm?.toInt()?.toString() ?: "--",
                                    fontSize = 62.sp,
                                    lineHeight = 64.sp,
                                    fontWeight = FontWeight.Light,
                                    color = if (liveReading) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface
                                )
                                Text(" bpm", modifier = Modifier.padding(bottom = 9.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                        StatusPill(
                            label = if (liveReading) "LIVE" else if (stale && latestBpm != null) "STALE" else "WAITING",
                            healthy = liveReading
                        )
                    }
                    Text(
                        if (latestBpm == null) "Start a session to begin reading ${vitals.source} vitals."
                        else "Sensor ${prettyStatus(vitals.availability)} from ${vitals.source}.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Button(
                        onClick = {
                            if (sessionActive) application.endSession() else application.startSession()
                        },
                        modifier = Modifier.fillMaxWidth().heightIn(min = 54.dp),
                        colors = if (sessionActive) ButtonDefaults.buttonColors(
                            containerColor = MaterialTheme.colorScheme.surfaceVariant,
                            contentColor = MaterialTheme.colorScheme.onSurface
                        ) else ButtonDefaults.buttonColors(),
                        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 14.dp)
                    ) {
                        Text(if (sessionActive) "End session" else "Start session", fontWeight = FontWeight.Bold)
                    }
                }
            }

            SectionLabel("SESSION HEALTH")
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                StatusCard("Watch", if (vitals.watchConnected) "Connected" else "Offline", vitals.watchConnected, Modifier.weight(1f))
                StatusCard("Backend", if (vitals.backendConnected) "Connected" else "Offline", vitals.backendConnected, Modifier.weight(1f))
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                StatusCard("Session", prettyStatus(vitals.sessionStatus), sessionActive, Modifier.weight(1f))
                StatusCard("Upload queue", vitals.pendingEvents.toString(), vitals.pendingEvents == 0, Modifier.weight(1f))
            }

            if (BuildConfig.COPILOT_ENABLED) {
                SectionLabel("CONVERSATION COPILOT")
                Card(
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                    shape = RoundedCornerShape(18.dp)
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(16.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(
                                if (vitals.copilotState == "completed") "Advice ready" else prettyStatus(vitals.copilotState),
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.SemiBold
                            )
                            Text(
                                if (sessionActive) "Vitals access is consented for this session."
                                else "Starts automatically with an active session.",
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                style = MaterialTheme.typography.bodySmall
                            )
                        }
                        StatusPill(vitals.copilotState.uppercase(), vitals.copilotState == "completed")
                    }
                }
            }

            SectionLabel("AUDIO & COACHING")
            Card(
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                shape = RoundedCornerShape(22.dp)
            ) {
                Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(audio.route, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                        Text(audio.status, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        OutlinedButton(
                            onClick = { selectEarbudsOrFallback(probe) },
                            enabled = permissionGranted,
                            modifier = Modifier.weight(1f).heightIn(min = 50.dp)
                        ) { Text("Audio route", maxLines = 1) }
                        OutlinedButton(
                            onClick = { sendHaptic() },
                            modifier = Modifier.weight(1f).heightIn(min = 50.dp)
                        ) { Text("Test watch", maxLines = 1) }
                    }
                    Button(
                        onClick = { if (audio.capturing) probe.stopCapture() else probe.startCapture(pipeline.currentSessionElapsedMs()) },
                        enabled = permissionGranted,
                        modifier = Modifier.fillMaxWidth().heightIn(min = 54.dp)
                    ) {
                        Text(if (audio.capturing) "Stop transcription" else "Record and transcribe", fontWeight = FontWeight.Bold)
                    }
                    OutlinedButton(
                        onClick = probe::speakProbe,
                        enabled = permissionGranted,
                        modifier = Modifier.fillMaxWidth().heightIn(min = 50.dp)
                    ) { Text("Play coaching prompt") }
                    OutlinedButton(
                        onClick = pipeline::toggleExerciseMode,
                        enabled = sessionActive,
                        modifier = Modifier.fillMaxWidth().heightIn(min = 50.dp)
                    ) { Text(if (vitals.exerciseMode) "Stop exercise mode" else "Start exercise mode") }
                    if (BuildConfig.DEBUG && BuildConfig.VITALS_SOURCE == "simulated") {
                        OutlinedButton(
                            onClick = { if (vitals.simulatorRunning) pipeline.stopSimulator() else pipeline.startSimulator() },
                            modifier = Modifier.fillMaxWidth().heightIn(min = 50.dp)
                        ) { Text(if (vitals.simulatorRunning) "Stop simulated sequence" else "Run simulated sequence") }
                    }
                }
            }

            if (audio.interimTranscript.isNotBlank() || audio.transcript.isNotBlank()) {
                SectionLabel(if (audio.interimTranscript.isNotBlank()) "LIVE CAPTION" else "LATEST TRANSCRIPT")
                Card(
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
                    shape = RoundedCornerShape(18.dp)
                ) {
                    Text(
                        audio.interimTranscript.ifBlank { audio.transcript },
                        modifier = Modifier.padding(18.dp),
                        style = MaterialTheme.typography.bodyLarge,
                        lineHeight = 25.sp
                    )
                }
            }

            Surface(
                color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.7f),
                shape = RoundedCornerShape(16.dp)
            ) {
                Text(
                    vitals.message,
                    modifier = Modifier.fillMaxWidth().padding(14.dp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis
                )
            }
            if (!permissionGranted) {
                Text(
                    "Microphone and nearby-device permissions are required for audio tools.",
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall
                )
            }
            Spacer(Modifier.height(6.dp))
        }
    }

    private fun selectEarbudsOrFallback(probe: AudioProbe) {
        val earbuds = probe.routes().firstOrNull {
            it.type == AudioDeviceInfo.TYPE_BLE_HEADSET || it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
        }
        probe.selectRoute(earbuds)
    }

    private fun sendHaptic() {
        lifecycleScope.launch {
            val nodes = Wearable.getNodeClient(this@MainActivity).connectedNodes.await()
            nodes.forEach { Wearable.getMessageClient(this@MainActivity).sendMessage(it.id, "/phase0/haptic", byteArrayOf()).await() }
        }
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        fontSize = 11.sp,
        fontWeight = FontWeight.Bold,
        letterSpacing = 1.6.sp
    )
}

@Composable
private fun StatusPill(label: String, healthy: Boolean) {
    Surface(
        color = if (healthy) MaterialTheme.colorScheme.primary.copy(alpha = 0.14f)
        else MaterialTheme.colorScheme.surfaceVariant,
        shape = RoundedCornerShape(50)
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 11.dp, vertical = 7.dp),
            horizontalArrangement = Arrangement.spacedBy(7.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Box(
                Modifier
                    .size(7.dp)
                    .background(
                        if (healthy) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                        CircleShape
                    )
            )
            Text(label, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.sp)
        }
    }
}

@Composable
private fun StatusCard(label: String, value: String, healthy: Boolean, modifier: Modifier = Modifier) {
    Card(
        modifier = modifier,
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        shape = RoundedCornerShape(18.dp)
    ) {
        Column(Modifier.fillMaxWidth().padding(15.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                Box(
                    Modifier
                        .size(7.dp)
                        .background(
                            if (healthy) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
                            CircleShape
                        )
                )
                Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text(value, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, maxLines = 1)
        }
    }
}

private fun prettyStatus(value: String): String = value
    .replace('_', ' ')
    .replaceFirstChar { if (it.isLowerCase()) it.titlecase() else it.toString() }
