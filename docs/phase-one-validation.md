# Phase 1 validation

Run date: 2026-07-17

| Gate | Command or check | Result |
| --- | --- | --- |
| TypeScript contracts and lifecycle | `npm test` | Passed: 7 tests |
| TypeScript static checks | `npm run typecheck` | Passed |
| MCP build | `npm run build` | Passed; built process remained running during startup check |
| Android fixture consumer | `android\gradlew.bat :contracts:testDebugUnitTest` | Passed |
| Phone and watch shells | `android\gradlew.bat :phone:assembleDebug :watch:assembleDebug` | Passed |
| Backend health | `GET http://127.0.0.1:8787/health` | Passed: `ok`, contract `1.0` |
| Mock vitals and transcript | `npm run mock:events` | Passed: all three events accepted |
| MCP health | Read `pulse://health` in NitroStudio | Not run |

Hardware paths and cloud-provider connectivity remain Phase 0/manual checks. Phase 1 defaults to clearly identified fixture, phone-microphone, and simulated-action modes.
