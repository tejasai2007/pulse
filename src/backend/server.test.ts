import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { RuntimeConfig } from '../config.js';
import { mockEventSequence } from '../contracts/fixtures.js';
import { createBackend } from './server.js';

const config: RuntimeConfig = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  BACKEND_HOST: '127.0.0.1',
  BACKEND_PORT: 0,
  BACKEND_URL: 'http://127.0.0.1:0',
  VITALS_SOURCE: 'simulated',
  AUDIO_INPUT: 'phone',
  TRANSCRIPTION_MODE: 'fixture',
  DEVICE_ACTIONS: 'simulated',
  COPILOT_ENABLED: false,
  STORE_RAW_AUDIO: false,
  DEEPGRAM_API_KEY: undefined
};

describe('Phase 1 backend', () => {
  const backend = createBackend(config);
  let baseUrl = '';

  before(async () => {
    await new Promise<void>((resolve) => backend.server.listen(0, '127.0.0.1', resolve));
    const address = backend.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
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
    assert.equal(body.events.length, 3);
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
});
