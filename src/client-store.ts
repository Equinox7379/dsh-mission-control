import type { MissionControlStateV1 } from './domain.js'
import type { WorkCommand } from './workflow.js'

export interface ClientStoreSnapshot {
  phase: 'idle' | 'connecting' | 'ready' | 'error' | 'closed'
  state?: MissionControlStateV1
  error?: { code: string; message: string }
  conflict?: boolean
  host?: { pluginVersion: string; protocolFingerprint: string; certifiedDsh: string; storage: string }
}
type HostResponse = { v: 1; requestId: string; ok: true; result: any } | { v: 1; requestId: string; ok: false; error: { code: string; message: string; retryable?: boolean } }

/** Read lifetimes never cancel writes. A failed write is reported, never replayed. */
export class MissionControlClientStore {
  private value: ClientStoreSnapshot = { phase: 'idle' }
  private csrf = ''
  private listeners = new Set<() => void>()
  private closed = false
  private lifecycle = new AbortController()
  private connecting?: Promise<ClientStoreSnapshot>
  private mutationTail: Promise<void> = Promise.resolve()
  private generation = 0

  getSnapshot = (): ClientStoreSnapshot => this.value
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(next: ClientStoreSnapshot) {
    if (this.closed) return
    // A delayed read cannot roll the UI back behind an already acknowledged write.
    if (next.state && this.value.state && next.state.revision < this.value.state.revision) next = { ...next, state: this.value.state }
    this.value = next; this.listeners.forEach(listener => listener())
  }
  connect(): Promise<ClientStoreSnapshot> {
    if (this.closed) return Promise.resolve(this.value)
    if (this.connecting) return this.connecting
    const generation = ++this.generation
    const promise = this.connectOnce(generation)
    this.connecting = promise
    void promise.finally(() => { if (this.connecting === promise) this.connecting = undefined })
    return promise
  }
  private async connectOnce(generation: number): Promise<ClientStoreSnapshot> {
    this.publish({ ...this.value, phase: 'connecting', error: undefined, conflict: false })
    try {
      const response = await fetch('/mission-control/health', { method: 'GET', signal: AbortSignal.any([this.lifecycle.signal, AbortSignal.timeout(15_000)]), credentials: 'same-origin', cache: 'no-store' })
      const health = await response.json()
      if (!response.ok || health?.ok !== true || typeof health.pluginVersion !== 'string' || typeof health.protocolFingerprint !== 'string' || typeof health.certifiedDsh !== 'string' || health.storage !== 'ready') throw { code: 'handshake-failed', message: '任务服务尚未就绪。现有数据未被重置。' }
      const handshake = await this.call('system.handshake', {}, { csrf: false })
      if (typeof handshake.csrf !== 'string' || handshake.csrf.length < 32 || handshake.protocolFingerprint !== health.protocolFingerprint) throw { code: 'handshake-failed', message: '任务服务握手失败，请重新连接。' }
      if (this.closed || generation !== this.generation) return this.value
      this.csrf = handshake.csrf
      const state = await this.call('state.snapshot', {})
      if (!this.closed && generation === this.generation) this.publish({ phase: 'ready', state, host: { pluginVersion: health.pluginVersion, protocolFingerprint: health.protocolFingerprint, certifiedDsh: health.certifiedDsh, storage: health.storage } })
    } catch (error: any) {
      if (!this.closed && generation === this.generation) {
        this.csrf = ''; this.publish({ ...this.value, phase: 'error', error: this.safeError(error, '连接未完成，请稍后重新连接。') })
      }
    }
    return this.value
  }
  async refresh(): Promise<ClientStoreSnapshot> {
    if (this.closed) return this.value
    if (!this.csrf || this.value.phase !== 'ready') return this.connect()
    const generation = this.generation
    try {
      const state = await this.call('state.snapshot', {})
      if (generation === this.generation) this.publish({ ...this.value, state, error: undefined, conflict: false })
    } catch (error: any) {
      if (!this.closed && generation === this.generation) {
        if (error?.code === 'csrf-refused') { this.csrf = ''; return this.connect() }
        this.publish({ ...this.value, error: this.safeError(error, '刷新失败，仍保留上次读取的内容。') })
      }
    }
    return this.value
  }
  async read(method: string, args: Record<string, unknown> = {}): Promise<any> {
    if (!this.csrf || this.value.phase !== 'ready') throw { code: 'unavailable', message: '请先连接任务服务。' }
    return this.call(method, args)
  }
  mutate(command: WorkCommand): Promise<ClientStoreSnapshot> {
    const immutable = structuredClone(command)
    const result = this.mutationTail.then(() => this.mutateOnce(immutable))
    this.mutationTail = result.then(() => undefined, () => undefined)
    return result
  }
  private async mutateOnce(command: WorkCommand): Promise<ClientStoreSnapshot> {
    const current = this.value.state
    if (this.closed || this.value.phase !== 'ready' || !current || !this.csrf) throw { code: 'unavailable', message: '任务服务未连接，更改没有发送。' }
    const generation = this.generation
    const args = Object.fromEntries(Object.entries(command).filter(([key]) => key !== 'type'))
    try {
      const state = await this.call(command.type, args, { expectedStateRevision: current.revision })
      if (!this.closed && generation === this.generation) this.publish({ ...this.value, phase: 'ready', state, error: undefined, conflict: false })
      return this.value
    } catch (error: any) {
      if (this.closed) return this.value
      const safe = this.safeError(error, '无法确认本次更改是否已保存，请刷新核对。')
      if (safe.code === 'revision-conflict') {
        await this.refresh()
        this.publish({ ...this.value, conflict: true, error: safe })
      } else if (safe.code === 'csrf-refused') {
        this.csrf = ''; await this.connect()
        this.publish({ ...this.value, error: { code: safe.code, message: '宿主连接已更新。本次更改没有重试，请核对最新内容。' } })
      } else this.publish({ ...this.value, error: safe })
      return this.value
    }
  }
  async executionCall(method: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    if (this.closed || !this.csrf || this.value.phase !== 'ready') throw { code: 'execution.unavailable', message: '任务服务尚未连接，请先重新连接。' }
    try { return await this.call(method, args, { signal }) }
    catch (error: any) {
      if (error?.code === 'csrf-refused' && !signal?.aborted && !this.closed) {
        this.csrf = ''; await this.connect()
        throw { code: 'csrf-refused', message: '宿主连接已更新；本次运行操作没有自动重发。' }
      }
      throw error
    }
  }
  async writeExport(destinationDirectory?: string, redactPaths = true): Promise<{ path: string; sha256: string }> {
    return this.call('export.write', { ...(destinationDirectory ? { destinationDirectory } : {}), redactPaths })
  }
  close() {
    if (this.closed) return
    this.closed = true; ++this.generation; this.lifecycle.abort(); this.csrf = ''
    this.value = { phase: 'closed' }; this.listeners.forEach(listener => listener()); this.listeners.clear()
  }
  private safeError(error: any, fallback: string) { return { code: String(error?.code ?? 'network'), message: String(error?.message ?? fallback).slice(0,500) } }
  private async call(method: string, args: Record<string, unknown>, options: { signal?: AbortSignal; csrf?: boolean; expectedStateRevision?: number } = {}): Promise<any> {
    if (this.closed) throw { code: 'closed', message: '工作台已关闭。' }
    const requestId = `mc-${crypto.randomUUID()}`
    const envelope = { v: 1, requestId, method, args, ...(options.expectedStateRevision !== undefined ? { expectedStateRevision: options.expectedStateRevision } : {}) }
    const headers: Record<string,string> = { 'content-type': 'application/json' }
    if (options.csrf !== false) {
      if (!this.csrf) throw { code: 'csrf-refused', message: '请先重新连接任务服务。' }
      headers['x-mission-control-csrf'] = this.csrf
    }
    const signals = [this.lifecycle.signal, AbortSignal.timeout(15_000), ...(options.signal ? [options.signal] : [])]
    const response = await fetch('/mission-control/api', { method: 'POST', headers, body: JSON.stringify(envelope), signal: AbortSignal.any(signals), credentials: 'same-origin', cache: 'no-store' })
    let body: HostResponse
    try { body = await response.json() } catch { throw { code: 'invalid-response', message: '没有取得有效的服务回执，请核对当前状态。' } }
    if (!body || body.v !== 1 || body.requestId !== requestId || typeof body.ok !== 'boolean') throw { code: 'invalid-response', message: '服务回执与本次请求不匹配。' }
    if (body.ok === false) throw body.error
    if (!response.ok) throw { code: 'invalid-response', message: '服务返回了异常状态，请核对结果。' }
    return body.result
  }
}
