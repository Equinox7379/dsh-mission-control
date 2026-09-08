import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { DomainError, type DomainCommand } from './domain.js'
import { buildExport, writeExport } from './export.js'
import type { AtomicStateStore } from './storage.js'
import { EXECUTION_METHODS } from './execution/http.js'
import { ExecutionError } from './execution/types.js'

const API_PATH = '/mission-control/api'
const HEALTH_PATH = '/mission-control/health'
const MAX_BODY = 262_144
const MAX_RESPONSE = 1_048_576
const REQUEST_ID = /^mc-[A-Za-z0-9._:-]{1,120}$/u
const MUTATIONS = new Set([
  'project.create', 'project.update', 'project.archive',
  'task.create', 'task.update', 'task.transition', 'task.bind-session', 'task.unbind-session', 'task.binding-repair',
  'run.create', 'run.update', 'approval.request', 'approval.decide', 'evidence.append', 'settings.update',
])
const READS = new Set(['system.status', 'state.snapshot', 'project.get', 'task.get', 'task.list', 'audit.page', 'export.preview'])

export interface HostApiOptions {
  execution?: { handle(method: string, args: unknown): Promise<unknown> }
  store: AtomicStateStore
  expectedHosts: ReadonlySet<string>
  expectedOrigins: ReadonlySet<string>
  csrf?: string
  version?: string
  certifiedDsh?: string
  protocolFingerprint?: string
  validateSession?: (sessionId: string, signal: AbortSignal) => Promise<boolean>
  exportDirectory?: string
}

const isObject = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: unknown, required: string[], optional: string[] = []): value is Record<string, any> => {
  if (!isObject(value)) return false
  const keys = Object.keys(value); const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key))
}
const loopback = (address?: string | null) => address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'

function send(res: ServerResponse, status: number, body: unknown) {
  let data = JSON.stringify(body)
  if (status < 400 && Buffer.byteLength(data) > MAX_RESPONSE) {
    status = 500
    data = JSON.stringify({ v: 1, requestId: 'mc-response', ok: false, error: { code: 'response-too-large', message: 'Mission Control response exceeded its limit.', retryable: false } })
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(data)
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const rawLength = req.headers['content-length']
  if (Array.isArray(rawLength)) throw new DomainError('invalid-envelope', 'content length is invalid')
  if (rawLength !== undefined) {
    const declared = Number(rawLength)
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_BODY) throw new DomainError('body-too-large', 'request body is too large')
  }
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY) throw new DomainError('body-too-large', 'request body is too large')
    chunks.push(buffer)
  }
  let parsed: unknown
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
  catch { throw new DomainError('invalid-json', 'invalid JSON') }
  if (!isObject(parsed)) throw new DomainError('invalid-envelope', 'request envelope must be an object')
  return parsed
}

const methodShape: Record<string, { required: string[]; optional?: string[] }> = {
  'project.create': { required: ['projectId', 'title'], optional: ['description', 'workspaceId'] },
  'project.update': { required: ['projectId', 'expectedEntityRevision'], optional: ['title', 'description', 'workspaceId'] },
  'project.archive': { required: ['projectId', 'expectedEntityRevision'] },
  'task.create': { required: ['taskId', 'projectId', 'title'], optional: ['objective', 'acceptanceCriteria', 'priority'] },
  'task.update': { required: ['taskId', 'expectedEntityRevision'], optional: ['title', 'objective', 'acceptanceCriteria', 'planMarkdown', 'priority', 'dependencies', 'requiredEvidence'] },
  'task.transition': { required: ['taskId', 'expectedEntityRevision', 'phase'], optional: ['blockedReason', 'actorRole'] },
  'task.bind-session': { required: ['taskId', 'expectedEntityRevision', 'sessionId'] },
  'task.unbind-session': { required: ['taskId', 'expectedEntityRevision'] },
  'task.binding-repair': { required: ['taskId', 'expectedEntityRevision', 'reason'], optional: ['sessionId'] },
  'run.create': { required: ['runId', 'taskId', 'expectedEntityRevision'], optional: ['sessionId'] },
  'run.update': { required: ['runId', 'expectedEntityRevision', 'status'], optional: ['resultSummary', 'failure'] },
  'approval.request': { required: ['approvalId', 'taskId', 'expectedEntityRevision', 'summary'] },
  'approval.decide': { required: ['approvalId', 'expectedEntityRevision', 'decision', 'actorRole'], optional: ['note'] },
  'evidence.append': { required: ['evidenceId', 'taskId', 'evidenceType', 'status', 'label', 'summary', 'producer'], optional: ['locator', 'sha256', 'redacted'] },
  'settings.update': { required: [], optional: ['ownerLabel'] },
}

function commandFor(method: string, args: unknown): DomainCommand {
  const shape = methodShape[method]
  if (!shape || !exact(args, shape.required, shape.optional ?? [])) throw new DomainError('invalid-arguments', 'method arguments are invalid')
  return { type: method, ...(args as object) } as DomainCommand
}

function publicError(error: unknown): { status: number; code: string; message: string; retryable: boolean } {
  if (error instanceof DomainError) {
    const status = error.code === 'revision-conflict' ? 409 : error.code === 'forbidden' ? 403 : error.code === 'not-found' ? 404 : error.code === 'body-too-large' || error.code === 'capacity' ? 413 : 400
    return { status, code: error.code, message: error.message.slice(0, 300), retryable: error.code === 'revision-conflict' }
  }
  return { status: 500, code: 'internal', message: 'Mission Control request failed', retryable: false }
}

function page<T>(items: T[], offset: number, limit: number) {
  const safeOffset = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 && limit <= 200 ? limit : 50
  return { items: items.slice(safeOffset, safeOffset + safeLimit), nextOffset: safeOffset + safeLimit < items.length ? safeOffset + safeLimit : undefined }
}

export function createHostApi(options: HostApiOptions) {
  const csrf = options.csrf ?? randomBytes(32).toString('base64url')
  const pluginVersion = options.version ?? '0.2.0'
  const certifiedDsh = options.certifiedDsh ?? '0.1.3-alpha.2'
  const protocolFingerprint = options.protocolFingerprint ?? 'unknown'

  const guardBase = (req: IncomingMessage, originRequired: boolean): string | null => {
    if (!loopback(req.socket.remoteAddress)) return 'loopback-required'
    if (!options.expectedHosts.has(String(req.headers.host ?? ''))) return 'host-refused'
    const origin = req.headers.origin
    if ((originRequired || origin !== undefined)
      && (Array.isArray(origin) || !options.expectedOrigins.has(String(origin ?? '')))) return 'origin-refused'
    if (req.headers['sec-fetch-site'] !== 'same-origin') return 'fetch-site-refused'
    return null
  }

  const success = (res: ServerResponse, requestId: string, result: unknown) => send(res, 200, { v: 1, requestId, ok: true, result })
  const failure = (res: ServerResponse, requestId: string, error: unknown) => {
    const safe = publicError(error)
    return send(res, safe.status, { v: 1, requestId, ok: false, error: { code: safe.code, message: safe.message, retryable: safe.retryable } })
  }

  return {
    csrf,
    async handler(req: IncomingMessage, res: ServerResponse) {
      const path = (req.url ?? '/').split('?', 1)[0]
      if (path !== HEALTH_PATH && path !== API_PATH) return send(res, 404, { ok: false, error: { code: 'route-not-found', message: 'Not found' } })
      const expectedMethod = path === HEALTH_PATH ? 'GET' : 'POST'
      if (req.method !== expectedMethod) return send(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Method not allowed' } })
      const baseError = guardBase(req, path === API_PATH)
      if (baseError) return send(res, 403, { ok: false, error: { code: baseError, message: 'Request refused' } })
       if (path === HEALTH_PATH) return send(res, 200, { ok: true, pluginVersion, apiVersion: 1, protocolFingerprint, certifiedDsh, storage: 'ready' })
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(String(req.headers['content-type'] ?? ''))) return send(res, 415, { ok: false, error: { code: 'content-type', message: 'application/json required' } })

      let requestId = 'mc-invalid'
      try {
        const envelope = await readBody(req)
        if (!exact(envelope, ['v', 'requestId', 'method', 'args'], ['expectedStateRevision']) || envelope.v !== 1 || typeof envelope.requestId !== 'string' || !REQUEST_ID.test(envelope.requestId) || typeof envelope.method !== 'string') throw new DomainError('invalid-envelope', 'request envelope is invalid')
        requestId = envelope.requestId
        const method = envelope.method
        const args = envelope.args
        if (method === 'system.handshake') {
          if (envelope.expectedStateRevision !== undefined || !exact(args, [])) throw new DomainError('invalid-arguments', 'method arguments are invalid')
          return success(res, requestId, { csrf, pluginVersion, apiVersion: 1, protocolFingerprint, stateRevision: options.store.snapshot().revision })
        }
        if (String(req.headers['x-mission-control-csrf'] ?? '') !== csrf) throw new DomainError('csrf-refused', 'Mission Control handshake is required')

        if (EXECUTION_METHODS.has(method)) {
          if (envelope.expectedStateRevision !== undefined) throw new DomainError('invalid-envelope', 'execution requests use their own preview and run identity')
          if (!options.execution) throw new DomainError('capability-unavailable', 'Task execution is unavailable')
          try { return success(res, requestId, await options.execution.handle(method, args)) }
          catch (error) {
            if (error instanceof ExecutionError) throw new DomainError(error.code, error.message)
            throw error
          }
        }
        const state = options.store.snapshot()
        if (READS.has(method)) {
          if (envelope.expectedStateRevision !== undefined) throw new DomainError('invalid-envelope', 'read request must not carry a revision precondition')
          switch (method) {
            case 'system.status':
              if (!exact(args, [])) throw new DomainError('invalid-arguments', 'method arguments are invalid')
              return success(res, requestId, { pluginVersion, apiVersion: 1, protocolFingerprint, certifiedDsh, storage: 'ready', stateRevision: state.revision })
            case 'state.snapshot':
              if (!exact(args, [])) throw new DomainError('invalid-arguments', 'method arguments are invalid')
              return success(res, requestId, state)
            case 'project.get': {
              if (!exact(args, ['projectId']) || typeof args.projectId !== 'string') throw new DomainError('invalid-arguments', 'method arguments are invalid')
              const project = state.projects[args.projectId]; if (!project) throw new DomainError('not-found', 'project not found')
              return success(res, requestId, project)
            }
            case 'task.get': {
              if (!exact(args, ['taskId']) || typeof args.taskId !== 'string') throw new DomainError('invalid-arguments', 'method arguments are invalid')
              const task = state.tasks[args.taskId]; if (!task) throw new DomainError('not-found', 'task not found')
              return success(res, requestId, task)
            }
            case 'task.list': {
              if (!exact(args, [], ['projectId']) || (args.projectId !== undefined && typeof args.projectId !== 'string')) throw new DomainError('invalid-arguments', 'method arguments are invalid')
              const projectId = args.projectId
              const items = Object.values(state.tasks).filter((item) => !projectId || item.projectId === projectId).sort((a, b) => b.updatedAt - a.updatedAt)
              return success(res, requestId, { items })
            }
            case 'audit.page': {
              if (!exact(args, [], ['offset', 'limit'])) throw new DomainError('invalid-arguments', 'method arguments are invalid')
              return success(res, requestId, page(state.audit, Number(args.offset ?? 0), Number(args.limit ?? 50)))
            }
            case 'export.preview': {
              if (!exact(args, [], ['redactPaths']) || (args.redactPaths !== undefined && typeof args.redactPaths !== 'boolean')) throw new DomainError('invalid-arguments', 'method arguments are invalid')
              return success(res, requestId, buildExport(state, args.redactPaths !== false))
            }
          }
        }

        if (method === 'export.write') {
          if (envelope.expectedStateRevision !== undefined) throw new DomainError('invalid-envelope', 'export request must not carry a revision precondition')
          if (!exact(args, [], ['destinationDirectory', 'redactPaths']) || (args.destinationDirectory !== undefined && typeof args.destinationDirectory !== 'string') || (args.redactPaths !== undefined && typeof args.redactPaths !== 'boolean')) throw new DomainError('invalid-arguments', 'method arguments are invalid')
          const destination = args.destinationDirectory ?? options.exportDirectory
          if (!destination) throw new DomainError('invalid-arguments', 'export destination is required')
          return success(res, requestId, await writeExport(state, destination, args.redactPaths !== false))
        }

        if (!MUTATIONS.has(method)) throw new DomainError('method-not-allowed', 'method is not allowed')
        const expectedStateRevision = envelope.expectedStateRevision
        if (typeof expectedStateRevision !== 'number' || !Number.isSafeInteger(expectedStateRevision) || expectedStateRevision < 0) throw new DomainError('invalid-envelope', 'mutation state revision is required')
        const command = commandFor(method, args)
        if (method === 'task.bind-session') {
          if (!options.validateSession) throw new DomainError('capability-unavailable', 'Session inspection is unavailable')
          const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 5000)
          try {
            if (!await options.validateSession((command as Extract<DomainCommand, { type: 'task.bind-session' }>).sessionId, controller.signal)) throw new DomainError('session-not-found', 'Session does not exist')
          } finally { clearTimeout(timer) }
        }
        const next = await options.store.execute(expectedStateRevision, command)
        return success(res, requestId, next)
      } catch (error) { return failure(res, requestId, error) }
    },
  }
}

export const missionControlRoutes = { api: API_PATH, health: HEALTH_PATH } as const
