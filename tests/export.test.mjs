import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { applyCommand, createInitialState } from '../lib/domain.js'
import { buildExport, writeExport } from '../lib/export.js'

const run = (state, command) => applyCommand(state, state.revision, command)

test('export redacts local paths and writes only to an explicit absolute destination', async () => {
  const root = process.env.DSH_MC_TEST_TMP
  assert.ok(root?.startsWith('D:\\'), 'DSH_MC_TEST_TMP must be on D:')
  const dir = join(root, `export-${randomUUID()}`)
  await mkdir(dir, { recursive: true })
  try {
    let state = createInitialState()
    state = run(state, { type: 'project.create', projectId: 'project-main', title: 'Project' })
    state.projects['project-main'].rootPath = 'C:\\Users\\Example\\secret-project'
    state = run(state, { type: 'task.create', taskId: 'task-main', projectId: 'project-main', title: 'Task' })
    state = run(state, {
      type: 'evidence.append', evidenceId: 'evidence-main', taskId: 'task-main', evidenceType: 'artifact', status: 'pass',
      label: 'Artifact', summary: 'Created', locator: { kind: 'local-path', value: 'C:\\Users\\Example\\secret-project\\out.txt' },
      producer: { kind: 'dsh-plugin', name: 'dsh-mission-control' },
    })

    const preview = buildExport(state, true)
    assert.equal(preview.state.projects['project-main'].rootPath, 'secret-project')
    assert.equal(preview.state.evidence['evidence-main'].locator.value, 'out.txt')

    const result = await writeExport(state, dir, true)
    assert.ok(result.path.startsWith(dir))
    const written = JSON.parse(await readFile(result.path, 'utf8'))
    assert.equal(written.sourceStateRevision, state.revision)
    assert.equal(written.pathsRedacted, true)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
