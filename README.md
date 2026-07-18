# Pulse

Pulse is a NitroStack MCP server plus watch, phone, and backend foundations for exposing consent-scoped physiological and conversational state to agents. Conversation Copilot adds optional, watch-requested advice through the existing consent-gated audio path. The Phase 0 audio and haptic probes remain available for device validation.

## Components

- `src/contracts`: canonical Zod domain records, versioned event envelopes, lifecycle rules, and deterministic fixtures.
- `src/backend`: HTTP/WebSocket event ingress with transactional SQLite storage, duplicate suppression, FTS5 transcript search, and deterministic stress-signal derivation.
- `src`: NitroStack MCP server exposing current-session transcript/vitals/stress resources, session search tools, and the retained `phase_zero_probe` tool.
- `android/contracts`: shared Kotlin envelope validation and structured boundary logging.
- `android/watch`: foreground `MeasureClient` capture, capability/permission checks, visible connection state, and acknowledged urgent DataItems.
- `android/phone`: durable event replay queue, persistent backend stream, scripted simulator, and live transcription.

The phone and watch modules intentionally share `applicationId` `dev.nitrostack.coach`, which lets Android associate them as one wearable application.

## Prerequisites

- Android Studio with Android SDK 35 and JDK 17
- A paired Pixel Watch running Wear OS 3 or newer
- Earbuds paired with the phone
- Node.js 18 or newer and npm 9 or newer
- `DEEPGRAM_API_KEY` only when `TRANSCRIPTION_MODE=cloud`

Never put the Deepgram key in source control. Copy the safe settings from `.env.example` into your process environment. For Android Studio builds, add local settings to the ignored `android/local.properties`; shell builds may use environment variables. The Phase 0 probe embeds a Deepgram value in a local debug APK only, so never use a production credential there.

## Run Phase 5

Install and verify the TypeScript components:

```text
npm install
npm run typecheck
npm test
```

Start the backend and MCP server in separate terminals. Neither requires the other to start:

```text
npm run dev:backend
npm run dev
```

The backend binds to `0.0.0.0:8787` by default. Check `http://127.0.0.1:8787/health` locally. The phone connects to `WS /v1/session-stream`; the existing fixture path remains available through:

Copy `.env.example` to `.env` and set `BACKEND_PORT` and `BACKEND_URL` there. The backend startup scripts load `.env` automatically.

```text
npm run mock:events
```

Sessions persist at `DATABASE_PATH=data/pulse.sqlite` by default. MCP agents can read `session://current/transcript`, `session://latest/transcript`, `session://current/speech-metrics`, `session://current/vitals`, and `session://current/stress`. They can call `search_sessions`, read `session://{sessionId}/report`, or call `generate_session_report` to render the synchronized report widget in a supporting MCP client.

Conversation Copilot is enabled by default. Set `COPILOT_MODE=automatic`, `DEVICE_ACTIONS=real`, and `OPENAI_API_KEY` on the backend to generate conversation advice directly with OpenAI and play it on the phone without MCP. Keep the API key on the backend; never add it to the Android build. `OPENAI_MODEL` defaults to `gpt-4.1-mini`. Starting a phone session automatically grants session-scoped `read:transcript` and `act:audio` consent, and ending it revokes both. A watch `Ask copilot` tap sends the latest 20 transcript segments, speech metrics, and consented stress/vital summaries to OpenAI with response storage disabled, then queues its concise advice through the existing audio path. If OpenAI is unavailable, the backend falls back to metric-based advice. Set `COPILOT_ENABLED=false` to disable the feature or `COPILOT_MODE=mcp` to use an MCP host instead.

`session://current/vitals` returns the latest BPM, availability, source, freshness, and a rolling window capped at 30 samples. `session://current/stress` returns the backend-derived stress state, baseline, delta, elevation duration, and cooldown. Both resources require a current calibrating or active session and an active `read:vitals` consent grant; authenticated callers must also carry `read:vitals`, and session-bound callers must match the current session.

Open NitroStudio and connect to the MCP process. The backend remains independently checkable through `GET /health`.

## Android

Open `android` in Android Studio, select its bundled JDK 17, sync Gradle, then build and install both modules:

```text
:phone:installDebug
:watch:installDebug
```

Build and validate the shared fixtures from a shell:

```text
android\gradlew.bat :contracts:testDebugUnitTest :phone:assembleDebug :watch:assembleDebug
```

The emulator reaches the local backend through the default `BACKEND_URL=http://10.0.2.2:8787`. Debug builds allow the resulting local `ws://` connection. A physical phone must set `BACKEND_URL` in `android/local.properties` to a host address it can reach; production builds must use HTTPS/WSS. The phone screen displays source, latest BPM, freshness, watch/backend connectivity, and upload queue depth.

For real capture set `VITALS_SOURCE=watch`, grant microphone permission in the phone app once, then tap `Start session` on the watch or phone. Keep the watch app visible because `MeasureClient` is deliberately foreground-only. Starting a session grants `read:vitals` for that session; ending it revokes the grant before the session closes. The phone streams final transcript segments and vital samples through the durable backend queue, and MCP exposes transcript, vitals, and stress resources for the current session. For hardware-free validation set `VITALS_SOURCE=simulated`, start a session, and tap `Run simulated sequence`. Simulated sessions do not start watch measurement, every stored sample has `source=simulator`, and both the UI and session record identify the simulation.

Supported settings are:

```text
VITALS_SOURCE=watch|simulated
AUDIO_INPUT=earbuds|phone
TRANSCRIPTION_MODE=cloud|on_device|fixture
DEVICE_ACTIONS=real|simulated
COPILOT_ENABLED=false
STORE_RAW_AUDIO=false
```

`TRANSCRIPTION_MODE=cloud` without `DEEPGRAM_API_KEY` starts the backend but returns an explicit unavailable health state. `STORE_RAW_AUDIO=true` is rejected. See `docs/contracts-v1.md` for event boundaries and delivery rules, and `docs/phase-three-validation.md` for the current acceptance checks.

## Phase 0 Hardware Validation

Perform this on the actual demo devices and record the results in `docs/phase-zero-results.md`.

1. Set `VITALS_SOURCE=watch`, launch both apps, and start a session on the phone.
2. Grant sensor permission, wear the watch snugly, and verify that an automatic live BPM appears on the phone.
3. Tap `Vibrate watch`; verify the two-pulse pattern once.
4. Connect the earbuds, tap `Select earbuds`, and confirm their product name appears. `Phone-mic fallback active` means Android did not expose them as a communication input.
5. Start a session from the watch, speak for five seconds, and confirm an intelligible final transcript appears on the phone and in `session://current/transcript`.
6. Start capture, tap `Play TTS`, and confirm TTS is private to the earbuds and status returns to `TTS complete; capture resumed`.
7. Speak again and confirm another final transcript arrives after TTS.
8. Run and inspect `phase_zero_probe` in NitroStudio.

Raw audio is streamed to Deepgram and is not written to app storage or exposed through MCP.

## Acceptance Boundary

Code/build validation cannot prove physical routing, sensor contact, intelligibility, vibration, account deployment access, or Studio connectivity. Phase 0 is accepted only after every row in `docs/phase-zero-results.md` has a dated result and the selected fallbacks are marked.
