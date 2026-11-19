// The helpdesk panel: shield (focus) / router (free) over the worker's queue, as cards.
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Collapsible,
  EmptyState,
  Heading,
  IconButton,
  Image,
  Input,
  Link,
  plugin,
  read,
  RelativeTime,
  Row,
  Progress,
  Select,
  Spinner,
  set,
  update,
  shell,
  Stack,
  Tab,
  Tabs,
  Text,
  Textarea,
  type PanelContext
} from 'orca'
import type { Action, AgentRow, View } from './protocol'
import { importance, threadLink, type Item, type Msg } from './queue'
import { segments } from './calendar'

const view = atom<View | null>(null)
const agents = atom<AgentRow[]>([])
const draft = atom('')
const channelDraft = atom('')
const sending = atom(false)
const sendError = atom<string | null>(null)
const tokenDraft = atom('')

const LOGO: Record<Item['source'], string> = { agent: 'assets/agent-mark.png', slack: 'assets/slack-mark.png', linear: 'assets/linear-mark.png' }
const SOURCE: Record<Item['source'], string> = { agent: 'Agent', slack: 'Slack', linear: 'Linear' }

// ---- actions -------------------------------------------------------------

async function act(action: Action, extra: { id?: string; choice?: '30m' | '2h' | 'tomorrow'; terminalId?: string } = {}) {
  set(view, await plugin.request('queue.act', { action, ...extra }))
}

async function take(item: Item) {
  await act('take', { id: item.id })
  if (item.source === 'agent') await plugin.request('item.open', { id: item.id })
}

/** Runs a Slack write, keeping the busy flag and the error line in step. */
async function slackWrite(run: () => Promise<View>, clear: () => void) {
  set(sending, true)
  set(sendError, null)
  try {
    set(view, await run())
    clear()
  } catch (err) {
    set(sendError, String((err as Error).message ?? err))
  } finally {
    set(sending, false)
  }
}

const reply = (id: string, text: string) =>
  text.trim() ? slackWrite(() => plugin.request('slack.reply', { id, text }), () => set(draft, '')) : undefined


export function setup(ctx: PanelContext): void {
  const show = (v: View) => {
    set(view, v)
    markSeen(v)
  }
  ctx.subscriptions.push(plugin.on('queue.changed', show))
  void plugin.request('queue.get').then(show)
  void plugin.request('agents.all').then((a) => set(agents, a)).catch(() => {})
}

// ---- small pieces --------------------------------------------------------

function initials(name: string): string {
  return name.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?'
}

/** A small image: Image's smallest size is ~48px, so a fixed Box sets the real size. */
function Icon({ src, alt, px = 16, round = false }: { src: string; alt: string; px?: number; round?: boolean }) {
  return (
    <Box width={px} height={px} radius={round ? 'full' : 'none'} shrink={false}>
      <Image src={src} alt={alt} size="full" fit={round ? 'cover' : 'contain'} rounded={round} />
    </Box>
  )
}

/** Clicking someone's avatar opens a direct conversation with them in the TEAM section. */
function Avatar({ name, src, px = 20 }: { name: string; src?: string; px?: number }) {
  return src ? <Icon src={src} alt={name} px={px} round /> : <Badge>{initials(name)}</Badge>
}

/** A person's name; clicking it opens a direct conversation in the TEAM section. Not the avatar:
 *  Orca refuses an image inside a Link or Button ("a layout Orca cannot show"). */
function Who({ name, mine = false }: { name: string; mine?: boolean }) {
  return mine || !read(view)?.slack ? <Text size="xs" weight="semibold" tone={mine ? 'accent' : undefined}>{name}</Text> : <Link onPress={() => openDm(name)}>{name}</Link>
}

async function openDm(name: string) {
  try {
    const { view: v, id } = await plugin.request('dm.open', { name })
    set(view, v)
    set(channelTab, id)
    set(sendError, null)
  } catch (err) {
    set(sendError, err instanceof Error ? err.message : String(err))
  }
}

/** People involved: Slack thread authors, then the names the collector gave, with avatars when known. */
function involved(item: Item, max = 4): [string, string | undefined][] {
  const avatars = read(view)?.avatars ?? {}
  const seen = new Map<string, string | undefined>()
  for (const m of item.thread ?? []) if (!m.mine && !seen.has(m.who)) seen.set(m.who, m.avatar)
  for (const name of item.people ?? []) if (!seen.has(name)) seen.set(name, avatars[name])
  return [...seen].slice(0, max)
}

function People({ item, names = true, max = 4 }: { item: Item; names?: boolean; max?: number }) {
  const list = involved(item, max)
  if (!list.length) return null
  return (
    <Row gap="xs" align="center">
      {list.map(([name, src]) => <Avatar name={name} src={src} />)}
      {names ? list.map(([name]) => <Who name={name} />) : null}
    </Row>
  )
}

function Message({ m, px = 24 }: { m: Msg; px?: number }) {
  return (
    <Row gap="sm" align="start">
      <Avatar name={m.who} src={m.avatar} px={px} />
      <Stack gap="none">
        <Row gap="xs" align="center">
          <Who name={m.who} mine={m.mine} />
          <Text size="xs" muted><RelativeTime at={Number(m.ts) * 1000} /></Text>
        </Row>
        {m.text ? <Text size="sm">{m.text}</Text> : null}
        {m.files?.length ? (
          <Stack gap="xs">
            {m.files.map((f) =>
              f.thumb ? (
                // Images: small thumbnail; the larger preview unfolds on click (panels have no hover).
                <Row gap="xs" align="start">
                  <Icon src={f.thumb} alt={f.name} px={32} />
                  <Box grow minWidth={0}>
                    <Collapsible title={f.name.length > 32 ? `${f.name.slice(0, 29)}…` : f.name}>
                      <Stack gap="xs">
                        {f.preview ? <Image src={f.preview} alt={f.name} size="full" fit="contain" /> : null}
                        <Link onPress={() => shell.openExternal(f.url)}>Open in Slack</Link>
                      </Stack>
                    </Collapsible>
                  </Box>
                </Row>
              ) : (
                <Row>
                  <Button size="sm" variant="outline" icon={f.image ? 'file' : 'download'} tooltip={`Open ${f.name} in Slack`} onPress={() => shell.openExternal(f.url)}>
                    {f.name.length > 28 ? `${f.name.slice(0, 25)}…` : f.name}
                  </Button>
                </Row>
              )
            )}
          </Stack>
        ) : null}
      </Stack>
    </Row>
  )
}

/** Thread replies by root ts; loaded the first time the thread is opened. */
const threads = atom<Record<string, Msg[] | 'loading' | 'error'>>({})

async function openThread(channel: string, ts: string) {
  update(threads, (t) => ({ ...t, [ts]: 'loading' }))
  const replies = await plugin.request('slack.thread', { channel, ts }).catch(() => 'error' as const)
  update(threads, (t) => ({ ...t, [ts]: replies }))
}

/** A channel message with its replies folded underneath, Reddit style. */
function ChannelMessage({ channel, m }: { channel: string; m: Msg }) {
  const replies = read(threads)[m.ts]
  return (
    <Stack gap="xs">
      <Message m={m} />
      {m.replies ? (
        <Box direction="row" align="start" gap="xs" paddingX="lg">
          <Box grow minWidth={0}>
            <Collapsible
              title={`${m.replies} ${m.replies === 1 ? 'reply' : 'replies'}`}
              onChange={(open) => {
                if (open && (replies === undefined || replies === 'error')) void openThread(channel, m.ts)
              }}
            >
              <Box direction="column" gap="sm" padding="sm" radius="md" background="muted">
                {replies === 'loading' || replies === undefined ? <Text size="xs" muted>Loading…</Text> : null}
                {replies === 'error' ? <Text size="xs" tone="danger">Could not load the thread.</Text> : null}
                {Array.isArray(replies) ? replies.map((r) => <Message m={r} px={20} />) : null}
              </Box>
            </Collapsible>
          </Box>
          <IconButton icon="layers" label="Open thread in a tab" tooltip="Open thread in a tab" size="sm" variant="ghost" onPress={() => openThreadTab(channel, m)} />
        </Box>
      ) : null}
    </Stack>
  )
}

const WT_STATE: Record<string, { label: string; tone: 'accent' | 'warning' | 'success' | 'neutral' }> = {
  working: { label: 'agent working', tone: 'accent' },
  permission: { label: 'needs you', tone: 'warning' },
  done: { label: 'agent done', tone: 'success' },
  active: { label: 'open', tone: 'neutral' },
  inactive: { label: 'idle', tone: 'neutral' }
}

/** The Orca worktree linked to an item, with its agent state; pressing it opens the worktree. */
function WorktreeChip({ item, compact = false }: { item: Item; compact?: boolean }) {
  const wt = read(view)?.worktrees?.[item.id]
  if (!wt) return null
  const st = WT_STATE[wt.state] ?? { label: wt.state, tone: 'neutral' as const }
  const open = () => plugin.request('worktree.open', { id: wt.id })
  const tip = `Open worktree ${wt.name} (${st.label})`
  // Panels cannot animate; Orca's Spinner is the one moving thing, so it marks an agent at work.
  const busy = wt.state === 'working' ? <Spinner label="Agent working" labelHidden /> : null
  return compact ? (
    <Row gap="none" align="center">
      {busy}
      <IconButton icon="branch" label={tip} tooltip={tip} size="sm" variant="ghost" tone={st.tone} onPress={open} />
    </Row>
  ) : (
    <Row gap="xs" align="center">
      {busy}
      <Button size="sm" variant="ghost" tone={st.tone} icon="branch" tooltip={tip} onPress={open}>
        {`${wt.name} · ${st.label}`}
      </Button>
    </Row>
  )
}

/** P1/P2 stand out, P3 stays quiet, P4 (info only) is muted. */
function Priority({ item }: { item: Item }) {
  if (item.kind === 'urgent' || item.kind === 'agent') return null
  const p = importance(item)
  if (p === 3) return null
  return <Badge tone={p === 1 ? 'danger' : p === 2 ? 'warning' : 'neutral'}>{p === 4 ? 'FYI' : `P${p}`}</Badge>
}

/** The one item that matters now (in progress, or next up): a highlighted card. */
function Hero({ item, label, since, children }: { item: Item; label: string; since?: number; children?: unknown }) {
  const urgent = item.kind === 'urgent'
  return (
    <Box border={urgent ? 'danger' : 'accent'} radius="lg" padding="md" background="card" direction="column" gap="sm">
      <Row justify="between" align="center">
        <Row gap="xs" align="center">
          <Icon src={LOGO[item.source]} alt={SOURCE[item.source]} />
          <Text size="xs" weight="semibold" tone={urgent ? 'danger' : 'accent'}>{label}</Text>
          <Text size="xs" muted>
            · <RelativeTime at={since ?? item.arrivedAt} format="short" />
          </Text>
        </Row>
        <Row gap="xs" align="center">
          {urgent ? <Badge tone="danger">Urgent</Badge> : <Priority item={item} />}
        </Row>
      </Row>
      <Stack gap="xs">
        <Text size="md" weight="semibold">{item.title}</Text>
        {item.summary ? <Text size="sm" muted>{item.summary}</Text> : null}
      </Stack>
      <Row gap="sm" align="center" wrap>
        <People item={item} />
        <WorktreeChip item={item} />
      </Row>
      {item.reason ? <Text size="xs" muted>{item.reason}</Text> : null}
      {children}
    </Box>
  )
}

/** A queued item as one compact row. */
function QueueRow({ item, badge }: { item: Item; badge?: string }) {
  return (
    <Box direction="row" align="center" gap="sm" paddingX="sm" paddingY="xs" radius="md" border={item.kind === 'urgent' ? 'danger' : true}>
      <Icon src={LOGO[item.source]} alt={SOURCE[item.source]} />
      <Box direction="column" grow minWidth={0}>
        <Text size="sm" weight="medium" truncate>{item.title}</Text>
        <Text size="xs" muted truncate>{item.summary}</Text>
      </Box>
      <People item={item} names={false} max={2} />
      {badge ? <Badge>{badge}</Badge> : <Priority item={item} />}
      <WorktreeChip item={item} compact />
      <IconButton icon="close" label={`Dismiss ${item.title}`} tooltip="Dismiss: not relevant to me" size="sm" variant="ghost" onPress={() => act('pass', { id: item.id })} />
      <IconButton icon="play" label={`Take ${item.title}`} tooltip="Take" size="sm" tone="accent" onPress={() => take(item)} />
    </Box>
  )
}

// ---- sections ------------------------------------------------------------

function Thread({ item }: { item: Item }) {
  const busy = read(sending)
  const error = read(sendError)
  const base = read(view)?.slackUrl
  const link = base ? threadLink(base, item.id) : item.url
  return (
    <Stack gap="sm">
      <Row justify="between" align="center">
        <Text size="xs" weight="semibold">Thread</Text>
        {link ? <Link onPress={() => shell.openExternal(link)}>Open thread in Slack</Link> : null}
      </Row>
      {(item.thread ?? []).map((m) => <Message m={m} />)}
      <Textarea
        label="Reply in thread"
        placeholder="Your reply, posted as you…"
        rows={2}
        value={read(draft)}
        onChange={(t) => set(draft, t)}
        onSubmit={(t) => reply(item.id, t)}
      />
      <Row gap="xs" wrap>
        <Button variant="solid" tone="accent" icon="upload" disabled={busy || !read(draft).trim()} onPress={() => reply(item.id, read(draft))}>Send</Button>
        <Button variant="outline" tone="success" disabled={busy} onPress={() => reply(item.id, 'On it 👀')}>👀 On it</Button>
        <Button variant="outline" tone="warning" disabled={busy} onPress={() => set(draft, 'Could you share a bit more context? ')}>Need more info</Button>
      </Row>
      {error ? <Text size="xs" tone="danger">{error}</Text> : null}
    </Stack>
  )
}

/** Snooze and delegate share one menu: `snooze:<choice>` or `delegate:<terminalId>`. */
function MoreMenu({ item }: { item: Item }) {
  const options = [
    { value: 'snooze:30m', label: 'Snooze 30 min' },
    { value: 'snooze:2h', label: 'Snooze 2 h' },
    { value: 'snooze:tomorrow', label: 'Snooze until tomorrow 9am' },
    ...(item.source !== 'agent' ? read(agents).map((a) => ({ value: `delegate:${a.terminalId}`, label: `Delegate to ${a.title} — ${a.workspace}` })) : [])
  ]
  return (
    <Select
      label="Later or delegate"
      labelHidden
      placeholder="Later…"
      options={options}
      onChange={(value) => {
        const [kind, arg] = [value.slice(0, value.indexOf(':')), value.slice(value.indexOf(':') + 1)]
        if (kind === 'snooze') void act('snooze', { id: item.id, choice: arg as '30m' | '2h' | 'tomorrow' })
        else void act('delegate', { id: item.id, terminalId: arg })
      }}
    />
  )
}

const CI = {
  running: { label: 'Waiting for CI', tone: 'warning', icon: 'refresh' },
  failing: { label: 'CI failing', tone: 'danger', icon: 'error' },
  passed: { label: 'CI passed', tone: 'success', icon: 'check' }
} as const

/** The current item's PR checks; opens them on GitHub. */
function CiBadge({ ci }: { ci: NonNullable<View['ci']> }) {
  const c = CI[ci.state]
  return <Button size="sm" variant="ghost" tone={c.tone} icon={c.icon} tooltip="Open the checks on GitHub" onPress={() => shell.openExternal(ci.url)}>{c.label}</Button>
}

function Current({ item, since }: { item: Item; since: number }) {
  const v = read(view)
  const hasWorktree = !!v?.worktrees?.[item.id]
  return (
    <Hero item={item} label="NOW" since={since}>
      {item.source === 'slack' && v?.slack ? <Thread item={item} /> : null}
      <Row gap="xs" align="center" justify="between" wrap>
        <Row gap="xs" align="center">
          <Button variant="solid" tone="success" icon="check" onPress={() => act('done', { id: item.id })}>Done</Button>
          {item.prUrl ? (
            <Button variant="outline" icon="code" tooltip={`Open ${item.prUrl.replace('https://github.com/', '')} on GitHub`} onPress={() => shell.openExternal(item.prUrl!)}>Open PR</Button>
          ) : null}
          {v?.ci ? <CiBadge ci={v.ci} /> : null}
          {hasWorktree ? (
            <Button variant="outline" tone="accent" icon="branch" tooltip="Back to the queue once the worktree agent finishes or needs you; opens the next item now" onPress={() => act('wait', { id: item.id })}>Background</Button>
          ) : null}
        </Row>
        <Row gap="xs" align="center">
          {item.url && item.source !== 'slack' ? <IconButton icon="open-external" label="Open" tooltip="Open" size="sm" variant="ghost" onPress={() => shell.openExternal(item.url!)} /> : null}
          {item.terminalId ? <IconButton icon="terminal" label="Open terminal" tooltip="Open terminal" size="sm" variant="ghost" onPress={() => plugin.request('item.open', { id: item.id })} /> : null}
          <IconButton icon="pause" label="Back to queue" tooltip="Back to queue" size="sm" variant="ghost" onPress={() => act('release')} />
          <IconButton icon="close" label="Dismiss" tooltip="Dismiss: not relevant to me" size="sm" variant="ghost" onPress={() => act('pass', { id: item.id })} />
          <MoreMenu item={item} />
        </Row>
      </Row>
    </Hero>
  )
}

const calendarDraft = atom('')
const hhmm = (t: number) => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(t)

/** Today's meetings as a horizontal timeline, with the current or next one and its Join button below. */
function Meetings({ v }: { v: View }) {
  if (!v.calendar) {
    return (
      <Collapsible title="Connect calendar" description="Google Calendar → Settings → Integrate calendar → Secret address in iCal format">
        <Row gap="xs" align="end">
          <Box grow>
            <Input label="Calendar iCal address" labelHidden type="password" placeholder="https://calendar.google.com/calendar/ical/…/private-…/basic.ics" value={read(calendarDraft)} onChange={(t) => set(calendarDraft, t)} />
          </Box>
          <Button
            variant="solid"
            tone="accent"
            disabled={!read(calendarDraft).trim()}
            onPress={() => slackWrite(() => plugin.request('calendar.connect', { url: read(calendarDraft) }), () => set(calendarDraft, ''))}
          >
            Connect
          </Button>
        </Row>
        {read(sendError) ? <Text size="xs" tone="danger">{read(sendError)}</Text> : null}
      </Collapsible>
    )
  }
  const all = v.meetings ?? []
  const now = v.nowAt ?? 0
  const done = all.filter((m) => m.status === 'past').length
  const left = all.filter((m) => m.status !== 'past')
  // Day window: 9h–19h, widened to whole hours around any meeting outside it.
  const day = new Date(now)
  const at = (h: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), h).getTime()
  const from = Math.min(at(9), ...all.map((m) => at(new Date(m.start).getHours())))
  const to = Math.max(at(19), ...all.map((m) => at(Math.ceil((m.end - at(0)) / 3600_000))))
  // Box only takes whole percentages ("55.5%" is ignored), so round: ~6 min precision on 10 h.
  const whole = (n: number) => `${Math.max(0, Math.round(n))}%` as const
  const hours = Array.from({ length: Math.floor((to - from) / 7200_000) }, (_, k) => new Date(from + k * 7200_000).getHours())
  // Under the bar: the current meeting and the next one; once the day is over, the last one.
  const current = all.find((m) => m.status === 'now')
  const next = all.find((m) => m.status === 'upcoming')
  const lines = [current, next].filter((m): m is NonNullable<typeof m> => !!m)
  if (!lines.length && all.length) lines.push(all[all.length - 1]!)
  return (
    <Stack gap="xs">
      <Row justify="between" align="center">
        <Text size="xs" weight="semibold" muted>TODAY</Text>
        <Row gap="xs" align="center">
          <Text size="xs" muted>{all.length ? `${done} done · ${left.length} left` : 'No meetings today'}</Text>
          {v.permaconf ? (
            <Button size="xs" variant="ghost" tone="accent" icon="play" tooltip="Join the permaconf" onPress={() => shell.openExternal(v.permaconf!)}>Permaconf</Button>
          ) : null}
        </Row>
      </Row>
      {/* One bar for the day, made of native progress bars (the only fill that shows in every
          theme): free stretches and meetings, each filled by how much of it has passed. */}
      {/* Hover targets: only buttons get tooltips in Orca, so each meeting gets a marker above its slot. */}
      <Box direction="row" align="end" height={22}>
        {segments(all, from, to, now).map((seg) => (
          <Box width={whole(seg.width)} shrink={false} direction="row" justify="center">
            {seg.meeting ? (
              <IconButton
                icon="calendar"
                size="sm"
                variant="ghost"
                tone={seg.meeting.status === 'now' ? 'accent' : 'neutral'}
                label={`${hhmm(seg.meeting.start)}–${hhmm(seg.meeting.end)} · ${seg.meeting.title}`}
                tooltip={`${hhmm(seg.meeting.start)}–${hhmm(seg.meeting.end)} · ${seg.meeting.title}${seg.meeting.url ? ' (click to open the meet)' : ''}`}
                disabled={!seg.meeting.url}
                onPress={() => shell.openExternal(seg.meeting!.url!)}
              />
            ) : null}
          </Box>
        ))}
      </Box>
      <Box direction="row" align="center">
        {segments(all, from, to, now).map((seg) => (
          <Box width={whole(seg.width)} shrink={false} paddingX={seg.meeting ? 'xs' : 'none'}>
            <Progress label={seg.meeting ? seg.meeting.title : 'Free time'} labelHidden value={Math.round(seg.elapsed * 100)} />
          </Box>
        ))}
      </Box>
      <Box direction="row">
        {hours.map((h) => (
          <Box width={whole((7200_000 / (to - from)) * 100)} shrink={false}>
            <Text size="xs" muted>{`${h}h`}</Text>
          </Box>
        ))}
      </Box>
      {lines.map((m) => (
        <Row gap="xs" align="center" justify="between">
          <Text size="xs" truncate>
            <Text size="xs" weight="semibold" tone={m.status === 'now' ? 'accent' : m.status === 'upcoming' ? 'warning' : undefined}>
              {m.status === 'now' ? 'Now' : m.status === 'past' ? 'Last' : 'Next'}
            </Text>
            {` ${hhmm(m.start)}–${hhmm(m.end)} · ${m.title}`}
          </Text>
          {m.url ? (
            <Button size="sm" variant={m.status === 'now' ? 'solid' : 'outline'} tone="accent" icon="play" onPress={() => shell.openExternal(m.url!)}>Join</Button>
          ) : null}
        </Row>
      ))}
    </Stack>
  )
}

const channelTab = atom('channelTab', '', { persist: 'plugin' })
/** Newest message ts from someone else that was on screen, per tab. Drives the unread dot. */
const seen = atom<Record<string, string>>('seenTabs', {}, { persist: 'plugin' })

type TeamTab = NonNullable<View['channels']>[number]

const latest = (t: TeamTab) => t.messages.filter((m) => !m.mine).reduce((max, m) => (Number(m.ts) > Number(max) ? m.ts : max), '0')
const unread = (t: TeamTab) => Number(latest(t)) > Number(read(seen)[t.id] ?? '0')

function currentTab(tabs: TeamTab[]): TeamTab | undefined {
  return tabs.find((t) => t.id === read(channelTab)) ?? tabs[0]
}

/** The visible tab counts as read; a tab seen for the first time starts read, not all-unread. */
function markSeen(v: View) {
  const tabs = v.channels ?? []
  const cur = currentTab(tabs)
  update(seen, (s) => {
    const next = { ...s }
    for (const t of tabs) if (next[t.id] === undefined || t.id === cur?.id) next[t.id] = latest(t)
    return next
  })
}

const postTo = (t: TeamTab, text: string) =>
  text.trim()
    ? slackWrite(() => plugin.request('slack.post', { channel: t.channel, text, ...(t.ts ? { ts: t.ts } : {}) }), () => set(channelDraft, ''))
    : undefined

async function openThreadTab(channel: string, m: Msg) {
  const v = await plugin.request('thread.open', { channel, ts: m.ts, title: `🧵 ${m.who}: ${m.text}` })
  set(view, v)
  set(channelTab, `${channel}:${m.ts}`)
  markSeen(v)
}

async function closeThreadTab(id: string) {
  set(channelTab, '')
  set(view, await plugin.request('thread.close', { id }))
}

function Channels({ tabs }: { tabs: TeamTab[] }) {
  const busy = read(sending)
  const current = currentTab(tabs)!
  return (
    <Stack gap="xs">
      <Row justify="between" align="center">
        <Text size="xs" weight="semibold" muted>TEAM</Text>
        <Row gap="xs" align="center">
          {current.ts || current.dm ? <IconButton icon="close" label="Close tab" tooltip="Close this tab" size="sm" variant="ghost" onPress={() => closeThreadTab(current.id)} /> : null}
          <IconButton icon="open-external" label="Open in Slack" tooltip="Open in Slack" size="sm" variant="ghost" onPress={() => shell.openExternal(current.url)} />
        </Row>
      </Row>
      {read(sendError) ? <Text size="xs" tone="danger">{read(sendError)}</Text> : null}
      <Tabs
        label="Team channels"
        value={current.id}
        onChange={(id) => {
          set(channelTab, id)
          const v = read(view)
          if (v) markSeen(v)
        }}
      >
        {tabs.map((t) => (
          <Tab value={t.id} label={unread(t) && t.id !== current.id ? `● ${t.name}` : t.name}>
            <Stack gap="sm">
              <Box direction="column" gap="sm" maxHeight={240} scroll="y">
                {t.ts ? (
                  // Thread: root first, then replies newest first.
                  [t.messages[0], ...t.messages.slice(1).reverse()].filter(Boolean).map((m) => <Message m={m!} />)
                ) : (
                  // Channel: newest first, since the list cannot start scrolled to the bottom.
                  [...t.messages].reverse().map((m) => <ChannelMessage channel={t.channel} m={m} />)
                )}
              </Box>
              <Row gap="xs" align="end">
                <Box grow>
                  <Input
                    label={`Message ${t.name}`}
                    labelHidden
                    placeholder={t.ts ? 'Reply in thread' : `Message ${t.name}`}
                    value={read(channelDraft)}
                    onChange={(x) => set(channelDraft, x)}
                    onSubmit={(x) => postTo(t, x)}
                  />
                </Box>
                <Button variant="solid" tone="accent" icon="upload" disabled={busy || !read(channelDraft).trim()} onPress={() => postTo(t, read(channelDraft))}>Send</Button>
              </Row>
            </Stack>
          </Tab>
        ))}
      </Tabs>
    </Stack>
  )
}

// ---- panel ---------------------------------------------------------------

export default function Panel() {
  const v = read(view)
  if (!v) return <Text muted>Loading…</Text>
  const [first, ...rest] = v.next
  const urgent = v.next.find((i) => i.kind === 'urgent')
  const queued = v.focus ? v.next : rest
  return (
    // Queue scrolls; the team chat stays pinned at the bottom.
    <Box direction="column" height="100%" gap="md">
      <Box direction="column" gap="md" grow minHeight={0} scroll="y">
        <Row justify="between" align="center">
          <Heading>DreamDesk</Heading>
          <Row gap="xs">
            <Badge>{`${v.next.length} to handle`}</Badge>
            <Badge tone={v.focus ? 'accent' : 'success'}>{v.focus ? 'Focus' : 'Free'}</Badge>
          </Row>
        </Row>

        {v.alert ? (
          <Callout tone="danger" icon="error" title={`● Urgent${urgent ? `: ${urgent.title}` : ''}`}>
            <Row gap="xs">
              {urgent ? <Button variant="solid" tone="danger" onPress={() => take(urgent)}>Take</Button> : null}
              <Button variant="ghost" onPress={() => act('ack')}>Seen</Button>
            </Row>
          </Callout>
        ) : null}

        {v.current && v.focus ? <Current item={v.current} since={v.focus.since} /> : null}

        {v.focus && !v.current ? (
          <Box border radius="md" padding="sm" justify="between" align="center">
            <Text muted>
              On something else since <RelativeTime at={v.focus.since} />
            </Text>
            <Button onPress={() => act('release')}>Done with it</Button>
          </Box>
        ) : null}

        {!v.focus ? (
          <Stack gap="sm">
            {first ? (
              <Hero item={first} label="NEXT UP">
                <Row gap="xs">
                  <Button variant="solid" tone={first.kind === 'urgent' ? 'danger' : 'accent'} icon="play" onPress={() => take(first)}>Take it</Button>
                  <Button variant="ghost" icon="close" tooltip="Not relevant to me" onPress={() => act('pass', { id: first.id })}>Dismiss</Button>
                </Row>
              </Hero>
            ) : (
              <EmptyState title="Nothing to handle" description="Shield is down, enjoy." icon="check" />
            )}
            <Button variant="ghost" icon="pause" onPress={() => act('other')}>Working on something else</Button>
          </Stack>
        ) : null}

        {queued.length ? (
          <Stack gap="sm">
            <Text size="xs" weight="semibold" muted>{v.focus ? 'QUEUED (SHIELD UP)' : 'UP NEXT'}</Text>
            {queued.map((i) => <QueueRow item={i} />)}
          </Stack>
        ) : null}

        {v.parked.length ? (
          <Collapsible title={`Parked (${v.parked.length})`}>
            <Stack gap="sm">
              {v.parked.map((i) => <QueueRow item={i} badge={i.delegatedTo?.startsWith('ws:') ? 'Waiting on worktree' : i.state === 'delegated' ? 'Delegated' : 'Snoozed'} />)}
            </Stack>
          </Collapsible>
        ) : null}


        {!v.slack ? (
          <Collapsible title="Connect Slack" description="To read threads and reply as you">
            <Row gap="xs">
              <Input label="Slack user token" labelHidden type="password" placeholder="xoxp-…" value={read(tokenDraft)} onChange={(t) => set(tokenDraft, t)} />
              <Button onPress={async () => { set(view, await plugin.request('slack.connect', { token: read(tokenDraft) })); set(tokenDraft, '') }}>Connect</Button>
            </Row>
          </Collapsible>
        ) : null}
      </Box>
      <Box direction="column" shrink={false} gap="md">
        <Meetings v={v} />
        {v.channels?.length ? (
          <Channels tabs={v.channels} />
        ) : v.slack ? (
          <Text size="xs" muted>Add team channels in Orca Settings → DreamDesk → Team channels.</Text>
        ) : null}
      </Box>
    </Box>
  )
}
