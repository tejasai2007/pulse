import { ExecutionContext, ToolDecorator as Tool, Widget } from '@nitrostack/core';
import { loadRuntimeConfig } from './config.js';
import { deviceStatusResponseSchema, type DeviceStatusResponse } from './contracts/device-status.js';

export class DeviceStatusTools {
  @Tool({
    name: 'get_device_status',
    description: 'Display the current watch, phone, audio, transcription, backend, and MCP access health with active simulation and fallback labels.',
    inputSchema: deviceStatusResponseSchema.pick({}).strict(),
    outputSchema: deviceStatusResponseSchema,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: false
    }
  })
  @Widget({ route: 'device-health-panel', prefersBorder: true })
  async getDeviceStatus(_input: Record<string, never>, context: ExecutionContext): Promise<DeviceStatusResponse> {
    const response = await fetch(`${loadRuntimeConfig().BACKEND_URL}/v1/sessions/current/device-status`, {
      signal: AbortSignal.timeout(2_000)
    });
    const body = await response.json() as unknown;
    if (!response.ok) {
      const detail = typeof body === 'object' && body !== null && 'error' in body ? String(body.error) : `HTTP ${response.status}`;
      throw new Error(`Backend device-status request failed: ${detail}`);
    }
    const status = deviceStatusResponseSchema.parse(body);
    const sessionId = status.session?.sessionId;
    const claimedSessionId = context.auth?.claims?.sessionId;
    if (claimedSessionId !== undefined && claimedSessionId !== sessionId) {
      throw new Error(`Authenticated session does not match current session ${sessionId ?? 'none'}`);
    }
    const checkedAt = new Date().toISOString();
    const result = deviceStatusResponseSchema.parse({
      ...status,
      agentAccess: {
        state: 'connected',
        mode: 'live',
        detail: 'MCP server successfully handled get_device_status',
        checkedAt
      }
    });
    context.logger.info('Device health status read', {
      boundary: 'mcp_tool_call',
      correlationId: crypto.randomUUID(),
      sessionId,
      tool: 'get_device_status'
    });
    return result;
  }
}
