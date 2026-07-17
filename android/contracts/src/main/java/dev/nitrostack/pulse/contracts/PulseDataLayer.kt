package dev.nitrostack.pulse.contracts

object PulseDataLayer {
    const val VITAL_EVENT_PREFIX = "/pulse/vitals/"
    const val VITAL_ACK_PREFIX = "/pulse/vital-acks/"
    const val SESSION_ACTION_PREFIX = "/pulse/session-actions/"
    const val SESSION_ACTION_ACK_PREFIX = "/pulse/session-action-acks/"
    const val SESSION_STATE_PATH = "/pulse/session-state"
    const val CONNECTION_STATE_PATH = "/pulse/connection-state"
    const val ADVICE_REQUEST_PREFIX = "/pulse/advice-requests/"
    const val ADVICE_REQUEST_ACK_PREFIX = "/pulse/advice-request-acks/"
    const val COPILOT_STATE_PATH = "/pulse/copilot-state"
    const val EVENT_JSON = "eventJson"
    const val ACK_EVENT_ID = "eventId"

    fun vitalEventPath(eventId: String) = "$VITAL_EVENT_PREFIX$eventId"
    fun vitalAckPath(eventId: String) = "$VITAL_ACK_PREFIX$eventId"
    fun sessionActionPath(eventId: String) = "$SESSION_ACTION_PREFIX$eventId"
    fun sessionActionAckPath(eventId: String) = "$SESSION_ACTION_ACK_PREFIX$eventId"
    fun adviceRequestPath(eventId: String) = "$ADVICE_REQUEST_PREFIX$eventId"
    fun adviceRequestAckPath(eventId: String) = "$ADVICE_REQUEST_ACK_PREFIX$eventId"
}
