import type { DomainCommand, MissionControlStateV1 } from './domain.js'

export interface ClientStoreSnapshot {
  phase: 'idle' | 'connecting' | 'ready' | 'error' | 'closed'
  state?: MissionControlStateV1
  error?: { code: string; message: string }
  conflict?: boolean
  host?: { pluginVersion: string; protocolFingerprint: string; certifiedDsh: string; storage: string }
}

type HostResponse = { v: 1; requestId: string; ok: true; result: any } | { v: 1; requestId: string; ok: false; error: { code: string; message: string; retryable?: boolean } }

export class MissionControlClientStore {
  private value: ClientStoreSnapshot = { phase: 'idle' }
  private csrf = ''
  private readController?: AbortController
  private listeners = new Set<() => void>()
  private closed = false

  getSnapshot = (): ClientStoreSnapshot => this.value
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(next: ClientStoreSnapshot) { this.value = next; this.listeners.forEach((listener) => listener()) }

  async connect(): Promise<ClientStoreSnapshot> {
    if (this.closed) return this.value
    this.readController?.abort()
    const controller = new AbortController(); this.readController = controller
    this.publish({ ...this.value, phase: 'connecting', error: undefined, conflict: false })
    try {
      const healthResponse = await fetch('/mission-control/health', { method: 'GET', signal: controller.signal, credentials: 'same-origin', cache: 'no-store' })
      const health = await healthResponse.json()
      if (!healthResponse.ok || health?.ok !== true || typeof health.pluginVersion !== 'string' || typeof health.protocolFingerprint !== 'string' || typeof health.certifiedDsh !== 'string' || health.storage !== 'ready') throw { code: 'handshake-failed', message: 'Mission Control host unavailable' }
      const handshake = await this.call('system.handshake', {}, { signal: controller.signal, csrf: false })
      if (typeof handshake.csrf !== 'string' || handshake.csrf.length < 32 || handshake.protocolFingerprint !== health.protocolFingerprint) throw { code: 'handshake-failed', message: 'Mission Control handshake failed' }
      this.csrf = handshake.csrf
      const state = await this.call('state.snapshot', {}, { signal: controller.signal })
      if (controller.signal.aborted) return this.value
      this.publish({ phase: 'ready', state, conflict: false, host: { pluginVersion: health.pluginVersion, protocolFingerprint: health.protocolFingerprint, certifiedDsh: health.certifiedDsh, storage: health.storage } })
      return this.value
    } catch (error: any) {
      if (controller.signal.aborted) return this.value
      this.csrf = ''
      this.publish({ ...this.value, phase: 'error', error: this.safeError(error, 'Mission Control unavailable') })
      return this.value
    } finally { if (this.readController === controller) this.readController = undefined }
  }

  async refresh(): Promise<ClientStoreSnapshot> {
    if (!this.csrf) return this.connect()
    this.readController?.abort()
    const controller = new AbortController(); this.readController = controller
    try {
      const state = await this.call('state.snapshot', {}, { signal: controller.signal })
      if (!controller.signal.aborted) this.publish({ ...this.value, phase: 'ready', state, error: undefined, conflict: false })
    } catch (error: any) {
      if (!controller.signal.aborted) this.publish({ ...this.value, error: this.safeError(error, 'Refresh failed') })
    } finally { if (this.readController === controller) this.readController = undefined }
    return this.value
  }

  async read(method: string, args: Record<string, unknown> = {}): Promise<any> {
    if (!this.csrf || this.value.phase !== 'ready') throw new Error('Mission Control store is not ready')
    this.readController?.abort()
    const controller = new AbortController(); this.readController = controller
    try { return await this.call(method, args, { signal: controller.signal }) }
    finally { if (this.readController === controller) this.readController = undefined }
  }

  async mutate(command: DomainCommand): Promise<ClientStoreSnapshot> {
    const current = this.value.state
    if (this.value.phase !== 'ready' || !current || !this.csrf) throw new Error('Mission Control store is not ready')
    const args = Object.fromEntries(Object.entries(command).filter(([key]) => key !== 'type'))
    try {
      const state = await this.call(command.type, args, { expectedStateRevision: current.revision })
      this.publish({ ...this.value, phase: 'ready', state, error: undefined, conflict: false })
      return this.value
    } catch (error: any) {
      const safe = this.safeError(error, 'Mutation failed')
      if (safe.code === 'revision-conflict') {
        await this.refresh()
        const next = { ...this.value, conflict: true, error: safe }
        this.publish(next); return next
      }
      if (safe.code === 'csrf-refused') {
        this.csrf = ''
        await this.connect()
        const next = { ...this.value, error: { code: safe.code, message: 'Host restarted; state reloaded. Your change was not retried.' } }
        this.publish(next); return next
      }
      const next = { ...this.value, error: safe }
      this.publish(next); return next
    }
  }

  /** Separate request lifetime; observation never aborts a task mutation or resends an execution. */
  async executionCall(method: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    if (!this.csrf || this.value.phase !== 'ready') throw { code: 'execution.unavailable', message: '指挥台主机尚未连接，请先重新连接。' }
    try { return await this.call(method, args, { signal }) }
    catch (error: any) {
      if (error?.code === 'csrf-refused' && !signal?.aborted) {
        this.csrf = ''
        await this.connect()
        throw { code: 'csrf-refused', message: '主机连接已更新；本次运行操作没有自动重发。' }
      }
      throw error
    }
  }

  async writeExport(destinationDirectory?: string, redactPaths = true): Promise<{ path: string; sha256: string }> {
    return this.call('export.write', { ...(destinationDirectory ? { destinationDirectory } : {}), redactPaths })
  }

  close() {
    this.closed = true; this.readController?.abort(); this.readController = undefined; this.csrf = ''
    this.publish({ phase: 'closed' }); this.listeners.clear()
  }

  private safeError(error: any, fallback: string) {
    return { code: String(error?.code ?? 'network'), message: String(error?.message ?? fallback).slice(0, 500) }
  }

  private async call(method: string, args: Record<string, unknown>, options: { signal?: AbortSignal; csrf?: boolean; expectedStateRevision?: number } = {}): Promise<any> {
    const requestId = `mc-${crypto.randomUUID()}`
    const envelope = { v: 1, requestId, method, args, ...(options.expectedStateRevision !== undefined ? { expectedStateRevision: options.expectedStateRevision } : {}) }
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (options.csrf !== false) {
      if (!this.csrf) throw { code: 'csrf-refused', message: 'Mission Control handshake is required' }
      headers['x-mission-control-csrf'] = this.csrf
    }
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), 15_000)
    const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal
    try {
      const response = await fetch('/mission-control/api', { method: 'POST', headers, body: JSON.stringify(envelope), signal, credentials: 'same-origin', cache: 'no-store' })
      let body: HostResponse
      try { body = await response.json() } catch { throw { code: 'invalid-response', message: 'Invalid host response' } }
      if (!body || body.v !== 1 || body.requestId !== requestId || typeof body.ok !== 'boolean') throw { code: 'invalid-response', message: 'Host response correlation failed' }
      if (body.ok === false) throw body.error
      return body.result
    } finally { clearTimeout(timer) }
  }
}
