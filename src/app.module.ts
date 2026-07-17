import { McpApp, Module } from '@nitrostack/core';
import { PhaseZeroTools } from './phase-zero.tools.js';
import { TranscriptResources } from './transcript.resources.js';
import { SessionTools } from './session.tools.js';
import { VitalsResources } from './vitals.resources.js';
import { VitalsResourceNotifier } from './vitals-resource-notifier.js';
import { SpeechMetricsResources } from './speech-metrics.resources.js';
import { InterventionTools } from './intervention.tools.js';
import { SessionReportPrompts, SessionReportResources, SessionReportTools } from './session-report.mcp.js';
import { CurrentSessionTools } from './current-session.tools.js';
import { CopilotPrompts, CopilotResources, CopilotTools } from './copilot.mcp.js';

@McpApp({
  module: AppModule,
  server: { name: 'pulse', version: '0.2.0' },
  logging: { level: 'info' }
})
@Module({
  name: 'pulse-foundation',
  controllers: [
    VitalsResources,
    TranscriptResources,
    SpeechMetricsResources,
    SessionReportResources,
    SessionReportTools,
    SessionReportPrompts,
    CurrentSessionTools,
    SessionTools,
    CopilotResources,
    CopilotTools,
    CopilotPrompts,
    InterventionTools,
    PhaseZeroTools
  ],
  providers: [VitalsResourceNotifier]
})
export class AppModule {}
