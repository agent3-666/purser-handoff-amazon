import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import assert from "node:assert/strict";
const dir = mkdtempSync(join(tmpdir(), "agent3-mcp-"));
const checks = [];
let child, client;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
async function boot() {
  child = spawn(process.execPath, ["src/server.js"], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (b) => (err += b));
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(origin + "/healthz");
      if (r.ok) return;
    } catch {}
    if (child.exitCode !== null) throw Error(err || "Server exited");
    await delay(50);
  }
  throw Error("Startup timed out");
}
function access() {
  return JSON.parse(readFileSync(join(dir, "client-access.json"), "utf8"));
}
async function http(path, body, extra = {}) {
  const r = await fetch(origin + path, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: "Bearer " + access().bearer,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...extra,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    value = text;
  }
  return { status: r.status, value };
}
const base = (t) => ({
  taskId: t.id,
  revision: t.revision,
  requestId: randomUUID(),
});
async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const v = JSON.parse(r.content[0].text);
  if (r.isError) {
    const e = Error(v.message);
    e.code = v.error;
    throw e;
  }
  return v;
}
try {
  await boot();
  const auth = access();
  const raw = await http(
    "/mcp",
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "independent-wire-probe", version: "1" },
      },
    },
    { Accept: "application/json, text/event-stream" },
  );
  assert.equal(raw.status, 200);
  assert.equal(raw.value.result.protocolVersion, "2025-11-25");
  checks.push("Real HTTP initialize negotiates MCP 2025-11-25");
  const createId = randomUUID();
  const httpCreated = await http("/api/task", { requestId: createId });
  assert.equal(httpCreated.status, 200);
  const httpReplayed = await http("/api/task", { requestId: createId });
  assert.equal(httpReplayed.value.task.id, httpCreated.value.task.id);
  checks.push(
    "Actual UI HTTP create route works and request replay creates no duplicate",
  );
  client = new Client({
    name: "independent-official-sdk-client",
    version: "1.0.0",
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(auth.url), {
      requestInit: { headers: { Authorization: "Bearer " + auth.bearer } },
    }),
  );
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 7);
  checks.push(
    "Official SDK Client over Streamable HTTP discovers exactly 7 tools",
  );
  let t = (await call("start_briefing", { requestId: randomUUID() })).task;
  let a = await call("take_over", { ...base(t), runner: "Phone assistant" });
  t = (
    await call("check_next_source", {
      ...base(a.task),
      leaseToken: a.leaseToken,
    })
  ).task;
  const saved = structuredClone(t.steps.programme);
  const b = await call("take_over", {
    ...base(t),
    runner: "Desktop assistant",
  });
  t = b.task;
  await assert.rejects(
    call("check_next_source", { ...base(t), leaseToken: a.leaseToken }),
    (e) => e.code === "OLD_RUNNER",
  );
  checks.push("Old runner rejected by server even when given latest revision");
  for (let i = 0; i < 2; i++)
    t = (
      await call("check_next_source", { ...base(t), leaseToken: b.leaseToken })
    ).task;
  assert.deepEqual(t.steps.programme, saved);
  assert.equal(
    t.events.filter((e) => e.kind === "source" && e.source === "programme")
      .length,
    1,
  );
  checks.push("Actual source checkpoint reused, no repeated programme check");
  t = (await call("prepare_briefing", { ...base(t), leaseToken: b.leaseToken }))
    .task;
  assert.match(t.draft.text, /West door/);
  const confirmation = { ...base(t), digest: t.draft.digest };
  t = (await call("confirm_briefing", confirmation)).task;
  assert.equal(t.status, "completed");
  const download = await http("/api/brief/" + t.id);
  assert.equal(download.status, 200);
  assert.match(download.value, /Riley/);
  checks.push(
    "MCP workflow creates real cited Markdown; explicit test-owner confirmation unlocks HTTP download",
  );
  const source = (await call("read_workshop")).sources.venue;
  await http("/api/source", {
    source: "venue",
    text: source.text.replace("West door", "East door"),
    version: source.version,
  });
  const replay = await call("confirm_briefing", confirmation);
  assert.equal(replay.replayed, true);
  assert.equal(replay.task.status, "active");
  assert.equal(replay.task.draft, null);
  assert.equal((await http("/api/brief/" + t.id)).status, 409);
  checks.push(
    "Source update invalidates completed draft and download; old confirmation replay reports current active state",
  );
  let current = replay.task;
  const competing = await Promise.all([
    http("/api/claim", { ...base(current), runner: "One" }),
    http("/api/claim", { ...base(current), runner: "Two" }),
  ]);
  assert.deepEqual(competing.map((x) => x.status).sort(), [200, 409]);
  checks.push("Parallel real HTTP takeovers: one winner, one 409");
  assert.equal(
    (await http("/api/state", null, { Origin: "https://untrusted.invalid" }))
      .status,
    403,
  );
  assert.equal((await fetch(origin + "/api/state")).status, 401);
  assert.equal((await fetch(origin + "/api/session")).status, 403);
  assert.equal(
    (
      await fetch(origin + "/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
    401,
  );
  const badHost = await new Promise((resolve, reject) => {
    import("node:http").then(({ request }) => {
      const q = request(
        origin + "/api/state",
        { headers: { Host: "evil.invalid" } },
        (r) => {
          r.resume();
          resolve(r.statusCode);
        },
      );
      q.on("error", reject);
      q.end();
    });
  });
  assert.equal(badHost, 403);
  checks.push(
    "Missing capability, cross-origin, invalid Host and non-browser pairing are rejected",
  );
  await client.close();
  client = null;
  child.kill("SIGKILL");
  await new Promise((r) => child.once("exit", r));
  await boot();
  current = (await http("/api/state")).value.tasks.find((x) => x.id === t.id);
  assert.deepEqual(current.steps.programme, saved);
  assert.ok(current.steps.people);
  assert.equal(current.steps.venue, null);
  assert.equal(current.status, "active");
  checks.push(
    "SIGKILL then real process restart recovers correct incremental state from disk and reclaims dead writer lock",
  );
  const result = {
    at: new Date().toISOString(),
    protocol: "2025-11-25",
    officialSdk: "1.32.1",
    passed: checks.length,
    checks,
  };
  console.log(JSON.stringify(result, null, 2));
  if (process.env.REPORT)
    writeFileSync(resolve(process.env.REPORT), JSON.stringify(result, null, 2));
} finally {
  if (client) await client.close().catch(() => {});
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
  }
  rmSync(dir, { recursive: true, force: true });
}
