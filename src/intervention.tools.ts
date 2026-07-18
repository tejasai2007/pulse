import { ExecutionContext, ToolDecorator as Tool } from '@nitrostack/core';
import { loadRuntimeConfig } from './config.js';
import {
  hapticNudgeInputSchema,
  interventionActionResponseSchema,
  whisperCoachInputSchema,
  type HapticNudgeInput,
  type InterventionActionResponse,
  type WhisperCoachInput
} from './contracts/interventions.js';

export class InterventionTools {
  @Tool({
    name: 'haptic_nudge',
    description: 'Deliver a predefined calming haptic pattern to the current wearer when act:haptic consent is active.',
    inputSchema: hapticNudgeInputSchema,
    outputSchema: interventionActionResponseSchema
  })
  async hapticNudge(input: HapticNudgeInput, context: ExecutionContext): Promise<InterventionActionResponse> {
    return this.invoke('haptic', 'act:haptic', input, context);
  }

  @Tool({
    name: 'whisper_coach',
    description: 'Speak non-empty coaching text through the current wearer\'s audio route when act:audio consent is active. Playback waits for conversational silence and may expire.',
    inputSchema: whisperCoachInputSchema,
    outputSchema: interventionActionResponseSchema
  })
  async whisperCoach(input: WhisperCoachInput, context: ExecutionContext): Promise<InterventionActionResponse> {
    return this.invoke('whisper', 'act:audio', input, context);
  }

  private async invoke(
    action: 'haptic' | 'whisper',
    scope: 'act:haptic' | 'act:audio',
    input: HapticNudgeInput | WhisperCoachInput,
    context: ExecutionContext
  ): Promise<InterventionActionResponse> {
    if (context.auth && context.auth.scopes?.includes(scope) !== true) {
      throw new Error(`Authenticated agent is missing scope ${scope}`);
    }
    const claims = context.auth?.claims;
    const requestingAgentId = typeof claims?.sub === 'string' && claims.sub.length > 0 ? claims.sub : 'mcp-agent';
    const expectedSessionId = typeof claims?.sessionId === 'string' ? claims.sessionId : undefined;
    const response = await fetch(
      `${loadRuntimeConfig().BACKEND_URL}/v1/sessions/current/interventions/${action}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...input, requestingAgentId, expectedSessionId }),
        signal: AbortSignal.timeout(5_000)
      }
    );
    const body = await response.json() as unknown;
    if (!response.ok) {
      const detail = typeof body === 'object' && body !== null && 'error' in body ? String(body.error) : `HTTP ${response.status}`;
      throw new Error(`Backend ${action} action failed: ${detail}`);
    }
    const result = interventionActionResponseSchema.parse(body);
    context.logger.info('Consent-gated intervention requested', {
      boundary: 'mcp_tool_call',
      correlationId: crypto.randomUUID(),
      sessionId: result.intervention.sessionId,
      interventionId: result.intervention.interventionId,
      tool: action === 'haptic' ? 'haptic_nudge' : 'whisper_coach',
      consentScope: scope,
      deliveryResult: result.intervention.deliveryResult,
      duplicate: result.duplicate
    });
    return result;
  }
}
