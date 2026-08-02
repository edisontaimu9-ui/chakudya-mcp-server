import express from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { env } from "./config/env.js";
import { logger } from "./utils/logger.js";
import { createChakudyaMcpServer } from "./server/createServer.js";
import { requireAuth, rateLimit } from "./server/security.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

if (env.MCP_ALLOWED_ORIGINS.length > 0) {
  app.use(
    cors({
      origin: env.MCP_ALLOWED_ORIGINS,
      exposedHeaders: ["Mcp-Session-Id"],
      allowedHeaders: ["Content-Type", "Authorization", "Mcp-Session-Id"],
    })
  );
}

// Unauthenticated liveness check for your deploy platform / uptime monitor.
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "chakudya-mcp-server", time: new Date().toISOString() });
});

/**
 * One StreamableHTTPServerTransport (and one McpServer) per MCP session.
 * This is the official stateful pattern: the transport is created on the
 * client's `initialize` call and reused for every subsequent request that
 * carries the same `Mcp-Session-Id` header.
 *
 * NOTE: this map is in-memory and per-process. If you ever run more than
 * one instance of this server behind a load balancer, sessions must be
 * sticky-routed back to the same instance (or you swap this for a shared
 * session store) — otherwise a client's follow-up request can land on an
 * instance that's never heard of its session id.
 */
const transports = new Map<string, StreamableHTTPServerTransport>();

app.post("/mcp", requireAuth, rateLimit, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  try {
    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId)!;
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          transports.set(newSessionId, transport);
          logger.info("mcp_session_initialized", { sessionId: newSessionId });
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          transports.delete(transport.sessionId);
          logger.info("mcp_session_closed", { sessionId: transport.sessionId });
        }
      };

      const server = createChakudyaMcpServer();
      await server.connect(transport);
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: no valid session id and not an initialize request" },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    logger.error("mcp_post_error", { error: e instanceof Error ? e.message : String(e) });
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// GET is used by clients to open the server->client SSE notification stream
// for an existing session.
app.get("/mcp", requireAuth, rateLimit, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) {
    res.status(400).send("Invalid or missing Mcp-Session-Id header");
    return;
  }
  await transport.handleRequest(req, res);
});

// DELETE lets a well-behaved client explicitly terminate its session.
app.delete("/mcp", requireAuth, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) {
    res.status(400).send("Invalid or missing Mcp-Session-Id header");
    return;
  }
  await transport.handleRequest(req, res);
});

const httpServer = app.listen(env.PORT, () => {
  logger.info("mcp_server_listening", { port: env.PORT, chakudyaApi: env.CHAKUDYA_API_BASE_URL });
});

// Graceful shutdown: close every open MCP session's transport before exiting
// so clients get a clean disconnect instead of a dropped connection.
async function shutdown(signal: string) {
  logger.info("shutdown_started", { signal });
  httpServer.close();
  for (const transport of transports.values()) {
    try {
      await transport.close();
    } catch {
      // best-effort cleanup
    }
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
