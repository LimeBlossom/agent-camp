# Reloading Camp data

The packaged app needs one rebuild and relaunch to install this support. Changes
to bundled main-process, preload, phone-page or hook-shim code still require a
rebuild; renderer code can load from disk (below). These external files can then
change while Camp is running:

| File or setting | When changes take effect |
| --- | --- |
| `config.json` in Electron's user-data directory | After a 100 ms debounce; settings are broadcast to every window and mission/context schedules are refreshed. Invalid JSON keeps the last valid configuration in memory. |
| `<harnessHome>/roster.json` | After a 100 ms debounce; saved fields on existing agent cards refresh while terminal status stays live. |
| `<hive>/registry.json` | After a 100 ms debounce; existing cards refresh their names and roles. |
| `<hive>/prompts/worker.md` and `boss.md` | On the next agent spawn. Missing/unreadable files use the bundled prompt. |
| External `camp` MCP JavaScript entry point | On the next Claude Boss spawn. Its modules are loaded in that new child process. |
| `<hive>/prompts/sections/<key>.md` | On the next agent spawn. See `docs/camp-prompt-overrides.md`. |
| `<hive>/prompts/messages/<key>.md` | On the next message of that kind. A blank file, or one naming a placeholder that message lacks, uses the bundled text. |
| Renderer build named by `campRendererDir` or `campRendererPath` (config), or `CAMP_RENDERER_DIR` / `CAMP_RENDERER_PATH` (env) | On Ctrl/Cmd+R in a floor window. A directory resolves to its `index.html`; a missing path uses the bundled renderer. Terminals stay alive, but each terminal keeps only its current screen: scrollback is lost. The preload script is always the bundled one. |

Set `campMcpServerPath` in `config.json` to an absolute JavaScript file path, or
set `CAMP_MCP_SERVER_PATH` in the environment that launches Camp. A configured
path takes precedence over the environment variable. A missing path or a directory
falls back to the bundled `campMcpServer.js`. The external entry point must have
its own required modules and dependencies available beside it.

Prompt files replace the entire injected system prompt. Optional placeholders
`{{name}}`, `{{id}}`, `{{dir}}`, `{{root}}`, and `{{tools}}` expand at spawn time;
all other text stays literal. Task kickoff content is still delivered separately.
Removing a prompt file restores the bundled prompt for the next spawn.

`ensureHive()` refreshes `PROTOCOL.md`, `PROTOCOL-BOSS.md`, and `COMMANDS.md` only
when missing or when their content matches the previously recorded bundle hash
in `<hive>/.bundled-protocol-hashes.json`. Edited files with a recorded bundle hash
are preserved, and each skip appends a `protocol-file-kept` event with the file name
to `log.jsonl`. On the first upgrade, files without recorded hashes are refreshed
from the bundle: the previous app overwrote them on every bootstrap. To restore a
bundled protocol, keep a copy of the local file and remove it before the next
bootstrap or spawn.

File watches monitor parent directories, so atomic replacement saves remain
visible. Roster watches follow the configured home and are closed on shutdown.

## Design: reloading app code (proposal, nothing below is built)

### What forces a rebuild today

The 107 commits on the integration branch that touched `src/` between 2026-10-15 and
2026-11-11, grouped by the areas each one touched:

| Areas touched | Commits |
| --- | --- |
| Main process only | 60 |
| Main process plus renderer, preload, shared or phone | 32 |
| Phone page only (`phone.ts`, `phonePage.ts`, `phoneMarkdown.ts`) | 7 |
| Renderer only | 4 |
| Phone, renderer, preload or shared, without main | 4 |

92 of the 107 (86%) changed main-process code. The most-touched files in the
main-only commits were `hive.ts` (20), `index.ts` (17), `campTools.ts` (10) and
`config.ts` (6). `taskPatch.ts` appeared in 2. Three commits touched only the camp
MCP files, which `campMcpServerPath` can already reload for the Boss. The human's
`config.json` sets neither that key nor `campRendererDir`.

Phone page and renderer reloads together reach at most 14 of the 107; rules
loaded from a script would add about 2. Only a change in how the main process
restarts reaches the other 86%.

A merged card needs a rebuild when it touches `src/main`, `src/preload`, or a
`src/shared` module that main imports. A renderer-only change needs Ctrl+R with
`campRendererDir` set. Once slice 1 lands, a phone-only change needs a page refresh.

### Candidates

**1. Phone page served from disk.** Safe to reload.
- Today `PHONE_PAGE` is a template string built once at module load
  (`phonePage.ts:5`), with `parsePhoneMarkdown` spliced in through `toString()`
  (`phonePage.ts:229`). `GET /` returns it (`phone.ts:347`).
- Design: the build writes the finished string to `out/phone/index.html`. A
  `campPhonePagePath` config key (or `CAMP_PHONE_PAGE_PATH`) names an absolute
  file, read on each `GET /`. A missing or unreadable file serves the bundled
  string, using the same fallback as `campRendererDir`. The CSP stays as it is,
  so the page keeps its JS inline.
- Risk: low. No agent or terminal is involved, and a phone refresh picks it up.
  The page can drift ahead of main's `/api/*` routes. A page that calls a route
  main lacks gets a 404. Today that fails the JSON parse and shows "offline"
  (`phonePage.ts:228, 911`), which hides the real cause; only a 401 clears the
  stored token. Anyone who can write `config.json` could serve
  their own script to the phone, but `campMcpServerPath` already lets them run
  code.

**2. Renderer dev reload.** Shipped. v0.4.6 contains the `campRendererDir`
lookup (`campRenderer.ts:33-50`) and Ctrl/Cmd+R (`index.ts:2545-2552`); see the
table above.
- Gaps: the preload script is always the bundled one (16 of the 107 commits
  touched it). A renderer built against newer preload calls fails at runtime. A
  reload keeps the PTYs but drops xterm scrollback: main keeps only an 8 KB crash
  tail (`pty.ts:36`), and `redrawPty` restores the current screen. Desktop-mode
  windows (`desktop.ts`) have no Ctrl+R.
- Risk: low. A follow-up could have the preload expose an API version, with the
  renderer falling back to the bundled build when the versions disagree.

**3. Main-process rules from an external script.** Possible, but not worth it yet.
- `planTaskMessage` (`taskPatch.ts:157`), `answerNeedsBoss`, `getMessageRoute`,
  `modelOrderFor`, `engineOrderFor` and `difficultyEffort` are pure. Their
  imports stay inside `src/shared` leaf modules. `HiveManager` setters such as
  `setCardPatchGate` (`hive.ts:2281`) are a ready seam. Routes already reload as
  data through `config.routes`.
- Not pure: send-back counting has a second copy at `hive.ts:2560-2564`;
  `cardDifficulty` and `spawnEffort` read `tasks.json` and the database
  (`index.ts:3780-3793`); `routeHumanAnswer` and `routeMessage`/`deliver` do I/O.
  Delivery should stay bundled.
- Risk: high, because unlike the camp MCP server the code runs inside main. A
  throw inside `drainOutboxes` is caught at `hive.ts:2452`, which renames the file
  to `.sent/bad-<file>` with no log entry and no refusal mail, so a broken rule
  would silently eat every card edit. Containment would need:
  - its own try/catch, falling back to the bundled function and logging a
    `rule-error` entry;
  - bundled re-validation of every verdict, covering allowed keys per role, field
    types, an existing id, and the done, closing-time and backlog refusals (the
    external rule could add refusals, never remove them);
  - a JSON round-trip, since an unserialisable value makes the ledger flush lose
    the whole tick;
  - a `vm` timeout, because the router runs on the main thread.
- The containment is more code than the rules it reloads, and the rules changed
  in 2 of the 60 main-only commits.

**4. Hook shims from disk.** Low value.
- `HOOK_SHIM`, `AGY_HOOK_SHIM`, `GEMINI_HOOK_SHIM`, `GROK_HOOK_SHIM` and
  `CLAUDE_HOOK_ADAPTER` are strings that `ensureHive()` writes to `<hive>/bin` on
  boot, every spawn and every `writeTasks` (`hive.ts:866-874`). A hand edit
  therefore lasts until the next spawn.
- An override directory checked at those write points would apply on the next
  spawn.
- Risk: medium. Every agent runs the shim on every hook. A broken shim breaks hooks
  floor-wide, and a shim ahead of `HookServer` can send frames main does not parse
  (`hooks.ts:27`).
- How often the shims change was not measured: they sit inside `hive.ts` beside
  unrelated code.

**5. Main-process restart on code change.** This is the only lever on the 86%, but
a plain restart is a reboot with extra steps.
- Main spawns every PTY directly (`pty.ts:677`) and kills them on exit
  (`pty.ts:844-861`). Relaunched agents start fresh on their next work: resume is
  off by design (`useRestoreTeam.ts:141-144`; see `docs/per-card-sessions.md`).
- A restart also resets in-memory guards: circuit-breaker counts, todo nudges,
  quota watch, crash backoff, temporary-worker caps, broker tokens, and Unity runs
  in flight (which `recoverInterrupted` reports as interrupted).
- `npm run dev` has no `-w`, so dev mode does not restart main today. With `-w`,
  electron-vite sends SIGTERM and launches straight away. That has not been tested
  against the `before-quit` cancel and the single-instance lock.
- Three ways to make it cheap, smallest first:
  - **5a. Restart with resume.** After a main restart, respawn each agent that was
    on a doing card with `--resume <sid>`. `spawnAgentCore` already supports this
    (`index.ts:2979-2983`), and session ids are on disk.
    - Kept: the card's conversation.
    - Lost: the in-flight turn and any half-run tool call (a commit or file write
      cut off mid-way), and the in-memory guards above.
    - Claude only; the other engines resume differently or not at all.
  - **5b. PTY host process.** Move `PtyManager` into a long-lived child that main
    reconnects to over a socket, as `hooks.sock` does, with a scrollback ring per
    terminal for replay. Agents never die on a main restart.
    - Large: every `pty:data` path, crash detection, quit semantics and
      `hiddenClaude` change.
    - Under an AppImage the mount at `/tmp/.mount_*` goes away when the app exits.
      A host process running from that mount would lose its own files, so the host
      needs an install location outside the image.
  - **5c. Main code from disk.** A bundled stub `require`s `out/main/index.js` from
    a configured directory. This removes the packaging step but not the restart.
    The repo's native modules must match the packaged Electron ABI, and every
    `__dirname`-relative path (preload, renderer, MCP entry points,
    `process.resourcesPath`) needs auditing. It is only worth it after 5a or 5b.

### Recommended first slice

Slice 1 is candidate 1, the phone page from disk:
- `campPhonePagePath`, read on each request, with fallback to the bundled string;
- a build step that writes `out/phone/index.html`;
- the 404 handling in the page;
- tests: a request after a file edit serves the new page, and a missing file or a
  directory serves the bundled one.

It is self-contained, cannot touch an agent, and repeats a fallback pattern that
is already proven. The renderer reload it pairs with already ships (see the
table above).

The human decides whether to fund 5a next. It is the only option that reaches the 86%
of commits that touch main. Its cost is that a code-change restart costs each
agent its current turn but not its card context, which bends the fresh-session
rule for a restart in the middle of a card.
