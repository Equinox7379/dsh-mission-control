import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { DomainError, type DomainCommand } from './domain.js'
import type { AtomicStateStore } from './storage.js'

const API_PATH = '/mission-control/api'
const HEALTH_PATH = '/mission-control/health'
const MAX_BODY = 262_144
const MUTATIONS = new Set([
  'project.create', 'task.create', 'task.edit', 'task.transition', 'task.bind-session', 'task.unbind-session',
  'run.start', 'run.finish', 'approval.request', 'approval.decide', 'evidence.add', 'settings.update',
])

export interface HostApiOptions {
  store: AtomicStateStore
  expectedHosts: ReadonlySet<string>
  expectedOrigins: ReadonlySet<string>
  csrf?: string
  version?: string
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> => {
  if (!isObject(value)) return false
  const keys = Object.keys(value); const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key))
}
const loopback = (address?: string | null) => address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'

function send(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(data)
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const declared = Number(req.headers['content-length'] ?? 0)
  if (!Number.isFinite(declared) || declared < 0 || declared > MAX_BODY) throw new DomainError('body-too-large', 'request body is too large')
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length; if (size > MAX_BODY) throw new DomainError('body-too-large', 'request body is too large')
    chunks.push(buffer)
  }
  let parsed: unknown
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new DomainError('invalid-json', 'invalid JSON') }
  if (!isObject(parsed)) throw new DomainError('invalid-envelope', 'request envelope must be an object')
  return parsed
}

function requireArgs(method: string, args: unknown): DomainCommand | null {
  const required: Record<string, string[]> = {
    'project.create': ['id', 'name'], 'task.create': ['id', 'projectId', 'title'], 'task.edit': ['taskId'],
    'task.transition': ['taskId', 'status'], 'task.bind-session': ['taskId', 'sessionId'], 'task.unbind-session': ['taskId'],
    'run.start': ['id', 'taskId'], 'run.finish': ['runId', 'state'], 'approval.request': ['id', 'taskId'],
    'approval.decide': ['approvalId', 'decision', 'actorRole'], 'evidence.add': ['id', 'taskId', 'text'], 'settings.update': [],
  }
  const optional: Record<string, string[]> = {
    'task.create': ['acceptanceCriteria'], 'task.edit': ['title', 'acceptanceCriteria'], 'run.finish': ['summary'],
    'approval.request': ['note'], 'approval.decide': ['note'], 'settings.update': ['ownerLabel'],
  }
  if (!required[method] || !exact(args, required[method], optional[method] ?? [])) throw new DomainError('invalid-arguments', 'method arguments are invalid')
  return { type: method, ...(args as object) } as DomainCommand
}

function publicError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof DomainError) {
    const status = error.code === 'revision-conflict' ? 409 : error.code === 'forbidden' ? 403 : error.code === 'not-found' ? 404 : error.code === 'capacity' || error.code === 'body-too-large' ? 413 : 400
    return { status, code: error.code, message: error.message.slice(0, 300) }
  }
  return { status: 500, code: 'internal', message: 'Mission Control request failed' }
}

export function createHostApi(options: HostApiOptions) {
  const csrf = options.csrf ?? randomBytes(32).toString('base64url')
  const guardBase = (req: IncomingMessage): string | null => {
    if (!loopback(req.socket.remoteAddress)) return 'loopback-required'
    const host = String(req.headers.host ?? '')
    if (!options.expectedHosts.has(host)) return 'host-refused'
    const fetchSite = req.headers['sec-fetch-site']
    if (fetchSite !== 'same-origin') return 'fetch-site-refused'
    return null
  }
  return {
    csrf,
    async handler(req: IncomingMessage, res: ServerResponse) {
      const path = req.url ?? '/'
      if (path !== HEALTH_PATH && path !== API_PATH) return send(res, 404, { ok: false, error: { code: 'route-not-found', message: 'Not found' } })
      const baseError = guardBase(req); if (baseError) return send(res, 403, { ok: false, error: { code: baseError, message: 'Request refused' } })
      if (path === HEALTH_PATH) {
        if (req.method !== 'GET') return send(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Method not allowed' } })
        return send(res, 200, { ok: true, version: options.version ?? '0.1.0', revision: options.store.snapshot().revision, csrf })
      }
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Method not allowed' } })
      const origin = String(req.headers.origin ?? '')
      if (!options.expectedOrigins.has(origin)) return send(res, 403, { ok: false, error: { code: 'origin-refused', message: 'Request refused' } })
      if (String(req.headers['content-type'] ?? '').toLowerCase() !== 'application/json') return send(res, 415, { ok: false, error: { code: 'content-type', message: 'application/json required' } })
      try {
        const envelope = await readBody(req)
        if (!exact(envelope, ['method', 'args', 'revision', 'csrf']) || typeof envelope.method !== 'string' || !Number.isSafeInteger(envelope.revision) || envelope.csrf !== csrf) throw new DomainError('invalid-envelope', 'request envelope is invalid')
        const method = envelope.method
        if (method === 'state.snapshot') {
          if (!exact(envelope.args, [])) throw new DomainError('invalid-arguments', 'method arguments are invalid')
          return send(res, 200, { ok: true, state: options.store.snapshot() })
        }
        if (!MUTATIONS.has(method)) throw new DomainError('method-not-allowed', 'method is not allowed')
        const command = requireArgs(method, envelope.args)
        const state = await options.store.execute(envelope.revision as number, command!)
        return send(res, 200, { ok: true, state })
      } catch (error) {
        const safe = publicError(error)
        return send(res, safe.status, { ok: false, error: { code: safe.code, message: safe.message } })
      }
    },
  }
}

export const missionControlRoutes = { api: API_PATH, health: HEALTH_PATH } as const
