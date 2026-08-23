import { test } from "node:test";
import assert from "node:assert/strict";
import { registerClinicalTools } from "../tools/clinicalTools.js";
import { createTestClient, parseToolJson, mockFetch, jsonEnvelope } from "./testServer.js";

test("clinicalTools: all 4 tools are registered with full read-only annotations", async () => {
  const { client, close } = await createTestClient(registerClinicalTools);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "diabetes_exchange_lookup",
      "enteral_formula_lookup",
      "nutrition_calculator",
      "renal_exchange_lookup",
    ]);
    for (const tool of tools) {
      assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} readOnlyHint`);
      assert.equal(tool.annotations?.destructiveHint, false, `${tool.name} destructiveHint`);
      assert.equal(tool.annotations?.idempotentHint, true, `${tool.name} idempotentHint`);
      assert.equal(typeof tool.annotations?.openWorldHint, "boolean", `${tool.name} openWorldHint present`);
    }
    // Pure calculation, no external API — openWorldHint should be false.
    const calc = tools.find((t) => t.name === "nutrition_calculator");
    assert.equal(calc?.annotations?.openWorldHint, false);
  } finally {
    await close();
  }
});

test("diabetes_exchange_lookup calls GET /exchange and returns the API's data", async () => {
  const restore = mockFetch((url) => {
    assert.equal(url.pathname, "/exchange");
    assert.equal(url.searchParams.get("type"), "starch");
    return jsonEnvelope([{ id: 1, food_name: "Nsima" }], { count: 1 });
  });
  const { client, close } = await createTestClient(registerClinicalTools);
  try {
    const result = await client.callTool({
      name: "diabetes_exchange_lookup",
      arguments: { type: "starch" },
    });
    const parsed = parseToolJson(result);
    assert.deepEqual(parsed.data, [{ id: 1, food_name: "Nsima" }]);
    assert.equal(parsed.count, 1);
  } finally {
    await close();
    restore();
  }
});

test("renal_exchange_lookup calls GET /renal", async () => {
  const restore = mockFetch((url) => {
    assert.equal(url.pathname, "/renal");
    return jsonEnvelope([{ id: 5, food_name: "Rice" }], { count: 1 });
  });
  const { client, close } = await createTestClient(registerClinicalTools);
  try {
    const result = await client.callTool({ name: "renal_exchange_lookup", arguments: {} });
    const parsed = parseToolJson(result);
    assert.equal(parsed.data[0].food_name, "Rice");
  } finally {
    await close();
    restore();
  }
});

test("enteral_formula_lookup calls GET /formulas with route param", async () => {
  const restore = mockFetch((url) => {
    assert.equal(url.pathname, "/formulas");
    assert.equal(url.searchParams.get("route"), "NG");
    return jsonEnvelope([{ id: 2, name: "Formula X" }], { count: 1 });
  });
  const { client, close } = await createTestClient(registerClinicalTools);
  try {
    const result = await client.callTool({
      name: "enteral_formula_lookup",
      arguments: { route: "NG" },
    });
    const parsed = parseToolJson(result);
    assert.equal(parsed.data[0].name, "Formula X");
  } finally {
    await close();
    restore();
  }
});

test("nutrition_calculator computes BMI/BMR/TDEE without calling the network", async () => {
  const restore = mockFetch(() => {
    throw new Error("nutrition_calculator must not call the network");
  });
  const { client, close } = await createTestClient(registerClinicalTools);
  try {
    const result = await client.callTool({
      name: "nutrition_calculator",
      arguments: {
        weight_kg: 70,
        height_cm: 175,
        age_years: 30,
        sex: "male",
        activity_level: "moderate",
      },
    });
    const parsed = parseToolJson(result);
    // Mifflin-St Jeor: 10*70 + 6.25*175 - 5*30 + 5 = 700 + 1093.75 - 150 + 5 = 1648.75
    assert.equal(parsed.bmr_kcal_per_day, 1649);
    assert.equal(parsed.tdee_kcal_per_day, Math.round(1648.75 * 1.55));
    assert.equal(parsed.bmi_category, "normal");
    assert.equal(parsed.bmi, 22.9);
  } finally {
    await close();
    restore();
  }
});

test("nutrition_calculator categorizes underweight/overweight/obese correctly", async () => {
  const restore = mockFetch(() => {
    throw new Error("must not call the network");
  });
  const { client, close } = await createTestClient(registerClinicalTools);
  try {
    const cases: Array<[number, string]> = [
      [16, "underweight"],
      [22, "normal"],
      [27, "overweight"],
      [33, "obese"],
    ];
    for (const [bmi, expected] of cases) {
      // Solve weight_kg for a fixed 170cm height to hit the target BMI.
      const heightM = 1.7;
      const weight_kg = Math.round(bmi * heightM * heightM * 10) / 10;
      const result = await client.callTool({
        name: "nutrition_calculator",
        arguments: { weight_kg, height_cm: 170, age_years: 40, sex: "female" },
      });
      const parsed = parseToolJson(result);
      assert.equal(parsed.bmi_category, expected, `weight ${weight_kg} should be ${expected}`);
    }
  } finally {
    await close();
    restore();
  }
});
