import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, safeTool } from "../utils/toolResult.js";

/**
 * ASPEN Consensus Recommendations for Refeeding Syndrome (RS).
 *
 * Source: da Silva JSV, Seres DS, Sabino K, et al. ASPEN Consensus
 * Recommendations for Refeeding Syndrome. Nutr Clin Pract. 2020;35(2):178-195.
 * DOI: 10.1002/ncp.10474.
 *
 * Three tools:
 * - aspen_refeeding_risk_adult      — Table 3 (risk stratification, 18y+)
 * - aspen_refeeding_risk_pediatric  — Table 5 (risk stratification, >28 days
 *                                     to <18y; not for neonates ≤28 days of
 *                                     life or ≤44 weeks corrected gestational
 *                                     age — the guide gives no pediatric-
 *                                     validated neonatal criteria)
 * - aspen_refeeding_syndrome_severity — the paper's core RS diagnostic
 *   definition: a decrease in phosphorus/potassium/magnesium of 10-20%
 *   (mild), 20-30% (moderate), or >30% and/or organ dysfunction or thiamin
 *   deficiency (severe), within 5 days of reinitiating/increasing calories.
 *
 * Several Table 3/5 criteria (caloric-intake pattern, electrolyte trend,
 * physical-exam loss of fat/muscle, comorbidity severity) are not single
 * numbers — they're a clinician's qualitative read of a compound
 * description. Rather than guess at a purely numeric proxy, those criteria
 * are taken as an already-assessed level (none/moderate/significant, or
 * none/mild/moderate/significant for pediatrics) and only the criteria the
 * source table expresses as clean numeric thresholds (BMI, weight loss %,
 * z-score, MUAC z-score, days of low intake, electrolyte % decrease) are
 * auto-classified here.
 *
 * Pure table lookup / classification — no Chakudya API calls. Educational/
 * clinical-support classification only, not a substitute for individualized
 * clinical assessment; these consensus criteria are based on expert
 * consensus, not randomized trial evidence, per the source paper.
 */

const ASPEN_DISCLAIMER =
  "Classification only, per ASPEN Consensus Recommendations for Refeeding Syndrome (da Silva et al, " +
  "Nutr Clin Pract. 2020;35(2):178-195). These criteria are based on expert consensus, not randomized " +
  "trial evidence — the source paper states they 'will need to be tested in randomized trials.' Not a " +
  "substitute for individualized clinical assessment.";

type RiskLevel = "none" | "mild" | "moderate" | "significant";

function classifyByThresholds(
  value: number,
  // ascending thresholds; comparisons are "value <= threshold" style depending on direction
  thresholds: { mild?: number; moderate?: number; significant: number },
  direction: "lower_is_worse" | "higher_is_worse"
): RiskLevel {
  const worse = (a: number, b: number) => (direction === "lower_is_worse" ? a <= b : a >= b);
  if (worse(value, thresholds.significant)) return "significant";
  if (thresholds.moderate !== undefined && worse(value, thresholds.moderate)) return "moderate";
  if (thresholds.mild !== undefined && worse(value, thresholds.mild)) return "mild";
  return "none";
}

export function registerAspenRefeedingTools(server: McpServer): void {
  // ── Adult risk stratification (Table 3) ──────────────────────────────────
  server.registerTool(
    "aspen_refeeding_risk_adult",
    {
      title: "ASPEN Refeeding Syndrome Risk — Adults (Table 3)",
      description:
        "Stratify an adult (18y+) as moderate or significant risk for refeeding syndrome per ASPEN " +
        "Table 3. Moderate risk needs 2 of the criteria met at 'moderate' level; significant risk needs " +
        "just 1 criterion met at 'significant' level (significant always outranks moderate). BMI and " +
        "weight loss are auto-classified from numbers; the other criteria (caloric intake pattern, " +
        "prefeeding electrolyte abnormality, physical-exam loss of subcutaneous fat/muscle mass, " +
        "comorbidity severity) require your own clinical assessment against the ASPEN table wording — " +
        "pass the level you've already determined for each.",
      inputSchema: {
        bmi: z.number().positive().optional(),
        weight_loss_percent: z
          .number()
          .optional()
          .describe("Percent body weight lost; interpreted together with weight_loss_timeframe"),
        weight_loss_timeframe: z
          .enum(["1_month", "3_months", "6_months"])
          .optional()
          .describe(
            "Per Table 3: moderate = 5% in 1 month; significant = 7.5% in 3 months OR >10% in 6 months"
          ),
        caloric_intake_level: z
          .enum(["none", "moderate", "significant"])
          .optional()
          .describe(
            "Moderate: none/negligible oral intake 5-6 days, OR <75% of estimated need for >7 days " +
              "during acute illness/injury, OR <75% of estimated need for >1 month. Significant: " +
              "none/negligible oral intake >7 days, OR <50% of estimated need for >5 days during acute " +
              "illness/injury, OR <50% of estimated need for >1 month."
          ),
        prefeeding_electrolyte_abnormality_level: z
          .enum(["none", "moderate", "significant"])
          .optional()
          .describe(
            "Moderate: minimally low or normal current K/phosphorus/magnesium with recent low levels " +
              "needing minimal/single-dose supplementation. Significant: moderately/significantly low " +
              "levels, or minimally low/normal with recent low levels needing significant/multiple-dose " +
              "supplementation. Note electrolytes may be normal despite total-body deficiency."
          ),
        subcutaneous_fat_loss: z.enum(["none", "moderate", "severe"]).optional(),
        muscle_mass_loss: z.enum(["none", "moderate", "severe"]).optional(),
        comorbidity_severity: z
          .enum(["none", "moderate", "severe"])
          .optional()
          .describe(
            "Severity of a higher-RS-risk comorbidity (e.g. chronic alcohol/drug use disorder, eating " +
              "disorder, malabsorptive state, cancer, postbariatric surgery, prolonged fasting) if present"
          ),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool(
      "aspen_refeeding_risk_adult",
      async ({
        bmi,
        weight_loss_percent,
        weight_loss_timeframe,
        caloric_intake_level,
        prefeeding_electrolyte_abnormality_level,
        subcutaneous_fat_loss,
        muscle_mass_loss,
        comorbidity_severity,
      }) => {
        const criteria: Array<{ criterion: string; level: RiskLevel; basis: string }> = [];

        if (bmi !== undefined) {
          const level = classifyByThresholds(bmi, { moderate: 18.5, significant: 16.0 }, "lower_is_worse");
          criteria.push({
            criterion: "bmi",
            level,
            basis: `BMI ${bmi}: moderate 16-18.5, significant <16`,
          });
        }

        if (weight_loss_percent !== undefined && weight_loss_timeframe) {
          let level: RiskLevel = "none";
          if (weight_loss_timeframe === "1_month" && weight_loss_percent >= 5) level = "moderate";
          if (weight_loss_timeframe === "3_months" && weight_loss_percent >= 7.5) level = "significant";
          if (weight_loss_timeframe === "6_months" && weight_loss_percent > 10) level = "significant";
          criteria.push({
            criterion: "weight_loss",
            level,
            basis: `${weight_loss_percent}% over ${weight_loss_timeframe.replace("_", " ")}: moderate = 5% in 1 month, significant = 7.5% in 3 months or >10% in 6 months`,
          });
        }

        if (caloric_intake_level) {
          criteria.push({
            criterion: "caloric_intake",
            level: caloric_intake_level,
            basis: "Clinician-assessed per Table 3 caloric intake pattern",
          });
        }

        if (prefeeding_electrolyte_abnormality_level) {
          criteria.push({
            criterion: "prefeeding_electrolyte_abnormality",
            level: prefeeding_electrolyte_abnormality_level,
            basis: "Clinician-assessed per Table 3 electrolyte abnormality pattern",
          });
        }

        if (subcutaneous_fat_loss) {
          criteria.push({
            criterion: "subcutaneous_fat_loss",
            level: subcutaneous_fat_loss,
            basis: "Clinician physical-exam assessment",
          });
        }

        if (muscle_mass_loss) {
          criteria.push({
            criterion: "muscle_mass_loss",
            level: muscle_mass_loss,
            basis: "Clinician physical-exam assessment",
          });
        }

        if (comorbidity_severity) {
          criteria.push({
            criterion: "comorbidity_severity",
            level: comorbidity_severity,
            basis: "Clinician-assessed severity of a higher-risk comorbidity (see Table 4)",
          });
        }

        if (criteria.length === 0) {
          throw new Error("Provide at least one criterion.");
        }

        const significantCount = criteria.filter((c) => c.level === "significant").length;
        const moderateCount = criteria.filter((c) => c.level === "moderate" || c.level === "significant").length;

        let overallRisk: "not_at_risk_by_these_criteria" | "moderate" | "significant";
        if (significantCount >= 1) overallRisk = "significant";
        else if (moderateCount >= 2) overallRisk = "moderate";
        else overallRisk = "not_at_risk_by_these_criteria";

        return ok(
          {
            population: "adults 18y+",
            criteria,
            overallRisk,
            rule: "Significant risk needs only 1 criterion at 'significant'; moderate risk needs 2 criteria at 'moderate' or higher. ASPEN provides no 'mild risk' category for adults by design.",
          },
          { disclaimer: ASPEN_DISCLAIMER }
        );
      }
    )
  );

  // ── Pediatric risk stratification (Table 5) ─────────────────────────────
  server.registerTool(
    "aspen_refeeding_risk_pediatric",
    {
      title: "ASPEN Refeeding Syndrome Risk — Pediatric (Table 5)",
      description:
        "Stratify a pediatric patient (>28 days to <18y) as mild, moderate, or significant risk for " +
        "refeeding syndrome per ASPEN Table 5. Mild risk needs 3 criteria at 'mild' or higher; moderate " +
        "needs 2 at 'moderate' or higher; significant needs just 1 at 'significant' (higher levels " +
        "always outrank lower). NOT intended for neonates ≤28 days of life or ≤44 weeks corrected " +
        "gestational age — ASPEN gives no validated criteria for that group in this paper. Weight-for-" +
        "length/BMI-for-age z-score change, weight gain vs expected, energy-intake duration, and MUAC " +
        "z-score are auto-classified from numbers; electrolyte abnormality and comorbidity severity " +
        "require your own clinical assessment.",
      inputSchema: {
        z_score_change_from_baseline: z
          .number()
          .optional()
          .describe(
            "Change from baseline in weight-for-length z-score (1-24 months) or BMI-for-age z-score " +
              "(2-20 years). Mild -1 to -1.9, moderate -2 to -2.9, significant -3 or beyond."
          ),
        weight_gain_percent_of_expected: z
          .number()
          .optional()
          .describe(
            "Current weight gain as % of expected/norm. Mild <75%, moderate <50%, significant <25%."
          ),
        low_intake_days: z
          .number()
          .nonnegative()
          .optional()
          .describe(
            "Consecutive days of protein/energy intake <75% of estimated need. Mild 3-5 days, moderate " +
              "5-7 days, significant >7 days."
          ),
        prefeeding_electrolyte_abnormality_level: z
          .enum(["none", "mild", "moderate", "significant"])
          .optional()
          .describe(
            "Mild: mildly abnormal or decreased to 25% below lower limit of normal. Moderate/" +
              "significant: moderately/significantly abnormal or down to 25-50% below lower limit of " +
              "normal (the table gives the same wording for both moderate and significant columns)."
          ),
        comorbidity_severity: z.enum(["none", "mild", "moderate", "severe"]).optional(),
        subcutaneous_fat_loss: z
          .enum(["none", "mild", "moderate", "severe"])
          .optional()
          .describe("Direct clinical assessment; alternatively supply muac_z_score"),
        muscle_mass_loss: z
          .enum(["none", "moderate", "severe"])
          .optional()
          .describe(
            "Direct clinical assessment; note ASPEN gives no 'mild' criterion for muscle mass loss. " +
              "Alternatively supply muac_z_score."
          ),
        muac_z_score: z
          .number()
          .optional()
          .describe(
            "Mid-upper arm circumference z-score, used for BOTH subcutaneous-fat-loss and muscle-mass-" +
              "loss criteria per Table 5. Fat: mild -1 to -1.9, moderate -2 to -2.9, severe -3 or beyond. " +
              "Muscle: moderate -2 to -2.9, severe -3 or beyond (no mild band)."
          ),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool(
      "aspen_refeeding_risk_pediatric",
      async ({
        z_score_change_from_baseline,
        weight_gain_percent_of_expected,
        low_intake_days,
        prefeeding_electrolyte_abnormality_level,
        comorbidity_severity,
        subcutaneous_fat_loss,
        muscle_mass_loss,
        muac_z_score,
      }) => {
        const criteria: Array<{ criterion: string; level: RiskLevel; basis: string }> = [];

        if (z_score_change_from_baseline !== undefined) {
          const level = classifyByThresholds(
            z_score_change_from_baseline,
            { mild: -1, moderate: -2, significant: -3 },
            "lower_is_worse"
          );
          criteria.push({
            criterion: "z_score_change",
            level,
            basis: `Change ${z_score_change_from_baseline}: mild -1 to -1.9, moderate -2 to -2.9, significant -3 or beyond`,
          });
        }

        if (weight_gain_percent_of_expected !== undefined) {
          const level = classifyByThresholds(
            weight_gain_percent_of_expected,
            { mild: 75, moderate: 50, significant: 25 },
            "lower_is_worse"
          );
          criteria.push({
            criterion: "weight_gain_vs_expected",
            level,
            basis: `${weight_gain_percent_of_expected}% of expected: mild <75%, moderate <50%, significant <25%`,
          });
        }

        if (low_intake_days !== undefined) {
          const level = classifyByThresholds(
            low_intake_days,
            { mild: 3, moderate: 5, significant: 7 },
            "higher_is_worse"
          );
          // >7 is significant per the table (not >=7); adjust the boundary case
          const adjusted: RiskLevel = low_intake_days > 7 ? "significant" : level;
          criteria.push({
            criterion: "low_intake_duration",
            level: adjusted,
            basis: `${low_intake_days} days <75% estimated need: mild 3-5 days, moderate 5-7 days, significant >7 days`,
          });
        }

        if (prefeeding_electrolyte_abnormality_level) {
          criteria.push({
            criterion: "prefeeding_electrolyte_abnormality",
            level: prefeeding_electrolyte_abnormality_level,
            basis: "Clinician-assessed per Table 5 electrolyte abnormality pattern",
          });
        }

        if (comorbidity_severity) {
          criteria.push({
            criterion: "comorbidity_severity",
            level: comorbidity_severity,
            basis: "Clinician-assessed severity of a higher-risk comorbidity (see Table 4)",
          });
        }

        if (subcutaneous_fat_loss) {
          criteria.push({
            criterion: "subcutaneous_fat_loss",
            level: subcutaneous_fat_loss,
            basis: "Direct clinical assessment",
          });
        } else if (muac_z_score !== undefined) {
          const level = classifyByThresholds(
            muac_z_score,
            { mild: -1, moderate: -2, significant: -3 },
            "lower_is_worse"
          );
          criteria.push({
            criterion: "subcutaneous_fat_loss",
            level,
            basis: `MUAC z-score ${muac_z_score}: mild -1 to -1.9, moderate -2 to -2.9, severe -3 or beyond`,
          });
        }

        if (muscle_mass_loss) {
          criteria.push({
            criterion: "muscle_mass_loss",
            level: muscle_mass_loss,
            basis: "Direct clinical assessment (no mild band for muscle mass loss per ASPEN)",
          });
        } else if (muac_z_score !== undefined) {
          let level: RiskLevel = "none";
          if (muac_z_score <= -3) level = "significant";
          else if (muac_z_score <= -2) level = "moderate";
          criteria.push({
            criterion: "muscle_mass_loss",
            level,
            basis: `MUAC z-score ${muac_z_score}: moderate -2 to -2.9, severe -3 or beyond (no mild band)`,
          });
        }

        if (criteria.length === 0) {
          throw new Error("Provide at least one criterion.");
        }

        const significantCount = criteria.filter((c) => c.level === "significant").length;
        const moderateCount = criteria.filter((c) => c.level === "moderate" || c.level === "significant").length;
        const mildCount = criteria.filter((c) => c.level !== "none").length;

        let overallRisk: "not_at_risk_by_these_criteria" | "mild" | "moderate" | "significant";
        if (significantCount >= 1) overallRisk = "significant";
        else if (moderateCount >= 2) overallRisk = "moderate";
        else if (mildCount >= 3) overallRisk = "mild";
        else overallRisk = "not_at_risk_by_these_criteria";

        return ok(
          {
            population: ">28 days to <18 years",
            criteria,
            overallRisk,
            rule: "Significant risk needs 1 criterion at 'significant'; moderate needs 2 at 'moderate' or higher; mild needs 3 at 'mild' or higher.",
            note: "Not intended for use in patients ≤28 days of life or ≤44 weeks corrected gestational age.",
          },
          { disclaimer: ASPEN_DISCLAIMER }
        );
      }
    )
  );

  // ── RS severity / diagnostic classification ─────────────────────────────
  server.registerTool(
    "aspen_refeeding_syndrome_severity",
    {
      title: "ASPEN Refeeding Syndrome Severity Classification",
      description:
        "Classify refeeding syndrome severity per the ASPEN consensus definition: a decrease in any 1, " +
        "2, or 3 of serum phosphorus, potassium, and/or magnesium by 10-20% (mild), 20-30% (moderate), " +
        "or >30% (severe), and/or organ dysfunction resulting from a decrease in any of these, and/or " +
        "due to thiamin deficiency (severe) — occurring within 5 days of reintroducing or substantially " +
        "increasing calorie provision after undernourishment. Supply baseline + current levels (any " +
        "consistent unit) for whichever electrolytes were measured, or a pre-computed percent_decrease " +
        "directly.",
      inputSchema: {
        phosphorus_baseline: z.number().positive().optional(),
        phosphorus_current: z.number().positive().optional(),
        phosphorus_percent_decrease: z.number().optional().describe("Use instead of baseline/current if already computed"),
        potassium_baseline: z.number().positive().optional(),
        potassium_current: z.number().positive().optional(),
        potassium_percent_decrease: z.number().optional(),
        magnesium_baseline: z.number().positive().optional(),
        magnesium_current: z.number().positive().optional(),
        magnesium_percent_decrease: z.number().optional(),
        organ_dysfunction_from_electrolyte_decrease: z
          .boolean()
          .optional()
          .describe("Any organ dysfunction resulting from a decrease in phosphorus, potassium, and/or magnesium"),
        thiamin_deficiency: z.boolean().optional(),
        within_5_days_of_refeeding: z
          .boolean()
          .optional()
          .describe(
            "Whether this occurred within 5 days of reinitiating/substantially increasing calorie " +
              "provision — required by the ASPEN definition for this to be classified as RS at all"
          ),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool(
      "aspen_refeeding_syndrome_severity",
      async ({
        phosphorus_baseline,
        phosphorus_current,
        phosphorus_percent_decrease,
        potassium_baseline,
        potassium_current,
        potassium_percent_decrease,
        magnesium_baseline,
        magnesium_current,
        magnesium_percent_decrease,
        organ_dysfunction_from_electrolyte_decrease,
        thiamin_deficiency,
        within_5_days_of_refeeding,
      }) => {
        function resolvePercentDecrease(
          baseline: number | undefined,
          current: number | undefined,
          direct: number | undefined
        ): number | undefined {
          if (direct !== undefined) return direct;
          if (baseline !== undefined && current !== undefined) {
            if (baseline <= 0) throw new Error("Baseline electrolyte level must be positive.");
            return ((baseline - current) / baseline) * 100;
          }
          return undefined;
        }

        function classifyElectrolyte(pctDecrease: number): "normal_or_increased" | "mild" | "moderate" | "severe" {
          if (pctDecrease > 30) return "severe";
          if (pctDecrease >= 20) return "moderate";
          if (pctDecrease >= 10) return "mild";
          return "normal_or_increased";
        }

        const electrolytes: Array<{ electrolyte: string; percentDecrease: number; classification: string }> = [];

        const pDec = resolvePercentDecrease(phosphorus_baseline, phosphorus_current, phosphorus_percent_decrease);
        if (pDec !== undefined) {
          electrolytes.push({
            electrolyte: "phosphorus",
            percentDecrease: Math.round(pDec * 100) / 100,
            classification: classifyElectrolyte(pDec),
          });
        }
        const kDec = resolvePercentDecrease(potassium_baseline, potassium_current, potassium_percent_decrease);
        if (kDec !== undefined) {
          electrolytes.push({
            electrolyte: "potassium",
            percentDecrease: Math.round(kDec * 100) / 100,
            classification: classifyElectrolyte(kDec),
          });
        }
        const mDec = resolvePercentDecrease(magnesium_baseline, magnesium_current, magnesium_percent_decrease);
        if (mDec !== undefined) {
          electrolytes.push({
            electrolyte: "magnesium",
            percentDecrease: Math.round(mDec * 100) / 100,
            classification: classifyElectrolyte(mDec),
          });
        }

        if (
          electrolytes.length === 0 &&
          organ_dysfunction_from_electrolyte_decrease === undefined &&
          thiamin_deficiency === undefined
        ) {
          throw new Error(
            "Provide at least one electrolyte's baseline+current (or percent_decrease), or organ_dysfunction_from_electrolyte_decrease, or thiamin_deficiency."
          );
        }

        const worstElectrolyte = electrolytes.reduce<"normal_or_increased" | "mild" | "moderate" | "severe">(
          (worst, e) => {
            const rank = { normal_or_increased: 0, mild: 1, moderate: 2, severe: 3 } as const;
            return rank[e.classification as keyof typeof rank] > rank[worst]
              ? (e.classification as typeof worst)
              : worst;
          },
          "normal_or_increased"
        );

        let severity: "normal_or_increased" | "mild" | "moderate" | "severe" = worstElectrolyte;
        const severityReasons: string[] = [];
        if (worstElectrolyte !== "normal_or_increased") {
          severityReasons.push(`electrolyte decrease (${worstElectrolyte})`);
        }
        if (organ_dysfunction_from_electrolyte_decrease) {
          severity = "severe";
          severityReasons.push("organ dysfunction from electrolyte decrease");
        }
        if (thiamin_deficiency) {
          severity = "severe";
          severityReasons.push("thiamin deficiency");
        }

        const meetsAspenRsDefinition =
          severity !== "normal_or_increased" && within_5_days_of_refeeding !== false;

        return ok(
          {
            electrolytes,
            organDysfunctionFromElectrolyteDecrease: organ_dysfunction_from_electrolyte_decrease ?? null,
            thiaminDeficiency: thiamin_deficiency ?? null,
            severityClassification: severity,
            severityBasis: severityReasons.length > 0 ? severityReasons : ["no qualifying decrease/finding provided"],
            meetsAspenRsDefinition,
            note:
              within_5_days_of_refeeding === undefined
                ? "within_5_days_of_refeeding was not specified — the ASPEN definition requires this timing to classify as RS; confirm timing before using this as a diagnosis."
                : within_5_days_of_refeeding === false
                  ? "within_5_days_of_refeeding is false — per the ASPEN definition this does not meet the RS timing criterion regardless of electrolyte/organ/thiamin findings."
                  : undefined,
          },
          { disclaimer: ASPEN_DISCLAIMER }
        );
      }
    )
  );
}
