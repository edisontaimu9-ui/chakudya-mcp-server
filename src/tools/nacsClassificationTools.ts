import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, safeTool } from "../utils/toolResult.js";

/**
 * NACS (Nutrition Assessment and Classification and Support) nutritional
 * status classification.
 *
 * Source: NACS User's Guide, Module 2 — "Cutoffs to Classify Nutritional
 * Status by Age Group and Pregnancy Status" (April 2016), citing WHO. 1995.
 * Physical Status: The Use and Interpretation of Anthropometry. WHO
 * Technical Report Series 854.
 *
 * Pure table lookup / classification — no Chakudya API calls, no computed
 * z-scores (feed in a WHZ or BMI-for-age z-score already computed, e.g. via
 * the who_growth_z_score tool). Educational/clinical-support classification
 * only, not a substitute for a full clinical nutrition assessment.
 *
 * Do not add or alter cutoffs beyond what the source guide states. If a
 * cutoff for a population/measure isn't in the guide (e.g. MUAC in adults
 * is explicitly a suggestion, not a WHO standard), say so rather than
 * inventing a firmer number.
 */

const NACS_DISCLAIMER =
  "Classification only, per NACS User's Guide Module 2 cutoffs (source: WHO 1995, Technical Report " +
  "Series 854). Any bilateral pitting edema alone classifies as the most severe category regardless " +
  "of other measures. Not a substitute for a full clinical nutrition assessment.";

type Severity = "severe" | "moderate" | "normal" | "overweight" | "obesity";

interface IndicatorResult {
  indicator: string;
  value: string;
  classification: Severity;
  cutoffApplied: string;
}

function worstAcuteClassification(results: IndicatorResult[]): Severity {
  // Only severe/moderate/normal compete for "worst" on the acute-malnutrition axis;
  // overweight/obesity are reported per-indicator but don't override a severe/moderate finding.
  let worst: "moderate" | "normal" = "normal";
  for (const r of results) {
    if (r.classification === "severe") return "severe";
    if (r.classification === "moderate") worst = "moderate";
  }
  return worst;
}

export function registerNacsClassificationTools(server: McpServer): void {
  server.registerTool(
    "nacs_classify_children_0_59m",
    {
      title: "NACS Classification — Children 0-59 months",
      description:
        "Classify acute malnutrition status for a child 0-59 months old using NACS cutoffs: bilateral " +
        "pitting edema, MUAC (6-59 months only), and/or weight-for-height z-score (WHZ, 6-59 months). " +
        "Supply whichever measures were taken; at least one of muac_mm or whz is required unless edema " +
        "is present. Returns a classification per indicator plus an overall status (edema, if present, " +
        "always makes the overall classification 'severe' — this is SAM regardless of MUAC/WHZ).",
      inputSchema: {
        edema: z.boolean().optional().describe("Any bilateral pitting edema present"),
        muac_mm: z.number().positive().optional().describe("Mid-upper arm circumference in mm (6-59 months)"),
        whz: z.number().optional().describe("Weight-for-height z-score (6-59 months)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("nacs_classify_children_0_59m", async ({ edema, muac_mm, whz }) => {
      if (edema === undefined && muac_mm === undefined && whz === undefined) {
        throw new Error("Provide at least one of edema, muac_mm, or whz.");
      }

      const indicators: IndicatorResult[] = [];

      if (edema) {
        indicators.push({
          indicator: "bilateral_pitting_edema",
          value: "present",
          classification: "severe",
          cutoffApplied: "Any bilateral pitting edema = SAM (severe acute malnutrition)",
        });
      }

      if (muac_mm !== undefined) {
        let classification: Severity;
        if (muac_mm < 115) classification = "severe";
        else if (muac_mm < 125) classification = "moderate";
        else classification = "normal";
        indicators.push({
          indicator: "muac",
          value: `${muac_mm} mm`,
          classification,
          cutoffApplied: "SAM < 115mm, MAM >= 115 to < 125mm, normal >= 125mm",
        });
      }

      if (whz !== undefined) {
        let classification: Severity;
        if (whz < -3) classification = "severe";
        else if (whz < -2) classification = "moderate";
        else if (whz <= 2) classification = "normal";
        else if (whz <= 3) classification = "overweight";
        else classification = "obesity";
        indicators.push({
          indicator: "whz",
          value: whz.toString(),
          classification,
          cutoffApplied:
            "SAM < -3, MAM >= -3 to < -2, normal >= -2 to <= +2, overweight > +2 to <= +3, obesity > +3",
        });
      }

      const overall = worstAcuteClassification(indicators);

      return ok(
        {
          ageGroup: "0-59 months",
          indicators,
          overallAcuteMalnutritionClassification: overall,
          note:
            "Weight loss >5% since last visit is not a listed classification criterion for this age " +
            "group in the source guide (WHZ/MUAC/edema are used instead).",
        },
        { disclaimer: NACS_DISCLAIMER }
      );
    })
  );

  server.registerTool(
    "nacs_classify_children_5_17y",
    {
      title: "NACS Classification — Children/Adolescents 5-17 years",
      description:
        "Classify malnutrition status for a child/adolescent aged 5-17 years using NACS cutoffs: " +
        "bilateral pitting edema, age-banded MUAC (5-9y, 10-14y, 15-17y), and/or BMI-for-age z-score. " +
        "age_years is required if muac_mm is supplied, to select the correct MUAC band.",
      inputSchema: {
        age_years: z.number().min(5).max(17).optional().describe("Required if muac_mm is supplied"),
        edema: z.boolean().optional().describe("Any bilateral pitting edema present"),
        muac_mm: z.number().positive().optional().describe("Mid-upper arm circumference in mm"),
        bmi_for_age_z: z.number().optional().describe("BMI-for-age z-score"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("nacs_classify_children_5_17y", async ({ age_years, edema, muac_mm, bmi_for_age_z }) => {
      if (edema === undefined && muac_mm === undefined && bmi_for_age_z === undefined) {
        throw new Error("Provide at least one of edema, muac_mm, or bmi_for_age_z.");
      }
      if (muac_mm !== undefined && age_years === undefined) {
        throw new Error("age_years is required when muac_mm is supplied, to select the correct MUAC band.");
      }

      const indicators: IndicatorResult[] = [];

      if (edema) {
        indicators.push({
          indicator: "bilateral_pitting_edema",
          value: "present",
          classification: "severe",
          cutoffApplied: "Any bilateral pitting edema = severe malnutrition",
        });
      }

      if (muac_mm !== undefined && age_years !== undefined) {
        let band: { severe: number; moderate: number; label: string };
        if (age_years < 10) band = { severe: 135, moderate: 145, label: "5-9 years" };
        else if (age_years < 15) band = { severe: 160, moderate: 185, label: "10-14 years" };
        else band = { severe: 185, moderate: 220, label: "15-17 years" };

        let classification: Severity;
        if (muac_mm < band.severe) classification = "severe";
        else if (muac_mm < band.moderate) classification = "moderate";
        else classification = "normal";

        indicators.push({
          indicator: "muac",
          value: `${muac_mm} mm`,
          classification,
          cutoffApplied: `${band.label} band: severe < ${band.severe}mm, moderate >= ${band.severe} to < ${band.moderate}mm, normal >= ${band.moderate}mm`,
        });
      }

      if (bmi_for_age_z !== undefined) {
        let classification: Severity;
        if (bmi_for_age_z < -3) classification = "severe";
        else if (bmi_for_age_z < -2) classification = "moderate";
        else if (bmi_for_age_z <= 1) classification = "normal";
        else if (bmi_for_age_z <= 2) classification = "overweight";
        else classification = "obesity";
        indicators.push({
          indicator: "bmi_for_age_z",
          value: bmi_for_age_z.toString(),
          classification,
          cutoffApplied:
            "severe < -3, moderate >= -3 to < -2, normal >= -2 to <= +1, overweight > +1 to <= +2, obesity > +2",
        });
      }

      const overall = worstAcuteClassification(indicators);

      return ok(
        {
          ageGroup: "5-17 years",
          indicators,
          overallMalnutritionClassification: overall,
          note:
            "Weight loss >5% since last visit is not a listed classification criterion for this age " +
            "group in the source guide.",
        },
        { disclaimer: NACS_DISCLAIMER }
      );
    })
  );

  server.registerTool(
    "nacs_classify_pregnant_postpartum",
    {
      title: "NACS Classification — Pregnant/Postpartum Women",
      description:
        "Classify malnutrition status for a pregnant or postpartum woman using NACS cutoffs: bilateral " +
        "pitting edema, MUAC, and/or confirmed unintentional weight loss >10% since last visit (a " +
        "severe-malnutrition trigger). The MAM MUAC upper cutoff varies by country protocol (220 or 230mm) " +
        "— pass moderate_muac_upper_mm if your country uses 230mm; defaults to 220mm.",
      inputSchema: {
        edema: z.boolean().optional().describe("Any bilateral pitting edema present"),
        muac_mm: z.number().positive().optional().describe("Mid-upper arm circumference in mm"),
        moderate_muac_upper_mm: z
          .union([z.literal(220), z.literal(230)])
          .optional()
          .describe("Country-specific MAM/normal MUAC boundary: 220 (default) or 230mm"),
        confirmed_weight_loss_over_10_percent: z
          .boolean()
          .optional()
          .describe("Confirmed unintentional weight loss >10% since last visit"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool(
      "nacs_classify_pregnant_postpartum",
      async ({ edema, muac_mm, moderate_muac_upper_mm, confirmed_weight_loss_over_10_percent }) => {
        if (
          edema === undefined &&
          muac_mm === undefined &&
          confirmed_weight_loss_over_10_percent === undefined
        ) {
          throw new Error(
            "Provide at least one of edema, muac_mm, or confirmed_weight_loss_over_10_percent."
          );
        }

        const upper = moderate_muac_upper_mm ?? 220;
        const indicators: IndicatorResult[] = [];

        if (edema) {
          indicators.push({
            indicator: "bilateral_pitting_edema",
            value: "present",
            classification: "severe",
            cutoffApplied: "Any bilateral pitting edema = severe malnutrition",
          });
        }

        if (confirmed_weight_loss_over_10_percent) {
          indicators.push({
            indicator: "weight_loss",
            value: ">10% since last visit",
            classification: "severe",
            cutoffApplied: "Confirmed unintentional weight loss >10% since last visit = severe malnutrition",
          });
        }

        if (muac_mm !== undefined) {
          let classification: Severity;
          if (muac_mm < 190) classification = "severe";
          else if (muac_mm < upper) classification = "moderate";
          else classification = "normal";
          indicators.push({
            indicator: "muac",
            value: `${muac_mm} mm`,
            classification,
            cutoffApplied: `severe < 190mm, moderate >= 190 to < ${upper}mm, normal >= ${upper}mm (country-specific MAM upper cutoff)`,
          });
        }

        const overall = worstAcuteClassification(indicators);

        return ok(
          {
            population: "pregnant/postpartum women",
            indicators,
            overallMalnutritionClassification: overall,
            note:
              "WHO has not established a single standard MUAC cutoff for this population; countries may " +
              "use 220 or 230mm for the moderate/normal boundary — confirm which your program uses.",
          },
          { disclaimer: NACS_DISCLAIMER }
        );
      }
    )
  );

  server.registerTool(
    "nacs_classify_adult",
    {
      title: "NACS Classification — Adults 18+ (non-pregnant/non-postpartum)",
      description:
        "Classify malnutrition status for a non-pregnant, non-postpartum adult (18+) using NACS cutoffs: " +
        "bilateral pitting edema, MUAC, BMI, and/or confirmed unintentional weight loss >10% since last " +
        "visit (a severe-malnutrition trigger). Note the guide states WHO has not established standard " +
        "MUAC cutoffs for adults — the MUAC cutoffs used here are suggestions based on current practice, " +
        "not a WHO standard, unlike BMI.",
      inputSchema: {
        edema: z.boolean().optional().describe("Any bilateral pitting edema present"),
        muac_mm: z.number().positive().optional().describe("Mid-upper arm circumference in mm"),
        bmi: z.number().positive().optional().describe("Body mass index (kg/m^2)"),
        confirmed_weight_loss_over_10_percent: z
          .boolean()
          .optional()
          .describe("Confirmed unintentional weight loss >10% since last visit"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool(
      "nacs_classify_adult",
      async ({ edema, muac_mm, bmi, confirmed_weight_loss_over_10_percent }) => {
        if (
          edema === undefined &&
          muac_mm === undefined &&
          bmi === undefined &&
          confirmed_weight_loss_over_10_percent === undefined
        ) {
          throw new Error(
            "Provide at least one of edema, muac_mm, bmi, or confirmed_weight_loss_over_10_percent."
          );
        }

        const indicators: IndicatorResult[] = [];

        if (edema) {
          indicators.push({
            indicator: "bilateral_pitting_edema",
            value: "present",
            classification: "severe",
            cutoffApplied: "Any bilateral pitting edema = severe malnutrition",
          });
        }

        if (confirmed_weight_loss_over_10_percent) {
          indicators.push({
            indicator: "weight_loss",
            value: ">10% since last visit",
            classification: "severe",
            cutoffApplied: "Confirmed unintentional weight loss >10% since last visit = severe malnutrition",
          });
        }

        if (muac_mm !== undefined) {
          let classification: Severity;
          if (muac_mm < 185) classification = "severe";
          else if (muac_mm < 220) classification = "moderate";
          else classification = "normal";
          indicators.push({
            indicator: "muac",
            value: `${muac_mm} mm`,
            classification,
            cutoffApplied: "severe < 185mm, moderate >= 185 to < 220mm, normal >= 220mm (suggested, not a WHO standard)",
          });
        }

        if (bmi !== undefined) {
          let classification: Severity;
          if (bmi < 16.0) classification = "severe";
          else if (bmi < 18.5) classification = "moderate";
          else if (bmi < 25.0) classification = "normal";
          else if (bmi < 30.0) classification = "overweight";
          else classification = "obesity";
          indicators.push({
            indicator: "bmi",
            value: bmi.toString(),
            classification,
            cutoffApplied:
              "severe < 16.0, moderate >= 16.0 to < 18.5, normal >= 18.5 to < 25.0, overweight >= 25.0 to < 30.0, obesity >= 30.0",
          });
        }

        const overall = worstAcuteClassification(indicators);

        return ok(
          {
            population: "adults 18+ (non-pregnant/non-postpartum)",
            indicators,
            overallMalnutritionClassification: overall,
          },
          { disclaimer: NACS_DISCLAIMER }
        );
      }
    )
  );
}
