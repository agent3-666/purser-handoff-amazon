import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  fsyncSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
export const sha = (x) => createHash("sha256").update(x).digest("hex");
export class Fault extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
const copy = (x) => structuredClone(x);
const fail = (code, msg, status) => {
  throw new Fault(code, msg, status);
};
const freshSources = () => ({
  programme: {
    version: 1,
    title: "Workshop programme",
    text: "Event: Saturday Repair Workshop\nDate: 31 October 2026\nWelcome: 09:30\nWorkshop: 10:00–12:00\nWrap-up: 12:00–12:15\nOwner: Morgan, event coordinator",
  },
  venue: {
    version: 1,
    title: "Venue instructions",
    text: "Venue: Riverside Community Room\nEntrance: West door\nSetup: 09:00\nCapacity: 24\nAccessibility: Step-free entrance; keep the access aisle clear",
  },
  people: {
    version: 1,
    title: "Volunteer assignments",
    text: "Welcome desk: Riley\nSetup lead: Sam\nWorkshop lead: Casey\nClose-down: Sam and Riley\nContact: Morgan at the welcome desk",
  },
});
const fields = {
  programme: ["Event", "Date", "Welcome", "Workshop", "Wrap-up", "Owner"],
  venue: ["Venue", "Entrance", "Setup", "Capacity", "Accessibility"],
  people: [
    "Welcome desk",
    "Setup lead",
    "Workshop lead",
    "Close-down",
    "Contact",
  ],
};
export const sourceIds = Object.keys(fields);
function extract(text, source) {
  const out = {},
    duplicates = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (m) {
      const key = m[1].trim();
      if (Object.hasOwn(out, key)) duplicates.push(key);
      out[key] = m[2].trim();
    }
  }
  const missing = [
    ...fields[source].filter((k) => !out[k]),
    ...duplicates.map((k) => "Conflicting duplicate: " + k),
  ];
  return {
    facts: Object.fromEntries(
      fields[source].map((k) => [k, out[k] || "NEEDS OWNER INPUT"]),
    ),
    missing,
  };
}
export class Store {
  constructor(dir, { clock = () => Date.now(), leaseMs = 90000 } = {}) {
    this.dir = dir;
    this.clock = clock;
    this.leaseMs = leaseMs;
    this.closed = false;
    this.lockToken = randomUUID();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, "state.json");
    this.lock = join(dir, "writer.lock");
    this.acquire();
    try {
      this.state = existsSync(this.file)
        ? JSON.parse(readFileSync(this.file, "utf8"))
        : { schema: 1, sources: freshSources(), tasks: [] };
      this.validate(this.state);
    } catch (e) {
      this.close();
      throw e;
    }
  }
  acquire() {
    const writeLock = () => {
      const fd = openSync(this.lock, "wx", 0o600);
      try {
        writeFileSync(
          fd,
          JSON.stringify({ pid: process.pid, token: this.lockToken }),
        );
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    };
    try {
      writeLock();
      return;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    const recovery = this.lock + ".recovery";
    let fd;
    try {
      fd = openSync(recovery, "wx", 0o600);
      const old = JSON.parse(readFileSync(this.lock, "utf8"));
      if (!Number.isSafeInteger(old.pid) || old.pid <= 0 || !old.token)
        throw Error("Invalid writer lock; manual review required");
      try {
        process.kill(old.pid, 0);
        throw Error("Another writer is active");
      } catch (e) {
        if (e.code !== "ESRCH") throw e;
      }
      unlinkSync(this.lock);
      writeLock();
    } finally {
      if (fd !== undefined) {
        closeSync(fd);
        unlinkSync(recovery);
      }
    }
  }
  validate(s) {
    if (
      s.schema !== 1 ||
      !Array.isArray(s.tasks) ||
      !s.sources ||
      sourceIds.some(
        (k) =>
          !s.sources[k] ||
          !Number.isSafeInteger(s.sources[k].version) ||
          typeof s.sources[k].text !== "string",
      )
    )
      throw Error("Invalid persistent store; refusing to reset");
    for (const t of s.tasks)
      if (
        typeof t.id !== "string" ||
        !Number.isSafeInteger(t.revision) ||
        !t.steps ||
        !Array.isArray(t.events) ||
        !t.requests ||
        !["active", "revoked", "completed"].includes(t.status)
      )
        throw Error("Invalid task; refusing to reset");
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (
      existsSync(this.lock) &&
      JSON.parse(readFileSync(this.lock, "utf8")).token === this.lockToken
    )
      unlinkSync(this.lock);
  }
  save(next) {
    if (this.closed) throw Error("Store closed");
    this.validate(next);
    const tmp = this.file + ".tmp";
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(next, null, 2));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.file);
    const d = openSync(this.dir, "r");
    try {
      fsyncSync(d);
    } finally {
      closeSync(d);
    }
    this.state = next;
  }
  event(t, kind, message, extra = {}) {
    t.events.push({
      sequence: t.events.length + 1,
      at: new Date(this.clock()).toISOString(),
      kind,
      message,
      ...extra,
    });
  }
  view(t) {
    const v = copy(t);
    delete v.requests;
    delete v.leaseHash;
    v.activeRunner = t.runner || null;
    v.canResume = t.status === "active";
    v.leaseActive = !!t.leaseHash && t.leaseUntil > this.clock();
    return v;
  }
  read() {
    return {
      sources: copy(this.state.sources),
      tasks: this.state.tasks.map((t) => this.view(t)),
      serverTime: new Date(this.clock()).toISOString(),
    };
  }
  task(id, s = this.state) {
    const t = s.tasks.find((t) => t.id === id);
    if (!t) fail("NOT_FOUND", "Task not found", 404);
    return t;
  }
  reject(id, e) {
    const next = copy(this.state);
    const t = this.task(id, next);
    this.event(t, "blocked", e.message, { code: e.code });
    this.save(next);
  }
  // Synchronous transaction: no await between read, revision check and durable commit.
  change(id, operation, input, fn) {
    const next = copy(this.state);
    const t = this.task(id, next);
    const key = input.requestId;
    if (typeof key !== "string" || key.length < 8 || key.length > 100)
      fail("REQUEST_ID", "Use a fresh request ID (8–100 characters)", 400);
    const fingerprint = sha(JSON.stringify({ operation, input }));
    const prior = Object.hasOwn(t.requests, key) ? t.requests[key] : null;
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        fail("KEY_REUSE", "This request ID was used with different arguments");
      return {
        replayed: true,
        originalResult: copy(prior.result),
        task: this.view(t),
      };
    }
    try {
      if (t.revision !== input.revision)
        fail(
          "STALE_REVISION",
          "This view is out of date. Refresh before continuing.",
        );
      const result = fn(t, next) || {};
      t.revision++;
      const response = { ...result, task: this.view(t) };
      t.requests = { ...t.requests, [key]: { fingerprint, result: response } };
      this.save(next);
      return response;
    } catch (e) {
      if (e instanceof Fault) this.reject(id, e);
      throw e;
    }
  }
  create({ requestId } = {}) {
    if (
      typeof requestId !== "string" ||
      requestId.length < 8 ||
      requestId.length > 100
    )
      fail("REQUEST_ID", "Use a fresh request ID (8–100 characters)", 400);
    const next = copy(this.state);
    next.creationRequests ||= {};
    if (Object.hasOwn(next.creationRequests, requestId))
      return {
        task: this.view(this.task(next.creationRequests[requestId])),
        replayed: true,
      };
    if (next.tasks.length >= 100)
      fail("LIMIT", "Local demo allows 100 tasks", 400);
    const t = {
      id: randomUUID(),
      title: "Saturday workshop volunteer briefing",
      revision: 1,
      status: "active",
      steps: Object.fromEntries(sourceIds.map((k) => [k, null])),
      draft: null,
      receipt: null,
      runner: null,
      leaseHash: null,
      leaseUntil: 0,
      events: [],
      requests: {},
    };
    this.event(
      t,
      "created",
      "Briefing requested. Three source documents are ready.",
    );
    next.tasks.push(t);
    next.creationRequests = { ...next.creationRequests, [requestId]: t.id };
    this.save(next);
    return { task: this.view(t) };
  }
  assertActive(t) {
    if (t.status !== "active")
      fail(
        "TASK_CLOSED",
        t.status === "revoked"
          ? "The owner withdrew this task."
          : "The owner already confirmed this briefing.",
      );
  }
  claim(input) {
    return this.change(input.taskId, "claim", input, (t) => {
      this.assertActive(t);
      if (
        typeof input.runner !== "string" ||
        !input.runner.trim() ||
        input.runner.length > 60
      )
        fail("RUNNER", "Choose a runner name", 400);
      const old = t.runner;
      const token = randomUUID();
      t.leaseHash = sha(token);
      t.leaseUntil = this.clock() + this.leaseMs;
      t.runner = input.runner.trim();
      this.event(
        t,
        "handoff",
        old
          ? `${t.runner} took over. ${old} can no longer change this task.`
          : `${t.runner} is preparing the briefing.`,
        { preserved: sourceIds.filter((k) => t.steps[k]) },
      );
      return { leaseToken: token };
    });
  }
  verifyLease(t, input) {
    this.assertActive(t);
    if (
      !input.leaseToken ||
      !t.leaseHash ||
      sha(input.leaseToken) !== t.leaseHash
    )
      fail(
        "OLD_RUNNER",
        "That assistant no longer has permission. Progress was kept safe.",
      );
    if (t.leaseUntil <= this.clock())
      fail(
        "LEASE_EXPIRED",
        "The assistant paused for too long. Take over to continue.",
      );
  }
  step(input) {
    return this.change(input.taskId, "step", input, (t, s) => {
      this.verifyLease(t, input);
      const id = sourceIds.find(
        (k) => !t.steps[k] || t.steps[k].version !== s.sources[k].version,
      );
      if (!id)
        fail(
          "SOURCES_DONE",
          "All source checks are complete. Prepare the briefing.",
        );
      const source = s.sources[id];
      const result = extract(source.text, id);
      t.steps[id] = {
        version: source.version,
        hash: sha(source.text),
        ...result,
        completedAt: new Date(this.clock()).toISOString(),
      };
      t.draft = null;
      t.leaseUntil = this.clock() + this.leaseMs;
      this.event(
        t,
        "source",
        `${source.title} checked${result.missing.length ? ". Missing: " + result.missing.join(", ") : ". Facts and source reference saved."}`,
        { source: id, version: source.version },
      );
      return { checked: id };
    });
  }
  draft(input) {
    return this.change(input.taskId, "draft", input, (t, s) => {
      this.verifyLease(t, input);
      if (
        sourceIds.some(
          (k) => !t.steps[k] || t.steps[k].version !== s.sources[k].version,
        )
      )
        fail("INCOMPLETE", "Check all three current source documents first.");
      const missing = sourceIds.flatMap((k) =>
        t.steps[k].missing.map((f) => `${s.sources[k].title}: ${f}`),
      );
      if (missing.length)
        fail("MISSING_INFO", "Owner input needed: " + missing.join("; "));
      const p = t.steps.programme.facts;
      const quote = (key, source) =>
        `${t.steps[source].facts[key]} [${source} v${t.steps[source].version}]`;
      const text = `# ${p.Event}\n## Volunteer briefing\n\n${quote("Date", "programme")} · ${quote("Venue", "venue")}\n\n## Arrive ready\n- Enter through: **${quote("Entrance", "venue")}**\n- Setup begins: ${quote("Setup", "venue")}\n- Room capacity: ${quote("Capacity", "venue")}\n- Access: ${quote("Accessibility", "venue")}\n\n## Run of show\n- Welcome: ${quote("Welcome", "programme")}\n- Workshop: ${quote("Workshop", "programme")}\n- Wrap-up: ${quote("Wrap-up", "programme")}\n\n## Who does what\n- Welcome desk: ${quote("Welcome desk", "people")}\n- Setup lead: ${quote("Setup lead", "people")}\n- Workshop lead: ${quote("Workshop lead", "people")}\n- Close-down: ${quote("Close-down", "people")}\n- Questions: ${quote("Contact", "people")}\n\n## Before you share\n- [ ] Owner has checked the entrance, timings and assignments.\n- [ ] Send only the owner-confirmed version. This app does not send messages.\n\n## Sources\n${sourceIds.map((k) => `- [${k} v${s.sources[k].version}] ${s.sources[k].title}; SHA-256 ${sha(s.sources[k].text)}`).join("\n")}\n\nSynthetic workshop example. Prepared locally; no booking, payment or message was sent.\n`;
      t.draft = {
        text,
        digest: sha(text),
        sourceVersions: Object.fromEntries(
          sourceIds.map((k) => [k, s.sources[k].version]),
        ),
        createdAt: new Date(this.clock()).toISOString(),
      };
      t.leaseUntil = this.clock() + this.leaseMs;
      this.event(
        t,
        "draft",
        "Briefing is ready for your review. Nothing has been sent.",
      );
      return {};
    });
  }
  confirm(input) {
    return this.change(input.taskId, "confirm", input, (t, s) => {
      this.assertActive(t);
      if (
        !t.draft ||
        input.digest !== t.draft.digest ||
        sha(t.draft.text) !== input.digest
      )
        fail(
          "DRAFT_CHANGED",
          "The briefing changed. Review the current version first.",
        );
      if (
        sourceIds.some(
          (k) => t.draft.sourceVersions[k] !== s.sources[k].version,
        )
      )
        fail(
          "SOURCE_CHANGED",
          "A source changed. Update the briefing before confirming.",
        );
      t.status = "completed";
      t.leaseHash = null;
      t.runner = null;
      t.leaseUntil = 0;
      t.receipt = {
        id: randomUUID(),
        digest: t.draft.digest,
        at: new Date(this.clock()).toISOString(),
      };
      this.event(
        t,
        "confirmed",
        "You confirmed this exact briefing. Ready to download and share yourself.",
        { receipt: copy(t.receipt) },
      );
      return { receipt: t.receipt };
    });
  }
  revoke(input) {
    return this.change(input.taskId, "revoke", input, (t) => {
      this.assertActive(t);
      t.status = "revoked";
      t.leaseHash = null;
      t.runner = null;
      t.leaseUntil = 0;
      this.event(
        t,
        "revoked",
        "You withdrew permission. The saved work remains available for inspection.",
      );
      return {};
    });
  }
  updateSource({ source, text, version }) {
    if (
      !sourceIds.includes(source) ||
      typeof text !== "string" ||
      text.length > 10000 ||
      !text.trim()
    )
      fail(
        "SOURCE_INPUT",
        "Supply a nonempty source of at most 10,000 characters",
        400,
      );
    const next = copy(this.state);
    if (next.sources[source].version !== version)
      fail("STALE_SOURCE", "Source changed. Refresh before editing.");
    if (next.sources[source].text === text) return this.read();
    next.sources[source].text = text;
    next.sources[source].version++;
    for (const t of next.tasks) {
      if (t.status === "revoked") continue;
      const had = !!t.steps[source];
      t.steps[source] = null;
      t.draft = null;
      t.receipt = null;
      t.status = "active";
      t.leaseHash = null;
      t.runner = null;
      t.leaseUntil = 0;
      t.revision++;
      this.event(
        t,
        "source_changed",
        `${next.sources[source].title} updated. ${had ? "Recheck this source; other finished source checks were kept." : "This source needs checking."} Any previous briefing and confirmation are now out of date.`,
        { source, version: next.sources[source].version },
      );
    }
    this.save(next);
    return this.read();
  }
}
