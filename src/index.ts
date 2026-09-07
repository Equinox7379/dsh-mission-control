import { isAbsolute, join } from 'node:path'
import { createHostApi, missionControlRoutes } from './host-api.js'
import { AtomicStateStore } from './storage.js'
import { PROTOCOL_FINGERPRINT } from './rpc-contracts.js'

export const inject: string[] = []

export function isSessionNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { code?: unknown; name?: unknown; constructor?: { name?: unknown } }
  return candidate.code === 'session-not-found'
    || candidate.code === 'session/not-found'
    || candidate.code === 'SESSION_QUERY_SESSION_NOT_FOUND'
    || candidate.name === 'ApiSessionNotFound'
    || candidate.constructor?.name === 'ApiSessionNotFound'
}

export async function apply(ctx: any): Promise<void> {
  // Official boot resolves the default ~/.dsh without materializing DSH_HOME.
  // Use its public resolver so the plugin shares the host's actual data root.
  const home = typeof ctx.dshHomePath === 'function' ? ctx.dshHomePath() : process.env.DSH_HOME
  if (typeof home !== 'string' || !home || !isAbsolute(home)) throw new Error('dsh-mission-control requires an absolute resolved DSH_HOME')
  const store = new AtomicStateStore(join(home, 'storages', 'dsh-mission-control', 'state-v1.json'))
  await store.open()
  ctx.effect(() => async () => { await store.close() }, 'dsh-mission-control: storage lifecycle')
  ctx.inject(['webServer', 'sessionController'], (scope: any) => {
    const webServer = scope?.webServer ?? scope
    const sessionController = scope?.sessionController
    const port = Number(webServer?.port)
    if (!webServer?.register || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('dsh-mission-control requires a bound webServer')
    if (!sessionController?.inspect) throw new Error('dsh-mission-control requires sessionController.inspect')
    const authority = `127.0.0.1:${port}`
    const exportDirectory = process.env.DSH_MISSION_CONTROL_EXPORT_DIR
      ?? join(process.env.USERPROFILE ?? home, 'Documents', 'DshMissionControlExports')
    const api = createHostApi({
      store,
      expectedHosts: new Set([authority]),
      expectedOrigins: new Set([`http://${authority}`]),
      version: '0.1.1',
      certifiedDsh: '0.1.2-alpha.4',
      protocolFingerprint: PROTOCOL_FINGERPRINT,
      exportDirectory,
      validateSession: async (sessionId, signal) => {
        try { await sessionController.inspect(sessionId, signal); return true }
        catch (error: any) {
          if (isSessionNotFoundError(error)) return false
          throw error
        }
      },
    })
    for (const [name, path] of Object.entries(missionControlRoutes)) {
      scope.effect(() => webServer.register({ name: `mission-control-${name}`, kind: 'exact', path, handler: api.handler }), `dsh-mission-control: ${path}`)
    }
  })
}

export * from './domain.js'
export * from './storage.js'
export * from './export.js'
export * from './session-saga.js'
export * from './rpc-contracts.js'
