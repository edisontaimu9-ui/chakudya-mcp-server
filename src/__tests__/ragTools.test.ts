import { test } from "node:test";
import assert from "node:assert/strict";
import { registerRagTools } from "../tools/ragTools.js";
import { createTestClient, parseToolJson, mockFetch, jsonEnvelope } from "./testServer.js";

test("ragTools: all 3 tools registered with read-only, open-world annotations", async () => {
  const { client, close } = await createTestClient(registerRagTools);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["rag_retrieve", "retrieve_evidence", "search_guidelines"]);
    for (const tool of tools) {
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.destructiveHint, false);
      assert.equal(tool.annotations?.idempotentHint, true);
      assert.equal(tool.annotations?.openWorldHint, true);
    }
  } finally {
    await close();
  }
});

test("rag_retrieve posts to /rag/retrieve and returns raw chunks", async () => {
  const restore = mockFetch(async (url, init) => {
    assert.equal(url.pathname, "/rag/retrieve");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.query, "protein needs in burns");
    assert.equal(body.context, "both");
    assert.equal(body.top_k, 5);
    return jsonEnvelope([{ chunk: "Burns patients need 1.5-2g/kg protein." }]);
  });
  const { client, close } = await createTestClient(registerRagTools);
  try {
    const result = await client.callTool({
      name: "rag_retrieve",
      arguments: { query: "protein needs in burns" },
    });
    const parsed = parseToolJson(result);
    assert.match(parsed[0].chunk, /Burns patients/);
  } finally {
    await close();
    restore();
  }
});

test("search_guidelines posts to /rag/ask with context=clinical", async () => {
  const restore = mockFetch(async (url, init) => {
    assert.equal(url.pathname, "/rag/ask");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.context, "clinical");
    assert.equal(body.top_k, 6);
    return jsonEnvelope({
      answer: "Stage 3 CKD: ~0.6-0.8 g/kg/day protein [1].",
      intent: "nutrition_question",
      barcode_detected: null,
      sources: [{ id: 1, source: "guideline", title: "KDOQI" }],
    });
  });
  const { client, close } = await createTestClient(registerRagTools);
  try {
    const result = await client.callTool({
      name: "search_guidelines",
      arguments: { query: "protein intake stage 3 CKD" },
    });
    const parsed = parseToolJson(result);
    assert.match(parsed.answer, /Stage 3 CKD/);
    assert.equal(parsed.sources[0].title, "KDOQI");
  } finally {
    await close();
    restore();
  }
});

test("retrieve_evidence posts to /rag/ask with context=both and a higher default top_k", async () => {
  const restore = mockFetch(async (url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.context, "both");
    assert.equal(body.top_k, 8);
    return jsonEnvelope({ answer: "General overview.", intent: "general_chat", barcode_detected: null, sources: [] });
  });
  const { client, close } = await createTestClient(registerRagTools);
  try {
    const result = await client.callTool({
      name: "retrieve_evidence",
      arguments: { query: "sodium and hypertension" },
    });
    const parsed = parseToolJson(result);
    assert.match(parsed.answer, /General overview/);
  } finally {
    await close();
    restore();
  }
});
