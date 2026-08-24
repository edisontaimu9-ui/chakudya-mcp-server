import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, safeTool } from "../utils/toolResult.js";
import wfaGirlsLms from "../data/who/wfa-girls-lms.json" with { type: "json" };
import wfaBoysLms from "../data/who/wfa-boys-lms.json" with { type: "json" };
import lhfaGirlsLms from "../data/who/lhfa-girls-lms.json" with { type: "json" };
import lhfaBoysLms from "../data/who/lhfa-boys-lms.json" with { type: "json" };
import bfaGirlsLms from "../data/who/bfa-girls-lms.json" with { type: "json" };
import bfaBoysLms from "../data/who/bfa-boys-lms.json" with { type: "json" };

/**
 * WHO Child Growth Standards z-score / percentile calculator (LMS method).
 *
 * Source: WHO Child Growth Standards "expanded tables" (z-scores), which
 * give daily L, M, S parameters from birth to 5 years (1856 days), by sex.
 * https://www.who.int/tools/child-growth-standards/standards
 *
 * Loaded so far: weight-for-age, height/length-for-age, BMI-for-age (0-5y
 * WHO Child Growth Standards only — the WHO Reference 2007 BMI-for-age for
 * ages 5-19y is a separate dataset not yet loaded). Additional standards
 * (head-circumference-for-age, weight-for-length/height) will be added
 * here once their expanded LMS tables are supplied — do not fabricate
 * LMS values for standards not yet loaded.
 *
 * Pure calculation — no Chakudya API calls. Educational/clinical-support
 * estimate only, not a substitute for a clinician's growth assessment
 * (which should also consider growth trajectory over time, not a single
 * point-in-time z-score).
 */

const DISCLAIMER =
  "Estimate only, computed from the WHO Child Growth Standards LMS method. A single measurement is not a " +
  "substitute for tracking growth trajectory over time and clinical assessment.";

// [day, L, M, S]
type LmsRow = [number, number, number, number];

const LMS_TABLES: Record<string, Record<"male" | "female", LmsRow[]>> = {
  weight_for_age: {
    female: wfaGirlsLms as unknown as LmsRow[],
    male: wfaBoysLms as unknown as LmsRow[],
  },
  height_for_age: {
    female: lhfaGirlsLms as unknown as LmsRow[],
    male: lhfaBoysLms as unknown as LmsRow[],
  },
  bmi_for_age_0_5y: {
    female: bfaGirlsLms as unknown as LmsRow[],
    male: bfaBoysLms as unknown as LmsRow[],
  },
};

const AVAILABLE_STANDARDS = Object.keys(LMS_TABLES);

function lmsAtDay(rows: LmsRow[], ageDays: number): { L: number; M: number; S: number } | null {
  if (ageDays < rows[0][0] || ageDays > rows[rows.length - 1][0]) return null;

  // Rows are indexed by integer day starting at 0, so this is a direct/interpolated lookup.
  const lowIdx = Math.floor(ageDays);
  const highIdx = Math.ceil(ageDays);
  const low = rows[lowIdx];
  const high = rows[highIdx];
  if (!low || !high) return null;
  if (lowIdx === highIdx) return { L: low[1], M: low[2], S: low[3] };

  const frac = ageDays - lowIdx;
  return {
    L: low[1] + (high[1] - low[1]) * frac,
    M: low[2] + (high[2] - low[2]) * frac,
    S: low[3] + (high[3] - low[3]) * frac,
  };
}

function lmsZScore(value: number, L: number, M: number, S: number): number {
  if (Math.abs(L) < 1e-9) return Math.log(value / M) / S;
  return (Math.pow(value / M, L) - 1) / (L * S);
}

// Abramowitz & Stegun normal CDF approximation.
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  let prob = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (z > 0) prob = 1 - prob;
  return prob;
}

function classify(z: number, standard: string): string {
  // WHO cutoffs are similar across standards but the clinical label differs
  // by which direction of z-score is "underweight"/"overweight"-flavoured.
  if (standard === "weight_for_age") {
    if (z < -3) return "severely underweight";
    if (z < -2) return "underweight";
    if (z > 2) return "possible growth/overweight concern (weight-for-age is not used alone to assess overweight)";
    return "normal";
  }
  if (standard === "height_for_age") {
    if (z < -3) return "severely stunted";
    if (z < -2) return "stunted";
    return "normal";
  }
  if (standard === "bmi_for_age_0_5y") {
    if (z < -3) return "severely wasted";
    if (z < -2) return "wasted";
    if (z > 3) return "obese";
    if (z > 2) return "overweight";
    if (z > 1) return "possible risk of overweight";
    return "normal";
  }
  if (z < -3) return "severely low";
  if (z < -2) return "low";
  if (z > 3) return "very high";
  if (z > 2) return "high";
  return "normal";
}

function ageDaysFrom(ageDays?: number, ageMonths?: number, ageYears?: number): number | null {
  if (ageDays !== undefined) return ageDays;
  if (ageMonths !== undefined) return ageMonths * 30.4375;
  if (ageYears !== undefined) return ageYears * 365.25;
  return null;
}

export function registerWhoGrowthTools(server: McpServer) {
  server.registerTool(
    "who_growth_zscore",
    {
      title: "WHO Child Growth Standards Z-Score Calculator",
      description:
        `Compute a WHO Child Growth Standards z-score and approximate percentile for a measurement, using ` +
        `the LMS method against WHO's daily-resolution expanded tables (birth to 5 years for weight/height/ ` +
        `BMI). Currently supports: ${AVAILABLE_STANDARDS.join(", ")}. More standards ` +
        `(head-circumference-for-age, weight-for-length/height, and the WHO Reference 2007 BMI-for-age for ` +
        `ages 5-19y) will be added as their reference tables are loaded — calling this tool with an ` +
        `unsupported standard returns an error rather than a guess. ` +
        `Provide age as age_days, age_months, or age_years (any one).`,
      inputSchema: {
        standard: z.enum(AVAILABLE_STANDARDS as [string, ...string[]]),
        sex: z.enum(["male", "female"]),
        value: z.number().positive().describe("The measurement in the standard's units (kg for weight_for_age, cm for height_for_age, kg/m^2 for bmi_for_age_0_5y)"),
        age_days: z.number().nonnegative().optional(),
        age_months: z.number().nonnegative().optional(),
        age_years: z.number().nonnegative().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("who_growth_zscore", async ({ standard, sex, value, age_days, age_months, age_years }) => {
      const table = LMS_TABLES[standard];
      if (!table) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Standard "${standard}" is not loaded yet. Available: ${AVAILABLE_STANDARDS.join(", ")}.`,
            },
          ],
          isError: true as const,
        };
      }

      const ageDays = ageDaysFrom(age_days, age_months, age_years);
      if (ageDays === null) {
        return {
          content: [{ type: "text" as const, text: "Provide age_days, age_months, or age_years." }],
          isError: true as const,
        };
      }

      const rows = table[sex];
      const lms = lmsAtDay(rows, ageDays);
      if (!lms) {
        return {
          content: [
            {
              type: "text" as const,
              text: `age (${ageDays.toFixed(1)} days) is outside this table's range (0-${rows[rows.length - 1][0]} days, i.e. birth to 5 years).`,
            },
          ],
          isError: true as const,
        };
      }

      const zScore = lmsZScore(value, lms.L, lms.M, lms.S);
      const percentile = normalCdf(zScore) * 100;

      return ok({
        standard,
        sex,
        age_days: Math.round(ageDays * 10) / 10,
        value,
        z_score: Math.round(zScore * 100) / 100,
        percentile: Math.round(percentile * 10) / 10,
        classification: classify(zScore, standard),
        lms_parameters: { L: lms.L, M: lms.M, S: lms.S },
        disclaimer: DISCLAIMER,
      });
    })
  );
}
