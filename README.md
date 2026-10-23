# Agent3 Purser Handoff

**A pause should not mean starting over.** Prepare a volunteer briefing from workshop notes, pause, then continue with another assistant without repeating finished work or accepting an outdated draft.

This is an **Alexa+ experience simulation**, with a real local workflow backend and a real self-hosted MCP server. It does **not** connect to Alexa, use Amazon accounts, make payments, send messages, or call an LLM. The workshop and names are synthetic. Source extraction, checkpointing, takeover, document generation, confirmation and downloads actually run.

## Try it in two minutes

Requires Node.js 20.19+ and npm. No API key, cloud account, device or payment is required. Dependency installation uses the public npm registry; the app runs locally afterward.

```sh
npm ci
npm start
```

Open **http://127.0.0.1:5387**. The server binds only to loopback. Use `PORT=5395 npm start` if the default port is occupied; do not stop an unfamiliar service. To run a separate demo, also set a different `DATA_DIR`.

1. Select **Prepare volunteer briefing**. The deterministic assistant starts checking the programme, venue instructions and volunteer assignments.
2. Select **Pause here** before all checks finish. Reload the page. Already checked facts remain saved.
3. Select **Continue on desktop**, then **Safety check: let the old assistant try again**. The old runner's actual request is refused.
4. Select **Continue preparing**. The assistant checks only the unfinished sources and prepares a Markdown briefing with per-fact citations.
5. Open **Edit venue instructions**, then select **Change entrance to East door**. The old draft disappears. The other two source checks stay saved.
6. Select **Continue preparing** again. Only the venue is rechecked, and the new briefing cites `venue v2`.
7. Review the draft, select **I've reviewed this briefing. Confirm it.**, and download the actual confirmed Markdown file.

The phone/desktop labels represent **two runner identities in the same local browser/server**, not a deployed cross-device service. There is no automatic sending step. The single-step controls remain available for inspection.

## What is different about the handoff?

The checkpoint is not a chat summary. It contains actual extracted facts, completed subtask records, source versions and hashes, and a saved event history. A replacement runner keeps those artifacts. Server-issued runner permission and task revisions reject the old runner even if it knows the latest task revision.

If an input changes, the affected source check and any generated briefing/confirmation become outdated. Other checks survive. The person reviews and confirms an exact SHA-256 digest; the download route serves only the current confirmed version. A replay of an old confirmation returns the **current task** plus an explicitly historical `originalResult`, never an apparently current completion.

## Real MCP interface

`src/server.js` imports and calls the official `@modelcontextprotocol/sdk` at runtime. `/mcp` uses **Streamable HTTP**, stateless JSON responses, and negotiates **2025-11-25** with the official SDK Client.

Tools: `read_workshop`, `start_briefing`, `take_over`, `check_next_source`, `prepare_briefing`, `confirm_briefing`, `withdraw_permission`.

The running server writes a short-lived local bearer capability to `.runtime/client-access.json` with mode 0600, inside the ignored runtime folder. It rotates on restart. An authorized local client can read that file and use `StreamableHTTPClientTransport` with an `Authorization: Bearer …` request header. Do not publish that file. See `scripts/interop.js` for a complete independent-client example; it starts its own isolated server and does not require reading your current demo state.

```sh
npm test
npm run check
npm run test:interop
```

The interoperability check uses a real HTTP initialize exchange, the official SDK Client, all seven tools, two runner identities, an actual Markdown download, source invalidation, concurrent takeover requests, authentication/origin/Host rejection, and a **SIGKILL plus process restart**. It removes only its own temporary test directory.

## Architecture and persistence

- `web/`: accessible English UI, deterministic assistant orchestration and pause controls.
- `src/store.js`: synchronous state transitions, revision checks, runner capabilities, source dependency invalidation and exact-draft confirmation.
- `src/server.js`: single-user loopback HTTP API, browser pairing, download gate and official MCP transport.
- `tests/`: adversarial state tests.
- `scripts/interop.js`: independent official Client acceptance test over real HTTP.

A single writer uses an exclusive process lock. A checked-dead writer can be reclaimed under a separate recovery lock; a live or ambiguous lock refuses startup. Snapshots use a temporary file, file fsync, atomic rename and directory fsync. A malformed store refuses startup rather than silently resetting. Stop/restart the server normally to see saved progress; task data is not cleared. A crash may leave a recovery lock requiring manual review. Network filesystems and multiple writers are not supported.

## Honest boundaries

- Local single-user prototype, not production multi-tenant authentication. The local owner and trusted MCP clients share authority. The `confirm_briefing` tool instructs clients to obtain human approval; it cannot technically prove a trusted client asked a human. The tested safety boundary is stale/unpermitted **runner writes**, not isolation from a malicious local owner/client.
- No official Alexa integration, voice input, Alexa onboarding or device testing. The browser clearly identifies the simulation. A real MCP endpoint is included independently of that simulated presentation.
- No hosted cross-device sync, cloud durability, external task execution, booking, payment or messaging. No real customers or adoption claims.
- Deterministic extraction from a small `label: value` document schema. Missing or duplicate required facts block drafting; this is not arbitrary-document understanding. Humans remain responsible for factual review.
- Disk state is editable by its local owner; hashes identify exact versions, not a tamper-proof ledger. No claim of exactly-once execution of external side effects.
- Revisions are scoped to tasks; the source set is shared within this one local workshop workspace. Editing a source reopens affected confirmed tasks, retaining historical confirmation events.

## New work and provenance

This application was created on 23 October 2026 for Build, Ship, Shape. Agent3's earlier Purser work focused on payment authorization and delivery checks. This project retains the name and interruption-recovery concept but implements a new workshop briefing workflow, source-aware incremental checks, automatic preparation/pause UI, revision/runner state machine, exact-draft confirmation, and MCP transport. **No first-party source code or private data was copied from the earlier payment implementation.** No wallets, private keys or payment libraries are included.

Built with assistance from OpenAI Codex; the precise model revision is not independently verified. No LLM decides task completion at runtime. Our original source and interface assets are MIT licensed; dependencies retain their own licenses. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Official references: [event rules](https://amazonappdev2026.devpost.com/rules), [MCP 2025-11-25 Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [official TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/).
