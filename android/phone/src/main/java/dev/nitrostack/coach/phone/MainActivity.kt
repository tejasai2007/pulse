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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import com.google.android.gms.wearable.DataClient
import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import java.text.DateFormat
import java.util.Date

class MainActivity : ComponentActivity(), DataClient.OnDataChangedListener {
    private var heartRate by mutableStateOf("No watch reading")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { MaterialTheme { PhaseZeroScreen() } }
    }

    override fun onResume() {
        super.onResume()
        Wearable.getDataClient(this).addListener(this)
    }

    override fun onPause() {
        Wearable.getDataClient(this).removeListener(this)
        super.onPause()
    }

    override fun onDataChanged(events: DataEventBuffer) {
        events.filter { it.type == DataEvent.TYPE_CHANGED && it.dataItem.uri.path == "/phase0/heart-rate" }
            .forEach {
                val data = DataMapItem.fromDataItem(it.dataItem).dataMap
                val time = DateFormat.getTimeInstance().format(Date(data.getLong("timestamp")))
                runOnUiThread {
                    heartRate = "${data.getDouble("bpm").toInt()} BPM at $time (${data.getString("availability")})"
                }
            }
    }

    @Composable
    private fun PhaseZeroScreen() {
        val probe = remember { AudioProbe(this, lifecycleScope) }
        val foundation = remember { FoundationClient(lifecycleScope) }
        val audio by probe.state.collectAsStateWithLifecycle()
        val foundationStatus by foundation.status.collectAsStateWithLifecycle()
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
            foundation.checkHealth()
        }
        DisposableEffect(probe) { onDispose { probe.close() } }

        Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Pulse foundation", style = MaterialTheme.typography.headlineMedium)
            Text("Vitals: ${BuildConfig.VITALS_SOURCE} | Audio: ${BuildConfig.AUDIO_INPUT}")
            Text("Transcription: ${BuildConfig.TRANSCRIPTION_MODE} | Actions: ${BuildConfig.DEVICE_ACTIONS}")
            Text(foundationStatus)
            Text("Watch: $heartRate")
            Text("Audio route: ${audio.route}")
            Text(audio.status)
            if (audio.transcript.isNotBlank()) Text("Final transcript: ${audio.transcript}")
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { selectEarbudsOrFallback(probe) }, enabled = permissionGranted) { Text("Select earbuds") }
                Button(onClick = { sendHaptic() }) { Text("Vibrate watch") }
            }
            Button(onClick = foundation::sendMockSequence) { Text("Send mock events") }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { if (audio.capturing) probe.stopCapture() else probe.startCapture() }, enabled = permissionGranted) {
                    Text(if (audio.capturing) "Stop capture" else "Record + transcribe")
                }
                Button(onClick = probe::speakProbe, enabled = permissionGranted) { Text("Play TTS") }
            }
            if (!permissionGranted) Text("Microphone and nearby-device permissions are required.")
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
