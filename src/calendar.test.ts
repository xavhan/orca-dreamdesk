import { assert, test } from 'orca/testing'
import { lanes, segments, todaysMeetings, withAuthUser, zoned } from './calendar'

const TZ = 'Europe/Paris'
// Thursday 19 Nov 2026, 12:00 in Paris.
const NOW = zoned(2026, 11, 19, 12, 0, TZ)
const ev = (body: string) => `BEGIN:VEVENT\r\n${body.trim().split('\n').map((l) => l.trim()).join('\r\n')}\r\nEND:VEVENT`
const cal = (...events: string[]) => `BEGIN:VCALENDAR\r\n${events.join('\r\n')}\r\nEND:VCALENDAR\r\n`
const hm = (t: number) => new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(t)

test('single, weekly, daily-with-exdate, moved and cancelled occurrences', () => {
  const ics = cal(
    ev(`UID:one
      DTSTART;TZID=Europe/Paris:20261119T150000
      DTEND;TZID=Europe/Paris:20261119T153000
      SUMMARY:Design review\\, v2
      X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij`),
    ev(`UID:standup
      DTSTART;TZID=Europe/Paris:20260105T093000
      DTEND;TZID=Europe/Paris:20260105T094500
      RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR
      SUMMARY:Standup`),
    ev(`UID:skip
      DTSTART;TZID=Europe/Paris:20261101T080000
      DTEND;TZID=Europe/Paris:20261101T081000
      RRULE:FREQ=DAILY
      EXDATE;TZID=Europe/Paris:20261119T080000
      SUMMARY:Skipped today`),
    ev(`UID:weekly
      DTSTART;TZID=Europe/Paris:20261008T110000
      DTEND;TZID=Europe/Paris:20261008T120000
      RRULE:FREQ=WEEKLY;INTERVAL=2
      SUMMARY:Biweekly sync`),
    ev(`UID:weekly
      RECURRENCE-ID;TZID=Europe/Paris:20261119T110000
      DTSTART;TZID=Europe/Paris:20261119T170000
      DTEND;TZID=Europe/Paris:20261119T180000
      SUMMARY:Biweekly sync (moved)`),
    ev(`UID:gone
      DTSTART;TZID=Europe/Paris:20261119T100000
      DTEND;TZID=Europe/Paris:20261119T110000
      STATUS:CANCELLED
      SUMMARY:Cancelled`),
    ev(`UID:ended
      DTSTART;TZID=Europe/Paris:20260101T140000
      DTEND;TZID=Europe/Paris:20260101T150000
      RRULE:FREQ=WEEKLY;BYDAY=TH;UNTIL=20261001T000000Z
      SUMMARY:Ended series`),
    ev(`UID:declined
      DTSTART:20261119T130000Z
      DTEND:20261119T140000Z
      ATTENDEE;PARTSTAT=DECLINED;CN=Me:mailto:me@example.com
      SUMMARY:Declined`),
    ev(`UID:allday
      DTSTART;VALUE=DATE:20261119
      SUMMARY:Holiday`)
  )
  const got = todaysMeetings(ics, NOW, TZ, 'me@example.com').map((m) => `${hm(m.start)}-${hm(m.end)} ${m.title}${m.url ? ' +link' : ''}`)
  assert.deepEqual(got, ['09:30-09:45 Standup', '15:00-15:30 Design review, v2 +link', '17:00-18:00 Biweekly sync (moved)'])
})

test('weekly interval 2 lands on the right weeks; count limits occurrences', () => {
  const ics = cal(
    ev(`UID:bi
      DTSTART;TZID=Europe/Paris:20261105T100000
      DTEND;TZID=Europe/Paris:20261105T103000
      RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TH
      SUMMARY:On`),
    ev(`UID:off
      DTSTART;TZID=Europe/Paris:20261112T100000
      DTEND;TZID=Europe/Paris:20261112T103000
      RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TH
      SUMMARY:Off`),
    ev(`UID:count
      DTSTART;TZID=Europe/Paris:20261116T160000
      DTEND;TZID=Europe/Paris:20261116T161500
      RRULE:FREQ=DAILY;COUNT=3
      SUMMARY:Three days only`)
  )
  assert.deepEqual(todaysMeetings(ics, NOW, TZ).map((m) => m.title), ['On'])
})

test('lanes: proportional slots, overlaps on a second lane', () => {
  const h = (n: number) => n * 3600_000
  const meetings = [
    { title: 'a', start: h(10), end: h(11) },
    { title: 'b', start: h(10.5), end: h(12) },
    { title: 'c', start: h(14), end: h(15) }
  ]
  const got = lanes(meetings, h(9), h(19)).map((l) => l.map((s) => [s.meeting.title, +s.gap.toFixed(1), +s.width.toFixed(1)]))
  assert.deepEqual(got, [
    [['a', 10, 10], ['c', 30, 10]],
    [['b', 15, 15]]
  ])
})

test('segments: free stretches and meetings, filled by elapsed share, overlaps merged', () => {
  const h = (n: number) => n * 3600_000
  const meetings = [
    { title: 'a', start: h(10), end: h(11) },
    { title: 'b', start: h(10.5), end: h(12) },
    { title: 'c', start: h(14), end: h(15) }
  ]
  const got = segments(meetings, h(9), h(19), h(14.5)).map((s) => [s.meeting?.title ?? 'free', +s.width.toFixed(1), +s.elapsed.toFixed(2)])
  assert.deepEqual(got, [['free', 10, 1], ['a', 10, 1], ['b', 10, 1], ['free', 20, 1], ['c', 10, 0.5], ['free', 40, 0]])
})

test('withAuthUser adds the account to Meet links only', () => {
  assert.equal(withAuthUser('https://meet.google.com/abc-defg-hij', 'me@acme.com'), 'https://meet.google.com/abc-defg-hij?authuser=me%40acme.com')
  assert.equal(withAuthUser('https://meet.google.com/a?pli=1', 'x@y.z'), 'https://meet.google.com/a?pli=1&authuser=x%40y.z')
  assert.equal(withAuthUser('https://zoom.us/j/1', 'x@y.z'), 'https://zoom.us/j/1')
})
