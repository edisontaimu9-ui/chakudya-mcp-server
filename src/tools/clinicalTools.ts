import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { chakudyaClient } from "../clients/chakudyaClient.js";
import { ok, safeTool } from "../utils/toolResult.js";

// Activity factors for the Mifflin-St Jeor TDEE calculation.
const ACTIVITY_FACTORS = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
} as const;

export function registerClinicalTools(server: McpServer) {
  // ── diabetes_exchange_lookup ─────────────────────────────────────────────
  server.registerTool(
    "diabetes_exchange_lookup",
    {
      title: "Diabetes Exchange List Lookup",
      description:
        "Look up foods in the diabetic exchange list (e.g. UCT-style exchange system) by exchange type " +
        "(e.g. 'starch', 'fruit', 'meat', 'fat', 'milk', 'vegetable'). Returns exchange portion data for " +
        "carbohydrate counting / meal planning in diabetes care.",
      inputSchema: {
        type: z.string().optional().describe("Exchange category, e.g. 'starch', 'fruit', 'meat', 'fat'"),
        limit: z.number().int().positive().max(200).optional().default(50),
        offset: z.number().int().nonnegative().optional().default(0),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safeTool("diabetes_exchange_lookup", async ({ type, limit, offset }) => {
      const res = await chakudyaClient.get("/exchange", { type, limit, offset });
      return ok(res.data, { count: res.count });
    })
  );

  // ── renal_exchange_lookup ────────────────────────────────────────────────
  server.registerTool(
    "renal_exchange_lookup",
    {
      title: "Renal Exchange List Lookup",
      description:
        "Look up foods in the renal diet exchange list (based on the RenalSmart South African exchange " +
        "system) — potassium, phosphorus, and sodium content relevant to chronic kidney disease / dialysis " +
        "diets.",
      inputSchema: {
        limit: z.number().int().positive().max(200).optional().default(50),
        offset: z.number().int().nonnegative().optional().default(0),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safeTool("renal_exchange_lookup", async ({ limit, offset }) => {
      const res = await chakudyaClient.get("/renal", { limit, offset });
      return ok(res.data, { count: res.count });
    })
  );

  // ── enteral_formula_lookup ───────────────────────────────────────────────
  server.registerTool(
    "enteral_formula_lookup",
    {
      title: "Enteral Formula Lookup",
      description:
        "Look up enteral/parenteral nutrition formulas by feeding route (e.g. 'oral', 'NG', 'PEG', 'IV'). " +
        "Returns formula composition (energy density, protein content, etc.) for tube feeding / " +
        "malnutrition management planning.",
      inputSchema: {
        route: z.string().optional().describe("Feeding route, e.g. 'oral', 'NG', 'PEG', 'IV'"),
        limit: z.number().int().positive().max(200).optional().default(50),
        offset: z.number().int().nonnegative().optional().default(0),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safeTool("enteral_formula_lookup", async ({ route, limit, offset }) => {
      const res = await chakudyaClient.get("/formulas", { route, limit, offset });
      return ok(res.data, { count: res.count });
    })
  );

  // ── nutrition_calculator ─────────────────────────────────────────────────
  server.registerTool(
    "nutrition_calculator",
    {
      title: "Nutrition Calculator (BMI / BMR / TDEE)",
      description:
        "Compute BMI, Basal Metabolic Rate (Mifflin-St Jeor equation), and Total Daily Energy Expenditure " +
        "from weight, height, age, sex, and activity level. Pure calculation — does not call the CNR API. " +
        "Educational/clinical-support estimate only, not a substitute for individualized dietetic assessment.",
      inputSchema: {
        weight_kg: z.number().positive(),
        height_cm: z.number().positive(),
        age_years: z.number().positive(),
        sex: z.enum(["male", "female"]),
        activity_level: z
          .enum(["sedentary", "light", "moderate", "active", "very_active"])
          .optional()
          .default("sedentary")
          .describe(
            "sedentary=little/no exercise, light=1-3 days/wk, moderate=3-5 days/wk, " +
              "active=6-7 days/wk, very_active=hard daily exercise or physical job"
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    safeTool(
      "nutrition_calculator",
      async ({ weight_kg, height_cm, age_years, sex, activity_level }) => {
        const heightM = height_cm / 100;
        const bmi = Math.round((weight_kg / (heightM * heightM)) * 10) / 10;

        let bmiCategory = "normal";
        if (bmi < 18.5) bmiCategory = "underweight";
        else if (bmi >= 25 && bmi < 30) bmiCategory = "overweight";
        else if (bmi >= 30) bmiCategory = "obese";

        // Mifflin-St Jeor
        const bmr =
          sex === "male"
            ? 10 * weight_kg + 6.25 * height_cm - 5 * age_years + 5
            : 10 * weight_kg + 6.25 * height_cm - 5 * age_years - 161;

        const tdee = bmr * ACTIVITY_FACTORS[activity_level];

        return ok({
          bmi: bmi,
          bmi_category: bmiCategory,
          bmr_kcal_per_day: Math.round(bmr),
          tdee_kcal_per_day: Math.round(tdee),
          formula: "Mifflin-St Jeor",
          activity_level,
          disclaimer:
            "Estimate only. Does not account for illness state, body composition, pregnancy, or " +
            "clinical condition (e.g. burns, critical illness) — use appropriate stress/injury factors " +
            "and clinical judgement for patient care decisions.",
        });
      }
    )
  );
}
