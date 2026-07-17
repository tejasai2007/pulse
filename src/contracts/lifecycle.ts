import type { SessionStatus } from './domain.js';

export const SESSION_TRANSITIONS: Readonly<Record<SessionStatus, readonly SessionStatus[]>> = {
  created: ['calibrating', 'failed'],
  calibrating: ['active', 'ending', 'failed'],
  active: ['ending', 'failed'],
  ending: ['completed', 'failed'],
  completed: [],
  failed: []
};

export class InvalidSessionTransitionError extends Error {
  constructor(from: SessionStatus, to: SessionStatus) {
    super(`Invalid session transition: ${from} -> ${to}`);
    this.name = 'InvalidSessionTransitionError';
  }
}

export function assertSessionTransition(from: SessionStatus, to: SessionStatus): void {
  if (!SESSION_TRANSITIONS[from].includes(to)) {
    throw new InvalidSessionTransitionError(from, to);
  }
}

export function canTransitionSession(from: SessionStatus, to: SessionStatus): boolean {
  return SESSION_TRANSITIONS[from].includes(to);
}
