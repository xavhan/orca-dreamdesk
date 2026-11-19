import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readInbox } from './worker'
import * as main from './worker'

const CAPS = ['settings:own', 'automation:read', 'automation:write', 'secrets:own', 'storage:own', 'agent:read', 'workspace:read', 'workspace:write', 'notifications:show']
const host = (storage = {}) =>
  mockHost({ capabilities: CAPS, storage, results: { 'workspace.list': { workspaces: [], truncated: false } } })

test('readInbox keeps valid entries, drops broken files, skips .tmp', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-'))
  writeFileSync(join(dir, '1.json'), JSON.stringify([{ source: 'slack', originId: 'a', type: 'mention', urgent: false, title: 'A', summary: '', at: 1 }, { nope: 1 }]))
  writeFileSync(join(dir, '2.json'), '{not json')
  writeFileSync(join(dir, '3.json.tmp'), '[]')
  const logs: string[] = []
  const got = readInbox(dir, (m) => logs.push(m))
  assert.deepEqual(got.entries.map((x) => x.originId), ['a'])
  assert.deepEqual(got.files, [join(dir, '1.json')])
  assert.deepEqual(readdirSync(dir).sort(), ['1.json', '3.json.tmp'])
  assert.equal(logs.length, 1)
})

test('agent event queues the agent and posts the view; queue survives restart', async () => {
  const h = host()
  const w = await mountWorker(main, { host: h, events: ['agent.status.changed'] })
  await w.emit('agent.status.changed', { workspaceId: 'w', paneKey: 'p', terminalId: 't1', title: 'claude', state: 'blocked', receivedAt: 1 })
  const view = await w.request('queue.get')
  assert.deepEqual(view.next.map((i) => i.id), ['agent:t1'])
  assert.ok(w.posts.some((p) => p.event === 'queue.changed'))
  await w.deactivate()

  const again = await mountWorker(main, { host: mockHost({ capabilities: CAPS, storage: h.data().storage as never, results: { 'workspace.list': { workspaces: [], truncated: false } } }) })
  assert.deepEqual((await again.request('queue.get')).next.map((i) => i.id), ['agent:t1'])
  await again.deactivate()
})

test('take, done and ack go through queue.act', async () => {
  const w = await mountWorker(main, { host: host(), events: ['agent.status.changed'] })
  await w.emit('agent.status.changed', { workspaceId: 'w', paneKey: 'p', terminalId: 't1', title: 'codex', state: 'waiting', receivedAt: 1 })
  let v = await w.request('queue.act', { action: 'take', id: 'agent:t1' })
  assert.equal(v.current?.id, 'agent:t1')
  v = await w.request('queue.act', { action: 'done', id: 'agent:t1' })
  assert.equal(v.focus, null)
  assert.equal(v.next.length, 0)
  await w.deactivate()
})

test('parseChannels reads "ID label" lines and skips junk', async () => {
  const { parseChannels } = await import('./worker')
  assert.deepEqual(parseChannels('C0123ABCD #team\n\n  G0456EFGH   Lunch crew  \nnot a channel\nC0789IJKL'), [
    { id: 'C0123ABCD', name: '#team' },
    { id: 'G0456EFGH', name: 'Lunch crew' },
    { id: 'C0789IJKL', name: 'C0789IJKL' }
  ])
})
