package dev.nitrostack.coach.watch

import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.Node
import com.google.android.gms.wearable.Wearable
import com.google.android.gms.wearable.WearableListenerService
import dev.nitrostack.pulse.contracts.PulseContract
import dev.nitrostack.pulse.contracts.PulseDataLayer
import org.json.JSONObject

class WatchDataService : WearableListenerService() {
    override fun onCreate() {
        super.onCreate()
        WatchStateStore.restore(this)
    }

    override fun onPeerConnected(peer: Node) {
        WatchStateStore.updateConnection(phoneConnected = true)
    }

    override fun onPeerDisconnected(peer: Node) {
        WatchStateStore.updateConnection(phoneConnected = false)
    }

    override fun onDataChanged(events: DataEventBuffer) {
        events.filter { it.type == DataEvent.TYPE_CHANGED }.forEach { event ->
            val path = event.dataItem.uri.path.orEmpty()
            val data = DataMapItem.fromDataItem(event.dataItem).dataMap
            when {
                path == PulseDataLayer.SESSION_STATE_PATH -> {
                    val eventJson = data.getString(PulseDataLayer.EVENT_JSON) ?: return@forEach
                    val envelope = PulseContract.validateEnvelope(eventJson)
                    val status = envelope.getJSONObject("payload").getString("status")
                    val sessionElapsedMs = data.getLong("sessionElapsedMs")
                    WatchStateStore.updateSession(this, envelope.getString("sessionId"), status, sessionElapsedMs)
                }
                path == PulseDataLayer.CONNECTION_STATE_PATH -> {
                    val eventJson = data.getString(PulseDataLayer.EVENT_JSON) ?: return@forEach
                    val envelope = PulseContract.validateEnvelope(eventJson)
                    val payload = envelope.getJSONObject("payload")
                    WatchStateStore.updateConnection(
                        phoneConnected = payload.getBoolean("phoneConnected"),
                        backendConnected = payload.getBoolean("backendConnected")
                    )
                }
                path == PulseDataLayer.COPILOT_STATE_PATH -> {
                    val eventJson = data.getString(PulseDataLayer.EVENT_JSON) ?: return@forEach
                    val envelope = PulseContract.validateEnvelope(eventJson)
                    WatchStateStore.updateCopilotState(this, envelope.getJSONObject("payload").getString("state"))
                }
                path.startsWith(PulseDataLayer.VITAL_ACK_PREFIX) -> {
                    val eventId = data.getString(PulseDataLayer.ACK_EVENT_ID) ?: return@forEach
                    WatchStateStore.acknowledge(this, eventId)
                    val dataClient = Wearable.getDataClient(this)
                    dataClient.getDataItems().addOnSuccessListener { items ->
                        items.filter { it.uri.path == PulseDataLayer.vitalEventPath(eventId) }
                            .forEach { dataClient.deleteDataItems(it.uri) }
                        items.release()
                    }
                    dataClient.deleteDataItems(event.dataItem.uri)
                }
                path.startsWith(PulseDataLayer.SESSION_ACTION_ACK_PREFIX) -> {
                    val eventId = data.getString(PulseDataLayer.ACK_EVENT_ID) ?: return@forEach
                    WatchStateStore.acknowledge(this, eventId)
                    val dataClient = Wearable.getDataClient(this)
                    dataClient.getDataItems().addOnSuccessListener { items ->
                        items.filter { it.uri.path == PulseDataLayer.sessionActionPath(eventId) }
                            .forEach { dataClient.deleteDataItems(it.uri) }
                        items.release()
                    }
                    dataClient.deleteDataItems(event.dataItem.uri)
                }
                path.startsWith(PulseDataLayer.ADVICE_REQUEST_ACK_PREFIX) -> {
                    val eventId = data.getString(PulseDataLayer.ACK_EVENT_ID) ?: return@forEach
                    WatchStateStore.acknowledge(this, eventId)
                    val dataClient = Wearable.getDataClient(this)
                    dataClient.getDataItems().addOnSuccessListener { items ->
                        items.filter { it.uri.path == PulseDataLayer.adviceRequestPath(eventId) }
                            .forEach { dataClient.deleteDataItems(it.uri) }
                        items.release()
                    }
                    dataClient.deleteDataItems(event.dataItem.uri)
                }
            }
        }
    }
}
