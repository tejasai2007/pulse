import { z } from 'zod';
import {
  consentGrantSchema,
  sessionContextSchema,
  sessionSchema,
  sessionStatusSchema,
  transcriptSegmentSchema,
  vitalSampleSchema
} from './domain.js';
import { copilotStateSchema } from './copilot.js';

export const CONTRACT_VERSION = '1.0' as const;

const id = z.string().min(1).max(128);
const timestamp = z.string().datetime({ offset: true });

function event<T extends string, S extends z.ZodTypeAny>(type: T, payload: S) {
  return z.object({
    version: z.literal(CONTRACT_VERSION),
    type: z.literal(type),
    sessionId: id,
    eventId: id,
    timestamp,
    correlationId: id,
    payload
  }).strict();
}

const emptyPayload = z.object({}).strict();

export const heartRateSampleEventSchema = event('heart_rate_sample', vitalSampleSchema);
export const heartRateAvailabilityEventSchema = event('heart_rate_availability', z.object({
  availability: z.enum(['available', 'acquiring', 'unavailable', 'unknown']),
  sessionElapsedMs: z.number().int().nonnegative()
}).strict());
export const watchStatusEventSchema = event('watch_status', z.object({
  connected: z.boolean(),
  batteryPercent: z.number().int().min(0).max(100).nullable(),
  sensorAvailable: z.boolean()
}).strict());
export const sessionActionEventSchema = event('session_action', z.object({
  action: z.enum(['start', 'pause', 'resume', 'end'])
}).strict());

export const sessionStateEventSchema = event('session_state', z.object({
  status: sessionStatusSchema
}).strict());
export const hapticCommandEventSchema = event('haptic_command', z.object({
  commandId: id,
  pattern: z.enum(['single', 'double', 'breathing']),
  expiresAt: timestamp
}).strict());
export const connectionStatusEventSchema = event('connection_status', z.object({
  phoneConnected: z.boolean(),
  backendConnected: z.boolean()
}).strict());

export const sessionStartedEventSchema = event('session_started', z.object({
  session: sessionSchema
}).strict());
export const sessionEndedEventSchema = event('session_ended', z.object({
  endedAt: timestamp,
  reason: z.enum(['completed', 'cancelled', 'failure'])
}).strict());
export const sessionContextUpdatedEventSchema = event('session_context_updated', sessionContextSchema);
export const vitalSampleReceivedEventSchema = event('vital_sample_received', vitalSampleSchema);
export const transcriptSegmentReceivedEventSchema = event('transcript_segment_received', transcriptSegmentSchema);
export const audioRouteChangedEventSchema = event('audio_route_changed', z.object({
  route: z.enum(['earbuds', 'phone', 'unavailable'])
}).strict());
export const consentUpdatedEventSchema = event('consent_updated', consentGrantSchema);
export const playbackCompletedEventSchema = event('playback_completed', z.object({
  commandId: id,
  result: z.enum(['played', 'cancelled', 'failed'])
}).strict());
export const adviceRequestedEventSchema = event('advice_requested', z.object({
  requestId: id
}).strict());
export const hapticCompletedEventSchema = event('haptic_completed', z.object({
  commandId: id,
  result: z.enum(['delivered', 'cancelled', 'failed'])
}).strict());

export const playTtsEventSchema = event('play_tts', z.object({
  commandId: id,
  text: z.string().min(1),
  expiresAt: timestamp,
  capturePolicy: z.literal('pause')
}).strict());
export const cancelTtsEventSchema = event('cancel_tts', z.object({ commandId: id }).strict());
export const sendWatchHapticEventSchema = event('send_watch_haptic', hapticCommandEventSchema.shape.payload);
export const reportReadyEventSchema = event('report_ready', z.object({ reportId: id }).strict());
export const copilotStateEventSchema = event('copilot_state', z.object({
  requestId: id,
  state: copilotStateSchema
}).strict());

export const pulseEventSchema = z.discriminatedUnion('type', [
  heartRateSampleEventSchema,
  heartRateAvailabilityEventSchema,
  watchStatusEventSchema,
  sessionActionEventSchema,
  adviceRequestedEventSchema,
  sessionStateEventSchema,
  hapticCommandEventSchema,
  connectionStatusEventSchema,
  sessionStartedEventSchema,
  sessionEndedEventSchema,
  sessionContextUpdatedEventSchema,
  vitalSampleReceivedEventSchema,
  transcriptSegmentReceivedEventSchema,
  audioRouteChangedEventSchema,
  consentUpdatedEventSchema,
  playbackCompletedEventSchema,
  hapticCompletedEventSchema,
  playTtsEventSchema,
  cancelTtsEventSchema,
  sendWatchHapticEventSchema,
  reportReadyEventSchema,
  copilotStateEventSchema
]);
export type PulseEvent = z.infer<typeof pulseEventSchema>;

export const eventAcknowledgementSchema = z.object({
  eventId: id,
  accepted: z.boolean(),
  duplicate: z.boolean(),
  receivedAt: timestamp,
  error: z.string().nullable()
}).strict();
export type EventAcknowledgement = z.infer<typeof eventAcknowledgementSchema>;

export const emptyEventPayloadSchema = emptyPayload;
