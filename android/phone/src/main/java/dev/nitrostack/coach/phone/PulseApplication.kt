package dev.nitrostack.coach.phone

import android.app.Application
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

class PulseApplication : Application() {
    lateinit var vitalPipeline: VitalPipeline
        private set
    lateinit var audioProbe: AudioProbe
        private set

    private val applicationScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    override fun onCreate() {
        super.onCreate()
        audioProbe = AudioProbe(this, applicationScope) { segment ->
            vitalPipeline.acceptTranscriptSegment(segment)
        }
        vitalPipeline = VitalPipeline(this) { audioProbe.speakHighHeartRateAlert() }
    }

    fun startSession(): Boolean {
        vitalPipeline.startSession()
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            vitalPipeline.reportMessage("Session started; open the phone app to grant microphone permission")
            return false
        }
        return if (TranscriptionService.start(this)) {
            true
        } else {
            vitalPipeline.reportMessage("Session started; Android blocked background transcription. Open the phone app and retry")
            false
        }
    }

    fun endSession() {
        audioProbe.stopCapture()
        TranscriptionService.stop(this)
        vitalPipeline.endSession()
    }

    companion object {
        fun pipeline(context: Context) = (context.applicationContext as PulseApplication).vitalPipeline
        fun instance(context: Context) = context.applicationContext as PulseApplication
    }
}
