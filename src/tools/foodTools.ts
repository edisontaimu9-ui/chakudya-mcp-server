import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { chakudyaClient, ChakudyaApiError } from "../clients/chakudyaClient.js";
import { ok, safeTool } from "../utils/toolResult.js";

/** Per-100g/ml nutrient shape returned by every CNR food source. */
interface CnrFood {
  id?: string | number;
  food_name: string;
  category?: string | null;
  // Local Malawi FCT rows (from /foods, /foods/:id) store calories as `kcal`;
  // only the /foods/lookup external-cascade fallback normalizes to
  // `energy_kcal`. Accept both and prefer whichever is present.
  energy_kcal?: number | null;
  kcal?: number | null;
  protein_g?: number | null;
  fat_g?: number | null;
  carbs_g?: number | null;
  fiber_g?: number | null;
  sodium_mg?: number | null;
  [key: string]: unknown;
}

const NUTRIENT_KEYS = ["energy_kcal", "protein_g", "fat_g", "carbs_g", "fiber_g", "sodium_mg"] as const;

/** Fills in `energy_kcal` from the local `kcal` column when the API hasn't
 * already normalized it (see CnrFood comment above). Leaves everything else
 * untouched. */
function normalizeFood(food: CnrFood): CnrFood {
  return { ...food, energy_kcal: food.energy_kcal ?? food.kcal ?? null };
}

function scaleNutrients(food: CnrFood, grams: number) {
  const factor = grams / 100;
  const scaled: Record<string, number | null> = {};
  for (const key of NUTRIENT_KEYS) {
    const val = key === "energy_kcal" ? food.energy_kcal ?? food.kcal : food[key];
    scaled[key] = typeof val === "number" ? Math.round(val * factor * 100) / 100 : null;
  }
  return scaled;
}

/** Resolves a food by numeric id, or by name via /foods search when id isn't given. */
async function resolveFood(input: { food_id?: string | number; food_name?: string }): Promise<CnrFood> {
  if (input.food_id !== undefined && input.food_id !== null && input.food_id !== "") {
    const res = await chakudyaClient.get<CnrFood>(`/foods/${input.food_id}`);
    if (!res.data) throw new ChakudyaApiError("Food id not found", 404, "/foods/:id", null);
    return normalizeFood(res.data);
  }
  if (input.food_name) {
    const res = await chakudyaClient.get<CnrFood[]>("/foods", { search: input.food_name, limit: 1 });
    const first = Array.isArray(res.data) ? res.data[0] : undefined;
    if (!first) {
      throw new ChakudyaApiError(
        `No food matching "${input.food_name}" found in the local database`,
        404,
        "/foods",
        null
      );
    }
    return normalizeFood(first);
  }
  throw new ChakudyaApiError("Provide either food_id or food_name", 400, "/foods", null);
}

export function registerFoodTools(server: McpServer) {
  // ── search_food ──────────────────────────────────────────────────────────
  server.registerTool(
    "search_food",
    {
      title: "Search Food",
      description:
        "Search the Chakudya Nutrition Registry (Malawi food composition database) by name. " +
        "Searches the local database first; if nothing matches locally, falls back to the " +
        "external lookup cascade (USDA FoodData Central / Open Food Facts / FatSecret). " +
        "Use this to find a food before calling get_food_details or calculate_nutrients.",
      inputSchema: {
        query: z.string().min(1).describe("Food name to search for, e.g. 'nsima' or 'banana'"),
        category: z.string().optional().describe("Optional category filter"),
        limit: z.number().int().positive().max(100).optional().default(10),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safeTool("search_food", async ({ query, category, limit }) => {
      const local = await chakudyaClient.get<CnrFood[]>("/foods", { search: query, category, limit });
      const localResults = Array.isArray(local.data) ? local.data.map(normalizeFood) : [];
      if (localResults.length > 0) {
        return ok(localResults, { source: "local_database", count: localResults.length });
      }

      // Fall back to the external cascade for foods not yet in CNR.
      // Note: /foods/lookup returns a single best-match object under `data`
      // (not an array, unlike /foods), so normalize both shapes here.
      try {
        const fallback = await chakudyaClient.get<CnrFood[] | CnrFood>("/foods/lookup", { q: query });
        const raw = fallback.data;
        const fallbackResults = Array.isArray(raw)
          ? raw.map(normalizeFood)
          : raw
            ? [normalizeFood(raw)]
            : [];
        return ok(fallbackResults, {
          source: "external_fallback",
          note: "Not found locally; retrieved via USDA/OpenFoodFacts/FatSecret cascade and cached for next time.",
        });
      } catch (e) {
        if (e instanceof ChakudyaApiError && e.status === 404) {
          return ok([], { source: "none", message: `No match for "${query}" in local or external sources.` });
        }
        throw e;
      }
    })
  );

  // ── get_food_details ────────────────────────────────────────────────────
  server.registerTool(
    "get_food_details",
    {
      title: "Get Food Details",
      description:
        "Fetch full details (per-100g/ml nutrients, category) for a single food by its Chakudya database id. " +
        "Use search_food first to find the id.",
      inputSchema: {
        food_id: z.union([z.string(), z.number()]).describe("The CNR food id from search_food"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safeTool("get_food_details", async ({ food_id }) => {
      const res = await chakudyaClient.get<CnrFood>(`/foods/${food_id}`);
      return ok(res.data ? normalizeFood(res.data) : res.data);
    })
  );

  // ── calculate_nutrients ──────────────────────────────────────────────────
  server.registerTool(
    "calculate_nutrients",
    {
      title: "Calculate Nutrients For A Quantity",
      description:
        "Calculate the actual nutrient content of a specific quantity of one food, scaling from the " +
        "database's per-100g/100ml values. Provide either food_id (preferred, from search_food) or " +
        "food_name (will be resolved via search). All CNR nutrient values are per 100g/100ml, so this " +
        "tool does the grams-based scaling for you.",
      inputSchema: {
        food_id: z.union([z.string(), z.number()]).optional(),
        food_name: z.string().optional(),
        quantity_grams: z
          .number()
          .positive()
          .describe("Quantity actually consumed, in grams (or ml for liquids)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safeTool("calculate_nutrients", async ({ food_id, food_name, quantity_grams }) => {
      const food = await resolveFood({ food_id, food_name });
      const scaled = scaleNutrients(food, quantity_grams);
      return ok(
        { food_name: food.food_name, quantity_grams, nutrients: scaled },
        { basis: "per_100g_or_ml_scaled", source_food_id: food.id ?? null }
      );
    })
  );

  // ── analyze_meal ─────────────────────────────────────────────────────────
  server.registerTool(
    "analyze_meal",
    {
      title: "Analyze A Meal (Multiple Foods)",
      description:
        "Given a list of foods and quantities making up a meal, resolve each food in the CNR database, " +
        "scale its nutrients to the quantity eaten, and return both the per-item breakdown and the " +
        "meal-level totals (energy, protein, fat, carbs, fiber, sodium). Each item needs either food_id " +
        "or food_name plus quantity_grams.",
      inputSchema: {
        items: z
          .array(
            z.object({
              food_id: z.union([z.string(), z.number()]).optional(),
              food_name: z.string().optional(),
              quantity_grams: z.number().positive(),
            })
          )
          .min(1)
          .describe("Foods making up the meal"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safeTool("analyze_meal", async ({ items }) => {
      const totals: Record<string, number> = {
        energy_kcal: 0,
        protein_g: 0,
        fat_g: 0,
        carbs_g: 0,
        fiber_g: 0,
        sodium_mg: 0,
      };
      const breakdown: unknown[] = [];
      const warnings: string[] = [];

      for (const item of items) {
        try {
          const food = await resolveFood(item);
          const scaled = scaleNutrients(food, item.quantity_grams);
          breakdown.push({ food_name: food.food_name, quantity_grams: item.quantity_grams, nutrients: scaled });
          for (const key of NUTRIENT_KEYS) {
            const v = scaled[key];
            if (typeof v === "number") totals[key] += v;
          }
        } catch (e) {
          const label = item.food_name ?? item.food_id ?? "unknown item";
          warnings.push(`Skipped "${label}": ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      for (const key of Object.keys(totals)) {
        totals[key] = Math.round(totals[key] * 100) / 100;
      }

      return ok(
        { totals, items: breakdown },
        { basis: "per_100g_or_ml_scaled", warnings: warnings.length ? warnings : undefined }
      );
    })
  );

  // ── barcode_lookup ───────────────────────────────────────────────────────
  server.registerTool(
    "barcode_lookup",
    {
      title: "Packaged Product Lookup",
      description:
        "Look up a packaged food product by barcode (EAN/UPC) and/or free-text product name. Checks the " +
        "community-submitted packaged foods table first, then falls back to the external cascade " +
        "(USDA FoodData Central / Open Food Facts / FatSecret) via the CNR foods/lookup route. At least " +
        "one of barcode or query must be provided.",
      inputSchema: {
        barcode: z.string().min(6).optional().describe("The product barcode, digits only"),
        query: z.string().optional().describe("Free-text product name to search for"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safeTool("barcode_lookup", async ({ barcode, query }) => {
      if (!barcode && !query) {
        throw new ChakudyaApiError("Provide at least one of: barcode, query", 400, "/packaged", null);
      }

      const packaged = await chakudyaClient.get("/packaged", { barcode, search: query, limit: 5 });
      const packagedResults = Array.isArray(packaged.data) ? packaged.data : [];
      if (packagedResults.length > 0) {
        return ok(packagedResults, { source: "community_packaged_foods" });
      }

      try {
        const fallback = await chakudyaClient.get("/foods/lookup", { barcode, q: query });
        return ok(fallback.data ?? [], { source: "external_fallback" });
      } catch (e) {
        if (e instanceof ChakudyaApiError && e.status === 404) {
          return ok([], { message: `No product found for ${barcode ? `barcode ${barcode}` : `"${query}"`}` });
        }
        throw e;
      }
    })
  );

  // ── packaged_food_search ─────────────────────────────────────────────────
  server.registerTool(
    "packaged_food_search",
    {
      title: "Packaged Food Search",
      description:
        "Search packaged/branded food products. Pass a barcode for an exact lookup, and/or a free-text " +
        "query to search by product name (substring match). At least one of barcode or query must be " +
        "provided.",
      inputSchema: {
        query: z.string().optional().describe("Free-text product name search"),
        barcode: z.string().optional(),
        limit: z.number().int().positive().max(50).optional().default(10),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safeTool("packaged_food_search", async ({ query, barcode, limit }) => {
      if (!query && !barcode) {
        throw new ChakudyaApiError("Provide at least one of: query, barcode", 400, "/packaged", null);
      }
      const res = await chakudyaClient.get("/packaged", { barcode, search: query, limit });
      return ok(res.data ?? [], { source: "community_packaged_foods" });
    })
  );
}
