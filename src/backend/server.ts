import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { z } from 'zod';
import { WebSocketServer, type WebSocket } from 'ws';
import { loadRuntimeConfig, type RuntimeConfig } from '../config.js';
import { pulseEventSchema, type EventAcknowledgement } from '../contracts/events.js';
import { sessionStatusSchema } from '../contracts/domain.js';
import { sessionSearchInputSchema } from '../contracts/session-search.js';
import { backendHapticRequestSchema, backendWhisperRequestSchema } from '../contracts/interventions.js';
import { currentStressResponseSchema, currentVitalsResponseSchema } from '../contracts/vitals-resources.js';
import { localHealth } from '../health.js';
import { StructuredLogger } from '../observability/logger.js';
import { EventStore } from './event-store.js';
import { DeviceActions } from './device-actions.js';
import { copilotAdviceInputSchema, pendingCopilotResponseSchema } from '../contracts/copilot.js';

const MAX_BODY_BYTES = 1_000_000;
const VITAL_STALE_AFTER_MS = 10_000;

export interface Backend {
  server: Server;
  store: EventStore;
  logger: StructuredLogger;
  websocketServer: WebSocketServer;
  deviceActions: DeviceActions;
}

export function createBackend(config: RuntimeConfig = loadRuntimeConfig()): Backend {
  const logger = new StructuredLogger('backend', config.LOG_LEVEL);
  const store = new EventStore(logger, config.DATABASE_PATH);
  const deviceActions = new DeviceActions(store, config, logger);
  const websocketServer = new WebSocketServer({ noServer: true });
  const server = createServer(async (request, response) => {
    try {
      await route(request, response, store, deviceActions, config, logger);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown backend error';
      logger.error('Request failed', { boundary: 'http', error: message });
      sendJson(response, error instanceof SyntaxError || error instanceof z.ZodError ? 400 : 409, {
        error: message
      });
    }
  });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://pulse.local');
    if (url.pathname !== '/v1/session-stream') {
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer.emit('connection', websocket, request);
    });
  });
  websocketServer.on('connection', (socket) => {
    deviceActions.addSocket(socket);
    handleSessionStream(socket, store, deviceActions, config, logger);
  });
  server.on('close', () => {
    deviceActions.close();
    store.close();
  });
  return { server, store, logger, websocketServer, deviceActions };
}

function handleSessionStream(
  socket: WebSocket,
  store: EventStore,
  deviceActions: DeviceActions,
  config: RuntimeConfig,
  logger: StructuredLogger
): void {
  logger.info('Persistent session connection opened', { boundary: 'phone_to_backend_stream' });
  socket.on('message', (data) => {
    const raw = data.toString();
    try {
      const event = pulseEventSchema.parse(JSON.parse(raw));
      logger.info('WebSocket boundary received', {
        boundary: 'phone_to_backend_stream',
        sessionId: event.sessionId,
        eventId: event.eventId,
        correlationId: event.correlationId,
        eventType: event.type
      });
      deviceActions.beforeIngest(event);
      if (event.type === 'advice_requested' && !config.COPILOT_ENABLED) {
        socket.send(JSON.stringify(disabledCopilotAcknowledgement(event.eventId)));
        return;
      }
      const acknowledgement = store.ingest(event);
      deviceActions.afterIngest(event, acknowledgement.duplicate);
      socket.send(JSON.stringify(acknowledgement));
    } catch (error) {
      const acknowledgement: EventAcknowledgement = {
        eventId: eventIdFrom(raw),
        accepted: false,
        duplicate: false,
        receivedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Invalid event'
      };
      socket.send(JSON.stringify(acknowledgement));
    }
  });
  socket.on('close', () => logger.info('Persistent session connection closed', {
    boundary: 'phone_to_backend_stream'
  }));
}

function eventIdFrom(raw: string): string {
  try {
    const value = JSON.parse(raw) as { eventId?: unknown };
    return typeof value.eventId === 'string' && value.eventId.length > 0 ? value.eventId : 'unknown';
  } catch {
    return 'unknown';
  }
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  store: EventStore,
  deviceActions: DeviceActions,
  config: RuntimeConfig,
  logger: StructuredLogger
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://pulse.local');
  if (request.method === 'GET' && url.pathname === '/health') {
    const health = localHealth('backend', config);
    sendJson(response, health.status === 'unavailable' ? 503 : 200, health);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/events') {
    const event = pulseEventSchema.parse(await readJson(request));
    logger.info('HTTP boundary received', {
      boundary: 'phone_to_backend',
      sessionId: event.sessionId,
      eventId: event.eventId,
      correlationId: event.correlationId,
      eventType: event.type
    });
    deviceActions.beforeIngest(event);
    if (event.type === 'advice_requested' && !config.COPILOT_ENABLED) {
      sendJson(response, 202, disabledCopilotAcknowledgement(event.eventId));
      return;
    }
    const acknowledgement = store.ingest(event);
    deviceActions.afterIngest(event, acknowledgement.duplicate);
    sendJson(response, 202, acknowledgement);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/v1/sessions/current/transcript') {
    const session = store.getCurrentSession();
    if (!session) {
      sendJson(response, 200, { session: null, segments: [] });
      return;
    }
    sendJson(response, 200, {
      session,
      segments: store.getTranscriptSegments(session.sessionId).slice(-100)
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/v1/sessions/current/vitals') {
    const session = requireReadableCurrentSession(store);
    const samples = store.getVitalSamples(session.sessionId);
    const latest = samples.at(-1) ?? null;
    const observedAt = store.getLatestVitalObservedAt(session.sessionId);
    const ageMs = observedAt ? Math.max(0, Date.now() - Date.parse(observedAt)) : null;
    sendJson(response, 200, currentVitalsResponseSchema.parse({
      session,
      consentAllowed: store.hasActiveConsent(session.sessionId, 'read:vitals'),
      latest,
      freshness: observedAt && ageMs !== null ? {
        status: ageMs > VITAL_STALE_AFTER_MS ? 'stale' : 'live',
        observedAt,
        ageMs,
        staleAfterMs: VITAL_STALE_AFTER_MS
      } : null,
      window: samples.slice(-30)
    }));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/v1/sessions/current/stress') {
    const session = requireReadableCurrentSession(store);
    const stressSignal = store.getStressSignal(session.sessionId);
    sendJson(response, 200, currentStressResponseSchema.parse({
      session,
      consentAllowed: store.hasActiveConsent(session.sessionId, 'read:vitals'),
      signal: withoutEvidence(stressSignal)
    }));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/v1/transcripts/latest') {
    const latest = store.getLatestTranscript();
    sendJson(response, 200, latest ?? { session: null, segment: null });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/v1/sessions/current/speech-metrics') {
    const session = store.getCurrentSession();
    if (!session) {
      sendJson(response, 200, { session: null, metrics: null });
      return;
    }
    sendJson(response, 200, { session, metrics: store.getSpeechMetrics(session.sessionId) });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/v1/sessions/current/context') {
    const session = store.getCurrentSession();
    if (!session) {
      sendJson(response, 200, { session: null, context: null, consentAllowed: false, evidenceIds: null });
      return;
    }
    const context = store.getContext(session.sessionId) ?? null;
    sendJson(response, 200, {
      session,
      context,
      consentAllowed: store.hasActiveConsent(session.sessionId, 'read:context'),
      evidenceIds: context ? {
        situation: 'context:situation',
        goals: context.goals.map((_, index) => `context:goal:${index}`)
      } : null
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/v1/copilot/requests/pending') {
    sendJson(response, 200, pendingCopilotResponseSchema.parse(deviceActions.claimCopilotRequest()));
    return;
  }

  const copilotAdviceMatch = url.pathname.match(/^\/v1\/copilot\/requests\/([^/]+)\/advice$/);
  if (request.method === 'POST' && copilotAdviceMatch) {
    const body = await readJson(request);
    const input = copilotAdviceInputSchema.extend({
      requestingAgentId: z.string().min(1).max(128),
      expectedSessionId: z.string().min(1).max(128).optional()
    }).strict().parse({
      ...(typeof body === 'object' && body !== null ? body : {}),
      requestId: decodeURIComponent(copilotAdviceMatch[1])
    });
    sendJson(response, 200, deviceActions.copilotAdvice(input));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/sessions/search') {
    const input = sessionSearchInputSchema.parse(await readJson(request));
    sendJson(response, 200, store.searchSessions(input));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/sessions/current/interventions/haptic') {
    const input = backendHapticRequestSchema.parse(await readJson(request));
    sendJson(response, 200, deviceActions.haptic(input));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/sessions/current/interventions/whisper') {
    const input = backendWhisperRequestSchema.parse(await readJson(request));
    sendJson(response, 200, deviceActions.whisper(input));
    return;
  }

  const transcriptMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/transcript$/);
  if (request.method === 'GET' && transcriptMatch) {
    const sessionId = decodeURIComponent(transcriptMatch[1]);
    const session = store.getSession(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    sendJson(response, 200, { session, segments: store.getTranscriptSegments(sessionId) });
    return;
  }

  const eventMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/events$/);
  if (request.method === 'GET' && eventMatch) {
    const sessionId = decodeURIComponent(eventMatch[1]);
    if (!store.getSession(sessionId)) throw new Error(`Unknown session: ${sessionId}`);
    sendJson(response, 200, { sessionId, events: store.getEvents(sessionId) });
    return;
  }

  const interventionsMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/interventions$/);
  if (request.method === 'GET' && interventionsMatch) {
    const sessionId = decodeURIComponent(interventionsMatch[1]);
    if (!store.getSession(sessionId)) throw new Error(`Unknown session: ${sessionId}`);
    sendJson(response, 200, { sessionId, interventions: store.getInterventions(sessionId) });
    return;
  }

  const vitalsMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/vitals$/);
  if (request.method === 'GET' && vitalsMatch) {
    const sessionId = decodeURIComponent(vitalsMatch[1]);
    if (!store.getSession(sessionId)) throw new Error(`Unknown session: ${sessionId}`);
    const samples = store.getVitalSamples(sessionId);
    sendJson(response, 200, {
      sessionId,
      samples,
      latest: samples.at(-1) ?? null
    });
    return;
  }

  const stressEventsMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/stress-events$/);
  if (request.method === 'GET' && stressEventsMatch) {
    const sessionId = decodeURIComponent(stressEventsMatch[1]);
    if (!store.getSession(sessionId)) throw new Error(`Unknown session: ${sessionId}`);
    sendJson(response, 200, { sessionId, transitions: store.getStressTransitions(sessionId) });
    return;
  }

  const reportMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/report$/);
  if (request.method === 'GET' && reportMatch) {
    const sessionId = decodeURIComponent(reportMatch[1]);
    const report = store.getSessionReport(sessionId);
    if (!report) throw new Error(`Unknown session: ${sessionId}`);
    sendJson(response, 200, report);
    return;
  }

  const transitionMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/status$/);
  if (request.method === 'PATCH' && transitionMatch) {
    const sessionId = decodeURIComponent(transitionMatch[1]);
    const input = z.object({ status: sessionStatusSchema }).strict().parse(await readJson(request));
    sendJson(response, 200, store.transition(sessionId, input.status));
    return;
  }

  sendJson(response, 404, { error: `Route not found: ${request.method} ${url.pathname}` });
}

function withoutEvidence<T extends { evidence?: unknown }>(signal: T | undefined): Omit<T, 'evidence'> | null {
  if (signal === undefined) return null;
  const { evidence: _evidence, ...publicSignal } = signal;
  return publicSignal;
}
function requireReadableCurrentSession(store: EventStore) {
  const session = store.getCurrentSession();
  if (!session) throw new Error('No current session');
  if (session.status !== 'calibrating' && session.status !== 'active') {
    throw new Error(`Current session is not readable: ${session.sessionId} (${session.status})`);
  }
  return session;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error('Request body exceeds 1 MB');
    chunks.push(buffer);
  }
  if (chunks.length === 0) throw new SyntaxError('A JSON request body is required');
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(value));
}

function disabledCopilotAcknowledgement(eventId: string): EventAcknowledgement {
  return {
    eventId,
    accepted: true,
    duplicate: false,
    receivedAt: new Date().toISOString(),
    error: null
  };
}
