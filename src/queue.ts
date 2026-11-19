// Pure queue logic: no Orca, no I/O. Every function returns a new Queue.

export type Kind = 'urgent' | 'agent' | 'mention' | 'ticket'
/** `passed`: dismissed as not relevant; only an urgent update brings it back. */
export type State = 'new' | 'in_progress' | 'snoozed' | 'delegated' | 'done' | 'passed'
export type AgentState = 'working' | 'blocked' | 'waiting' | 'done'

export interface Item {
  id: string
  /** `me`: a task the user noted for themself (through the MCP server), logged nowhere else. */
  source: 'agent' | 'slack' | 'linear' | 'me'
  kind: Kind
  title: string
  summary: string
  url?: string
  /** GitHub pull request the item is about; `prSettled` closes the item once it is handled. */
  prUrl?: string
  terminalId?: string
  /** Agent requests only: short answers the panel offers as buttons, typed into `terminalId`. */
  actions?: string[]
  reason?: string
  priority?: number
  people?: string[]
  importance?: number
  arrivedAt: number
  state: State
  snoozeUntil?: number
  /** Agent terminal id, or `ws:<workspace id>` when waiting on a worktree. */
  delegatedTo?: string
  /** Waiting on a worktree: its last seen status, to resurface on a change to needs-you. */
  waitFrom?: string
  /** Sent to the bottom of the queue at this time; cleared by new activity (ingest rebuilds the item). */
  sunkAt?: number
  /** Slack only: latest thread messages, oldest first, and the newest ts already seen. */
  thread?: Msg[]
  seenTs?: string
}

export interface SlackFile {
  id: string
  name: string
  url: string
  image: boolean
  /** Plugin-relative files once downloaded: a 64px thumbnail and a ~360px preview. */
  thumb?: string
  preview?: string
  /** Slack's private thumbnail URLs, used by the worker only and dropped once downloaded. */
  remote?: { thumb?: string; preview?: string }
}

export interface Msg {
  who: string
  text: string
  ts: string
  mine: boolean
  /** Plugin-relative avatar file, when downloaded. */
  avatar?: string
  /** Links in the text, opened from small link buttons (the text shows labels or hosts only). */
  links?: { url: string; label: string }[]
  /** Channel feed only: reply count of a thread root. */
  replies?: number
  /** Attachments: a link to open in Slack and, for images, local thumbnail files. */
  files?: SlackFile[]
}

export interface Queue {
  items: Record<string, Item>
  /** `relax`: lunch or end of day; urgent items wait silently until the user is back. */
  focus: { itemId: string | null; since: number; relax?: boolean } | null
  alert: boolean
}

/** One entry the collector agent writes to the inbox. */
export interface Incoming {
  source: 'slack' | 'linear'
  originId: string
  type: 'mention' | 'ticket'
  urgent?: boolean
  title: string
  summary: string
  url?: string
  /** GitHub pull request the entry is about, when there is one. */
  prUrl?: string
  reason?: string
  priority?: number
  /** Names of the people involved, for the avatars row. */
  people?: string[]
  /** Collector's inferred importance for the user: 1 high … 4 low (info only). */
  importance?: number
  at: number
}

// Urgent first, then agents waiting on you; mentions and tickets share a tier, sorted by importance.
const KIND_ORDER: Record<Kind, number> = { urgent: 0, agent: 1, mention: 2, ticket: 2 }

/** 1 high … 4 low. Inferred importance wins; else Linear priority; else normal (3). */
export function importance(i: Item): number {
  return i.importance ?? (i.priority && i.priority > 0 ? Math.min(i.priority, 4) : 3)
}

export function emptyQueue(): Queue {
  return { items: {}, focus: null, alert: false }
}

function put(q: Queue, item: Item): Queue {
  return { ...q, items: { ...q.items, [item.id]: item } }
}

function patch(q: Queue, id: string, changes: Partial<Item>): Queue {
  const item = q.items[id]
  return item ? put(q, { ...item, ...changes }) : q
}

/** Missing or non-boolean `urgent` counts as urgent: a false alarm beats a missed one. */
export function ingest(q: Queue, incoming: readonly Incoming[], now: number): Queue {
  for (const inc of incoming) {
    const urgent = inc.urgent !== false
    const id = `${inc.source}:${inc.originId}`
    const prev = q.items[id]
    const fresh: Item = {
      id,
      source: inc.source,
      kind: urgent ? 'urgent' : inc.type,
      title: inc.title,
      summary: inc.summary,
      url: inc.url,
      ...(typeof inc.prUrl === 'string' ? { prUrl: inc.prUrl } : {}),
      reason: inc.reason ?? (inc.urgent === undefined ? 'not classified' : undefined),
      priority: inc.priority,
      importance: [1, 2, 3, 4].includes(inc.importance as number) ? inc.importance : undefined,
      people: Array.isArray(inc.people) ? inc.people.filter((p) => typeof p === 'string').slice(0, 5) : undefined,
      arrivedAt: inc.at || now,
      state: 'new'
    }
    if (!prev) {
      q = put(q, fresh)
    } else if ((prev.state === 'snoozed' || prev.state === 'passed') && !urgent) {
      q = put(q, { ...prev, summary: fresh.summary, title: fresh.title, prUrl: fresh.prUrl ?? prev.prUrl })
    } else {
      const keep = prev.state === 'in_progress' || prev.state === 'delegated'
      q = put(q, {
        ...fresh,
        prUrl: fresh.prUrl ?? prev.prUrl,
        ...(keep && prev.sunkAt ? { sunkAt: prev.sunkAt } : {}),
        arrivedAt: keep ? prev.arrivedAt : fresh.arrivedAt,
        state: keep ? prev.state : 'new',
        delegatedTo: prev.delegatedTo,
        thread: prev.thread,
        seenTs: prev.seenTs
      })
    }
    if (urgent) q = { ...q, alert: true }
  }
  return q
}

export function agentStatus(
  q: Queue,
  ev: { terminalId: string; title?: string; state: AgentState },
  now: number
): Queue {
  const id = `agent:${ev.terminalId}`
  const needsYou = ev.state === 'blocked' || ev.state === 'waiting'
  const delegated = Object.values(q.items).find((i) => i.state === 'delegated' && i.delegatedTo === ev.terminalId)
  if (delegated) {
    return needsYou ? patch(q, delegated.id, { state: 'new', delegatedTo: undefined, summary: `${ev.title ?? 'Agent'} is back to you. ${delegated.summary}` }) : q
  }
  if (!needsYou) {
    if (!q.items[id]) return q
    const { [id]: _gone, ...items } = q.items
    const focus = q.focus?.itemId === id ? null : q.focus
    return { ...q, items, focus }
  }
  if (q.items[id]) return q
  const title = ev.title ?? 'Agent'
  return put(q, {
    id,
    source: 'agent',
    kind: 'agent',
    title,
    summary: ev.state === 'blocked' ? `${title} is blocked and needs your decision.` : `${title} is waiting for your answer.`,
    terminalId: ev.terminalId,
    arrivedAt: now,
    state: 'new'
  })
}

function visible(item: Item, now: number): boolean {
  return item.state === 'new' || (item.state === 'snoozed' && (item.snoozeUntil ?? 0) <= now)
}

/** Items to show, in router order. */
export function rank(q: Queue, now: number): Item[] {
  return Object.values(q.items)
    .filter((i) => visible(i, now))
    .sort(
      (a, b) =>
        (a.sunkAt ?? 0) - (b.sunkAt ?? 0) ||
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
        importance(a) - importance(b) ||
        a.arrivedAt - b.arrivedAt
    )
}

/** Items parked: snoozed (not yet due) and delegated. */
export function parked(q: Queue, now: number): Item[] {
  return Object.values(q.items).filter((i) => i.state === 'delegated' || (i.state === 'snoozed' && !visible(i, now)))
}

function endCurrent(q: Queue): Queue {
  const cur = q.focus?.itemId
  return cur && q.items[cur]?.state === 'in_progress' ? patch(q, cur, { state: 'new' }) : q
}

export function take(q: Queue, id: string, now: number): Queue {
  if (!q.items[id]) return q
  q = endCurrent(q)
  q = patch(q, id, { state: 'in_progress', snoozeUntil: undefined })
  return { ...q, focus: { itemId: id, since: now }, alert: false }
}

function leave(q: Queue, id: string, changes: Partial<Item>): Queue {
  q = patch(q, id, changes)
  return q.focus?.itemId === id ? { ...q, focus: null } : q
}

/** Send an item to the bottom of the queue, below everything not sunk before it. */
export function sink(q: Queue, id: string, now: number): Queue {
  return patch(q, id, { sunkAt: now })
}

export function pass(q: Queue, id: string): Queue {
  return leave(q, id, { state: 'passed' })
}

export function done(q: Queue, id: string): Queue {
  return leave(q, id, { state: 'done' })
}

export function snooze(q: Queue, id: string, until: number): Queue {
  return leave(q, id, { state: 'snoozed', snoozeUntil: until })
}

export function delegate(q: Queue, id: string, terminalId: string): Queue {
  return leave(q, id, { state: 'delegated', delegatedTo: terminalId })
}

/** Park the item while its worktree's agent works; `worktreeStatus` brings it back. */
export function waitOnWorktree(q: Queue, id: string, workspaceId: string, status: string): Queue {
  return leave(q, id, { state: 'delegated', delegatedTo: `ws:${workspaceId}`, waitFrom: status })
}

const needsYou = (status?: string) => status === 'permission' || status === 'done'

/** A worktree status poll: items waiting on it come back when it turns to needing you. */
export function worktreeStatus(q: Queue, workspaceId: string, status: string, now: number): Queue {
  for (const item of Object.values(q.items)) {
    if (item.state !== 'delegated' || item.delegatedTo !== `ws:${workspaceId}` || item.waitFrom === status) continue
    q = needsYou(status) && !needsYou(item.waitFrom)
      ? patch(q, item.id, {
          state: 'new',
          arrivedAt: now,
          delegatedTo: undefined,
          waitFrom: undefined,
          reason: status === 'permission' ? 'The worktree agent needs you.' : 'The worktree agent is done.'
        })
      : patch(q, item.id, { waitFrom: status })
  }
  return q
}

/** Focus the top-ranked item, if any: after putting the current one in the background. */
export function takeNext(q: Queue, now: number): Queue {
  const next = rank(q, now)[0]
  return next ? take(q, next.id, now) : q
}

/** Notes a task of the user's own and makes it the current one. */
export function start(q: Queue, title: string, now: number): Queue {
  const next = applyRequest(q, { op: 'add', from: 'me', title }, now)
  const id = Object.keys(next.items).find((k) => !q.items[k])!
  return take(next, id, now)
}

/** Lunch break or end of the day: shield up, no notifications, until `release`. */
export function relax(q: Queue, now: number): Queue {
  return { ...endCurrent(q), focus: { itemId: null, since: now, relax: true } }
}

export function focusOther(q: Queue, now: number): Queue {
  return { ...endCurrent(q), focus: { itemId: null, since: now } }
}

export function release(q: Queue): Queue {
  return { ...endCurrent(q), focus: null }
}

export function ack(q: Queue): Queue {
  return { ...q, alert: false }
}

/** Drop done items older than a week so storage stays small. */
export function prune(q: Queue, now: number): Queue {
  const week = 7 * 24 * 3600_000
  const items = Object.fromEntries(Object.entries(q.items).filter(([, i]) => (i.state !== 'done' && i.state !== 'passed') || now - i.arrivedAt < week))
  return { ...q, items }
}

export function snoozeUntil(choice: '30m' | '2h' | 'tomorrow', now: number): number {
  if (choice === '30m') return now + 30 * 60_000
  if (choice === '2h') return now + 2 * 3600_000
  const d = new Date(now)
  d.setDate(d.getDate() + 1)
  d.setHours(9, 0, 0, 0)
  return d.getTime()
}

/** Slack items whose threads the worker keeps polling: open ones, and done ones for 3 days. */
export function watchedSlack(q: Queue, now: number): Item[] {
  const window = 3 * 24 * 3600_000
  return Object.values(q.items).filter((i) => i.source === 'slack' && i.state !== 'passed' && (i.state !== 'done' || now - i.arrivedAt < window))
}

/** `delegatedTo` of a Slack item parked until someone answers in its thread. */
export const AWAIT_REPLY = 'slack:reply'

/** Park a Slack item until someone else posts in its thread (`threadUpdate` brings it back). */
export function awaitReply(q: Queue, id: string): Queue {
  return leave(q, id, { state: 'delegated', delegatedTo: AWAIT_REPLY })
}

/** Stores the latest thread messages. A new message from someone else reopens a done item, or one
 *  parked awaiting their reply. */
export function threadUpdate(q: Queue, id: string, msgs: readonly Msg[], now: number): Queue {
  const item = q.items[id]
  if (!item || !msgs.length) return q
  const newest = msgs[msgs.length - 1].ts
  const fresh = item.seenTs ? msgs.some((m) => !m.mine && Number(m.ts) > Number(item.seenTs)) : false
  const changes: Partial<Item> = { thread: msgs.slice(-5), seenTs: newest }
  if (fresh && item.state === 'done') Object.assign(changes, { state: 'new', arrivedAt: now })
  if (fresh && item.delegatedTo === AWAIT_REPLY) Object.assign(changes, { state: 'new', arrivedAt: now, delegatedTo: undefined, reason: 'They replied in the thread.' })
  return patch(q, id, changes)
}

/** A request another agent dropped in `~/.orca-helpdesk/requests/` through the DreamDesk MCP server. */
export type Request =
  | { op: 'add'; title: string; summary?: string; url?: string; prUrl?: string; importance?: number; urgent?: boolean; from?: 'me' | 'agent'; actions?: string[]; terminalId?: string }
  | { op: 'done' | 'pass'; id: string }
  | { op: 'snooze'; id: string; minutes: number }
  | { op: 'set_pr'; id: string; prUrl: string }

const str = (v: unknown, max = 2000) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined)
const prLink = (v: unknown) => (typeof v === 'string' && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(v) ? v : undefined)

/** At most 3 distinct short answers. */
const answers = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.map((a) => str(a, 40)).filter((a): a is string => !!a))].slice(0, 3) : []

/** Applies one request. Anything malformed or naming an unknown item throws, so the worker logs it. */
export function applyRequest(q: Queue, raw: unknown, now: number): Queue {
  const r = (raw ?? {}) as Record<string, unknown>
  if (r.op === 'add') {
    const title = str(r.title, 200)
    if (!title) throw new Error('add: title required')
    const urgent = r.urgent === true
    const me = r.from === 'me'
    const id = `${me ? 'me' : 'agent:mcp'}:${now.toString(36)}:${Math.random().toString(36).slice(2, 6)}`
    const q2 = put(q, {
      id,
      source: me ? 'me' : 'agent',
      kind: urgent ? 'urgent' : 'mention',
      title,
      summary: str(r.summary) ?? '',
      ...(str(r.url) ? { url: str(r.url) } : {}),
      ...(prLink(r.prUrl) ? { prUrl: prLink(r.prUrl) } : {}),
      ...([1, 2, 3, 4].includes(r.importance as number) ? { importance: r.importance as number } : {}),
      // Suggested answers need the asking agent's terminal to be typed into.
      ...(!me && typeof r.terminalId === 'string' && /^term_[\w-]+$/.test(r.terminalId) && answers(r.actions).length
        ? { terminalId: r.terminalId, actions: answers(r.actions) }
        : {}),
      reason: me ? 'Noted by you' : 'Added by an agent',
      arrivedAt: now,
      state: 'new'
    })
    return urgent ? { ...q2, alert: true } : q2
  }
  const id = str(r.id)
  if (!id || !q.items[id]) throw new Error(`${String(r.op)}: unknown item ${String(r.id)}`)
  switch (r.op) {
    case 'done': return done(q, id)
    case 'pass': return pass(q, id)
    case 'snooze': {
      const minutes = Number(r.minutes)
      if (!(minutes > 0)) throw new Error('snooze: minutes must be positive')
      return snooze(q, id, now + Math.min(minutes, 7 * 24 * 60) * 60_000)
    }
    case 'set_pr': {
      const prUrl = prLink(r.prUrl)
      if (!prUrl) throw new Error('set_pr: prUrl must be a github.com pull request URL')
      return patch(q, id, { prUrl })
    }
    default: throw new Error(`unknown op ${String(r.op)}`)
  }
}

/** What `gh pr view --json state,author,reviews` says, flattened. */
export interface PrInfo {
  state: string
  author: string
  /** Logins of submitted reviews (pending drafts excluded). */
  reviewers: string[]
}

/** A PR item is handled once the PR is merged or closed or, unless it is the user's own PR,
 *  once anyone but its author has reviewed it. */
export function prSettled(pr: PrInfo, me: string): boolean {
  if (pr.state === 'MERGED' || pr.state === 'CLOSED') return true
  return pr.author !== me && pr.reviewers.some((r) => r !== pr.author)
}

/** CI of a PR from gh's `statusCheckRollup` (check runs have status/conclusion, commit statuses
 *  have state): failing beats running beats passed; no checks → undefined. */
export type CiState = 'running' | 'failing' | 'passed'
export function ciState(checks: readonly { status?: string; conclusion?: string; state?: string }[]): CiState | undefined {
  if (!checks.length) return undefined
  const bad = ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']
  if (checks.some((c) => bad.includes(c.conclusion ?? '') || bad.includes(c.state ?? ''))) return 'failing'
  if (checks.some((c) => (c.status && c.status !== 'COMPLETED') || c.state === 'PENDING' || c.state === 'EXPECTED')) return 'running'
  return 'passed'
}

/** What a row's border says: red needs you, orange blinking an agent works, orange waits on
 *  CI or a review, white is yours to act on, none is idle (info only, snoozed). */
export type Status = 'need' | 'working' | 'waiting' | 'actionable' | 'idle'

type PrStatus = { ci?: CiState; awaitingReview: boolean }

/** Why an item needs the user, in a few words; undefined when it does not. */
export function needReason(item: Item, worktree?: string, pr?: PrStatus): string | undefined {
  if (item.kind === 'urgent') return 'urgent'
  if (item.kind === 'agent') return 'agent waiting for you'
  if (item.source === 'agent') return 'agent asks you'
  if (worktree === 'permission') return 'worktree agent waiting for you'
  if (pr?.ci === 'failing') return 'CI failing'
  return undefined
}

export function status(item: Item, worktree?: string, pr?: PrStatus): Status {
  if (needReason(item, worktree, pr)) return 'need'
  if (worktree === 'working') return 'working'
  if (pr?.ci === 'running' || pr?.awaitingReview || item.state === 'delegated') return 'waiting'
  if (importance(item) === 4 || item.state === 'snoozed') return 'idle'
  return 'actionable'
}

// Slack ids and links. Pure, so the panel can import them (it cannot load node: modules).

/** Collector origin ids are `<channel>:<thread ts>`. */
export function parseOrigin(itemId: string): { channel: string; ts: string } | null {
  const m = /^slack:([A-Z0-9]+):(\d+\.\d+)$/.exec(itemId)
  return m ? { channel: m[1], ts: m[2] } : null
}

/** Link that opens the thread root in Slack, e.g. https://acme.slack.com/archives/C1/p1700000000000100 */
export function threadLink(workspaceUrl: string, itemId: string): string | null {
  const origin = parseOrigin(itemId)
  if (!origin) return null
  return `${workspaceUrl.replace(/\/?$/, '/')}archives/${origin.channel}/p${origin.ts.replace('.', '')}`
}

/** What to ask `orca reference find` for: the Linear issue key when there is one, else the item URL. */
export function referenceQuery(item: Item): string | null {
  const key = item.source === 'linear' ? /^[A-Z][A-Z0-9]*-\d+$/.exec(item.id.slice('linear:'.length))?.[0] : undefined
  return key ?? (item.url && item.source !== 'slack' ? item.url : null)
}
