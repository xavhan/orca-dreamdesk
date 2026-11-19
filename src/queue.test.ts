import { assert, test } from 'orca/testing'
import * as Q from './queue'

const T = 1_000_000
const inc = (o: Partial<Q.Incoming> & { originId: string }): Q.Incoming => ({
  source: 'slack', type: 'mention', urgent: false, title: o.originId, summary: '', at: T, ...o
})

test('rank follows router order', () => {
  let q = Q.ingest(Q.emptyQueue(), [
    inc({ originId: 't-low', source: 'linear', type: 'ticket', priority: 4, at: T }),
    inc({ originId: 't-high', source: 'linear', type: 'ticket', priority: 2, at: T + 5 }),
    inc({ originId: 'm-new', at: T + 2 }),
    inc({ originId: 'm-old', at: T + 1 }),
    inc({ originId: 'u', urgent: true, at: T + 9 })
  ], T)
  q = Q.agentStatus(q, { terminalId: 'term1', title: 'claude', state: 'blocked' }, T + 3)
  // Linear priority 2 outranks normal mentions (3); priority 4 goes last.
  assert.deepEqual(Q.rank(q, T + 10).map((i) => i.id), [
    'slack:u', 'agent:term1', 'linear:t-high', 'slack:m-old', 'slack:m-new', 'linear:t-low'
  ])
})

test('inferred importance reorders mentions and tickets, invalid values ignored', () => {
  const q = Q.ingest(Q.emptyQueue(), [
    inc({ originId: 'info', source: 'linear', type: 'ticket', priority: 1, importance: 4, at: T }),
    inc({ originId: 'review', importance: 1, at: T + 5 }),
    inc({ originId: 'plain', at: T + 1 }),
    inc({ originId: 'bad', importance: 9, at: T + 2 })
  ], T)
  assert.deepEqual(Q.rank(q, T + 10).map((i) => i.id), ['slack:review', 'slack:plain', 'slack:bad', 'linear:info'])
  assert.equal(q.items['slack:bad'].importance, undefined)
})

test('missing classification counts as urgent and raises alert', () => {
  const q = Q.ingest(Q.emptyQueue(), [inc({ originId: 'x', urgent: undefined })], T)
  assert.equal(q.items['slack:x'].kind, 'urgent')
  assert.equal(q.items['slack:x'].reason, 'not classified')
  assert.equal(q.alert, true)
})

test('new activity reopens done, but only urgent wakes snoozed', () => {
  let q = Q.ingest(Q.emptyQueue(), [inc({ originId: 'a' }), inc({ originId: 'b' })], T)
  q = Q.done(q, 'slack:a')
  q = Q.snooze(q, 'slack:b', T + 60_000)
  q = Q.ingest(q, [inc({ originId: 'a' }), inc({ originId: 'b' })], T + 1)
  assert.equal(q.items['slack:a'].state, 'new')
  assert.equal(q.items['slack:b'].state, 'snoozed')
  q = Q.ingest(q, [inc({ originId: 'b', urgent: true })], T + 2)
  assert.equal(q.items['slack:b'].state, 'new')
})

test('agent blocked → working → blocked keeps one item', () => {
  let q = Q.agentStatus(Q.emptyQueue(), { terminalId: 't', state: 'blocked' }, T)
  q = Q.agentStatus(q, { terminalId: 't', state: 'waiting' }, T + 1)
  assert.equal(Object.keys(q.items).length, 1)
  q = Q.agentStatus(q, { terminalId: 't', state: 'working' }, T + 2)
  assert.equal(Object.keys(q.items).length, 0)
  q = Q.agentStatus(q, { terminalId: 't', state: 'blocked' }, T + 3)
  assert.deepEqual(Object.keys(q.items), ['agent:t'])
})

test('delegated item resurfaces when its agent needs you, without a duplicate agent item', () => {
  let q = Q.ingest(Q.emptyQueue(), [inc({ originId: 'a' })], T)
  q = Q.take(q, 'slack:a', T)
  q = Q.delegate(q, 'slack:a', 'term9')
  assert.equal(q.focus, null)
  q = Q.agentStatus(q, { terminalId: 'term9', state: 'working' }, T + 1)
  assert.equal(q.items['slack:a'].state, 'delegated')
  q = Q.agentStatus(q, { terminalId: 'term9', state: 'waiting' }, T + 2)
  assert.equal(q.items['slack:a'].state, 'new')
  assert.deepEqual(Object.keys(q.items), ['slack:a'])
})

test('take while another is in progress puts the old one back; take clears alert', () => {
  let q = Q.ingest(Q.emptyQueue(), [inc({ originId: 'a' }), inc({ originId: 'b', urgent: true })], T)
  q = Q.take(q, 'slack:a', T)
  q = Q.take(q, 'slack:b', T + 1)
  assert.equal(q.items['slack:a'].state, 'new')
  assert.equal(q.items['slack:b'].state, 'in_progress')
  assert.deepEqual(q.focus, { itemId: 'slack:b', since: T + 1 })
  assert.equal(q.alert, false)
})

test('snoozed item comes back when due; ack clears alert', () => {
  let q = Q.ingest(Q.emptyQueue(), [inc({ originId: 'a', urgent: true })], T)
  q = Q.snooze(q, 'slack:a', T + 100)
  assert.equal(Q.rank(q, T + 50).length, 0)
  assert.equal(Q.parked(q, T + 50).length, 1)
  assert.equal(Q.rank(q, T + 100).length, 1)
  assert.equal(Q.ack(q).alert, false)
})

test('focusOther then release', () => {
  let q = Q.focusOther(Q.emptyQueue(), T)
  assert.deepEqual(q.focus, { itemId: null, since: T })
  assert.equal(Q.release(q).focus, null)
})

test('snoozeUntil tomorrow is 9:00 next day', () => {
  const d = new Date(Q.snoozeUntil('tomorrow', new Date(2026, 10, 19, 22, 0).getTime()))
  assert.deepEqual([d.getDate(), d.getHours(), d.getMinutes()], [20, 9, 0])
})

const msg = (ts: string, mine = false): Q.Msg => ({ who: mine ? 'moi' : 'Jean', text: ts, ts, mine })

test('thread update: first read only records, a reply from someone else reopens done', () => {
  let q = Q.ingest(Q.emptyQueue(), [inc({ originId: 'C1:100.1' })], T)
  q = Q.threadUpdate(q, 'slack:C1:100.1', [msg('100.1'), msg('101.0')], T)
  assert.equal(q.items['slack:C1:100.1'].seenTs, '101.0')
  q = Q.done(q, 'slack:C1:100.1')
  q = Q.threadUpdate(q, 'slack:C1:100.1', [msg('100.1'), msg('101.0'), msg('102.0', true)], T + 1)
  assert.equal(q.items['slack:C1:100.1'].state, 'done')
  q = Q.threadUpdate(q, 'slack:C1:100.1', [msg('100.1'), msg('101.0'), msg('102.0', true), msg('103.0')], T + 2)
  assert.equal(q.items['slack:C1:100.1'].state, 'new')
  assert.equal(q.items['slack:C1:100.1'].thread?.length, 4)
})

test('collector re-ingest keeps the thread', () => {
  let q = Q.ingest(Q.emptyQueue(), [inc({ originId: 'C1:1' })], T)
  q = Q.threadUpdate(q, 'slack:C1:1', [msg('1')], T)
  q = Q.ingest(q, [inc({ originId: 'C1:1' })], T + 1)
  assert.equal(q.items['slack:C1:1'].seenTs, '1')
})

test('watchedSlack keeps open items and recent done ones', () => {
  let q = Q.ingest(Q.emptyQueue(), [inc({ originId: 'a' }), inc({ originId: 'b' }), inc({ originId: 'l', source: 'linear' })], T)
  q = Q.done(q, 'slack:b')
  assert.deepEqual(Q.watchedSlack(q, T).map((i) => i.id).sort(), ['slack:a', 'slack:b'])
  assert.deepEqual(Q.watchedSlack(q, T + 4 * 24 * 3600_000).map((i) => i.id), ['slack:a'])
})

test('pass hides an item; only an urgent update brings it back', () => {
  let q = Q.ingest(Q.emptyQueue(), [inc({ originId: 'C1:1.0' })], T)
  q = Q.take(q, 'slack:C1:1.0', T)
  q = Q.pass(q, 'slack:C1:1.0')
  assert.equal(q.focus, null)
  assert.equal(Q.rank(q, T).length, 0)
  assert.equal(Q.watchedSlack(q, T).length, 0)
  q = Q.ingest(q, [inc({ originId: 'C1:1.0' })], T + 1)
  assert.equal(q.items['slack:C1:1.0'].state, 'passed')
  q = Q.ingest(q, [inc({ originId: 'C1:1.0', urgent: true })], T + 2)
  assert.equal(q.items['slack:C1:1.0'].state, 'new')
})

test('referenceQuery uses the Linear key, else a non-Slack URL', () => {
  const base = { source: 'linear' as const, kind: 'ticket' as const, title: '', summary: '', arrivedAt: 0, state: 'new' as const }
  assert.equal(Q.referenceQuery({ ...base, id: 'linear:TC-1420', url: 'https://x' }), 'TC-1420')
  assert.equal(Q.referenceQuery({ ...base, id: 'linear:review:abc', url: 'https://linear.app/r' }), 'https://linear.app/r')
  assert.equal(Q.referenceQuery({ ...base, id: 'slack:C1:1.0', source: 'slack', url: 'https://slack' }), null)
})

test('waiting on a worktree: item comes back only when the agent turns to needing you', () => {
  let q = Q.ingest(Q.emptyQueue(), [inc({ originId: 'TC-1', source: 'linear', type: 'ticket' })], T)
  q = Q.take(q, 'linear:TC-1', T)
  q = Q.waitOnWorktree(q, 'linear:TC-1', 'W1', 'done')
  assert.equal(q.focus, null)
  assert.equal(Q.parked(q, T).length, 1)
  q = Q.worktreeStatus(q, 'W1', 'done', T + 1) // still the old "done": no resurfacing
  assert.equal(q.items['linear:TC-1'].state, 'delegated')
  q = Q.worktreeStatus(q, 'W1', 'working', T + 2)
  assert.equal(q.items['linear:TC-1'].state, 'delegated')
  q = Q.worktreeStatus(q, 'W1', 'permission', T + 3)
  assert.equal(q.items['linear:TC-1'].state, 'new')
  assert.equal(q.items['linear:TC-1'].reason, 'The worktree agent needs you.')
})

test('prSettled: merged or closed, or reviewed by someone else unless it is my PR', () => {
  const pr = (state: string, author: string, reviewers: string[] = []) => ({ state, author, reviewers })
  assert.equal(Q.prSettled(pr('MERGED', 'bob'), 'me'), true)
  assert.equal(Q.prSettled(pr('CLOSED', 'me'), 'me'), true)
  assert.equal(Q.prSettled(pr('OPEN', 'bob'), 'me'), false)
  assert.equal(Q.prSettled(pr('OPEN', 'bob', ['bob']), 'me'), false)
  assert.equal(Q.prSettled(pr('OPEN', 'bob', ['alice']), 'me'), true)
  assert.equal(Q.prSettled(pr('OPEN', 'bob', ['me']), 'me'), true)
  assert.equal(Q.prSettled(pr('OPEN', 'me', ['alice']), 'me'), false)
})

test('ingest keeps the PR link across updates', () => {
  const base = { source: 'linear' as const, originId: 'ENG-1', type: 'ticket' as const, urgent: false, title: 't', summary: 's', at: 1 }
  let q = Q.ingest(Q.emptyQueue(), [{ ...base, prUrl: 'https://github.com/acme/app/pull/1' }], 1)
  q = Q.ingest(q, [base], 2)
  assert.equal(q.items['linear:ENG-1']!.prUrl, 'https://github.com/acme/app/pull/1')
})

test('takeNext focuses the top item once the current one is in the background', () => {
  const inc = (originId: string, importance: number) => ({ source: 'linear' as const, originId, type: 'ticket' as const, urgent: false, title: originId, summary: '', importance, at: 1 })
  let q = Q.ingest(Q.emptyQueue(), [inc('A-1', 1), inc('A-2', 2), inc('A-3', 3)], 1)
  q = Q.take(q, 'linear:A-1', 2)
  q = Q.takeNext(Q.waitOnWorktree(q, 'linear:A-1', 'W1', 'working'), 3)
  assert.equal(q.focus?.itemId, 'linear:A-2')
  assert.equal(q.items['linear:A-1']!.state, 'delegated')
  assert.equal(Q.takeNext(Q.emptyQueue(), 1).focus, null)
})

test('ciState: failing beats running beats passed', () => {
  const done = { status: 'COMPLETED', conclusion: 'SUCCESS' }
  assert.equal(Q.ciState([]), undefined)
  assert.equal(Q.ciState([done, { status: 'COMPLETED', conclusion: 'SKIPPED' }]), 'passed')
  assert.equal(Q.ciState([done, { status: 'IN_PROGRESS' }]), 'running')
  assert.equal(Q.ciState([done, { state: 'PENDING' }]), 'running')
  assert.equal(Q.ciState([{ status: 'IN_PROGRESS' }, { status: 'COMPLETED', conclusion: 'FAILURE' }]), 'failing')
  assert.equal(Q.ciState([{ state: 'ERROR' }]), 'failing')
})
