import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { chakudyaClient } from "../clients/chakudyaClient.js";
import { ok, safeTool } from "../utils/toolResult.js";

interface RagAskResponseData {
  answer: string;
  intent: string;
  sources: Array<{ id: number; source: string; title: string }>;
}

const EDUCATIONAL_DISCLAIMER =
  "Educational information only, grounded on the CNR knowledge base (not a diagnosis, prescription, " +
  "or individualized care plan). Verify against current clinical guidelines and a licensed " +
  "clinician/pharmacist before acting on it.";

export function registerEducationTools(server: McpServer) {
  // ── disease_information ──────────────────────────────────────────────────
  server.registerTool(
    "disease_information",
    {
      title: "Disease Information (Nutrition-Focused, Educational)",
      description:
        "Get educational, nutrition-focused background on a disease or condition (e.g. 'type 2 diabetes', " +
        "'chronic kidney disease', 'kwashiorkor') — pathophysiology overview and dietary/nutritional " +
        "management considerations, grounded on the CNR RAG knowledge base with citations. This is " +
        "educational content, not a diagnosis or individualized treatment plan.",
      inputSchema: {
        condition: z.string().min(1).describe("Disease or condition name"),
        focus: z
          .string()
          .optional()
          .describe("Optional angle to focus on, e.g. 'dietary management' or 'complications'"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safeTool("disease_information", async ({ condition, focus }) => {
      const query =
        `Provide a general educational overview of ${condition}` +
        (focus ? `, focusing on ${focus}` : ", including nutritional/dietary management considerations") +
        `. This is for educational purposes for a nutrition/dietetics learner — do not present it as a ` +
        `diagnosis or individualized treatment plan for a specific patient.`;

      const res = await chakudyaClient.post<RagAskResponseData>("/rag/ask", {
        query,
        context: "clinical",
        top_k: 8,
      });

      return ok(
        { condition, ...res.data },
        { disclaimer: EDUCATIONAL_DISCLAIMER }
      );
    })
  );

  // ── medicine_information ─────────────────────────────────────────────────
  server.registerTool(
    "medicine_information",
    {
      title: "Medicine Information (Educational, No Prescribing)",
      description:
        "Get general educational information about a medication's nutrition-relevant profile — e.g. " +
        "known food-drug interactions, nutrient depletion effects, general dietary considerations — " +
        "grounded on the CNR RAG knowledge base with citations. This tool NEVER returns dosing, " +
        "administration instructions, or prescribing guidance; it is strictly educational background, " +
        "not clinical decision support for prescribing.",
      inputSchema: {
        medicine: z.string().min(1).describe("Medication name (generic or brand)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safeTool("medicine_information", async ({ medicine }) => {
      const query =
        `Provide general educational information about ${medicine} relevant to nutrition and dietetics: ` +
        `known food-drug interactions, effects on nutrient absorption/depletion, and general dietary ` +
        `considerations. Do NOT include dosing, administration schedules, or prescribing instructions — ` +
        `this is educational background only, for a nutrition/dietetics learner, not a prescribing ` +
        `reference.`;

      const res = await chakudyaClient.post<RagAskResponseData>("/rag/ask", {
        query,
        context: "clinical",
        top_k: 6,
      });

      return ok(
        { medicine, ...res.data },
        {
          disclaimer:
            EDUCATIONAL_DISCLAIMER +
            " Does not include and must not be used for dosing or prescribing decisions.",
        }
      );
    })
  );
}
