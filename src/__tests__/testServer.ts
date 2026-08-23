import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

/**
 * Spins up a real McpServer + Client pair connected over an in-memory
 * transport, so tests exercise tools exactly the way an MCP client would
 * (list_tools, call_tool) rather than calling handler functions directly.
 */
export async function createTestClient(register: (server: McpServer) => void) {
  const server = new McpServer({ name: "chakudya-mcp-server-test", version: "0.0.0-test" });
  register(server);

  const client = new Client({ name: "test-client", version: "0.0.0-test" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Parses the JSON text content out of a tool call result (see ok() in toolResult.ts). */
export function parseToolJson(result: Awaited<ReturnType<Client["callTool"]>>): any {
  const first = (result.content as Array<{ type: string; text?: string }>)?.[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error(`Expected a single text content block, got: ${JSON.stringify(result.content)}`);
  }
  return JSON.parse(first.text);
}

type FetchArgs = Parameters<typeof fetch>;

/**
 * Replaces globalThis.fetch for the duration of a test with a handler that
 * inspects the requested URL and returns a canned Response — so tool tests
 * never hit the real Chakudya API. Always call restore() (e.g. in a
 * try/finally or t.after) even if the test throws.
 */
export function mockFetch(handler: (url: URL, init: FetchArgs[1]) => Response | Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: FetchArgs[0], init?: FetchArgs[1]) => {
    const url = new URL(typeof input === "string" ? input : (input as Request).url ?? String(input));
    return handler(url, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** Builds a Chakudya-API-shaped success envelope Response. */
export function jsonEnvelope(data: unknown, extra: Record<string, unknown> = {}, status = 200) {
  return new Response(JSON.stringify({ status: status < 300 ? "success" : "error", data, ...extra }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
