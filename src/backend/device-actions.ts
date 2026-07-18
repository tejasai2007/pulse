import type { WebSocket } from 'ws';
import type { RuntimeConfig } from '../config.js';
import type { InterventionActionResponse } from '../contracts/interventions.js';
import type { PulseEvent } from '../contracts/events.js';
import type { CopilotAdviceInput, CopilotAdviceResponse, CopilotRequest, PendingCopilotResponse } from '../contracts/copilot.js';
import type { StructuredLogger } from '../observability/logger.js';
import { EventStore, type PendingIntervention } from './event-store.js';

const SAFE_SILENCE_MS = 1_500;
const COPILOT_REQUEST_TTL_MS = 30_000;

export class DeviceActions {
  private readonly sockets = new Set<WebSocket>();
  private readonly queueTimer: NodeJS.Timeout;

  constructor(
    private readonly store: EventStore,
    private readonly config: RuntimeConfig,
    private readonly logger: StructuredLogger
  ) {
    this.queueTimer = setInterval(() => this.processWhisperQueue(), 250);
    this.queueTimer.unref();
  }

  addSocket(socket: WebSocket): void {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    this.processWhisperQueue();
  }

  haptic(input: {
    idempotencyKey: string;
    pattern: 'single' | 'double' | 'breathing';
    triggerEvidenceIds: string[];
    requestingAgentId: string;
    expectedSessionId?: string;
  }): InterventionActionResponse {
    const session = this.requireActionableSession('act:haptic');
    this.requireExpectedSession(session.sessionId, input.expectedSessionId);
    const action = this.store.createIntervention({
      ...input,
      sessionId: session.sessionId,
      type: 'haptic_nudge',
      generatedMessage: null
    });
    if (action.duplicate) return action;

    if (this.config.DEVICE_ACTIONS === 'simulated') {
      this.simulateCompletion(action.commandId, session.sessionId, 'haptic_completed', 'delivered');
    } else {
      if (!this.hasConnectedPhone()) {
        this.store.completeCommand(action.commandId, 'failed', new Date().toISOString());
        throw new Error('No phone is connected to deliver the haptic command');
      }
      this.broadcast(this.commandEvent(session.sessionId, 'send_watch_haptic', {
        commandId: action.commandId,
        pattern: input.pattern,
        expiresAt: new Date(Date.now() + 10_000).toISOString()
      }));
      this.store.markInterventionDispatched(action.commandId);
    }
    return this.currentResponse(action.commandId, false);
  }

  whisper(input: {
    idempotencyKey: string;
    text: string;
    triggerEvidenceIds: string[];
    expiresInMs: number;
    requestingAgentId: string;
    expectedSessionId?: string;
  }): InterventionActionResponse {
    const session = this.requireActionableSession('act:audio');
    this.requireExpectedSession(session.sessionId, input.expectedSessionId);
    const action = this.store.createIntervention({
      ...input,
      sessionId: session.sessionId,
      type: 'whisper_coach',
      generatedMessage: input.text,
      expiresAt: new Date(Date.now() + input.expiresInMs).toISOString()
    });
    if (action.duplicate) return action;
    this.processWhisperQueue();
    return this.currentResponse(action.commandId, false);
  }

  claimCopilotRequest(): PendingCopilotResponse {
    if (!this.config.COPILOT_ENABLED) return { request: null, duplicate: false };
    const request = this.store.getRequestedCopilotRequest();
    if (!request) return { request: null, duplicate: false };
    if (Date.now() - Date.parse(request.requestedAt) >= COPILOT_REQUEST_TTL_MS) {
      const expired = this.store.updateCopilotRequest(request.requestId, 'expired');
      this.broadcastCopilotState(expired);
      return { request: null, duplicate: false };
    }
    const thinking = this.store.updateCopilotRequest(request.requestId, 'thinking');
    this.broadcastCopilotState(thinking);
    return { request: thinking, duplicate: false };
  }

  copilotAdvice(input: CopilotAdviceInput & {
    requestingAgentId: string;
    expectedSessionId?: string;
  }): CopilotAdviceResponse {
    if (!this.config.COPILOT_ENABLED) throw new Error('Conversation Copilot is disabled');
    const request = this.store.getCopilotRequest(input.requestId);
    if (!request) throw new Error(`Unknown copilot request: ${input.requestId}`);
    const session = this.requireActionableSession('act:audio');
    this.requireExpectedSession(session.sessionId, input.expectedSessionId);
    if (request.sessionId !== session.sessionId) throw new Error('Copilot request does not belong to the current session');
    if (request.commandId && ['queued', 'playing', 'completed'].includes(request.state)) {
      return { ...this.currentResponse(request.commandId, true), request };
    }
    if (request.state !== 'thinking' && request.state !== 'queued' && request.state !== 'playing') {
      throw new Error(`Copilot request ${input.requestId} is not actionable (${request.state})`);
    }
    if (Date.now() - Date.parse(request.requestedAt) >= COPILOT_REQUEST_TTL_MS) {
      const expired = this.store.updateCopilotRequest(request.requestId, 'expired');
      this.broadcastCopilotState(expired);
      throw new Error('Copilot request expired before advice was ready');
    }
    const unknownEvidence = input.triggerEvidenceIds.filter((id) => !this.store.hasCopilotEvidence(session.sessionId, id));
    if (unknownEvidence.length > 0) throw new Error(`Unknown copilot evidence: ${unknownEvidence.join(', ')}`);
    const action = this.store.createIntervention({
      sessionId: session.sessionId,
      type: 'copilot_advice',
      idempotencyKey: request.requestId,
      requestingAgentId: input.requestingAgentId,
      triggerEvidenceIds: input.triggerEvidenceIds,
      generatedMessage: input.text,
      expiresAt: new Date(Date.now() + input.expiresInMs).toISOString()
    });
    if (!action.duplicate) {
      const queued = this.store.updateCopilotRequest(request.requestId, 'queued', {
        advice: input.text,
        commandId: action.commandId
      });
      this.broadcastCopilotState(queued);
      this.processWhisperQueue();
    }
    const current = this.store.getCopilotRequest(request.requestId)!;
    return { ...this.currentResponse(action.commandId, action.duplicate), request: current };
  }

  beforeIngest(event: PulseEvent): void {
    if (event.type !== 'consent_updated' || event.payload.revokedAt === null || event.payload.scope !== 'act:audio') return;
    for (const pending of this.store.getPendingAudioInterventions()) {
      if (pending.intervention.sessionId !== event.sessionId || pending.dispatchedAt === null) continue;
      this.broadcast(this.commandEvent(event.sessionId, 'cancel_tts', { commandId: pending.commandId }));
    }
  }

  afterIngest(event: PulseEvent, duplicate: boolean): void {
    if (duplicate || !this.config.COPILOT_ENABLED) return;
    if (event.type === 'advice_requested') {
      const session = this.store.getSession(event.sessionId);
      if (!session || session.status !== 'active') return;
      const result = this.store.createCopilotRequest({
        requestId: event.payload.requestId,
        sessionId: event.sessionId,
        sourceEventId: event.eventId,
        requestedAt: event.timestamp
      });
      this.broadcastCopilotState(result.request);
      if (!result.duplicate && this.config.COPILOT_MODE === 'automatic') {
        void this.processCopilotRequest(result.request);
      }
      return;
    }
    if (event.type === 'consent_updated' && event.payload.scope === 'act:audio' && event.payload.revokedAt !== null) {
      const request = this.store.getActiveCopilotRequest(event.sessionId);
      if (request?.commandId) {
        const intervention = this.store.getInterventionByCommand(request.commandId)?.intervention;
        if (intervention && intervention.deliveryResult !== 'pending') {
          this.broadcastCopilotState(this.store.updateCopilotRequest(request.requestId, 'cancelled', {}, event.timestamp));
        }
      }
      return;
    }
    if (event.type === 'playback_completed') this.finishCopilotForCommand(event.payload.commandId, event.payload.result);
  }

  close(): void {
    clearInterval(this.queueTimer);
  }

  private processWhisperQueue(): void {
    const now = Date.now();
    const activeCopilot = this.store.getCurrentSession()?.sessionId;
    const staleRequest = activeCopilot ? this.store.getActiveCopilotRequest(activeCopilot) : undefined;
    if (staleRequest && ['requested', 'thinking'].includes(staleRequest.state) &&
      now - Date.parse(staleRequest.requestedAt) >= COPILOT_REQUEST_TTL_MS) {
      this.broadcastCopilotState(this.store.updateCopilotRequest(staleRequest.requestId, 'expired'));
    }
    const pendingAudio = this.store.getPendingAudioInterventions();
    if (pendingAudio.some(({ dispatchedAt }) => dispatchedAt !== null)) return;
    for (const pending of pendingAudio) {
      if (pending.dispatchedAt !== null) continue;
      if (!pending.expiresAt || Date.parse(pending.expiresAt) <= now) {
        this.store.expireIntervention(pending.commandId);
        this.finishCopilotForCommand(pending.commandId, 'cancelled', 'expired');
        continue;
      }
      const { sessionId } = pending.intervention;
      const session = this.store.getSession(sessionId);
      if (!session || session.status !== 'active' || !this.store.hasActiveConsent(sessionId, 'act:audio')) {
        this.store.completeCommand(pending.commandId, 'cancelled', new Date().toISOString());
        this.finishCopilotForCommand(pending.commandId, 'cancelled');
        continue;
      }
      if (this.store.getConversationSilenceMs(sessionId, now) < SAFE_SILENCE_MS) continue;
      if (this.config.DEVICE_ACTIONS === 'simulated') {
        this.markCopilotPlaying(pending.commandId);
        this.simulateCompletion(pending.commandId, sessionId, 'playback_completed', 'played');
        continue;
      }
      if (!this.hasConnectedPhone()) continue;
      this.broadcast(this.commandEvent(sessionId, 'play_tts', {
        commandId: pending.commandId,
        text: pending.intervention.generatedMessage!,
        expiresAt: pending.expiresAt,
        capturePolicy: 'pause'
      }));
      this.store.markInterventionDispatched(pending.commandId);
      this.markCopilotPlaying(pending.commandId);
      return;
    }
  }

  private async processCopilotRequest(request: CopilotRequest): Promise<void> {
    if (!this.store.hasActiveConsent(request.sessionId, 'read:transcript') ||
      !this.store.hasActiveConsent(request.sessionId, 'act:audio')) {
      this.broadcastCopilotState(this.store.updateCopilotRequest(request.requestId, 'failed'));
      return;
    }

    const transcript = this.store.getTranscriptSegments(request.sessionId).slice(-20);
    const speechMetrics = this.store.getSpeechMetrics(request.sessionId);
    if (!speechMetrics) {
      this.broadcastCopilotState(this.store.updateCopilotRequest(request.requestId, 'failed'));
      return;
    }
    const vitalsAllowed = this.store.hasActiveConsent(request.sessionId, 'read:vitals');
    const stress = vitalsAllowed ? this.store.getStressSignal(request.sessionId) : undefined;
    const latestVital = vitalsAllowed ? this.store.getVitalSamples(request.sessionId).at(-1) : undefined;
    const fallback = speechMetrics.wordsPerMinute > 160
      ? 'Slow down and make your next point concise.'
      : speechMetrics.longestTurnMs > 30_000
        ? 'Pause and invite the other person to respond.'
        : transcript.length > 0
          ? 'Address the latest point with one clear follow-up question.'
          : 'Listen first, then ask one clear follow-up question.';
    const evidenceIds = [
      'speech-metrics:current',
      ...(stress ? ['stress:current'] : []),
      ...(latestVital ? ['vitals:current'] : []),
      ...transcript.map(({ segmentId }) => segmentId)
    ];

    const thinking = this.store.updateCopilotRequest(request.requestId, 'thinking');
    this.broadcastCopilotState(thinking);
    try {
      const text = await this.generateOpenAiAdvice(transcript, speechMetrics, stress, latestVital, fallback);
      this.copilotAdvice({
        requestId: request.requestId,
        text,
        triggerEvidenceIds: evidenceIds,
        confidentialContextDirectlyUseful: false,
        expiresInMs: 15_000,
        requestingAgentId: 'backend-openai-copilot'
      });
    } catch (error) {
      this.logger.error('Automatic copilot request failed', {
        boundary: 'openai_advice',
        requestId: request.requestId,
        sessionId: request.sessionId,
        error: error instanceof Error ? error.message : 'Unknown OpenAI error'
      });
      const current = this.store.getCopilotRequest(request.requestId);
      if (current?.state === 'thinking') {
        this.broadcastCopilotState(this.store.updateCopilotRequest(request.requestId, 'failed'));
      }
    }
  }

  private async generateOpenAiAdvice(
    transcript: ReturnType<EventStore['getTranscriptSegments']>,
    speechMetrics: NonNullable<ReturnType<EventStore['getSpeechMetrics']>>,
    stress: ReturnType<EventStore['getStressSignal']>,
    latestVital: ReturnType<EventStore['getVitalSamples']>[number] | undefined,
    fallback: string
  ): Promise<string> {
    if (!this.config.OPENAI_API_KEY) return fallback;

    try {
      const response = await fetch(`${this.config.OPENAI_BASE_URL.replace(/\/$/u, '')}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.OPENAI_API_KEY}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: this.config.OPENAI_MODEL,
          store: false,
          max_output_tokens: 80,
          instructions: 'Give one immediately actionable conversation suggestion using only the supplied transcript and metrics. Use at most 20 words. Do not invent facts. Return JSON only.',
          input: JSON.stringify({
            recentTranscript: transcript.map(({ segmentId, speaker, text }) => ({ segmentId, speaker, text })),
            speechMetrics: {
              wordsPerMinute: speechMetrics.wordsPerMinute,
              longestTurnMs: speechMetrics.longestTurnMs,
              currentSilenceMs: speechMetrics.currentSilenceMs
            },
            stress: stress ? {
              state: stress.state,
              currentDeltaBpm: stress.currentDeltaBpm,
              elevationDurationMs: stress.elevationDurationMs
            } : null,
            latestVital: latestVital ? {
              bpm: latestVital.bpm,
              availability: latestVital.availability,
              source: latestVital.source
            } : null
          }),
          text: {
            format: {
              type: 'json_schema',
              name: 'copilot_advice',
              strict: true,
              schema: {
                type: 'object',
                properties: { advice: { type: 'string' } },
                required: ['advice'],
                additionalProperties: false
              }
            }
          }
        }),
        signal: AbortSignal.timeout(10_000)
      });
      if (!response.ok) throw new Error(`OpenAI returned HTTP ${response.status}`);
      const body = await response.json() as {
        output_text?: string;
        output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
      };
      const output = body.output_text ?? body.output
        ?.flatMap(({ content }) => content ?? [])
        .find(({ type }) => type === 'output_text')?.text;
      if (!output) throw new Error('OpenAI returned no advice');
      const parsed = JSON.parse(output) as { advice?: unknown };
      if (typeof parsed.advice !== 'string' || parsed.advice.trim().length === 0) {
        throw new Error('OpenAI returned invalid advice');
      }
      return parsed.advice.trim().split(/\s+/u).slice(0, 20).join(' ');
    } catch (error) {
      this.logger.warn('OpenAI advice unavailable; using deterministic fallback', {
        boundary: 'openai_advice',
        error: error instanceof Error ? error.message : 'Unknown OpenAI error'
      });
      return fallback;
    }
  }

  private requireActionableSession(scope: 'act:haptic' | 'act:audio') {
    const session = this.store.getCurrentSession();
    if (!session) throw new Error('No current session');
    if (session.status !== 'active') throw new Error(`Session ${session.sessionId} is stale or not active (${session.status})`);
    if (!this.store.hasActiveConsent(session.sessionId, scope)) {
      throw new Error(`Consent scope ${scope} is not granted for session ${session.sessionId}`);
    }
    return session;
  }

  private currentResponse(commandId: string, duplicate: boolean): InterventionActionResponse {
    const current = this.store.getInterventionByCommand(commandId);
    if (!current) throw new Error(`Unknown device command: ${commandId}`);
    return { intervention: current.intervention, commandId, duplicate };
  }

  private requireExpectedSession(sessionId: string, expectedSessionId?: string): void {
    if (expectedSessionId !== undefined && expectedSessionId !== sessionId) {
      throw new Error(`Authenticated session does not match current session ${sessionId}`);
    }
  }

  private simulateCompletion(
    commandId: string,
    sessionId: string,
    type: 'playback_completed' | 'haptic_completed',
    result: 'played' | 'delivered'
  ): void {
    const timestamp = new Date().toISOString();
    this.store.ingest({
      version: '1.0',
      type,
      sessionId,
      eventId: crypto.randomUUID(),
      timestamp,
      correlationId: crypto.randomUUID(),
      payload: { commandId, result }
    } as PulseEvent);
    if (type === 'playback_completed') this.finishCopilotForCommand(commandId, result as 'played');
  }

  private markCopilotPlaying(commandId: string): void {
    const request = this.store.getCopilotRequestByCommand(commandId);
    if (!request || request.state !== 'queued') return;
    this.broadcastCopilotState(this.store.updateCopilotRequest(request.requestId, 'playing'));
  }

  private finishCopilotForCommand(
    commandId: string,
    result: 'played' | 'cancelled' | 'failed',
    override?: 'expired'
  ): void {
    const request = this.store.getCopilotRequestByCommand(commandId);
    if (!request || !['queued', 'playing'].includes(request.state)) return;
    const state = override ?? (result === 'played' ? 'completed' : result);
    this.broadcastCopilotState(this.store.updateCopilotRequest(request.requestId, state));
  }

  private broadcastCopilotState(request: CopilotRequest): void {
    this.broadcast(this.commandEvent(request.sessionId, 'copilot_state', {
      requestId: request.requestId,
      state: request.state
    }));
  }

  private commandEvent<T extends 'send_watch_haptic' | 'play_tts' | 'cancel_tts' | 'copilot_state'>(
    sessionId: string,
    type: T,
    payload: Extract<PulseEvent, { type: T }>['payload']
  ): Extract<PulseEvent, { type: T }> {
    return {
      version: '1.0',
      type,
      sessionId,
      eventId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      correlationId: crypto.randomUUID(),
      payload
    } as Extract<PulseEvent, { type: T }>;
  }

  private hasConnectedPhone(): boolean {
    return [...this.sockets].some((socket) => socket.readyState === socket.OPEN);
  }

  private broadcast(event: PulseEvent): void {
    const message = JSON.stringify(event);
    for (const socket of this.sockets) if (socket.readyState === socket.OPEN) socket.send(message);
  }
}
