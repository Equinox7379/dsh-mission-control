import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { apply } from '../lib/index.js'

const require = createRequire(import.meta.url)
const controllerRequire = createRequire(require.resolve('@deepseek-ai/dsh-api-session-controller'))
const { Context } = await import(pathToFileURL(controllerRequire.resolve('@deepseek-ai/cordis')).href)

test('official home resolver supports absent environment and takes precedence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mc-home-'))
  const previous = process.env.DSH_HOME
  try {
    for (const environment of [undefined, join(root, 'unused-env')]) {
      if (environment === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = environment
      const cleanup = []
      let called = 0
      await apply({
        dshHomePath() { called++; return root },
        effect(register) { cleanup.push(register()) },
        inject(dependencies) { assert.deepEqual(dependencies, ['webServer', 'sessionController', 'connection']) },
      })
      assert.equal(called, 1)
      for (const dispose of cleanup) await dispose()
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('invalid host-resolved home fails closed instead of using a different environment root', async () => {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = tmpdir()
  try {
    for (const home of ['', 'relative-home', undefined]) {
      await assert.rejects(apply({ dshHomePath: () => home }), /absolute resolved DSH_HOME/)
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('standalone hosts retain an explicit absolute environment fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mc-home-env-'))
  const previous = process.env.DSH_HOME
  const cleanup = []
  process.env.DSH_HOME = root
  try {
    await apply({ effect(register) { cleanup.push(register()) }, inject() {} })
  } finally {
    for (const dispose of cleanup) await dispose()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('official Cordis mounts Desktop routes with Connection admission on a synthetic home', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mc-desktop-home-'))
  const routes = new Map()
  const server = createServer((req, res) => {
    const handler = routes.get(req.url)
    if (handler) void handler(req, res)
    else { res.writeHead(404); res.end() }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  const root = new Context()
  root.provide('dshHomePath', () => home)
  root.provide('webServer', { port, register: route => {
    routes.set(route.path, route.handler)
    return () => routes.delete(route.path)
  } })
  root.provide('sessionController', { inspect: async () => ({ meta: { id: 'fixture' }, events: [] }) })
  root.provide('connection', { admit: req => req.headers.cookie === 'admitted' ? { peer: {} } : { rejection: 401 } })
  try {
    await root.plugin(apply)
    assert.deepEqual([...routes.keys()].sort(), ['/mission-control/api', '/mission-control/health'])
    const base = `http://127.0.0.1:${port}`
    assert.equal((await fetch(`${base}/mission-control/health`)).status, 403)
    assert.equal((await fetch(`${base}/mission-control/health`, { headers: { cookie: 'admitted' } })).status, 200)
  } finally {
    await root.fiber.dispose()
    await new Promise(resolve => server.close(resolve))
    await rm(home, { recursive: true, force: true })
  }
})
