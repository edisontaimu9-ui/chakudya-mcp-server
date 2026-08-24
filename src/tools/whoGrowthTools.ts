import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, safeTool } from "../utils/toolResult.js";
import wfaGirlsLms from "../data/who/wfa-girls-lms.json" with { type: "json" };
import wfaBoysLms from "../data/who/wfa-boys-lms.json" with { type: "json" };
import lhfaGirlsLms from "../data/who/lhfa-girls-lms.json" with { type: "json" };
import lhfaBoysLms from "../data/who/lhfa-boys-lms.json" with { type: "json" };
import bfaGirlsLms from "../data/who/bfa-girls-lms.json" with { type: "json" };
import bfaBoysLms from "../data/who/bfa-boys-lms.json" with { type: "json" };
import bmi5to19GirlsLms from "../data/who/bmi5to19-girls-lms.json" with { type: "json" };
import bmi5to19BoysLms from "../data/who/bmi5to19-boys-lms.json" with { type: "json" };

/**
 * WHO growth standard z-score / percentile calculator (LMS method).
 *
 * Two source datasets are combined here:
 * - WHO Child Growth Standards (birth-5y), daily-resolution expanded
 *   tables: weight-for-age, height/length-for-age, BMI-for-age.
 *   https://www.who.int/tools/child-growth-standards/standards
 * - WHO Reference 2007 (5-19y), monthly-resolution expanded tables:
 *   BMI-for-age. https://www.who.int/tools/growth-reference-data-for-5to19-years
 *
 * Additional standards (head-circumference-for-age, weight-for-length/
 * height) will be added here once their expanded LMS tables are supplied
 * — do not fabricate LMS values for standards not yet loaded.
 *
 * Pure calculation — no Chakudya API calls. Educational/clinical-support
 * estimate only, not a substitute for a clinician's growth assessment
 * (which should also consider growth trajectory over time, not a single
 * point-in-time z-score).
 */

const DISCLAIMER =
  "Estimate only, computed from WHO growth reference LMS parameters. A single measurement is not a " +
  "substitute for tracking growth trajectory over time and clinical assessment.";

// [ageKey, L, M, S] — ageKey is in the unit the source table uses (day or month), not always contiguous.
type LmsRow = [number, number, number, number];

type AgeUnit = "day" | "month";

interface StandardEntry {
  unit: AgeUnit;
  female: LmsRow[];
  male: LmsRow[];
  ageRangeLabel: string;
}

const LMS_TABLES: Record<string, StandardEntry> = {
  weight_for_age: {
    unit: "day",
    female: wfaGirlsLms as unknown as LmsRow[],
    male: wfaBoysLms as unknown as LmsRow[],
    ageRangeLabel: "birth to 5 years (WHO Child Growth Standards)",
  },
  height_for_age: {
    unit: "day",
    female: lhfaGirlsLms as unknown as LmsRow[],
    male: lhfaBoysLms as unknown as LmsRow[],
    ageRangeLabel: "birth to 5 years (WHO Child Growth Standards)",
  },
  bmi_for_age_0_5y: {
    unit: "day",
    female: bfaGirlsLms as unknown as LmsRow[],
    male: bfaBoysLms as unknown as LmsRow[],
    ageRangeLabel: "birth to 5 years (WHO Child Growth Standards)",
  },
  bmi_for_age_5_19y: {
    unit: "month",
    female: bmi5to19GirlsLms as unknown as LmsRow[],
    male: bmi5to19BoysLms as unknown as LmsRow[],
    ageRangeLabel: "5 to 19 years (WHO Reference 2007)",
  },
};

const AVAILABLE_STANDARDS = Object.keys(LMS_TABLES);

/** Binary-search + linear-interpolate LMS parameters for an arbitrary age key. Works for both
 * densely-indexed (day 0..N, contiguous) and sparsely-indexed (month 61..228) tables. */
function interpolateLms(rows: LmsRow[], ageKey: number): { L: number; M: number; S: number } | null {
  if (ageKey < rows[0][0] || ageKey > rows[rows.length - 1][0]) return null;

  let lo = 0;
  let hi = rows.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (rows[mid][0] <= ageKey) lo = mid;
    else hi = mid;
  }

  const low = rows[lo];
  const high = rows[hi];
  if (low[0] === ageKey) return { L: low[1], M: low[2], S: low[3] };

  const frac = (ageKey - low[0]) / (high[0] - low[0]);
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
  // WHO cutoffs are similar across standards but the clinical label — and, for BMI, the exact
  // z-score cutoffs — differ between the 0-5y Child Growth Standards and the 5-19y Reference 2007.
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
  if (standard === "bmi_for_age_5_19y") {
    if (z < -3) return "severely thin";
    if (z < -2) return "thin";
    if (z > 2) return "obese";
    if (z > 1) return "overweight";
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
      title: "WHO Growth Standard Z-Score Calculator",
      description:
        `Compute a WHO growth reference z-score and approximate percentile for a measurement, using the ` +
        `LMS method. Currently supports: ${AVAILABLE_STANDARDS.join(", ")} — see each standard's ` +
        `ageRangeLabel in the tool result for its exact source and valid age range (0-5y standards use the ` +
        `WHO Child Growth Standards; bmi_for_age_5_19y uses the separate WHO Reference 2007 dataset). More ` +
        `standards (head-circumference-for-age, weight-for-length/height) will be added as their reference ` +
        `tables are loaded — calling this tool with an unsupported standard or an out-of-range age returns ` +
        `an error rather than a guess. Provide age as age_days, age_months, or age_years (any one).`,
      inputSchema: {
        standard: z.enum(AVAILABLE_STANDARDS as [string, ...string[]]),
        sex: z.enum(["male", "female"]),
        value: z
          .number()
          .positive()
          .describe(
            "The measurement in the standard's units (kg for weight_for_age, cm for height_for_age, kg/m^2 for bmi_for_age_0_5y / bmi_for_age_5_19y)"
          ),
        age_days: z.number().nonnegative().optional(),
        age_months: z.number().nonnegative().optional(),
        age_years: z.number().nonnegative().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("who_growth_zscore", async ({ standard, sex, value, age_days, age_months, age_years }) => {
      const entry = LMS_TABLES[standard];
      if (!entry) {
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

      const rows = entry[sex];
      const ageKey = entry.unit === "day" ? ageDays : ageDays / 30.4375;
      const lms = interpolateLms(rows, ageKey);
      if (!lms) {
        return {
          content: [
            {
              type: "text" as const,
              text: `age is outside this standard's range (${entry.ageRangeLabel}).`,
            },
          ],
          isError: true as const,
        };
      }

      const zScore = lmsZScore(value, lms.L, lms.M, lms.S);
      const percentile = normalCdf(zScore) * 100;

      return ok({
        standard,
        source_age_range: entry.ageRangeLabel,
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
