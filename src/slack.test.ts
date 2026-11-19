import { assert, test } from 'orca/testing'
import { downloadThumbs, parseOrigin, plainLinks, readChannel, readThread, reply, threadLink } from './slack'

function fakeFetch(answers: Record<string, unknown>, seen: { method: string; body: string }[] = []) {
  return (async (url: string, init: { body: string }) => {
    const method = url.split('/').pop()!
    seen.push({ method, body: init.body })
    return { json: async () => answers[method] }
  }) as unknown as typeof fetch
}

test('parseOrigin reads channel and thread ts', () => {
  assert.deepEqual(parseOrigin('slack:C0123ABC:1700000000.000100'), { channel: 'C0123ABC', ts: '1700000000.000100' })
  assert.equal(parseOrigin('slack:weird'), null)
  assert.equal(parseOrigin('linear:LAY-1'), null)
})

test('readThread names authors, resolves mentions and flags my messages', async () => {
  const f = fakeFetch({
    'conversations.replies': { ok: true, messages: [
      { user: 'U1', text: 'hey <@ME>', ts: '1.0' },
      { user: 'ME', text: 'on it', ts: '2.0' }
    ] }
  })
  const names: Record<string, string> = { U1: 'Ana', ME: 'me' }
  const msgs = await readThread('t', 'ME', { channel: 'C1', ts: '1.0' }, async (id) => ({ name: names[id] }), f)
  assert.deepEqual(msgs, [
    { who: 'Ana', text: 'hey @me', ts: '1.0', mine: false },
    { who: 'me', text: 'on it', ts: '2.0', mine: true }
  ])
})

test('reply posts in the thread and surfaces Slack errors', async () => {
  const seen: { method: string; body: string }[] = []
  await reply('t', { channel: 'C1', ts: '1.0' }, 'Je suis dessus', fakeFetch({ 'chat.postMessage': { ok: true } }, seen))
  assert.equal(seen[0].method, 'chat.postMessage')
  assert.match(seen[0].body, /thread_ts=1\.0/)
  await assert.rejects(reply('t', { channel: 'C1', ts: '1.0' }, 'x', fakeFetch({ 'chat.postMessage': { ok: false, error: 'not_in_channel' } })), /not_in_channel/)
})

test('threadLink points at the thread root', () => {
  assert.equal(threadLink('https://acme.slack.com/', 'slack:C1:1700000000.000100'), 'https://acme.slack.com/archives/C1/p1700000000000100')
  assert.equal(threadLink('https://acme.slack.com', 'linear:LAY-1'), null)
})

test('readChannel keeps real messages, oldest first, with reply counts', async () => {
  const f = fakeFetch({
    'conversations.history': { ok: true, messages: [
      { user: 'U1', text: 'newest', ts: '3.0', reply_count: 2 },
      { user: 'U1', subtype: 'channel_join', text: 'joined', ts: '2.0' },
      { user: 'U2', text: 'older', ts: '1.0' }
    ] }
  })
  const msgs = await readChannel('t', 'ME', 'C1', async (id) => ({ name: id, avatar: `avatars/${id}.png` }), 12, f)
  assert.deepEqual(msgs.map((m) => [m.text, m.replies, m.avatar]), [['older', undefined, 'avatars/U2.png'], ['newest', 2, 'avatars/U1.png']])
})

test('plainLinks turns Slack markup into readable text', () => {
  assert.equal(plainLinks('see <https://fal.ai/x|fal> and <https://a.b> in <#C1|eng> <!here> &amp; co'), 'see fal and https://a.b in #eng @here & co')
})

test('downloadThumbs saves image thumbnails with the token and drops the private URLs', async () => {
  const { mkdtempSync, existsSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'media-'))
  const auth: string[] = []
  const f = (async (_url: string, init: { headers: Record<string, string> }) => {
    auth.push(init.headers.Authorization)
    return { ok: true, headers: { get: () => 'image/png' }, arrayBuffer: async () => new ArrayBuffer(4) }
  }) as unknown as typeof fetch
  const [m] = await downloadThumbs('tok', [{ who: 'A', text: '', ts: '1', mine: false, files: [{ id: 'F1', name: 'a.png', url: 'u', image: true, remote: { thumb: 't64', preview: 't360' } }] }], dir, f)
  assert.deepEqual(m!.files, [{ id: 'F1', name: 'a.png', url: 'u', image: true, thumb: 'media/F1-64.png', preview: 'media/F1-360.png' }])
  assert.deepEqual(auth, ['Bearer tok', 'Bearer tok'])
  assert.ok(existsSync(join(dir, 'F1-64.png')))
})
