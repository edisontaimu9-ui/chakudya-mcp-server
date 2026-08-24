import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, safeTool } from "../utils/toolResult.js";

/**
 * Pediatric clinical nutrition calculators.
 *
 * Source: BND 415 Clinical Nutrition — Paediatric Medicine Resources
 * (Holliday-Segar, Schofield 1985, WHO 1985, DRI/FAO 2004, DRI/IOM 2006,
 * IOM 2005 protein RDA, ASPEN Paediatric and Neonatal Nutrition Support
 * Handbook 3rd ed. growth velocity / preterm / enteral feed tables).
 *
 * Pure calculation / table lookup — no Chakudya API calls. Educational and
 * clinical-support estimates only, not a substitute for individualized
 * dietetic assessment.
 */

const PEDS_DISCLAIMER =
  "Estimate/reference only, derived from published pediatric nutrition support formulas and tables. " +
  "Not a substitute for individualized clinical assessment and judgement.";

// ── DRI/FAO (2004) TEE tables (kcal/kg/d) ───────────────────────────────────
const FAO_TEE_MONTHS: Array<{ maxMonth: number; girls: number; boys: number }> = [
  { maxMonth: 1, girls: 107, boys: 113 },
  { maxMonth: 2, girls: 101, boys: 104 },
  { maxMonth: 3, girls: 94, boys: 95 },
  { maxMonth: 4, girls: 84, boys: 82 },
  { maxMonth: 5, girls: 83, boys: 81 },
  { maxMonth: 6, girls: 82, boys: 81 },
  { maxMonth: 7, girls: 78, boys: 79 },
  { maxMonth: 8, girls: 78, boys: 79 },
  { maxMonth: 9, girls: 78, boys: 79 },
  { maxMonth: 10, girls: 79, boys: 80 },
  { maxMonth: 11, girls: 79, boys: 80 },
  { maxMonth: 12, girls: 79, boys: 81 },
];

const FAO_TEE_YEARS: Array<{ maxYear: number; girls: number; boys: number }> = [
  { maxYear: 2, girls: 80, boys: 82 },
  { maxYear: 3, girls: 81, boys: 84 },
  { maxYear: 4, girls: 77, boys: 80 },
  { maxYear: 5, girls: 74, boys: 77 },
  { maxYear: 6, girls: 72, boys: 75 },
  { maxYear: 7, girls: 69, boys: 73 },
  { maxYear: 8, girls: 67, boys: 71 },
  { maxYear: 9, girls: 64, boys: 69 },
  { maxYear: 10, girls: 61, boys: 67 },
  { maxYear: 11, girls: 58, boys: 65 },
  { maxYear: 12, girls: 55, boys: 62 },
  { maxYear: 13, girls: 52, boys: 60 },
  { maxYear: 14, girls: 49, boys: 58 },
  { maxYear: 15, girls: 47, boys: 56 },
  { maxYear: 16, girls: 45, boys: 53 },
  { maxYear: 17, girls: 44, boys: 52 },
  { maxYear: 18, girls: 44, boys: 50 },
];

// ── DRI/IOM (2006) physical activity coefficients (3-18y) ──────────────────
const IOM_PA_COEFFICIENTS = {
  boys: { sedentary: 1.0, low_active: 1.13, active: 1.26, very_active: 1.42 },
  girls: { sedentary: 1.0, low_active: 1.16, active: 1.31, very_active: 1.56 },
} as const;

// ── IOM (2005) protein RDA ──────────────────────────────────────────────────
const IOM_PROTEIN_RDA: Array<{ label: string; maxMonths: number | null; gPerKg: number }> = [
  { label: "1-6 months", maxMonths: 6, gPerKg: 1.52 },
  { label: "6-12 months", maxMonths: 12, gPerKg: 1.5 },
  { label: "1-3 years", maxMonths: 36, gPerKg: 1.1 },
  { label: "4-13 years", maxMonths: 13 * 12, gPerKg: 0.95 },
  { label: "14-18 years", maxMonths: null, gPerKg: 0.85 },
];

// ── ASPEN protein dosing for sick children ──────────────────────────────────
const ASPEN_PROTEIN_SICK: Array<{ label: string; maxYears: number | null; range: string; midGPerKg: number }> = [
  { label: "0-2 years", maxYears: 2, range: "3 g/kg/d", midGPerKg: 3 },
  { label: "2-13 years", maxYears: 13, range: "1.5-2 g/kg/d", midGPerKg: 1.75 },
  { label: "13-18 years", maxYears: null, range: "1.5 g/kg/d", midGPerKg: 1.5 },
];

// ── Preterm infant reference (enteral) ──────────────────────────────────────
const PRETERM_PROTEIN: Array<{ label: string; maxG: number | null; range: string; midGPerKg: number }> = [
  { label: "Birth/current wt <1000 g", maxG: 1000, range: "3.5-4.5 g/kg/d", midGPerKg: 4.0 },
  { label: "1000-1500 g", maxG: 1500, range: "3.5-4.5 g/kg/d", midGPerKg: 4.0 },
  { label: "1500-2000 g", maxG: 2000, range: "3-4 g/kg/d", midGPerKg: 3.5 },
  { label: "2000-2500 g", maxG: 2500, range: "2.5-3.5 g/kg/d", midGPerKg: 3.0 },
  { label: ">2500 g", maxG: null, range: "2-2.5 g/kg/d", midGPerKg: 2.25 },
];

// ── Term infant/child growth velocity (ASPEN handbook) ──────────────────────
const TERM_GROWTH_MONTHS: Array<{
  label: string;
  maxMonth: number;
  girlsWeight: string;
  boysWeight: string;
  length: string;
}> = [
  { label: "0-1 mo", maxMonth: 1, girlsWeight: "22-42 g/d", boysWeight: "24-48 g/d", length: "0.8-1.1 mm/d" },
  { label: "1-2 mo", maxMonth: 2, girlsWeight: "24-43 g/d", boysWeight: "30-51 g/d", length: "0.8-1.1 mm/d" },
  { label: "2-3 mo", maxMonth: 3, girlsWeight: "16-23 g/d", boysWeight: "19-36 g/d", length: "0.8-1.1 mm/d" },
  { label: "3-6 mo", maxMonth: 6, girlsWeight: "21-21 g/d", boysWeight: "13-23 g/d", length: "0.5-0.85 mm/d" },
  { label: "6-9 mo", maxMonth: 9, girlsWeight: "6-15 g/d", boysWeight: "7-15 g/d", length: "0.4-0.55 mm/d" },
  { label: "9-12 mo", maxMonth: 12, girlsWeight: "4-12 g/d", boysWeight: "4-12 g/d", length: "0.4-0.55 mm/d" },
  { label: "12-18 mo", maxMonth: 18, girlsWeight: "4-10 g/d", boysWeight: "4-10 g/d", length: "0.37 mm/d (girls), 0.36 mm/d (boys)" },
  { label: "18-24 mo", maxMonth: 24, girlsWeight: "4-10 g/d", boysWeight: "4-9 g/d", length: "0.31 mm/d (girls), 0.30 mm/d (boys)" },
];

const TERM_GROWTH_YEARS: Array<{ label: string; maxYear: number; weight: string; height: string }> = [
  { label: "2-<4 y", maxYear: 4, weight: "3.5-5 g/d", height: "0.15-0.23 mm/d" },
  { label: "4-7 y", maxYear: 7, weight: "4.5-6.5 g/d", height: "0.16 mm/d" },
  { label: "7-<9 y", maxYear: 9, weight: "5-8.5 g/d", height: "0.13-0.16 mm/d" },
  { label: "9-<10 y", maxYear: 10, weight: "6-10 g/d", height: "0.09-0.13 mm/d" },
  { label: "10-<11 y", maxYear: 11, weight: "7-11 g/d", height: "0.09-0.15 mm/d" },
];

const PRETERM_GROWTH_REFERENCE = {
  initial_weight_loss: "Lose <= 15% of birth weight; regain by 10-14 days",
  weight: "15-20 g/kg/d (daily)",
  length: "> 1 cm/week (weekly)",
  head_circumference: "0.8-1 cm/week (weekly)",
};

// ── Enteral feed initiation & advancement (Peds & Nutrition Support Handbook, 3rd ed. 2024)
const ENTERAL_FEEDS: Array<{
  label: string;
  maxYears: number | null;
  continuous: { initiation: string; advancement: string; goalVolume: string };
  bolus: { initiation: string; advancement: string; goalVolume: string };
}> = [
  {
    label: "0-12 months",
    maxYears: 1,
    continuous: { initiation: "1-2 mL/kg/hr", advancement: "1-2 mL/kg Q2-8H", goalVolume: "6 mL/kg/hr" },
    bolus: { initiation: "10-15 mL/kg", advancement: "10-30 mL/feed Q2-3H", goalVolume: "20-30 mL/kg Q3-5H" },
  },
  {
    label: "1-6 years",
    maxYears: 6,
    continuous: { initiation: "1 mL/kg/hr", advancement: "1 mL/kg Q2-8H", goalVolume: "Up to 6 mL/kg/hr" },
    bolus: { initiation: "5-10 mL/kg", advancement: "30-45 mL/feed Q3H", goalVolume: "15-20 mL/kg Q4-6H" },
  },
  {
    label: "> 7 years",
    maxYears: null,
    continuous: { initiation: "25 mL/hr", advancement: "25 mL Q2-8H", goalVolume: "100-150 mL/hr" },
    bolus: { initiation: "90-120 mL", advancement: "60-90 mL/feed Q3-4H", goalVolume: "240-480 mL Q4-6H" },
  },
];

const PRETERM_ENTERAL_REQUIREMENTS = {
  fluid_ml_per_kg_per_day: "120-200 mL/kg/d",
  energy_kcal_per_kg_per_day: "110-130 kcal/kg/day",
};

// ── Macronutrient distribution range (% of kcal) ────────────────────────────
const MACRO_RANGES: Array<{ label: string; maxMonths: number | null; carb: [number, number]; fat: [number, number]; protein: [number, number] }> = [
  { label: "Full-term infant", maxMonths: 12, carb: [35, 65], fat: [30, 55], protein: [7, 16] },
  { label: "1-3 years", maxMonths: 36, carb: [45, 65], fat: [30, 40], protein: [5, 20] },
  { label: "4-18 years", maxMonths: null, carb: [45, 65], fat: [25, 35], protein: [10, 30] },
];

function pick<T extends { maxMonth?: number | null; maxYear?: number | null; maxYears?: number | null; maxMonths?: number | null; maxG?: number | null }>(
  table: T[],
  value: number,
  key: "maxMonth" | "maxYear" | "maxYears" | "maxMonths" | "maxG"
): T {
  for (const row of table) {
    const bound = row[key];
    if (bound === null || bound === undefined || value <= bound) return row;
  }
  return table[table.length - 1];
}

export function registerPediatricTools(server: McpServer) {
  // ── pediatric_fluid_requirements ──────────────────────────────────────────
  server.registerTool(
    "pediatric_fluid_requirements",
    {
      title: "Pediatric Fluid Requirements (Holliday-Segar)",
      description:
        "Compute daily maintenance fluid requirement for a child using the Holliday-Segar method, given " +
        "body weight in kg. Returns total mL/day and mL/hr.",
      inputSchema: {
        weight_kg: z.number().positive(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("pediatric_fluid_requirements", async ({ weight_kg }) => {
      let mlPerDayLow: number;
      let mlPerDayHigh: number;
      let basis: string;

      if (weight_kg <= 10) {
        mlPerDayLow = weight_kg * 100;
        mlPerDayHigh = weight_kg * 150;
        basis = "100-150 mL/kg (0-10 kg bracket)";
      } else if (weight_kg <= 20) {
        const total = 1000 + (weight_kg - 10) * 50;
        mlPerDayLow = mlPerDayHigh = total;
        basis = "1000 mL + 50 mL/kg for each kg > 10 kg (11-20 kg bracket)";
      } else {
        const total = 1500 + (weight_kg - 20) * 20;
        mlPerDayLow = mlPerDayHigh = total;
        basis = "1500 mL + 20 mL/kg for each kg > 20 kg (>20 kg bracket)";
      }

      return ok({
        weight_kg,
        method: "Holliday-Segar",
        maintenance_fluid_ml_per_day:
          mlPerDayLow === mlPerDayHigh
            ? Math.round(mlPerDayLow)
            : { low: Math.round(mlPerDayLow), high: Math.round(mlPerDayHigh) },
        maintenance_fluid_ml_per_hr:
          mlPerDayLow === mlPerDayHigh
            ? Math.round((mlPerDayLow / 24) * 10) / 10
            : { low: Math.round((mlPerDayLow / 24) * 10) / 10, high: Math.round((mlPerDayHigh / 24) * 10) / 10 },
        basis,
        disclaimer: PEDS_DISCLAIMER,
      });
    })
  );

  // ── pediatric_energy_requirements ─────────────────────────────────────────
  server.registerTool(
    "pediatric_energy_requirements",
    {
      title: "Pediatric Energy Requirements (BMR/TEE)",
      description:
        "Estimate pediatric BMR and/or Total Energy Expenditure using one of four published methods: " +
        "'schofield_bmr' (Schofield 1985, needs weight_kg + height_cm), 'who_bmr' (WHO 1985, needs weight_kg " +
        "only), 'dri_fao_2004' (direct kcal/kg/d TEE table lookup by age, needs weight_kg), or " +
        "'dri_iom_2006' (DRI/IOM 2006 EER equations — infants 0-3y need weight_kg only; children 3-18y also " +
        "need height_cm and physical_activity_level). For schofield_bmr/who_bmr, optionally supply " +
        "activity_factor and/or stress_factor (from the published ranges: activity 1.0-2.15, stress " +
        "0.7-2.5) to scale BMR up to an estimated TEE.",
      inputSchema: {
        method: z.enum(["schofield_bmr", "who_bmr", "dri_fao_2004", "dri_iom_2006"]),
        sex: z.enum(["male", "female"]),
        weight_kg: z.number().positive(),
        height_cm: z.number().positive().optional(),
        age_years: z.number().nonnegative().optional(),
        age_months: z.number().nonnegative().optional(),
        activity_factor: z.number().positive().optional().describe("Multiplier applied to BMR, e.g. 1.0-2.15"),
        stress_factor: z.number().positive().optional().describe("Multiplier applied to BMR, e.g. 0.7-2.5"),
        physical_activity_level: z
          .enum(["sedentary", "low_active", "active", "very_active"])
          .optional()
          .describe("Required for dri_iom_2006 when age >= 3 years"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool(
      "pediatric_energy_requirements",
      async ({
        method,
        sex,
        weight_kg,
        height_cm,
        age_years,
        age_months,
        activity_factor,
        stress_factor,
        physical_activity_level,
      }) => {
        const ageYears = age_years ?? (age_months !== undefined ? age_months / 12 : undefined);

        if (method === "schofield_bmr" || method === "who_bmr") {
          if (ageYears === undefined) {
            return {
              content: [{ type: "text" as const, text: "age_years or age_months is required for this method." }],
              isError: true as const,
            };
          }
          if (method === "schofield_bmr" && height_cm === undefined) {
            return {
              content: [{ type: "text" as const, text: "height_cm is required for schofield_bmr." }],
              isError: true as const,
            };
          }

          let bmr: number;
          let equation: string;

          if (method === "schofield_bmr") {
            const ht = height_cm as number;
            if (ageYears < 3) {
              bmr = sex === "male" ? 0.17 * weight_kg + 15.17 * ht - 617.6 : 16.25 * weight_kg + 10.232 * ht - 413.5;
              equation = "Schofield 0-3y";
            } else if (ageYears < 10) {
              bmr = sex === "male" ? 19.6 * weight_kg + 1.303 * ht + 414.9 : 16.97 * weight_kg + 1.618 * ht + 371.2;
              equation = "Schofield 3-10y";
            } else {
              bmr = sex === "male" ? 16.25 * weight_kg + 1.372 * ht + 515.5 : 8.365 * weight_kg + 4.65 * ht + 200;
              equation = "Schofield 10-18y";
            }
          } else {
            if (ageYears < 3) {
              bmr = sex === "male" ? 60.9 * weight_kg - 54 : 61 * weight_kg - 51;
              equation = "WHO 0-3y";
            } else if (ageYears < 10) {
              bmr = sex === "male" ? 22.7 * weight_kg + 495 : 22.5 * weight_kg + 499;
              equation = "WHO 3-10y";
            } else {
              bmr = sex === "male" ? 17.5 * weight_kg + 651 : 12.2 * weight_kg + 746;
              equation = "WHO 10-18y";
            }
          }

          const multiplier = (activity_factor ?? 1) * (stress_factor ?? 1);
          const tee = bmr * multiplier;

          return ok({
            method: equation,
            bmr_kcal_per_day: Math.round(bmr),
            activity_factor: activity_factor ?? null,
            stress_factor: stress_factor ?? null,
            estimated_tee_kcal_per_day:
              activity_factor || stress_factor ? Math.round(tee) : null,
            disclaimer: PEDS_DISCLAIMER,
          });
        }

        if (method === "dri_fao_2004") {
          let kcalPerKg: number;
          let bracketLabel: string;

          if (age_months !== undefined && age_months <= 12) {
            const row = pick(FAO_TEE_MONTHS, age_months, "maxMonth");
            kcalPerKg = sex === "male" ? row.boys : row.girls;
            bracketLabel = `${row.maxMonth === 1 ? "0" : row.maxMonth - 1}-${row.maxMonth} months`;
          } else if (ageYears !== undefined) {
            const row = pick(FAO_TEE_YEARS, ageYears, "maxYear");
            kcalPerKg = sex === "male" ? row.boys : row.girls;
            bracketLabel = `${row.maxYear - 1}-${row.maxYear} years`;
          } else {
            return {
              content: [{ type: "text" as const, text: "age_years or age_months is required for dri_fao_2004." }],
              isError: true as const,
            };
          }

          return ok({
            method: "DRI/FAO (2004) TEE",
            age_bracket: bracketLabel,
            kcal_per_kg_per_day: kcalPerKg,
            total_tee_kcal_per_day: Math.round(kcalPerKg * weight_kg),
            disclaimer: PEDS_DISCLAIMER,
          });
        }

        // dri_iom_2006
        if (ageYears === undefined) {
          return {
            content: [{ type: "text" as const, text: "age_years or age_months is required for dri_iom_2006." }],
            isError: true as const,
          };
        }

        if (ageYears < 3) {
          const ageMonths = age_months ?? ageYears * 12;
          let addend: number;
          let bracketLabel: string;
          if (ageMonths <= 3) {
            addend = 175;
            bracketLabel = "0-3 months";
          } else if (ageMonths <= 6) {
            addend = 56;
            bracketLabel = "4-6 months";
          } else if (ageMonths <= 12) {
            addend = 22;
            bracketLabel = "7-12 months";
          } else {
            addend = 20;
            bracketLabel = "13-35 months";
          }
          const eer = 89 * weight_kg - 100 + addend;

          return ok({
            method: "DRI/IOM (2006) EER, 0-3y",
            age_bracket: bracketLabel,
            eer_kcal_per_day: Math.round(eer),
            disclaimer: PEDS_DISCLAIMER,
          });
        }

        if (height_cm === undefined) {
          return {
            content: [{ type: "text" as const, text: "height_cm is required for dri_iom_2006 when age >= 3 years." }],
            isError: true as const,
          };
        }
        const pal = physical_activity_level ?? "sedentary";
        const pa = sex === "male" ? IOM_PA_COEFFICIENTS.boys[pal] : IOM_PA_COEFFICIENTS.girls[pal];
        const htM = height_cm / 100;
        const kcalAddend = ageYears < 9 ? 20 : 25;
        const bracketLabel = ageYears < 9 ? "3-8 years" : "9-18 years";

        const eer =
          sex === "male"
            ? 88.5 - 61.9 * ageYears + pa * (26.7 * weight_kg + 903 * htM) + kcalAddend
            : 135.3 - 30.8 * ageYears + pa * (10 * weight_kg + 934 * htM) + kcalAddend;

        return ok({
          method: "DRI/IOM (2006) EER, 3-18y",
          age_bracket: bracketLabel,
          physical_activity_level: pal,
          pa_coefficient: pa,
          eer_kcal_per_day: Math.round(eer),
          disclaimer: PEDS_DISCLAIMER,
        });
      }
    )
  );

  // ── pediatric_protein_requirements ────────────────────────────────────────
  server.registerTool(
    "pediatric_protein_requirements",
    {
      title: "Pediatric Protein Requirements",
      description:
        "Look up pediatric protein requirement (g/kg/d) from a published source and compute total g/day for " +
        "a given weight. Sources: 'iom_2005' (healthy growth RDA, by age in months/years), 'aspen_sick' " +
        "(ASPEN dosing guideline for sick children, by age in years), or 'preterm' (ASPEN enteral preterm " +
        "infant protein by birth/current weight in grams — pass weight_kg as normal, it is converted).",
      inputSchema: {
        source: z.enum(["iom_2005", "aspen_sick", "preterm"]),
        weight_kg: z.number().positive(),
        age_years: z.number().nonnegative().optional(),
        age_months: z.number().nonnegative().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("pediatric_protein_requirements", async ({ source, weight_kg, age_years, age_months }) => {
      if (source === "preterm") {
        const weightG = weight_kg * 1000;
        const row = pick(PRETERM_PROTEIN, weightG, "maxG");
        return ok({
          source: "ASPEN preterm infant (enteral)",
          weight_bracket: row.label,
          protein_g_per_kg_per_day: row.range,
          total_g_per_day_estimate: Math.round(row.midGPerKg * weight_kg * 10) / 10,
          disclaimer: PEDS_DISCLAIMER,
        });
      }

      const ageMonths = age_months ?? (age_years !== undefined ? age_years * 12 : undefined);
      if (ageMonths === undefined) {
        return {
          content: [{ type: "text" as const, text: "age_years or age_months is required." }],
          isError: true as const,
        };
      }

      if (source === "iom_2005") {
        const row = pick(IOM_PROTEIN_RDA, ageMonths, "maxMonths");
        return ok({
          source: "IOM (2005) RDA for healthy growth",
          age_bracket: row.label,
          protein_g_per_kg_per_day: row.gPerKg,
          total_g_per_day: Math.round(row.gPerKg * weight_kg * 10) / 10,
          disclaimer: PEDS_DISCLAIMER,
        });
      }

      // aspen_sick
      const ageYears = ageMonths / 12;
      const row = pick(ASPEN_PROTEIN_SICK, ageYears, "maxYears");
      return ok({
        source: "ASPEN guideline dosing for sick children",
        age_bracket: row.label,
        protein_g_per_kg_per_day: row.range,
        total_g_per_day_estimate: Math.round(row.midGPerKg * weight_kg * 10) / 10,
        disclaimer: PEDS_DISCLAIMER,
      });
    })
  );

  // ── pediatric_growth_velocity ─────────────────────────────────────────────
  server.registerTool(
    "pediatric_growth_velocity",
    {
      title: "Pediatric Growth Velocity Reference",
      description:
        "Look up expected/reference growth velocity (weight gain, linear growth) from the ASPEN Paediatric " +
        "and Neonatal Nutrition Support Handbook, 3rd edition. Set preterm=true for the preterm infant " +
        "reference (initial weight loss, weight/length/HC velocity — no age input needed). Otherwise pass " +
        "age_months (0-24, sex-specific) or age_years (2-11, not sex-specific) for term infants/children.",
      inputSchema: {
        preterm: z.boolean().optional().default(false),
        sex: z.enum(["male", "female"]).optional().describe("Required for term infants age_months <= 24"),
        age_months: z.number().nonnegative().optional(),
        age_years: z.number().nonnegative().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("pediatric_growth_velocity", async ({ preterm, sex, age_months, age_years }) => {
      if (preterm) {
        return ok({
          source: "ASPEN Paediatric and Neonatal Nutrition Support Handbook, 3rd ed. — preterm infants",
          reference: PRETERM_GROWTH_REFERENCE,
          disclaimer: PEDS_DISCLAIMER,
        });
      }

      if (age_months !== undefined) {
        if (!sex) {
          return {
            content: [{ type: "text" as const, text: "sex is required for term infant growth velocity (age_months)." }],
            isError: true as const,
          };
        }
        const row = pick(TERM_GROWTH_MONTHS, age_months, "maxMonth");
        return ok({
          source: "ASPEN Paediatric and Neonatal Nutrition Support Handbook, 3rd ed. — term infants",
          age_bracket: row.label,
          weight_velocity: sex === "male" ? row.boysWeight : row.girlsWeight,
          length_velocity: row.length,
          disclaimer: PEDS_DISCLAIMER,
        });
      }

      if (age_years !== undefined) {
        const row = pick(TERM_GROWTH_YEARS, age_years, "maxYear");
        return ok({
          source: "ASPEN Paediatric and Neonatal Nutrition Support Handbook, 3rd ed. — term children",
          age_bracket: row.label,
          weight_velocity: row.weight,
          height_velocity: row.height,
          disclaimer: PEDS_DISCLAIMER,
        });
      }

      return {
        content: [
          { type: "text" as const, text: "Provide preterm=true, or age_months (0-24), or age_years (2-11)." },
        ],
        isError: true as const,
      };
    })
  );

  // ── pediatric_enteral_feed_advancement ────────────────────────────────────
  server.registerTool(
    "pediatric_enteral_feed_advancement",
    {
      title: "Pediatric Enteral Feed Initiation & Advancement",
      description:
        "Look up initiation, advancement, and goal volume guidance for pediatric enteral feeds (continuous " +
        "or bolus) by age, from the Pediatric and Nutrition Support Handbook, 3rd edition (2024).",
      inputSchema: {
        age_years: z.number().nonnegative(),
        feed_type: z.enum(["continuous", "bolus"]).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("pediatric_enteral_feed_advancement", async ({ age_years, feed_type }) => {
      const row = pick(ENTERAL_FEEDS, age_years, "maxYears");
      const result: Record<string, unknown> = {
        source: "Pediatric and Nutrition Support Handbook, 3rd edition (2024)",
        age_bracket: row.label,
      };
      if (!feed_type || feed_type === "continuous") result.continuous_feeds = row.continuous;
      if (!feed_type || feed_type === "bolus") result.bolus_feeds = row.bolus;
      result.disclaimer = PEDS_DISCLAIMER;
      return ok(result);
    })
  );

  // ── preterm_fluid_energy_requirements ─────────────────────────────────────
  server.registerTool(
    "preterm_fluid_energy_requirements",
    {
      title: "Preterm Infant Fluid & Energy Requirements",
      description:
        "Look up estimated enteral fluid and energy requirements for preterm infants (BND 415 Paediatric " +
        "Medicine Resources). Returns the reference mL/kg/d and kcal/kg/day ranges, plus totals for the " +
        "given weight using the range midpoints. Pair with pediatric_protein_requirements(source='preterm') " +
        "for the matching protein target.",
      inputSchema: {
        weight_kg: z.number().positive(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("preterm_fluid_energy_requirements", async ({ weight_kg }) => {
      return ok({
        source: "BND 415 Paediatric Medicine Resources — preterm infants (enteral)",
        weight_kg,
        fluid_ml_per_kg_per_day: PRETERM_ENTERAL_REQUIREMENTS.fluid_ml_per_kg_per_day,
        fluid_ml_per_day_estimate: { low: Math.round(weight_kg * 120), high: Math.round(weight_kg * 200) },
        energy_kcal_per_kg_per_day: PRETERM_ENTERAL_REQUIREMENTS.energy_kcal_per_kg_per_day,
        energy_kcal_per_day_estimate: { low: Math.round(weight_kg * 110), high: Math.round(weight_kg * 130) },
        disclaimer: PEDS_DISCLAIMER,
      });
    })
  );

  // ── macronutrient_distribution_check ──────────────────────────────────────
  server.registerTool(
    "macronutrient_distribution_check",
    {
      title: "Macronutrient Distribution Range Check",
      description:
        "Look up the DRI acceptable macronutrient distribution range (% of kcal from carbohydrate, fat, " +
        "protein) for a pediatric age group (BND 415 Paediatric Medicine Resources), and optionally check " +
        "whether a proposed diet's percentages fall inside those ranges.",
      inputSchema: {
        age_months: z.number().nonnegative().optional(),
        age_years: z.number().nonnegative().optional(),
        proposed_carb_percent: z.number().min(0).max(100).optional(),
        proposed_fat_percent: z.number().min(0).max(100).optional(),
        proposed_protein_percent: z.number().min(0).max(100).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool(
      "macronutrient_distribution_check",
      async ({ age_months, age_years, proposed_carb_percent, proposed_fat_percent, proposed_protein_percent }) => {
        const months = age_months ?? (age_years !== undefined ? age_years * 12 : undefined);
        if (months === undefined) return { content: [{ type: "text" as const, text: "age_months or age_years is required." }], isError: true as const };

        const row = pick(MACRO_RANGES, months, "maxMonths");
        const inRange = (val: number | undefined, range: [number, number]) =>
          val === undefined ? null : val >= range[0] && val <= range[1];

        return ok({
          source: "BND 415 Paediatric Medicine Resources — macronutrient distribution range",
          age_bracket: row.label,
          carbohydrate_percent_range: row.carb,
          fat_percent_range: row.fat,
          protein_percent_range: row.protein,
          proposed_check:
            proposed_carb_percent === undefined && proposed_fat_percent === undefined && proposed_protein_percent === undefined
              ? null
              : {
                  carbohydrate_in_range: inRange(proposed_carb_percent, row.carb),
                  fat_in_range: inRange(proposed_fat_percent, row.fat),
                  protein_in_range: inRange(proposed_protein_percent, row.protein),
                },
          disclaimer: PEDS_DISCLAIMER,
        });
      }
    )
  );
}
