import type { Logger, LogLevel, TokiOptions } from "./types.ts";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** no-op logger; default so logging costs nothing unless opted in */
export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};

/** JSON-per-line logger; drops below `level`, carries `bindings` */
export function createConsoleLogger(
  level: LogLevel = "info",
  bindings: Record<string, unknown> = {},
): Logger {
  const threshold = LEVELS[level];

  function log(at: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVELS[at] < threshold) {
      return;
    }
    const line = JSON.stringify({ level: at, msg: message, ...bindings, ...fields });
    if (at === "error" || at === "warn") {
      process.stderr.write(line + "\n");
    } else {
      process.stdout.write(line + "\n");
    }
  }

  return {
    debug: (m, f) => log("debug", m, f),
    info: (m, f) => log("info", m, f),
    warn: (m, f) => log("warn", m, f),
    error: (m, f) => log("error", m, f),
    child: (extra) => createConsoleLogger(level, { ...bindings, ...extra }),
  };
}

/** resolve the `logger` option to a concrete {@link Logger} */
export function resolveLogger(option: TokiOptions["logger"]): Logger {
  if (option === undefined || option === false) {
    return silentLogger;
  }
  if (typeof option === "string") {
    return createConsoleLogger(option);
  }
  return option;
}
