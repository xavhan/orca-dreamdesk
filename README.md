# DreamDesk

An Orca plugin that gives you one attention queue for your Orca agents, Slack and Linear.

- **Shield:** while you work on one item, new things wait in the queue. Only urgent ones break through, with a blinking status bar item and a notification.
- **Router:** when you are free, it hands you the next most important item, with its context.
- **Team:** your team Slack channels, today's meetings, and the Orca worktree linked to each ticket.

Nothing personal is stored in the code. Each person connects their own accounts. Tokens and addresses go in the plugin's encrypted secrets, and everything else lives in Orca Settings.

## Install

```sh
git clone https://github.com/xavhan/orca-dreamdesk.git && cd orca-dreamdesk
orca plugin dev load .          # Orca lists the access it asks for; approve it
orca plugin open local.helpdesk --panel helpdesk
```

(`local.helpdesk` is the plugin key, from the manifest `id`. `orca plugin list` shows it.)

## Set up (5 minutes)

1. **Slack, to read threads and reply as you.** Create a Slack app at <https://api.slack.com/apps>. Under *OAuth & Permissions → User Token Scopes*, add:
   `channels:history groups:history im:history mpim:history search:read users:read chat:write files:read im:write`
   Install it to your workspace and copy the **User OAuth Token** (`xoxp-…`). Paste it into the panel's **Connect Slack** field.
2. **Calendar, for today's meetings.** In Google Calendar, go to *Settings → your calendar → Integrate calendar → Secret address in iCal format*. Paste that address into the panel's **Connect calendar** field.
3. **Team channels.** In *Orca Settings → DreamDesk*:
   - **Team channels:** one channel per line, its ID then a label, for example `C0123ABCD #my-team`. In Slack, the ID is at the bottom of the channel's *About* panel.
   - **Incident channels:** where production incidents are reported, for example `#engineering, #ops`.
4. **Collector.** Run the Orca command **DreamDesk: set up the Slack/Linear collector**. It creates an automation where Claude reads Slack and Linear every 30 minutes and drops new items into `~/.orca-helpdesk/inbox/`. Claude needs the **Slack** and **Linear** connectors.

## Develop

Coding agents (and humans): start with [`AGENTS.md`](AGENTS.md) for the architecture and conventions, and [`docs/orca-gotchas.md`](docs/orca-gotchas.md) before touching the panel or images.


```sh
orca plugin test .     # unit tests
orca plugin check .    # renders the panel scenarios
```

- `src/queue.ts`: the queue, its ranking and transitions (pure)
- `src/worker.ts`: wires it to Orca (agents, inbox, Slack, calendar, worktrees)
- `src/panel.tsx`: the panel
- `src/slack.ts`, `src/calendar.ts`: Slack Web API client, iCal parsing
- `collector/prompt.md`: the collector automation's prompt
