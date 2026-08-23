import { test } from "node:test";
import assert from "node:assert/strict";
import { ok, toolError, safeTool } from "../utils/toolResult.js";
import { ChakudyaApiError } from "../clients/chakudyaClient.js";

test("ok() wraps data as a single JSON text block", () => {
  const result = ok({ a: 1 });
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  assert.deepEqual(JSON.parse(result.content[0].text), { a: 1 });
});

test("ok() merges meta alongside data", () => {
  const result = ok([1, 2, 3], { count: 3, source: "local" });
  const parsed = JSON.parse(result.content[0].text);
  assert.deepEqual(parsed, { count: 3, source: "local", data: [1, 2, 3] });
});

test("toolError() sets isError: true", () => {
  const result = toolError("something broke");
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "something broke");
});

test("safeTool() passes through a successful result unchanged", async () => {
  const wrapped = safeTool("noop", async () => ok({ hello: "world" }));
  const result = await wrapped();
  assert.deepEqual(JSON.parse((result as any).content[0].text), { hello: "world" });
});

test("safeTool() converts a 404 ChakudyaApiError into a friendly tool error", async () => {
  const wrapped = safeTool("noop", async () => {
    throw new ChakudyaApiError("Food id not found", 404, "/foods/999", null);
  });
  const result = await wrapped();
  assert.equal((result as any).isError, true);
  assert.match((result as any).content[0].text, /No matching data found/);
});

test("safeTool() converts a 429 ChakudyaApiError into a rate-limit message", async () => {
  const wrapped = safeTool("noop", async () => {
    throw new ChakudyaApiError("Too many requests", 429, "/rag/ask", null);
  });
  const result = await wrapped();
  assert.equal((result as any).isError, true);
  assert.match((result as any).content[0].text, /rate-limited/);
});

test("safeTool() converts an unexpected thrown error without crashing", async () => {
  const wrapped = safeTool("noop", async () => {
    throw new Error("boom");
  });
  const result = await wrapped();
  assert.equal((result as any).isError, true);
  assert.match((result as any).content[0].text, /Unexpected error in tool "noop"/);
  assert.match((result as any).content[0].text, /boom/);
});
