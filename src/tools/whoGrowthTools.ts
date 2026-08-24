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
import hcfaGirlsLms from "../data/who/hcfa-girls-lms.json" with { type: "json" };
import hcfaBoysLms from "../data/who/hcfa-boys-lms.json" with { type: "json" };
import wflGirlsLms from "../data/who/wfl-girls-lms.json" with { type: "json" };
import wflBoysLms from "../data/who/wfl-boys-lms.json" with { type: "json" };
import wfhGirlsLms from "../data/who/wfh-girls-lms.json" with { type: "json" };
import wfhBoysLms from "../data/who/wfh-boys-lms.json" with { type: "json" };

/**
 * WHO growth standard z-score / percentile calculator (LMS method).
 *
 * Two source datasets are combined here:
 * - WHO Child Growth Standards (birth-5y), expanded tables: weight-for-age,
 *   height/length-for-age, BMI-for-age, head-circumference-for-age
 *   (daily-resolution, keyed by age); weight-for-length (keyed by the
 *   child's recumbent length in cm, 45-110cm); and weight-for-height
 *   (keyed by standing height in cm, 65-120cm) — WHO indexes these last
 *   two by body size, not age.
 *   https://www.who.int/tools/child-growth-standards/standards
 * - WHO Reference 2007 (5-19y), monthly-resolution expanded tables:
 *   BMI-for-age. https://www.who.int/tools/growth-reference-data-for-5to19-years
 *
 * All planned standards are now loaded. If further standards are ever
 * needed, do not fabricate LMS values for ones not yet loaded — add them
 * here the same way once their expanded LMS tables are supplied.
 *
 * Pure calculation — no Chakudya API calls. Educational/clinical-support
 * estimate only, not a substitute for a clinician's growth assessment
 * (which should also consider growth trajectory over time, not a single
 * point-in-time z-score).
 */

const DISCLAIMER =
  "Estimate only, computed from WHO growth reference LMS parameters. A single measurement is not a " +
  "substitute for tracking growth trajectory over time and clinical assessment.";

// [key, L, M, S] — key is in the unit the source table uses (age in day/month, or length/height in cm),
// not always contiguous or integer-stepped.
type LmsRow = [number, number, number, number];

type KeyKind = "age_day" | "age_month" | "length_cm" | "height_cm";

interface StandardEntry {
  keyKind: KeyKind;
  female: LmsRow[];
  male: LmsRow[];
  rangeLabel: string;
}

const LMS_TABLES: Record<string, StandardEntry> = {
  weight_for_age: {
    keyKind: "age_day",
    female: wfaGirlsLms as unknown as LmsRow[],
    male: wfaBoysLms as unknown as LmsRow[],
    rangeLabel: "birth to 5 years (WHO Child Growth Standards)",
  },
  height_for_age: {
    keyKind: "age_day",
    female: lhfaGirlsLms as unknown as LmsRow[],
    male: lhfaBoysLms as unknown as LmsRow[],
    rangeLabel: "birth to 5 years (WHO Child Growth Standards)",
  },
  bmi_for_age_0_5y: {
    keyKind: "age_day",
    female: bfaGirlsLms as unknown as LmsRow[],
    male: bfaBoysLms as unknown as LmsRow[],
    rangeLabel: "birth to 5 years (WHO Child Growth Standards)",
  },
  bmi_for_age_5_19y: {
    keyKind: "age_month",
    female: bmi5to19GirlsLms as unknown as LmsRow[],
    male: bmi5to19BoysLms as unknown as LmsRow[],
    rangeLabel: "5 to 19 years (WHO Reference 2007)",
  },
  head_circumference_for_age: {
    keyKind: "age_day",
    female: hcfaGirlsLms as unknown as LmsRow[],
    male: hcfaBoysLms as unknown as LmsRow[],
    rangeLabel: "birth to 5 years (WHO Child Growth Standards)",
  },
  weight_for_length: {
    keyKind: "length_cm",
    female: wflGirlsLms as unknown as LmsRow[],
    male: wflBoysLms as unknown as LmsRow[],
    rangeLabel: "recumbent length 45-110 cm, i.e. roughly birth to 2 years (WHO Child Growth Standards)",
  },
  weight_for_height: {
    keyKind: "height_cm",
    female: wfhGirlsLms as unknown as LmsRow[],
    male: wfhBoysLms as unknown as LmsRow[],
    rangeLabel: "standing height 65-120 cm, i.e. roughly 2 to 5 years (WHO Child Growth Standards)",
  },
};

const AVAILABLE_STANDARDS = Object.keys(LMS_TABLES);

/** Binary-search + linear-interpolate LMS parameters for an arbitrary key. Works for densely-indexed
 * (day 0..N, contiguous), sparsely-indexed (month 61..228), and fine-stepped (length 45.0..110.0 by 0.1)
 * tables alike. */
function interpolateLms(rows: LmsRow[], key: number): { L: number; M: number; S: number } | null {
  if (key < rows[0][0] || key > rows[rows.length - 1][0]) return null;

  let lo = 0;
  let hi = rows.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (rows[mid][0] <= key) lo = mid;
    else hi = mid;
  }

  const low = rows[lo];
  const high = rows[hi];
  if (low[0] === key) return { L: low[1], M: low[2], S: low[3] };

  const frac = (key - low[0]) / (high[0] - low[0]);
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
  if (standard === "bmi_for_age_0_5y" || standard === "weight_for_length" || standard === "weight_for_height") {
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
  if (standard === "head_circumference_for_age") {
    if (z < -3) return "severe microcephaly";
    if (z < -2) return "microcephaly";
    if (z > 3) return "severe macrocephaly";
    if (z > 2) return "macrocephaly";
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
        `rangeLabel in the tool result for its exact source and valid range (0-5y standards use the WHO ` +
        `Child Growth Standards; bmi_for_age_5_19y uses the separate WHO Reference 2007 dataset). Most ` +
        `standards are keyed by age — provide age_days, age_months, or age_years (any one). ` +
        `weight_for_length and weight_for_height are instead keyed by the child's body size — provide ` +
        `length_or_height_cm (recumbent length for weight_for_length, standing height for weight_for_height) ` +
        `instead of an age. Calling this tool with an unsupported standard or an out-of-range key returns ` +
        `an error rather than a guess.`,
      inputSchema: {
        standard: z.enum(AVAILABLE_STANDARDS as [string, ...string[]]),
        sex: z.enum(["male", "female"]),
        value: z
          .number()
          .positive()
          .describe(
            "The measurement in the standard's units (kg for weight_for_age / weight_for_length / weight_for_height, cm for height_for_age / head_circumference_for_age, kg/m^2 for bmi_for_age_0_5y / bmi_for_age_5_19y)"
          ),
        age_days: z.number().nonnegative().optional(),
        age_months: z.number().nonnegative().optional(),
        age_years: z.number().nonnegative().optional(),
        length_or_height_cm: z
          .number()
          .positive()
          .optional()
          .describe(
            "Required instead of age for body-size-keyed standards (weight_for_length: recumbent length in cm; weight_for_height: standing height in cm)"
          ),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool(
      "who_growth_zscore",
      async ({ standard, sex, value, age_days, age_months, age_years, length_or_height_cm }) => {
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

        let key: number;
        let resultAgeDays: number | null = null;

        if (entry.keyKind === "length_cm" || entry.keyKind === "height_cm") {
          if (length_or_height_cm === undefined) {
            return {
              content: [
                { type: "text" as const, text: `${standard} requires length_or_height_cm, not an age.` },
              ],
              isError: true as const,
            };
          }
          key = length_or_height_cm;
        } else {
          const ageDays = ageDaysFrom(age_days, age_months, age_years);
          if (ageDays === null) {
            return {
              content: [{ type: "text" as const, text: "Provide age_days, age_months, or age_years." }],
              isError: true as const,
            };
          }
          resultAgeDays = ageDays;
          key = entry.keyKind === "age_month" ? ageDays / 30.4375 : ageDays;
        }

        const rows = entry[sex];
        const lms = interpolateLms(rows, key);
        if (!lms) {
          return {
            content: [{ type: "text" as const, text: `Input is outside this standard's range (${entry.rangeLabel}).` }],
            isError: true as const,
          };
        }

        const zScore = lmsZScore(value, lms.L, lms.M, lms.S);
        const percentile = normalCdf(zScore) * 100;

        return ok({
          standard,
          source_range: entry.rangeLabel,
          sex,
          age_days: resultAgeDays !== null ? Math.round(resultAgeDays * 10) / 10 : null,
          length_or_height_cm:
            entry.keyKind === "length_cm" || entry.keyKind === "height_cm" ? length_or_height_cm : null,
          value,
          z_score: Math.round(zScore * 100) / 100,
          percentile: Math.round(percentile * 10) / 10,
          classification: classify(zScore, standard),
          lms_parameters: { L: lms.L, M: lms.M, S: lms.S },
          disclaimer: DISCLAIMER,
        });
      }
    )
  );
}
