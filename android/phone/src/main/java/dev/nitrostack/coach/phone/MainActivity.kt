package dev.nitrostack.coach.phone

import android.Manifest
import android.content.pm.PackageManager
import android.media.AudioDeviceInfo
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { MaterialTheme { PulseScreen() } }
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
        Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Pulse vitals", style = MaterialTheme.typography.headlineMedium)
            if (BuildConfig.VITALS_SOURCE == "simulated") Text("SIMULATED VITALS", color = MaterialTheme.colorScheme.error)
            Text("Session: ${vitals.sessionStatus} ${vitals.sessionId.orEmpty()}")
            Text(vitals.latestBpm?.let {
                "${it.toInt()} BPM - ${if (stale) "STALE" else "LIVE"} - ${vitals.source}"
            } ?: "No heart-rate reading")
            Text("Sensor: ${vitals.availability}")
            Text("Exercise mode: ${if (vitals.exerciseMode) "on" else "off"}")
            Text("Watch: ${if (vitals.watchConnected) "connected" else "offline"} | Backend: ${if (vitals.backendConnected) "connected" else "offline"}")
            Text("Upload queue: ${vitals.pendingEvents} | ${vitals.message}")
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = application::startSession,
                    enabled = vitals.sessionStatus !in setOf("calibrating", "active")
                ) { Text("Start session") }
                Button(
                    onClick = application::endSession,
                    enabled = vitals.sessionStatus in setOf("calibrating", "active")
                ) { Text("End session") }
            }
            Button(
                onClick = pipeline::toggleExerciseMode,
                enabled = vitals.sessionStatus in setOf("calibrating", "active")
            ) { Text(if (vitals.exerciseMode) "Stop exercise mode" else "Start exercise mode") }
            if (BuildConfig.DEBUG && BuildConfig.VITALS_SOURCE == "simulated") {
                Button(onClick = { if (vitals.simulatorRunning) pipeline.stopSimulator() else pipeline.startSimulator() }) {
                    Text(if (vitals.simulatorRunning) "Stop simulator" else "Run simulated sequence")
                }
            }
            Text("Audio route: ${audio.route} | ${audio.status}")
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { selectEarbudsOrFallback(probe) }, enabled = permissionGranted) { Text("Select earbuds") }
                Button(onClick = { sendHaptic() }) { Text("Vibrate watch") }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { if (audio.capturing) probe.stopCapture() else probe.startCapture(pipeline.currentSessionElapsedMs()) }, enabled = permissionGranted) {
                    Text(if (audio.capturing) "Stop capture" else "Record + transcribe")
                }
                Button(onClick = probe::speakProbe, enabled = permissionGranted) { Text("Play TTS") }
            }
            if (audio.transcript.isNotBlank()) Text("Final transcript: ${audio.transcript}")
            if (!permissionGranted) Text("Microphone and nearby-device permissions are required for audio probes.")
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
