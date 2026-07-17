import { z } from 'zod';
import { interventionActionResponseSchema } from './interventions.js';
import { sessionContextSchema, sessionSchema } from './domain.js';

const id = z.string().min(1).max(128);
const timestamp = z.string().datetime({ offset: true });

export const COPILOT_ADVICE_WORD_LIMIT = 20;

export const copilotStateSchema = z.enum([
  'requested',
  'thinking',
  'queued',
  'playing',
  'completed',
  'expired',
  'cancelled',
  'failed'
]);
export type CopilotState = z.infer<typeof copilotStateSchema>;

export const copilotRequestSchema = z.object({
  requestId: id,
  sessionId: id,
  sourceEventId: id,
  requestedAt: timestamp,
  updatedAt: timestamp,
  state: copilotStateSchema,
  advice: z.string().nullable(),
  commandId: id.nullable()
}).strict();
export type CopilotRequest = z.infer<typeof copilotRequestSchema>;

export const pendingCopilotResponseSchema = z.object({
  request: copilotRequestSchema.nullable(),
  duplicate: z.boolean().default(false)
}).strict();
export type PendingCopilotResponse = z.infer<typeof pendingCopilotResponseSchema>;

export const copilotAdviceInputSchema = z.object({
  requestId: id,
  text: z.string().min(1).refine(
    (text) => text.trim().split(/\s+/u).length <= COPILOT_ADVICE_WORD_LIMIT,
    `Advice must contain at most ${COPILOT_ADVICE_WORD_LIMIT} words`
  ),
  triggerEvidenceIds: z.array(id).min(1).max(200),
  confidentialContextDirectlyUseful: z.boolean().default(false),
  expiresInMs: z.number().int().min(1_000).max(30_000).default(15_000)
}).strict();
export type CopilotAdviceInput = z.infer<typeof copilotAdviceInputSchema>;

export const copilotAdviceResponseSchema = interventionActionResponseSchema.extend({
  request: copilotRequestSchema
}).strict();
export type CopilotAdviceResponse = z.infer<typeof copilotAdviceResponseSchema>;

export const currentContextResponseSchema = z.object({
  session: sessionSchema.nullable(),
  context: sessionContextSchema.nullable(),
  consentAllowed: z.boolean(),
  evidenceIds: z.object({
    situation: z.literal('context:situation'),
    goals: z.array(z.string())
  }).strict().nullable()
}).strict();
export type CurrentContextResponse = z.infer<typeof currentContextResponseSchema>;
