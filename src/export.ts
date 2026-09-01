import { createHash, randomUUID } from 'node:crypto'
import { access, link, mkdir, open, rm } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import type { MissionControlStateV1 } from './domain.js'

export interface MissionControlExportV1 {
  schemaVersion: 1
  exportedAt: string
  sourceStateRevision: number
  pathsRedacted: boolean
  stateSha256: string
  state: MissionControlStateV1
}

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

export function buildExport(state: MissionControlStateV1, redactPaths = true): MissionControlExportV1 {
  const copy = structuredClone(state)
  if (redactPaths) {
    for (const project of Object.values(copy.projects)) {
      if (project.rootPath) project.rootPath = basename(project.rootPath)
    }
    for (const evidence of Object.values(copy.evidence)) {
      if (evidence.locator?.kind === 'local-path') evidence.locator.value = basename(evidence.locator.value)
    }
  }
  const stateJson = JSON.stringify(copy)
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    sourceStateRevision: state.revision,
    pathsRedacted: redactPaths,
    stateSha256: digest(stateJson),
    state: copy,
  }
}

export async function writeExport(state: MissionControlStateV1, destinationDirectory: string, redactPaths = true): Promise<{ path: string; sha256: string }> {
  if (!isAbsolute(destinationDirectory)) throw new Error('export destination must be absolute')
  await mkdir(destinationDirectory, { recursive: true })
  const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/u, 'Z')
  const path = join(destinationDirectory, `MissionControl-export-${stamp}.json`)
  try { await access(path); throw new Error('export already exists') } catch (error: any) { if (error?.code !== 'ENOENT') throw error }
  const bytes = Buffer.from(`${JSON.stringify(buildExport(state, redactPaths), null, 2)}\n`, 'utf8')
  const temp = join(destinationDirectory, `.mission-control-export-${process.pid}-${randomUUID()}.tmp`)
  let handle
  try {
    handle = await open(temp, 'wx')
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close(); handle = undefined
    await link(temp, path)
    await rm(temp, { force: true })
    return { path, sha256: digest(bytes) }
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}
