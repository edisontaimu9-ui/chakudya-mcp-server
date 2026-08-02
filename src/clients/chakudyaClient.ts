import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

/**
 * Thin HTTP client for the already-deployed Chakudya Nutrition Registry
 * Worker (chakudya-api). This file intentionally contains NO business logic
 * of its own — it only knows how to call the existing API and normalize
 * errors. All Chakudya-specific behavior (routes, query params, auth model)
 * lives in the Worker itself; this client just mirrors it.
 */

export class ChakudyaApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly body: unknown;

  constructor(message: string, status: number, path: string, body: unknown) {
    super(message);
    this.name = "ChakudyaApiError";
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

interface CnrEnvelope<T = unknown> {
  status: "success" | "error" | "not_found";
  message?: string;
  count?: number;
  limit?: number;
  offset?: number;
  data?: T;
  [key: string]: unknown;
}

const BASE_URL = env.CHAKUDYA_API_BASE_URL.replace(/\/$/, "");

function buildUrl(path: string, params?: Record<string, string | number | boolean | undefined>) {
  const url = new URL(BASE_URL + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === "") continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url;
}

async function request<T = unknown>(
  method: "GET" | "POST",
  path: string,
  opts: {
    params?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    /** Set true only for routes documented as admin-gated in the CNR README. */
    useAdminKey?: boolean;
    timeoutMs?: number;
  } = {}
): Promise<CnrEnvelope<T>> {
  const { params, body, useAdminKey, timeoutMs = 15_000 } = opts;
  const url = buildUrl(path, params);

  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (useAdminKey) {
    if (!env.CHAKUDYA_ADMIN_API_KEY) {
      throw new ChakudyaApiError(
        "This operation requires CHAKUDYA_ADMIN_API_KEY to be set on the MCP server, but it isn't.",
        500,
        path,
        null
      );
    }
    headers.Authorization = `Bearer ${env.CHAKUDYA_ADMIN_API_KEY}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const isAbort = e instanceof Error && e.name === "AbortError";
    throw new ChakudyaApiError(
      isAbort
        ? `Chakudya API request timed out after ${timeoutMs}ms`
        : `Network error calling Chakudya API: ${(e as Error).message}`,
      isAbort ? 504 : 502,
      path,
      null
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON response body; fall through with raw text captured below.
  }

  if (!res.ok) {
    const message =
      (parsed as CnrEnvelope | null)?.message ??
      `Chakudya API returned HTTP ${res.status} for ${method} ${path}`;
    logger.warn("chakudya_api_error", { path, status: res.status, message });
    throw new ChakudyaApiError(message, res.status, path, parsed ?? text);
  }

  return (parsed ?? {}) as CnrEnvelope<T>;
}

export const chakudyaClient = {
  get: <T = unknown>(path: string, params?: Record<string, string | number | boolean | undefined>) =>
    request<T>("GET", path, { params }),

  post: <T = unknown>(path: string, body: unknown, opts: { useAdminKey?: boolean } = {}) =>
    request<T>("POST", path, { body, useAdminKey: opts.useAdminKey }),
};
