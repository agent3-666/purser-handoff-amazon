const $ = (id) => document.getElementById(id);
let data,
  task,
  runner = JSON.parse(sessionStorage.getItem("runner") || "null"),
  oldRunner = JSON.parse(sessionStorage.getItem("oldRunner") || "null"),
  busy = false,
  autoRunning = false,
  pauseRequested = false;
const id = () => crypto.randomUUID();
const esc = (x) =>
  String(x).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
function notice(text, error = false) {
  $("notice").hidden = false;
  $("notice").className = error ? "error" : "";
  $("notice").textContent = text;
}
async function api(path, body) {
  const r = await fetch("/api/" + path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const j = await r.json();
  if (!r.ok) {
    const e = Error(j.message);
    e.code = j.error;
    throw e;
  }
  return j;
}
async function refresh() {
  data = await api("state");
  const selected = sessionStorage.getItem("task");
  task = data.tasks.find((t) => t.id === selected) || data.tasks.at(-1);
  render();
}
function saveRunner() {
  sessionStorage.setItem("runner", JSON.stringify(runner));
  sessionStorage.setItem("oldRunner", JSON.stringify(oldRunner));
}
async function action(fn) {
  if (busy) return;
  busy = true;
  document.querySelectorAll("button").forEach((b) => (b.disabled = true));
  try {
    await fn();
  } catch (e) {
    notice(e.message, true);
  } finally {
    busy = false;
    await refresh();
  }
}
const base = () => ({
  taskId: task.id,
  revision: task.revision,
  requestId: id(),
});
async function claim(name) {
  if (runner) oldRunner = { ...runner, revision: task.revision };
  const r = await api("claim", { ...base(), runner: name });
  runner = { taskId: task.id, leaseToken: r.leaseToken, name };
  task = r.task;
  saveRunner();
}
const completeCount = () => Object.values(task.steps).filter(Boolean).length;
function buttons(items) {
  $("actions").replaceChildren();
  for (const [label, style, fn] of items) {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = style;
    b.onclick = () => action(fn);
    $("actions").append(b);
  }
}
function render() {
  $("connection").textContent = "Saved on this computer";
  if ($("start")) $("start").hidden = !!task;
  if (!task) {
    $("progress").replaceChildren();
    renderSources();
    return;
  }
  const n = completeCount(),
    missing = Object.values(task.steps).flatMap((s) => s?.missing || []);
  const lastChange = [...task.events]
    .reverse()
    .find((e) => e.kind === "source_changed");
  $("task-status").textContent =
    task.status === "completed"
      ? "Confirmed"
      : task.status === "revoked"
        ? "Permission withdrawn"
        : `${n} of 3 checks saved`;
  $("task-status").className =
    "pill" + (task.status === "revoked" ? " warning" : "");
  $("assistant-title").textContent =
    task.status === "completed"
      ? "Your volunteers can get the right briefing."
      : task.status === "revoked"
        ? "Stopped, as you asked."
        : task.draft
          ? "One last check. Yours."
          : n === 0
            ? "Let’s check the facts."
            : n < 3
              ? "Your progress is right here."
              : "All three sources are checked.";
  $("assistant-copy").textContent =
    task.status === "completed"
      ? "You confirmed the current version. Download it when you’re ready; nothing was sent automatically."
      : task.status === "revoked"
        ? "No assistant can continue this task. Its saved work and history are still here."
        : missing.length
          ? "Some required information is missing. Edit the source below before preparing a briefing."
          : task.draft
            ? "The entrance, timings and assignments are linked to their source versions. Review them before you confirm."
            : `${n} source ${n === 1 ? "check is" : "checks are"} saved. ${3 - n} ${3 - n === 1 ? "check remains" : "checks remain"}. No need to repeat finished work.`;
  $("progress").innerHTML = ["programme", "venue", "people"]
    .map((k, i) => {
      const s = task.steps[k];
      return `<div class="check ${s ? "done" : ""}"><span class="check-number">${s ? "✓" : i + 1}</span><span class="label">${esc(data.sources[k].title)}<span class="sub">${s ? (s.missing.length ? "Needs your input: " + esc(s.missing.join(", ")) : "Saved facts · source version " + s.version) : "Not checked at current source version"}</span></span><span class="count">${s ? Object.keys(s.facts).length + " facts" : "Pending"}</span></div>`;
    })
    .join("");
  const pendingChange = lastChange && !task.steps[lastChange.source];
  $("resume-note").hidden = !lastChange;
  $("resume-note").textContent = pendingChange
    ? lastChange.message
    : lastChange
      ? "Updated " +
        data.sources[lastChange.source].title.toLowerCase() +
        " to version " +
        data.sources[lastChange.source].version +
        ". Other finished checks were preserved."
      : "";
  if (task.status === "active")
    buttons([
      [
        n < 3
          ? "Check next source →"
          : task.draft
            ? "Refresh saved progress"
            : "Prepare the briefing →",
        "primary",
        async () => {
          if (!runner || runner.taskId !== task.id || !task.leaseActive)
            await claim("Desktop assistant");
          if (n < 3) {
            const r = await api("step", {
              ...base(),
              leaseToken: runner.leaseToken,
            });
            task = r.task;
            notice(data.sources[r.checked].title + " checked and saved.");
          } else if (!task.draft) {
            const r = await api("draft", {
              ...base(),
              leaseToken: runner.leaseToken,
            });
            task = r.task;
            notice(
              "Briefing prepared. Please review the exact current version.",
            );
          }
        },
      ],
      [
        "Pause here",
        "subtle",
        async () =>
          notice(
            "You can leave now. All finished checks are on disk. Continue on desktop when you return.",
          ),
      ],
      [
        "Withdraw permission",
        "subtle",
        async () => {
          await api("revoke", base());
          notice(
            "Permission withdrawn. No further assistant actions are allowed.",
          );
        },
      ],
    ]);
  else buttons([["Start another briefing", "subtle", start]]);
  $("handoff").hidden = task.status !== "active";
  $("runner-label").textContent = task.activeRunner
    ? task.activeRunner + (task.leaseActive ? " · active" : " · paused")
    : "No assistant active";
  $("takeover").textContent =
    runner?.name === "Desktop assistant"
      ? "Start a fresh assistant →"
      : "Continue on desktop →";
  $("old-attempt").hidden = !oldRunner;
  $("event-count").textContent = task.events.length + " events";
  $("events").innerHTML = [...task.events]
    .reverse()
    .map(
      (e) =>
        `<li class="${e.kind === "blocked" ? "blocked" : ""}"><strong>${esc(e.message)}</strong><time>${new Date(e.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time></li>`,
    )
    .join("");
  $("brief-empty").hidden = !!task.draft;
  $("brief-content").hidden = !task.draft;
  $("review").hidden = !task.draft;
  $("brief-status").textContent =
    task.status === "completed"
      ? "Owner confirmed"
      : task.draft
        ? "Needs your review"
        : lastChange
          ? "Needs update"
          : "Not prepared yet";
  $("brief-status").className =
    "pill " +
    (lastChange && !task.draft ? "warning" : task.draft ? "" : "neutral");
  if (task.draft) {
    $("brief-content").innerHTML = renderBrief(task.draft.text);
    $("confirm").hidden = task.status !== "active";
    $("download").hidden = task.status !== "completed";
    $("download").href = "/api/brief/" + task.id;
    $("review-copy").textContent =
      task.status === "completed"
        ? "Confirmed by you. This is the exact version you approved."
        : "Check the entrance, timings and assignments before confirming.";
    $("digest").textContent =
      "Version fingerprint: " + task.draft.digest.slice(0, 20) + "…";
  }
  renderSources();
  document
    .querySelectorAll("button")
    .forEach((b) => (b.disabled = busy || autoRunning));
  const pauseButton = [...document.querySelectorAll("#actions button")].find(
    (b) => b.textContent === "Pause here",
  );
  if (pauseButton) {
    pauseButton.disabled = busy;
    pauseButton.onclick = () => {
      pauseRequested = true;
      notice(
        autoRunning
          ? "Pausing after the current check. Finished work stays saved."
          : "Paused. Finished checks stay saved; continue whenever you are ready.",
      );
    };
  }
  if (task.status === "active" && !task.draft) {
    const auto = document.createElement("button");
    auto.className = "primary";
    auto.textContent = autoRunning
      ? "Preparing your briefing…"
      : "Continue preparing →";
    auto.disabled = busy || autoRunning;
    auto.onclick = runAssistant;
    const step = document.querySelector("#actions .primary");
    if (step) step.className = "subtle";
    $("actions").prepend(auto);
  }
}
function renderSources() {
  $("sources").innerHTML = Object.entries(data.sources)
    .map(
      ([k, s]) =>
        `<article class="source"><div class="source-top"><b>${esc(s.title)}</b><span class="source-version">Version ${s.version}</span></div><pre>${esc(s.text)}</pre><details><summary>Edit ${esc(s.title.toLowerCase())}</summary><label class="small" for="source-${k}">Source text (label: value format)</label><textarea id="source-${k}">${esc(s.text)}</textarea><button class="subtle" data-save="${k}">Save source changes</button>${k === "venue" ? '<button class="subtle" id="east-door">Change entrance to East door</button>' : ""}</details></article>`,
    )
    .join("");
  document.querySelectorAll("[data-save]").forEach(
    (b) =>
      (b.onclick = () =>
        action(async () => {
          const k = b.dataset.save;
          await api("source", {
            source: k,
            text: $("source-" + k).value,
            version: data.sources[k].version,
          });
          notice(
            "Source updated. The old briefing is no longer current; unrelated checks were kept.",
          );
        })),
  );
  if ($("east-door"))
    $("east-door").onclick = () =>
      action(async () => {
        const s = data.sources.venue;
        await api("source", {
          source: "venue",
          text: s.text.replace(/^Entrance:.*$/m, "Entrance: East door"),
          version: s.version,
        });
        notice(
          "Entrance changed to East door. Only venue needs rechecking. The old briefing cannot be confirmed.",
        );
      });
}
function renderBrief(text) {
  return text
    .split("\n")
    .filter(
      (line) =>
        !line.startsWith("## Sources") &&
        !line.startsWith("- [programme v") &&
        !line.startsWith("- [venue v") &&
        !line.startsWith("- [people v") &&
        !line.startsWith("Synthetic workshop"),
    )
    .map((line) => {
      let s = esc(line)
        .replace(/\*\*(.*?)\*\*/g, "<b>$1</b>")
        .replace(
          /\[(programme|venue|people) v(\d+)\]/g,
          '<span class="citation">[$1 v$2]</span>',
        );
      if (s.startsWith("# ")) return "<h2>" + s.slice(2) + "</h2>";
      if (s === "## Volunteer briefing") return "";
      if (s.startsWith("## ")) return "<h3>" + s.slice(3) + "</h3>";
      if (s.startsWith("- [ ]"))
        return '<div class="brief-line">□ ' + s.slice(6) + "</div>";
      if (s.startsWith("- "))
        return '<div class="brief-line">' + s.slice(2) + "</div>";
      return s ? "<p>" + s + "</p>" : "";
    })
    .join("");
}
async function start() {
  const r = await api("task", { requestId: id() });
  task = r.task;
  sessionStorage.setItem("task", task.id);
  runner = null;
  oldRunner = null;
  saveRunner();
  await claim("Phone assistant");
  notice("Briefing started. The first source is ready to check.");
}
async function runAssistant() {
  if (busy || autoRunning || !task || task.status !== "active") return;
  autoRunning = true;
  pauseRequested = false;
  notice(
    "Continuing saved work. Only unfinished or updated sources will be checked.",
  );
  render();
  try {
    if (!runner || runner.taskId !== task.id || !task.leaseActive)
      await claim("Desktop assistant");
    while (!pauseRequested && task.status === "active" && !task.draft) {
      const route = completeCount() < 3 ? "step" : "draft";
      const result = await api(route, {
        ...base(),
        leaseToken: runner.leaseToken,
      });
      task = result.task;
      await refresh();
      if (route === "draft") break;
      await new Promise((r) => setTimeout(r, 1800));
    }
    notice(
      pauseRequested
        ? "Paused. Finished checks are saved; another assistant can pick up here."
        : "Briefing prepared. Review the exact current version before confirming.",
    );
  } catch (e) {
    notice(e.message, true);
  } finally {
    autoRunning = false;
    await refresh();
  }
}
$("start").onclick = async () => {
  await action(start);
  await runAssistant();
};
$("takeover").onclick = () =>
  action(async () => {
    await claim("Desktop assistant");
    notice(
      "Desktop took over. Finished checks were kept. The previous assistant cannot write.",
    );
  });
$("old-attempt").onclick = () =>
  action(async () => {
    try {
      await api("step", {
        taskId: task.id,
        revision: task.revision,
        requestId: id(),
        leaseToken: oldRunner.leaseToken,
      });
      notice("Unexpected: old assistant was allowed to write.", true);
    } catch (e) {
      notice("Old assistant blocked: " + e.message, true);
    }
  });
$("confirm").onclick = () =>
  action(async () => {
    await api("confirm", { ...base(), digest: task.draft.digest });
    notice("Confirmed. Download the exact briefing you reviewed.");
  });
try {
  await api("session");
  await refresh();
} catch (e) {
  $("connection").textContent = "Connection interrupted";
  notice(
    "Cannot reach the local server. Your saved work stays on disk. Reload after restarting it.",
    true,
  );
}
