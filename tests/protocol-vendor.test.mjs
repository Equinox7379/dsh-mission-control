import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PROTOCOL_FINGERPRINT } from '../lib/rpc-contracts.js'

test('vendored Desktop contracts are complete and match the browser fingerprint', async () => {
  const root = join(process.cwd(), 'protocol-vendor', PROTOCOL_FINGERPRINT)
  const source = JSON.parse(await readFile(join(root, 'source.json'), 'utf8'))
  assert.equal(source.fingerprint, PROTOCOL_FINGERPRINT)
  assert.match(source.desktopCommit, /^[0-9a-f]{40}$/)
  assert.equal(source.files.filter((item) => item.path.startsWith('rpc-') && item.path.endsWith('.schema.json')).length, 9)
  assert.ok(source.files.some((item) => item.path.includes('/rpc-valid/')))
  assert.ok(source.files.some((item) => item.path.includes('/rpc-invalid/')))
  for (const item of source.files) {
    const bytes = await readFile(join(root, item.path))
    assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256, item.path)
  }
})
