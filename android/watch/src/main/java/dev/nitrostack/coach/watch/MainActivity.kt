package dev.nitrostack.coach.watch

import android.Manifest
import android.content.pm.PackageManager
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
import androidx.health.services.client.HealthServices
import androidx.health.services.client.MeasureCallback
import androidx.health.services.client.data.Availability
import androidx.health.services.client.data.DataPointContainer
import androidx.health.services.client.data.DataType
import androidx.health.services.client.data.DeltaDataType
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.Text
import com.google.android.gms.wearable.PutDataMapRequest
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.awaitCancellation

data class HeartRateState(val bpm: Double? = null, val availability: String = "Checking")

class MainActivity : ComponentActivity() {
    private val heartRate = MutableStateFlow(HeartRateState())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { MaterialTheme { HeartRateProbe(heartRate) } }
    }

    @Composable
    private fun HeartRateProbe(stateFlow: MutableStateFlow<HeartRateState>) {
        val state by stateFlow.collectAsStateWithLifecycle()
        var permitted by remember {
            mutableStateOf(ContextCompat.checkSelfPermission(this, Manifest.permission.BODY_SENSORS) == PackageManager.PERMISSION_GRANTED)
        }
        val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { permitted = it }

        LaunchedEffect(Unit) { if (!permitted) permission.launch(Manifest.permission.BODY_SENSORS) }
        if (permitted) HeartRateMeasurement(stateFlow)

        Column(
            modifier = Modifier.fillMaxSize(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center
        ) {
            Text(state.bpm?.let { "${it.toInt()} BPM" } ?: "-- BPM", style = MaterialTheme.typography.titleLarge)
            Text(if (permitted) state.availability else "Sensor permission required")
            Text("Vitals: ${BuildConfig.VITALS_SOURCE}")
            Button(onClick = { sendReading(state) }, enabled = state.bpm != null) { Text("Send to phone") }
        }
    }

    @Composable
    private fun HeartRateMeasurement(state: MutableStateFlow<HeartRateState>) {
        val measureClient = remember { HealthServices.getClient(this).measureClient }
        val callback = remember {
            object : MeasureCallback {
                override fun onAvailabilityChanged(dataType: DeltaDataType<*, *>, availability: Availability) {
                    if (dataType == DataType.HEART_RATE_BPM) state.value = state.value.copy(availability = availability.toString())
                }

                override fun onDataReceived(data: DataPointContainer) {
                    val bpm = data.getData(DataType.HEART_RATE_BPM).lastOrNull()?.value
                    if (bpm != null) {
                        state.value = HeartRateState(bpm, "Available")
                        sendReading(state.value)
                    }
                }
            }
        }

        LaunchedEffect(measureClient, callback) {
            try {
                measureClient.registerMeasureCallback(DataType.HEART_RATE_BPM, callback)
                awaitCancellation()
            } finally {
                measureClient.unregisterMeasureCallbackAsync(DataType.HEART_RATE_BPM, callback)
            }
        }
    }

    private fun sendReading(state: HeartRateState) {
        val bpm = state.bpm ?: return
        val request = PutDataMapRequest.create("/phase0/heart-rate").apply {
            dataMap.putDouble("bpm", bpm)
            dataMap.putLong("timestamp", System.currentTimeMillis())
            dataMap.putString("availability", state.availability)
        }.asPutDataRequest().setUrgent()
        Wearable.getDataClient(this).putDataItem(request)
    }
}
