import { loadRuntimeConfig } from '../config.js';
import { mockEventSequence } from '../contracts/fixtures.js';
import { eventAcknowledgementSchema } from '../contracts/events.js';

const config = loadRuntimeConfig();

for (const event of mockEventSequence) {
  const response = await fetch(`${config.BACKEND_URL}/v1/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event)
  }).catch((error: unknown) => {
    throw new Error(`Backend unavailable at ${config.BACKEND_URL}: ${String(error)}`);
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Mock event ${event.eventId} failed: ${JSON.stringify(body)}`);
  const acknowledgement = eventAcknowledgementSchema.parse(body);
  console.log(JSON.stringify({ type: event.type, ...acknowledgement }));
}
