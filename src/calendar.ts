// Today's meetings from an iCal feed (Google Calendar's secret address). Pure: no I/O.
// ponytail: handles what Google emits for meetings: DAILY/WEEKLY recurrences (INTERVAL, BYDAY,
// UNTIL, COUNT), EXDATE, moved or cancelled occurrences (RECURRENCE-ID), declined invites.
// MONTHLY/YEARLY rules and all-day events are skipped; add them if they ever matter.

export interface Meeting {
  title: string
  start: number
  end: number
  url?: string
}

type Props = Record<string, { value: string; params: Record<string, string> }>

/** Unfolds lines and splits VEVENT blocks into property maps (first value wins, EXDATE joined). */
function events(ics: string): Props[] {
  const lines = ics.replace(/\r?\n[ \t]/g, '').split(/\r?\n/)
  const out: Props[] = []
  let cur: Props | null = null
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') cur = {}
    else if (line === 'END:VEVENT') {
      if (cur) out.push(cur)
      cur = null
    } else if (cur) {
      const colon = line.indexOf(':')
      if (colon < 0) continue
      const [name, ...rawParams] = line.slice(0, colon).split(';')
      const params = Object.fromEntries(rawParams.map((p) => p.split('=') as [string, string]))
      const value = line.slice(colon + 1)
      if (name === 'EXDATE' || name === 'ATTENDEE') {
        const prev = cur[name]
        cur[name] = { value: prev ? `${prev.value}\n${value}` : value, params: name === 'ATTENDEE' ? {} : params }
        if (name === 'ATTENDEE' && params.PARTSTAT === 'DECLINED') cur.DECLINED_BY = { value: `${cur.DECLINED_BY?.value ?? ''}\n${value}`, params: {} }
      } else if (!cur[name!]) cur[name!] = { value, params }
    }
  }
  return out
}

/** Epoch ms of a wall-clock time in `tz` (two-pass offset fix, fine outside the DST gap hour). */
export function zoned(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi)
  const offset = (t: number) => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
        .formatToParts(t)
        .map((p) => [p.type, p.value])
    )
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute) - t
  }
  const first = guess - offset(guess)
  return guess - offset(first)
}

interface Stamp {
  y: number
  mo: number
  d: number
  h: number
  mi: number
  tz: string
  allDay: boolean
}

function stamp(p: { value: string; params: Record<string, string> } | undefined, fallbackTz: string): Stamp | null {
  if (!p) return null
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})\d{2}(Z)?)?$/.exec(p.value.trim())
  if (!m) return null
  const tz = m[6] ? 'UTC' : (p.params.TZID ?? fallbackTz)
  return { y: +m[1], mo: +m[2], d: +m[3], h: +(m[4] ?? 0), mi: +(m[5] ?? 0), tz, allDay: !m[4] }
}

const epoch = (s: Stamp) => zoned(s.y, s.mo, s.d, s.h, s.mi, s.tz)

/** Calendar date (y, m, d) of an instant in `tz`, as a day number for date arithmetic. */
function dayIn(t: number, tz: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(t).map((x) => [x.type, x.value])
  )
  return Date.UTC(+p.year, +p.month - 1, +p.day) / 86_400_000
}

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

/** Does the recurrence rule produce an occurrence on day number `day` (in the event's zone)? */
function occursOn(rule: string, start: Stamp, day: number, exdays: Set<number>): boolean {
  const r = Object.fromEntries(rule.split(';').map((kv) => kv.split('=') as [string, string]))
  const first = Date.UTC(start.y, start.mo - 1, start.d) / 86_400_000
  if (day < first || exdays.has(day)) return false
  if (r.UNTIL) {
    const u = stamp({ value: r.UNTIL, params: {} }, start.tz)
    if (u && day > dayIn(epoch(u), start.tz)) return false
  }
  const interval = Number(r.INTERVAL ?? 1)
  const byDay = r.BYDAY ? r.BYDAY.split(',').map((d) => d.slice(-2)) : null
  const weekday = (n: number) => DAYS[new Date(n * 86_400_000).getUTCDay()]!
  const hits = (n: number): boolean => {
    if (r.FREQ === 'DAILY') return (n - first) % interval === 0 && (!byDay || byDay.includes(weekday(n)))
    if (r.FREQ === 'WEEKLY') {
      // Weeks counted from the Monday of the first week.
      const monday = (x: number) => x - ((new Date(x * 86_400_000).getUTCDay() + 6) % 7)
      const week = Math.round((monday(n) - monday(first)) / 7)
      return week % interval === 0 && (byDay ?? [weekday(first)]).includes(weekday(n))
    }
    return false
  }
  if (!hits(day)) return false
  if (r.COUNT) {
    let count = 0
    for (let n = first; n <= day; n++) if (hits(n)) count++
    if (count > Number(r.COUNT)) return false
  }
  return true
}

/** Meetings on the local day containing `now`, sorted by start. `me` skips invites you declined. */
export function todaysMeetings(ics: string, now: number, tz: string, me?: string): Meeting[] {
  const today = dayIn(now, tz)
  const all = events(ics)
  // Moved or cancelled single occurrences, keyed by UID + original day.
  const overridden = new Set<string>()
  for (const e of all) {
    const rid = stamp(e['RECURRENCE-ID'], tz)
    if (rid && e.UID) overridden.add(`${e.UID.value}|${dayIn(epoch(rid), rid.tz)}`)
  }
  const out: Meeting[] = []
  for (const e of all) {
    const start = stamp(e.DTSTART, tz)
    if (!start || start.allDay || e.STATUS?.value === 'CANCELLED') continue
    if (me && e.DECLINED_BY?.value.toLowerCase().includes(me.toLowerCase())) continue
    const end = stamp(e.DTEND, tz)
    const duration = end ? epoch(end) - epoch(start) : 30 * 60_000
    let begin: number | null = null
    if (e.RRULE && !e['RECURRENCE-ID']) {
      const exdays = new Set(
        (e.EXDATE?.value ?? '')
          .split(/[\n,]/)
          .map((v) => stamp({ value: v, params: e.EXDATE?.params ?? {} }, start.tz))
          .filter((s): s is Stamp => !!s)
          .map((s) => dayIn(epoch(s), start.tz))
      )
      const day = dayIn(now, start.tz)
      if (occursOn(e.RRULE.value, start, day, exdays) && !overridden.has(`${e.UID?.value}|${day}`)) {
        const d = new Date(day * 86_400_000)
        begin = zoned(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), start.h, start.mi, start.tz)
      }
    } else if (dayIn(epoch(start), tz) === today) {
      begin = epoch(start)
    }
    if (begin === null || dayIn(begin, tz) !== today) continue
    out.push({ title: unescape(e.SUMMARY?.value ?? '(no title)'), start: begin, end: begin + duration, ...link(e) })
  }
  return out.sort((a, b) => a.start - b.start)
}

function unescape(s: string): string {
  return s.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1')
}

/** Video link: Google Meet / Zoom / Teams, from the conference field, URL or description. */
function link(e: Props): { url?: string } {
  const text = [e['X-GOOGLE-CONFERENCE']?.value, e.URL?.value, e.LOCATION?.value, e.DESCRIPTION?.value].filter(Boolean).join(' ')
  const m = /https:\/\/(?:meet\.google\.com|[\w.-]*zoom\.us|teams\.microsoft\.com)\/[^\s"<>\\]+/.exec(text)
  return m ? { url: m[0] } : {}
}

export interface Slot<M extends Meeting = Meeting> {
  /** Gap before this block and the block's width, as % of the day window. */
  gap: number
  width: number
  meeting: M
}

/** Lays meetings on a day window [from, to] (epoch ms): overlapping meetings go to extra lanes. */
export function lanes<M extends Meeting>(meetings: readonly M[], from: number, to: number): Slot<M>[][] {
  const span = to - from
  const pct = (t: number) => (Math.min(Math.max(t, from), to) - from) / span * 100
  const out: { end: number; slots: Slot<M>[] }[] = []
  for (const m of [...meetings].sort((a, b) => a.start - b.start)) {
    let lane = out.find((l) => l.end <= m.start)
    if (!lane) out.push((lane = { end: from, slots: [] }))
    const gap = pct(m.start) - pct(lane.end)
    lane.slots.push({ gap, width: Math.max(pct(m.end) - pct(m.start), 0.5), meeting: m })
    lane.end = m.end
  }
  return out.map((l) => l.slots)
}

/** The day cut into bar segments: meetings and the free stretches between them. `width` in %,
 *  `elapsed` the share of the segment already past at `now` (0..1). Overlapping meetings merge. */
export function segments<M extends Meeting>(meetings: readonly M[], from: number, to: number, now: number): { width: number; meeting?: M; elapsed: number }[] {
  const clamp = (t: number) => Math.min(Math.max(t, from), to)
  const span = to - from
  const out: { width: number; meeting?: M; elapsed: number }[] = []
  const push = (a: number, b: number, meeting?: M) => {
    if (b > a) out.push({ width: ((b - a) / span) * 100, elapsed: Math.min(Math.max((now - a) / (b - a), 0), 1), ...(meeting ? { meeting } : {}) })
  }
  let cursor = from
  for (const m of [...meetings].sort((a, b) => a.start - b.start)) {
    const start = clamp(m.start)
    const end = clamp(m.end)
    if (end <= cursor) continue
    push(cursor, start)
    push(Math.max(cursor, start), end, m)
    cursor = end
  }
  push(cursor, to)
  return out
}

/** Opens Meet links in the right Google account (`?authuser=<email>`); other links unchanged. */
export function withAuthUser(url: string, email: string): string {
  if (!email || !/^https:\/\/meet\.google\.com\//.test(url)) return url
  const u = new URL(url)
  u.searchParams.set('authuser', email)
  return u.toString()
}
