// Wires the pure queue (src/queue.ts) to Orca: agent events, the collector's inbox files,
// storage, the status bar and notifications.
import type { OrcaWorkerApi } from 'orca/worker'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as Q from './queue'
import type { AgentRow, View, Worktree } from './protocol'
import * as Slack from './slack'
import { todaysMeetings, withAuthUser } from './calendar'

// Tests point HELPDESK_INBOX at a temp dir; everything else in ~/.orca-helpdesk follows it.
export const INBOX = process.env.HELPDESK_INBOX ?? join(homedir(), '.orca-helpdesk', 'inbox')
export const HOME = dirname(INBOX)
/** The MCP server (mcp/server.mjs) reads the queue here and drops requests in REQUESTS. */
export const SNAPSHOT = join(HOME, 'queue.json')
export const REQUESTS = join(HOME, 'requests')
const KEY = 'queue'
// Avatars must be files inside the plugin folder: panels cannot load URLs. Gitignored.
const AVATARS = fileURLToPath(new URL('../avatars/', import.meta.url))
const MEDIA = fileURLToPath(new URL('../media/', import.meta.url))
const ORCA_CLI = process.env.ORCA_CLI_BIN_DIR ? join(process.env.ORCA_CLI_BIN_DIR, 'orca') : '/Applications/Orca.app/Contents/Resources/bin/orca'
const run = promisify(execFile)
const COLLECTOR_PROMPT = fileURLToPath(new URL('../collector/prompt.md', import.meta.url))

/** The `teamChannels` setting: one channel per line, its Slack id then a label (`C0123ABCD #team`). */
export function parseChannels(text: string): { id: string; name: string }[] {
  return text
    .split('\n')
    .map((line) => /^\s*([CGD][A-Z0-9]{6,})\s*(.*?)\s*$/.exec(line))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ id: m[1]!, name: m[2] || m[1]! }))
}

/** Reads every finished `*.json` in `dir`. Broken files are deleted and reported; the caller
 *  deletes the good ones (`files`) only once their entries are safely stored. */
export function readInbox(dir: string, log: (m: string) => void = () => {}): { entries: Q.Incoming[]; files: string[] } {
  mkdirSync(dir, { recursive: true })
  const out: Q.Incoming[] = []
  const files: string[] = []
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    const file = join(dir, name)
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'))
      const list = Array.isArray(data) ? data : []
      out.push(...list.filter((x) => x && typeof x.originId === 'string' && (x.source === 'slack' || x.source === 'linear')))
      if (!Array.isArray(data)) log(`inbox: ${name} is not an array, dropped`)
      files.push(file)
    } catch (err) {
      log(`inbox: ${name} unreadable, dropped (${String(err)})`)
      rmSync(file, { force: true })
    }
  }
  return { entries: out, files }
}

export function viewOf(q: Q.Queue, now: number, extra: Partial<View> = {}): View {
  const id = q.focus?.itemId
  return {
    focus: q.focus,
    current: id ? (q.items[id] ?? null) : null,
    next: Q.rank(q, now),
    parked: Q.parked(q, now),
    alert: q.alert,
    slack: false,
    ...extra
  }
}

export default function activate(orca: OrcaWorkerApi): void {
  let q: Q.Queue = Q.emptyQueue()
  let blink = false
  let CHANNELS: { id: string; name: string }[] = []
  let PERMACONF = ''

  /** Reads settings; also writes what the collector agent needs to ~/.orca-helpdesk/config.json. */
  async function loadSettings(): Promise<void> {
    const s = await orca.settings.get().catch(() => ({}) as Record<string, unknown>)
    CHANNELS = parseChannels(String(s.teamChannels ?? ''))
    PERMACONF = String(s.permaconfUrl ?? '').trim()
    const incidentChannels = String(s.incidentChannels ?? '').split(',').map((c) => c.trim()).filter(Boolean)
    try {
      mkdirSync(HOME, { recursive: true })
      writeFileSync(join(HOME, 'config.json'), JSON.stringify({ incidentChannels }, null, 2))
    } catch (err) {
      orca.log(`settings: ${String(err)}`)
    }
  }
  orca.settings.onDidChange(() => void loadSettings().then(pollChannel).then(() => orca.panels.post('queue.changed', view())))

  let slack: { token: string; me: string; url: string; who: ReturnType<typeof Slack.people> } | null = null
  const channelMsgs: Record<string, Q.Msg[]> = {}
  /** Threads opened as tabs, persisted; their messages are kept in `channelMsgs` by tab id. */
  let pinned: { channel: string; ts: string; title: string }[] = []
  /** The workspace focused in Orca, from `workspace.changed`. */
  let focusedWs: { workspaceId?: string; displayName: string } | null = null
  let dms: { channel: string; name: string }[] = []
  const tabId = (t: { channel: string; ts: string }) => `${t.channel}:${t.ts}`
  /** Collector names (Linear people) → avatar file, filled from the Slack directory. */
  const avatarByName: Record<string, string> = {}
  let findUser: ((name: string) => string | null) | null = null
  const slackErrors = new Set<string>()
  let worktrees: Record<string, Worktree> = {}
  // Calendar: the feed is fetched every 10 min; today's meetings are recomputed every minute.
  let calendar: { url: string; ics: string; fetchedAt: number } | null = null
  const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone

  async function fetchCalendar(url: string): Promise<string> {
    const res = await fetch(url)
    const text = await res.text()
    if (!res.ok || !text.startsWith('BEGIN:VCALENDAR')) throw Object.assign(new Error(`not an iCal feed (HTTP ${res.status})`), { code: 'invalid_params' })
    return text
  }

  async function pollCalendar(): Promise<void> {
    // Read the saved address lazily, so a failed first read (e.g. during a reload) retries next minute.
    if (!calendar) {
      const url = await orca.secrets.get('calendarUrl').catch(() => null)
      if (!url) return
      calendar = { url, ics: '', fetchedAt: 0 }
    }
    if (Date.now() - calendar.fetchedAt < 10 * 60_000) return
    try {
      calendar = { ...calendar, ics: await fetchCalendar(calendar.url), fetchedAt: Date.now() }
    } catch (err) {
      orca.log(`calendar: ${String(err)}`)
      calendar = { ...calendar, fetchedAt: Date.now() }
    }
  }

  function meetings(now: number): View['meetings'] {
    if (!calendar?.ics) return []
    // The feed URL names the calendar owner, which lets us skip invites they declined.
    const me = decodeURIComponent(/\/ical\/([^/]+)\//.exec(calendar.url)?.[1] ?? '')
    return todaysMeetings(calendar.ics, now, TZ, me || undefined).map((m) => ({
      ...m,
      ...(m.url ? { url: withAuthUser(m.url, me) } : {}),
      status: m.end <= now ? 'past' : m.start <= now ? 'now' : 'upcoming'
    }))
  }
  const refErrors = new Set<string>()

  /** The worktree's agents say more than its workspace status: blocked/waiting → needs you. */
  async function agentState(workspaceId: string, fallback = 'inactive'): Promise<string> {
    try {
      const { agents } = await orca.host.call('agents.list', { workspaceId })
      const states = agents.map((a) => a.state)
      if (states.some((s) => s === 'blocked' || s === 'waiting')) return 'permission'
      if (states.includes('working')) return 'working'
      if (states.includes('done')) return 'done'
    } catch {
      // Fall back to the workspace status.
    }
    return fallback
  }

  /** Links open items to Orca worktrees. ponytail: one CLI call per item per minute; a host
   *  API for references would replace it if Orca adds one. */
  async function pollWorktrees(): Promise<void> {
    const found: Record<string, Worktree> = {}
    let status: Record<string, string> = {}
    try {
      const { workspaces } = await orca.host.call('workspace.list', { includeStatus: true })
      status = Object.fromEntries(workspaces.map((w) => [w.id, w.status?.state ?? 'inactive']))
    } catch (err) {
      orca.log(`worktrees: status ${String(err)}`)
    }
    const open = Object.values(q.items).filter((i) => i.state !== 'done' && i.state !== 'passed')
    for (const item of open) {
      const query = Q.referenceQuery(item)
      if (!query) continue
      try {
        const { stdout } = await run(ORCA_CLI, ['reference', 'find', query, '--json'], { timeout: 10_000 })
        const ws = JSON.parse(stdout).result?.matches?.find((m: any) => !m.workspace?.archived)?.workspace
        if (ws) found[item.id] = { id: ws.id, name: ws.name, state: await agentState(ws.id, status[ws.id]) }
      } catch (err) {
        // Log each failing query once, not every minute.
        if (!refErrors.has(query)) orca.log(`worktrees: ${query} ${String(err).slice(0, 200)}`)
        refErrors.add(query)
      }
    }
    worktrees = found
    let next = q
    for (const wt of Object.values(found)) next = Q.worktreeStatus(next, wt.id, wt.state, Date.now())
    if (next !== q) await commit(next)
    else orca.panels.post('queue.changed', view())
  }

  const view = () =>
    viewOf(
      q,
      Date.now(),
      {
        worktrees,
        calendar: !!calendar,
        ...(here() ? { here: here() } : {}),
        ...(q.focus?.itemId && prs[q.focus.itemId]?.ci ? { ci: { state: prs[q.focus.itemId]!.ci!, url: `${prs[q.focus.itemId]!.url}/checks` } } : {}),
        needs: Object.fromEntries(
          Object.values(q.items)
            .filter((i) => i.state !== 'done' && i.state !== 'passed')
            .map((i) => [i.id, Q.needReason(i, worktrees[i.id]?.state, prs[i.id])])
            .filter(([, why]) => why)
        ),
        status: Object.fromEntries(
          Object.values(q.items)
            .filter((i) => i.state !== 'done' && i.state !== 'passed')
            .map((i) => [i.id, Q.status(i, worktrees[i.id]?.state, prs[i.id])])
        ),
        ...(PERMACONF ? { permaconf: PERMACONF } : {}),
        nowAt: Date.now(),
        meetings: meetings(Date.now()),
        ...(slack
        ? {
            slack: true,
            slackUrl: slack.url,
            channels: [
              ...CHANNELS.map((c) => ({ ...c, channel: c.id, url: `${slack!.url}archives/${c.id}`, messages: channelMsgs[c.id] ?? [] })),
              ...pinned.map((t) => ({
                id: tabId(t),
                name: t.title,
                channel: t.channel,
                ts: t.ts,
                url: `${slack!.url}archives/${t.channel}/p${t.ts.replace('.', '')}`,
                messages: channelMsgs[tabId(t)] ?? []
              })),
              ...dms.map((d) => ({ id: d.channel, name: `@${d.name}`, channel: d.channel, dm: true, url: `${slack!.url}archives/${d.channel}`, messages: channelMsgs[d.channel] ?? [] }))
            ],
            avatars: avatarByName
          }
        : {})
      }
    )

  async function pollChannel(): Promise<void> {
    if (!slack) return
    for (const c of [...CHANNELS, ...dms.map((d) => ({ id: d.channel, name: d.name }))]) {
      try {
        channelMsgs[c.id] = await Slack.downloadThumbs(slack.token, await Slack.readChannel(slack.token, slack.me, c.id, slack.who), MEDIA)
      } catch (err) {
        orca.log(`slack: ${c.name} ${String(err)}`)
      }
    }
    for (const t of pinned) await pollPinned(t)
    await resolvePeople()
    orca.panels.post('queue.changed', view())
  }

  async function pollPinned(t: { channel: string; ts: string }): Promise<void> {
    if (!slack) return
    try {
      channelMsgs[tabId(t)] = await Slack.downloadThumbs(slack.token, await Slack.readThread(slack.token, slack.me, t, slack.who, fetch, 50), MEDIA)
    } catch (err) {
      orca.log(`slack: thread ${tabId(t)} ${String(err)}`)
    }
  }

  async function resolvePeople(): Promise<void> {
    if (!slack) return
    const names = new Set(Object.values(q.items).flatMap((i) => i.people ?? []))
    const missing = [...names].filter((n) => !(n in avatarByName))
    if (!missing.length) return
    try {
      findUser ??= (await Slack.directory(slack.token)).find
    } catch (err) {
      orca.log(`slack: directory ${String(err)}`)
      return
    }
    for (const name of missing) {
      const id = findUser(name)
      const avatar = id ? (await slack.who(id)).avatar : undefined
      if (avatar) avatarByName[name] = avatar
    }
  }

  async function connectSlack(token: string): Promise<void> {
    const auth = await Slack.call(token, 'auth.test', {})
    slack = { token, me: auth.user_id, url: auth.url, who: Slack.people(token, AVATARS) }
    orca.log(`slack: connected as ${auth.user}`)
    void Slack.directory(token)
      .then(async (d) => {
        findUser = d.find
        const added = await Slack.prefetchAvatars(d.users, AVATARS)
        if (added) orca.log(`slack: ${added} new avatars, shown after the next plugin load`)
      })
      .catch((e) => orca.log(`slack: directory ${String(e)}`))
  }

  async function pollThreads(): Promise<void> {
    if (!slack) return
    const updates: [string, Q.Msg[]][] = []
    for (const item of Q.watchedSlack(q, Date.now())) {
      const origin = Slack.parseOrigin(item.id)
      if (!origin) continue
      try {
        updates.push([item.id, await Slack.readThread(slack.token, slack.me, origin, slack.who)])
      } catch (err) {
        // Log each failing thread once, not every minute.
        if (!slackErrors.has(item.id)) orca.log(`slack: ${item.id} ${String(err)}`)
        slackErrors.add(item.id)
      }
    }
    // Fold into the queue as it is now: the panel may have acted while we were fetching.
    let next = q
    for (const [id, msgs] of updates) next = Q.threadUpdate(next, id, msgs, Date.now())
    if (next !== q) await commit(next)
  }
  const ready = (async () => {
    await loadSettings()
    const stored = (await orca.storage.get(KEY)) as Q.Queue | null
    if (stored && stored.items) q = stored
    const threads = (await orca.storage.get('pinnedThreads')) as typeof pinned | null
    if (Array.isArray(threads)) pinned = threads
    const dmTabs = (await orca.storage.get('dmTabs')) as typeof dms | null
    if (Array.isArray(dmTabs)) dms = dmTabs
  })()

  async function commit(next: Q.Queue, pierced: Q.Item[] = []): Promise<View> {
    // Round-trip through JSON: storage refuses `undefined` fields.
    q = JSON.parse(JSON.stringify(Q.prune(next, Date.now())))
    writeSnapshot()
    await orca.storage.set(KEY, q as never)
    const v = view()
    orca.panels.post('queue.changed', v)
    await statusBar(v)
    for (const item of pierced) {
      await orca.host.call('notifications.show', { title: `Urgent: ${item.title}`, body: item.summary }).catch(() => {})
    }
    return v
  }

  async function statusBar(view: View): Promise<void> {
    const n = view.next.length
    const mode = view.focus ? 'Focus' : 'Free'
    await orca.host
      .call('statusBar.update', {
        id: 'helpdesk',
        text: view.alert ? `● ${n}` : `${mode} · ${n}`,
        tone: view.alert ? (blink ? 'danger' : 'neutral') : 'neutral',
        tooltip: view.alert ? 'Urgent — click to mark as seen' : `DreamDesk: ${n} to handle`
      })
      .catch(() => {})
  }

  // gh lives in Homebrew, which an app-launched worker's PATH may not include.
  const gh = (args: string[], cwd?: string) =>
    run('gh', args, { timeout: 15_000, cwd, env: { ...process.env, PATH: `${process.env.PATH ?? ''}:/opt/homebrew/bin:/usr/local/bin` } })
  let ghLogin = ''

  /** GitHub state of each open item's PR (its PR link, else its worktree's branch): CI and review. */
  let prs: Record<string, { url: string; ci?: Q.CiState; awaitingReview: boolean }> = {}

  /** One gh call per open item with a PR link or a worktree. Closes PR items once merged, closed or
   *  reviewed (`Q.prSettled`). ponytail: N calls a minute; batch through GraphQL if that gets slow. */
  async function pollGithub(): Promise<void> {
    const open = Object.values(q.items).filter((i) => i.state !== 'done' && i.state !== 'passed' && (i.prUrl || worktrees[i.id]))
    if (!open.length) return void (prs = {})
    try {
      ghLogin ||= (await gh(['api', 'user', '--jq', '.login'])).stdout.trim()
    } catch (err) {
      if (!refErrors.has('gh')) orca.log(`prs: gh unavailable ${String(err).slice(0, 200)}`)
      refErrors.add('gh')
      return
    }
    const found: typeof prs = {}
    const settled: string[] = []
    for (const item of open) {
      const dir = worktrees[item.id]?.id.split('::')[1]
      try {
        const args = ['pr', 'view', ...(item.prUrl ? [item.prUrl] : []), '--json', 'url,state,author,reviews,statusCheckRollup']
        const pr = JSON.parse((await gh(args, item.prUrl ? undefined : dir)).stdout)
        const info: Q.PrInfo = {
          state: pr.state,
          author: pr.author?.login ?? '',
          reviewers: (pr.reviews ?? []).filter((r: any) => r.state !== 'PENDING').map((r: any) => r.author?.login ?? '')
        }
        if (item.prUrl && Q.prSettled(info, ghLogin)) settled.push(item.id)
        found[item.id] = {
          url: pr.url,
          ...(Q.ciState(pr.statusCheckRollup ?? []) ? { ci: Q.ciState(pr.statusCheckRollup ?? []) } : {}),
          awaitingReview: info.state === 'OPEN' && info.author === ghLogin && !info.reviewers.some((r) => r !== ghLogin)
        }
      } catch (err) {
        // A worktree branch without a PR is normal; only log failing PR links, once.
        if (item.prUrl && !refErrors.has(item.prUrl)) orca.log(`prs: ${item.prUrl} ${String(err).slice(0, 200)}`)
        if (item.prUrl) refErrors.add(item.prUrl)
      }
    }
    prs = found
    // Applied to the queue as it is now: the user may have acted during the gh calls.
    if (settled.length) await commit(settled.reduce((acc, id) => Q.done(acc, id), q))
    else orca.panels.post('queue.changed', view())
  }

  /** What the MCP server shows other agents: open items, with their linked worktree. */
  function writeSnapshot(): void {
    try {
      const now = Date.now()
      const row = (i: Q.Item) => ({
        id: i.id, title: i.title, summary: i.summary, source: i.source, state: i.state, importance: Q.importance(i),
        ...(i.url ? { url: i.url } : {}), ...(i.prUrl ? { prUrl: i.prUrl } : {}),
        ...(worktrees[i.id] ? { worktree: worktrees[i.id]!.name } : {})
      })
      const id = q.focus?.itemId
      const snap = { at: now, current: id && q.items[id] ? row(q.items[id]!) : null, queue: Q.rank(q, now).map(row), parked: Q.parked(q, now).map(row) }
      mkdirSync(HOME, { recursive: true })
      writeFileSync(`${SNAPSHOT}.tmp`, JSON.stringify(snap, null, 2))
      renameSync(`${SNAPSHOT}.tmp`, SNAPSHOT)
    } catch (err) {
      orca.log(`snapshot: ${String(err)}`)
    }
  }

  /** Applies the MCP server's request files in order, then deletes them (the server waits for that). */
  let applying = Promise.resolve()
  const applyRequests = () =>
    (applying = applying.then(async () => {
      await ready
      mkdirSync(REQUESTS, { recursive: true })
      const files = readdirSync(REQUESTS).filter((n) => n.endsWith('.json')).sort()
      if (!files.length) return
      let next = q
      for (const name of files) {
        try {
          next = Q.applyRequest(next, JSON.parse(readFileSync(join(REQUESTS, name), 'utf8')), Date.now())
        } catch (err) {
          orca.log(`requests: ${name} ${String(err).slice(0, 200)}`)
          writeFileSync(join(REQUESTS, `${name}.error`), String(err))
        }
        rmSync(join(REQUESTS, name), { force: true })
      }
      await commit(next)
    }).catch((err) => orca.log(`requests: ${String(err)}`)))
  try {
    mkdirSync(REQUESTS, { recursive: true })
    const watcher = watch(REQUESTS, () => void applyRequests())
    deactivateHooks.push(() => watcher.close())
  } catch (err) {
    orca.log(`requests: watch ${String(err)}`)
  }

  async function ingestInbox(): Promise<void> {
    await ready
    const { entries: incoming, files } = readInbox(INBOX, (m) => orca.log(m))
    if (incoming.length) orca.log(`inbox: ${incoming.length} entries from ${INBOX}`)
    const before = q
    const next = Q.ingest(q, incoming, Date.now())
    const pierced = Object.values(next.items).filter(
      (i) => i.kind === 'urgent' && i.state === 'new' && before.items[i.id]?.state !== 'new'
    )
    // Re-commit even when empty so due snoozes reappear.
    await commit(next, pierced)
    for (const f of files) rmSync(f, { force: true })
  }

  async function seedAgents(): Promise<void> {
    const rows = await allAgents(true)
    orca.log(`start: ${rows.length} agents need you`)
    for (const row of rows) {
      q = Q.agentStatus(q, { terminalId: row.terminalId, title: row.title, state: row.state }, Date.now())
    }
  }

  async function allAgents(onlyNeedsYou = false): Promise<(AgentRow & { state: Q.AgentState })[]> {
    const rows: (AgentRow & { state: Q.AgentState })[] = []
    try {
      const { workspaces } = await orca.host.call('workspace.list', { includeStatus: true })
      for (const ws of workspaces) {
        if (!ws.status?.terminalCount) continue
        if (onlyNeedsYou && ws.status.state !== 'permission' && ws.status.state !== 'done') continue
        const { agents } = await orca.host.call('agents.list', { workspaceId: ws.id }).catch(() => ({ agents: [] }))
        for (const a of agents) {
          if (!a.terminalId) continue
          if (onlyNeedsYou && a.state !== 'blocked' && a.state !== 'waiting') continue
          rows.push({ terminalId: a.terminalId, title: a.title ?? a.agent ?? 'agent', workspace: ws.name, state: a.state })
        }
      }
    } catch (err) {
      orca.log(`agents: listing failed (${String(err)})`)
    }
    return rows
  }

  orca.events.on('workspace.changed', ({ context }) => {
    focusedWs = context
    orca.panels.post('queue.changed', view())
  })
  /** The open item whose linked worktree is focused in Orca, unless it is the current one. Matched by
   *  name too: the event gives an `identity:` id, not the `repo::path` id that workspace.list gives. */
  function here(): string | undefined {
    if (!focusedWs) return undefined
    const id = Object.entries(worktrees).find(([, w]) => w.id === focusedWs!.workspaceId || w.name === focusedWs!.displayName)?.[0]
    return id && id !== q.focus?.itemId ? id : undefined
  }

  orca.events.on('agent.status.changed', async (ev) => {
    await ready
    if (!ev.terminalId) return
    await commit(Q.agentStatus(q, { terminalId: ev.terminalId, title: ev.title, state: ev.state }, Date.now()))
  })

  orca.panels.handle('queue.get', async () => {
    await ready
    return view()
  })

  orca.panels.handle('slack.connect', async ({ token }) => {
    await connectSlack(token.trim())
    await orca.secrets.set('slackToken', token.trim())
    await pollThreads()
    return view()
  })

  orca.panels.handle('slack.reply', async ({ id, text }) => {
    await ready
    const origin = Slack.parseOrigin(id)
    if (!slack || !origin || !text.trim()) throw Object.assign(new Error('cannot reply'), { code: 'invalid_params' })
    await Slack.reply(slack.token, origin, text.trim())
    await pollThreads()
    return view()
  })

  orca.panels.handle('slack.thread', async ({ channel, ts }) => {
    if (!slack || !CHANNELS.some((c) => c.id === channel)) throw Object.assign(new Error('unknown channel'), { code: 'invalid_params' })
    const msgs = await Slack.downloadThumbs(slack.token, await Slack.readThread(slack.token, slack.me, { channel, ts }, slack.who, fetch, 100), MEDIA)
    return msgs.filter((m) => m.ts !== ts)
  })

  const teamChannel = (channel: string) => CHANNELS.some((c) => c.id === channel) || dms.some((d) => d.channel === channel)

  orca.commands.register('helpdesk.setupCollector', async () => {
    const prompt = readFileSync(COLLECTOR_PROMPT, 'utf8')
    const existing = await orca.host.call('automation.list', {}).catch(() => ({ automations: [] as { name: string }[] }))
    if ((existing as { automations: { name: string }[] }).automations.some((a) => a.name === 'DreamDesk collector')) {
      return 'The DreamDesk collector automation already exists (see Automations).'
    }
    await orca.host.call('automation.create', {
      name: 'DreamDesk collector',
      prompt,
      agent: 'claude',
      schedule: '*/30 * * * *',
      timezone: TZ,
      enabled: true,
      creationKey: 'dreamdesk-collector'
    })
    return 'Created the DreamDesk collector: Claude reads Slack and Linear every 30 minutes.'
  })

  orca.panels.handle('calendar.connect', async ({ url }) => {
    const clean = url.trim()
    if (!/^https:\/\/calendar\.google\.com\/calendar\/ical\//.test(clean) && !/^https:\/\/.+\.ics(\?.*)?$/.test(clean)) {
      throw Object.assign(new Error('expected an https iCal (.ics) address'), { code: 'invalid_params' })
    }
    calendar = { url: clean, ics: await fetchCalendar(clean), fetchedAt: Date.now() }
    await orca.secrets.set('calendarUrl', clean)
    return view()
  })

  orca.panels.handle('worktree.open', async ({ id }) => {
    const known = Object.values(worktrees).some((w) => w.id === id)
    if (!known) return { ok: false }
    await orca.host.call('workspace.open', { workspaceId: id })
    return { ok: true }
  })

  orca.panels.handle('thread.open', async ({ channel, ts, title }) => {
    if (!slack || !teamChannel(channel)) throw Object.assign(new Error('unknown channel'), { code: 'invalid_params' })
    if (!pinned.some((t) => t.channel === channel && t.ts === ts)) {
      pinned = [...pinned, { channel, ts, title: title.slice(0, 24) || 'Thread' }]
      await orca.storage.set('pinnedThreads', pinned as never)
    }
    await pollPinned({ channel, ts })
    return view()
  })

  orca.panels.handle('thread.close', async ({ id }) => {
    pinned = pinned.filter((t) => tabId(t) !== id)
    dms = dms.filter((d) => d.channel !== id)
    delete channelMsgs[id]
    await orca.storage.set('pinnedThreads', pinned as never)
    await orca.storage.set('dmTabs', dms as never)
    return view()
  })

  // ponytail: the person is found by name (exact, else a unique first name); pass the Slack user
  // id from messages if two people ever share a name.
  orca.panels.handle('dm.open', async ({ name }) => {
    if (!slack) throw Object.assign(new Error('Slack is not connected'), { code: 'invalid_params' })
    findUser ??= (await Slack.directory(slack.token)).find
    const user = findUser(name)
    if (!user) throw Object.assign(new Error(`No Slack user named ${name}`), { code: 'invalid_params' })
    const opened = await Slack.call(slack.token, 'conversations.open', { users: user }).catch((err) => {
      throw /missing_scope/.test(String(err)) ? new Error('Add the im:write scope to your Slack app, reinstall it and reconnect Slack') : err
    })
    const channel = opened.channel.id as string
    if (!dms.some((d) => d.channel === channel)) {
      dms = [...dms, { channel, name: name.split(/\s+/)[0]! }]
      await orca.storage.set('dmTabs', dms as never)
    }
    try {
      channelMsgs[channel] = await Slack.downloadThumbs(slack.token, await Slack.readChannel(slack.token, slack.me, channel, slack.who), MEDIA)
    } catch (err) {
      orca.log(`slack: dm ${channel} ${String(err)}`)
    }
    return { view: view(), id: channel }
  })

  orca.panels.handle('slack.post', async ({ channel, text, ts }) => {
    // Only the channels shown in the panel: the panel must not be able to post anywhere else.
    if (!slack || !text.trim() || !teamChannel(channel)) {
      throw Object.assign(new Error('cannot post'), { code: 'invalid_params' })
    }
    if (ts) {
      await Slack.reply(slack.token, { channel, ts }, text.trim())
      await pollPinned({ channel, ts })
      return view()
    }
    await Slack.post(slack.token, channel, text.trim())
    await pollChannel()
    return view()
  })

  orca.panels.handle('queue.act', async ({ action, id, choice, terminalId }) => {
    await ready
    const now = Date.now()
    const need = (v: string | undefined, name: string): string => {
      if (!v) throw Object.assign(new Error(`${name} required`), { code: 'invalid_params' })
      return v
    }
    switch (action) {
      case 'take': return commit(Q.take(q, need(id, 'id'), now))
      case 'done': return commit(Q.done(q, need(id, 'id')))
      case 'pass': return commit(Q.pass(q, need(id, 'id')))
      case 'sink': return commit(Q.sink(q, need(id, 'id'), now))
      case 'wait': {
        const wt = worktrees[need(id, 'id')]
        if (!wt) throw Object.assign(new Error('no linked worktree'), { code: 'invalid_params' })
        // Fresh state: the minute-old one may still say "done" from before the user's last prompt.
        const state = await agentState(wt.id, wt.state)
        return commit(Q.takeNext(Q.waitOnWorktree(q, id!, wt.id, state), now))
      }
      case 'snooze': return commit(Q.snooze(q, need(id, 'id'), Q.snoozeUntil(choice ?? '30m', now)))
      case 'delegate': return commit(Q.takeNext(Q.delegate(q, need(id, 'id'), need(terminalId, 'terminalId')), now))
      case 'other': return commit(Q.focusOther(q, now))
      case 'release': return commit(Q.release(q))
      case 'ack': return commit(Q.ack(q))
    }
  })

  orca.panels.handle('agents.all', async () => (await allAgents()).map(({ state: _s, ...row }) => row))

  orca.panels.handle('item.open', async ({ id }) => {
    await ready
    const terminalId = q.items[id]?.terminalId ?? q.items[id]?.delegatedTo
    if (!terminalId) return { ok: false }
    const { focused } = await orca.host.call('terminal.focus', { terminalId })
    return { ok: focused }
  })

  orca.commands.register('helpdesk.ack', async () => {
    await ready
    await commit(Q.ack(q))
    return 'Alert seen'
  })

  // The status bar item keeps this worker alive, so plain timers are enough.
  const tick = setInterval(
    () => void applyRequests().then(ingestInbox).then(pollThreads).then(pollChannel).then(pollWorktrees).then(pollGithub).then(pollCalendar).catch((e) => orca.log(`tick: ${String(e)}`)),
    60_000
  )
  let rowBlink = false
  const blinker = setInterval(() => {
    if (Object.values(worktrees).some((w) => w.state === 'working')) orca.panels.post('blink', (rowBlink = !rowBlink))
    if (!q.alert) return
    blink = !blink
    void statusBar(view())
  }, 1000)
  deactivateHooks.push(() => {
    clearInterval(tick)
    clearInterval(blinker)
  })

  orca.log(`start: inbox ${INBOX}`)
  const slackReady = orca.secrets
    .get('slackToken')
    .then((t) => (t ? connectSlack(t) : undefined))
    .catch((e) => orca.log(`slack: ${String(e)}`))
  void ready
    .then(seedAgents)
    .then(ingestInbox)
    .then(() => slackReady)
    .then(pollThreads)
    .then(pollChannel)
    .then(pollWorktrees)
    .then(pollCalendar)
    .then(() => orca.panels.post('queue.changed', view()))
    .catch((e) => orca.log(`start: ${String(e)}`))
}

const deactivateHooks: (() => void)[] = []
export function deactivate(): void {
  for (const h of deactivateHooks.splice(0)) h()
}
