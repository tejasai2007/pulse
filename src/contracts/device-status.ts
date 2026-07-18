import { z } from 'zod';
import { sessionSchema } from './domain.js';

const timestamp = z.string().datetime({ offset: true });

export const deviceComponentStateSchema = z.enum([
  'connected',
  'degraded',
  'offline',
  'unavailable',
  'unknown'
]);
export type DeviceComponentState = z.infer<typeof deviceComponentStateSchema>;

export const deviceComponentModeSchema = z.enum(['live', 'simulated', 'fallback', 'unavailable']).nullable();
export type DeviceComponentMode = z.infer<typeof deviceComponentModeSchema>;

export const deviceComponentStatusSchema = z.object({
  state: deviceComponentStateSchema,
  mode: deviceComponentModeSchema,
  detail: z.string().min(1).max(500),
  checkedAt: timestamp
}).strict();
export type DeviceComponentStatus = z.infer<typeof deviceComponentStatusSchema>;

export const deviceStatusReportSchema = z.object({
  sessionId: z.string().min(1).max(128),
  reportedAt: timestamp,
  watch: deviceComponentStatusSchema,
  phone: deviceComponentStatusSchema,
  earbuds: deviceComponentStatusSchema,
  microphone: deviceComponentStatusSchema,
  transcriptionProvider: deviceComponentStatusSchema
}).strict();
export type DeviceStatusReport = z.infer<typeof deviceStatusReportSchema>;

export const deviceStatusFlagsSchema = z.object({
  simulatedVitals: z.boolean(),
  simulatedDeviceActions: z.boolean(),
  audioInput: z.enum(['earbuds', 'phone']),
  transcriptionMode: z.enum(['cloud', 'on_device', 'fixture']),
  activeFallbacks: z.array(z.enum(['phone_microphone', 'on_device_transcription', 'fixture_transcription'])).max(3)
}).strict();
export type DeviceStatusFlags = z.infer<typeof deviceStatusFlagsSchema>;

export const deviceStatusResponseSchema = z.object({
  session: sessionSchema.nullable(),
  flags: deviceStatusFlagsSchema,
  watch: deviceComponentStatusSchema,
  phone: deviceComponentStatusSchema,
  earbuds: deviceComponentStatusSchema,
  microphone: deviceComponentStatusSchema,
  transcriptionProvider: deviceComponentStatusSchema,
  backend: deviceComponentStatusSchema,
  agentAccess: deviceComponentStatusSchema
}).strict();
export type DeviceStatusResponse = z.infer<typeof deviceStatusResponseSchema>;
