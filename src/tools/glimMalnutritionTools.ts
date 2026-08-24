import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, safeTool } from "../utils/toolResult.js";

/**
 * GLIM (Global Leadership Initiative on Malnutrition) criteria for the
 * diagnosis of malnutrition in adults.
 *
 * Source: Cederholm T, Jensen GL, Correia MITD, et al. GLIM criteria for
 * the diagnosis of malnutrition – A consensus report from the global
 * clinical nutrition community. J Cachexia Sarcopenia Muscle.
 * 2019;10(1):207-217. DOI: 10.1002/jcsm.12383.
 *
 * Three tools:
 * - glim_malnutrition_diagnosis   — Table 3: requires ≥1 phenotypic
 *                                   criterion (weight loss, low BMI,
 *                                   reduced muscle mass) AND ≥1 etiologic
 *                                   criterion (reduced food intake or
 *                                   assimilation, disease burden/
 *                                   inflammation) to diagnose malnutrition.
 * - glim_malnutrition_severity    — Table 4: grades diagnosed malnutrition
 *                                   as Stage 1 (moderate) or Stage 2
 *                                   (severe) using phenotypic criteria only.
 * - glim_etiology_classification  — Table 5: sorts a malnutrition diagnosis
 *                                   into one of four etiology-based
 *                                   categories, used to guide intervention
 *                                   and anticipated outcomes.
 *
 * This is GLIM's two-step model for the *second* step (assessment/
 * diagnosis/severity grading) — it assumes risk screening (step 1, via any
 * validated tool such as MUST/MNA-SF/NRS-2002) has already flagged the
 * patient as "at risk." Weight loss and BMI are auto-classified from
 * numbers; reduced muscle mass, reduced food intake/assimilation, and
 * inflammation are qualitative/compound judgments per the source paper —
 * they are taken as an already-assessed level or presence rather than
 * guessed at from a numeric proxy, except where GLIM itself gives numeric
 * thresholds (e.g. ≤50% of estimated energy requirement for >1 week).
 *
 * Pure table lookup / classification — no Chakudya API calls. Educational/
 * clinical-support classification only, not a substitute for individualized
 * clinical assessment or comprehensive nutrition assessment by a qualified
 * practitioner (e.g. a dietitian).
 */

const GLIM_DISCLAIMER =
  "Classification only, per GLIM Criteria for the Diagnosis of Malnutrition (Cederholm et al, " +
  "J Cachexia Sarcopenia Muscle. 2019;10(1):207-217). GLIM assumes prior risk screening by a " +
  "validated tool. Only phenotypic criteria are used for severity grading; etiologic criteria are " +
  "used to guide intervention and anticipated outcomes, not severity. Not a substitute for " +
  "individualized clinical assessment or comprehensive nutrition assessment by a qualified " +
  "practitioner.";

type WeightLossTimeframe = "within_6_months" | "beyond_6_months";
type BmiRegion = "non_asia" | "asia";
type MuscleMassSeverity = "none" | "mild_to_moderate" | "severe";
type InflammationLevel = "none" | "mild_to_moderate" | "severe";
type MetLevel = "not_met" | "moderate" | "severe";

function classifyWeightLoss(percent: number, timeframe: WeightLossTimeframe): MetLevel {
  if (timeframe === "within_6_months") {
    if (percent > 10) return "severe";
    if (percent >= 5) return "moderate";
    return "not_met";
  }
  // beyond_6_months
  if (percent > 20) return "severe";
  if (percent >= 10) return "moderate";
  return "not_met";
}

function classifyBmi(bmi: number, ageYears: number, region: BmiRegion): MetLevel {
  const elderly = ageYears >= 70;
  if (region === "asia") {
    // Table 3 gives only the diagnostic (moderate-equivalent) Asia thresholds;
    // Table 4 does not publish separate Asia severity cutoffs.
    const threshold = elderly ? 20 : 18.5;
    return bmi < threshold ? "moderate" : "not_met";
  }
  const severeThreshold = elderly ? 20 : 18.5;
  const moderateThreshold = elderly ? 22 : 20;
  if (bmi < severeThreshold) return "severe";
  if (bmi < moderateThreshold) return "moderate";
  return "not_met";
}

function muscleMassToMetLevel(severity: MuscleMassSeverity): MetLevel {
  if (severity === "severe") return "severe";
  if (severity === "mild_to_moderate") return "moderate";
  return "not_met";
}

export function registerGlimMalnutritionTools(server: McpServer): void {
  // ── Diagnosis (Table 3) ──────────────────────────────────────────────
  server.registerTool(
    "glim_malnutrition_diagnosis",
    {
      title: "GLIM Malnutrition Diagnosis (Table 3)",
      description:
        "Determine whether an adult patient already flagged 'at risk' by a validated screening tool " +
        "(MUST/MNA-SF/NRS-2002/etc) meets GLIM diagnostic criteria for malnutrition, per Table 3. " +
        "Diagnosis requires at least one phenotypic criterion (weight loss, low BMI, reduced muscle " +
        "mass) AND at least one etiologic criterion (reduced food intake/assimilation, disease burden/" +
        "inflammation). Weight loss and BMI are auto-classified from numbers; reduced muscle mass " +
        "(assessed by DXA/BIA/CT/MRI or, where unavailable, physical exam or MUAC/calf circumference) " +
        "is taken as an already-assessed clinical judgment.",
      inputSchema: {
        weight_loss_percent: z
          .number()
          .optional()
          .describe("Percent body weight lost; interpreted together with weight_loss_timeframe"),
        weight_loss_timeframe: z
          .enum(["within_6_months", "beyond_6_months"])
          .optional()
          .describe(
            "Per Table 3: criterion met at >5% within past 6 months, or >10% beyond 6 months"
          ),
        bmi: z.number().positive().optional(),
        age_years: z
          .number()
          .positive()
          .optional()
          .describe("Required together with bmi — cutoffs differ for <70y vs >=70y"),
        bmi_region: z
          .enum(["non_asia", "asia"])
          .optional()
          .describe(
            "Non-Asia: <20 if <70y or <22 if >=70y. Asia: <18.5 if <70y or <20 if >=70y. Defaults " +
              "to non_asia if omitted."
          ),
        reduced_muscle_mass: z
          .boolean()
          .optional()
          .describe(
            "Whether muscle mass is reduced per a validated body composition method (DXA/BIA/CT/MRI) " +
              "or, where unavailable, physical exam/anthropometry (e.g. mid-arm or calf circumference); " +
              "grip strength may support but does not itself establish this criterion"
          ),
        reduced_food_intake_or_assimilation: z
          .boolean()
          .optional()
          .describe(
            "Met if: <=50% of estimated energy requirement for >1 week, OR any reduction in intake " +
              "for >2 weeks, OR any chronic GI condition that adversely affects food assimilation or " +
              "absorption (e.g. short bowel syndrome, pancreatic insufficiency, post-bariatric surgery, " +
              "esophageal strictures, gastroparesis, intestinal pseudo-obstruction). GI symptoms " +
              "(dysphagia, nausea, vomiting, diarrhea, constipation, abdominal pain) are supportive " +
              "indicators, not the criterion itself — judge severity/frequency/duration clinically."
          ),
        inflammation_or_disease_burden: z
          .boolean()
          .optional()
          .describe(
            "Met if there is acute disease/injury-related inflammation (e.g. major infection, burns, " +
              "trauma, closed head injury) or chronic disease-related inflammation (e.g. malignancy, " +
              "COPD, congestive heart failure, chronic kidney/liver disease, rheumatoid arthritis, or " +
              "any disease with chronic/recurrent inflammation). Transient mild inflammation does not " +
              "meet this criterion. CRP may be used as a supportive lab measure."
          ),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool(
      "glim_malnutrition_diagnosis",
      async ({
        weight_loss_percent,
        weight_loss_timeframe,
        bmi,
        age_years,
        bmi_region,
        reduced_muscle_mass,
        reduced_food_intake_or_assimilation,
        inflammation_or_disease_burden,
      }) => {
        const phenotypic: Array<{ criterion: string; met: boolean; basis: string }> = [];
        const etiologic: Array<{ criterion: string; met: boolean; basis: string }> = [];

        if (weight_loss_percent !== undefined && weight_loss_timeframe) {
          const level = classifyWeightLoss(weight_loss_percent, weight_loss_timeframe);
          phenotypic.push({
            criterion: "weight_loss",
            met: level !== "not_met",
            basis: `${weight_loss_percent}% ${weight_loss_timeframe.replace(/_/g, " ")}: threshold >5% within 6 months or >10% beyond 6 months`,
          });
        }

        if (bmi !== undefined && age_years !== undefined) {
          const region = bmi_region ?? "non_asia";
          const level = classifyBmi(bmi, age_years, region);
          const elderly = age_years >= 70;
          const basis =
            region === "asia"
              ? `BMI ${bmi}, age ${age_years} (Asia): threshold <${elderly ? 20 : 18.5}`
              : `BMI ${bmi}, age ${age_years}: threshold <${elderly ? 22 : 20}`;
          phenotypic.push({ criterion: "low_bmi", met: level !== "not_met", basis });
        }

        if (reduced_muscle_mass !== undefined) {
          phenotypic.push({
            criterion: "reduced_muscle_mass",
            met: reduced_muscle_mass,
            basis: "Clinician-assessed via validated body composition method or physical exam/anthropometry",
          });
        }

        if (reduced_food_intake_or_assimilation !== undefined) {
          etiologic.push({
            criterion: "reduced_food_intake_or_assimilation",
            met: reduced_food_intake_or_assimilation,
            basis: "<=50% of estimated energy requirement >1 week, any reduction >2 weeks, or a chronic GI condition impairing assimilation",
          });
        }

        if (inflammation_or_disease_burden !== undefined) {
          etiologic.push({
            criterion: "inflammation_or_disease_burden",
            met: inflammation_or_disease_burden,
            basis: "Acute disease/injury-related or chronic disease-related inflammation",
          });
        }

        if (phenotypic.length === 0 || etiologic.length === 0) {
          throw new Error(
            "Provide at least one phenotypic criterion (weight_loss, bmi+age, or reduced_muscle_mass) " +
              "and at least one etiologic criterion (reduced_food_intake_or_assimilation or " +
              "inflammation_or_disease_burden)."
          );
        }

        const phenotypicMet = phenotypic.filter((c) => c.met);
        const etiologicMet = etiologic.filter((c) => c.met);
        const meetsGlimCriteria = phenotypicMet.length >= 1 && etiologicMet.length >= 1;

        return ok(
          {
            phenotypicCriteria: phenotypic,
            etiologicCriteria: etiologic,
            phenotypicCriteriaMetCount: phenotypicMet.length,
            etiologicCriteriaMetCount: etiologicMet.length,
            meetsGlimCriteriaForMalnutrition: meetsGlimCriteria,
            note: meetsGlimCriteria
              ? "Diagnosis met. Use glim_malnutrition_severity to grade severity and glim_etiology_classification to categorize etiology."
              : "Diagnosis not met with the criteria provided — either no phenotypic criterion, no etiologic criterion, or neither was assessed as met. Consider whether additional criteria (e.g. reduced muscle mass) should be assessed before ruling out malnutrition.",
          },
          { disclaimer: GLIM_DISCLAIMER }
        );
      }
    )
  );

  // ── Severity grading (Table 4) ───────────────────────────────────────
  server.registerTool(
    "glim_malnutrition_severity",
    {
      title: "GLIM Malnutrition Severity Grading (Table 4)",
      description:
        "Grade the severity of a GLIM-diagnosed malnutrition (see glim_malnutrition_diagnosis) as " +
        "Stage 1 (moderate) or Stage 2 (severe), per Table 4. Only phenotypic criteria (weight loss, " +
        "BMI, reduced muscle mass) are used for severity — etiologic criteria inform intervention, " +
        "not severity. Only one phenotypic criterion needs to reach a given stage's threshold for " +
        "the patient to be graded at that stage; severe outranks moderate.",
      inputSchema: {
        weight_loss_percent: z.number().optional(),
        weight_loss_timeframe: z
          .enum(["within_6_months", "beyond_6_months"])
          .optional()
          .describe(
            "Within 6 months: moderate 5-10%, severe >10%. Beyond 6 months: moderate 10-20%, severe >20%."
          ),
        bmi: z.number().positive().optional(),
        age_years: z.number().positive().optional().describe("Required together with bmi"),
        bmi_region: z
          .enum(["non_asia", "asia"])
          .optional()
          .describe(
            "Non-Asia only: moderate <20 (<70y) / <22 (>=70y); severe <18.5 (<70y) / <20 (>=70y). " +
              "Table 4 gives no separate Asia severity cutoffs — if bmi_region is 'asia', BMI is " +
              "reported for reference but excluded from severity grading, with a note to that effect."
          ),
        muscle_mass_deficit: z
          .enum(["none", "mild_to_moderate", "severe"])
          .optional()
          .describe("Clinician-assessed degree of muscle mass deficit per validated methods"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool(
      "glim_malnutrition_severity",
      async ({
        weight_loss_percent,
        weight_loss_timeframe,
        bmi,
        age_years,
        bmi_region,
        muscle_mass_deficit,
      }) => {
        const criteria: Array<{ criterion: string; level: MetLevel; basis: string; excluded?: string }> = [];

        if (weight_loss_percent !== undefined && weight_loss_timeframe) {
          const level = classifyWeightLoss(weight_loss_percent, weight_loss_timeframe);
          criteria.push({
            criterion: "weight_loss",
            level,
            basis:
              weight_loss_timeframe === "within_6_months"
                ? `${weight_loss_percent}% within 6 months: moderate 5-10%, severe >10%`
                : `${weight_loss_percent}% beyond 6 months: moderate 10-20%, severe >20%`,
          });
        }

        if (bmi !== undefined && age_years !== undefined) {
          const region = bmi_region ?? "non_asia";
          const elderly = age_years >= 70;
          if (region === "asia") {
            criteria.push({
              criterion: "low_bmi",
              level: "not_met",
              basis: `BMI ${bmi}, age ${age_years} (Asia)`,
              excluded: "Table 4 publishes no Asia-specific severity cutoffs; BMI excluded from severity grading for this region.",
            });
          } else {
            const level = classifyBmi(bmi, age_years, "non_asia");
            criteria.push({
              criterion: "low_bmi",
              level,
              basis: `BMI ${bmi}, age ${age_years}: moderate <${elderly ? 22 : 20}, severe <${elderly ? 20 : 18.5}`,
            });
          }
        }

        if (muscle_mass_deficit) {
          criteria.push({
            criterion: "reduced_muscle_mass",
            level: muscleMassToMetLevel(muscle_mass_deficit),
            basis: "Clinician-assessed deficit: none / mild-to-moderate / severe",
          });
        }

        if (criteria.length === 0) {
          throw new Error(
            "Provide at least one phenotypic criterion: weight_loss_percent+weight_loss_timeframe, " +
              "bmi+age_years, or muscle_mass_deficit."
          );
        }

        const gradableCriteria = criteria.filter((c) => !c.excluded);
        const hasSevere = gradableCriteria.some((c) => c.level === "severe");
        const hasModerate = gradableCriteria.some((c) => c.level === "moderate");

        let severity: "not_graded_no_phenotypic_criterion_met" | "stage_1_moderate" | "stage_2_severe";
        if (hasSevere) severity = "stage_2_severe";
        else if (hasModerate) severity = "stage_1_moderate";
        else severity = "not_graded_no_phenotypic_criterion_met";

        return ok(
          {
            criteria,
            severity,
            note:
              severity === "not_graded_no_phenotypic_criterion_met"
                ? "None of the phenotypic criteria provided reached the moderate or severe threshold. Severity grading per Table 4 assumes the patient already meets GLIM diagnostic criteria (see glim_malnutrition_diagnosis) — confirm diagnosis first if that hasn't been done."
                : "Only one phenotypic criterion needs to reach a stage's threshold for that overall stage to apply.",
          },
          { disclaimer: GLIM_DISCLAIMER }
        );
      }
    )
  );

  // ── Etiology-based diagnosis classification (Table 5) ────────────────
  server.registerTool(
    "glim_etiology_classification",
    {
      title: "GLIM Etiology-Based Diagnosis Classification (Table 5)",
      description:
        "Categorize a GLIM-diagnosed malnutrition into one of four etiology-based categories per " +
        "Table 5, to help guide intervention and anticipated outcomes: chronic disease with " +
        "inflammation, chronic disease with minimal/no perceived inflammation, acute disease or " +
        "injury with severe inflammation, or starvation-related (hunger/food shortage from " +
        "socioeconomic or environmental factors). These categories are not mutually exclusive in " +
        "real patients; provide your best clinical read of the dominant driver.",
      inputSchema: {
        starvation_related: z
          .boolean()
          .optional()
          .describe(
            "Malnutrition driven by hunger/food shortage from socioeconomic or environmental factors " +
              "(e.g. poverty, food insecurity, famine) rather than disease. If true, this category " +
              "takes priority over the disease-based categories below."
          ),
        disease_course: z
          .enum(["acute_disease_or_injury", "chronic_disease", "none"])
          .optional()
          .describe(
            "Whether the dominant driver is an acute disease/injury (e.g. major infection, burns, " +
              "trauma, closed head injury) or a chronic disease (e.g. malignancy, COPD, CHF, chronic " +
              "kidney/liver disease, rheumatoid arthritis)"
          ),
        inflammation_level: z
          .enum(["none", "mild_to_moderate", "severe"])
          .optional()
          .describe(
            "Degree of associated inflammation. Acute disease/injury is typically severe inflammation; " +
              "chronic disease is typically mild-to-moderate, though chronic disease with no perceived " +
              "inflammation is also a distinct GLIM category."
          ),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool(
      "glim_etiology_classification",
      async ({ starvation_related, disease_course, inflammation_level }) => {
        if (starvation_related === undefined && !disease_course && !inflammation_level) {
          throw new Error(
            "Provide at least starvation_related, or disease_course together with inflammation_level."
          );
        }

        let category:
          | "starvation_related"
          | "acute_disease_or_injury_with_severe_inflammation"
          | "chronic_disease_with_inflammation"
          | "chronic_disease_with_minimal_or_no_perceived_inflammation"
          | "unable_to_classify_from_inputs_given";
        let basis: string;

        if (starvation_related) {
          category = "starvation_related";
          basis = "Hunger/food shortage associated with socioeconomic or environmental factors.";
        } else if (disease_course === "acute_disease_or_injury" && inflammation_level === "severe") {
          category = "acute_disease_or_injury_with_severe_inflammation";
          basis = "Acute disease/injury (e.g. major infection, burns, trauma, closed head injury) with severe inflammation.";
        } else if (
          disease_course === "chronic_disease" &&
          (inflammation_level === "mild_to_moderate" || inflammation_level === "severe")
        ) {
          category = "chronic_disease_with_inflammation";
          basis = "Chronic disease (e.g. malignancy, COPD, CHF, chronic kidney/liver disease) with chronic or recurrent inflammation.";
        } else if (disease_course === "chronic_disease" && inflammation_level === "none") {
          category = "chronic_disease_with_minimal_or_no_perceived_inflammation";
          basis = "Chronic disease present but without perceived inflammation.";
        } else {
          category = "unable_to_classify_from_inputs_given";
          basis =
            "The combination of disease_course/inflammation_level given doesn't map cleanly onto one " +
              "of the four Table 5 categories (e.g. acute disease/injury without severe inflammation is " +
              "not a distinct GLIM category) — use clinical judgment or provide a fuller picture.";
        }

        return ok(
          { category, basis },
          { disclaimer: GLIM_DISCLAIMER }
        );
      }
    )
  );
}
