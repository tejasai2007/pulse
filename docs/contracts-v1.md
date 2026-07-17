# Pulse contract v1

The canonical TypeScript schemas are in `src/contracts`. Android consumes the matching envelope through `android/contracts`. Every boundary message contains:

- `version`: currently exactly `1.0`
- `type`: one frozen event or command name
- `sessionId`, `eventId`, and `correlationId`
- `timestamp`: ISO 8601 wall-clock time
- `payload`: a strict type-specific object

Timeline payloads additionally carry session-relative monotonic milliseconds. Consumers must acknowledge and ignore an already-seen `eventId`; they must never repeat a command because of a retry.

## Boundaries

| Boundary | Messages |
| --- | --- |
| Watch to phone | `heart_rate_sample`, `heart_rate_availability`, `watch_status`, `session_action` |
| Phone to watch | `session_state`, `haptic_command`, `connection_status` |
| Phone to backend | `session_started`, `session_ended`, `session_context_updated`, `vital_sample_received`, `transcript_segment_received`, `audio_route_changed`, `consent_updated`, `playback_completed` |
| Backend to phone | `play_tts`, `cancel_tts`, `send_watch_haptic`, `report_ready` |

Changing a field or event requires a contract version change and coordinated producer/consumer updates. Unknown keys are rejected by TypeScript ingress validation.

## Session Lifecycle

Valid transitions are:

```text
created -> calibrating | failed
calibrating -> active | ending | failed
active -> ending | failed
ending -> completed | failed
completed -> (terminal)
failed -> (terminal)
```

Invalid transitions produce `Invalid session transition: <from> -> <to>`. Events for unknown or terminal sessions are rejected explicitly.

## Fixture Validation

Canonical JSON fixtures live in `fixtures/events`. Validate TypeScript consumers with `npm test` and Android consumers with:

```text
android\gradlew.bat :contracts:testDebugUnitTest
```

## HTTP Foundation

- `GET /health`: backend, transcription-provider, command-channel, and runtime-mode health
- `POST /v1/events`: strict v1 event ingestion and duplicate acknowledgement
- `GET /v1/sessions/{sessionId}/events`: current in-memory mock timeline
- `PATCH /v1/sessions/{sessionId}/status`: lifecycle transition validation

Storage is intentionally in memory in Phase 1. Restarting the backend clears sessions and duplicate IDs.
