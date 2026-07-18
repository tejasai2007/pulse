# Phase 6 validation

Phase 6 adds the consent-gated `haptic_nudge` and `whisper_coach` MCP tools. It intentionally excludes the co-regulation loop and tool annotations.

## Behavior

- Both tools require an active session, the matching wearer consent scope, and any authenticated agent scope/session claim.
- Consent can only enter through the phone event boundary as `consent_updated`; MCP exposes no grant or revoke operation.
- Per-session idempotency keys prevent retries from creating or dispatching duplicate interventions.
- Haptic commands use the predefined `single`, `double`, and `breathing` patterns.
- Whisper text has no word or character limit in the tool/domain schemas. The HTTP boundary still has the general 1 MB request safety limit.
- Whisper playback waits for 1.5 seconds of wearer and participant silence, expires if no safe window occurs, and is cancelled immediately on consent revocation.
- `play_tts.capturePolicy` is `pause`, directing the phone to pause captured audio during playback. Successful playback is stored as transcript speaker `agent` only.
- `DEVICE_ACTIONS=simulated` completes actions through the same acknowledgement event path used by devices.

## Validation

Run:

```powershell
npm.cmd run typecheck
npm.cmd test
```

The automated suite covers consent denial, haptic retry deduplication, long whisper text, silence gating, agent transcript attribution, and queued-audio cancellation after revocation. Real watch and earbud delivery still requires the Android consumers to handle `send_watch_haptic`, `play_tts`, `cancel_tts`, `haptic_completed`, and `playback_completed` over `/v1/session-stream`.
