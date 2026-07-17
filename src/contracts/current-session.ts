import { z } from 'zod';
import { currentStressSignalSchema, currentVitalsResponseSchema } from './vitals-resources.js';
import { sessionSchema, speechMetricSnapshotSchema, transcriptSegmentSchema } from './domain.js';

export const currentTranscriptResponseSchema = z.object({
  session: sessionSchema.nullable(),
  segments: z.array(transcriptSegmentSchema).max(100)
}).strict();
export type CurrentTranscriptResponse = z.infer<typeof currentTranscriptResponseSchema>;

export const currentSpeechMetricsResponseSchema = z.union([
  z.object({ session: sessionSchema, metrics: speechMetricSnapshotSchema }).strict(),
  z.object({ session: z.null(), metrics: z.null() }).strict()
]);
export type CurrentSpeechMetricsResponse = z.infer<typeof currentSpeechMetricsResponseSchema>;

export const currentSessionMetricsResponseSchema = z.object({
  session: sessionSchema,
  vitals: z.object({
    latest: currentVitalsResponseSchema.shape.latest,
    freshness: currentVitalsResponseSchema.shape.freshness,
    window: currentVitalsResponseSchema.shape.window
  }).strict(),
  stress: currentStressSignalSchema.nullable(),
  speechMetrics: speechMetricSnapshotSchema.nullable()
}).strict();
export type CurrentSessionMetricsResponse = z.infer<typeof currentSessionMetricsResponseSchema>;

export const currentTranscriptToolInputSchema = z.object({
  sinceMs: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(100).default(50)
}).strict();
export type CurrentTranscriptToolInput = z.infer<typeof currentTranscriptToolInputSchema>;

export const currentTranscriptToolResponseSchema = currentTranscriptResponseSchema.extend({
  truncated: z.boolean()
}).strict();
export type CurrentTranscriptToolResponse = z.infer<typeof currentTranscriptToolResponseSchema>;

export function selectCurrentTranscriptSegments(
  transcript: CurrentTranscriptResponse,
  input: CurrentTranscriptToolInput
): CurrentTranscriptToolResponse {
  const matching = input.sinceMs === undefined
    ? transcript.segments
    : transcript.segments.filter((segment) => segment.endMs >= input.sinceMs!);
  const segments = matching.slice(-input.limit);
  return {
    session: transcript.session,
    segments,
    truncated: matching.length > segments.length || transcript.segments.length === 100
  };
}
