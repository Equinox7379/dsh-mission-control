import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { applyCommand, createInitialState, type DomainCommand, type MissionControlStateV1, validateState } from './domain.js'

export interface StateIo {
  read(path: string): Promise<string>
  write(path: string, data: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  remove(path: string): Promise<void>
  ensureDir(path: string): Promise<void>
}

const nodeIo: StateIo = {
  read: (path) => readFile(path, 'utf8'),
  write: (path, data) => writeFile(path, data, { encoding: 'utf8', flag: 'wx' }),
  rename,
  remove: (path) => rm(path, { force: true }),
  ensureDir: (path) => mkdir(path, { recursive: true }).then(() => undefined),
}

export class AtomicStateStore {
  private state = createInitialState()
  private tail: Promise<void> = Promise.resolve()
  private closed = false
  constructor(private readonly statePath: string, private readonly io: StateIo = nodeIo) {}

  async open(): Promise<MissionControlStateV1> {
    await this.io.ensureDir(dirname(this.statePath))
    try { this.state = validateState(JSON.parse(await this.io.read(this.statePath))) }
    catch (error: any) {
      if (error?.code !== 'ENOENT') throw error
      await this.persist(this.state)
    }
    return this.snapshot()
  }

  snapshot(): MissionControlStateV1 { return structuredClone(this.state) }

  execute(expectedRevision: number, command: DomainCommand): Promise<MissionControlStateV1> {
    if (this.closed) return Promise.reject(new Error('store is closed'))
    let resolve!: (state: MissionControlStateV1) => void
    let reject!: (error: unknown) => void
    const result = new Promise<MissionControlStateV1>((ok, bad) => { resolve = ok; reject = bad })
    this.tail = this.tail.then(async () => {
      try {
        const next = applyCommand(this.state, expectedRevision, command)
        await this.persist(next)
        this.state = next
        resolve(this.snapshot())
      } catch (error) { reject(error) }
    })
    return result
  }

  async close(): Promise<void> { this.closed = true; await this.tail }

  private async persist(state: MissionControlStateV1): Promise<void> {
    const temp = `${this.statePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    try { await this.io.write(temp, `${JSON.stringify(state)}\n`); await this.io.rename(temp, this.statePath) }
    catch (error) { await this.io.remove(temp).catch(() => undefined); throw error }
  }
}
