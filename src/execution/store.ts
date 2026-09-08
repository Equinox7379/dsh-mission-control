import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ExecutionError, opaqueId, type ExecutionState, type ExecutionRepository } from './types.js'

/** A bounded last-run index. It does not read/write official Session files or legacy state-v1.json. */
export class ExecutionFile implements ExecutionRepository {
  constructor(private readonly path: string) {}
  async load(): Promise<ExecutionState> {
    try {
      const stat = await import('node:fs/promises').then(fs => fs.stat(this.path))
      if (stat.size > 8 * 1024 * 1024) throw new Error('oversized')
      const value = JSON.parse(await readFile(this.path, 'utf8'))
      const statuses = new Set(['dispatching','accepted','running','stopping','completed','failed','cancelled','interrupted','unconfirmed','detached'])
      if (value?.version !== 1 || !value.runs || typeof value.runs !== 'object' || Array.isArray(value.runs)
        || Object.keys(value.runs).length > 500) throw new Error('shape')
      for (const [taskId, raw] of Object.entries(value.runs)) {
        const run = raw as any
        if (!opaqueId(taskId) || run?.taskId !== taskId || !opaqueId(run.runId) || !opaqueId(run.requestId)
          || !opaqueId(run.intentId) || !opaqueId(run.sessionId) || !opaqueId(run.projectId)
          || !statuses.has(run.status) || !Number.isSafeInteger(run.baseSeq) || run.baseSeq < -1
          || !Number.isSafeInteger(run.cursor) || run.cursor < run.baseSeq || !Number.isSafeInteger(run.taskRevision)
          || typeof run.output !== 'string' || run.output.length > 6000 || !Array.isArray(run.tools) || run.tools.length > 40
          || typeof run.cwd !== 'string' || typeof run.model !== 'string' || typeof run.activity !== 'string'
          || !Number.isFinite(run.createdAt) || !Number.isFinite(run.updatedAt)) throw new Error('run')
      }
      return value
    } catch (error: any) {
      if (error?.code === 'ENOENT') return { version: 1, runs: {} }
      throw new ExecutionError('execution.storage-unavailable', '运行记录无法读取，未清空或覆盖原文件。')
    }
  }
  async save(state: ExecutionState): Promise<void> {
    const text = JSON.stringify(state)
    if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new ExecutionError('execution.capacity', '运行索引已达容量，请核对原会话；不会自动重发。')
    await mkdir(dirname(this.path), { recursive: true })
    const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    try { await writeFile(temp, text + '\n', { encoding: 'utf8', flag: 'wx' }); await rename(temp, this.path) }
    catch (error) { await rm(temp, { force: true }).catch(() => undefined); throw error }
  }
}
