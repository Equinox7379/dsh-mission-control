import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createHostApi } from '../lib/host-api.js'
import { isSessionNotFoundError } from '../lib/index.js'
import { AtomicStateStore } from '../lib/storage.js'

test('alpha.3 session not-found errors are recognized without message matching', () => {
  class ApiSessionNotFound extends Error {}
  assert.equal(isSessionNotFoundError(new ApiSessionNotFound('missing')), true)
  assert.equal(isSessionNotFoundError(Object.assign(new Error('missing'), { code: 'session/not-found' })), true)
  assert.equal(isSessionNotFoundError(new Error('session not found')), false)
})

test('Host API enforces same-origin handshake, CSRF, and state revisions', async () => {
  const root = process.env.DSH_MC_TEST_TMP
  assert.ok(root?.startsWith('D:\\'), 'DSH_MC_TEST_TMP must be on D:')
  const dir = join(root, `host-api-${randomUUID()}`)
  await mkdir(dir, { recursive: true })
  const store = new AtomicStateStore(join(dir, 'state.json'))
  await store.open()
  const expectedHosts = new Set()
  const expectedOrigins = new Set()
  const api = createHostApi({ store, expectedHosts, expectedOrigins, validateSession: async (id) => id === 'session-ok' })
  const server = createServer(api.handler)
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()))
  const address = server.address()
  const host = `127.0.0.1:${address.port}`
  const origin = `http://${host}`
  expectedHosts.add(host); expectedOrigins.add(origin)
  const headers = { host, origin, 'sec-fetch-site': 'same-origin' }
  const post = (body, csrf) => fetch(`${origin}/mission-control/api`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json', ...(csrf ? { 'x-mission-control-csrf': csrf } : {}) }, body: JSON.stringify(body),
  })

  try {
    const healthResponse = await fetch(`${origin}/mission-control/health`, { headers })
    const health = await healthResponse.json()
    assert.equal(healthResponse.status, 200)
    assert.equal(Object.hasOwn(health, 'csrf'), false)
    assert.equal(healthResponse.headers.get('access-control-allow-origin'), null)
    assert.equal(healthResponse.headers.get('cache-control'), 'no-store')
    assert.equal(healthResponse.headers.get('x-content-type-options'), 'nosniff')

    const wrongMethod = await fetch(`${origin}/mission-control/health`, { method: 'POST' })
    assert.equal(wrongMethod.status, 405)

    const wrongContentType = await fetch(`${origin}/mission-control/api`, {
      method: 'POST', headers: { ...headers, 'content-type': 'text/plain' }, body: '{}',
    })
    assert.equal(wrongContentType.status, 415)

    const handshakeResponse = await post({ v: 1, requestId: 'mc-handshake', method: 'system.handshake', args: {} })
    const handshake = await handshakeResponse.json()
    assert.equal(handshakeResponse.status, 200)
    assert.ok(handshake.result.csrf.length >= 32)

    const missingCsrf = await post({ v: 1, requestId: 'mc-no-csrf', method: 'state.snapshot', args: {} })
    const missingCsrfBody = await missingCsrf.json()
    assert.equal(missingCsrf.status, 400)
    assert.equal(missingCsrfBody.error.code, 'csrf-refused')

    const tooLarge = await fetch(`${origin}/mission-control/api`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'x-mission-control-csrf': handshake.result.csrf },
      body: JSON.stringify({ padding: 'x'.repeat(262_144) }),
    })
    assert.equal(tooLarge.status, 413)

    const forbidden = await fetch(`${origin}/mission-control/api`, {
      method: 'POST', headers: { ...headers, origin: 'http://127.0.0.1:1', 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, requestId: 'mc-forbidden', method: 'system.handshake', args: {} }),
    })
    assert.equal(forbidden.status, 403)

    const created = await post({ v: 1, requestId: 'mc-create-project', method: 'project.create', args: { projectId: 'project-main', title: 'Project' }, expectedStateRevision: 0 }, handshake.result.csrf)
    assert.equal(created.status, 200)

    const stale = await post({ v: 1, requestId: 'mc-stale', method: 'project.update', args: { projectId: 'project-main', expectedEntityRevision: 0, title: 'Changed' }, expectedStateRevision: 0 }, handshake.result.csrf)
    const staleBody = await stale.json()
    assert.equal(stale.status, 409)
    assert.equal(staleBody.error.code, 'revision-conflict')
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
