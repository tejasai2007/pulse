package dev.nitrostack.coach.watch

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import androidx.core.content.ContextCompat
import androidx.health.services.client.ExerciseUpdateCallback
import androidx.health.services.client.HealthServices
import androidx.health.services.client.data.Availability
import androidx.health.services.client.data.DataType
import androidx.health.services.client.data.ExerciseConfig
import androidx.health.services.client.data.ExerciseEvent
import androidx.health.services.client.data.ExerciseLapSummary
import androidx.health.services.client.data.ExerciseTrackedStatus
import androidx.health.services.client.data.ExerciseType
import androidx.health.services.client.data.ExerciseUpdate
import com.google.android.gms.wearable.PutDataMapRequest
import com.google.android.gms.wearable.Wearable
import dev.nitrostack.pulse.contracts.PulseContract
import dev.nitrostack.pulse.contracts.PulseDataLayer
import dev.nitrostack.pulse.contracts.PulseLog
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.time.Instant
import java.util.UUID

class HeartRateService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val exerciseClient by lazy { HealthServices.getClient(this).exerciseClient }
    private val operationMutex = Mutex()
    private var operationJob: Job? = null
    private var retryJob: Job? = null
    private var callbackRegistered = false
    private var foregroundStarted = false
    private var trackedSessionId: String? = null
    private var wakeLock: PowerManager.WakeLock? = null

    private val callback = object : ExerciseUpdateCallback {
        override fun onRegistered() = Unit

        override fun onRegistrationFailed(throwable: Throwable) {
            callbackRegistered = false
            reportUnavailable("Heart-rate listener failed: ${throwable.message.orEmpty()}")
            scheduleRetry()
        }

        override fun onExerciseUpdateReceived(update: ExerciseUpdate) {
            if (isTrackingCurrentSession()) {
                update.latestMetrics.getData(DataType.HEART_RATE_BPM).forEach { sample ->
                    WatchStateStore.updateHeartRate(sample.value, "available", true)
                    sendReading(sample.value)
                }
            }
            if (update.exerciseStateInfo.state.isEnded && isTrackingCurrentSession()) {
                reportUnavailable("Heart-rate exercise ended")
                clearTrackedSession()
                scheduleRetry()
            }
        }

        override fun onLapSummaryReceived(lapSummary: ExerciseLapSummary) = Unit

        override fun onAvailabilityChanged(dataType: DataType<*, *>, availability: Availability) {
            if (dataType != DataType.HEART_RATE_BPM) return
            val normalized = normalizeAvailability(availability)
            if (!isTrackingCurrentSession()) return
            WatchStateStore.updateHeartRate(availability = normalized, clearBpm = normalized != "available")
            sendAvailability(normalized)
        }

        override fun onExerciseEventReceived(event: ExerciseEvent) = Unit
    }

    override fun onCreate() {
        super.onCreate()
        WatchStateStore.restore(this)
        createNotificationChannel()
        val notification = Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setContentTitle("Pulse session active")
            .setContentText("Monitoring heart rate")
            .setOngoing(true)
            .build()
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_HEALTH)
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
            foregroundStarted = true
        } catch (error: Exception) {
            reportUnavailable("Android blocked heart-rate monitoring: ${error.message.orEmpty()}")
            stopSelf()
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!foregroundStarted) return START_NOT_STICKY
        if (intent?.action == ACTION_STOP || !isSessionActive()) {
            scheduleReconcile()
            return START_STICKY
        } else if (ContextCompat.checkSelfPermission(this, Manifest.permission.BODY_SENSORS) != PackageManager.PERMISSION_GRANTED) {
            reportUnavailable("Heart-rate permission required")
            stopSelf()
            return START_NOT_STICKY
        }
        scheduleReconcile()
        return START_STICKY
    }

    override fun onDestroy() {
        if (callbackRegistered) exerciseClient.clearUpdateCallbackAsync(callback)
        retryJob?.cancel()
        releaseWakeLock()
        scope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun scheduleReconcile() {
        if (operationJob?.isActive == true) return
        operationJob = scope.launch {
            operationMutex.withLock {
                repeat(3) {
                    val requestedSessionId = activeSessionId()
                    val succeeded = if (requestedSessionId != null) startOrReattach() else stopExercise()
                    if (!succeeded) return@withLock
                    if (activeSessionId() == requestedSessionId) {
                        if (requestedSessionId == null) stopSelf()
                        return@withLock
                    }
                }
            }
        }
    }

    private suspend fun startOrReattach(): Boolean {
        try {
            if (!callbackRegistered) {
                exerciseClient.setUpdateCallback(callback)
                callbackRegistered = true
            }
            val requestedSessionId = WatchStateStore.state.value.sessionId ?: return false
            val info = withContext(Dispatchers.IO) { exerciseClient.getCurrentExerciseInfoAsync().get() }
            when (info.exerciseTrackedStatus) {
                ExerciseTrackedStatus.OWNED_EXERCISE_IN_PROGRESS -> {
                    val ownerSessionId = getSharedPreferences(PREFS, MODE_PRIVATE)
                        .getString(TRACKED_SESSION_ID, null)
                    if (ownerSessionId != requestedSessionId) {
                        withContext(Dispatchers.IO) { exerciseClient.endExerciseAsync().get() }
                        clearTrackedSession()
                        return startExercise(requestedSessionId)
                    }
                    trackedSessionId = requestedSessionId
                    acquireWakeLock()
                    WatchStateStore.updateHeartRate(
                        availability = "acquiring",
                        sensorSupported = true,
                        clearBpm = true
                    )
                }
                ExerciseTrackedStatus.OTHER_APP_IN_PROGRESS -> {
                    reportUnavailable("Another app is monitoring an exercise")
                    scheduleRetry()
                    return false
                }
                else -> return startExercise(requestedSessionId)
            }
            return true
        } catch (error: Exception) {
            reportUnavailable("Unable to monitor heart rate: ${error.cause?.message ?: error.message.orEmpty()}")
            scheduleRetry()
            return false
        }
    }

    private suspend fun startExercise(sessionId: String): Boolean {
        val capabilities = withContext(Dispatchers.IO) { exerciseClient.getCapabilitiesAsync().get() }
        val exerciseType = listOf(ExerciseType.WORKOUT, ExerciseType.EXERCISE_CLASS)
            .firstOrNull { type ->
                type in capabilities.supportedExerciseTypes &&
                    DataType.HEART_RATE_BPM in capabilities.getExerciseTypeCapabilities(type).supportedDataTypes
            }
        if (exerciseType == null) {
            WatchStateStore.updateHeartRate(availability = "unavailable", sensorSupported = false, clearBpm = true)
            sendAvailability("unavailable")
            PulseLog.boundary(
                "watch",
                "health_services",
                JSONObject().put("message", "Continuous heart rate is unsupported"),
                "Continuous heart rate is unsupported"
            )
            stopSelf()
            return false
        }
        WatchStateStore.updateHeartRate(availability = "acquiring", sensorSupported = true, clearBpm = true)
        val config = ExerciseConfig.builder(exerciseType)
            .setDataTypes(setOf(DataType.HEART_RATE_BPM))
            .setIsAutoPauseAndResumeEnabled(false)
            .setIsGpsEnabled(false)
            .build()
        withContext(Dispatchers.IO) { exerciseClient.startExerciseAsync(config).get() }
        trackedSessionId = sessionId
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(TRACKED_SESSION_ID, sessionId).commit()
        acquireWakeLock()
        return true
    }

    private suspend fun stopExercise(): Boolean {
        return try {
            val info = withContext(Dispatchers.IO) { exerciseClient.getCurrentExerciseInfoAsync().get() }
            if (info.exerciseTrackedStatus == ExerciseTrackedStatus.OWNED_EXERCISE_IN_PROGRESS) {
                withContext(Dispatchers.IO) { exerciseClient.endExerciseAsync().get() }
            }
            clearTrackedSession()
            releaseWakeLock()
            WatchStateStore.updateHeartRate(availability = "inactive", clearBpm = true)
            true
        } catch (error: Exception) {
            reportUnavailable("Unable to stop heart-rate monitoring: ${error.cause?.message ?: error.message.orEmpty()}")
            scheduleRetry()
            false
        }
    }

    private fun scheduleRetry() {
        if (retryJob?.isActive == true) return
        retryJob = scope.launch {
            delay(RETRY_DELAY_MS)
            scheduleReconcile()
        }
    }

    private fun clearTrackedSession() {
        trackedSessionId = null
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove(TRACKED_SESSION_ID).apply()
    }

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        wakeLock = getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:heart-rate")
            .apply {
                setReferenceCounted(false)
                acquire()
            }
    }

    private fun releaseWakeLock() {
        wakeLock?.takeIf { it.isHeld }?.release()
        wakeLock = null
    }

    private fun reportUnavailable(message: String) {
        WatchStateStore.updateHeartRate(availability = "unavailable", sensorSupported = true, clearBpm = true)
        sendAvailability("unavailable")
        PulseLog.boundary("watch", "health_services", JSONObject().put("message", message), message)
    }

    private fun sendReading(bpm: Double) {
        val bridge = WatchStateStore.state.value
        val sessionId = bridge.sessionId ?: return
        if (!bridge.sessionClockSynchronized || !isTrackingCurrentSession()) return
        val eventId = UUID.randomUUID().toString()
        val event = PulseContract.envelope(
            type = "heart_rate_sample",
            sessionId = sessionId,
            eventId = eventId,
            payload = JSONObject()
                .put("sessionId", sessionId)
                .put("bpm", bpm)
                .put("availability", "available")
                .put("sessionElapsedMs", sessionElapsedMs(bridge))
                .put("deviceTimestamp", Instant.now().toString())
                .put("source", "watch")
        )
        putVitalEvent(eventId, event)
    }

    private fun sendAvailability(availability: String) {
        val bridge = WatchStateStore.state.value
        val sessionId = bridge.sessionId ?: return
        if (!bridge.sessionClockSynchronized || !isSessionActive()) return
        val eventId = UUID.randomUUID().toString()
        val event = PulseContract.envelope(
            type = "heart_rate_availability",
            sessionId = sessionId,
            eventId = eventId,
            payload = JSONObject()
                .put("availability", availability)
                .put("sessionElapsedMs", sessionElapsedMs(bridge))
        )
        putVitalEvent(eventId, event)
    }

    private fun putVitalEvent(eventId: String, event: JSONObject) {
        val request = PutDataMapRequest.create(PulseDataLayer.vitalEventPath(eventId)).apply {
            dataMap.putString(PulseDataLayer.EVENT_JSON, event.toString())
        }.asPutDataRequest().setUrgent()
        Wearable.getDataClient(this).putDataItem(request).addOnSuccessListener {
            WatchStateStore.addPending(this, eventId)
            PulseLog.boundary("watch", "watch_to_phone", event, "Queued vital event")
        }
    }

    private fun isSessionActive() = WatchStateStore.state.value.sessionStatus in ACTIVE_SESSION_STATUSES

    private fun activeSessionId(): String? {
        val state = WatchStateStore.state.value
        return state.sessionId?.takeIf { state.sessionStatus in ACTIVE_SESSION_STATUSES }
    }

    private fun isTrackingCurrentSession(): Boolean {
        val state = WatchStateStore.state.value
        return state.sessionStatus in ACTIVE_SESSION_STATUSES && state.sessionId == trackedSessionId
    }

    private fun sessionElapsedMs(state: WatchState) =
        (SystemClock.elapsedRealtime() - state.sessionStartElapsedRealtimeMs).coerceAtLeast(0)

    private fun createNotificationChannel() {
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Pulse heart rate", NotificationManager.IMPORTANCE_LOW)
        )
    }

    private fun normalizeAvailability(value: Availability): String {
        val text = value.toString().lowercase()
        return when {
            "acquir" in text -> "acquiring"
            "unavailable" in text -> "unavailable"
            "available" in text -> "available"
            else -> "unknown"
        }
    }

    companion object {
        private const val CHANNEL_ID = "pulse-heart-rate"
        private const val NOTIFICATION_ID = 2001
        private const val ACTION_STOP = "dev.nitrostack.coach.watch.STOP_HEART_RATE"
        private const val PREFS = "pulse_heart_rate_service"
        private const val TRACKED_SESSION_ID = "tracked_session_id"
        private const val RETRY_DELAY_MS = 10_000L
        private val ACTIVE_SESSION_STATUSES = setOf("calibrating", "active")

        fun reconcile(context: Context, sessionStatus: String) {
            val intent = Intent(context, HeartRateService::class.java)
            if (sessionStatus in ACTIVE_SESSION_STATUSES) {
                if (ContextCompat.checkSelfPermission(context, Manifest.permission.BODY_SENSORS) == PackageManager.PERMISSION_GRANTED) {
                    runCatching { ContextCompat.startForegroundService(context, intent) }
                        .onFailure {
                            WatchStateStore.updateHeartRate(
                                availability = "unavailable",
                                sensorSupported = true,
                                clearBpm = true
                            )
                        }
                }
            } else {
                intent.action = ACTION_STOP
                runCatching { ContextCompat.startForegroundService(context, intent) }
                    .onFailure {
                        WatchStateStore.updateHeartRate(availability = "unavailable", clearBpm = true)
                    }
            }
        }
    }
}
