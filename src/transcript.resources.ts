import { ExecutionContext, ResourceDecorator as Resource } from '@nitrostack/core';
import { z } from 'zod';
import { loadRuntimeConfig } from './config.js';
import { currentTranscriptResponseSchema } from './contracts/current-session.js';
import { sessionSchema, transcriptSegmentSchema } from './contracts/domain.js';

const historicalTranscriptSchema = z.object({
  session: sessionSchema,
  segments: z.array(transcriptSegmentSchema)
}).strict();

const latestTranscriptSchema = z.union([
  z.object({ session: sessionSchema, segment: transcriptSegmentSchema }).strict(),
  z.object({ session: z.null(), segment: z.null() }).strict()
]);

export class TranscriptResources {
  @Resource({
    uri: 'session://latest/transcript',
    name: 'Latest uploaded transcript',
    description: 'The most recently ingested final transcript segment across all sessions.',
    mimeType: 'application/json',
    annotations: { audience: ['assistant'], priority: 1 }
  })
  async latestTranscript(uri: string, context: ExecutionContext) {
    context.logger.info('Latest transcript resource read', {
      boundary: 'mcp_resource_read',
      correlationId: crypto.randomUUID(),
      resourceUri: uri
    });
    const response = await fetch(`${loadRuntimeConfig().BACKEND_URL}/v1/transcripts/latest`, {
      signal: AbortSignal.timeout(2_000)
    });
    if (!response.ok) throw new Error(`Backend latest transcript request failed (${response.status})`);
    return latestTranscriptSchema.parse(await response.json());
  }

  @Resource({
    uri: 'session://current/transcript',
    name: 'Live Session transcript',
    description: 'Transcript segments from the active session, ordered on its monotonic timeline.',
    mimeType: 'application/json',
    annotations: { audience: ['assistant'], priority: 1 }
  })
  async currentTranscript(uri: string, context: ExecutionContext) {
    const correlationId = crypto.randomUUID();
    context.logger.info('Transcript resource read', {
      boundary: 'mcp_resource_read',
      correlationId,
      resourceUri: uri
    });
    const config = loadRuntimeConfig();
    const response = await fetch(`${config.BACKEND_URL}/v1/sessions/current/transcript`, {
      signal: AbortSignal.timeout(2_000)
    });
    if (!response.ok) throw new Error(`Backend transcript request failed (${response.status})`);
    const transcript = currentTranscriptResponseSchema.parse(await response.json());
    return transcript;
  }

  @Resource({
    uri: 'session://{sessionId}/transcript',
    name: 'Historical Session Transcripts',
    description: 'All final transcript segments stored for a selected session.',
    mimeType: 'application/json',
    annotations: { audience: ['assistant'], priority: 0.9 }
  })
  async historicalTranscript(uri: string, context: ExecutionContext) {
    const sessionId = sessionIdFromResourceUri(uri, 'transcript');
    context.logger.info('Historical transcript resource read', {
      boundary: 'mcp_resource_read',
      correlationId: crypto.randomUUID(),
      resourceUri: uri,
      sessionId
    });
    const response = await fetch(`${loadRuntimeConfig().BACKEND_URL}/v1/sessions/${encodeURIComponent(sessionId)}/transcript`, {
      signal: AbortSignal.timeout(2_000)
    });
    if (!response.ok) throw new Error(`Backend transcript request failed (${response.status})`);
    return historicalTranscriptSchema.parse(await response.json());
  }
}

function sessionIdFromResourceUri(uri: string, subject: string): string {
  const match = uri.match(new RegExp(`^session://([^/]+)/${subject}$`));
  if (!match) throw new Error(`Invalid session resource URI: ${uri}`);
  return decodeURIComponent(match[1]);
}
