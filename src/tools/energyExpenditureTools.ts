import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, safeTool } from "../utils/toolResult.js";

/**
 * Energy expenditure calculators sourced from Nelms/Ireton-Jones, "Nutrition
 * Therapy and Pathophysiology" — Chapter 2: Intake: Energy. Institute of
 * Medicine (2002/2005) DRI/EER prediction equations (Box 2.1, Table 2.2-2.4).
 *
 * Pure calculation — no Chakudya API calls. Educational/clinical-support
 * estimate only, not a substitute for individualized dietetic assessment or
 * measured indirect calorimetry.
 */

const DISCLAIMER =
  "Estimate only, derived from IOM/DRI published prediction equations. Individual variation may be wide; " +
  "measured indirect calorimetry is preferred when available and clinically indicated.";

// ── PA (physical activity) coefficient tables ───────────────────────────────
type PAL = "sedentary" | "low_active" | "active" | "very_active";

const PA_TABLES = {
  child_boy_normal: { sedentary: 1, low_active: 1.13, active: 1.26, very_active: 1.42 },
  child_girl_normal: { sedentary: 1, low_active: 1.16, active: 1.31, very_active: 1.56 },
  child_boy_overweight: { sedentary: 1, low_active: 1.12, active: 1.24, very_active: 1.45 },
  child_girl_overweight: { sedentary: 1, low_active: 1.18, active: 1.35, very_active: 1.6 },
  adult_male_normal: { sedentary: 1, low_active: 1.11, active: 1.25, very_active: 1.48 },
  adult_female_normal: { sedentary: 1, low_active: 1.12, active: 1.27, very_active: 1.45 },
  adult_male_overweight_obese: { sedentary: 1, low_active: 1.12, active: 1.29, very_active: 1.59 },
  adult_female_overweight_obese: { sedentary: 1, low_active: 1.16, active: 1.27, very_active: 1.44 },
  adult_male_combined: { sedentary: 1, low_active: 1.12, active: 1.27, very_active: 1.54 },
  adult_female_combined: { sedentary: 1, low_active: 1.14, active: 1.27, very_active: 1.45 },
} as const satisfies Record<string, Record<PAL, number>>;

// ── MET table (Table 2.4) ───────────────────────────────────────────────────
const MET_ACTIVITIES: Record<string, number> = {
  lying_quietly: 1,
  riding_in_car: 1,
  light_activity_sitting: 1.5,
  vacuuming: 3.5,
  household_tasks_moderate: 3.5,
  gardening_no_lifting: 4.4,
  mowing_lawn_power: 4.5,
  walking_2mph: 2.5,
  paddling_leisurely: 2.5,
  golfing_with_cart: 2.5,
  dancing: 2.9,
  walking_3mph: 3.3,
  cycling_leisurely: 3.5,
  walking_4mph: 4.5,
  chopping_wood: 4.9,
  tennis_doubles: 5,
  ice_skating: 5.5,
  cycling_moderate: 5.7,
  skiing_downhill_or_water: 6.8,
  swimming: 7,
  climbing_hills_5kg_load: 7.4,
  walking_5mph: 8,
  jogging_10min_mile: 10.2,
  skipping_rope: 12,
};

function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

export function registerEnergyExpenditureTools(server: McpServer) {
  // ── iom_dri_eer_calculator ────────────────────────────────────────────────
  server.registerTool(
    "iom_dri_eer_calculator",
    {
      title: "IOM/DRI Estimated Energy Requirement (EER) Calculator",
      description:
        "Compute Estimated Energy Requirement using the Institute of Medicine (2002/2005) DRI prediction " +
        "equations (Nelms/Ireton-Jones Box 2.1), covering life stages beyond simple Mifflin-St Jeor: infants " +
        "0-2y (weight only), normal-weight children 3-18y (5th-85th BMI percentile), overweight children " +
        "3-18y (>85th BMI percentile), adults 19+ at three equation variants (normal-weight-only BMI " +
        "18.5-25, overweight/obese-only BMI>=25, and a combined normal+overweight/obese BMI>=18.5 " +
        "equation set), and pregnant/lactating women (14-18y or 19-50y, which layer on top of the " +
        "corresponding adolescent/adult female EER). Requires different inputs depending on life_stage — " +
        "see individual field descriptions.",
      inputSchema: {
        life_stage: z.enum([
          "infant_0_2y",
          "child_boy_3_8_normal",
          "child_boy_9_18_normal",
          "child_girl_3_8_normal",
          "child_girl_9_18_normal",
          "child_boy_3_18_overweight",
          "child_girl_3_18_overweight",
          "adult_male_normal_bmi18_5_25",
          "adult_female_normal_bmi18_25",
          "adult_male_overweight_obese_bmi25plus",
          "adult_female_overweight_obese_bmi25plus",
          "adult_male_combined_bmi18_5plus",
          "adult_female_combined_bmi18_5plus",
          "pregnant_14_18",
          "pregnant_19_50",
          "lactating_14_18",
          "lactating_19_50",
        ]),
        weight_kg: z.number().positive(),
        height_cm: z.number().positive().optional().describe("Required for all life stages except infant_0_2y"),
        age_years: z.number().nonnegative().optional().describe("Required for all life stages except infant_0_2y"),
        age_months: z.number().nonnegative().optional().describe("Required for infant_0_2y (0-35 months)"),
        physical_activity_level: z
          .enum(["sedentary", "low_active", "active", "very_active"])
          .optional()
          .default("sedentary")
          .describe("Required for all life stages except infant_0_2y"),
        trimester: z
          .enum(["first", "second", "third"])
          .optional()
          .describe("Required for pregnant_14_18 / pregnant_19_50"),
        months_postpartum: z
          .enum(["first_6_months", "second_6_months"])
          .optional()
          .describe("Required for lactating_14_18 / lactating_19_50"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool(
      "iom_dri_eer_calculator",
      async ({
        life_stage,
        weight_kg,
        height_cm,
        age_years,
        age_months,
        physical_activity_level,
        trimester,
        months_postpartum,
      }) => {
        const pal = physical_activity_level ?? "sedentary";

        // ── Infants 0-2y: weight only ──
        if (life_stage === "infant_0_2y") {
          const months = age_months ?? (age_years !== undefined ? age_years * 12 : undefined);
          if (months === undefined) return err("age_months (or age_years) is required for infant_0_2y.");
          let addend: number;
          let bracket: string;
          if (months <= 3) {
            addend = 175;
            bracket = "0-3 months";
          } else if (months <= 6) {
            addend = 56;
            bracket = "4-6 months";
          } else if (months <= 12) {
            addend = 22;
            bracket = "7-12 months";
          } else {
            addend = 20;
            bracket = "13-35 months";
          }
          const eer = 89 * weight_kg - 100 + addend;
          return ok({
            life_stage,
            age_bracket: bracket,
            eer_kcal_per_day: Math.round(eer),
            disclaimer: DISCLAIMER,
          });
        }

        // Everything else needs age_years and height_cm.
        if (age_years === undefined) return err("age_years is required for this life_stage.");
        if (height_cm === undefined) return err("height_cm is required for this life_stage.");
        const htM = height_cm / 100;

        // ── Children 3-18y, normal weight ──
        if (
          life_stage === "child_boy_3_8_normal" ||
          life_stage === "child_boy_9_18_normal" ||
          life_stage === "child_girl_3_8_normal" ||
          life_stage === "child_girl_9_18_normal"
        ) {
          const isBoy = life_stage.startsWith("child_boy");
          const kcalAddend = life_stage.includes("_3_8_") ? 20 : 25;
          const pa = isBoy ? PA_TABLES.child_boy_normal[pal] : PA_TABLES.child_girl_normal[pal];
          const eer = isBoy
            ? 88.5 - 61.9 * age_years + pa * (26.7 * weight_kg + 903 * htM) + kcalAddend
            : 135.3 - 30.8 * age_years + pa * (10 * weight_kg + 934 * htM) + kcalAddend;
          return ok({
            life_stage,
            pa_coefficient: pa,
            eer_kcal_per_day: Math.round(eer),
            disclaimer: DISCLAIMER,
          });
        }

        // ── Children 3-18y, overweight ──
        if (life_stage === "child_boy_3_18_overweight" || life_stage === "child_girl_3_18_overweight") {
          const isBoy = life_stage === "child_boy_3_18_overweight";
          const pa = isBoy ? PA_TABLES.child_boy_overweight[pal] : PA_TABLES.child_girl_overweight[pal];
          const tee = isBoy
            ? 114 - 50.9 * age_years + pa * (19.5 * weight_kg + 1161.4 * htM)
            : 389 - 41.2 * age_years + pa * (15 * weight_kg + 701.6 * htM);
          return ok({
            life_stage,
            pa_coefficient: pa,
            tee_kcal_per_day: Math.round(tee),
            disclaimer: DISCLAIMER,
          });
        }

        // ── Adults 19+, three equation variants ──
        if (life_stage === "adult_male_normal_bmi18_5_25") {
          const pa = PA_TABLES.adult_male_normal[pal];
          const eer = 662 - 9.53 * age_years + pa * (15.91 * weight_kg + 539.6 * htM);
          return ok({ life_stage, pa_coefficient: pa, eer_kcal_per_day: Math.round(eer), disclaimer: DISCLAIMER });
        }
        if (life_stage === "adult_female_normal_bmi18_25") {
          const pa = PA_TABLES.adult_female_normal[pal];
          const eer = 354 - 6.91 * age_years + pa * (9.36 * weight_kg + 726 * htM);
          return ok({ life_stage, pa_coefficient: pa, eer_kcal_per_day: Math.round(eer), disclaimer: DISCLAIMER });
        }
        if (life_stage === "adult_male_overweight_obese_bmi25plus") {
          const pa = PA_TABLES.adult_male_overweight_obese[pal];
          const tee = 1086 - 10.1 * age_years + pa * (13.7 * weight_kg + 416 * htM);
          return ok({ life_stage, pa_coefficient: pa, tee_kcal_per_day: Math.round(tee), disclaimer: DISCLAIMER });
        }
        if (life_stage === "adult_female_overweight_obese_bmi25plus") {
          const pa = PA_TABLES.adult_female_overweight_obese[pal];
          const tee = 448 - 7.95 * age_years + pa * (11.4 * weight_kg + 619 * htM);
          return ok({ life_stage, pa_coefficient: pa, tee_kcal_per_day: Math.round(tee), disclaimer: DISCLAIMER });
        }
        if (life_stage === "adult_male_combined_bmi18_5plus") {
          const pa = PA_TABLES.adult_male_combined[pal];
          const tee = 864 - 9.72 * age_years + pa * (14.2 * weight_kg + 503 * htM);
          return ok({ life_stage, pa_coefficient: pa, tee_kcal_per_day: Math.round(tee), disclaimer: DISCLAIMER });
        }
        if (life_stage === "adult_female_combined_bmi18_5plus") {
          const pa = PA_TABLES.adult_female_combined[pal];
          const tee = 387 - 7.31 * age_years + pa * (10.9 * weight_kg + 660.7 * htM);
          return ok({ life_stage, pa_coefficient: pa, tee_kcal_per_day: Math.round(tee), disclaimer: DISCLAIMER });
        }

        // ── Pregnant / lactating: layer on adolescent (girl 9-18 normal) or adult (female normal) EER ──
        const isAdolescent = life_stage.endsWith("_14_18");
        let baseEer: number;
        let baseLabel: string;
        if (isAdolescent) {
          const pa = PA_TABLES.child_girl_normal[pal];
          baseEer = 135.3 - 30.8 * age_years + pa * (10 * weight_kg + 934 * htM) + 25;
          baseLabel = "Adolescent EER (girl 9-18y normal-weight equation)";
        } else {
          const pa = PA_TABLES.adult_female_normal[pal];
          baseEer = 354 - 6.91 * age_years + pa * (9.36 * weight_kg + 726 * htM);
          baseLabel = "Adult EER (woman 19+ normal-weight equation)";
        }

        if (life_stage === "pregnant_14_18" || life_stage === "pregnant_19_50") {
          if (!trimester) return err("trimester (first/second/third) is required for pregnancy life stages.");
          const adjustment = trimester === "first" ? 0 : trimester === "second" ? 160 : 272;
          return ok({
            life_stage,
            base_eer_kcal_per_day: Math.round(baseEer),
            base_eer_basis: baseLabel,
            pregnancy_energy_deposition_kcal: adjustment,
            eer_kcal_per_day: Math.round(baseEer + adjustment),
            disclaimer: DISCLAIMER,
          });
        }

        if (life_stage === "lactating_14_18" || life_stage === "lactating_19_50") {
          if (!months_postpartum)
            return err("months_postpartum (first_6_months/second_6_months) is required for lactation life stages.");
          let adjustment: number;
          if (isAdolescent) {
            adjustment = months_postpartum === "first_6_months" ? 330 : 400; // +500-170 / +400-0
          } else {
            adjustment = months_postpartum === "first_6_months" ? 430 : 400; // +500-70 / +400-0
          }
          return ok({
            life_stage,
            base_eer_kcal_per_day: Math.round(baseEer),
            base_eer_basis: baseLabel,
            milk_energy_output_minus_weight_loss_kcal: adjustment,
            eer_kcal_per_day: Math.round(baseEer + adjustment),
            disclaimer: DISCLAIMER,
          });
        }

        return err(`Unhandled life_stage: ${life_stage}`);
      }
    )
  );

  // ── met_activity_energy_calculator ────────────────────────────────────────
  server.registerTool(
    "met_activity_energy_calculator",
    {
      title: "MET-Based Activity Energy Expenditure Calculator",
      description:
        "Estimate kcal expended during a physical activity using its metabolic equivalent (MET) value: " +
        "kcal = MET x weight(kg) x duration(hours). Pick a known activity from Table 2.4 (Nelms/Ireton-Jones) " +
        "via `activity`, or supply a custom `met_value` for an activity not in the table.",
      inputSchema: {
        weight_kg: z.number().positive(),
        duration_minutes: z.number().positive(),
        activity: z.enum(Object.keys(MET_ACTIVITIES) as [string, ...string[]]).optional(),
        met_value: z.number().positive().optional().describe("Custom MET value, used if `activity` is omitted"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("met_activity_energy_calculator", async ({ weight_kg, duration_minutes, activity, met_value }) => {
      const mets = activity ? MET_ACTIVITIES[activity] : met_value;
      if (mets === undefined) return err("Provide either `activity` or `met_value`.");
      const kcal = mets * weight_kg * (duration_minutes / 60);
      return ok({
        activity: activity ?? "custom",
        met_value: mets,
        weight_kg,
        duration_minutes,
        kcal_expended: Math.round(kcal * 10) / 10,
        disclaimer: DISCLAIMER,
      });
    })
  );

  // ── alcohol_kcal_calculator ───────────────────────────────────────────────
  server.registerTool(
    "alcohol_kcal_calculator",
    {
      title: "Alcoholic Beverage Calorie Calculator",
      description:
        "Compute kcal in an alcoholic beverage from volume (oz) and proof: " +
        "kcal = volume_oz x proof x 0.8. Proof is the US convention where 100-proof = 50% ethyl alcohol by " +
        "volume (i.e. pass the proof number itself, e.g. 86, not a fraction).",
      inputSchema: {
        volume_oz: z.number().positive(),
        proof: z.number().positive(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("alcohol_kcal_calculator", async ({ volume_oz, proof }) => {
      const kcal = volume_oz * proof * 0.8;
      const percentEthanol = proof / 2;
      return ok({
        volume_oz,
        proof,
        percent_ethyl_alcohol: percentEthanol,
        kcal: Math.round(kcal * 10) / 10,
        disclaimer: DISCLAIMER,
      });
    })
  );

  // ── respiratory_quotient_interpreter ──────────────────────────────────────
  server.registerTool(
    "respiratory_quotient_interpreter",
    {
      title: "Respiratory Quotient (RQ) Interpreter",
      description:
        "Interpret a measured respiratory quotient (RQ = VCO2/VO2) from indirect calorimetry against the " +
        "reference fuel-mixture values: 1.0=carbohydrate, 0.85=mixed diet, 0.82=protein, 0.7=fat, " +
        "<=0.65=ketone production. Values >1 suggest net fat synthesis / excess carbohydrate or total " +
        "caloric intake; very low values may indicate inadequate nutrient intake. Note: per McClave et al " +
        "(2003), RQ has low sensitivity/specificity for detecting over/underfeeding in practice and is best " +
        "used as a marker of measurement validity (confirming RQ is in the physiologic 0.65-1.2 range).",
      inputSchema: {
        rq: z.number().positive(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("respiratory_quotient_interpreter", async ({ rq }) => {
      let interpretation: string;
      let closestReference: string;

      if (rq > 1) {
        interpretation =
          "RQ > 1: suggests net fat synthesis (lipogenesis), high carbohydrate/glucose intake, or excessive " +
          "total caloric intake (overfeeding).";
        closestReference = "above carbohydrate (1.0)";
      } else if (rq >= 0.92) {
        interpretation = "Close to 1.0 — fuel mixture weighted toward carbohydrate oxidation.";
        closestReference = "carbohydrate (1.0)";
      } else if (rq >= 0.78) {
        interpretation = "Close to 0.85 — consistent with a mixed diet (typical resting fuel mixture).";
        closestReference = "mixed diet (0.85)";
      } else if (rq >= 0.72) {
        interpretation = "Close to 0.7-0.82 — fuel mixture weighted toward fat/protein oxidation.";
        closestReference = "fat (0.7) / protein (0.82)";
      } else if (rq > 0.65) {
        interpretation =
          "Approaching 0.65 — fuel mixture heavily weighted toward fat oxidation; may reflect inadequate " +
          "nutrient/caloric intake.";
        closestReference = "fat (0.7), trending toward ketone production";
      } else {
        interpretation =
          "RQ <= 0.65: consistent with ketone production, typically seen with markedly inadequate nutrient " +
          "intake (e.g. starvation, severe underfeeding).";
        closestReference = "ketone production (<=0.65)";
      }

      return ok({
        rq,
        closest_reference_value: closestReference,
        interpretation,
        note:
          "RQ has been shown to correlate poorly with percent calories provided/required in hospitalized " +
          "patients (McClave et al, 2003) — use primarily to confirm the measurement is physiologically " +
          "plausible rather than to titrate feeding.",
        disclaimer: DISCLAIMER,
      });
    })
  );
}
