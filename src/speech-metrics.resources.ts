import { ExecutionContext, ResourceDecorator as Resource } from '@nitrostack/core';
import { loadRuntimeConfig } from './config.js';
import { currentSpeechMetricsResponseSchema } from './contracts/current-session.js';

export class SpeechMetricsResources {
  @Resource({
    uri: 'session://current/speech-metrics',
    name: 'Current session speech metrics',
    description: 'Deterministic pace, turn length, and silence metrics from final wearer or unknown-speaker segments.',
    mimeType: 'application/json',
    annotations: { audience: ['assistant'], priority: 0.9 }
  })
  async currentSpeechMetrics(uri: string, context: ExecutionContext) {
    context.logger.info('Speech metrics resource read', {
      boundary: 'mcp_resource_read',
      correlationId: crypto.randomUUID(),
      resourceUri: uri
    });
    const response = await fetch(`${loadRuntimeConfig().BACKEND_URL}/v1/sessions/current/speech-metrics`, {
      signal: AbortSignal.timeout(2_000)
    });
    if (!response.ok) throw new Error(`Backend speech metrics request failed (${response.status})`);
    return currentSpeechMetricsResponseSchema.parse(await response.json());
  }
}
