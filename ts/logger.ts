/** Accepts a bare message, or a structured record optionally followed by one (pino-style). */
export type LogFn = {
  (message: string): void;
  (fields: Record<string, unknown>, message?: string): void;
};

/** The logging surface Toki depends on. Structurally compatible with a pino instance. */
export interface Logger {
  fatal: LogFn;
  error: LogFn;
  warn: LogFn;
  info: LogFn;
  debug: LogFn;
  trace: LogFn;
  child(bindings: Record<string, unknown>): Logger;
}

/** Severity levels, from most to least severe. */
export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";

const LEVEL_WEIGHT: Readonly<Record<LogLevel, number>> = {
  fatal: 60,
  error: 50,
  warn: 40,
  info: 30,
  debug: 20,
  trace: 10,
};

const LEVELS: readonly LogLevel[] = ["fatal", "error", "warn", "info", "debug", "trace"];

/** Options for {@link createConsoleLogger}. */
export interface ConsoleLoggerOptions {
  /** Minimum level to emit; entries below it are dropped. Defaults to `"info"`. */
  level?: LogLevel;
  /** Fields stamped onto every entry. */
  bindings?: Record<string, unknown>;
}

/** A minimal JSON-line logger backed by `console`; the default for `{ logger: true }`. */
export function createConsoleLogger(options: ConsoleLoggerOptions = {}): Logger {
  const threshold = LEVEL_WEIGHT[options.level ?? "info"];
  const bindings = options.bindings ?? {};

  const emit = (level: LogLevel): LogFn => {
    const weight = LEVEL_WEIGHT[level];
    const sink = weight >= LEVEL_WEIGHT.error ? console.error : console.log;
    return (first: string | Record<string, unknown>, second?: string): void => {
      if (weight < threshold) {
        return;
      }
      const entry: Record<string, unknown> = {
        level,
        time: new Date().toISOString(),
        ...bindings,
      };
      if (typeof first === "string") {
        entry["msg"] = first;
      } else {
        Object.assign(entry, first);
        if (second !== undefined) {
          entry["msg"] = second;
        }
      }
      sink(JSON.stringify(entry));
    };
  };

  return {
    fatal: emit("fatal"),
    error: emit("error"),
    warn: emit("warn"),
    info: emit("info"),
    debug: emit("debug"),
    trace: emit("trace"),
    child(childBindings: Record<string, unknown>): Logger {
      return createConsoleLogger({
        level: options.level ?? "info",
        bindings: { ...bindings, ...childBindings },
      });
    },
  };
}

/** A {@link Logger} that discards every entry; the default when no logger is requested. */
export const silentLogger: Logger = (() => {
  const noop: LogFn = () => {};
  const logger: Logger = {
    fatal: noop,
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
    trace: noop,
    child: () => logger,
  };
  return logger;
})();

/** Resolve the `logger` constructor option into a concrete {@link Logger}. */
export function resolveLogger(option: LoggerOption | undefined): Logger {
  if (option === undefined || option === false) {
    return silentLogger;
  }
  if (option === true) {
    return createConsoleLogger();
  }
  if (typeof option === "string") {
    return createConsoleLogger({ level: option });
  }
  return option;
}

/** Accepted `logger` option shapes: a toggle, a {@link LogLevel} threshold, or a {@link Logger}. */
export type LoggerOption = boolean | LogLevel | Logger;

/** Type guard distinguishing a level string from the other option shapes. */
export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LEVELS as readonly string[]).includes(value);
}
