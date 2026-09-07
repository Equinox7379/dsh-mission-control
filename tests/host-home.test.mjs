import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../lib/index.js'

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
        inject(dependencies) { assert.deepEqual(dependencies, ['webServer', 'sessionController']) },
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
