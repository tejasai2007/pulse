import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { deviceStatusResponseSchema } from './contracts/device-status.js';

describe('Device Health Panel widget fixtures', () => {
  it('provides valid connected, fallback, and offline examples to NitroStudio', () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'src/widgets/widget-manifest.json'), 'utf8')) as {
      widgets: Array<{ uri: string; examples: Array<{ name: string; data: unknown }> }>;
    };
    const widget = manifest.widgets.find(({ uri }) => uri === '/device-health-panel');
    assert.ok(widget);
    assert.deepEqual(widget.examples.map(({ name }) => name), ['Live system', 'Demo fallbacks', 'Offline devices']);
    for (const example of widget.examples) deviceStatusResponseSchema.parse(example.data);
  });
});
