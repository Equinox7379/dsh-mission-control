import { isAbsolute, join } from 'node:path'
import { createHostApi, missionControlRoutes } from './host-api.js'
import { AtomicStateStore } from './storage.js'

export const inject: string[] = []

export async function apply(ctx: any): Promise<void> {
  const home = process.env.DSH_HOME
  if (!home || !isAbsolute(home)) throw new Error('dsh-mission-control requires an absolute DSH_HOME')
  const store = new AtomicStateStore(join(home, 'storages', 'dsh-mission-control', 'state-v1.json'))
  await store.open()
  ctx.effect(() => async () => { await store.close() }, 'dsh-mission-control: storage lifecycle')
  ctx.inject(['webServer'], (scope: any) => {
    const webServer = scope?.webServer ?? scope
    const port = Number(webServer?.port)
    if (!webServer?.register || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('dsh-mission-control requires a bound webServer')
    const authority = `127.0.0.1:${port}`
    const api = createHostApi({ store, expectedHosts: new Set([authority]), expectedOrigins: new Set([`http://${authority}`]), version: '0.1.0' })
    for (const [name, path] of Object.entries(missionControlRoutes)) {
      scope.effect(() => webServer.register({ name: `mission-control-${name}`, kind: 'exact', path, handler: api.handler }), `dsh-mission-control: ${path}`)
    }
  })
}

export * from './domain.js'
export * from './storage.js'
