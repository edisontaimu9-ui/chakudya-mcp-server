import { env } from "../config/env.js";

type Level = "debug" | "info" | "warn" | "error";

const levelOrder: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const minLevel: Level = env.NODE_ENV === "production" ? "info" : "debug";

function emit(level: Level, msg: string, meta?: Record<string, unknown>) {
  if (levelOrder[level] < levelOrder[minLevel]) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(meta ?? {}),
  };
  const out = level === "error" ? console.error : console.log;
  out(JSON.stringify(line));
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit("error", msg, meta),
};
