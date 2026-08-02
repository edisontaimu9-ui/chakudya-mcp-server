import { ChakudyaApiError } from "../clients/chakudyaClient.js";
import { logger } from "./logger.js";

/**
 * MCP tool handlers must never throw raw exceptions back through the SDK —
 * we catch everything and return a structured `isError` result instead, so
 * the calling model gets a clean, explainable message rather than a
 * transport-level failure.
 */

export function ok(data: unknown, meta?: Record<string, unknown>) {
  const payload = meta ? { ...meta, data } : data;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

export function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

/**
 * Wraps a tool handler body so any thrown error (from the Chakudya client,
 * a Zod refinement, or a bug) becomes a well-formed MCP error result instead
 * of crashing the request.
 */
export function safeTool<Args extends unknown[]>(
  name: string,
  fn: (...args: Args) => Promise<ReturnType<typeof ok>>
) {
  return async (...args: Args) => {
    try {
      return await fn(...args);
    } catch (e) {
      if (e instanceof ChakudyaApiError) {
        logger.warn("tool_chakudya_error", { tool: name, status: e.status, path: e.path });
        if (e.status === 404) {
          return toolError(`No matching data found. (${e.message})`);
        }
        if (e.status === 429) {
          return toolError(
            `The Chakudya API rate-limited this request. Please wait a moment and try again.`
          );
        }
        return toolError(`Chakudya API error (${e.status}): ${e.message}`);
      }
      logger.error("tool_unexpected_error", {
        tool: name,
        error: e instanceof Error ? e.message : String(e),
      });
      return toolError(
        `Unexpected error in tool "${name}": ${e instanceof Error ? e.message : String(e)}`
      );
    }
  };
}
