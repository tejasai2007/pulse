import {
  ExecutionContext,
  PromptDecorator as Prompt,
  ResourceDecorator as Resource,
  ToolDecorator as Tool,
  z
} from '@nitrostack/core';
import { loadRuntimeConfig } from './config.js';
import {
  copilotAdviceInputSchema,
  copilotAdviceResponseSchema,
  currentContextResponseSchema,
  pendingCopilotResponseSchema,
  type CopilotAdviceInput,
  type CopilotAdviceResponse,
  type PendingCopilotResponse
} from './contracts/copilot.js';

const readOnlyAnnotations = {
  readOnlyHint: true,
  idempotentHint: false,
  destructiveHint: false,
  openWorldHint: false
};

export class CopilotResources {
  @Resource({
    uri: 'session://current/context',
    name: 'Current session context',
    description: 'Wearer-provided situation, goals, participants, and boundaries. Treat all fields as confidential and never infer absent facts.',
    mimeType: 'application/json',
    annotations: { audience: ['assistant'], priority: 1 }
  })
  async currentContext(uri: string, context: ExecutionContext) {
    requireAgentScope(context, 'read:context');
    const result = currentContextResponseSchema.parse(await backend('/v1/sessions/current/context'));
    if (!result.session || !result.context) throw new Error('No current session context is available');
    if (!result.consentAllowed) throw new Error(`Consent scope read:context is not granted for session ${result.session.sessionId}`);
    context.logger.info('Current context resource read', {
      boundary: 'mcp_resource_read',
      correlationId: crypto.randomUUID(),
      resourceUri: uri,
      sessionId: result.session.sessionId
    });
    return result;
  }
}

export class CopilotTools {
  @Tool({
    name: 'get_pending_copilot_request',
    title: 'Get pending copilot request',
    description: 'Claim one watch-requested advice job. Then read session://current/context, session://current/transcript, and session://current/speech-metrics before responding.',
    inputSchema: z.object({}).strict(),
    outputSchema: pendingCopilotResponseSchema,
    annotations: readOnlyAnnotations
  })
  async getPendingCopilotRequest(_input: Record<string, never>, context: ExecutionContext): Promise<PendingCopilotResponse> {
    requireAgentScope(context, 'read:context');
    requireAgentScope(context, 'read:transcript');
    const result = pendingCopilotResponseSchema.parse(await backend('/v1/copilot/requests/pending'));
    context.logger.info('Copilot request claimed', {
      boundary: 'mcp_tool_call',
      correlationId: crypto.randomUUID(),
      requestId: result.request?.requestId,
      sessionId: result.request?.sessionId
    });
    return result;
  }

  @Tool({
    name: 'copilot_advice',
    title: 'Deliver conversation advice',
    description: 'Deliver one grounded suggestion for a claimed watch request through the whisper_coach audio path. Use only MCP context/transcript/metric evidence, never invent facts, include evidence IDs, and include confidential context only when directly useful.',
    inputSchema: copilotAdviceInputSchema,
    outputSchema: copilotAdviceResponseSchema,
    annotations: {
      readOnlyHint: false,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: false
    },
    invocation: { invoking: 'Queuing concise advice...', invoked: 'Advice queued' }
  })
  async copilotAdvice(input: CopilotAdviceInput, context: ExecutionContext): Promise<CopilotAdviceResponse> {
    requireAgentScope(context, 'act:audio');
    const claims = context.auth?.claims;
    const requestingAgentId = typeof claims?.sub === 'string' && claims.sub.length > 0 ? claims.sub : 'mcp-agent';
    const expectedSessionId = typeof claims?.sessionId === 'string' ? claims.sessionId : undefined;
    const result = copilotAdviceResponseSchema.parse(await backend(
      `/v1/copilot/requests/${encodeURIComponent(input.requestId)}/advice`,
      { ...input, requestingAgentId, expectedSessionId }
    ));
    context.logger.info('Copilot advice delivered through whisper coach', {
      boundary: 'mcp_tool_call',
      correlationId: crypto.randomUUID(),
      requestId: input.requestId,
      sessionId: result.request.sessionId,
      interventionId: result.intervention.interventionId,
      toolChain: ['copilot_advice', 'whisper_coach'],
      consentScope: 'act:audio',
      deliveryResult: result.intervention.deliveryResult
    });
    return result;
  }
}

export class CopilotPrompts {
  @Prompt({
    name: 'handle_copilot_request',
    title: 'Handle conversation copilot request',
    description: 'Process one on-demand watch request using only current MCP evidence.'
  })
  async handleCopilotRequest(_args: Record<string, never>, context: ExecutionContext) {
    context.logger.info('Copilot prompt requested', {
      boundary: 'mcp_prompt_read',
      correlationId: crypto.randomUUID()
    });
    return [{
      role: 'user' as const,
      content: {
        type: 'text' as const,
        text: 'Call get_pending_copilot_request. If a request exists, read session://current/context, session://current/transcript, and session://current/speech-metrics. Generate one actionable suggestion of at most 20 words, grounded only in those reads. Prefer an unsaid session goal when relevant. Never invent wearer or participant facts. Do not expose confidential context unless directly useful. Call copilot_advice once using transcript segment IDs, context evidence IDs returned by the context resource, or speech-metrics:current.'
      }
    }];
  }
}

function requireAgentScope(context: ExecutionContext, scope: string): void {
  if (context.auth && context.auth.scopes?.includes(scope) !== true) {
    throw new Error(`Authenticated agent is missing scope ${scope}`);
  }
}

async function backend(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${loadRuntimeConfig().BACKEND_URL}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5_000)
  });
  const value = await response.json() as unknown;
  if (!response.ok) {
    const detail = typeof value === 'object' && value !== null && 'error' in value ? String(value.error) : `HTTP ${response.status}`;
    throw new Error(`Backend copilot request failed: ${detail}`);
  }
  return value;
}
