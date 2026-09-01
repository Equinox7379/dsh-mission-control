import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

test('built client loads with React 18 and completes the Desktop handshake', async () => {
  const require = createRequire(import.meta.url)
  const posted = []
  const disposers = []
  let listener
  let definition
  globalThis.window = globalThis
  globalThis.innerWidth = 1024
  globalThis.document = { createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild() {} } }
  globalThis.addEventListener = () => {}
  globalThis.removeEventListener = () => {}
  globalThis.chrome = { webview: {
    postMessage: (message) => posted.push(message),
    addEventListener: (_type, callback) => { listener = callback },
    removeEventListener: () => {},
  } }
  globalThis.__ModuleLoader__ = { load: (value) => { definition = value } }

  await import('../lib/client.js')
  const client = definition.factory((id) => require(id))
  const ctx = {
    effect(callback) { const dispose = callback(); if (typeof dispose === 'function') disposers.push(dispose) },
    slots: { inject(_name, callback) { return callback() }, register() { return () => {} } },
    sessions: {}, workspaces: {}, conversation: {},
  }
  client.apply(ctx)
  const handshake = posted[0]
  assert.equal(handshake.name, 'bridge.handshake')
  listener({ data: {
    bridge: handshake.bridge, v: handshake.v, generation: handshake.generation, nonce: handshake.nonce,
    kind: 'response', id: handshake.id, name: handshake.name, ok: true,
    payload: { desktopVersion: '0.7.4', protocolFingerprint: handshake.payload.protocolFingerprint, acceptedCapabilities: [{ name: 'mission-control.open', version: 1 }], maxMessageBytes: 262144 },
  } })
  await Promise.resolve()
  assert.equal(posted[1].name, 'bridge.ready')

  listener({ data: {
    bridge: handshake.bridge, v: handshake.v, generation: handshake.generation, nonce: handshake.nonce,
    kind: 'request', id: 'req-11111111111111111111111111111111', name: 'mission-control.open', payload: {},
  } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(posted[2].ok, true)
  assert.deepEqual(posted[2].payload, { open: true })
  disposers.reverse().forEach((dispose) => dispose())
})
