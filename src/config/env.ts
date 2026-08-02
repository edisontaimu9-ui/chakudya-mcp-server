import "dotenv/config";
import { z } from "zod";

/**
 * All configuration for the process is validated once, at startup, right
 * here. If something required is missing or malformed we fail loudly and
 * immediately instead of limping along and failing confusingly on the first
 * request.
 */
const EnvSchema = z.object({
  CHAKUDYA_API_BASE_URL: z
    .string()
    .url()
    .default("https://chakudya-api.edisontaimu9.workers.dev"),

  // Optional: only required if you wire up an admin-gated CNR tool later.
  CHAKUDYA_ADMIN_API_KEY: z.string().optional(),

  PORT: z.coerce.number().int().positive().default(8787),

  // Required in production; the server will refuse to start without it
  // unless NODE_ENV === "development".
  MCP_AUTH_TOKEN: z.string().optional(),

  MCP_ALLOWED_ORIGINS: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    ),

  MCP_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(60),

  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("[env] Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

if (env.NODE_ENV === "production" && !env.MCP_AUTH_TOKEN) {
  console.error(
    "[env] MCP_AUTH_TOKEN is required when NODE_ENV=production. " +
      "Refusing to start an unauthenticated MCP server in production."
  );
  process.exit(1);
}

if (env.NODE_ENV !== "production" && !env.MCP_AUTH_TOKEN) {
  console.warn(
    "[env] MCP_AUTH_TOKEN is not set. Running WITHOUT authentication " +
      "(fine for local development only)."
  );
}
