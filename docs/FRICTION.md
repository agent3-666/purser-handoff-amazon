# Integration friction log

These entries record issues in **our own local application integration and development builds** on 23 October 2026. They are not reports of defects in Amazon services, Alexa+, the MCP SDK or browser cookie standards. We used a labelled browser simulation and a real local MCP server; we did not test actual Alexa accounts, devices or partner onboarding.

The failures below were fixed before delivery. Reproduction steps describe the affected development implementation, not expected behavior in the submitted version. Severity is our assessment of impact on this prototype, not an official platform rating.

## 1. Parallel local servers overwrote browser pairing

**Task:** Test and record an isolated instance while another local instance remained open for review.

**Development reproduction:**

1. Start two app servers on different loopback ports, each with its own state directory and independently generated local capability.
2. Open the first app and complete its browser pairing.
3. Open the second app, which originally set a cookie with the same name and host/path as the first.
4. Return to the first app and continue preparing a briefing.

**Expected:** Each instance keeps its own pairing and accepts its own browser requests.

**Actual:** The second pairing replaced the first instance's cookie. The first app returned HTTP 401 with a request to reload and pair, despite its server still being healthy. This occurred during the automated-preparation recording attempt. The affected recording was not used as the final demonstration.

**Severity:** High for local development continuity. It interrupted a valid workflow; it was not evidence of a lost task checkpoint or an Amazon outage.

**Cause:** We treated different ports as if they isolated cookies. Browser cookies are scoped by host/path, not by port.

**Fix and workaround:** Use a port-specific cookie name (`handoff_${port}`), retain the same-origin/Host checks, and reload to pair with the correct instance. Separate data directories alone do not solve cookie collisions.

**Verification:** The final isolated instance completed automatic preparation, pause, takeover, source update, confirmation and download. Independent review used another isolated instance. The final downloaded document matched its owner-confirmed digest.

**Actionable suggestion:** Local multi-server quickstarts could explicitly explain cookie scope and show per-instance pairing isolation. This is a documentation suggestion for application authors, not a request to change browser semantics.

## 2. A safe retry could misleadingly look like a current completion

**Task:** Retry an exact confirmation request after its response may have been lost, without presenting outdated work as complete.

**Development reproduction:**

1. Generate and confirm a briefing using a request ID and exact document digest.
2. Update the venue source, invalidating that draft and reopening the task.
3. Replay the original confirmation request with the same request ID and payload.

**Expected:** No duplicate confirmation effect. The response must also make clear that the current task is active and the old draft is no longer downloadable.

**Actual implementation behavior found in review:** The first idempotency implementation returned the cached result before checking current state. That result contained an old completed-task snapshot. The underlying source update could still be correct, but a client consuming the replay response could be misled into presenting the historical completion as current. This issue was identified by reviewing the replay branch; we do not claim an observed duplicate external action or an Amazon/MCP transport failure.

**Severity:** High for correctness of user-facing completion and approval state.

**Fix:** A replay now returns the current task and an explicitly historical `originalResult`. The download route independently requires the current confirmed draft. Historical confirmation details remain in the event history after a source change.

**Verification:** A dedicated regression confirms, changes the venue, then replays the old request. It asserts a current active task with no current draft or receipt, while retaining the historical receipt explicitly. Real HTTP/MCP acceptance additionally checks that the old download returns 409 until a new draft is confirmed. See [MCP/HTTP acceptance results](evidence/mcp-http-acceptance.json).

**Actionable suggestion:** Durable-workflow examples should distinguish request-effect idempotency from the freshness of returned business state. Reusing a request ID should not imply that its old snapshot is still authoritative.

## 3. A first-run render exception stranded enabled work behind disabled controls

**Task:** Create a briefing and advance the first source check through the browser UI.

**Development reproduction:**

1. Open a fresh app workspace and select **Prepare volunteer briefing**.
2. Advance a source check using the development UI's single-step control.
3. Let the response refresh and rerender the task controls.

**Expected:** The saved check appears, progress advances, and the next valid controls remain usable.

**Actual:** The server operation succeeded, but the page still displayed the old progress and its buttons remained disabled. The renderer referred to the original start button after the dynamic actions container had replaced and removed it, causing a null-element exception during refresh. A reviewer reproduced the stall in the actual UI.

**Severity:** High: the first-use UI could not continue even though the backend had saved work.

**Fix:** Guard access to the initial-only node, maintain a separate working **Start another briefing** entry after completed/withdrawn tasks, and render from refreshed server state. The final primary preparation path also runs the remaining source checks and draft automatically, while retaining pause and optional single-step inspection.

**Verification:** Subsequent real UI review and the final recording covered task creation, pause/reload, takeover, old-runner rejection, automatic completion, incremental regeneration, exact-draft confirmation and download. The final flow checked programme once, assignments once and venue twice because its source changed. See [final flow evidence](evidence/final-flow-acceptance.json).

**Actionable suggestion:** UI acceptance should include a fresh workspace and the first state transition, not only a pre-populated success view. Transport or unit-test success does not prove that the user can finish the task.

## Scope of feedback

The official MCP SDK enabled an independently testable Streamable HTTP implementation. These lessons concern the application lifecycle built on top of it. We have no first-hand findings about real Alexa onboarding, speech quality, device behavior, Amazon payments, production customers or AWS deployment, and make no claims about those experiences.
