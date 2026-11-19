import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { View } from './protocol'
import type { Item } from './queue'

const item = (id: string, o: Partial<Item> = {}): Item => ({
  id, source: 'slack', kind: 'mention', title: id, summary: 's', arrivedAt: 1, state: 'new', ...o
})
const free: View = { focus: null, current: null, next: [item('a'), item('b')], parked: [], alert: false, slack: true }

function hostWith(v: View, calls: unknown[] = []) {
  return mockHost({
    capabilities: ['agent:read'],
    requests: {
      'queue.get': () => v,
      'queue.act': (input) => (calls.push(input), v),
      'agents.all': () => [],
      'item.open': () => ({ ok: true }),
      'slack.reply': (input) => (calls.push(input), v),
      'slack.post': (input) => (calls.push(input), v),
      'thread.open': (input) => (calls.push(input), v),
      'slack.thread': (input) => (calls.push(input), [{ who: 'Bob', text: 'a reply', ts: '2.0', mine: false }])
    }
  })
}

test('free mode shows next item and takes it', async () => {
  const calls: unknown[] = []
  const view = await mount(panel, { host: hostWith(free, calls) })
  assert.ok(view.find({ text: 'Free' }))
  assert.ok(JSON.stringify(view.tree()).includes('UP NEXT'))
  await view.press({ text: 'Take it' })
  assert.deepEqual(calls, [{ action: 'take', id: 'a' }])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('focus mode shows current item and marks it done', async () => {
  const calls: unknown[] = []
  const v: View = { ...free, focus: { itemId: 'c', since: 1 }, current: item('c', { state: 'in_progress' }) }
  const view = await mount(panel, { host: hostWith(v, calls) })
  assert.ok(view.find({ text: 'Focus' }))
  await view.press({ text: 'Done' })
  assert.deepEqual(calls, [{ action: 'done', id: 'c' }])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('alert shows the red callout and can be acknowledged', async () => {
  const calls: unknown[] = []
  const v: View = { ...free, next: [item('u', { kind: 'urgent' })], alert: true }
  const view = await mount(panel, { host: hostWith(v, calls) })
  assert.match(view.summary().join('\n'), /Urgent: u/)
  await view.press({ text: 'Seen' })
  assert.deepEqual(calls, [{ action: 'ack' }])
  await view.unmount()
})

test('slack item in progress shows the thread and replies in it', async () => {
  const calls: unknown[] = []
  const cur = item('slack:C1:1.0', { state: 'in_progress', thread: [{ who: 'Jean', text: 'tu peux regarder ?', ts: '1.0', mine: false }] })
  const v: View = { ...free, focus: { itemId: cur.id, since: 1 }, current: cur, slackUrl: 'https://acme.slack.com/' }
  const view = await mount(panel, { host: hostWith(v, calls) })
  assert.ok(JSON.stringify(view.tree()).includes('tu peux regarder ?'))
  await view.press({ text: 'Open thread in Slack' })
  assert.deepEqual(JSON.parse(JSON.stringify(view.host.callsOf('shell.openExternal'))), [{ url: 'https://acme.slack.com/archives/C1/p10' }])
  await view.type({ label: 'Reply in thread' }, 'Je regarde')
  await view.press({ text: 'Send' })
  await view.press({ text: '👀 On it' })
  assert.deepEqual(calls, [
    { id: 'slack:C1:1.0', text: 'Je regarde' },
    { id: 'slack:C1:1.0', text: 'On it 👀' }
  ])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('without Slack, the panel offers to connect it', async () => {
  const view = await mount(panel, { host: hostWith({ ...free, slack: false }) })
  assert.ok(JSON.stringify(view.tree()).includes('Connect Slack'))
  await view.unmount()
})

test('team channel shows messages and posts to it', async () => {
  const calls: unknown[] = []
  const v: View = { ...free, channels: [
    { id: 'C1', channel: 'C1', name: '#team', url: 'https://x/archives/C1', messages: [{ who: 'Ana', text: 'hello team', ts: '1.0', mine: false, replies: 3 }] },
    { id: 'C2', channel: 'C2', name: 'Lunch crew', url: 'https://x/archives/C2', messages: [] }
  ] }
  const view = await mount(panel, { host: hostWith(v, calls) })
  const tree = JSON.stringify(view.tree())
  assert.ok(tree.includes('#team') && tree.includes('hello team') && tree.includes('3 replies'))
  await view.toggle({ label: '3 replies' })
  assert.ok(JSON.stringify(view.tree()).includes('a reply'))
  calls.length = 0
  await view.type({ label: 'Message #team' }, 'Shipping today', { submit: true })
  assert.deepEqual(calls, [{ channel: 'C1', text: 'Shipping today' }])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('dismiss removes the next item', async () => {
  const calls: unknown[] = []
  const view = await mount(panel, { host: hostWith(free, calls) })
  await view.press({ text: 'Dismiss' })
  assert.deepEqual(calls, [{ action: 'pass', id: 'a' }])
  await view.unmount()
})

test('back to queue releases the current item', async () => {
  const calls: unknown[] = []
  const v: View = { ...free, focus: { itemId: 'c', since: 1 }, current: item('c', { state: 'in_progress' }) }
  const view = await mount(panel, { host: hostWith(v, calls) })
  await view.press({ label: 'Back to queue' })
  assert.deepEqual(calls, [{ action: 'release' }])
  await view.unmount()
})

test('unread dot shows on a tab with newer messages, and opening a thread calls thread.open', async () => {
  const calls: unknown[] = []
  const tabs = (dreamTs: string): View => ({ ...free, channels: [
    { id: 'C1', channel: 'C1', name: '#team', url: 'u', messages: [{ who: 'Ana', text: 'hi', ts: '1.0', mine: false }] },
    { id: 'C2', channel: 'C2', name: 'Lunch crew', url: 'u', messages: [{ who: 'Bob', text: 'yo', ts: dreamTs, mine: false, replies: 2 }] }
  ] })
  const view = await mount(panel, { host: hostWith(tabs('5.0'), calls) })
  assert.ok(!JSON.stringify(view.tree()).includes('● Lunch crew'))
  await view.post('queue.changed', tabs('6.0'))
  assert.ok(JSON.stringify(view.tree()).includes('● Lunch crew'))
  await view.select({ label: 'Team channels' }, 'C2')
  assert.ok(!JSON.stringify(view.tree()).includes('● Lunch crew'))
  await view.press({ label: 'Open thread in a tab' })
  assert.deepEqual(calls, [{ channel: 'C2', ts: '6.0', title: '🧵 Bob: yo' }])
  await view.unmount()
})

test('linked worktree shows its state and lets you wait on it', async () => {
  const calls: unknown[] = []
  const cur = item('linear:TC-1', { source: 'linear', state: 'in_progress' })
  const v: View = { ...free, focus: { itemId: cur.id, since: 1 }, current: cur, worktrees: { 'linear:TC-1': { id: 'W1', name: 'tc-1-fix', state: 'working' } } }
  const view = await mount(panel, { host: hostWith(v, calls) })
  assert.ok(JSON.stringify(view.tree()).includes('tc-1-fix · agent working'))
  await view.press({ text: 'Background' })
  assert.deepEqual(calls, [{ action: 'wait', id: 'linear:TC-1' }])
  await view.unmount()
})

test('a working worktree shows a spinner; attachments open in Slack', async () => {
  const calls: unknown[] = []
  const v: View = {
    ...free,
    worktrees: { a: { id: 'W1', name: 'wt', state: 'working' } },
    channels: [{ id: 'C1', channel: 'C1', name: '#c', url: 'u', messages: [{ who: 'Ana', text: '', ts: '1.0', mine: false, files: [{ id: 'F1', name: 'shot.png', url: 'https://slack/f', image: true }] }] }]
  }
  const view = await mount(panel, { host: hostWith(v, calls) })
  const tree = JSON.stringify(view.tree())
  assert.ok(tree.includes('Agent working'))
  await view.press({ text: 'shot.png' })
  assert.deepEqual(JSON.parse(JSON.stringify(view.host.callsOf('shell.openExternal'))).map((c: any) => c.params ?? c), [{ url: 'https://slack/f' }])
  await view.unmount()
})

test('meetings timeline lays out the day and joins the current meeting', async () => {
  const h = (n: number) => new Date(2026, 10, 19, n).getTime()
  const v: View = {
    ...free,
    calendar: true,
    nowAt: h(11),
    meetings: [
      { title: 'Standup', start: h(9), end: h(9.25), status: 'past' },
      { title: 'Design review', start: h(10.5), end: h(11.5), status: 'now', url: 'https://meet.google.com/x' },
      { title: 'Retro', start: h(16), end: h(17), status: 'upcoming' }
    ]
  }
  const view = await mount(panel, { host: hostWith(v) })
  const tree = JSON.stringify(view.tree())
  assert.ok(tree.includes('1 done · 2 left') && tree.includes('Design review') && tree.includes('Retro'))
  assert.deepEqual(view.warnings.filter((w) => w.includes('width')), [])
  assert.ok(view.find({ label: `${new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(h(16))}–${new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(h(17))} · Retro` }))
  await view.press({ text: 'Join' })
  assert.equal(view.host.callsOf('shell.openExternal').length, 1)
  await view.unmount()
})

test('without a calendar the panel offers to connect one', async () => {
  const view = await mount(panel, { host: hostWith(free) })
  assert.ok(JSON.stringify(view.tree()).includes('Connect calendar'))
  await view.unmount()
})

test('a past meeting with a link still opens its meet from the day bar', async () => {
  const h = (n: number) => new Date(2026, 10, 19, n).getTime()
  const v: View = { ...free, calendar: true, nowAt: h(16), meetings: [{ title: 'Sync', start: h(14.5), end: h(15), status: 'past', url: 'https://meet.google.com/abc' }] }
  const view = await mount(panel, { host: hostWith(v) })
  const fmt = (t: number) => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(t)
  await view.press({ label: `${fmt(h(14.5))}–${fmt(h(15))} · Sync` })
  assert.equal(view.host.callsOf('shell.openExternal').length, 1)
  await view.unmount()
})
