package dev.nitrostack.coach.phone

import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.Node
import com.google.android.gms.wearable.PutDataMapRequest
import com.google.android.gms.wearable.Wearable
import com.google.android.gms.wearable.WearableListenerService
import dev.nitrostack.pulse.contracts.PulseDataLayer

class PhoneDataService : WearableListenerService() {
    override fun onPeerConnected(peer: Node) {
        PulseApplication.pipeline(this).setWatchConnected(true)
    }

    override fun onPeerDisconnected(peer: Node) {
        PulseApplication.pipeline(this).setWatchConnected(false)
    }

    override fun onDataChanged(events: DataEventBuffer) {
        events.filter { it.type == DataEvent.TYPE_CHANGED }.forEach { event ->
            val path = event.dataItem.uri.path.orEmpty()
            val data = DataMapItem.fromDataItem(event.dataItem).dataMap
            val eventJson = data.getString(PulseDataLayer.EVENT_JSON) ?: return@forEach
            if (path.startsWith(PulseDataLayer.VITAL_EVENT_PREFIX) && PulseApplication.pipeline(this).acceptWatchEvent(eventJson)) {
                val eventId = event.dataItem.uri.lastPathSegment ?: return@forEach
                acknowledge(PulseDataLayer.vitalAckPath(eventId), eventId)
            } else if (path.startsWith(PulseDataLayer.SESSION_ACTION_PREFIX)) {
                val envelope = runCatching { dev.nitrostack.pulse.contracts.PulseContract.validateEnvelope(eventJson) }.getOrNull()
                    ?: return@forEach
                val eventId = envelope.getString("eventId")
                when (envelope.getJSONObject("payload").getString("action")) {
                    "start" -> PulseApplication.instance(this).startSession()
                    "end" -> PulseApplication.instance(this).endSession()
                    else -> return@forEach
                }
                acknowledge(PulseDataLayer.sessionActionAckPath(eventId), eventId)
            } else if (path.startsWith(PulseDataLayer.ADVICE_REQUEST_PREFIX)) {
                val envelope = runCatching { dev.nitrostack.pulse.contracts.PulseContract.validateEnvelope(eventJson) }.getOrNull()
                    ?: return@forEach
                val eventId = envelope.getString("eventId")
                if (PulseApplication.pipeline(this).acceptAdviceRequest(eventJson)) {
                    acknowledge(PulseDataLayer.adviceRequestAckPath(eventId), eventId)
                }
            }
        }
    }

    private fun acknowledge(path: String, eventId: String) {
        val acknowledgement = PutDataMapRequest.create(path).apply {
            dataMap.putString(PulseDataLayer.ACK_EVENT_ID, eventId)
            dataMap.putLong("acknowledgedAt", System.currentTimeMillis())
        }.asPutDataRequest().setUrgent()
        Wearable.getDataClient(this).putDataItem(acknowledgement)
    }
}
