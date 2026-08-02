import type { Request, Response, NextFunction } from "express";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

/**
 * Requires `Authorization: Bearer <MCP_AUTH_TOKEN>` on every request to the
 * MCP endpoint. This protects your Chakudya API's public-but-rate-limited
 * routes (rag/ask, rag/retrieve) from being hammered by anyone who finds
 * this server's URL, since MCP tool calls fan out into real upstream calls.
 *
 * If MCP_AUTH_TOKEN is unset (local dev only — enforced in env.ts), this
 * becomes a no-op.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!env.MCP_AUTH_TOKEN) return next(); // dev-only escape hatch

  const header = req.headers.authorization ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1];

  if (!token || token !== env.MCP_AUTH_TOKEN) {
    logger.warn("mcp_auth_rejected", { ip: req.ip, path: req.path });
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: missing or invalid bearer token" },
      id: null,
    });
    return;
  }

  next();
}

/**
 * Minimal fixed-window per-IP rate limiter for the MCP endpoint itself.
 * This is independent of the Chakudya API's own rate limiting — it exists
 * so a misbehaving MCP client can't generate unbounded fan-out traffic
 * against your upstream API through this server.
 *
 * In-memory only: fine for a single instance. If you scale to multiple
 * instances behind a load balancer, swap this for a shared store (e.g.
 * Redis) — the comment in index.ts flags where.
 */
const windowMs = 60_000;
const hits = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(req: Request, res: Response, next: NextFunction) {
  const key = req.ip ?? "unknown";
  const now = Date.now();
  const entry = hits.get(key);

  if (!entry || entry.resetAt < now) {
    hits.set(key, { count: 1, resetAt: now + windowMs });
    return next();
  }

  entry.count += 1;
  if (entry.count > env.MCP_RATE_LIMIT_PER_MIN) {
    const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
    res.setHeader("Retry-After", String(retryAfterSec));
    res.status(429).json({
      jsonrpc: "2.0",
      error: { code: -32002, message: "Rate limit exceeded for this MCP server. Try again shortly." },
      id: null,
    });
    return;
  }

  next();
}

// Periodically sweep expired rate-limit entries so the map doesn't grow
// unbounded on a long-running process.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of hits) {
    if (entry.resetAt < now) hits.delete(key);
  }
}, windowMs).unref();
