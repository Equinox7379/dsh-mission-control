import test from 'node:test'
import assert from 'node:assert/strict'
import { assertRpcRequest, assertRpcResponse, METHODS } from '../lib/rpc-contracts.js'

test('browser RPC contracts cover all nine methods and reject shape, size, and Unicode drift', () => {
  const valid = {
    'session.list': [{}, { items: [{ sessionId: 'session-1', running: false, blank: true }] }],
    'session.search': [{ query: '记忆 🚀' }, { items: [{ sessionId: 'session-1', excerpt: '匹配' }], hasMore: false }],
    'session.current': [{}, {}],
    'session.open': [{ sessionId: 'session-1' }, { sessionId: 'session-1' }],
    'session.create-open': [{}, { sessionId: 'session-created' }],
    'workspace.list': [{}, { items: [{ workspaceId: 'workspace-1', name: '主工作区' }] }],
    'composer.replace-draft': [{ sessionId: 'session-1', text: '继续' }, { sessionId: 'session-1', newLength: 2 }],
    'mission-control.open': [{}, { open: true }],
    'mission-control.close': [{}, { open: false }],
  }
  assert.deepEqual(Object.keys(valid), [...METHODS])
  for (const method of METHODS) {
    assert.doesNotThrow(() => assertRpcRequest(method, valid[method][0]))
    assert.doesNotThrow(() => assertRpcResponse(method, valid[method][1]))
  }

  assert.throws(() => assertRpcRequest('session.open', { sessionId: 'session-1', extra: true }), /message.invalid/)
  assert.throws(() => assertRpcRequest('session.search', { query: null }), /message.invalid/)
  assert.throws(() => assertRpcRequest('composer.replace-draft', { sessionId: 'session-1', text: '\ud800' }), /message.invalid/)
  assert.throws(() => assertRpcRequest('composer.replace-draft', { sessionId: 'session-1', text: '😀'.repeat(32_769) }), /message.invalid/)
  assert.throws(() => assertRpcResponse('mission-control.open', { open: false }), /message.invalid/)
})
