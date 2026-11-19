// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
import type { Item, Msg, Queue, Status } from './queue'
import type { Meeting } from './calendar'

export type Action = 'take' | 'done' | 'pass' | 'sink' | 'answer' | 'await_reply' | 'relax' | 'start' | 'wait' | 'snooze' | 'delegate' | 'other' | 'release' | 'ack'

export interface View {
  focus: Queue['focus']
  current: Item | null
  next: Item[]
  parked: Item[]
  alert: boolean
  /** Whether a Slack user token is connected. */
  slack: boolean
  /** Workspace URL such as https://acme.slack.com/, to build thread links. */
  slackUrl?: string
  /** Team tabs: channel feeds, then threads opened in their own tab. Messages oldest first. */
  channels?: Tab[]
  /** Whether a calendar feed is connected, and today's meetings with where they stand now. */
  calendar?: boolean
  /** The team's standing meeting link (`permaconfUrl` setting). */
  permaconf?: string
  /** When the worker built this view; the timeline's "now". */
  nowAt?: number
  meetings?: (Meeting & { status: 'past' | 'now' | 'upcoming' })[]
  /** CI of the current item's PR (its PR link, else its worktree's branch), polled every minute. */
  ci?: { state: 'running' | 'failing' | 'passed'; url: string }
  /** Item id → what its row border shows (see `Q.status`). */
  status?: Record<string, Status>
  /** Item id → why it needs the user (`Q.needReason`), for the "Needs you" label. */
  needs?: Record<string, string>
  /** Queued item whose worktree is the one focused in Orca, when that is not the current item's. */
  here?: string
  /** Item id → Orca worktree linked to it (via `orca reference find`) and its agent status. */
  worktrees?: Record<string, Worktree>
  /** Person name → avatar file, for people the collector names. */
  avatars?: Record<string, string>
}

export interface Worktree {
  id: string
  name: string
  /** Workspace status from workspace.list: working, permission (needs you), done, active, inactive. */
  state: string
}

export interface Tab {
  /** Channel id, or `<channel>:<ts>` for a thread tab. */
  id: string
  name: string
  url: string
  channel: string
  /** Thread tabs only: the root message ts. */
  ts?: string
  /** A direct conversation opened from an avatar; closable like a thread tab. */
  dm?: boolean
  messages: Msg[]
}

export interface AgentRow {
  terminalId: string
  title: string
  workspace: string
}

declare module 'orca' {
  interface PluginRequests {
    'queue.get': { output: View }
    'queue.act': {
      /** `start`: note a task of your own (`title`) and make it the current one. */
      input: { action: Action; id?: string; choice?: '30m' | '2h' | 'tomorrow'; terminalId?: string; answer?: string; title?: string }
      output: View
    }
    'agents.all': { output: AgentRow[] }
    'item.open': { input: { id: string }; output: { ok: boolean } }
    'slack.connect': { input: { token: string }; output: View }
    'slack.reply': { input: { id: string; text: string }; output: View }
    /** Posts in a team channel, or in one of its threads when `ts` is given. */
    'slack.post': { input: { channel: string; text: string; ts?: string }; output: View }
    'calendar.connect': { input: { url: string }; output: View }
    'worktree.open': { input: { id: string }; output: { ok: boolean } }
    'thread.open': { input: { channel: string; ts: string; title: string }; output: View }
    /** Closes a thread or direct-conversation tab. */
    'thread.close': { input: { id: string }; output: View }
    /** Opens (or reuses) a direct conversation with a person, as a team tab. `id` is the tab. */
    'dm.open': { input: { name: string }; output: { view: View; id: string } }
    /** Replies of a thread in a team channel, root excluded, oldest first. */
    'slack.thread': { input: { channel: string; ts: string }; output: Msg[] }
  }
  interface PluginPanelEvents {
    'queue.changed': View
    /** Toggles every second while a row's agent works, to blink its border. */
    blink: boolean
  }
}
