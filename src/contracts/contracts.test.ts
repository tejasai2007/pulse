import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mockEventSequence } from './fixtures.js';
import { pulseEventSchema } from './events.js';
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
