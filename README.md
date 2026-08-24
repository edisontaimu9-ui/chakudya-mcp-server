# Chakudya MCP Server

An [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server that exposes the **Chakudya
Nutrition Registry (CNR)** API as a set of MCP tools, so any MCP-compatible client (Claude, Claude Code,
other LLM agents) can search Malawian food data, run clinical nutrition lookups, and query the RAG
knowledge base directly.

**This is a new, separate layer. It does not replace or modify the Chakudya Worker.** It's a small
Node/TypeScript HTTP service that sits in front of your existing API and translates MCP tool calls into
plain HTTP requests against the routes your Worker already serves.

```
MCP Client (Claude, etc.)
        │  Streamable HTTP (JSON-RPC over HTTP + SSE)
        ▼
Chakudya MCP Server  (this project)
        │  plain HTTPS fetch()
        ▼
Chakudya Worker API  (unchanged) → Supabase / Cohere / Groq / USDA / OFF / FatSecret
```

## Why a separate server, not a Worker

The official MCP TypeScript SDK's `StreamableHTTPServerTransport` is built for Node's
`http.IncomingMessage`/`ServerResponse`. Cloudflare Workers use the Fetch API instead, and the SDK's
web-standard variant (`WebStandardStreamableHTTPServerTransport`) is newer and less battle-tested for
production session management. Running this as a plain Node service (Docker, Render, Fly.io, a VPS,
etc.) is the more standard, better-documented path today, and it keeps this concern fully decoupled from
your Worker's deploy cycle. Nothing stops you from porting it to the web-standard transport on Workers
later if you want a single-platform deploy — the tool logic in `src/tools/*` doesn't care which
transport wraps it.

## Tools

All 31 tools either call your existing Chakudya Worker over HTTPS, or are pure in-process calculation/table
lookups — none of them touch Supabase, Cohere, or Groq directly, and none of them need `ADMIN_API_KEY`
(every route they use is public).

| Tool | Chakudya route(s) used |
|---|---|
| `search_food` | `GET /foods` → falls back to `GET /foods/lookup` |
| `get_food_details` | `GET /foods/:id` |
| `calculate_nutrients` | `GET /foods` or `/foods/:id`, then scales per-100g values in-process |
| `analyze_meal` | same as above, looped and summed across multiple items |
| `barcode_lookup` | `GET /packaged?barcode=` → falls back to `GET /foods/lookup?barcode=` |
| `packaged_food_search` | `GET /packaged` and/or `GET /products` |
| `diabetes_exchange_lookup` | `GET /exchange` |
| `renal_exchange_lookup` | `GET /renal` |
| `enteral_formula_lookup` | `GET /formulas` |
| `nutrition_calculator` | none — pure BMI/BMR (Mifflin-St Jeor)/TDEE math |
| `rag_retrieve` | `POST /rag/retrieve` |
| `search_guidelines` | `POST /rag/ask` (`context: "clinical"`) |
| `retrieve_evidence` | `POST /rag/ask` (`context: "both"`, higher `top_k`) |
| `disease_information` | `POST /rag/ask`, query framed for educational disease overview |
| `medicine_information` | `POST /rag/ask`, query explicitly instructed to exclude dosing/prescribing |
| `pediatric_fluid_requirements` | none — pure Holliday-Segar math |
| `pediatric_energy_requirements` | none — pure Schofield/WHO BMR + DRI/FAO 2004 + DRI/IOM 2006 math |
| `pediatric_protein_requirements` | none — pure IOM 2005 / ASPEN sick-child / preterm table lookup |
| `pediatric_growth_velocity` | none — pure ASPEN handbook growth-velocity table lookup |
| `pediatric_enteral_feed_advancement` | none — pure enteral feed protocol table lookup |
| `iom_dri_eer_calculator` | none — pure IOM/DRI (2002/2005) EER prediction-equation math, all life stages |
| `met_activity_energy_calculator` | none — pure MET x weight x duration math |
| `alcohol_kcal_calculator` | none — pure volume x proof math |
| `respiratory_quotient_interpreter` | none — pure RQ reference-value interpretation |
| `preterm_fluid_energy_requirements` | none — pure preterm fluid/energy table lookup |
| `macronutrient_distribution_check` | none — pure DRI macronutrient % range table lookup |
| `tee_activity_band_estimator` | none — pure REE x activity-band multiplier math |
| `fever_stress_ree_adjustment` | none — pure fever REE adjustment math |
| `atwater_food_energy_calculator` | none — pure Atwater factor (4/9/4/7) math |
| `dri_eer_reference_lookup` | none — pure DRI Table 2.2 reference table lookup |
| `who_growth_zscore` | none — pure WHO Child Growth Standards LMS z-score/percentile calculation (weight-for-age, height-for-age, BMI-for-age 0-5y) |

`disease_information` and `medicine_information` always return an educational disclaimer alongside the
answer and are prompted to avoid diagnosis/prescribing language — but they're still LLM-generated text
grounded on whatever's in your RAG knowledge base, not a verified medical reference. Treat them as a
starting point for a learner, same as the rest of the RAG-backed tools.

`pediatric_*` tools (source: BND 415 Clinical Nutrition — Paediatric Medicine Resources) and
`iom_dri_eer_calculator`/`met_activity_energy_calculator`/`alcohol_kcal_calculator`/
`respiratory_quotient_interpreter` (source: Nelms/Ireton-Jones, *Nutrition Therapy and Pathophysiology*,
Ch. 2) are pure calculation/lookup tools — no network call, no CNR data dependency. Same estimate-only
caveat applies: not a substitute for individualized clinical assessment or measured indirect calorimetry.

## Project layout

```
src/
├── index.ts                 Express app, Streamable HTTP session wiring, graceful shutdown
├── config/env.ts            Zod-validated environment config, loaded once at startup
├── clients/chakudyaClient.ts  Fetch wrapper for the Chakudya Worker (GET/POST, error normalization)
├── server/
│   ├── createServer.ts      Builds one McpServer instance and registers all tool modules
│   └── security.ts          Bearer auth + per-IP rate limiting for this server's /mcp endpoint
├── tools/
│   ├── foodTools.ts
│   ├── clinicalTools.ts
│   ├── ragTools.ts
│   ├── educationTools.ts
│   ├── pediatricTools.ts        Pediatric fluid/energy/protein/growth/enteral-feed calculators
│   └── energyExpenditureTools.ts  IOM/DRI EER, MET activity, alcohol kcal, RQ interpreter
│   └── whoGrowthTools.ts        WHO Child Growth Standards z-score/percentile calculator (LMS)
├── data/
│   └── who/                     WHO Child Growth Standards LMS tables (JSON, per standard+sex)
└── utils/
    ├── logger.ts             Structured JSON logging
    └── toolResult.ts         Consistent success/error shaping for every tool handler
```

## Environment variables

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Notes |
|---|---|---|
| `CHAKUDYA_API_BASE_URL` | no (defaults to the maintainer's own Worker) | If you're forking this repo to front your own CNR instance, set this to your own Worker's URL instead of relying on the default |
| `CHAKUDYA_ADMIN_API_KEY` | no | Not used by any current tool; only needed if you add an admin-gated tool later |
| `PORT` | no (default `8787`) | |
| `MCP_AUTH_TOKEN` | **yes in production** | Bearer token MCP clients must send. Server refuses to start in production without it |
| `MCP_ALLOWED_ORIGINS` | no | Comma-separated CORS origins; leave blank to disable browser access |
| `MCP_RATE_LIMIT_PER_MIN` | no (default `60`) | Per-IP cap on this server's own `/mcp` endpoint |
| `NODE_ENV` | no (default `development`) | Set to `production` for deploys |

## Security considerations

- **Auth is mandatory in production.** `env.ts` exits the process at startup if `NODE_ENV=production` and
  `MCP_AUTH_TOKEN` is unset — this is a deliberate fail-closed check, not just a warning.
- **This server sits in front of your rate-limited RAG routes.** `/rag/ask` on your Worker is capped at
  15 req/min per IP — but that's per *client* IP as seen by the Worker, which would be *this server's*
  IP once deployed, shared across everyone using it. The MCP-level rate limiter
  (`MCP_RATE_LIMIT_PER_MIN`) exists so one misbehaving MCP client can't silently exhaust that budget for
  everyone else. Tune it down if you expect multiple concurrent MCP clients.
- **No admin key is embedded or required.** Every tool calls a public CNR route. If you add an
  admin-gated tool later, keep `CHAKUDYA_ADMIN_API_KEY` server-side only — never expose it to the MCP
  client.
- **Session state is in-memory, per-process.** Fine for a single instance. If you ever scale to multiple
  instances behind a load balancer, either enable sticky sessions (route by `Mcp-Session-Id`) or swap the
  `transports` map in `src/index.ts` for a shared store.
- **CORS is off by default.** Only enable `MCP_ALLOWED_ORIGINS` if you have a specific browser-based MCP
  client; server-to-server MCP clients (Claude Desktop, Claude Code, etc.) don't need it.

## Running locally

```bash
cd ~
git clone https://github.com/edisontaimu9-ui/chakudya-mcp-server.git
cd chakudya-mcp-server
cp .env.example .env
# edit .env: set MCP_AUTH_TOKEN to a long random string
npm install
npm run build
npm start
```

Or for iterative dev with auto-reload:

```bash
npm run dev
```

Health check: `curl http://localhost:8787/health`

## Connecting an MCP client

Point any Streamable-HTTP-capable MCP client at:

```
POST/GET/DELETE  https://<your-deployed-host>/mcp
Header: Authorization: Bearer <MCP_AUTH_TOKEN>
```

For Claude Desktop / Claude Code, add it as a remote MCP server pointing at that URL with the same
bearer token. Consult Anthropic's current docs for the exact config file syntax, since that's changed
over time — check `https://docs.claude.com` for the latest `mcpServers` remote-server format.

## Deployment: Render (recommended — free, no credit card)

This repo includes `render.yaml`, so Render's Blueprint feature deploys it without any manual dashboard
configuration.

1. Push this repo to GitHub (commands below).
2. In the Render dashboard: **New → Blueprint**, connect your GitHub account, pick the
   `chakudya-mcp-server` repo. Render reads `render.yaml` automatically.
3. Render provisions the service on the **Free** plan and auto-generates a random `MCP_AUTH_TOKEN`
   (via `generateValue: true`). After the first deploy, go to the service's **Environment** tab to copy
   that generated token — you'll need it in your MCP client config.
4. Deploy. Your MCP endpoint will be `https://<your-service-name>.onrender.com/mcp` (check the Render
   dashboard for your actual generated URL — it may include a random suffix if your chosen name is
   taken).

### The free-tier sleep problem, and the fix

Render's free web services spin down after 15 minutes with no traffic, then take 30-60 seconds to wake
on the next request. That's fine for a health check, but it can drop an in-progress MCP session (session
state lives in memory — see `src/index.ts`) if the client goes quiet mid-conversation for too long.

Fix: keep it warm with a free uptime monitor pinging `/health` every 5-10 minutes.

1. Sign up at [uptimerobot.com](https://uptimerobot.com) (free plan, no card).
2. Add a new **HTTP(s)** monitor:
   - URL: `https://<your-service>.onrender.com/health`
   - Interval: 5 minutes
3. Save. `/health` is unauthenticated by design, specifically so this monitor doesn't need your
   `MCP_AUTH_TOKEN`.

This keeps the service warm 24/7 within the free plan's 750 hrs/month (well under the cap for one
service pinged this way).

### Updating after a code change

Render auto-redeploys on every push to your connected branch — no extra step needed:

```bash
git add .
git commit -m "Update MCP server"
git push
```

Watch the deploy in the Render dashboard's **Events** tab; it typically finishes in 1-2 minutes for a
project this size.

## Other deployment options

### Docker anywhere

```bash
docker build -t chakudya-mcp-server .
docker run -d -p 8787:8787 \
  -e NODE_ENV=production \
  -e MCP_AUTH_TOKEN=<long-random-string> \
  -e CHAKUDYA_API_BASE_URL=<your-chakudya-worker-url> \
  --name chakudya-mcp chakudya-mcp-server
```

### Plain VPS with a process manager

```bash
npm install --omit=dev
npm run build
npx pm2 start dist/index.js --name chakudya-mcp
```

Put it behind Nginx/Caddy for TLS termination if you're not already fronting it with something that
handles HTTPS.

## Updating via the command line

```bash
cd ~
# first time only:
git clone https://github.com/edisontaimu9-ui/chakudya-mcp-server.git
cd chakudya-mcp-server

# after any file update:
cp <path-to-updated-file>.ts src/<path>/<updated-file>.ts
git add .
git commit -m "Update MCP server"
git push
```

Then redeploy on whichever platform you chose (Render/Railway/Fly auto-redeploy on push if you connected
the GitHub repo; otherwise trigger a manual redeploy or re-run the Docker/pm2 commands above on your
host).
