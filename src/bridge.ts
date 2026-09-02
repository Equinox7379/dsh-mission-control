import { assertRpcRequest, assertRpcResponse, METHODS, PROTOCOL_FINGERPRINT, type RpcMethod } from './rpc-contracts.js'

const BRIDGE = 'dsh-desktop'
const VERSION = 1
const MAX_BYTES = 262_144
export { PROTOCOL_FINGERPRINT }
export { METHODS }
type Method = RpcMethod
type WebView = { postMessage(message: unknown): void; addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void; removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void }
type UiControl = { setOpen(open: boolean): void }

export interface BridgeStatus { state: 'edge-only' | 'handshaking' | 'ready' | 'degraded' | 'disposed'; accepted: Method[]; lastError?: string; pending: number }
export interface BrowserBridge { status(): BridgeStatus; dispose(): void }

const randomHex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (n) => n.toString(16).padStart(2, '0')).join('')
const exact = (value: unknown, required: string[], optional: string[] = []): value is Record<string, any> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value); const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key))
}
const validText = (value: string) => !/[\uD800-\uDFFF]/u.test(value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/gu, ''))
function safeValue(value: unknown, depth = 0): boolean {
  if (depth > 12) return false
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'string') return value.length <= 131072 && validText(value)
  if (typeof value === 'number') return Number.isSafeInteger(value)
  if (Array.isArray(value)) return value.length <= 500 && Reflect.ownKeys(value).every((key) => key === 'length' || (typeof key === 'string' && /^(0|[1-9]\d*)$/u.test(key))) && value.every((item) => safeValue(item, depth + 1))
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== 'string' || !validText(key)) return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return !!descriptor && descriptor.enumerable && 'value' in descriptor && safeValue(descriptor.value, depth + 1)
  })
}
function encode(message: unknown): string {
  if (!safeValue(message)) throw new Error('message.invalid')
  const json = JSON.stringify(message)
  if (new TextEncoder().encode(json).length > MAX_BYTES) throw new Error('message.too-large')
  return json
}
function decode(raw: unknown): Record<string, any> {
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    if (new TextEncoder().encode(raw).length > MAX_BYTES) throw new Error('message.too-large')
    parsed = JSON.parse(raw)
  }
  if (!safeValue(parsed) || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('message.invalid')
  return parsed as Record<string, any>
}
const listItems = (snapshot: any): any[] => {
  if (Array.isArray(snapshot)) return snapshot
  if (Array.isArray(snapshot?.items)) return snapshot.items
  if (Array.isArray(snapshot?.sessions)) return snapshot.sessions
  if (Array.isArray(snapshot?.ids) && snapshot?.byId && typeof snapshot.byId === 'object') return snapshot.ids.map((id: string) => snapshot.byId[id]).filter(Boolean)
  return []
}
const sessionId = (item: any) => String(item?.sessionId ?? item?.id ?? '')
const availableMethods = (ctx: any): Method[] => METHODS.filter((name) => {
  switch (name) {
    case 'session.list': case 'session.current': return Boolean(ctx.sessions?.list?.getSnapshot)
    case 'session.search': return typeof ctx.sessions?.search === 'function'
    case 'session.open': return typeof ctx.sessions?.open === 'function'
    case 'session.create-open': return typeof ctx.sessions?.create === 'function' && typeof ctx.sessions?.open === 'function'
    case 'workspace.list': return Boolean(ctx.workspaces?.list?.getSnapshot)
    case 'composer.replace-draft': return typeof ctx.sessions?.scope === 'function' && Boolean(ctx.conversation?.input?.for)
    case 'mission-control.open': case 'mission-control.close': return true
  }
})

async function dispatch(ctx: any, ui: UiControl, name: Method, payload: Record<string, any>, signal: AbortSignal): Promise<Record<string, unknown>> {
  assertRpcRequest(name, payload)
  switch (name) {
    case 'session.list': {
      if (!exact(payload, [])) throw new Error('message.invalid')
      await ctx.sessions.refresh?.()
      const snapshot = ctx.sessions.list.getSnapshot()
      const items = listItems(snapshot).slice(0, 200).map((item) => ({ sessionId: sessionId(item), running: Boolean(item?.running), blank: Boolean(item?.blank) })).filter((item) => item.sessionId)
      const current = snapshot?.currentSessionId ?? snapshot?.current?.sessionId ?? snapshot?.current
      return { items, ...(typeof current === 'string' && current ? { currentSessionId: current } : {}) }
    }
    case 'session.search': {
      if (!exact(payload, ['query']) || typeof payload.query !== 'string' || !payload.query.trim() || [...payload.query].length > 200) throw new Error('message.invalid')
      const result = await ctx.sessions.search(payload.query, signal)
      if (!result?.ok) throw new Error(String(result?.error?.code ?? 'session.search-failed'))
      const source = listItems(result.value).slice(0, 20)
      return { items: source.map((item) => ({ sessionId: sessionId(item), excerpt: String(item?.excerpt ?? item?.snippet ?? '').slice(0, 240) })).filter((item) => item.sessionId), hasMore: Boolean(result.value?.hasMore) }
    }
    case 'session.current': {
      if (!exact(payload, [])) throw new Error('message.invalid')
      const snapshot = ctx.sessions.list.getSnapshot(); const current = snapshot?.currentSessionId ?? snapshot?.current?.sessionId ?? snapshot?.current
      return typeof current === 'string' && current ? { sessionId: current } : {}
    }
    case 'session.open': {
      if (!exact(payload, ['sessionId']) || typeof payload.sessionId !== 'string' || !payload.sessionId) throw new Error('message.invalid')
      await ctx.sessions.open(payload.sessionId); return { sessionId: payload.sessionId }
    }
    case 'session.create-open': {
      if (!exact(payload, [], ['workspaceId', 'cwd']) || (payload.workspaceId !== undefined && typeof payload.workspaceId !== 'string') || (payload.cwd !== undefined && typeof payload.cwd !== 'string')) throw new Error('message.invalid')
      const created = await ctx.sessions.create({ ...(payload.workspaceId ? { workspaceId: payload.workspaceId } : {}), ...(payload.cwd ? { cwd: payload.cwd } : {}) })
      const id = sessionId(created) || (typeof created === 'string' ? created : '')
      if (!id) throw new Error('session.create-failed')
      try { await ctx.sessions.open(id) } catch { /* Preserve the created id so Desktop can recover without creating twice. */ }
      return { sessionId: id }
    }
    case 'workspace.list': {
      if (!exact(payload, [])) throw new Error('message.invalid')
      const snapshot = ctx.workspaces.list.getSnapshot(); const items = listItems(snapshot).slice(0, 500)
      return { items: items.map((item) => ({ workspaceId: String(item?.workspaceId ?? item?.id ?? ''), name: String(item?.name ?? item?.title ?? '') })).filter((item) => item.workspaceId) }
    }
    case 'composer.replace-draft': {
      if (!exact(payload, ['sessionId', 'text']) || typeof payload.sessionId !== 'string' || typeof payload.text !== 'string' || new TextEncoder().encode(payload.text).length > 131072) throw new Error('message.invalid')
      const scope = ctx.sessions.scope(payload.sessionId)
      if (!scope) throw new Error('session.not-found')
      ctx.conversation.input.for(scope).setDraft(payload.text)
      return { sessionId: payload.sessionId, newLength: [...payload.text].length }
    }
    case 'mission-control.open': if (!exact(payload, [])) throw new Error('message.invalid'); ui.setOpen(true); return { open: true }
    case 'mission-control.close': if (!exact(payload, [])) throw new Error('message.invalid'); ui.setOpen(false); return { open: false }
  }
}

export function installBrowserBridge(ctx: any, ui: UiControl): BrowserBridge {
  const webview: WebView | undefined = (globalThis as any).chrome?.webview
  let state: BridgeStatus = { state: webview ? 'handshaking' : 'edge-only', accepted: [], pending: 0 }
  if (!webview) return { status: () => ({ ...state }), dispose: () => { state = { ...state, state: 'disposed' } } }
  const generation = `gen-${randomHex(8)}`; const nonce = randomHex(16); const requestId = `req-${randomHex(16)}`
  const available = availableMethods(ctx)
  const offered = available.map((name) => ({ name, version: 1 }))
  const seen = new Set<string>(); const controllers = new Map<string, AbortController>()
  const post = (message: unknown) => webview.postMessage(JSON.parse(encode(message)))
  const base = { bridge: BRIDGE, v: VERSION, generation, nonce }
  const fail = (message: any, code: string, detail = 'Request failed') => post({ ...base, kind: 'response', id: message.id, name: message.name, ok: false, payload: {}, error: { code, message: detail.slice(0, 1024) } })
  const onMessage = async (event: { data: unknown }) => {
    let message: Record<string, any>
    try { message = decode(event.data) } catch { return }
    if (message.bridge !== BRIDGE || message.v !== VERSION || message.generation !== generation || message.nonce !== nonce) return
    if (state.state === 'handshaking' && message.kind === 'response' && message.id === requestId && message.name === 'bridge.handshake') {
      clearTimeout(deadline)
      const responseShape = exact(message, ['bridge','v','generation','nonce','kind','id','name','ok','payload'])
      const payloadShape = exact(message.payload, ['desktopVersion','protocolFingerprint','acceptedCapabilities','maxMessageBytes'])
      const capabilityShape = Array.isArray(message.payload?.acceptedCapabilities)
        && message.payload.acceptedCapabilities.length <= available.length
        && message.payload.acceptedCapabilities.every((item: any) => exact(item, ['name','version']) && typeof item.name === 'string' && available.includes(item.name as Method) && item.version === 1)
      if (!responseShape || message.ok !== true || !payloadShape || typeof message.payload.desktopVersion !== 'string' || message.payload.protocolFingerprint !== PROTOCOL_FINGERPRINT || message.payload.maxMessageBytes !== MAX_BYTES || !capabilityShape) {
        state = { state: 'degraded', accepted: [], pending: 0, lastError: message.error?.code ?? 'handshake.semantic-invalid' }; return
      }
      const accepted = message.payload.acceptedCapabilities.map((item: any) => item.name as Method)
      if (new Set(accepted).size !== accepted.length) { state = { state: 'degraded', accepted: [], pending: 0, lastError: 'handshake.semantic-invalid' }; return }
      state = { state: 'ready', accepted, pending: 0 }
      post({ ...base, kind: 'event', name: 'bridge.ready', payload: { state: 'ready' } }); return
    }
    if (state.state !== 'ready' || message.kind !== 'request' || typeof message.id !== 'string' || typeof message.name !== 'string' || !exact(message, ['bridge','v','generation','nonce','kind','id','name','payload'])) return
    if (!state.accepted.includes(message.name as Method)) return fail(message, 'capability.unavailable')
    if (seen.has(message.id) || seen.size >= 4096) return fail(message, seen.has(message.id) ? 'request.duplicate' : 'request.capacity')
    seen.add(message.id); const controller = new AbortController(); controllers.set(message.id, controller); state = { ...state, pending: controllers.size }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('request.timeout')) }, 15_000) })
      const payload = await Promise.race([dispatch(ctx, ui, message.name as Method, message.payload, controller.signal), timeout])
      assertRpcResponse(message.name as Method, payload)
      post({ ...base, kind: 'response', id: message.id, name: message.name, ok: true, payload })
    }
    catch (error: any) { fail(message, String(error?.message ?? 'internal').includes('.') ? String(error.message) : 'internal') }
    finally { if (timer) clearTimeout(timer); controllers.delete(message.id); state = { ...state, pending: controllers.size } }
  }
  webview.addEventListener('message', onMessage)
  const deadline = setTimeout(() => { if (state.state === 'handshaking') state = { state: 'degraded', accepted: [], pending: 0, lastError: 'handshake.timeout' } }, 10_000)
  post({ ...base, kind: 'request', id: requestId, name: 'bridge.handshake', payload: { pluginVersion: '0.1.0', protocolFingerprint: PROTOCOL_FINGERPRINT, certifiedDsh: { package: '@deepseek-ai/dsh', version: '0.1.2-alpha.3', sourceCommit: 'dd6322d604e00eec1ba5e0c8541159906a21094a' }, capabilities: offered } })
  return { status: () => ({ ...state, accepted: [...state.accepted] }), dispose: () => { clearTimeout(deadline); controllers.forEach((item) => item.abort()); controllers.clear(); webview.removeEventListener('message', onMessage); state = { state: 'disposed', accepted: [], pending: 0 } } }
}
