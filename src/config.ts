import { z } from 'zod';

const runtimeConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  BACKEND_HOST: z.string().min(1).default('0.0.0.0'),
  BACKEND_PORT: z.coerce.number().int().min(0).max(65_535).default(8787),
  BACKEND_URL: z.string().url().default('http://rlcraft.hrideshmg.com'),
  DATABASE_PATH: z.string().min(1).default('data/pulse.sqlite'),
  VITALS_SOURCE: z.enum(['watch', 'simulated']).default('simulated'),
  AUDIO_INPUT: z.enum(['earbuds', 'phone']).default('phone'),
  TRANSCRIPTION_MODE: z.enum(['cloud', 'on_device', 'fixture']).default('fixture'),
  DEVICE_ACTIONS: z.enum(['real', 'simulated']).default('simulated'),
  COPILOT_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  STORE_RAW_AUDIO: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  DEEPGRAM_API_KEY: z.string().min(1).optional()
}).strict();

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

let cachedConfig: RuntimeConfig | undefined;

export function loadRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  if (environment === process.env && cachedConfig) return cachedConfig;

  const values = Object.fromEntries(
    Object.keys(runtimeConfigSchema.shape).flatMap((key) =>
      environment[key] === undefined ? [] : [[key, environment[key]]]
    )
  );
  const result = runtimeConfigSchema.safeParse(values);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid Pulse environment configuration: ${details}`);
  }
  if (result.data.STORE_RAW_AUDIO) {
    throw new Error('STORE_RAW_AUDIO=true is not supported in Phase 1');
  }

  if (environment === process.env) cachedConfig = result.data;
  return result.data;
}

export function clearRuntimeConfigCache(): void {
  cachedConfig = undefined;
}
