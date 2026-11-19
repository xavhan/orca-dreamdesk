#!/usr/bin/env node
// DreamDesk MCP server: lets agents in other worktrees read and act on the DreamDesk queue.
// Stdio JSON-RPC, no dependencies. It talks to the plugin's worker through files:
// it reads ~/.orca-helpdesk/queue.json and drops requests in ~/.orca-helpdesk/requests/,
// which the worker applies (src/queue.ts `applyRequest`) and deletes.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const HOME = process.env.HELPDESK_HOME ?? join(homedir(), '.orca-helpdesk')
const SNAPSHOT = join(HOME, 'queue.json')
const REQUESTS = join(HOME, 'requests')

const id = { type: 'string', description: 'Item id, from dreamdesk_queue' }
const TOOLS = [
  {
    name: 'dreamdesk_queue',
    description: "The user's DreamDesk attention queue: the item they are on now, the queue in order, and parked items. Each item has an id, its linked Orca worktree name when there is one, and its URLs. Match `worktree` against your own worktree to find your task.",
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'dreamdesk_add',
    description: 'Add an item to the user\'s queue for something YOU, the agent, need from them: a review, a decision. Use urgent only for real emergencies: it breaks through their focus. For a task the user asks you to note for themself, use dreamdesk_note.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title, 8 words max' },
        summary: { type: 'string', description: 'Where it stands and what you need from the user, 2 sentences max' },
        url: { type: 'string' },
        prUrl: { type: 'string', description: 'GitHub pull request URL; DreamDesk clears the item once the PR is merged, closed or reviewed' },
        importance: { type: 'integer', minimum: 1, maximum: 4, description: '1 blocks someone … 4 information only' },
        urgent: { type: 'boolean' },
        actions: {
          type: 'array',
          items: { type: 'string', maxLength: 40 },
          maxItems: 3,
          description: "When the answer is simple, up to 3 short answers (e.g. ['Yes, commit and open the PR', 'No']). The user's click is typed into your terminal as their reply, so phrase each as what they would type. Only works when you run in an Orca terminal."
        }
      },
      required: ['title']
    }
  },
  {
    name: 'dreamdesk_note',
    description: "Add a task the user asks you to note for them in their DreamDesk queue: something to not lose track of during their day that is logged in no other system (not Linear, not Slack). Use this, not dreamdesk_add, whenever the user says 'note', 'remind me', 'add to my queue' or similar.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title in the user\'s words, 8 words max' },
        summary: { type: 'string', description: 'Any detail the user gave, 2 sentences max' },
        url: { type: 'string' },
        importance: { type: 'integer', minimum: 1, maximum: 4, description: '1 blocks someone … 4 information only; leave out if the user did not say' }
      },
      required: ['title']
    }
  },
  { name: 'dreamdesk_done', description: 'Mark an item as done.', inputSchema: { type: 'object', properties: { id }, required: ['id'] } },
  {
    name: 'dreamdesk_snooze',
    description: 'Hide an item for a while; it comes back after.',
    inputSchema: { type: 'object', properties: { id, minutes: { type: 'integer', minimum: 1 } }, required: ['id', 'minutes'] }
  },
  {
    name: 'dreamdesk_set_pr',
    description: "Link a GitHub PR to an item (for example the PR you opened for the user's task). DreamDesk then shows its CI and clears the item once merged, closed or reviewed.",
    inputSchema: { type: 'object', properties: { id, prUrl: { type: 'string' } }, required: ['id', 'prUrl'] }
  }
]

const readSnapshot = () => {
  if (!existsSync(SNAPSHOT)) throw new Error('DreamDesk has not written its queue yet: is the plugin running in Orca?')
  return JSON.parse(readFileSync(SNAPSHOT, 'utf8'))
}

/** Writes a request and waits (up to 5 s) for the worker to apply it. */
async function request(body) {
  mkdirSync(REQUESTS, { recursive: true })
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
  const file = join(REQUESTS, name)
  writeFileSync(`${file}.tmp`, JSON.stringify(body))
  renameSync(`${file}.tmp`, file)
  for (let i = 0; i < 50 && existsSync(file); i++) await new Promise((r) => setTimeout(r, 100))
  if (existsSync(file)) return 'Queued; DreamDesk will apply it within a minute (its worker did not answer right away).'
  if (existsSync(`${file}.error`)) {
    const err = readFileSync(`${file}.error`, 'utf8')
    rmSync(`${file}.error`, { force: true })
    throw new Error(err)
  }
  return 'Done.'
}

async function call(name, args = {}) {
  switch (name) {
    case 'dreamdesk_queue': return JSON.stringify(readSnapshot(), null, 2)
    // Orca gives each agent's processes its terminal: answers are typed back there.
    case 'dreamdesk_add': return request({ op: 'add', ...args, from: 'agent', terminalId: process.env.ORCA_TERMINAL_HANDLE })
    case 'dreamdesk_note': return request({ op: 'add', title: args.title, summary: args.summary, url: args.url, importance: args.importance, from: 'me' })
    case 'dreamdesk_done': return request({ op: 'done', id: args.id })
    case 'dreamdesk_snooze': return request({ op: 'snooze', id: args.id, minutes: args.minutes })
    case 'dreamdesk_set_pr': return request({ op: 'set_pr', id: args.id, prUrl: args.prUrl })
    default: throw new Error(`Unknown tool ${name}`)
  }
}

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`)

createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.id === undefined) return // notifications
  try {
    if (msg.method === 'initialize') {
      send({ id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'dreamdesk', version: '0.1.0' } } })
    } else if (msg.method === 'tools/list') {
      send({ id: msg.id, result: { tools: TOOLS } })
    } else if (msg.method === 'tools/call') {
      try {
        const text = await call(msg.params?.name, msg.params?.arguments)
        send({ id: msg.id, result: { content: [{ type: 'text', text }] } })
      } catch (err) {
        send({ id: msg.id, result: { content: [{ type: 'text', text: String(err.message ?? err) }], isError: true } })
      }
    } else if (msg.method === 'ping') {
      send({ id: msg.id, result: {} })
    } else {
      send({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } })
    }
  } catch (err) {
    send({ id: msg.id, error: { code: -32603, message: String(err) } })
  }
})
