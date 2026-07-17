import type { EventAcknowledgement, PulseEvent } from '../contracts/events.js';
import type { Session } from '../contracts/domain.js';
import { assertSessionTransition } from '../contracts/lifecycle.js';
import type { StructuredLogger } from '../observability/logger.js';

export class EventStore {
  private readonly eventIds = new Set<string>();
  private readonly events = new Map<string, PulseEvent[]>();
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly logger: StructuredLogger) {}

  ingest(event: PulseEvent): EventAcknowledgement {
    if (this.eventIds.has(event.eventId)) {
      this.logger.info('Duplicate event ignored', this.logContext(event));
      return this.acknowledge(event, true);
    }

    this.applySessionRules(event);
    this.eventIds.add(event.eventId);
    this.events.set(event.sessionId, [...(this.events.get(event.sessionId) ?? []), event]);
    this.logger.info('Boundary event accepted', this.logContext(event));
    return this.acknowledge(event, false);
  }

  getEvents(sessionId: string): readonly PulseEvent[] {
    return this.events.get(sessionId) ?? [];
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  transition(sessionId: string, status: Session['status']): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    assertSessionTransition(session.status, status);
    const updated = {
      ...session,
      status,
      endedAt: status === 'completed' || status === 'failed' ? new Date().toISOString() : session.endedAt
    };
    this.sessions.set(sessionId, updated);
    return updated;
  }

  private applySessionRules(event: PulseEvent): void {
    if (event.type === 'session_started') {
      if (event.payload.session.sessionId !== event.sessionId) {
        throw new Error('Envelope and payload session IDs do not match');
      }
      if (this.sessions.has(event.sessionId)) throw new Error(`Session already exists: ${event.sessionId}`);
      this.sessions.set(event.sessionId, event.payload.session);
      return;
    }

    const session = this.sessions.get(event.sessionId);
    if (!session) throw new Error(`Unknown session: ${event.sessionId}`);
    if (session.status === 'completed' || session.status === 'failed') {
      throw new Error(`Session is terminal: ${event.sessionId} (${session.status})`);
    }
    if ('sessionId' in event.payload && event.payload.sessionId !== event.sessionId) {
      throw new Error('Envelope and payload session IDs do not match');
    }

    if (event.type === 'session_ended') {
      if (session.status !== 'ending') assertSessionTransition(session.status, 'ending');
      this.sessions.set(event.sessionId, {
        ...session,
        status: event.payload.reason === 'failure' ? 'failed' : 'completed',
        endedAt: event.payload.endedAt
      });
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
