import type { LogEntry, LogSink } from './logsink';
import type { LogLevel } from './types';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function isLogLevel(value: string | undefined): value is LogLevel {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error';
}

export function parseLogLevel(value: string | undefined): LogLevel {
  return isLogLevel(value) ? value : 'info';
}

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  flush(ctx: ExecutionContext): void;
}

/**
 * Build a logger that prints structured JSON to stdout and (optionally) fans
 * every line out to a {@link LogSink} for external shipping.
 *
 * Lines below `level` are dropped from BOTH outputs — the sink sees the same
 * filtered stream stdout sees.
 *
 * `flush(ctx)` is called at the end of a run (success or fatal) and is the
 * single chance to ship buffered sink entries. With no sink, it is a no-op.
 */
export function createLogger(level: LogLevel, sink?: LogSink): Logger {
  const minRank = LEVEL_RANK[level];

  function emit(severity: LogLevel, event: string, fields?: Record<string, unknown>): void {
    if (LEVEL_RANK[severity] < minRank) return;
    const ts = new Date();
    const line = JSON.stringify({
      ts: ts.toISOString(),
      level: severity,
      event,
      version: VERSION,
      ...(fields ?? {}),
    });
    if (severity === 'error') {
      console.error(line);
    } else if (severity === 'warn') {
      console.warn(line);
    } else {
      // Structured info/debug output — the project's only sanctioned use of
      // console.log. All other call sites should go through this logger.
      // eslint-disable-next-line no-console
      console.log(line);
    }
    if (sink !== undefined) {
      const entry: LogEntry = { ts, level: severity, event, ...(fields ? { fields } : {}) };
      sink.push(entry);
    }
  }

  return {
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    flush: (ctx) => sink?.flush(ctx),
  };
}
