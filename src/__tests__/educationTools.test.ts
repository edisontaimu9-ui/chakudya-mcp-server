import { test } from "node:test";
import assert from "node:assert/strict";
import { registerEducationTools } from "../tools/educationTools.js";
import { createTestClient, parseToolJson, mockFetch, jsonEnvelope } from "./testServer.js";

test("educationTools: both tools registered with read-only, open-world annotations", async () => {
  const { client, close } = await createTestClient(registerEducationTools);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["disease_information", "medicine_information"]);
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

test("disease_information posts to /rag/ask with context=clinical and includes the educational disclaimer", async () => {
  const restore = mockFetch(async (url, init) => {
    assert.equal(url.pathname, "/rag/ask");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.context, "clinical");
    assert.match(body.query, /chronic kidney disease/);
    return jsonEnvelope({
      answer: "CKD is managed with protein and phosphorus restriction [1].",
      intent: "nutrition_question",
      sources: [{ id: 1, source: "textbook", title: "Renal Nutrition" }],
    });
  });
  const { client, close } = await createTestClient(registerEducationTools);
  try {
    const result = await client.callTool({
      name: "disease_information",
      arguments: { condition: "chronic kidney disease" },
    });
    const parsed = parseToolJson(result);
    assert.equal(parsed.data.condition, "chronic kidney disease");
    assert.match(parsed.data.answer, /CKD/);
    assert.match(parsed.disclaimer, /Educational information only/);
  } finally {
    await close();
    restore();
  }
});

test("medicine_information never requests dosing and flags it must not be used for prescribing", async () => {
  const restore = mockFetch(async (url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.match(body.query, /Do NOT include dosing/);
    return jsonEnvelope({
      answer: "Metformin can cause vitamin B12 depletion with long-term use.",
      intent: "nutrition_question",
      sources: [],
    });
  });
  const { client, close } = await createTestClient(registerEducationTools);
  try {
    const result = await client.callTool({
      name: "medicine_information",
      arguments: { medicine: "metformin" },
    });
    const parsed = parseToolJson(result);
    assert.match(parsed.data.answer, /B12/);
    assert.match(parsed.disclaimer, /must not be used for dosing or prescribing/);
  } finally {
    await close();
    restore();
  }
});
