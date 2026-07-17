import { McpApp, Module } from '@nitrostack/core';
import { HealthResources } from './health.resources.js';
import { PhaseZeroTools } from './phase-zero.tools.js';

@McpApp({
  module: AppModule,
  server: { name: 'pulse', version: '0.2.0' },
  logging: { level: 'info' }
})
@Module({
  name: 'pulse-foundation',
  controllers: [HealthResources, PhaseZeroTools]
})
export class AppModule {}
