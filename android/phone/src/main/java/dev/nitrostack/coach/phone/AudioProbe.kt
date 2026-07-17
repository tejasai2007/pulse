package dev.nitrostack.coach.phone

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject
import java.util.Locale

data class AudioProbeState(
    val route: String = "Phone microphone",
    val capturing: Boolean = false,
    val status: String = "Ready",
    val transcript: String = "",
    val interimTranscript: String = ""
)

data class FinalTranscriptSegment(
    val text: String,
    val startMs: Long,
    val endMs: Long,
    val confidence: Double?
)

class AudioProbe(
    private val context: Context,
    private val scope: CoroutineScope,
    private val currentTimelineMs: () -> Long = { 0L },
    private val onFinalTranscript: (FinalTranscriptSegment) -> Unit = {}
) : TextToSpeech.OnInitListener {
    val state = MutableStateFlow(AudioProbeState())
    private val audioManager = context.getSystemService(AudioManager::class.java)
    private val client = OkHttpClient()
    private val tts = TextToSpeech(context, this)
    private var selectedDevice: AudioDeviceInfo? = null
    private var captureJob: Job? = null
    private var recorder: AudioRecord? = null
    private var socket: WebSocket? = null
    private var reconnectJob: Job? = null
    private var reconnectAttempt = 0
    private var captureTimelineOffsetMs = 0L
    private val completionCallbacks = mutableMapOf<String, (String) -> Unit>()
    private var activeCommandId: String? = null

    override fun onInit(result: Int) {
        if (result == TextToSpeech.SUCCESS) tts.language = Locale.US
        else state.value = state.value.copy(status = "TTS initialization failed")
        tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) = Unit
            override fun onError(utteranceId: String?) = finishUtterance(utteranceId, "failed")
            override fun onDone(utteranceId: String?) = finishUtterance(utteranceId, "played")
        })
    }

    fun routes(): List<AudioDeviceInfo> = audioManager.availableCommunicationDevices

    fun selectRoute(device: AudioDeviceInfo?) {
        selectedDevice = device
        val routed = device != null && audioManager.setCommunicationDevice(device)
        val name = if (routed) device.productName.toString() else "Phone microphone"
        state.value = state.value.copy(route = name, status = if (routed) "Communication route selected" else "Phone-mic fallback active")
    }

    @SuppressLint("MissingPermission")
    fun startCapture(timelineOffsetMs: Long = 0) {
        if (captureJob != null) return
        captureTimelineOffsetMs = timelineOffsetMs
        val sampleRate = 16_000
        val minimum = AudioRecord.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val format = AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(sampleRate)
            .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
            .build()
        val newRecorder = AudioRecord.Builder()
            .setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION)
            .setAudioFormat(format)
            .setBufferSizeInBytes(minimum * 2)
            .build()
        selectedDevice?.let(newRecorder::setPreferredDevice)
        recorder = newRecorder
        newRecorder.startRecording()
        state.value = state.value.copy(capturing = true, status = "Connecting transcription", interimTranscript = "")
        captureJob = scope.launch(Dispatchers.IO) {
            val buffer = ByteArray(minimum)
            while (currentCoroutineContext().isActive) {
                val read = newRecorder.read(buffer, 0, buffer.size)
                if (read > 0) {
                    socket?.send(ByteString.of(*buffer.copyOf(read)))
                }
            }
        }
        socket = openTranscriptionSocket()
    }

    fun stopCapture(onStopped: (() -> Unit)? = null) {
        val job = captureJob ?: run { onStopped?.invoke(); return }
        captureJob = null
        reconnectJob?.cancel()
        reconnectJob = null
        scope.launch {
            recorder?.stop()
            job.cancelAndJoin()
            recorder?.release()
            recorder = null
            socket?.send("{\"type\":\"Finalize\"}")
            socket?.close(1000, "capture complete")
            socket = null
            state.value = state.value.copy(capturing = false, status = "Capture stopped", interimTranscript = "")
            onStopped?.invoke()
        }
    }

    fun speakProbe() {
        speak("Take a breath. You are ready.", "phase-zero")
    }

    fun speakHighHeartRateAlert() {
        speak("Your heart rate is high. Please stop, sit down, and take slow breaths. Seek medical help now if you have chest pain, severe shortness of breath, dizziness, or fainting.", "high-heart-rate-alert")
    }

    fun speakCommand(text: String, commandId: String, completed: (String) -> Unit) {
        activeCommandId = commandId
        speak(text, commandId, completed)
    }

    fun cancelCommand(commandId: String) {
        if (activeCommandId != commandId) return
        tts.stop()
        activeCommandId = null
        completionCallbacks.remove(commandId)?.invoke("cancelled")
        completionCallbacks.remove("$commandId-resume")?.invoke("cancelled")
    }

    private fun speak(text: String, utteranceId: String, completed: ((String) -> Unit)? = null) {
        val wasCapturing = captureJob != null
        stopCapture {
            val actualUtteranceId = if (wasCapturing) "$utteranceId-resume" else utteranceId
            if (completed != null) completionCallbacks[actualUtteranceId] = completed
            tts.speak(
                text,
                TextToSpeech.QUEUE_FLUSH,
                android.os.Bundle().apply {
                    putInt(TextToSpeech.Engine.KEY_PARAM_STREAM, AudioManager.STREAM_MUSIC)
                },
                actualUtteranceId
            )
            state.value = state.value.copy(status = "Playing TTS through ${state.value.route}")
        }
    }

    private fun finishUtterance(utteranceId: String?, result: String) {
        if (utteranceId == null) return
        completionCallbacks.remove(utteranceId)?.invoke(result)
        activeCommandId = null
        if (utteranceId.endsWith("-resume")) resumeAfterTts()
    }

    private fun resumeAfterTts() {
        scope.launch(Dispatchers.Main) {
            startCapture(currentTimelineMs())
            state.value = state.value.copy(status = "TTS complete; capture resumed")
        }
    }

    private fun openTranscriptionSocket(): WebSocket? {
        if (BuildConfig.DEEPGRAM_API_KEY.isBlank()) {
            state.value = state.value.copy(status = "Capturing locally; DEEPGRAM_API_KEY is missing")
            return null
        }
        val request = Request.Builder()
            .url("wss://api.deepgram.com/v1/listen?model=nova-3&language=en-US&encoding=linear16&sample_rate=16000&channels=1&punctuate=true&interim_results=true")
            .header("Authorization", "Token ${BuildConfig.DEEPGRAM_API_KEY}")
            .build()
        return client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (webSocket != socket) return
                reconnectAttempt = 0
                state.value = state.value.copy(status = "Deepgram stream connected")
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (webSocket != socket) return
                val json = JSONObject(text)
                val alternative = json.optJSONObject("channel")?.optJSONArray("alternatives")?.optJSONObject(0)
                val transcript = alternative?.optString("transcript").orEmpty()
                if (!json.optBoolean("is_final")) {
                    state.value = state.value.copy(interimTranscript = transcript)
                    return
                }
                if (transcript.isNotBlank()) {
                    val startMs = captureTimelineOffsetMs + (json.optDouble("start", 0.0) * 1_000).toLong()
                    val endMs = startMs + (json.optDouble("duration", 0.0) * 1_000).toLong()
                    val confidence = alternative?.optDouble("confidence")?.takeUnless { it.isNaN() }
                    state.value = state.value.copy(
                        transcript = transcript,
                        interimTranscript = "",
                        status = "Final transcript uploaded"
                    )
                    onFinalTranscript(FinalTranscriptSegment(transcript, startMs, endMs, confidence))
                }
            }

            override fun onFailure(webSocket: WebSocket, error: Throwable, response: Response?) {
                reconnect(webSocket, error.message ?: "connection failed")
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                reconnect(webSocket, "connection closed")
            }
        })
    }

    private fun reconnect(failedSocket: WebSocket, reason: String) {
        if (failedSocket != socket) return
        socket = null
        if (!state.value.capturing || reconnectJob?.isActive == true) return
        reconnectJob = scope.launch {
            val waitMs = 1_000L shl reconnectAttempt.coerceAtMost(4)
            reconnectAttempt++
            state.value = state.value.copy(status = "Transcription reconnecting in ${waitMs / 1_000}s: $reason")
            delay(waitMs)
            if (!state.value.capturing) return@launch
            captureTimelineOffsetMs = currentTimelineMs()
            socket = openTranscriptionSocket()
        }
    }

    fun close() {
        stopCapture()
        audioManager.clearCommunicationDevice()
        tts.shutdown()
    }
}
