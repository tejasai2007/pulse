import { z } from 'zod';
import { interventionSchema } from './domain.js';

const id = z.string().min(1).max(128);

export const hapticNudgeInputSchema = z.object({
  idempotencyKey: id,
  pattern: z.enum(['single', 'double', 'breathing']),
  triggerEvidenceIds: z.array(id).max(200).default([])
}).strict();
export type HapticNudgeInput = z.infer<typeof hapticNudgeInputSchema>;

export const whisperCoachInputSchema = z.object({
  idempotencyKey: id,
  text: z.string().min(1),
  triggerEvidenceIds: z.array(id).max(200).default([]),
  expiresInMs: z.number().int().min(1_000).max(300_000).default(30_000)
}).strict();
export type WhisperCoachInput = z.infer<typeof whisperCoachInputSchema>;

export const interventionActionResponseSchema = z.object({
  intervention: interventionSchema,
  commandId: id,
  duplicate: z.boolean()
}).strict();
export type InterventionActionResponse = z.infer<typeof interventionActionResponseSchema>;

export const backendHapticRequestSchema = hapticNudgeInputSchema.extend({
  requestingAgentId: id,
  expectedSessionId: id.optional()
}).strict();
export const backendWhisperRequestSchema = whisperCoachInputSchema.extend({
  requestingAgentId: id,
  expectedSessionId: id.optional()
}).strict();
