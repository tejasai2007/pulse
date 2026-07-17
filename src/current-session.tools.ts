import { ExecutionContext, ToolDecorator as Tool, z } from '@nitrostack/core';
import { loadRuntimeConfig } from './config.js';
import {
  currentSessionMetricsResponseSchema,
  currentSpeechMetricsResponseSchema,
  currentTranscriptResponseSchema,
  currentTranscriptToolInputSchema,
  currentTranscriptToolResponseSchema,
  selectCurrentTranscriptSegments,
  type CurrentSessionMetricsResponse,
  type CurrentTranscriptToolInput,
  type CurrentTranscriptToolResponse
} from './contracts/current-session.js';
import { currentStressResponseSchema, currentVitalsResponseSchema } from './contracts/vitals-resources.js';
import { authorizeVitalsRead } from './vitals-authorization.js';

const readOnlyAnnotations = {
  readOnlyHint: true,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: false
};

export class CurrentSessionTools {
  @Tool({
    name: 'get_current_session_metrics',
    title: 'Get current session metrics',
    description: 'Read consent-scoped live vitals, the deterministic stress signal, and speech pace metrics for the current session. The stress signal is not a medical diagnosis.',
    inputSchema: z.object({}).strict(),
    outputSchema: currentSessionMetricsResponseSchema,
    annotations: readOnlyAnnotations
  })
  async getCurrentSessionMetrics(_input: Record<string, never>, context: ExecutionContext): Promise<CurrentSessionMetricsResponse> {
    const [vitals, stress, speech] = await Promise.all([
      readBackend('/v1/sessions/current/vitals').then((value) => currentVitalsResponseSchema.parse(value)),
      readBackend('/v1/sessions/current/stress').then((value) => currentStressResponseSchema.parse(value)),
      readBackend('/v1/sessions/current/speech-metrics').then((value) => currentSpeechMetricsResponseSchema.parse(value))
    ]);

    authorizeVitalsRead(vitals, context, 'get_current_session_metrics', 'mcp_tool_call');
    authorizeVitalsRead(stress, context, 'get_current_session_metrics', 'mcp_tool_call');
    const sessionId = vitals.session.sessionId;
    if (stress.session.sessionId !== sessionId || (speech.session && speech.session.sessionId !== sessionId)) {
      throw new Error('Current session changed while metrics were being read');
    }

    context.logger.info('Current session metrics read', {
      boundary: 'mcp_tool_call',
      correlationId: crypto.randomUUID(),
      sessionId
    });
    return currentSessionMetricsResponseSchema.parse({
      session: vitals.session,
      vitals: {
        latest: vitals.latest,
        freshness: vitals.freshness,
        window: vitals.window
      },
      stress: stress.signal,
      speechMetrics: speech.metrics
    });
  }

  @Tool({
    name: 'get_current_transcript',
    title: 'Get current transcript',
    description: 'Read bounded final transcript segments from the current session. Returns the latest matching segments in chronological order.',
    inputSchema: currentTranscriptToolInputSchema,
    outputSchema: currentTranscriptToolResponseSchema,
    annotations: readOnlyAnnotations
  })
  async getCurrentTranscript(input: CurrentTranscriptToolInput, context: ExecutionContext): Promise<CurrentTranscriptToolResponse> {
    const transcript = currentTranscriptResponseSchema.parse(await readBackend('/v1/sessions/current/transcript'));
    const result = selectCurrentTranscriptSegments(transcript, input);
    context.logger.info('Current session transcript read', {
      boundary: 'mcp_tool_call',
      correlationId: crypto.randomUUID(),
      sessionId: result.session?.sessionId,
      returnedSegments: result.segments.length,
      truncated: result.truncated
    });
    return currentTranscriptToolResponseSchema.parse(result);
  }
}

async function readBackend(path: string): Promise<unknown> {
  const response = await fetch(`${loadRuntimeConfig().BACKEND_URL}${path}`, {
    signal: AbortSignal.timeout(2_000)
  });
  if (!response.ok) throw new Error(`Backend current session request failed (${response.status})`);
  return response.json();
}
