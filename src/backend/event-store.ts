import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { ConsentGrant, ConsentScope, Intervention, Session, SessionContext, SpeechMetricSnapshot, StressSignal, TranscriptSegment, VitalSample } from '../contracts/domain.js';
import { interventionSchema, sessionContextSchema, sessionSchema, speechMetricSnapshotSchema, transcriptSegmentSchema, vitalSampleSchema } from '../contracts/domain.js';
import type { InterventionActionResponse } from '../contracts/interventions.js';
import type { EventAcknowledgement, PulseEvent } from '../contracts/events.js';
import { pulseEventSchema } from '../contracts/events.js';
import type { SessionSearchInput, SessionSearchResponse } from '../contracts/session-search.js';
import type { StressTransition } from '../contracts/vitals-resources.js';
import { stressSignalSchema } from '../contracts/domain.js';
import { stressTransitionSchema } from '../contracts/vitals-resources.js';
import { assertSessionTransition } from '../contracts/lifecycle.js';
import type { StructuredLogger } from '../observability/logger.js';
import { deriveStressTimeline } from './stress-engine.js';
import { deriveSpeechMetrics } from './speech-metrics.js';
import { deriveSessionReport } from './session-report.js';
import type { SessionReport } from '../contracts/session-report.js';
import { copilotRequestSchema, type CopilotRequest, type CopilotState } from '../contracts/copilot.js';

interface JsonRow { json: string }
interface SearchRow { session_json: string; transcript_excerpt: string; rank: number }
interface InterventionRow extends JsonRow { command_id: string; idempotency_key: string; expires_at: string | null; dispatched_at: string | null; pattern: string | null }
interface CopilotRow extends JsonRow { source_event_id: string }

export interface PendingIntervention {
  intervention: Intervention;
  commandId: string;
  expiresAt: string | null;
  dispatchedAt: string | null;
  pattern: 'single' | 'double' | 'breathing' | null;
}

export class EventStore {
  private readonly database: Database.Database;

  constructor(private readonly logger: StructuredLogger, databasePath = ':memory:') {
    if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new Database(databasePath);
    this.database.pragma('foreign_keys = ON');
    this.database.pragma('busy_timeout = 5000');
    this.database.pragma('journal_mode = WAL');
    this.migrate();
  }

  ingest(event: PulseEvent): EventAcknowledgement {
    if (this.database.prepare('SELECT 1 FROM events WHERE event_id = ?').get(event.eventId)) {
      this.logger.info('Duplicate event ignored', this.logContext(event));
      return this.acknowledge(event, true);
    }

    this.database.transaction(() => {
      this.applySessionRules(event);
      this.database.prepare(`
        INSERT INTO events (event_id, session_id, type, timestamp, correlation_id, json)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(event.eventId, event.sessionId, event.type, event.timestamp, event.correlationId, JSON.stringify(event));

      if (event.type === 'vital_sample_received') {
        this.database.prepare(`
          INSERT INTO vital_samples (event_id, session_id, session_elapsed_ms, device_timestamp, json)
          VALUES (?, ?, ?, ?, ?)
        `).run(event.eventId, event.sessionId, event.payload.sessionElapsedMs,
          event.payload.deviceTimestamp, JSON.stringify(event.payload));
        this.rebuildStressTimeline(event.sessionId);
        this.persistSpeechMetrics(event.sessionId);
      }
      if (event.type === 'transcript_segment_received' && event.payload.isFinal) {
        this.database.prepare(`
          INSERT INTO transcript_segments (event_id, segment_id, session_id, start_ms, end_ms, json)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(event.eventId, event.payload.segmentId, event.sessionId, event.payload.startMs,
          event.payload.endMs, JSON.stringify(event.payload));
        this.database.prepare(`
          INSERT INTO transcript_search (session_id, segment_id, text) VALUES (?, ?, ?)
        `).run(event.sessionId, event.payload.segmentId, event.payload.text);
        this.persistSpeechMetrics(event.sessionId);
      }
      if (event.type === 'session_context_updated') {
        this.storeContext(event.payload);
        this.rebuildStressTimeline(event.sessionId);
      }
      if (event.type === 'consent_updated') {
        this.database.prepare(`
          INSERT INTO consent_grants (grant_id, session_id, scope, granted_at, revoked_at, json)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(grant_id) DO UPDATE SET revoked_at = excluded.revoked_at, json = excluded.json
        `).run(event.payload.grantId, event.sessionId, event.payload.scope, event.payload.grantedAt,
          event.payload.revokedAt, JSON.stringify(event.payload));
        if (event.payload.revokedAt !== null && event.payload.scope === 'act:audio') {
          this.cancelPendingInterventions(event.sessionId, 'whisper_coach', event.payload.revokedAt);
        }
        if (event.payload.revokedAt !== null && event.payload.scope === 'act:haptic') {
          this.cancelPendingInterventions(event.sessionId, 'haptic_nudge', event.payload.revokedAt);
        }
      }
      if (event.type === 'playback_completed' || event.type === 'haptic_completed') {
        this.completeCommand(event.payload.commandId, event.payload.result, event.timestamp, event.eventId);
      }
      if (event.type === 'session_ended') this.persistSpeechMetrics(event.sessionId);
    })();

    this.logger.info('Boundary event accepted', this.logContext(event));
    return this.acknowledge(event, false);
  }

  getEvents(sessionId: string): readonly PulseEvent[] {
    return (this.database.prepare('SELECT json FROM events WHERE session_id = ? ORDER BY rowid').all(sessionId) as JsonRow[])
      .map(({ json }) => pulseEventSchema.parse(JSON.parse(json)));
  }

  getSession(sessionId: string): Session | undefined {
    const row = this.database.prepare('SELECT json FROM sessions WHERE session_id = ?').get(sessionId) as JsonRow | undefined;
    return row ? sessionSchema.parse(JSON.parse(row.json)) : undefined;
  }

  getVitalSamples(sessionId: string): readonly VitalSample[] {
    return (this.database.prepare(`
      SELECT json FROM vital_samples WHERE session_id = ? ORDER BY session_elapsed_ms, device_timestamp
    `).all(sessionId) as JsonRow[]).map(({ json }) => vitalSampleSchema.parse(JSON.parse(json)));
  }

  getLatestVitalObservedAt(sessionId: string): string | undefined {
    const row = this.database.prepare(`
      SELECT e.timestamp AS observed_at
      FROM vital_samples v JOIN events e ON e.event_id = v.event_id
      WHERE v.session_id = ? ORDER BY v.session_elapsed_ms DESC, v.device_timestamp DESC LIMIT 1
    `).get(sessionId) as { observed_at: string } | undefined;
    return row?.observed_at;
  }

  getStressSignal(sessionId: string): StressSignal | undefined {
    return deriveStressTimeline(
      sessionId,
      this.getVitalSamples(sessionId),
      this.getContext(sessionId)?.stressSensitivity
    ).signal;
  }

  getStressTransitions(sessionId: string): readonly StressTransition[] {
    return (this.database.prepare(`
      SELECT json FROM stress_signal_events WHERE session_id = ? ORDER BY occurred_at_ms, rowid
    `).all(sessionId) as JsonRow[]).map(({ json }) => stressTransitionSchema.parse(JSON.parse(json)));
  }

  hasActiveConsent(sessionId: string, scope: ConsentScope, at = new Date()): boolean {
    const rows = this.database.prepare(`
      SELECT json FROM consent_grants WHERE session_id = ? AND scope = ?
    `).all(sessionId, scope) as JsonRow[];
    return rows.some(({ json }) => {
      const grant = JSON.parse(json) as ConsentGrant;
      return new Date(grant.grantedAt) <= at && (grant.revokedAt === null || new Date(grant.revokedAt) > at);
    });
  }

  createIntervention(input: {
    sessionId: string;
    type: 'haptic_nudge' | 'whisper_coach' | 'copilot_advice';
    idempotencyKey: string;
    requestingAgentId: string;
    triggerEvidenceIds: string[];
    generatedMessage: string | null;
    pattern?: 'single' | 'double' | 'breathing';
    expiresAt?: string;
  }): InterventionActionResponse {
    const existing = this.getInterventionByKey(input.sessionId, input.type, input.idempotencyKey);
    if (existing) return { intervention: existing.intervention, commandId: existing.commandId, duplicate: true };

    const requestedAt = new Date().toISOString();
    const intervention: Intervention = interventionSchema.parse({
      interventionId: crypto.randomUUID(),
      sessionId: input.sessionId,
      type: input.type,
      triggerEvidenceIds: input.triggerEvidenceIds,
      requestingAgentId: input.requestingAgentId,
      generatedMessage: input.generatedMessage,
      requestedAt,
      queuedAt: input.type === 'haptic_nudge' ? null : requestedAt,
      playedAt: null,
      dismissedAt: null,
      deliveryResult: 'pending'
    });
    const commandId = crypto.randomUUID();
    this.database.prepare(`
      INSERT INTO interventions
        (intervention_id, session_id, type, idempotency_key, command_id, expires_at, dispatched_at, pattern, json)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(intervention.interventionId, input.sessionId, input.type, input.idempotencyKey, commandId,
      input.expiresAt ?? null, input.pattern ?? null, JSON.stringify(intervention));
    return { intervention, commandId, duplicate: false };
  }

  getPendingInterventions(type?: 'haptic_nudge' | 'whisper_coach'): readonly PendingIntervention[] {
    const rows = this.database.prepare(`
      SELECT json, command_id, idempotency_key, expires_at, dispatched_at, pattern
      FROM interventions
      WHERE json_extract(json, '$.deliveryResult') = 'pending'
        ${type ? 'AND type = ?' : ''}
      ORDER BY rowid
    `).all(...(type ? [type] : [])) as InterventionRow[];
    return rows.map((row) => this.pendingFromRow(row));
  }

  getPendingAudioInterventions(): readonly PendingIntervention[] {
    const rows = this.database.prepare(`
      SELECT json, command_id, idempotency_key, expires_at, dispatched_at, pattern
      FROM interventions
      WHERE json_extract(json, '$.deliveryResult') = 'pending'
        AND type IN ('whisper_coach', 'copilot_advice')
      ORDER BY rowid
    `).all() as InterventionRow[];
    return rows.map((row) => this.pendingFromRow(row));
  }

  createCopilotRequest(input: {
    requestId: string;
    sessionId: string;
    sourceEventId: string;
    requestedAt: string;
  }): { request: CopilotRequest; duplicate: boolean } {
    const exact = this.getCopilotRequest(input.requestId);
    if (exact) return { request: exact, duplicate: true };
    const active = this.getActiveCopilotRequest(input.sessionId);
    if (active) return { request: active, duplicate: true };
    const request = copilotRequestSchema.parse({
      ...input,
      updatedAt: input.requestedAt,
      state: 'requested',
      advice: null,
      commandId: null
    });
    this.database.prepare(`
      INSERT INTO copilot_requests (request_id, session_id, source_event_id, state, command_id, json)
      VALUES (?, ?, ?, ?, NULL, ?)
    `).run(request.requestId, request.sessionId, request.sourceEventId, request.state, JSON.stringify(request));
    return { request, duplicate: false };
  }

  getCopilotRequest(requestId: string): CopilotRequest | undefined {
    const row = this.database.prepare('SELECT json, source_event_id FROM copilot_requests WHERE request_id = ?')
      .get(requestId) as CopilotRow | undefined;
    return row ? copilotRequestSchema.parse(JSON.parse(row.json)) : undefined;
  }

  getActiveCopilotRequest(sessionId: string): CopilotRequest | undefined {
    const row = this.database.prepare(`
      SELECT json, source_event_id FROM copilot_requests
      WHERE session_id = ? AND state IN ('requested', 'thinking', 'queued', 'playing')
      ORDER BY rowid LIMIT 1
    `).get(sessionId) as CopilotRow | undefined;
    return row ? copilotRequestSchema.parse(JSON.parse(row.json)) : undefined;
  }

  getRequestedCopilotRequest(): CopilotRequest | undefined {
    const row = this.database.prepare(`
      SELECT json, source_event_id FROM copilot_requests WHERE state = 'requested' ORDER BY rowid LIMIT 1
    `).get() as CopilotRow | undefined;
    return row ? copilotRequestSchema.parse(JSON.parse(row.json)) : undefined;
  }

  getCopilotRequestByCommand(commandId: string): CopilotRequest | undefined {
    const row = this.database.prepare('SELECT json, source_event_id FROM copilot_requests WHERE command_id = ?')
      .get(commandId) as CopilotRow | undefined;
    return row ? copilotRequestSchema.parse(JSON.parse(row.json)) : undefined;
  }

  updateCopilotRequest(
    requestId: string,
    state: CopilotState,
    fields: { advice?: string; commandId?: string } = {},
    at = new Date().toISOString()
  ): CopilotRequest {
    const current = this.getCopilotRequest(requestId);
    if (!current) throw new Error(`Unknown copilot request: ${requestId}`);
    const updated = copilotRequestSchema.parse({
      ...current,
      state,
      updatedAt: at,
      advice: fields.advice ?? current.advice,
      commandId: fields.commandId ?? current.commandId
    });
    this.database.prepare('UPDATE copilot_requests SET state = ?, command_id = ?, json = ? WHERE request_id = ?')
      .run(updated.state, updated.commandId, JSON.stringify(updated), requestId);
    return updated;
  }

  getInterventionByCommand(commandId: string): PendingIntervention | undefined {
    const row = this.database.prepare(`
      SELECT json, command_id, idempotency_key, expires_at, dispatched_at, pattern
      FROM interventions WHERE command_id = ?
    `).get(commandId) as InterventionRow | undefined;
    return row ? this.pendingFromRow(row) : undefined;
  }

  getConversationSilenceMs(sessionId: string, nowEpochMs = Date.now()): number {
    const session = this.getSession(sessionId);
    if (!session?.startedAt) return 0;
    const latestEndMs = this.getTranscriptSegments(sessionId)
      .filter(({ speaker }) => speaker !== 'agent')
      .reduce((latest, segment) => Math.max(latest, segment.endMs), 0);
    const elapsedMs = Math.max(0, nowEpochMs - Date.parse(session.startedAt));
    return Math.max(0, elapsedMs - latestEndMs);
  }

  markInterventionDispatched(commandId: string, at = new Date().toISOString()): void {
    this.database.prepare('UPDATE interventions SET dispatched_at = ? WHERE command_id = ? AND dispatched_at IS NULL')
      .run(at, commandId);
  }

  completeCommand(commandId: string, result: 'played' | 'delivered' | 'cancelled' | 'failed', at: string, eventId?: string): Intervention | undefined {
    const row = this.database.prepare(`
      SELECT json, command_id, idempotency_key, expires_at, dispatched_at, pattern
      FROM interventions WHERE command_id = ?
    `).get(commandId) as InterventionRow | undefined;
    if (!row) return undefined;
    const current = interventionSchema.parse(JSON.parse(row.json));
    if (current.deliveryResult !== 'pending') return current;
    const delivered = result === 'played' || result === 'delivered';
    const updated = interventionSchema.parse({
      ...current,
      playedAt: delivered ? at : null,
      dismissedAt: result === 'cancelled' ? at : null,
      deliveryResult: delivered ? 'delivered' : result
    });
    this.database.prepare('UPDATE interventions SET json = ? WHERE command_id = ?').run(JSON.stringify(updated), commandId);
    if (delivered && current.type === 'whisper_coach' && current.generatedMessage && eventId) {
      this.storeAgentTranscript(updated, current.generatedMessage, at, eventId);
    }
    return updated;
  }

  expireIntervention(commandId: string, at = new Date().toISOString()): Intervention | undefined {
    const row = this.database.prepare('SELECT json FROM interventions WHERE command_id = ?').get(commandId) as JsonRow | undefined;
    if (!row) return undefined;
    const current = interventionSchema.parse(JSON.parse(row.json));
    if (current.deliveryResult !== 'pending') return current;
    const updated = interventionSchema.parse({ ...current, dismissedAt: at, deliveryResult: 'expired' });
    this.database.prepare('UPDATE interventions SET json = ? WHERE command_id = ?').run(JSON.stringify(updated), commandId);
    return updated;
  }

  getInterventions(sessionId: string): readonly Intervention[] {
    return (this.database.prepare('SELECT json FROM interventions WHERE session_id = ? ORDER BY rowid').all(sessionId) as JsonRow[])
      .map(({ json }) => interventionSchema.parse(JSON.parse(json)));
  }

  getTranscriptSegments(sessionId: string): readonly TranscriptSegment[] {
    return (this.database.prepare(`
      SELECT json FROM transcript_segments WHERE session_id = ? ORDER BY start_ms, segment_id
    `).all(sessionId) as JsonRow[]).map(({ json }) => transcriptSegmentSchema.parse(JSON.parse(json)));
  }

  getLatestTranscript(): { session: Session; segment: TranscriptSegment } | undefined {
    const row = this.database.prepare(`
      SELECT s.json AS session_json, t.json AS segment_json
      FROM transcript_segments t
      JOIN events e ON e.event_id = t.event_id
      JOIN sessions s ON s.session_id = t.session_id
      ORDER BY e.rowid DESC LIMIT 1
    `).get() as { session_json: string; segment_json: string } | undefined;
    return row ? {
      session: sessionSchema.parse(JSON.parse(row.session_json)),
      segment: transcriptSegmentSchema.parse(JSON.parse(row.segment_json))
    } : undefined;
  }

  getSpeechMetrics(sessionId: string, nowEpochMs = Date.now()): SpeechMetricSnapshot | undefined {
    const session = this.getSession(sessionId);
    return session ? deriveSpeechMetrics(session, this.getTranscriptSegments(sessionId), nowEpochMs) : undefined;
  }

  getPersistedSpeechMetrics(sessionId: string): SpeechMetricSnapshot | undefined {
    const row = this.database.prepare('SELECT json FROM speech_metric_snapshots WHERE session_id = ?')
      .get(sessionId) as JsonRow | undefined;
    return row ? speechMetricSnapshotSchema.parse(JSON.parse(row.json)) : undefined;
  }

  getSessionReport(sessionId: string): SessionReport | undefined {
    const session = this.getSession(sessionId);
    if (!session) return undefined;
    const metrics = this.getPersistedSpeechMetrics(sessionId) ?? this.deriveStoredSpeechMetrics(session);
    return deriveSessionReport({
      session,
      vitals: this.getVitalSamples(sessionId),
      transitions: this.getStressTransitions(sessionId),
      segments: this.getTranscriptSegments(sessionId),
      metrics
    });
  }

  getContext(sessionId: string): SessionContext | undefined {
    const row = this.database.prepare('SELECT json FROM session_contexts WHERE session_id = ?').get(sessionId) as JsonRow | undefined;
    return row ? sessionContextSchema.parse(JSON.parse(row.json)) : undefined;
  }

  hasCopilotEvidence(sessionId: string, evidenceId: string): boolean {
    if (evidenceId === 'speech-metrics:current') return this.getSpeechMetrics(sessionId) !== undefined;
    if (evidenceId === 'stress:current') return this.getStressSignal(sessionId) !== undefined;
    if (evidenceId === 'vitals:current') return this.getVitalSamples(sessionId).length > 0;
    if (evidenceId === 'context:situation') return this.getContext(sessionId) !== undefined;
    const goal = evidenceId.match(/^context:goal:(\d+)$/);
    if (goal) return this.getContext(sessionId)?.goals[Number(goal[1])] !== undefined;
    return this.getTranscriptSegments(sessionId).some(({ segmentId }) => segmentId === evidenceId);
  }

  getCurrentSession(): Session | undefined {
    const row = this.database.prepare(`
      SELECT json FROM sessions
      WHERE status IN ('calibrating', 'active', 'ending')
      ORDER BY started_at DESC, rowid DESC LIMIT 1
    `).get() as JsonRow | undefined;
    return row ? sessionSchema.parse(JSON.parse(row.json)) : undefined;
  }

  searchSessions(input: SessionSearchInput): SessionSearchResponse {
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    let from = 'sessions s';
    let excerpt = `COALESCE((
      SELECT json_extract(t.json, '$.text') FROM transcript_segments t
      WHERE t.session_id = s.session_id ORDER BY t.start_ms DESC LIMIT 1
    ), '')`;
    let rank = '0';

    if (input.query) {
      from = 'transcript_search f JOIN sessions s ON s.session_id = f.session_id';
      clauses.push('transcript_search MATCH ?');
      parameters.push(toFtsQuery(input.query));
      rank = 'bm25(transcript_search)';
      excerpt = `snippet(transcript_search, 2, '[', ']', '...', 24)`;
    }
    if (input.startedAfter) {
      clauses.push('s.started_at >= ?');
      parameters.push(input.startedAfter);
    }
    if (input.startedBefore) {
      clauses.push('s.started_at <= ?');
      parameters.push(input.startedBefore);
    }
    if (input.status) {
      clauses.push('s.status = ?');
      parameters.push(input.status);
    }
    parameters.push(input.query ? input.limit * 20 : input.limit);

    const rows = this.database.prepare(`
      SELECT s.json AS session_json, ${excerpt} AS transcript_excerpt, ${rank} AS rank
      FROM ${from}
      WHERE ${clauses.join(' AND ')}
      ORDER BY rank, s.started_at DESC
      LIMIT ?
    `).all(...parameters) as SearchRow[];

    const seen = new Set<string>();
    const results = rows.flatMap((row) => {
      const session = sessionSchema.parse(JSON.parse(row.session_json));
      if (seen.has(session.sessionId)) return [];
      seen.add(session.sessionId);
      return [{ session, transcriptExcerpt: row.transcript_excerpt, rank: row.rank }];
    }).slice(0, input.limit);
    return { results };
  }

  transition(sessionId: string, status: Session['status']): Session {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    assertSessionTransition(session.status, status);
    const updated: Session = {
      ...session,
      status,
      endedAt: status === 'completed' || status === 'failed' ? new Date().toISOString() : session.endedAt
    };
    this.updateSession(updated);
    return updated;
  }

  close(): void {
    if (this.database.open) this.database.close();
  }

  private applySessionRules(event: PulseEvent): void {
    if (event.type === 'session_started') {
      if (event.payload.session.sessionId !== event.sessionId) {
        throw new Error('Envelope and payload session IDs do not match');
      }
      if (this.getSession(event.sessionId)) throw new Error(`Session already exists: ${event.sessionId}`);
      this.insertSession(event.payload.session);
      return;
    }

    const session = this.getSession(event.sessionId);
    if (!session) throw new Error(`Unknown session: ${event.sessionId}`);
    if (session.status === 'completed' || session.status === 'failed') {
      throw new Error(`Session is terminal: ${event.sessionId} (${session.status})`);
    }
    if ('sessionId' in event.payload && event.payload.sessionId !== event.sessionId) {
      throw new Error('Envelope and payload session IDs do not match');
    }
    if (event.type === 'session_ended') {
      if (session.status !== 'ending') assertSessionTransition(session.status, 'ending');
      this.updateSession({
        ...session,
        status: event.payload.reason === 'failure' ? 'failed' : 'completed',
        endedAt: event.payload.endedAt
      });
    }
  }

  private insertSession(session: Session): void {
    this.database.prepare(`
      INSERT INTO sessions (session_id, status, started_at, ended_at, json) VALUES (?, ?, ?, ?, ?)
    `).run(session.sessionId, session.status, session.startedAt, session.endedAt, JSON.stringify(session));
  }

  private updateSession(session: Session): void {
    this.database.prepare(`
      UPDATE sessions SET status = ?, started_at = ?, ended_at = ?, json = ? WHERE session_id = ?
    `).run(session.status, session.startedAt, session.endedAt, JSON.stringify(session), session.sessionId);
  }

  private storeContext(context: SessionContext): void {
    const participants = context.participants.map(({ name, role }) => `${name} ${role}`).join(' ');
    const goals = context.goals.join(' ');
    const topics = context.topicsToAvoid.join(' ');
    this.database.prepare(`
      INSERT INTO session_contexts
        (session_id, wearer_summary, situation, participants_text, goals_text, topics_text, json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        wearer_summary = excluded.wearer_summary,
        situation = excluded.situation,
        participants_text = excluded.participants_text,
        goals_text = excluded.goals_text,
        topics_text = excluded.topics_text,
        json = excluded.json
    `).run(context.sessionId, context.wearerSummary, context.situation, participants, goals, topics, JSON.stringify(context));
    this.database.prepare('DELETE FROM context_search WHERE session_id = ?').run(context.sessionId);
    this.database.prepare(`
      INSERT INTO context_search (session_id, wearer_summary, situation, participants, goals, topics)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(context.sessionId, context.wearerSummary, context.situation, participants, goals, topics);
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        started_at TEXT,
        ended_at TEXT,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_session_idx ON events(session_id, timestamp);
      CREATE TABLE IF NOT EXISTS vital_samples (
        event_id TEXT PRIMARY KEY REFERENCES events(event_id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        session_elapsed_ms INTEGER NOT NULL,
        device_timestamp TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS vitals_timeline_idx ON vital_samples(session_id, session_elapsed_ms);
      CREATE TABLE IF NOT EXISTS stress_signal_events (
        transition_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        occurred_at_ms INTEGER NOT NULL,
        state TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS stress_timeline_idx ON stress_signal_events(session_id, occurred_at_ms);
      CREATE TABLE IF NOT EXISTS transcript_segments (
        event_id TEXT PRIMARY KEY REFERENCES events(event_id) ON DELETE CASCADE,
        segment_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS transcript_timeline_idx ON transcript_segments(session_id, start_ms);
      CREATE TABLE IF NOT EXISTS session_contexts (
        session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
        wearer_summary TEXT NOT NULL,
        situation TEXT NOT NULL,
        participants_text TEXT NOT NULL,
        goals_text TEXT NOT NULL,
        topics_text TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS context_search USING fts5(
        session_id UNINDEXED, wearer_summary, situation, participants, goals, topics
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS transcript_search USING fts5(
        session_id UNINDEXED, segment_id UNINDEXED, text
      );
      CREATE TABLE IF NOT EXISTS consent_grants (
        grant_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        scope TEXT NOT NULL,
        granted_at TEXT NOT NULL,
        revoked_at TEXT,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS interventions (
        intervention_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        command_id TEXT NOT NULL UNIQUE,
        expires_at TEXT,
        dispatched_at TEXT,
        pattern TEXT,
        json TEXT NOT NULL,
        UNIQUE(session_id, type, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS interventions_session_idx ON interventions(session_id, type);
      CREATE TABLE IF NOT EXISTS copilot_requests (
        request_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        source_event_id TEXT NOT NULL UNIQUE REFERENCES events(event_id) ON DELETE CASCADE,
        state TEXT NOT NULL,
        command_id TEXT UNIQUE,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS copilot_requests_active_idx ON copilot_requests(session_id, state);
      CREATE TABLE IF NOT EXISTS speech_metric_snapshots (
        session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
        calculated_at_ms INTEGER NOT NULL,
        json TEXT NOT NULL
      );
      INSERT INTO transcript_search (session_id, segment_id, text)
      SELECT session_id, segment_id, json_extract(json, '$.text') FROM transcript_segments
      WHERE segment_id NOT IN (SELECT segment_id FROM transcript_search);
    `);
    const sessions = this.database.prepare('SELECT json FROM sessions').all() as JsonRow[];
    for (const { json } of sessions) {
      const session = sessionSchema.parse(JSON.parse(json));
      if (!this.getPersistedSpeechMetrics(session.sessionId)) this.persistSpeechMetrics(session.sessionId);
    }
  }

  private persistSpeechMetrics(sessionId: string): void {
    const session = this.getSession(sessionId);
    if (!session) return;
    const metrics = this.deriveStoredSpeechMetrics(session);
    this.database.prepare(`
      INSERT INTO speech_metric_snapshots (session_id, calculated_at_ms, json) VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        calculated_at_ms = excluded.calculated_at_ms,
        json = excluded.json
    `).run(sessionId, metrics.calculatedAtMs, JSON.stringify(metrics));
  }

  private deriveStoredSpeechMetrics(session: Session): SpeechMetricSnapshot {
    const segments = this.getTranscriptSegments(session.sessionId);
    const latestEvidenceMs = Math.max(
      segments.at(-1)?.endMs ?? 0,
      this.getVitalSamples(session.sessionId).at(-1)?.sessionElapsedMs ?? 0
    );
    const referenceEpochMs = session.endedAt
      ? Date.parse(session.endedAt)
      : session.startedAt
        ? Date.parse(session.startedAt) + latestEvidenceMs
        : 0;
    return deriveSpeechMetrics(session, segments, referenceEpochMs);
  }

  private rebuildStressTimeline(sessionId: string): void {
    const timeline = deriveStressTimeline(
      sessionId,
      this.getVitalSamples(sessionId),
      this.getContext(sessionId)?.stressSensitivity
    );
    this.database.prepare('DELETE FROM stress_signal_events WHERE session_id = ?').run(sessionId);
    const insert = this.database.prepare(`
      INSERT INTO stress_signal_events (transition_id, session_id, occurred_at_ms, state, json)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const transition of timeline.transitions) {
      stressSignalSchema.parse(transition.signal);
      insert.run(transition.transitionId, sessionId, transition.occurredAtMs,
        transition.state, JSON.stringify(transition));
    }
  }

  private acknowledge(event: PulseEvent, duplicate: boolean): EventAcknowledgement {
    return {
      eventId: event.eventId,
      accepted: true,
      duplicate,
      receivedAt: new Date().toISOString(),
      error: null
    };
  }

  private getInterventionByKey(sessionId: string, type: Intervention['type'], idempotencyKey: string): PendingIntervention | undefined {
    const row = this.database.prepare(`
      SELECT json, command_id, idempotency_key, expires_at, dispatched_at, pattern
      FROM interventions WHERE session_id = ? AND type = ? AND idempotency_key = ?
    `).get(sessionId, type, idempotencyKey) as InterventionRow | undefined;
    return row ? this.pendingFromRow(row) : undefined;
  }

  private pendingFromRow(row: InterventionRow): PendingIntervention {
    const pattern = row.pattern;
    if (pattern !== null && pattern !== 'single' && pattern !== 'double' && pattern !== 'breathing') {
      throw new Error(`Unknown stored haptic pattern: ${pattern}`);
    }
    return {
      intervention: interventionSchema.parse(JSON.parse(row.json)),
      commandId: row.command_id,
      expiresAt: row.expires_at,
      dispatchedAt: row.dispatched_at,
      pattern
    };
  }

  private cancelPendingInterventions(sessionId: string, type: 'haptic_nudge' | 'whisper_coach', at: string): void {
    const rows = this.database.prepare(`
      SELECT command_id FROM interventions
      WHERE session_id = ? AND type = ? AND json_extract(json, '$.deliveryResult') = 'pending'
    `).all(sessionId, type) as Array<{ command_id: string }>;
    for (const row of rows) this.completeCommand(row.command_id, 'cancelled', at);
    if (type === 'whisper_coach') {
      const copilotRows = this.database.prepare(`
        SELECT command_id FROM interventions
        WHERE session_id = ? AND type = 'copilot_advice' AND json_extract(json, '$.deliveryResult') = 'pending'
      `).all(sessionId) as Array<{ command_id: string }>;
      for (const row of copilotRows) this.completeCommand(row.command_id, 'cancelled', at);
    }
  }

  private storeAgentTranscript(intervention: Intervention, text: string, at: string, eventId: string): void {
    const session = this.getSession(intervention.sessionId);
    if (!session?.startedAt) return;
    const startMs = Math.max(0, Date.parse(at) - Date.parse(session.startedAt));
    const segment = transcriptSegmentSchema.parse({
      sessionId: intervention.sessionId,
      segmentId: `agent-${intervention.interventionId}`,
      speaker: 'agent',
      text,
      startMs,
      endMs: startMs,
      providerTimestamp: at,
      confidence: 1,
      isFinal: true
    });
    this.database.prepare(`
      INSERT OR IGNORE INTO transcript_segments (event_id, segment_id, session_id, start_ms, end_ms, json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(eventId, segment.segmentId, segment.sessionId, segment.startMs, segment.endMs, JSON.stringify(segment));
    this.database.prepare(`
      INSERT INTO transcript_search (session_id, segment_id, text)
      SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM transcript_search WHERE segment_id = ?)
    `).run(segment.sessionId, segment.segmentId, segment.text, segment.segmentId);
  }

  private logContext(event: PulseEvent) {
    return {
      boundary: 'event_ingress',
      sessionId: event.sessionId,
      eventId: event.eventId,
      correlationId: event.correlationId,
      eventType: event.type
    };
  }
}

function toFtsQuery(query: string): string {
  const terms = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (terms.length === 0) throw new Error('Search query must contain letters or numbers');
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' AND ');
}
