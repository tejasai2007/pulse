import type { ExecutionContext } from '@nitrostack/core';
import type { CurrentStressResponse, CurrentVitalsResponse } from './contracts/vitals-resources.js';

export function authorizeVitalsRead(
  response: CurrentVitalsResponse | CurrentStressResponse,
  context: ExecutionContext,
  subject: string,
  boundary = 'mcp_resource_read'
): void {
  const correlationId = crypto.randomUUID();
  const sessionId = response.session.sessionId;
  const authenticatedSessionId = context.auth?.claims?.sessionId;
  const authenticatedScopeAllowed = !context.auth || context.auth.scopes?.includes('read:vitals') === true;
  const sessionAllowed = authenticatedSessionId === undefined || authenticatedSessionId === sessionId;
  const allowed = response.consentAllowed && authenticatedScopeAllowed && sessionAllowed;
  context.logger.info('Vitals resource consent checked', {
    boundary,
    correlationId,
    subject,
    sessionId,
    consentScope: 'read:vitals',
    consentAllowed: allowed
  });
  if (!response.consentAllowed) throw new Error(`Consent scope read:vitals is not granted for session ${sessionId}`);
  if (!authenticatedScopeAllowed) throw new Error('Authenticated agent is missing scope read:vitals');
  if (!sessionAllowed) throw new Error(`Authenticated session does not match current session ${sessionId}`);
}
