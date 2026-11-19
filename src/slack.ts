// Minimal Slack Web API client for the worker. Uses the person's own user token (xoxp-), so replies
// are posted as him.
import { parseOrigin, type Msg } from './queue'

export { parseOrigin, threadLink } from './queue'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

type Fetch = typeof fetch

export async function call(token: string, method: string, params: Record<string, string>, f: Fetch = fetch): Promise<any> {
  const res = await f(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body: new URLSearchParams(params).toString()
  })
  const data = await res.json()
  if (!data.ok) throw Object.assign(new Error(`slack ${method}: ${data.error}`), { code: data.error })
  return data
}

export interface Person {
  name: string
  avatar?: string
}

/** Names Slack users and downloads their 48px avatar into `avatarDir` once (`avatars/<id>.png`).
 *  Cached for the worker's life. */
export function people(token: string, avatarDir: string | null, f: Fetch = fetch) {
  const cache = new Map<string, Promise<Person>>()
  async function load(id: string): Promise<Person> {
    const d = await call(token, 'users.info', { user: id }, f).catch(() => null)
    const name = d?.user?.profile?.display_name || d?.user?.real_name || d?.user?.name || id
    const url = d?.user?.profile?.image_48
    if (!avatarDir || !url) return { name }
    const file = join(avatarDir, `${id}.png`)
    try {
      if (!existsSync(file)) {
        const res = await f(url)
        mkdirSync(avatarDir, { recursive: true })
        writeFileSync(file, Buffer.from(await res.arrayBuffer()))
      }
      return { name, avatar: `avatars/${id}.png` }
    } catch {
      return { name }
    }
  }
  return (id: string): Promise<Person> => {
    if (!cache.has(id)) cache.set(id, load(id))
    return cache.get(id)!
  }
}

type Who = (id: string) => Promise<Person>

async function toMsg(m: any, me: string, who: Who): Promise<Msg> {
  const p: Person = m.user ? await who(m.user) : { name: m.username ?? 'bot' }
  return {
    who: p.name,
    ...(p.avatar ? { avatar: p.avatar } : {}),
    text: await mentionsToNames(String(m.text ?? ''), who),
    ts: String(m.ts),
    mine: m.user === me,
    ...(m.reply_count ? { replies: m.reply_count } : {}),
    ...(m.files?.length
      ? {
          files: m.files
            .filter((f: any) => f.permalink)
            .map((f: any) => {
              const image = String(f.mimetype ?? '').startsWith('image/')
              return {
                id: String(f.id),
                name: String(f.name || f.title || 'file'),
                url: String(f.permalink),
                image,
                ...(image && (f.thumb_64 || f.thumb_360) ? { remote: { thumb: f.thumb_64, preview: f.thumb_360 ?? f.thumb_480 } } : {})
              }
            })
        }
      : {})
  }
}

/** Latest messages of a thread (or of a single message with no replies), oldest first. */
export async function readThread(
  token: string,
  me: string,
  origin: { channel: string; ts: string },
  who: Who,
  f: Fetch = fetch,
  last = 5
): Promise<Msg[]> {
  const data = await call(token, 'conversations.replies', { channel: origin.channel, ts: origin.ts, limit: '200' }, f)
  const raw: any[] = data.messages ?? []
  return Promise.all(raw.slice(-last).map((m) => toMsg(m, me, who)))
}

/** Latest top-level messages of a channel, oldest first, skipping joins and other system events. */
export async function readChannel(token: string, me: string, channel: string, who: Who, limit = 12, f: Fetch = fetch): Promise<Msg[]> {
  const data = await call(token, 'conversations.history', { channel, limit: String(limit * 2) }, f)
  const raw: any[] = (data.messages ?? []).filter((m: any) => !m.subtype || m.subtype === 'thread_broadcast' || m.subtype === 'bot_message')
  return Promise.all(raw.slice(0, limit).reverse().map((m) => toMsg(m, me, who)))
}

export async function post(token: string, channel: string, text: string, f: Fetch = fetch): Promise<void> {
  await call(token, 'chat.postMessage', { channel, text }, f)
}

/** Slack markup → plain text: `<url|label>` → label, `<url>` → url, `<#C1|name>` → #name, `<!here>` → @here. */
export function plainLinks(text: string): string {
  return text
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<!(here|channel|everyone)>/g, '@$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

async function mentionsToNames(text: string, who: Who): Promise<string> {
  const ids = [...new Set([...text.matchAll(/<@([A-Z0-9]+)>/g)].map((m) => m[1]))]
  for (const id of ids) text = text.replaceAll(`<@${id}>`, `@${(await who(id)).name}`)
  return plainLinks(text)
}

export async function reply(token: string, origin: { channel: string; ts: string }, text: string, f: Fetch = fetch): Promise<void> {
  await call(token, 'chat.postMessage', { channel: origin.channel, thread_ts: origin.ts, text }, f)
}

/** Finds Slack users by display or real name (exact, else a unique first-name match), so
 *  people the collector names on Linear tickets get their Slack avatar. */
export async function directory(
  token: string,
  f: Fetch = fetch
): Promise<{ find: (name: string) => string | null; users: { id: string; image?: string }[] }> {
  const users: { id: string; names: string[]; image?: string }[] = []
  let cursor = ''
  do {
    const d = await call(token, 'users.list', { limit: '500', ...(cursor ? { cursor } : {}) }, f)
    for (const u of d.members ?? []) {
      if (u.deleted || u.is_bot) continue
      const names = [u.profile?.display_name, u.profile?.real_name, u.real_name, u.name].filter(Boolean).map((n: string) => n.toLowerCase().trim())
      users.push({ id: u.id, names, image: u.profile?.image_48 })
    }
    cursor = d.response_metadata?.next_cursor ?? ''
  } while (cursor)
  const find = (name: string) => {
    const n = name.toLowerCase().trim()
    const exact = users.find((u) => u.names.includes(n))
    if (exact) return exact.id
    const first = users.filter((u) => u.names.some((x) => x.split(/\s+/)[0] === n.split(/\s+/)[0]))
    return first.length === 1 ? first[0].id : null
  }
  return { find, users }
}

/** Downloads every missing avatar up front. Orca only serves plugin files that existed when the
 *  plugin loaded, so avatars fetched later show up only after the next load. */
export async function prefetchAvatars(users: { id: string; image?: string }[], avatarDir: string, f: Fetch = fetch): Promise<number> {
  mkdirSync(avatarDir, { recursive: true })
  let added = 0
  for (const u of users) {
    const file = join(avatarDir, `${u.id}.png`)
    if (!u.image || existsSync(file)) continue
    try {
      writeFileSync(file, Buffer.from(await (await f(u.image)).arrayBuffer()))
      added++
    } catch {
      // A missing avatar falls back to initials.
    }
  }
  return added
}

/** Downloads image thumbnails (needs the files:read scope) into `dir` and points messages at the
 *  local copies; Slack's private URLs never reach the panel. Files already on disk are reused. */
export async function downloadThumbs(token: string, msgs: Msg[], dir: string, f: Fetch = fetch): Promise<Msg[]> {
  mkdirSync(dir, { recursive: true })
  const get = async (url: string | undefined, name: string): Promise<string | undefined> => {
    if (!url) return undefined
    const file = join(dir, name)
    if (!existsSync(file)) {
      const res = await f(url, { headers: { Authorization: `Bearer ${token}` } })
      const type = res.headers.get('content-type') ?? ''
      if (!res.ok || !type.startsWith('image/')) return undefined
      writeFileSync(file, Buffer.from(await res.arrayBuffer()))
    }
    return `media/${name}`
  }
  return Promise.all(
    msgs.map(async (m) => {
      if (!m.files?.some((x) => x.remote)) return m
      const files = await Promise.all(
        m.files.map(async ({ remote, ...file }) => {
          if (!remote) return file
          const thumb = await get(remote.thumb, `${file.id}-64.png`).catch(() => undefined)
          const preview = await get(remote.preview, `${file.id}-360.png`).catch(() => undefined)
          return { ...file, ...(thumb ? { thumb } : {}), ...(preview ? { preview } : {}) }
        })
      )
      return { ...m, files }
    })
  )
}
