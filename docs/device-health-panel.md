# Device Health Panel

`get_device_status` is a read-only NitroStack tool with the `device-health-panel` widget. It displays watch, phone, earbuds, microphone, transcription provider, backend, and MCP access health.

The phone publishes `device_status_updated` at session, device, audio, transcription, and backend-connection transitions, plus every ten seconds during an active session. The backend persists the latest report and marks device reports offline after 15 seconds without a phone update.

The panel always identifies `simulatedVitals`, simulated device actions, and active phone-microphone or transcription fallbacks. It contains no raw audio, transcript text, or BPM.

## Test Resources

`src/widgets/widget-manifest.json` provides NitroStudio examples for:

- A fully live system
- Simulated vitals/actions with phone-microphone and fixture-transcription fallbacks
- Offline watch/phone and unavailable capture paths

`fixtures/events/device-status.json` is a valid ingress event shared with the Android contract test. The root widget-manifest test validates all examples against the MCP output schema.

## Validate

```text
npm run typecheck
npm run build
npm run widget -- run build
node --test dist/contracts/contracts.test.js dist/widgets-manifest.test.js
```

Start the backend and MCP server, then call `get_device_status` from NitroStudio. Start a simulated phone session to exercise the live event path without hardware. The widget renders after the tool call; it does not call the backend directly.
