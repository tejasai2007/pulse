import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  currentTranscriptToolInputSchema,
  selectCurrentTranscriptSegments,
  type CurrentTranscriptResponse
} from './contracts/current-session.js';

const session = {
  sessionId: 'session-current-tools',
  status: 'active' as const,
  startedAt: '2026-07-17T10:00:00.000Z',
  endedAt: null,
  simulatedVitals: true,
  audioInputRoute: 'phone' as const
};

const transcript: CurrentTranscriptResponse = {
  session,
  segments: [0, 1, 2].map((index) => ({
    sessionId: session.sessionId,
    segmentId: `segment-${index}`,
    speaker: 'wearer' as const,
    text: `Segment ${index}`,
    startMs: index * 1_000,
    endMs: index * 1_000 + 500,
    providerTimestamp: new Date(Date.parse(session.startedAt) + index * 1_000 + 500).toISOString(),
    confidence: 0.9,
    isFinal: true
  }))
};

describe('current session tools', () => {
  it('defaults transcript reads to 50 segments', () => {
    assert.deepEqual(currentTranscriptToolInputSchema.parse({}), { limit: 50 });
  });

  it('returns the latest bounded transcript segments in chronological order', () => {
    const result = selectCurrentTranscriptSegments(transcript, { limit: 2 });
    assert.deepEqual(result.segments.map(({ segmentId }) => segmentId), ['segment-1', 'segment-2']);
    assert.equal(result.truncated, true);
  });

  it('filters transcript segments that end before sinceMs', () => {
    const result = selectCurrentTranscriptSegments(transcript, { sinceMs: 501, limit: 50 });
    assert.deepEqual(result.segments.map(({ segmentId }) => segmentId), ['segment-1', 'segment-2']);
    assert.equal(result.truncated, false);
  });
});
