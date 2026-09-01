import type { DomainCommand, MissionControlStateV1 } from './domain.js'

export interface ClientStoreSnapshot {
  phase: 'idle' | 'connecting' | 'ready' | 'error' | 'closed'
  state?: MissionControlStateV1
  error?: { code: string; message: string }
  conflict?: boolean
}

export class MissionControlClientStore {
  private value: ClientStoreSnapshot = { phase: 'idle' }
  private csrf = ''
  private readController?: AbortController
  private listeners = new Set<() => void>()

  getSnapshot = (): ClientStoreSnapshot => this.value
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(next: ClientStoreSnapshot) { this.value = next; this.listeners.forEach((listener) => listener()) }

  async connect(): Promise<ClientStoreSnapshot> {
    this.readController?.abort(); const controller = new AbortController(); this.readController = controller
    this.publish({ ...this.value, phase: 'connecting', error: undefined, conflict: false })
    try {
      const health = await this.request('/mission-control/health', { method: 'GET', signal: controller.signal })
      if (controller.signal.aborted) return this.value
      if (!health?.ok || typeof health.csrf !== 'string') throw { code: 'handshake-failed', message: 'Mission Control host unavailable' }
      this.csrf = health.csrf
      const response = await this.request('/mission-control/api', {
        method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'state.snapshot', args: {}, revision: Number(health.revision ?? 0), csrf: this.csrf }),
      })
      if (controller.signal.aborted) return this.value
      if (!response?.ok || !response.state) throw response?.error ?? { code: 'snapshot-failed', message: 'State unavailable' }
      this.publish({ phase: 'ready', state: response.state, conflict: false }); return this.value
    } catch (error: any) {
      if (controller.signal.aborted) return this.value
      this.publish({ ...this.value, phase: 'error', error: { code: String(error?.code ?? 'network'), message: String(error?.message ?? 'Mission Control unavailable') } }); return this.value
    } finally { if (this.readController === controller) this.readController = undefined }
  }

  async mutate(command: DomainCommand): Promise<ClientStoreSnapshot> {
    const current = this.value.state
    if (this.value.phase !== 'ready' || !current) throw new Error('Mission Control store is not ready')
    try {
      const response = await this.request('/mission-control/api', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: command.type, args: Object.fromEntries(Object.entries(command).filter(([key]) => key !== 'type')), revision: current.revision, csrf: this.csrf }),
      })
      if (!response?.ok || !response.state) {
        const code = String(response?.error?.code ?? 'mutation-failed')
        if (code === 'revision-conflict') {
          const conflictError = { code, message: String(response?.error?.message ?? 'State changed; refreshed without applying your edit') }
          await this.connect()
          const refreshed = { ...this.value, conflict: true, error: conflictError }
          this.publish(refreshed)
          return refreshed
        }
        if (code === 'invalid-envelope' || code === 'origin-refused') this.csrf = ''
        throw response?.error ?? { code, message: 'Mutation failed' }
      }
      this.publish({ phase: 'ready', state: response.state, conflict: false }); return this.value
    } catch (error: any) {
      this.publish({ ...this.value, error: { code: String(error?.code ?? 'network'), message: String(error?.message ?? 'Mutation failed') } })
      return this.value
    }
  }

  close() { this.readController?.abort(); this.readController = undefined; this.csrf = ''; this.publish({ phase: 'closed' }); this.listeners.clear() }

  private async request(path: string, init: RequestInit): Promise<any> {
    const response = await fetch(path, { ...init, credentials: 'same-origin', cache: 'no-store' })
    let body: any
    try { body = await response.json() } catch { body = { ok: false, error: { code: 'invalid-response', message: 'Invalid host response' } } }
    if (!response.ok && !body?.error) throw { code: `http-${response.status}`, message: 'Mission Control request failed' }
    return body
  }
}
