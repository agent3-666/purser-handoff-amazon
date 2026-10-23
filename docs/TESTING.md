# Judge testing guide

Run `npm ci`, then `npm start`; visit http://127.0.0.1:5387. This is a local web app and real local MCP server, not a static site. No login, API key, credit card, AWS account or Alexa device is required. Keep the terminal running.

## Positive experience

Start the volunteer briefing. The assistant sequentially reads the three local source documents, saves structured facts, and prepares a draft automatically. Pause early, reload, then take over with the desktop runner and continue. Check that completed source checks are retained. The source events are real server events, not a scripted success screen.

Review the resulting entrance, setup/welcome times and named assignments. Each fact cites its source and version. Confirm the displayed draft and download the actual Markdown. The file includes full source hashes.

## Negative and recovery cases

- After takeover, the safety-check button sends an actual old-runner request. It must produce a refusal, not change the saved facts.
- Change the venue entrance from West door to East door. Only the venue check should clear; the draft/confirmation/download becomes unavailable. Continue automatically, confirm the East-door draft, and download it. Programme/people source checks should each occur once; venue twice.
- Remove the `Entrance:` line in the venue editor. Automatic preparation stops with a missing-information message. It must not invent an entrance or generate an approved draft. Restore the line and continue.
- Add two `Entrance:` lines. Drafting must block on conflicting duplicate data.
- Withdraw permission from an active task. Further work must stop. The saved history remains inspectable.
- Restart the server and reload the page. Saved work survives, but browser pairing refreshes. Use takeover after the runner permission expires (90 seconds idle).

Automated checks: `npm test` (state regressions), `npm run check` (syntax), `npm run test:interop` (real HTTP and official MCP Client including process crash recovery). The test client uses an isolated temporary data directory and cleans up only that directory.

The task's current state is authoritative. A cached historical idempotent result is clearly separated from the current task. Local trusted clients can approve on behalf of the local owner; there is no claim of production human-identity attestation.
