import { test } from "node:test";
import assert from "node:assert/strict";
import { registerFoodTools } from "../tools/foodTools.js";
import { createTestClient, parseToolJson, mockFetch, jsonEnvelope } from "./testServer.js";

test("foodTools: all 6 tools registered with read-only, open-world annotations", async () => {
  const { client, close } = await createTestClient(registerFoodTools);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "analyze_meal",
      "barcode_lookup",
      "calculate_nutrients",
      "get_food_details",
      "packaged_food_search",
      "search_food",
    ]);
    for (const tool of tools) {
      assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
      assert.equal(tool.annotations?.destructiveHint, false, tool.name);
      assert.equal(tool.annotations?.idempotentHint, true, tool.name);
      assert.equal(tool.annotations?.openWorldHint, true, tool.name);
    }
  } finally {
    await close();
  }
});

test("search_food returns local results as-is when the local DB has a match", async () => {
  const restore = mockFetch((url) => {
    assert.equal(url.pathname, "/foods");
    assert.equal(url.searchParams.get("search"), "nsima");
    return jsonEnvelope([{ id: 1, food_name: "Nsima", kcal: 130, protein_g: 2.4 }], { count: 1 });
  });
  const { client, close } = await createTestClient(registerFoodTools);
  try {
    const result = await client.callTool({ name: "search_food", arguments: { query: "nsima" } });
    const parsed = parseToolJson(result);
    assert.equal(parsed.source, "local_database");
    assert.equal(parsed.data[0].food_name, "Nsima");
    // Regression: local rows store calories as `kcal`; search_food must
    // normalize that into `energy_kcal` for callers.
    assert.equal(parsed.data[0].energy_kcal, 130);
  } finally {
    await close();
    restore();
  }
});

test("search_food falls back to /foods/lookup when it returns a single object (real API shape)", async () => {
  const restore = mockFetch((url) => {
    if (url.pathname === "/foods") return jsonEnvelope([], { count: 0 });
    assert.equal(url.pathname, "/foods/lookup");
    assert.equal(url.searchParams.get("q"), "quinoa");
    // Confirmed via live curl against the deployed Worker: /foods/lookup
    // returns a single best-match object under `data`, not an array.
    // A prior version of this test (and the code it tested) incorrectly
    // assumed an array here, which silently dropped every fallback result.
    return jsonEnvelope({ food_name: "Quinoa, cooked", energy_kcal: 120 });
  });
  const { client, close } = await createTestClient(registerFoodTools);
  try {
    const result = await client.callTool({ name: "search_food", arguments: { query: "quinoa" } });
    const parsed = parseToolJson(result);
    assert.equal(parsed.source, "external_fallback");
    assert.equal(Array.isArray(parsed.data), true);
    assert.equal(parsed.data.length, 1);
    assert.equal(parsed.data[0].food_name, "Quinoa, cooked");
    assert.equal(parsed.data[0].energy_kcal, 120);
  } finally {
    await close();
    restore();
  }
});

test("search_food falls back to /foods/lookup and does NOT double-wrap when it returns an array", async () => {
  const restore = mockFetch((url) => {
    if (url.pathname === "/foods") return jsonEnvelope([], { count: 0 });
    assert.equal(url.pathname, "/foods/lookup");
    assert.equal(url.searchParams.get("q"), "quinoa");
    // Also handle the array shape in case the API ever returns multiple candidates.
    return jsonEnvelope([{ food_name: "Quinoa", energy_kcal: 120 }]);
  });
  const { client, close } = await createTestClient(registerFoodTools);
  try {
    const result = await client.callTool({ name: "search_food", arguments: { query: "quinoa" } });
    const parsed = parseToolJson(result);
    assert.equal(parsed.source, "external_fallback");
    // Must be a flat array of foods, not [[...]] nested.
    assert.equal(Array.isArray(parsed.data), true);
    assert.equal(parsed.data.length, 1);
    assert.equal(parsed.data[0].food_name, "Quinoa");
  } finally {
    await close();
    restore();
  }
});

test("search_food returns an empty list when nothing matches anywhere", async () => {
  const restore = mockFetch((url) => {
    if (url.pathname === "/foods") return jsonEnvelope([], { count: 0 });
    return jsonEnvelope(null, { message: "not found" }, 404);
  });
  const { client, close } = await createTestClient(registerFoodTools);
  try {
    const result = await client.callTool({ name: "search_food", arguments: { query: "zzzznotfood" } });
    const parsed = parseToolJson(result);
    assert.equal(parsed.source, "none");
    assert.deepEqual(parsed.data, []);
  } finally {
    await close();
    restore();
  }
});

test("get_food_details normalizes kcal -> energy_kcal for a local food row (regression)", async () => {
  const restore = mockFetch((url) => {
    assert.equal(url.pathname, "/foods/42");
    return jsonEnvelope({ id: 42, food_name: "Beans", kcal: 340, protein_g: 21, fat_g: 1.2, carbs_g: 62 });
  });
  const { client, close } = await createTestClient(registerFoodTools);
  try {
    const result = await client.callTool({ name: "get_food_details", arguments: { food_id: 42 } });
    const parsed = parseToolJson(result);
    assert.equal(parsed.food_name, "Beans");
    assert.equal(parsed.kcal, 340);
    assert.equal(parsed.energy_kcal, 340);
  } finally {
    await close();
    restore();
  }
});

test("calculate_nutrients scales a local food's kcal correctly (regression: was returning null)", async () => {
  const restore = mockFetch((url) => {
    assert.equal(url.pathname, "/foods/7");
    return jsonEnvelope({ id: 7, food_name: "Nsima", kcal: 130, protein_g: 2.4, fat_g: 0.5, carbs_g: 28 });
  });
  const { client, close } = await createTestClient(registerFoodTools);
  try {
    const result = await client.callTool({
      name: "calculate_nutrients",
      arguments: { food_id: 7, quantity_grams: 200 },
    });
    const parsed = parseToolJson(result);
    // 200g is 2x the per-100g base values.
    assert.equal(parsed.data.nutrients.energy_kcal, 260);
    assert.equal(parsed.data.nutrients.protein_g, 4.8);
    assert.equal(parsed.data.nutrients.carbs_g, 56);
    // Local Malawi FCT foods don't carry fiber/sodium — should stay null, not error.
    assert.equal(parsed.data.nutrients.fiber_g, null);
  } finally {
    await close();
    restore();
  }
});

test("analyze_meal totals multiple foods and skips ones that fail to resolve", async () => {
  const restore = mockFetch((url) => {
    if (url.pathname === "/foods/1") {
      return jsonEnvelope({ id: 1, food_name: "Nsima", kcal: 130, protein_g: 2.4, fat_g: 0.5, carbs_g: 28 });
    }
    if (url.pathname === "/foods/999") {
      return jsonEnvelope(null, { message: "Food id not found" }, 404);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  const { client, close } = await createTestClient(registerFoodTools);
  try {
    const result = await client.callTool({
      name: "analyze_meal",
      arguments: {
        items: [
          { food_id: 1, quantity_grams: 100 },
          { food_id: 999, quantity_grams: 50 },
        ],
      },
    });
    const parsed = parseToolJson(result);
    assert.equal(parsed.data.totals.energy_kcal, 130);
    assert.equal(parsed.data.items.length, 1);
    assert.equal(parsed.warnings.length, 1);
    assert.match(parsed.warnings[0], /Skipped/);
  } finally {
    await close();
    restore();
  }
});

test("barcode_lookup returns community packaged results when present", async () => {
  const restore = mockFetch((url) => {
    assert.equal(url.pathname, "/packaged");
    assert.equal(url.searchParams.get("barcode"), "6009123456789");
    return jsonEnvelope([{ id: 3, product_name: "ONGA Mchuzi Mix", barcode: "6009123456789" }], { count: 1 });
  });
  const { client, close } = await createTestClient(registerFoodTools);
  try {
    const result = await client.callTool({
      name: "barcode_lookup",
      arguments: { barcode: "6009123456789" },
    });
    const parsed = parseToolJson(result);
    assert.equal(parsed.source, "community_packaged_foods");
    assert.equal(parsed.data[0].product_name, "ONGA Mchuzi Mix");
  } finally {
    await close();
    restore();
  }
});

test("barcode_lookup accepts a free-text query alongside/instead of a barcode", async () => {
  const restore = mockFetch((url) => {
    assert.equal(url.pathname, "/packaged");
    assert.equal(url.searchParams.get("search"), "mchuzi");
    assert.equal(url.searchParams.has("barcode"), false);
    return jsonEnvelope([{ id: 3, product_name: "ONGA Mchuzi Mix" }], { count: 1 });
  });
  const { client, close } = await createTestClient(registerFoodTools);
  try {
    const result = await client.callTool({ name: "barcode_lookup", arguments: { query: "mchuzi" } });
    const parsed = parseToolJson(result);
    assert.equal(parsed.data[0].product_name, "ONGA Mchuzi Mix");
  } finally {
    await close();
    restore();
  }
});

test("barcode_lookup falls back to /foods/lookup when nothing is local", async () => {
  const restore = mockFetch((url) => {
    if (url.pathname === "/packaged") return jsonEnvelope([], { count: 0 });
    assert.equal(url.pathname, "/foods/lookup");
    assert.equal(url.searchParams.get("barcode"), "6009999999999");
    return jsonEnvelope([{ product_name: "Some Import", energy_kcal: 400 }]);
  });
  const { client, close } = await createTestClient(registerFoodTools);
  try {
    const result = await client.callTool({
      name: "barcode_lookup",
      arguments: { barcode: "6009999999999" },
    });
    const parsed = parseToolJson(result);
    assert.equal(parsed.source, "external_fallback");
    assert.equal(parsed.data[0].product_name, "Some Import");
  } finally {
    await close();
    restore();
  }
});

test("barcode_lookup rejects when neither barcode nor query is given", async () => {
  const restore = mockFetch(() => {
    throw new Error("must not call the network");
  });
  const { client, close } = await createTestClient(registerFoodTools);
  try {
    const result = await client.callTool({ name: "barcode_lookup", arguments: {} });
    assert.equal(result.isError, true);
  } finally {
    await close();
    restore();
  }
});

test("packaged_food_search sends the `search` param for free-text queries (regression: was calling nonexistent /products)", async () => {
  const restore = mockFetch((url) => {
    assert.equal(url.pathname, "/packaged");
    assert.equal(url.searchParams.get("search"), "soya");
    return jsonEnvelope([{ id: 9, product_name: "Topsoy Soya Pieces" }], { count: 1 });
  });
  const { client, close } = await createTestClient(registerFoodTools);
  try {
    const result = await client.callTool({ name: "packaged_food_search", arguments: { query: "soya" } });
    const parsed = parseToolJson(result);
    assert.equal(parsed.data[0].product_name, "Topsoy Soya Pieces");
  } finally {
    await close();
    restore();
  }
});

test("packaged_food_search rejects when neither barcode nor query is given", async () => {
  const restore = mockFetch(() => {
    throw new Error("must not call the network");
  });
  const { client, close } = await createTestClient(registerFoodTools);
  try {
    const result = await client.callTool({ name: "packaged_food_search", arguments: {} });
    assert.equal(result.isError, true);
  } finally {
    await close();
    restore();
  }
});
