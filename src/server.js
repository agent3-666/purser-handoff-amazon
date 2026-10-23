import express from "express";
import { randomUUID } from "node:crypto";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { Store, Fault } from "./store.js";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT || 5387);
const host = "127.0.0.1";
const origin = `http://${host}:${port}`;
const runtime = resolve(process.env.DATA_DIR || join(root, ".runtime"));
const store = new Store(runtime);
const capability = randomUUID();
writeFileSync(
  join(runtime, "client-access.json"),
  JSON.stringify({ url: origin + "/mcp", bearer: capability }),
  { mode: 0o600 },
);
const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host))
    return res
      .status(403)
      .json({ error: "HOST", message: "Loopback host required" });
  const o = req.headers.origin;
  if (o && ![origin, `http://localhost:${port}`].includes(o))
    return res
      .status(403)
      .json({ error: "ORIGIN", message: "Same-origin requests only" });
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Cache-Control", "no-store");
  res.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  next();
});
app.use(express.json({ limit: "32kb" }));
app.get("/healthz", (_q, res) =>
  res.json({
    ok: true,
    project: "Agent3 Purser Handoff",
    transport: "Streamable HTTP",
    protocol: "2025-11-25",
    mode: "single-user loopback",
  }),
);
app.get("/api/session", (req, res) => {
  if (req.headers["sec-fetch-site"] !== "same-origin")
    return res
      .status(403)
      .json({ error: "PAIRING", message: "Open the local app to pair" });
  res.cookie("handoff_" + port, capability, {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
  });
  res.json({ ok: true });
});
const authorized = (req) =>
  req.headers.authorization === `Bearer ${capability}` ||
  (req.headers.cookie || "")
    .split(";")
    .map((x) => x.trim())
    .includes(`handoff_${port}=${capability}`);
app.use("/api", (req, res, next) =>
  authorized(req)
    ? next()
    : res
        .status(401)
        .json({ error: "UNPAIRED", message: "Reload the local app to pair" }),
);
app.get("/api/state", (_q, res) => res.json(store.read()));
app.post("/api/task", (req, res) => res.json(store.create(req.body)));
const actions = {
  claim: (x) => store.claim(x),
  step: (x) => store.step(x),
  draft: (x) => store.draft(x),
  confirm: (x) => store.confirm(x),
  revoke: (x) => store.revoke(x),
};
for (const [name, fn] of Object.entries(actions))
  app.post("/api/" + name, (req, res) => res.json(fn(req.body)));
app.post("/api/source", (req, res) => res.json(store.updateSource(req.body)));
app.get("/api/brief/:id", (req, res) => {
  const t = store.task(req.params.id);
  if (t.status !== "completed" || !t.draft || !t.receipt)
    throw new Fault(
      "NOT_CONFIRMED",
      "Confirm the current briefing before downloading",
      409,
    );
  res
    .type("text/markdown")
    .attachment("volunteer-briefing.md")
    .send(t.draft.text);
});
function buildMcp() {
  const m = new McpServer({ name: "agent3-purser-handoff", version: "1.0.0" });
  const out = (x) => ({ content: [{ type: "text", text: JSON.stringify(x) }] });
  const handle = (fn) => async (x) => {
    try {
      return out(fn(x));
    } catch (e) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: e.code || "INTERNAL",
              message: e.message,
            }),
          },
        ],
      };
    }
  };
  const common = {
    taskId: z.string().uuid(),
    revision: z.number().int().positive(),
    requestId: z.string().min(8).max(100),
  };
  const lease = { ...common, leaseToken: z.string().uuid() };
  m.registerTool(
    "read_workshop",
    {
      description:
        "Read saved tasks, source versions, actual checked facts, missing fields and event history. No lease secrets returned.",
      annotations: { readOnlyHint: true },
      inputSchema: {},
    },
    handle(() => store.read()),
  );
  m.registerTool(
    "start_briefing",
    {
      description:
        "Create a workshop volunteer briefing task from three local synthetic source documents. No external messages sent.",
      inputSchema: { requestId: z.string().min(8).max(100) },
    },
    handle((x) => store.create(x)),
  );
  m.registerTool(
    "take_over",
    {
      description:
        "Take ownership of an active briefing; invalidates prior runner immediately. Preserves finished checks. Owner-authorized action only.",
      inputSchema: { ...common, runner: z.string().min(1).max(60) },
    },
    handle((x) => store.claim(x)),
  );
  m.registerTool(
    "check_next_source",
    {
      description:
        "Check next unfinished or updated source. Saves facts and original source hash/version. Requires current revision and runner lease.",
      inputSchema: lease,
    },
    handle((x) => store.step(x)),
  );
  m.registerTool(
    "prepare_briefing",
    {
      description:
        "Generate a Markdown briefing with per-fact citations. Blocks if current source checks or required facts are missing.",
      inputSchema: lease,
    },
    handle((x) => store.draft(x)),
  );
  m.registerTool(
    "confirm_briefing",
    {
      description:
        "Owner approval of an exact reviewed SHA-256 digest. Call only after human review and explicit approval of current draft. Never infer consent.",
      inputSchema: { ...common, digest: z.string().regex(/^[0-9a-f]{64}$/) },
    },
    handle((x) => store.confirm(x)),
  );
  m.registerTool(
    "withdraw_permission",
    {
      description:
        "Owner-authorized withdrawal. Immediately rejects further runner actions; retains history.",
      inputSchema: common,
    },
    handle((x) => store.revoke(x)),
  );
  return m;
}
app.post("/mcp", async (req, res, next) => {
  if (!authorized(req))
    return res.status(401).json({
      error:
        "Bearer required. Local pairing details are in .runtime/client-access.json",
    });
  const m = buildMcp();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    transport.close();
    m.close();
  });
  try {
    await m.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    next(e);
  }
});
app.all("/mcp", (req, res) => {
  if (!authorized(req)) return res.status(401).end();
  res.status(405).set("Allow", "POST").end();
});
app.use(express.static(join(root, "web")));
app.use((e, _q, res, _n) =>
  res.status(e.status || 500).json({
    error: e.code || "INTERNAL",
    message: e.status
      ? e.message
      : "The local operation failed. See server log.",
  }),
);
const server = app.listen(port, host, () =>
  console.log(
    `Agent3 Purser Handoff: ${origin}\nLocal simulation. No real Alexa connection. Data: ${runtime}\nMCP: ${origin}/mcp (local bearer in client-access.json)`,
  ),
);
server.on("error", (e) => {
  store.close();
  console.error(e.message);
  process.exit(1);
});
function stop() {
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => {
    store.close();
    process.exit(0);
  }, 2000).unref();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
