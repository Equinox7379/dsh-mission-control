export const METHODS = [
  'session.list', 'session.search', 'session.current', 'session.open', 'session.create-open',
  'workspace.list', 'composer.replace-draft', 'mission-control.open', 'mission-control.close',
] as const
export const PROTOCOL_FINGERPRINT = '0b3eff804db7fdb24de345fd7d8c14abd0350a733c0a1f091d05b29098237756'

export type RpcMethod = typeof METHODS[number]

export interface RpcRequestMap {
  'session.list': Record<never, never>
  'session.search': { query: string }
  'session.current': Record<never, never>
  'session.open': { sessionId: string }
  'session.create-open': { workspaceId?: string; cwd?: string }
  'workspace.list': Record<never, never>
  'composer.replace-draft': { sessionId: string; text: string }
  'mission-control.open': Record<never, never>
  'mission-control.close': Record<never, never>
}

export interface RpcResponseMap {
  'session.list': { items: Array<{ sessionId: string; running: boolean; blank: boolean }>; currentSessionId?: string }
  'session.search': { items: Array<{ sessionId: string; excerpt: string }>; hasMore: boolean }
  'session.current': { sessionId?: string }
  'session.open': { sessionId: string }
  'session.create-open': { sessionId: string }
  'workspace.list': { items: Array<{ workspaceId: string; name: string }> }
  'composer.replace-draft': { sessionId: string; newLength: number }
  'mission-control.open': { open: true }
  'mission-control.close': { open: false }
}

const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: unknown, required: string[], optional: string[] = []): value is Record<string, any> => {
  if (!object(value)) return false
  const keys = Object.keys(value); const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key))
}
const validUnicode = (value: string) => !/[\uD800-\uDFFF]/u.test(value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/gu, ''))
const text = (value: unknown, maxCharacters: number, allowEmpty = false, maxBytes?: number): value is string =>
  typeof value === 'string' && validUnicode(value) && (allowEmpty || value.length > 0)
  && [...value].length <= maxCharacters && (maxBytes === undefined || new TextEncoder().encode(value).length <= maxBytes)
const sessionId = (value: unknown): value is string => text(value, 256)
const workspaceId = (value: unknown): value is string => text(value, 256)
const empty = (value: unknown) => exact(value, [])

export function assertRpcRequest<M extends RpcMethod>(method: M, value: unknown): void {
  let valid = false
  switch (method) {
    case 'session.list': case 'session.current': case 'workspace.list': case 'mission-control.open': case 'mission-control.close':
      valid = empty(value); break
    case 'session.search':
      valid = exact(value, ['query']) && text(value.query, 200); break
    case 'session.open':
      valid = exact(value, ['sessionId']) && sessionId(value.sessionId); break
    case 'session.create-open':
      valid = exact(value, [], ['workspaceId', 'cwd'])
        && (value.workspaceId === undefined || workspaceId(value.workspaceId))
        && (value.cwd === undefined || text(value.cwd, 4096)); break
    case 'composer.replace-draft':
      valid = exact(value, ['sessionId', 'text']) && sessionId(value.sessionId)
        && text(value.text, 131_072, true, 131_072); break
  }
  if (!valid) throw new Error('message.invalid')
}

export function assertRpcResponse<M extends RpcMethod>(method: M, value: unknown): void {
  let valid = false
  switch (method) {
    case 'session.list':
      valid = exact(value, ['items'], ['currentSessionId']) && Array.isArray(value.items) && value.items.length <= 200
        && value.items.every((item: unknown) => exact(item, ['sessionId', 'running', 'blank']) && sessionId(item.sessionId) && typeof item.running === 'boolean' && typeof item.blank === 'boolean')
        && (value.currentSessionId === undefined || sessionId(value.currentSessionId)); break
    case 'session.search':
      valid = exact(value, ['items', 'hasMore']) && Array.isArray(value.items) && value.items.length <= 20
        && value.items.every((item: unknown) => exact(item, ['sessionId', 'excerpt']) && sessionId(item.sessionId) && text(item.excerpt, 240, true))
        && typeof value.hasMore === 'boolean'; break
    case 'session.current':
      valid = exact(value, [], ['sessionId']) && (value.sessionId === undefined || sessionId(value.sessionId)); break
    case 'session.open': case 'session.create-open':
      valid = exact(value, ['sessionId']) && sessionId(value.sessionId); break
    case 'workspace.list':
      valid = exact(value, ['items']) && Array.isArray(value.items) && value.items.length <= 500
        && value.items.every((item: unknown) => exact(item, ['workspaceId', 'name']) && workspaceId(item.workspaceId) && text(item.name, 256, true)); break
    case 'composer.replace-draft':
      valid = exact(value, ['sessionId', 'newLength']) && sessionId(value.sessionId)
        && Number.isSafeInteger(value.newLength) && value.newLength >= 0 && value.newLength <= 131_072; break
    case 'mission-control.open':
      valid = exact(value, ['open']) && value.open === true; break
    case 'mission-control.close':
      valid = exact(value, ['open']) && value.open === false; break
  }
  if (!valid) throw new Error('message.invalid')
}
