# DreamDesk: agent guide

DreamDesk is an Orca plugin (a components panel plus a Node worker). It keeps one attention queue for the user's Orca agents, Slack and Linear. It acts as a **shield** while the user focuses on one item and as a **router** when they are free.

## Data flow

1. **Collector**: an Orca automation runs `collector/prompt.md` in Claude every 30 min. It reads Slack and Linear through MCP, classifies each entry (urgent, importance 1–4, people) and writes JSON arrays to `~/.orca-helpdesk/inbox/`.
2. **Worker** (`src/worker.ts`): every minute it ingests the inbox. It also:
   - polls Slack threads and team channels with the user's own token;
   - polls the iCal feed;
   - links items to Orca worktrees through `orca reference find`;
   - listens to `agent.status.changed`.

   It keeps the queue in `orca.storage` and posts a `View` to the panel.
3. **Panel** (`src/panel.tsx`) renders the `View` and sends actions back with `plugin.request`. Requests and events are typed once, in `src/protocol.ts`.

## Where logic lives

- `src/queue.ts`: all queue rules. Pure functions, with no I/O and no `node:` imports, so the panel can import from it. Ranking, transitions (take, done, pass, snooze, delegate, wait on worktree), shield breakthrough, Slack thread updates.
- `src/calendar.ts`: iCal parsing and the timeline layout. Pure as well.
- `src/slack.ts`: the Slack Web API client. It imports `node:fs`, so it is **worker-only**.
- New rules belong in a pure module with a test. The worker only wires them to I/O.

## Configuration

Nothing personal lives in the repo: no names, channel IDs, domains or tokens.

- Tokens and addresses (Slack `xoxp-` token, calendar iCal URL) go in `orca.secrets`. The panel's Connect fields set them.
- Per-person choices are `contributes.settings` (`teamChannels`, `incidentChannels`). The worker mirrors what the collector needs into `~/.orca-helpdesk/config.json`.
- Tests and examples use placeholders such as `acme`, `#team` and `me@example.com`.

## Verify

```sh
orca plugin test .     # every change; `HELPDESK_INBOX=$(mktemp -d)` keeps tests away from ~/.orca-helpdesk
orca plugin check .    # renders src/panel.check.ts scenarios
```

To see the live panel:

```sh
orca plugin dev reload
orca plugin shot <plugin-key> --panel helpdesk --out <file>.png
```

Read the PNG. Wait until `queue.get` answers with `slack: true` first, because a shot taken while the worker restarts shows "Loading…".

## Before changing the panel, images, or the worker's host calls

Read `docs/orca-gotchas.md`. It lists the Orca platform behaviours this code works around: image serving, Box widths, missing hover, theme tones, consent on reload. Each one has already caused a bug here.
