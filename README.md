# Pulse

Pulse is a NitroStack MCP server plus watch, phone, and backend foundations for exposing consent-scoped physiological and conversational state to agents. Phase 1 establishes versioned contracts, health checks, fallback configuration, structured boundary logs, and a hardware-free mock event path. The Phase 0 hardware probes remain available while device choices are validated.

## Components

- `src/contracts`: canonical Zod domain records, versioned event envelopes, lifecycle rules, and deterministic fixtures.
- `src/backend`: dependency-independent HTTP health and event-ingestion shell with duplicate suppression.
- `src`: NitroStack MCP server exposing `pulse://health` and the retained `phase_zero_probe` tool.
- `android/contracts`: shared Kotlin envelope validation and structured boundary logging.
- `android/watch`: runnable Health Services and haptic probe with visible runtime mode.
- `android/phone`: runnable audio/device probe, backend health, visible fallback modes, and mock event dispatch.

The phone and watch modules intentionally share `applicationId` `dev.nitrostack.coach`, which lets Android associate them as one wearable application.

## Prerequisites

- Android Studio with Android SDK 35 and JDK 17
- A paired Pixel Watch running Wear OS 3 or newer
- Earbuds paired with the phone
- Node.js 18 or newer and npm 9 or newer
- `DEEPGRAM_API_KEY` only when `TRANSCRIPTION_MODE=cloud`

Never put the Deepgram key in source control. Copy the safe settings from `.env.example` into your process environment. For Android Studio builds, add local settings to the ignored `android/local.properties`; shell builds may use environment variables. The Phase 0 probe embeds a Deepgram value in a local debug APK only, so never use a production credential there.

## Run Phase 1

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

The backend binds to `0.0.0.0:8787` by default. Check `http://127.0.0.1:8787/health` locally, then exercise the hardware-free event path:

```text
npm run mock:events
```

Open NitroStudio, connect to the MCP process, and read `pulse://health`. If the backend is stopped, the resource remains readable and reports it as unavailable instead of failing silently.

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

The emulator reaches the local backend through the default `BACKEND_URL=http://10.0.2.2:8787`. A physical phone must set `BACKEND_URL` in `android/local.properties` to a host address it can reach. The phone screen always displays active modes and has a `Send mock events` action.

Supported settings are:

```text
VITALS_SOURCE=watch|simulated
AUDIO_INPUT=earbuds|phone
TRANSCRIPTION_MODE=cloud|on_device|fixture
DEVICE_ACTIONS=real|simulated
COPILOT_ENABLED=false
STORE_RAW_AUDIO=false
```

`TRANSCRIPTION_MODE=cloud` without `DEEPGRAM_API_KEY` starts the backend but returns an explicit unavailable health state. `STORE_RAW_AUDIO=true` is rejected in Phase 1. See `docs/contracts-v1.md` for event boundaries and lifecycle rules.

## Phase 0 Hardware Validation

Perform this on the actual demo devices and record the results in `docs/phase-zero-results.md`.

1. Launch the watch app, grant sensor permission, wear the watch snugly, and wait for a non-placeholder BPM.
2. Tap `Send to phone`; verify that the phone shows the BPM and a current wall-clock timestamp.
3. Tap `Vibrate watch`; verify the two-pulse pattern once.
4. Connect the earbuds, tap `Select earbuds`, and confirm their product name appears. `Phone-mic fallback active` means Android did not expose them as a communication input.
5. Tap `Record + transcribe`, speak for five seconds, then stop. Confirm an intelligible final transcript appears and a non-empty `phase-zero-*.pcm` file is created in app cache.
6. Start capture, tap `Play TTS`, and confirm TTS is private to the earbuds and status returns to `TTS complete; capture resumed`.
7. Speak again and confirm another final transcript arrives after TTS.
8. Run and inspect `phase_zero_probe` in NitroStudio.

Raw `.pcm` clips are temporary app-cache artifacts and are not uploaded anywhere except the live Deepgram stream. Clear app storage after testing.

## Acceptance Boundary

Code/build validation cannot prove physical routing, sensor contact, intelligibility, vibration, account deployment access, or Studio connectivity. Phase 0 is accepted only after every row in `docs/phase-zero-results.md` has a dated result and the selected fallbacks are marked.
