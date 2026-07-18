import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import WebSocket from 'ws';
import type { RuntimeConfig } from '../config.js';
import { mockEventSequence } from '../contracts/fixtures.js';
import { StructuredLogger } from '../observability/logger.js';
import { EventStore } from './event-store.js';
import { createBackend } from './server.js';

const config: RuntimeConfig = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  BACKEND_HOST: '127.0.0.1',
  BACKEND_PORT: 0,
  BACKEND_URL: 'http://127.0.0.1:0',
  DATABASE_PATH: ':memory:',
  VITALS_SOURCE: 'simulated',
  AUDIO_INPUT: 'phone',
  TRANSCRIPTION_MODE: 'fixture',
  DEVICE_ACTIONS: 'simulated',
  COPILOT_ENABLED: false,
  COPILOT_MODE: 'automatic',
  STORE_RAW_AUDIO: false,
  DEEPGRAM_API_KEY: undefined
};

describe('Phase 2 backend', () => {
  const backend = createBackend(config);
  let baseUrl = '';

  before(async () => {
    await new Promise<void>((resolve) => backend.server.listen(0, '127.0.0.1', resolve));
    const address = backend.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    backend.websocketServer.close();
    await new Promise<void>((resolve, reject) => backend.server.close((error) => error ? reject(error) : resolve()));
  });

  it('reports dependency and fallback health explicitly', async () => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    const body = await response.json() as { status: string; contractVersion: string };
    assert.equal(body.status, 'ok');
    assert.equal(body.contractVersion, '1.0');
  });

  it('moves mock vital and transcript events through the same ingress', async () => {
    for (const event of mockEventSequence) {
      const response = await fetch(`${baseUrl}/v1/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event)
      });
      assert.equal(response.status, 202);
    }

    const response = await fetch(`${baseUrl}/v1/sessions/${mockEventSequence[0].sessionId}/events`);
    const body = await response.json() as { events: unknown[] };
    assert.equal(body.events.length, mockEventSequence.length);

    const reportResponse = await fetch(`${baseUrl}/v1/sessions/${mockEventSequence[0].sessionId}/report`);
    assert.equal(reportResponse.status, 200);
    const report = await reportResponse.json() as { session: { sessionId: string }; timeline: unknown[] };
    assert.equal(report.session.sessionId, mockEventSequence[0].sessionId);
    assert.equal(report.timeline.length, 3);
  });

  it('suppresses duplicate event IDs', async () => {
    const response = await fetch(`${baseUrl}/v1/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(mockEventSequence[2])
    });
    const body = await response.json() as { duplicate: boolean };
    assert.equal(body.duplicate, true);
  });

  it('does not persist copilot traffic when the feature is disabled', async () => {
    const event = {
      version: '1.0',
      type: 'advice_requested',
      sessionId: 'disabled-copilot-session',
      eventId: 'disabled-copilot-event',
      timestamp: new Date().toISOString(),
      correlationId: 'disabled-copilot-correlation',
      payload: { requestId: 'disabled-copilot-request' }
    };
    const response = await fetch(`${baseUrl}/v1/events`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event)
    });
    assert.equal(response.status, 202);
    assert.equal((await response.json() as { accepted: boolean }).accepted, true);
    assert.deepEqual(backend.store.getEvents(event.sessionId), []);
    assert.equal(backend.store.getRequestedCopilotRequest(), undefined);
  });

  it('exposes ordered final segments for the current session', async () => {
    const sessionId = 'session-transcript-001';
    const sessionEvent = {
      ...mockEventSequence[0],
      sessionId,
      eventId: 'event-transcript-session',
      payload: { session: { ...mockEventSequence[0].payload.session, sessionId } }
    };
    const segment = mockEventSequence[2];
    assert.equal(segment.type, 'transcript_segment_received');
    const laterSegment = {
      ...segment,
      sessionId,
      eventId: 'event-transcript-later',
      payload: { ...segment.payload, sessionId, segmentId: 'segment-later', startMs: 2_000, endMs: 2_500 }
    };
    const earlierSegment = {
      ...segment,
      sessionId,
      eventId: 'event-transcript-earlier',
      payload: { ...segment.payload, sessionId, segmentId: 'segment-earlier', startMs: 500, endMs: 1_000 }
    };
    const interimSegment = {
      ...segment,
      sessionId,
      eventId: 'event-transcript-interim',
      payload: { ...segment.payload, sessionId, segmentId: 'segment-interim', isFinal: false }
    };

    for (const event of [sessionEvent, laterSegment, interimSegment, earlierSegment]) {
      const response = await fetch(`${baseUrl}/v1/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event)
      });
      assert.equal(response.status, 202);
    }

    const response = await fetch(`${baseUrl}/v1/sessions/current/transcript`);
    assert.equal(response.status, 200);
    const body = await response.json() as {
      session: { sessionId: string };
      segments: Array<{ segmentId: string }>;
    };
    assert.equal(body.session.sessionId, sessionId);
    assert.deepEqual(body.segments.map(({ segmentId }) => segmentId), ['segment-earlier', 'segment-later']);

    const metricsResponse = await fetch(`${baseUrl}/v1/sessions/current/speech-metrics`);
    assert.equal(metricsResponse.status, 200);
    const metricsBody = await metricsResponse.json() as {
      session: { sessionId: string };
      metrics: { wordsPerMinute: number; longestTurnMs: number };
    };
    assert.equal(metricsBody.session.sessionId, sessionId);
    assert.equal(metricsBody.metrics.wordsPerMinute > 0, true);
    assert.equal(metricsBody.metrics.longestTurnMs, 2_000);
  });

  it('acknowledges streamed events and stores vitals in timeline order', async () => {
    const sessionId = 'session-stream-001';
    const sessionEvent = {
      ...mockEventSequence[0],
      sessionId,
      eventId: 'event-stream-session',
      payload: {
        session: {
          ...mockEventSequence[0].payload.session,
          sessionId
        }
      }
    };
    const laterVital = {
      ...mockEventSequence[1],
      sessionId,
      eventId: 'event-stream-vital-later',
      payload: {
        ...mockEventSequence[1].payload,
        sessionId,
        bpm: 91,
        sessionElapsedMs: 3_000
      }
    };
    const earlierVital = {
      ...mockEventSequence[1],
      sessionId,
      eventId: 'event-stream-vital-earlier',
      payload: {
        ...mockEventSequence[1].payload,
        sessionId,
        bpm: 80,
        sessionElapsedMs: 1_000
      }
    };
    const websocketUrl = baseUrl.replace('http://', 'ws://') + '/v1/session-stream';
    const socket = new WebSocket(websocketUrl);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });

    const send = (event: unknown) => new Promise<{ eventId: string; duplicate: boolean }>((resolve) => {
      socket.once('message', (data) => resolve(JSON.parse(data.toString())));
      socket.send(JSON.stringify(event));
    });
    assert.equal((await send(sessionEvent)).eventId, sessionEvent.eventId);
    assert.equal((await send(laterVital)).duplicate, false);
    assert.equal((await send(earlierVital)).duplicate, false);
    assert.equal((await send(earlierVital)).duplicate, true);
    socket.close();

    const response = await fetch(`${baseUrl}/v1/sessions/${sessionId}/vitals`);
    assert.equal(response.status, 200);
    const body = await response.json() as { samples: Array<{ bpm: number }>; latest: { bpm: number } };
    assert.deepEqual(body.samples.map((sample) => sample.bpm), [80, 91]);
    assert.equal(body.latest.bpm, 91);
  });

  it('exposes consent-scoped current vitals and deterministic stress transitions', async () => {
    const sessionId = 'session-phase-three-001';
    const startedAt = '2026-07-17T12:00:00.000Z';
    const start = {
      ...mockEventSequence[0],
      sessionId,
      eventId: 'event-phase-three-session',
      timestamp: startedAt,
      payload: { session: { ...mockEventSequence[0].payload.session, sessionId, status: 'active', startedAt } }
    };
    const makeVital = (at: number, bpm: number) => ({
      ...mockEventSequence[1],
      sessionId,
      eventId: `event-phase-three-vital-${at}`,
      timestamp: new Date(Date.parse(startedAt) + at).toISOString(),
      payload: {
        ...mockEventSequence[1].payload,
        sessionId,
        bpm,
        sessionElapsedMs: at,
        deviceTimestamp: new Date(Date.parse(startedAt) + at).toISOString()
      }
    });
    const baseline = [0, 1_000, 2_000, 3_000, 4_000, 5_000].map((at) => makeVital(at, 70));
    for (const event of [start, ...baseline]) {
      const response = await fetch(`${baseUrl}/v1/events`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event)
      });
      assert.equal(response.status, 202);
    }

    const denied = await fetch(`${baseUrl}/v1/sessions/current/vitals`);
    assert.equal((await denied.json() as { consentAllowed: boolean }).consentAllowed, false);

    const grant = {
      version: '1.0',
      type: 'consent_updated',
      sessionId,
      eventId: 'event-phase-three-consent',
      timestamp: startedAt,
      correlationId: 'correlation-phase-three',
      payload: {
        grantId: 'grant-phase-three-vitals', sessionId, scope: 'read:vitals', grantedAt: startedAt, revokedAt: null
      }
    };
    const elevated = [6_000, 7_000, 8_000, 9_000, 10_000, 11_000].map((at) => makeVital(at, 85));
    for (const event of [grant, ...elevated].reverse()) {
      const response = await fetch(`${baseUrl}/v1/events`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event)
      });
      assert.equal(response.status, 202);
    }

    const vitalsResponse = await fetch(`${baseUrl}/v1/sessions/current/vitals`);
    const vitals = await vitalsResponse.json() as { consentAllowed: boolean; latest: { bpm: number }; window: unknown[] };
    assert.equal(vitals.consentAllowed, true);
    assert.equal(vitals.latest.bpm, 85);
    assert.equal(vitals.window.length, 12);

    const stressResponse = await fetch(`${baseUrl}/v1/sessions/current/stress`);
    const stress = await stressResponse.json() as { signal: { state: string; baselineBpm: number } };
    assert.equal(stress.signal.state, 'sustained_elevation');
    assert.equal(stress.signal.baselineBpm, 70);

    const transitionsResponse = await fetch(`${baseUrl}/v1/sessions/${sessionId}/stress-events`);
    const transitions = await transitionsResponse.json() as { transitions: Array<{ state: string }> };
    assert.equal(transitions.transitions.filter(({ state }) => state === 'sustained_elevation').length, 1);
  });

  it('finds completed sessions by indexed transcript and exposes their history', async () => {
    const sessionId = 'session-transcript-search-001';
    const events = [
      {
        ...mockEventSequence[0],
        sessionId,
        eventId: 'event-context-session',
        payload: { session: { ...mockEventSequence[0].payload.session, sessionId } }
      },
      {
        ...mockEventSequence[2],
        sessionId,
        eventId: 'event-search-transcript',
        payload: {
          ...mockEventSequence[2].payload,
          sessionId,
          segmentId: 'segment-transcript-search',
          text: 'We discussed Acme annual pricing and contract terms.'
        }
      },
      {
        version: '1.0',
        type: 'session_ended',
        sessionId,
        eventId: 'event-search-ended',
        timestamp: '2026-07-17T10:10:00.000Z',
        correlationId: 'correlation-transcript-search',
        payload: { endedAt: '2026-07-17T10:10:00.000Z', reason: 'completed' }
      }
    ];
    for (const event of events) {
      const response = await fetch(`${baseUrl}/v1/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event)
      });
      assert.equal(response.status, 202);
    }

    const searchResponse = await fetch(`${baseUrl}/v1/sessions/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'Acme pricing', status: 'completed' })
    });
    assert.equal(searchResponse.status, 200);
    const search = await searchResponse.json() as { results: Array<{ session: { sessionId: string } }> };
    assert.deepEqual(search.results.map(({ session }) => session.sessionId), [sessionId]);

    const transcriptResponse = await fetch(`${baseUrl}/v1/sessions/${sessionId}/transcript`);
    const transcript = await transcriptResponse.json() as { segments: Array<{ segmentId: string }> };
    assert.deepEqual(transcript.segments.map(({ segmentId }) => segmentId), ['segment-transcript-search']);

    const latestResponse = await fetch(`${baseUrl}/v1/transcripts/latest`);
    const latest = await latestResponse.json() as {
      session: { sessionId: string };
      segment: { segmentId: string };
    };
    assert.equal(latest.session.sessionId, sessionId);
    assert.equal(latest.segment.segmentId, 'segment-transcript-search');
  });

  it('consent-gates and deduplicates simulated haptic interventions', async () => {
    const sessionId = 'session-phase-six-haptic';
    const startedAt = new Date().toISOString();
    const start = {
      ...mockEventSequence[0],
      sessionId,
      eventId: 'event-phase-six-haptic-session',
      timestamp: startedAt,
      payload: { session: { ...mockEventSequence[0].payload.session, sessionId, status: 'active', startedAt } }
    };
    assert.equal((await fetch(`${baseUrl}/v1/events`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(start)
    })).status, 202);

    const denied = await fetch(`${baseUrl}/v1/sessions/current/interventions/haptic`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        idempotencyKey: 'haptic-retry', pattern: 'breathing', triggerEvidenceIds: [], requestingAgentId: 'test-agent'
      })
    });
    assert.equal(denied.status, 409);
    assert.match((await denied.json() as { error: string }).error, /Consent scope act:haptic is not granted/);

    const grant = {
      version: '1.0', type: 'consent_updated', sessionId, eventId: 'event-phase-six-haptic-consent',
      timestamp: startedAt, correlationId: 'correlation-phase-six-haptic',
      payload: { grantId: 'grant-phase-six-haptic', sessionId, scope: 'act:haptic', grantedAt: startedAt, revokedAt: null }
    };
    assert.equal((await fetch(`${baseUrl}/v1/events`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(grant)
    })).status, 202);

    const call = () => fetch(`${baseUrl}/v1/sessions/current/interventions/haptic`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        idempotencyKey: 'haptic-retry', pattern: 'breathing', triggerEvidenceIds: ['stress-1'], requestingAgentId: 'test-agent'
      })
    });
    const first = await (await call()).json() as { intervention: { interventionId: string; deliveryResult: string }; duplicate: boolean };
    const retry = await (await call()).json() as { intervention: { interventionId: string }; duplicate: boolean };
    assert.equal(first.intervention.deliveryResult, 'delivered');
    assert.equal(first.duplicate, false);
    assert.equal(retry.duplicate, true);
    assert.equal(retry.intervention.interventionId, first.intervention.interventionId);

    const history = await (await fetch(`${baseUrl}/v1/sessions/${sessionId}/interventions`)).json() as { interventions: unknown[] };
    assert.equal(history.interventions.length, 1);
  });

  it('queues unlimited whisper text until silence and stores it only as agent speech', async () => {
    const sessionId = 'session-phase-six-whisper';
    const startedAt = new Date().toISOString();
    const text = Array.from({ length: 600 }, (_, index) => `coach${index}`).join(' ');
    const events = [
      {
        ...mockEventSequence[0], sessionId, eventId: 'event-phase-six-whisper-session', timestamp: startedAt,
        payload: { session: { ...mockEventSequence[0].payload.session, sessionId, status: 'active', startedAt } }
      },
      {
        version: '1.0', type: 'consent_updated', sessionId, eventId: 'event-phase-six-whisper-consent',
        timestamp: startedAt, correlationId: 'correlation-phase-six-whisper',
        payload: { grantId: 'grant-phase-six-whisper', sessionId, scope: 'act:audio', grantedAt: startedAt, revokedAt: null }
      },
      {
        ...mockEventSequence[2], sessionId, eventId: 'event-phase-six-recent-speech', timestamp: startedAt,
        payload: {
          ...mockEventSequence[2].payload, sessionId, segmentId: 'segment-phase-six-recent',
          speaker: 'participant', text: 'I am still talking.', startMs: 0, endMs: 100, providerTimestamp: startedAt
        }
      }
    ];
    for (const event of events) {
      assert.equal((await fetch(`${baseUrl}/v1/events`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event)
      })).status, 202);
    }

    const response = await fetch(`${baseUrl}/v1/sessions/current/interventions/whisper`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        idempotencyKey: 'long-whisper', text, triggerEvidenceIds: ['segment-phase-six-recent'],
        expiresInMs: 5_000, requestingAgentId: 'test-agent'
      })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { intervention: { deliveryResult: string } }).intervention.deliveryResult, 'pending');

    await new Promise((resolve) => setTimeout(resolve, 1_800));
    const history = await (await fetch(`${baseUrl}/v1/sessions/${sessionId}/interventions`)).json() as {
      interventions: Array<{ deliveryResult: string; generatedMessage: string }>;
    };
    assert.equal(history.interventions[0].deliveryResult, 'delivered');
    assert.equal(history.interventions[0].generatedMessage, text);

    const transcript = await (await fetch(`${baseUrl}/v1/sessions/${sessionId}/transcript`)).json() as {
      segments: Array<{ speaker: string; text: string }>;
    };
    assert.deepEqual(transcript.segments.map(({ speaker }) => speaker), ['participant', 'agent']);
    assert.equal(transcript.segments[1].text, text);

    const now = new Date().toISOString();
    const elapsedMs = Date.parse(now) - Date.parse(startedAt);
    const recentSpeech = {
      ...mockEventSequence[2], sessionId, eventId: 'event-phase-six-before-revocation', timestamp: now,
      payload: {
        ...mockEventSequence[2].payload, sessionId, segmentId: 'segment-phase-six-before-revocation',
        speaker: 'wearer', text: 'Do not play over this.', startMs: elapsedMs, endMs: elapsedMs, providerTimestamp: now
      }
    };
    await fetch(`${baseUrl}/v1/events`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(recentSpeech)
    });
    await fetch(`${baseUrl}/v1/sessions/current/interventions/whisper`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        idempotencyKey: 'expired-whisper', text: 'This becomes stale.', triggerEvidenceIds: [],
        expiresInMs: 1_000, requestingAgentId: 'test-agent'
      })
    });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await fetch(`${baseUrl}/v1/sessions/current/interventions/whisper`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        idempotencyKey: 'revoked-whisper', text: 'This must never play.', triggerEvidenceIds: [],
        expiresInMs: 5_000, requestingAgentId: 'test-agent'
      })
    });
    const revokedAt = new Date().toISOString();
    const revocation = {
      version: '1.0', type: 'consent_updated', sessionId, eventId: 'event-phase-six-whisper-revoked',
      timestamp: revokedAt, correlationId: 'correlation-phase-six-revoked',
      payload: { grantId: 'grant-phase-six-whisper', sessionId, scope: 'act:audio', grantedAt: startedAt, revokedAt }
    };
    await fetch(`${baseUrl}/v1/events`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(revocation)
    });
    const revokedHistory = await (await fetch(`${baseUrl}/v1/sessions/${sessionId}/interventions`)).json() as {
      interventions: Array<{ deliveryResult: string }>;
    };
    assert.deepEqual(
      revokedHistory.interventions.map(({ deliveryResult }) => deliveryResult),
      ['delivered', 'expired', 'cancelled']
    );
  });
});

describe('Phase 8 conversation copilot', () => {
  const copilotBackend = createBackend({ ...config, COPILOT_ENABLED: true, COPILOT_MODE: 'mcp' });
  let baseUrl = '';

  before(async () => {
    await new Promise<void>((resolve) => copilotBackend.server.listen(0, '127.0.0.1', resolve));
    const address = copilotBackend.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    copilotBackend.websocketServer.close();
    await new Promise<void>((resolve, reject) => copilotBackend.server.close((error) => error ? reject(error) : resolve()));
  });

  it('deduplicates taps, claims one request, and delivers one grounded suggestion', async () => {
    const sessionId = 'session-phase-eight';
    const startedAt = new Date(Date.now() - 5_000).toISOString();
    const start = {
      ...mockEventSequence[0],
      sessionId,
      eventId: 'phase-eight-session',
      timestamp: startedAt,
      payload: { session: { ...mockEventSequence[0].payload.session, sessionId, status: 'active', startedAt } }
    };
    const context = {
      version: '1.0', type: 'session_context_updated', sessionId, eventId: 'phase-eight-context',
      timestamp: startedAt, correlationId: 'phase-eight-context-correlation',
      payload: {
        sessionId,
        wearerSummary: 'Founder presenting a product plan.',
        situation: 'Investor pitch',
        participants: [{ name: 'Investor', role: 'decision maker' }],
        goals: ['Mention the implementation timeline'],
        topicsToAvoid: ['Unannounced customer names'],
        stressSensitivity: { baselineOffsetBpm: 12, elevationTriggerMs: 5_000, recoveryTriggerMs: 3_000, cooldownMs: 10_000 }
      }
    };
    const transcript = {
      ...mockEventSequence[2], sessionId, eventId: 'phase-eight-transcript', timestamp: startedAt,
      payload: {
        ...mockEventSequence[2].payload, sessionId, segmentId: 'phase-eight-segment',
        speaker: 'wearer', text: 'Our product reduces manual reporting.', startMs: 0, endMs: 500,
        providerTimestamp: startedAt
      }
    };
    const grants = ['read:context', 'read:transcript', 'act:audio'].map((scope) => ({
      version: '1.0', type: 'consent_updated', sessionId, eventId: `phase-eight-grant-${scope}`,
      timestamp: startedAt, correlationId: `phase-eight-grant-correlation-${scope}`,
      payload: { grantId: `phase-eight-grant-${scope}`, sessionId, scope, grantedAt: startedAt, revokedAt: null }
    }));
    for (const event of [start, context, transcript, ...grants]) {
      assert.equal((await fetch(`${baseUrl}/v1/events`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event)
      })).status, 202);
    }

    const tap = {
      version: '1.0', type: 'advice_requested', sessionId, eventId: 'phase-eight-tap',
      timestamp: new Date().toISOString(), correlationId: 'phase-eight-tap-correlation',
      payload: { requestId: 'phase-eight-request' }
    };
    const sendTap = (event: unknown) => fetch(`${baseUrl}/v1/events`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event)
    });
    assert.equal((await sendTap(tap)).status, 202);
    assert.equal((await (await sendTap(tap)).json() as { duplicate: boolean }).duplicate, true);
    assert.equal((await sendTap({
      ...tap, eventId: 'phase-eight-second-tap', payload: { requestId: 'phase-eight-second-request' }
    })).status, 202);
    assert.equal(copilotBackend.store.getActiveCopilotRequest(sessionId)?.requestId, 'phase-eight-request');

    const pending = await (await fetch(`${baseUrl}/v1/copilot/requests/pending`)).json() as {
      request: { requestId: string; state: string };
    };
    assert.equal(pending.request.requestId, 'phase-eight-request');
    assert.equal(pending.request.state, 'thinking');

    const adviceBody = {
      text: 'Mention the implementation timeline next.',
      triggerEvidenceIds: ['phase-eight-segment', 'context:goal:0'],
      confidentialContextDirectlyUseful: true,
      expiresInMs: 15_000,
      requestingAgentId: 'acceptance-agent'
    };
    const ungrounded = await fetch(`${baseUrl}/v1/copilot/requests/phase-eight-request/advice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...adviceBody, triggerEvidenceIds: ['invented-evidence'] })
    });
    assert.equal(ungrounded.status, 409);
    assert.match((await ungrounded.json() as { error: string }).error, /Unknown copilot evidence/);
    const deliver = () => fetch(`${baseUrl}/v1/copilot/requests/phase-eight-request/advice`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(adviceBody)
    });
    const deliveredResponse = await deliver();
    assert.equal(deliveredResponse.status, 200);
    const delivered = await deliveredResponse.json() as {
      request: { state: string };
      intervention: { interventionId: string; type: string; deliveryResult: string };
      duplicate: boolean;
    };
    assert.equal(delivered.request.state, 'completed');
    assert.equal(delivered.intervention.type, 'copilot_advice');
    assert.equal(delivered.intervention.deliveryResult, 'delivered');
    assert.equal(delivered.duplicate, false);

    const retry = await (await deliver()).json() as { intervention: { interventionId: string }; duplicate: boolean };
    assert.equal(retry.duplicate, true);
    assert.equal(retry.intervention.interventionId, delivered.intervention.interventionId);
    assert.equal(copilotBackend.store.getInterventions(sessionId).length, 1);
  });

  it('rejects ungrounded and over-limit advice', async () => {
    const invalid = await fetch(`${baseUrl}/v1/copilot/requests/phase-eight-request/advice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: Array.from({ length: 21 }, (_, index) => `word${index}`).join(' '),
        triggerEvidenceIds: [],
        requestingAgentId: 'acceptance-agent'
      })
    });
    assert.equal(invalid.status, 400);
  });

  it('expires a stale request before advice can be queued', async () => {
    const staleTap = {
      version: '1.0', type: 'advice_requested', sessionId: 'session-phase-eight',
      eventId: 'phase-eight-stale-tap', timestamp: new Date(Date.now() - 31_000).toISOString(),
      correlationId: 'phase-eight-stale-correlation', payload: { requestId: 'phase-eight-stale-request' }
    };
    assert.equal((await fetch(`${baseUrl}/v1/events`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(staleTap)
    })).status, 202);
    const pending = await (await fetch(`${baseUrl}/v1/copilot/requests/pending`)).json() as { request: unknown };
    assert.equal(pending.request, null);
    assert.equal(copilotBackend.store.getCopilotRequest('phase-eight-stale-request')?.state, 'expired');
    assert.equal(copilotBackend.store.getInterventions('session-phase-eight').length, 1);
  });
});

describe('Automatic conversation copilot', () => {
  const automaticBackend = createBackend({ ...config, COPILOT_ENABLED: true, COPILOT_MODE: 'automatic' });
  let baseUrl = '';

  before(async () => {
    await new Promise<void>((resolve) => automaticBackend.server.listen(0, '127.0.0.1', resolve));
    const address = automaticBackend.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    automaticBackend.websocketServer.close();
    await new Promise<void>((resolve, reject) => automaticBackend.server.close((error) => error ? reject(error) : resolve()));
  });

  it('turns a watch request into goal-based advice without an MCP claim', async () => {
    const sessionId = 'automatic-copilot-session';
    const startedAt = new Date(Date.now() - 5_000).toISOString();
    const events = [
      {
        ...mockEventSequence[0],
        sessionId,
        eventId: 'automatic-session',
        timestamp: startedAt,
        payload: { session: { ...mockEventSequence[0].payload.session, sessionId, status: 'active', startedAt } }
      },
      {
        version: '1.0', type: 'session_context_updated', sessionId, eventId: 'automatic-context',
        timestamp: startedAt, correlationId: 'automatic-context-correlation',
        payload: {
          sessionId,
          wearerSummary: '',
          situation: 'Project update',
          participants: [],
          goals: ['Explain the implementation timeline'],
          topicsToAvoid: [],
          stressSensitivity: { baselineOffsetBpm: 12, elevationTriggerMs: 5_000, recoveryTriggerMs: 3_000, cooldownMs: 10_000 }
        }
      },
      {
        version: '1.0', type: 'consent_updated', sessionId, eventId: 'automatic-audio-consent',
        timestamp: startedAt, correlationId: 'automatic-consent-correlation',
        payload: { grantId: 'automatic-audio-consent', sessionId, scope: 'act:audio', grantedAt: startedAt, revokedAt: null }
      },
      {
        version: '1.0', type: 'advice_requested', sessionId, eventId: 'automatic-request-event',
        timestamp: new Date().toISOString(), correlationId: 'automatic-request-correlation',
        payload: { requestId: 'automatic-request' }
      }
    ];

    for (const event of events) {
      const response = await fetch(`${baseUrl}/v1/events`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event)
      });
      assert.equal(response.status, 202);
    }

    const request = automaticBackend.store.getCopilotRequest('automatic-request');
    assert.equal(request?.state, 'completed');
    assert.equal(request?.advice, 'Next, mention Explain the implementation timeline');
    assert.equal(automaticBackend.store.getInterventions(sessionId).length, 1);
    const pending = await (await fetch(`${baseUrl}/v1/copilot/requests/pending`)).json() as { request: unknown };
    assert.equal(pending.request, null);
  });
});

describe('SQLite persistence', () => {
  it('retains sessions, transcripts, and duplicate IDs across restarts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pulse-store-'));
    const databasePath = join(directory, 'pulse.sqlite');
    const logger = new StructuredLogger('test', 'error');
    try {
      const firstStore = new EventStore(logger, databasePath);
      for (const event of mockEventSequence) firstStore.ingest(event);
      const firstReport = firstStore.getSessionReport(mockEventSequence[0].sessionId);
      firstStore.close();

      const reopenedStore = new EventStore(logger, databasePath);
      assert.equal(reopenedStore.getSession(mockEventSequence[0].sessionId)?.sessionId, mockEventSequence[0].sessionId);
      assert.deepEqual(
        reopenedStore.getTranscriptSegments(mockEventSequence[0].sessionId).map(({ segmentId }) => segmentId),
        ['segment-fixture-001']
      );
      assert.equal(reopenedStore.ingest(mockEventSequence[2]).duplicate, true);
      assert.deepEqual(reopenedStore.getSessionReport(mockEventSequence[0].sessionId), firstReport);
      assert.equal((reopenedStore.getPersistedSpeechMetrics(mockEventSequence[0].sessionId)?.wordsPerMinute ?? 0) > 0, true);
      reopenedStore.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
