import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerFoodTools } from "../tools/foodTools.js";
import { registerClinicalTools } from "../tools/clinicalTools.js";
import { registerRagTools } from "../tools/ragTools.js";
import { registerEducationTools } from "../tools/educationTools.js";
import { registerPediatricTools } from "../tools/pediatricTools.js";
import { registerEnergyExpenditureTools } from "../tools/energyExpenditureTools.js";
import { registerWhoGrowthTools } from "../tools/whoGrowthTools.js";
import { registerNacsClassificationTools } from "../tools/nacsClassificationTools.js";
import { registerAspenRefeedingTools } from "../tools/aspenRefeedingTools.js";
import { registerGlimMalnutritionTools } from "../tools/glimMalnutritionTools.js";
import { registerSgaAssessmentTools } from "../tools/sgaAssessmentTools.js";

/**
 * Builds a new McpServer instance with every Chakudya tool registered.
 *
 * A fresh instance is created per MCP session (see src/index.ts) — the tools
 * themselves are stateless (they just call the Chakudya API), so this is
 * cheap, and it keeps sessions fully isolated from one another as the MCP
 * Streamable HTTP spec expects.
 */
export function createChakudyaMcpServer(): McpServer {
  const server = new McpServer({
    name: "chakudya-nutrition-registry",
    version: "1.0.0",
  });

  registerFoodTools(server);
  registerClinicalTools(server);
  registerRagTools(server);
  registerEducationTools(server);
  registerPediatricTools(server);
  registerEnergyExpenditureTools(server);
  registerWhoGrowthTools(server);
  registerNacsClassificationTools(server);
  registerAspenRefeedingTools(server);
  registerGlimMalnutritionTools(server);
  registerSgaAssessmentTools(server);

  return server;
}
