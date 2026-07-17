import { z } from 'zod';
import type { RuntimeConfig } from './config.js';

export const dependencyHealthSchema = z.object({
  name: z.string(),
  status: z.enum(['available', 'degraded', 'unavailable']),
  detail: z.string()
}).strict();

export const healthResponseSchema = z.object({
  component: z.string(),
  status: z.enum(['ok', 'degraded', 'unavailable']),
  checkedAt: z.string().datetime({ offset: true }),
  contractVersion: z.literal('1.0'),
  dependencies: z.array(dependencyHealthSchema),
  flags: z.object({
    vitalsSource: z.enum(['watch', 'simulated']),
    audioInput: z.enum(['earbuds', 'phone']),
    transcriptionMode: z.enum(['cloud', 'on_device', 'fixture']),
    deviceActions: z.enum(['real', 'simulated'])
  }).strict()
}).strict();
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export function localHealth(component: string, config: RuntimeConfig): HealthResponse {
  const transcription = config.TRANSCRIPTION_MODE === 'cloud'
    ? config.DEEPGRAM_API_KEY
      ? { name: 'transcription_provider', status: 'degraded' as const, detail: 'configured; no active stream' }
      : { name: 'transcription_provider', status: 'unavailable' as const, detail: 'DEEPGRAM_API_KEY is missing' }
    : { name: 'transcription_provider', status: 'available' as const, detail: `${config.TRANSCRIPTION_MODE} fallback selected` };
  const device = config.DEVICE_ACTIONS === 'simulated'
    ? { name: 'device_command_channel', status: 'available' as const, detail: 'simulated actions selected' }
    : { name: 'device_command_channel', status: 'degraded' as const, detail: 'real channel awaits phone connection' };
  const dependencies = [transcription, device];
  const status = dependencies.some((item) => item.status === 'unavailable')
    ? 'unavailable'
    : dependencies.some((item) => item.status === 'degraded') ? 'degraded' : 'ok';

  return {
    component,
    status,
    checkedAt: new Date().toISOString(),
    contractVersion: '1.0',
    dependencies,
    flags: {
      vitalsSource: config.VITALS_SOURCE,
      audioInput: config.AUDIO_INPUT,
      transcriptionMode: config.TRANSCRIPTION_MODE,
      deviceActions: config.DEVICE_ACTIONS
    }
  };
}
