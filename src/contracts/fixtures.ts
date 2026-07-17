import type { PulseEvent } from './events.js';

export const FIXTURE_SESSION_ID = 'session-fixture-001';
export const FIXTURE_CORRELATION_ID = 'correlation-fixture-001';

export const mockSessionStarted: PulseEvent = {
  version: '1.0',
  type: 'session_started',
  sessionId: FIXTURE_SESSION_ID,
  eventId: 'event-session-started-001',
  timestamp: '2026-07-17T10:00:00.000Z',
  correlationId: FIXTURE_CORRELATION_ID,
  payload: {
    session: {
      sessionId: FIXTURE_SESSION_ID,
      status: 'calibrating',
      startedAt: '2026-07-17T10:00:00.000Z',
      endedAt: null,
      simulatedVitals: true,
      audioInputRoute: 'phone'
    }
  }
};

export const mockVitalSample: PulseEvent = {
  version: '1.0',
  type: 'vital_sample_received',
  sessionId: FIXTURE_SESSION_ID,
  eventId: 'event-vital-001',
  timestamp: '2026-07-17T10:00:02.000Z',
  correlationId: FIXTURE_CORRELATION_ID,
  payload: {
    sessionId: FIXTURE_SESSION_ID,
    bpm: 82,
    availability: 'available',
    sessionElapsedMs: 2_000,
    deviceTimestamp: '2026-07-17T10:00:02.000Z',
    source: 'simulator'
  }
};

export const mockTranscriptSegment: PulseEvent = {
  version: '1.0',
  type: 'transcript_segment_received',
  sessionId: FIXTURE_SESSION_ID,
  eventId: 'event-transcript-001',
  timestamp: '2026-07-17T10:00:03.000Z',
  correlationId: FIXTURE_CORRELATION_ID,
  payload: {
    sessionId: FIXTURE_SESSION_ID,
    segmentId: 'segment-fixture-001',
    speaker: 'wearer',
    text: 'This is a contract fixture.',
    startMs: 2_100,
    endMs: 2_900,
    providerTimestamp: '2026-07-17T10:00:03.000Z',
    confidence: 0.98,
    isFinal: true
  }
};

export const mockEventSequence = [mockSessionStarted, mockVitalSample, mockTranscriptSegment] as const;
