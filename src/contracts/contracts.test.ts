import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mockEventSequence } from './fixtures.js';
import { pulseEventSchema } from './events.js';
import { whisperCoachInputSchema } from './interventions.js';
import { copilotAdviceInputSchema } from './copilot.js';
import { SESSION_TRANSITIONS, assertSessionTransition, canTransitionSession } from './lifecycle.js';

describe('Pulse v1 contracts', () => {
  it('validates every shared mock fixture', () => {
    for (const fixture of mockEventSequence) {
      assert.deepEqual(pulseEventSchema.parse(fixture), fixture);
    }
  });

  it('rejects unknown fields at event boundaries', () => {
    assert.throws(() => pulseEventSchema.parse({ ...mockEventSequence[0], unexpected: true }));
  });

  it('accepts whisper coaching text without a word limit', () => {
    const text = Array.from({ length: 600 }, (_, index) => `word${index}`).join(' ');
    assert.equal(whisperCoachInputSchema.parse({ idempotencyKey: 'long-whisper', text }).text, text);
  });

  it('enforces grounded, short copilot advice', () => {
    const valid = { requestId: 'request-1', text: 'Mention the implementation timeline next.', triggerEvidenceIds: ['goal-1'] };
    assert.equal(copilotAdviceInputSchema.parse(valid).text, valid.text);
    assert.throws(() => copilotAdviceInputSchema.parse({ ...valid, triggerEvidenceIds: [] }));
    assert.throws(() => copilotAdviceInputSchema.parse({
      ...valid,
      text: Array.from({ length: 21 }, (_, index) => `word${index}`).join(' ')
    }), /at most 20 words/);
  });
});

describe('session lifecycle', () => {
  it('defines all valid transitions', () => {
    assert.deepEqual(SESSION_TRANSITIONS.created, ['calibrating', 'failed']);
    assert.equal(canTransitionSession('calibrating', 'active'), true);
    assert.equal(canTransitionSession('active', 'completed'), false);
  });

  it('throws an explicit error for invalid transitions', () => {
    assert.throws(
      () => assertSessionTransition('completed', 'active'),
      /Invalid session transition: completed -> active/
    );
  });
});
