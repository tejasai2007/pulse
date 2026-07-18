import { z } from 'zod';

const id = z.string().min(1).max(128);
const timestamp = z.string().datetime({ offset: true });

export const sessionStatusSchema = z.enum([
  'created',
  'calibrating',
  'active',
  'ending',
  'completed',
  'failed'
]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const sessionSchema = z.object({
  sessionId: id,
  status: sessionStatusSchema,
  startedAt: timestamp.nullable(),
  endedAt: timestamp.nullable(),
  simulatedVitals: z.boolean(),
  audioInputRoute: z.enum(['earbuds', 'phone', 'unavailable'])
}).strict();
export type Session = z.infer<typeof sessionSchema>;

export const sessionContextSchema = z.object({
  sessionId: id,
  wearerSummary: z.string().max(4_000),
  situation: z.string().max(4_000),
  participants: z.array(z.object({
    name: z.string().min(1).max(200),
    role: z.string().min(1).max(500)
  }).strict()).max(50),
  goals: z.array(z.string().min(1).max(1_000)).max(50),
  topicsToAvoid: z.array(z.string().min(1).max(1_000)).max(50),
  stressSensitivity: z.object({
    baselineOffsetBpm: z.number().min(0).max(100),
    elevationTriggerMs: z.number().int().positive(),
    recoveryTriggerMs: z.number().int().positive(),
    cooldownMs: z.number().int().nonnegative()
  }).strict()
}).strict();
export type SessionContext = z.infer<typeof sessionContextSchema>;

export const vitalSampleSchema = z.object({
  sessionId: id,
  bpm: z.number().positive().max(300),
  availability: z.enum(['available', 'acquiring', 'unavailable', 'unknown']),
  sessionElapsedMs: z.number().int().nonnegative(),
  deviceTimestamp: timestamp,
  source: z.enum(['watch', 'simulator'])
}).strict();
export type VitalSample = z.infer<typeof vitalSampleSchema>;

export const stressSignalSchema = z.object({
  sessionId: id,
  state: z.enum(['baseline', 'elevated', 'sustained_elevation', 'recovering']),
  baselineBpm: z.number().positive().max(300),
  currentDeltaBpm: z.number().min(-300).max(300),
  elevationStartedAtMs: z.number().int().nonnegative().nullable(),
  elevationDurationMs: z.number().int().nonnegative(),
  evidence: z.array(vitalSampleSchema).max(120),
  cooldownUntilMs: z.number().int().nonnegative().nullable()
}).strict();
export type StressSignal = z.infer<typeof stressSignalSchema>;

export const transcriptSegmentSchema = z.object({
  sessionId: id,
  segmentId: id,
  speaker: z.enum(['wearer', 'participant', 'agent', 'unknown']),
  text: z.string().min(1).max(20_000),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  providerTimestamp: timestamp,
  confidence: z.number().min(0).max(1).nullable(),
  isFinal: z.boolean()
}).strict().refine(({ startMs, endMs }) => endMs >= startMs, {
  message: 'endMs must be greater than or equal to startMs',
  path: ['endMs']
});
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;

export const speechMetricSnapshotSchema = z.object({
  sessionId: id,
  calculatedAtMs: z.number().int().nonnegative(),
  wordsPerMinute: z.number().nonnegative(),
  longestTurnMs: z.number().int().nonnegative(),
  currentSilenceMs: z.number().int().nonnegative()
}).strict();
export type SpeechMetricSnapshot = z.infer<typeof speechMetricSnapshotSchema>;

export const consentScopeSchema = z.enum([
  'read:vitals',
  'read:context',
  'read:transcript',
  'act:haptic',
  'act:audio'
]);
export type ConsentScope = z.infer<typeof consentScopeSchema>;

export const consentGrantSchema = z.object({
  grantId: id,
  sessionId: id,
  scope: consentScopeSchema,
  grantedAt: timestamp,
  revokedAt: timestamp.nullable()
}).strict();
export type ConsentGrant = z.infer<typeof consentGrantSchema>;

export const interventionSchema = z.object({
  interventionId: id,
  sessionId: id,
  type: z.enum(['haptic_nudge', 'whisper_coach', 'copilot_advice']),
  triggerEvidenceIds: z.array(id).max(200),
  requestingAgentId: id,
  generatedMessage: z.string().nullable(),
  requestedAt: timestamp,
  queuedAt: timestamp.nullable(),
  playedAt: timestamp.nullable(),
  dismissedAt: timestamp.nullable(),
  deliveryResult: z.enum(['pending', 'delivered', 'expired', 'cancelled', 'failed'])
}).strict();
export type Intervention = z.infer<typeof interventionSchema>;

export const auditEntrySchema = z.object({
  auditId: id,
  sessionId: id,
  timestamp,
  kind: z.enum(['resource_read', 'tool_call']),
  subject: z.string().min(1).max(500),
  arguments: z.record(z.unknown()),
  consentScope: consentScopeSchema,
  consentAllowed: z.boolean(),
  outcome: z.enum(['allowed', 'denied', 'succeeded', 'failed']),
  correlationId: id,
  interventionId: id.nullable()
}).strict();
export type AuditEntry = z.infer<typeof auditEntrySchema>;
