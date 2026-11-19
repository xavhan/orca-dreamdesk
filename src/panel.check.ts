// `orca plugin check` renders the panel once per scenario with the worker on a fresh host.
import { defineCheck } from 'orca/testing'

const caps = ['settings:own', 'automation:read', 'automation:write', 'secrets:own', 'storage:own', 'agent:read', 'workspace:read', 'workspace:write', 'notifications:show']
const ws = { 'workspace.list': { workspaces: [], truncated: false } }
const item = (id: string, kind: string, source = 'slack') => ({ id, source, kind, title: `Item ${id}`, summary: 'Résumé', arrivedAt: 1, state: 'new' })

export default defineCheck({
  empty: { capabilities: caps, results: ws },
  router: {
    capabilities: caps,
    results: ws,
    storage: { queue: { items: { a: item('a', 'agent', 'agent'), b: item('b', 'mention'), c: item('c', 'ticket', 'linear') }, focus: null, alert: false } }
  },
  alert: {
    capabilities: caps,
    results: ws,
    storage: { queue: { items: { u: item('u', 'urgent'), c: { ...item('c', 'mention'), state: 'in_progress' } }, focus: { itemId: 'c', since: 1 }, alert: true } }
  }
})
