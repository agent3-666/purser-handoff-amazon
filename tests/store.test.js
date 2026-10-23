import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store, sha } from "../src/store.js";
function fixture(t, opts) {
  const dir = mkdtempSync(join(tmpdir(), "agent3-handoff-"));
  const s = new Store(dir, opts);
  t.after(() => {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { s, dir };
}
const uid = () => randomUUID();
const args = (t) => ({ taskId: t.id, revision: t.revision, requestId: uid() });
function ready(s) {
  let t = s.create({ requestId: uid() }).task;
  let r = s.claim({ ...args(t), runner: "Phone" });
  let token = r.leaseToken;
  t = r.task;
  for (let i = 0; i < 3; i++)
    t = s.step({ ...args(t), leaseToken: token }).task;
  t = s.draft({ ...args(t), leaseToken: token }).task;
  return { t, token };
}
test("actual briefing has source facts, citations and exact hash; completion is durable", (t) => {
  const { s, dir } = fixture(t);
  let { t: task } = ready(s);
  assert.match(task.draft.text, /West door \[venue v1\]/);
  assert.match(task.draft.text, /Riley \[people v1\]/);
  assert.equal(sha(task.draft.text), task.draft.digest);
  const r = s.confirm({ ...args(task), digest: task.draft.digest });
  assert.equal(r.task.status, "completed");
  assert.equal(
    JSON.parse(readFileSync(join(dir, "state.json"))).tasks[0].receipt.digest,
    task.draft.digest,
  );
});
test("idempotent create returns one task", (t) => {
  const { s } = fixture(t);
  const requestId = uid();
  const a = s.create({ requestId });
  const b = s.create({ requestId });
  assert.equal(a.task.id, b.task.id);
  assert.equal(s.read().tasks.length, 1);
});
test("handoff preserves genuine checked output; old token fails even at latest revision", (t) => {
  const { s } = fixture(t);
  let task = s.create({ requestId: uid() }).task;
  const a = s.claim({ ...args(task), runner: "Phone" });
  task = s.step({ ...args(a.task), leaseToken: a.leaseToken }).task;
  const before = structuredClone(task.steps.programme);
  const b = s.claim({ ...args(task), runner: "Desktop" });
  assert.deepEqual(b.task.steps.programme, before);
  assert.throws(
    () => s.step({ ...args(b.task), leaseToken: a.leaseToken }),
    (e) => e.code === "OLD_RUNNER",
  );
  const next = s.step({ ...args(b.task), leaseToken: b.leaseToken });
  assert.equal(next.checked, "venue");
  assert.deepEqual(next.task.steps.programme, before);
  assert.equal(
    next.task.events.filter(
      (e) => e.kind === "source" && e.source === "programme",
    ).length,
    1,
  );
});
test("same revision concurrent takeovers allow one winner", (t) => {
  const { s } = fixture(t);
  const task = s.create({ requestId: uid() }).task;
  s.claim({ ...args(task), runner: "A" });
  assert.throws(
    () => s.claim({ ...args(task), runner: "B" }),
    (e) => e.code === "STALE_REVISION",
  );
  assert.equal(s.read().tasks[0].activeRunner, "A");
});
test("withdrawal blocks subsequent runner at current revision", (t) => {
  const { s } = fixture(t);
  const { t: task, token } = ready(s);
  const r = s.revoke(args(task));
  assert.throws(
    () => s.step({ ...args(r.task), leaseToken: token }),
    (e) => e.code === "TASK_CLOSED",
  );
  assert.equal(s.read().tasks[0].status, "revoked");
});
test("expired runner cannot write; new takeover resumes", (t) => {
  let now = 1000;
  const { s } = fixture(t, { clock: () => now, leaseMs: 20 });
  let task = s.create({ requestId: uid() }).task;
  const a = s.claim({ ...args(task), runner: "Phone" });
  now = 1021;
  assert.throws(
    () => s.step({ ...args(a.task), leaseToken: a.leaseToken }),
    (e) => e.code === "LEASE_EXPIRED",
  );
  const b = s.claim({ ...args(a.task), runner: "Desktop" });
  assert.equal(
    s.step({ ...args(b.task), leaseToken: b.leaseToken }).checked,
    "programme",
  );
});
test("missing source facts block draft; duplicate facts also block", (t) => {
  const { s } = fixture(t);
  let source = s.read().sources.venue;
  s.updateSource({
    source: "venue",
    version: source.version,
    text: source.text.replace("Entrance: West door", ""),
  });
  assert.throws(
    () => ready(s),
    (e) => e.code === "MISSING_INFO",
  );
  source = s.read().sources.venue;
  s.updateSource({
    source: "venue",
    version: source.version,
    text: source.text + "\nEntrance: East\nEntrance: West",
  });
  assert.throws(
    () => ready(s),
    (e) => e.code === "MISSING_INFO",
  );
});
test("incomplete checks and wrong digest cannot confirm", (t) => {
  const { s } = fixture(t);
  const task = s.create({ requestId: uid() }).task;
  const a = s.claim({ ...args(task), runner: "Phone" });
  assert.throws(
    () => s.draft({ ...args(a.task), leaseToken: a.leaseToken }),
    (e) => e.code === "INCOMPLETE",
  );
  const r = ready(s);
  assert.throws(
    () => s.confirm({ ...args(r.t), digest: "0".repeat(64) }),
    (e) => e.code === "DRAFT_CHANGED",
  );
  assert.equal(s.task(r.t.id).status, "active");
});
test("source change invalidates exact old draft and only affected source check", (t) => {
  const { s } = fixture(t);
  const { t: task, token } = ready(s);
  const before = structuredClone(task.steps.programme);
  const source = s.read().sources.venue;
  s.updateSource({
    source: "venue",
    version: source.version,
    text: source.text.replace("West door", "East door"),
  });
  const current = s.view(s.task(task.id));
  assert.equal(current.draft, null);
  assert.equal(current.steps.venue, null);
  assert.deepEqual(current.steps.programme, before);
  assert.ok(current.steps.people);
  assert.throws(
    () => s.confirm({ ...args(current), digest: task.draft.digest }),
    (e) => e.code === "DRAFT_CHANGED",
  );
  assert.throws(
    () => s.step({ ...args(current), leaseToken: token }),
    (e) => e.code === "OLD_RUNNER",
  );
  const b = s.claim({ ...args(current), runner: "Desktop" });
  const c = s.step({ ...args(b.task), leaseToken: b.leaseToken });
  assert.equal(c.checked, "venue");
  const d = s.draft({ ...args(c.task), leaseToken: b.leaseToken });
  assert.match(d.task.draft.text, /East door \[venue v2\]/);
  assert.notEqual(d.task.draft.digest, task.draft.digest);
});
test("old confirmation replay returns current task, historical receipt is explicit only", (t) => {
  const { s } = fixture(t);
  const { t: task } = ready(s);
  const input = { ...args(task), digest: task.draft.digest };
  const first = s.confirm(input);
  assert.equal(s.confirm(input).replayed, true);
  const source = s.read().sources.venue;
  s.updateSource({
    source: "venue",
    version: source.version,
    text: source.text.replace("West", "East"),
  });
  const replay = s.confirm(input);
  assert.equal(replay.task.status, "active");
  assert.equal(replay.task.receipt, null);
  assert.equal(replay.task.draft, null);
  assert.equal(replay.originalResult.receipt.id, first.receipt.id);
  assert.equal(
    replay.task.events.filter((e) => e.kind === "confirmed").length,
    1,
  );
  assert.equal(
    replay.task.events.find((e) => e.kind === "confirmed").receipt.id,
    first.receipt.id,
  );
});
test("reuse of idempotency key with changed payload is rejected", (t) => {
  const { s } = fixture(t);
  const task = s.create({ requestId: uid() }).task;
  const input = { ...args(task), runner: "A" };
  s.claim(input);
  assert.throws(
    () => s.claim({ ...input, runner: "B" }),
    (e) => e.code === "KEY_REUSE",
  );
});
test("restart reads actual source checks from disk; second live writer refused", (t) => {
  const { s, dir } = fixture(t);
  let task = s.create({ requestId: uid() }).task;
  const r = s.claim({ ...args(task), runner: "Phone" });
  task = s.step({ ...args(r.task), leaseToken: r.leaseToken }).task;
  assert.throws(() => new Store(dir), /writer is active/);
  s.close();
  const b = new Store(dir);
  assert.deepEqual(b.read().tasks[0].steps.programme, task.steps.programme);
  b.close();
});
test("corrupt persistent store refuses startup rather than inventing clean success", (t) => {
  const { s, dir } = fixture(t);
  s.close();
  writeFileSync(join(dir, "state.json"), "{broken");
  assert.throws(() => new Store(dir));
});
test("public views contain no runner secret or request replay capability", (t) => {
  const { s } = fixture(t);
  const r = ready(s);
  const str = JSON.stringify(s.read());
  assert.ok(!str.includes(r.token));
  assert.ok(!str.includes("leaseHash"));
  assert.ok(!str.includes("requests"));
});

test("idempotency treats inherited object property names as literal keys", (t) => {
  const { s } = fixture(t);
  const a = s.create({ requestId: "__proto__" });
  assert.equal(s.create({ requestId: "__proto__" }).task.id, a.task.id);
  const input = { ...args(a.task), requestId: "constructor", runner: "Phone" };
  const r = s.claim(input);
  assert.equal(r.task.activeRunner, "Phone");
  assert.equal(s.claim(input).replayed, true);
});
