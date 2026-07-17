export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  sessionId?: string;
  eventId?: string;
  correlationId?: string;
  boundary?: string;
  [key: string]: unknown;
}

const rank: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const redactedKeys = /authorization|api.?key|secret|token|audio|transcript|text/i;

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
      key,
      redactedKeys.test(key) ? '[REDACTED]' : sanitize(nested)
    ]));
  }
  return value;
}

export class StructuredLogger {
  constructor(
    private readonly component: string,
    private readonly minimumLevel: LogLevel = 'info'
  ) {}

  debug(message: string, context: LogContext = {}): void { this.write('debug', message, context); }
  info(message: string, context: LogContext = {}): void { this.write('info', message, context); }
  warn(message: string, context: LogContext = {}): void { this.write('warn', message, context); }
  error(message: string, context: LogContext = {}): void { this.write('error', message, context); }

  private write(level: LogLevel, message: string, context: LogContext): void {
    if (rank[level] < rank[this.minimumLevel]) return;
    const entry = sanitize({
      timestamp: new Date().toISOString(),
      level,
      component: this.component,
      message,
      ...context
    });
    const output = JSON.stringify(entry);
    if (level === 'error') console.error(output);
    else if (level === 'warn') console.warn(output);
    else console.log(output);
  }
}
