import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, safeTool } from "../utils/toolResult.js";

/**
 * Subjective Global Assessment (SGA) — Canadian Malnutrition Task Force
 * SGA Form and Body Composition Guidance (April 2017).
 *
 * SGA is, by design, a gestalt clinical judgment rather than an additive
 * score: the source form gives descriptive criteria for ratings A/B/C
 * across five domains (nutrient intake, weight change, symptoms,
 * functional capacity, physical exam of fat/muscle/fluid) and asks the
 * clinician to weigh them together, including two documented override
 * paths (the "OR *" trajectory clauses — a patient meeting worse criteria
 * but with clear recent improvement, or meeting better criteria but with
 * recent significant deterioration, can be rated on that trajectory
 * instead). This tool does NOT compute a definitive overall rating from
 * inputs; it structures the domain-by-domain classification against the
 * form's own descriptive criteria and surfaces a worst-domain-dominant
 * suggestion as a starting point for the clinician's synthesis — the form
 * itself is explicit that final rating is subjective.
 *
 * Two tools:
 * - sga_rating_classification — classify each domain per the form's A/B/C
 *   descriptive criteria and surface a suggested overall rating.
 * - sga_physical_exam_reference — reference lookup for the body-composition
 *   guidance table (subcutaneous fat / muscle wasting / fluid retention),
 *   by exam site, to standardize documentation language.
 *
 * Pure table lookup / classification — no Chakudya API calls, no computed
 * z-scores. Educational/clinical-support tool only, not a substitute for
 * a full clinical nutrition assessment.
 */

const SGA_DISCLAIMER =
  "Structuring aid only, per the Canadian Malnutrition Task Force Subjective Global Assessment Form " +
  "(April 2017). SGA is an inherently subjective, gestalt clinical rating — the form itself directs " +
  "the assessor to weigh domains together rather than sum them, and includes trajectory-based " +
  "overrides (recent improvement or deterioration can shift the rating). The suggestedOverallRating " +
  "here is a worst-domain-dominant starting point only, not the form's own algorithm — final rating " +
  "requires clinical synthesis. Not a substitute for a full clinical nutrition assessment.";

type SgaLevel = "A" | "B" | "C";
type ExamSeverity = "normal" | "mild_to_moderate" | "severe";

function levelRank(level: SgaLevel): number {
  return level === "A" ? 0 : level === "B" ? 1 : 2;
}

function rankToLevel(rank: number): SgaLevel {
  return rank === 0 ? "A" : rank === 1 ? "B" : "C";
}

function examSeverityToLevel(sev: ExamSeverity): SgaLevel {
  return sev === "normal" ? "A" : sev === "mild_to_moderate" ? "B" : "C";
}

export function registerSgaAssessmentTools(server: McpServer): void {
  // ── Overall rating structuring (page 1 domains + page 2 A/B/C criteria) ──
  server.registerTool(
    "sga_rating_classification",
    {
      title: "Subjective Global Assessment (SGA) Rating Structuring",
      description:
        "Structure a Subjective Global Assessment by classifying each domain (nutrient intake, weight " +
        "change, symptoms, functional capacity, physical exam of fat/muscle/fluid, metabolic " +
        "requirement) against the SGA form's descriptive A/B/C criteria, and surface a suggested " +
        "overall rating (worst-domain-dominant) as a starting point. SGA is explicitly a gestalt " +
        "clinical judgment, not an additive score — the final rating, and any trajectory-based " +
        "override (recent clear improvement or recent significant deterioration), is the clinician's " +
        "call, not this tool's.",
      inputSchema: {
        nutrient_intake_level: z
          .enum(["adequate", "moderately_reduced", "severely_reduced"])
          .optional()
          .describe(
            "Adequate: no change, adequate intake. Moderately reduced: definite decrease from usual " +
              "(e.g. suboptimal solid diet or full fluids/oral supplements). Severely reduced: minimal " +
              "intake, clear fluids only, or starvation."
          ),
        weight_loss_percent_6_months: z
          .number()
          .optional()
          .describe("Non-fluid weight loss over the past 6 months, as a percent of usual weight"),
        weight_loss_ongoing_or_no_stabilization: z
          .boolean()
          .optional()
          .describe(
            "Whether the weight loss is ongoing / has not stabilized or increased — required to reach " +
              "the >10% (severe) or 5-10% (moderate) categories rather than a stabilized/past loss"
          ),
        symptoms_affecting_intake: z
          .enum(["none", "intermittent_mild_few", "constant_severe_multiple"])
          .optional()
          .describe(
            "Symptoms affecting oral intake (anorexia, nausea, vomiting, dysphagia, diarrhea, pain on " +
              "eating, dental problems, feeling full quickly, constipation)"
          ),
        functional_capacity: z
          .enum(["no_dysfunction", "reduced_ambulation_or_normal_activities", "bed_or_chair_ridden"])
          .optional()
          .describe("Fatigue and progressive loss of function"),
        subcutaneous_fat_loss: z.enum(["normal", "mild_to_moderate", "severe"]).optional(),
        muscle_mass_loss: z.enum(["normal", "mild_to_moderate", "severe"]).optional(),
        edema_or_ascites: z.enum(["normal", "mild_to_moderate", "severe"]).optional(),
        high_metabolic_requirement: z
          .boolean()
          .optional()
          .describe("Presence of a high metabolic requirement (e.g. major sepsis, burns) — contextual, not independently scored"),
        recent_trajectory: z
          .enum(["clear_recent_improvement", "recent_significant_deterioration", "stable"])
          .optional()
          .describe(
            "Per the form's 'OR *' clauses: clear recent improvement in intake/symptoms/function can " +
              "justify rating an otherwise worse-looking patient one level better (toward A/B); recent " +
              "significant deterioration can justify rating an otherwise better-looking patient one " +
              "level worse (toward C). This tool surfaces the note but does not apply the shift " +
              "automatically — that judgment is the clinician's."
          ),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool(
      "sga_rating_classification",
      async ({
        nutrient_intake_level,
        weight_loss_percent_6_months,
        weight_loss_ongoing_or_no_stabilization,
        symptoms_affecting_intake,
        functional_capacity,
        subcutaneous_fat_loss,
        muscle_mass_loss,
        edema_or_ascites,
        high_metabolic_requirement,
        recent_trajectory,
      }) => {
        const domains: Array<{ domain: string; level: SgaLevel; basis: string }> = [];

        if (nutrient_intake_level) {
          const level: SgaLevel =
            nutrient_intake_level === "adequate"
              ? "A"
              : nutrient_intake_level === "moderately_reduced"
                ? "B"
                : "C";
          domains.push({ domain: "nutrient_intake", level, basis: `Intake: ${nutrient_intake_level.replace(/_/g, " ")}` });
        }

        if (weight_loss_percent_6_months !== undefined) {
          let level: SgaLevel = "A";
          if (weight_loss_percent_6_months > 10 && weight_loss_ongoing_or_no_stabilization !== false) {
            level = "C";
          } else if (weight_loss_percent_6_months >= 5) {
            level = "B";
          }
          domains.push({
            domain: "weight_loss",
            level,
            basis: `${weight_loss_percent_6_months}% over 6 months${weight_loss_ongoing_or_no_stabilization !== undefined ? `, ${weight_loss_ongoing_or_no_stabilization ? "ongoing/not stabilized" : "stabilized or improving"}` : ""}: <5% = A, 5-10% without stabilization = B, >10% ongoing = C`,
          });
        }

        if (symptoms_affecting_intake) {
          const level: SgaLevel =
            symptoms_affecting_intake === "none"
              ? "A"
              : symptoms_affecting_intake === "intermittent_mild_few"
                ? "B"
                : "C";
          domains.push({ domain: "symptoms", level, basis: `Symptoms: ${symptoms_affecting_intake.replace(/_/g, " ")}` });
        }

        if (functional_capacity) {
          const level: SgaLevel =
            functional_capacity === "no_dysfunction"
              ? "A"
              : functional_capacity === "reduced_ambulation_or_normal_activities"
                ? "B"
                : "C";
          domains.push({ domain: "functional_capacity", level, basis: `Function: ${functional_capacity.replace(/_/g, " ")}` });
        }

        if (subcutaneous_fat_loss) {
          domains.push({
            domain: "subcutaneous_fat_loss",
            level: examSeverityToLevel(subcutaneous_fat_loss),
            basis: `Physical exam: ${subcutaneous_fat_loss.replace(/_/g, " ")}`,
          });
        }

        if (muscle_mass_loss) {
          domains.push({
            domain: "muscle_mass_loss",
            level: examSeverityToLevel(muscle_mass_loss),
            basis: `Physical exam: ${muscle_mass_loss.replace(/_/g, " ")}`,
          });
        }

        if (edema_or_ascites) {
          domains.push({
            domain: "edema_or_ascites",
            level: examSeverityToLevel(edema_or_ascites),
            basis: `Physical exam: ${edema_or_ascites.replace(/_/g, " ")}`,
          });
        }

        if (domains.length === 0) {
          throw new Error("Provide at least one domain to classify.");
        }

        const worstRank = Math.max(...domains.map((d) => levelRank(d.level)));
        const suggestedOverallRating = rankToLevel(worstRank);

        return ok(
          {
            domains,
            highMetabolicRequirement: high_metabolic_requirement ?? null,
            suggestedOverallRating,
            suggestedOverallRatingBasis:
              "Worst-domain-dominant heuristic (the lowest-scoring domain determines the suggestion) — a common starting point, not the form's own method.",
            recentTrajectoryNote:
              recent_trajectory === "clear_recent_improvement"
                ? "Clear recent improvement noted: per the form's 'OR *' clause, this can justify rating one level better than the domain snapshot above (e.g. C-looking criteria with adequate recent intake, weight stabilization, symptom resolution, and functional improvement can be rated B; B-looking criteria with the same pattern can be rated A)."
                : recent_trajectory === "recent_significant_deterioration"
                  ? "Recent significant deterioration noted: per the form's 'OR *' clause, this can justify rating one level worse than the domain snapshot above, even if cumulative losses don't yet meet the worse category's usual thresholds."
                  : undefined,
            note:
              "SGA rating is a gestalt clinical judgment integrating all domains, not a sum or a strict " +
                "worst-domain rule — use this classification as a structured starting point for that judgment, not as the final rating.",
          },
          { disclaimer: SGA_DISCLAIMER }
        );
      }
    )
  );

  // ── Physical exam reference (body composition guidance table) ────────
  server.registerTool(
    "sga_physical_exam_reference",
    {
      title: "SGA Physical Exam Reference (Body Composition Guidance)",
      description:
        "Look up the SGA body-composition guidance descriptors (Normal / Mild-Moderate / Severe) for " +
        "a given physical exam site — subcutaneous fat, muscle wasting, or fluid retention — to " +
        "standardize exam documentation language. Pure reference lookup; does not classify a patient.",
      inputSchema: {
        category: z.enum(["subcutaneous_fat", "muscle_wasting", "fluid_retention"]),
        site: z
          .string()
          .optional()
          .describe(
            "Optional specific site to filter to, e.g. 'triceps', 'temple', 'clavicle', 'quadriceps', " +
              "'edema', 'ascites'. Omit to return all sites for the category."
          ),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("sga_physical_exam_reference", async ({ category, site }) => {
      const tables: Record<string, Array<{ site: string; normal: string; mild_to_moderate: string; severe: string }>> = {
        subcutaneous_fat: [
          {
            site: "under_the_eyes",
            normal: "Slightly bulging area",
            mild_to_moderate: "Somewhat hollow look, slightly dark circles",
            severe: "Hollowed look, depression, dark circles",
          },
          {
            site: "triceps",
            normal: "Large space between fingers",
            mild_to_moderate: "Some depth to fat tissue, but not ample. Loose fitting skin.",
            severe: "Very little space between fingers, or fingers touch",
          },
          {
            site: "ribs_lower_back_sides_of_trunk",
            normal: "Chest is full; ribs do not show. Slight to no protrusion of the iliac crest",
            mild_to_moderate: "Ribs obvious, but indentations are not marked. Iliac crest somewhat prominent",
            severe: "Indentation between ribs very obvious. Iliac crest very prominent",
          },
        ],
        muscle_wasting: [
          {
            site: "temple",
            normal: "Well-defined muscle",
            mild_to_moderate: "Slight depression",
            severe: "Hollowing, depression",
          },
          {
            site: "clavicle",
            normal: "Not visible in males; may be visible but not prominent in females",
            mild_to_moderate: "Some protrusion; may not be all the way along",
            severe: "Protruding/prominent bone",
          },
          {
            site: "shoulder",
            normal: "Rounded",
            mild_to_moderate: "No square look; acromion process may protrude slightly",
            severe: "Square look; bones prominent",
          },
          {
            site: "scapula_ribs",
            normal: "Bones not prominent; no significant depressions",
            mild_to_moderate: "Mild depressions or bone may show slightly; not all areas",
            severe: "Bones prominent; significant depressions",
          },
          {
            site: "quadriceps",
            normal: "Well defined",
            mild_to_moderate: "Depression/atrophy medially",
            severe: "Prominent knee, severe depression medially",
          },
          {
            site: "interosseous_muscle_thumb_forefinger",
            normal: "Muscle protrudes; could be flat in females",
            mild_to_moderate: "Slightly depressed",
            severe: "Flat or depressed area",
          },
        ],
        fluid_retention: [
          {
            site: "edema",
            normal: "None",
            mild_to_moderate: "Pitting edema of extremities / pitting to knees, possible sacral edema if bedridden",
            severe: "Pitting beyond knees, sacral edema if bedridden, may also have generalized edema",
          },
          {
            site: "ascites",
            normal: "Absent",
            mild_to_moderate: "Present (may only be present on imaging)",
            severe: "Present (may only be present on imaging)",
          },
        ],
      };

      const rows = tables[category];
      const filtered = site
        ? rows.filter((r) => r.site.toLowerCase().includes(site.toLowerCase()))
        : rows;

      if (site && filtered.length === 0) {
        throw new Error(
          `No site matching "${site}" in category "${category}". Available sites: ${rows.map((r) => r.site).join(", ")}`
        );
      }

      return ok(
        {
          category,
          sites: filtered,
          agingNote:
            category === "muscle_wasting"
              ? "In the elderly, prominent tendons and hollowing is the result of aging and may not reflect malnutrition."
              : undefined,
        },
        { disclaimer: SGA_DISCLAIMER }
      );
    })
  );
}
