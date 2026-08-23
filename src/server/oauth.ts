import { Router } from "express";
import { randomUUID, createHash } from "node:crypto";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

/**
 * This server has exactly one "user" (you) and one real credential
 * (MCP_AUTH_TOKEN). Some MCP clients — notably Claude.ai's custom
 * connector UI — refuse to send a bearer token directly and instead
 * require a full OAuth 2.1 authorization-code + PKCE handshake before
 * they'll talk to a remote MCP server.
 *
 * Rather than build real multi-user OAuth, this module implements the
 * minimum surface those clients expect, and auto-approves every request
 * (there's no login screen, no consent screen — if you can reach this
 * server, you're already the owner). The access token it ultimately
 * hands back is just your existing MCP_AUTH_TOKEN, so the existing
 * requireAuth() check in security.ts needs no changes to accept it.
 *
 * Endpoints implemented:
 *   GET  /.well-known/oauth-authorization-server   (RFC 8414 metadata)
 *   GET  /.well-known/oauth-protected-resource      (RFC 9728 metadata)
 *   POST /register                                  (RFC 7591 dynamic client registration)
 *   GET  /authorize                                  (auto-approves, issues a code)
 *   POST /token                                       (exchanges code -> MCP_AUTH_TOKEN)
 */

export const oauthRouter = Router();

// Short-lived authorization codes, PKCE-bound. In-memory + single instance
// is fine here: codes live for ~60s between /authorize and /token.
interface PendingCode {
  codeChallenge: string;
  redirectUri: string;
  expiresAt: number;
}
const pendingCodes = new Map<string, PendingCode>();

function baseUrl(req: { protocol: string; get(name: string): string | undefined }): string {
  // Render (and most PaaS) terminate TLS upstream, so req.protocol may say
  // "http" even though the public URL is https. Trust the standard proxy
  // header when present.
  const proto = (req.get("x-forwarded-proto") ?? req.protocol).split(",")[0].trim();
  const host = req.get("host");
  return `${proto}://${host}`;
}

oauthRouter.get("/.well-known/oauth-authorization-server", (req, res) => {
  const issuer = baseUrl(req);
  res.json({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"],
  });
});

oauthRouter.get("/.well-known/oauth-protected-resource", (req, res) => {
  const issuer = baseUrl(req);
  res.json({
    resource: `${issuer}/mcp`,
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
  });
});

// RFC 7591 dynamic client registration. Every caller gets approved — this
// server has no concept of distinct third-party clients, only "you."
oauthRouter.post("/register", (req, res) => {
  const clientId = randomUUID();
  logger.info("oauth_client_registered", { clientId });
  res.status(201).json({
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: req.body?.redirect_uris ?? [],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
});

// Auto-approve authorization endpoint: no login screen, no consent screen.
// Immediately issues a code bound to the caller's PKCE code_challenge and
// redirects back to their redirect_uri, exactly as if a user had clicked
// "Allow."
oauthRouter.get("/authorize", (req, res) => {
  const redirectUri = req.query.redirect_uri as string | undefined;
  const state = req.query.state as string | undefined;
  const codeChallenge = req.query.code_challenge as string | undefined;
  const codeChallengeMethod = req.query.code_challenge_method as string | undefined;

  if (!redirectUri) {
    res.status(400).send("Missing redirect_uri");
    return;
  }
  if (!codeChallenge || codeChallengeMethod !== "S256") {
    res.status(400).send("This server requires PKCE with S256.");
    return;
  }

  const code = randomUUID();
  pendingCodes.set(code, {
    codeChallenge,
    redirectUri,
    expiresAt: Date.now() + 60_000,
  });

  const redirect = new URL(redirectUri);
  redirect.searchParams.set("code", code);
  if (state) redirect.searchParams.set("state", state);

  logger.info("oauth_authorize_auto_approved", { redirectUri });
  res.redirect(302, redirect.toString());
});

function verifyPkce(verifier: string, challenge: string): boolean {
  const hash = createHash("sha256").update(verifier).digest("base64url");
  return hash === challenge;
}

oauthRouter.post("/token", (req, res) => {
  const grantType = req.body?.grant_type as string | undefined;

  if (grantType === "authorization_code") {
    const code = req.body?.code as string | undefined;
    const verifier = req.body?.code_verifier as string | undefined;
    const pending = code ? pendingCodes.get(code) : undefined;

    if (!code || !pending) {
      res.status(400).json({ error: "invalid_grant", error_description: "Unknown or expired code" });
      return;
    }
    pendingCodes.delete(code); // one-time use

    if (pending.expiresAt < Date.now()) {
      res.status(400).json({ error: "invalid_grant", error_description: "Code expired" });
      return;
    }
    if (!verifier || !verifyPkce(verifier, pending.codeChallenge)) {
      res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
      return;
    }

    logger.info("oauth_token_issued", { grantType });
    res.json({
      access_token: env.MCP_AUTH_TOKEN,
      token_type: "Bearer",
      expires_in: 31536000, // 1 year — there's nothing to rotate here
      refresh_token: env.MCP_AUTH_TOKEN,
      scope: "mcp",
    });
    return;
  }

  if (grantType === "refresh_token") {
    // Nothing actually expires or rotates for this server, so a refresh
    // just re-issues the same token.
    logger.info("oauth_token_refreshed", { grantType });
    res.json({
      access_token: env.MCP_AUTH_TOKEN,
      token_type: "Bearer",
      expires_in: 31536000,
      refresh_token: env.MCP_AUTH_TOKEN,
      scope: "mcp",
    });
    return;
  }

  res.status(400).json({ error: "unsupported_grant_type" });
});

// Periodic sweep so pendingCodes can't grow unbounded from abandoned flows.
setInterval(() => {
  const now = Date.now();
  for (const [code, pending] of pendingCodes) {
    if (pending.expiresAt < now) pendingCodes.delete(code);
  }
}, 60_000).unref();
