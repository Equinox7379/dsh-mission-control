import test from 'node:test'
import assert from 'node:assert/strict'
import { MissionControlClientStore } from '../lib/client-store.js'

const fingerprint = '0b3eff804db7fdb24de345fd7d8c14abd0350a733c0a1f091d05b29098237756'
const state = (revision) => ({ schemaVersion: 1, revision, projects: {}, tasks: {}, runs: {}, approvals: {}, evidence: {}, audit: [], settings: {} })
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const success = (request, result) => json({ v: 1, requestId: request.requestId, ok: true, result })
const failure = (request, code, message, status = 400) => json({ v: 1, requestId: request.requestId, ok: false, error: { code, message } }, status)
const health = () => json({ ok: true, pluginVersion: '0.1.0', protocolFingerprint: fingerprint, certifiedDsh: '0.1.2-alpha.3', storage: 'ready' })

test('revision conflict refreshes authoritative state without retrying the mutation', async () => {
  const originalFetch = globalThis.fetch
  let snapshotCalls = 0; let mutationCalls = 0
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/health')) return health()
    const request = JSON.parse(options.body)
    if (request.method === 'system.handshake') return success(request, { csrf: 'c'.repeat(43), protocolFingerprint: fingerprint })
    if (request.method === 'state.snapshot') return success(request, state(snapshotCalls++ === 0 ? 0 : 1))
    mutationCalls += 1
    return failure(request, 'revision-conflict', 'state moved', 409)
  }
  const store = new MissionControlClientStore()
  try {
    assert.equal((await store.connect()).state.revision, 0)
    const result = await store.mutate({ type: 'project.create', projectId: 'project-main', title: 'Project' })
    assert.equal(mutationCalls, 1)
    assert.equal(result.conflict, true)
    assert.equal(result.state.revision, 1)
  } finally { store.close(); globalThis.fetch = originalFetch }
})

test('Host restart re-handshakes but never retries an uncertain mutation', async () => {
  const originalFetch = globalThis.fetch
  let snapshotCalls = 0; let handshakeCalls = 0; let mutationCalls = 0
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/health')) return health()
    const request = JSON.parse(options.body)
    if (request.method === 'system.handshake') { handshakeCalls += 1; return success(request, { csrf: String(handshakeCalls).repeat(43), protocolFingerprint: fingerprint }) }
    if (request.method === 'state.snapshot') return success(request, state(snapshotCalls++ === 0 ? 0 : 2))
    mutationCalls += 1
    return failure(request, 'csrf-refused', 'Host restarted', 400)
  }
  const store = new MissionControlClientStore()
  try {
    await store.connect()
    const result = await store.mutate({ type: 'project.create', projectId: 'project-main', title: 'Project' })
    assert.equal(mutationCalls, 1)
    assert.equal(handshakeCalls, 2)
    assert.equal(result.state.revision, 2)
    assert.match(result.error.message, /not retried/i)
  } finally { store.close(); globalThis.fetch = originalFetch }
})
