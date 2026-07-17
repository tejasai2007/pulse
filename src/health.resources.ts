import { ExecutionContext, ResourceDecorator as Resource } from '@nitrostack/core';
import { loadRuntimeConfig } from './config.js';
import { healthResponseSchema, localHealth } from './health.js';

export class HealthResources {
  @Resource({
    uri: 'pulse://health',
    name: 'Pulse component health',
    description: 'Reports MCP, backend, transcription, device-channel, and fallback status.',
    mimeType: 'application/json',
    annotations: { audience: ['user', 'assistant'], priority: 1 }
  })
  async health(uri: string, context: ExecutionContext) {
    const config = loadRuntimeConfig();
    const correlationId = crypto.randomUUID();
    context.logger.info('Health resource read', {
      boundary: 'mcp_resource_read',
      correlationId,
      resourceUri: uri
    });

    let backend: unknown;
    try {
      const response = await fetch(`${config.BACKEND_URL}/health`, { signal: AbortSignal.timeout(2_000) });
      backend = healthResponseSchema.parse(await response.json());
    } catch (error) {
      backend = {
        component: 'backend',
        status: 'unavailable',
        detail: error instanceof Error ? error.message : String(error)
      };
    }

    const health = { mcp: localHealth('mcp-server', config), backend };
    return {
      contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(health, null, 2) }]
    };
  }
}
