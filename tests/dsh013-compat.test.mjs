import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { releasedV2SessionFormatCodec as codec, restoreReleasedV2Artifact } from '@deepseek-ai/dsh-session-format-v1-to-v2'
import { createDsh013ExecutionPort } from '../lib/execution/dsh013.js'
import { TaskExecutionService } from '../lib/execution/runner.js'
import { ExecutionFile } from '../lib/execution/store.js'

const require = createRequire(import.meta.url)
const hostRequire = createRequire(require.resolve('@deepseek-ai/dsh-api-session-controller'))
const { Session, KNOWN_SESSION_EVENT_TYPES } = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-session')).href)
const { createUserMessage, createAssistantMessage, createToolResultMessage, AssistantStreamAccumulator } = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-llm')).href)
const tick = () => new Promise(resolve => setImmediate(resolve))

function fixture({ session: restored, saved, repository } = {}) {
  const session = restored ?? Session.create('session-013', [], {
    version: 2, id: 'session-013', createdAt: 1, cwd: '/work/project-013', isSeeded: false,
  })
  const agent = { id: session.id, status: 'idle', session, inbox: { nextTurn: [], nextStep: [] } }
  let subscriber, attached = true
  const calls = { prompts: [], cancels: [], queue: [], inspections: 0 }
  const task = { taskId: 'task-013', projectId: 'project-013', revision: 1, title: 'v2 fixture',
    objective: 'verify execution recovery', acceptanceCriteria: ['one request'], phase: 'draft',
    sessionBinding: { sessionId: session.id } }
  const source = { snapshot: () => ({ tasks: { [task.taskId]: structuredClone(task) }, projects: { [task.projectId]: { title: 'fixture' } } }) }
  const repo = repository ?? { data: saved ? structuredClone(saved) : { version: 1, runs: {} },
    async load() { return structuredClone(this.data) }, async save(value) { this.data = structuredClone(value) } }
  const services = { agents: { get: id => attached && id === session.id ? agent : undefined },
    workspaceRegistry: { list: () => [] }, agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'synthetic' }) } }
  const ctx = { get: name => services[name], on: (name, listener) => {
    assert.equal(name, 'session/event'); subscriber = listener; return () => { subscriber = undefined }
  } }
  const controller = {
    inspect: async id => { calls.inspections++; assert.equal(id, session.id); return { meta: session.header,
      inheritedEventCount: session.inheritedEventCount, events: session.snapshotEvents() } },
    resolveAgent: async id => { await tick(); assert.equal(id, session.id); attached = true; return { agent } },
    prompt: async request => { calls.prompts.push(structuredClone(request)); return { accepted: true } },
    cancel: request => { calls.cancels.push(request); return { accepted: true } },
    updateQueue: request => {
      calls.queue.push(request)
      for (const key of ['nextTurn','nextStep']) agent.inbox[key] = agent.inbox[key].filter(item => item.id !== request.itemId)
      return { accepted: true }
    },
  }
  const port = createDsh013ExecutionPort(ctx, controller)
  const service = new TaskExecutionService(source, repo, port)
  const emit = (type, data, surface = false) => {
    const event = surface ? session.append(type, data, { surfaceOp: 'append' }) : session.append(type, data)
    subscriber?.(session, event); return event
  }
  const human = requestId => createUserMessage({ source: { kind: 'user', rpcId: requestId }, content: [{ type: 'text', text: 'synthetic instruction' }] })
  const begin = async () => {
    const preview = await service.preview(task.taskId)
    const [a,b] = await Promise.all([service.start(preview.previewId,'intent-013'), service.start(preview.previewId,'intent-013')])
    assert.equal(a.runId,b.runId); await tick(); await service.status(task.taskId); return a
  }
  return { session, agent, task, source, repo, port, service, controller, calls, emit, human, begin,
    detach: () => { attached = false } }
}

function complete(f, requestId) {
  f.emit('turn/start', { turn: 1 })
  f.emit('user/message', f.human(requestId), true)
  f.emit('step/start', { turn: 1, step: 1 })
  const stream = new AssistantStreamAccumulator()
  stream.push({ time: 10, chunk: { type:'block-start', index:0, blockType:'text' } })
  stream.push({ time: 11, chunk: { type:'text-delta', index:0, text:'v2 ' } })
  stream.push({ time: 12, chunk: { type:'text-delta', index:0, text:'result' } })
  stream.push({ time: 13, chunk: { type:'block-end', index:0, block:{type:'text',text:'v2 result'} } })
  const call = {type:'tool-call',id:'call-013',name:'write',arguments:'{"fixture":true}'}
  stream.push({ time: 14, chunk: { type:'block-start',index:1,blockType:'tool-call' } })
  stream.push({ time: 15, chunk: { type:'tool-call-delta',index:1,id:call.id,name:call.name,argumentsDelta:call.arguments } })
  stream.push({ time: 16, chunk: { type:'block-end',index:1,block:call } })
  stream.push({ time: 17, chunk: { type:'finish', reason:{kind:'tool-calls'} } })
  f.emit('assistant/message', {turn:1,step:1,message:createAssistantMessage({source:{provider:'fixture',model:'synthetic'},content:[{type:'text',text:'v2 result'},call]}),stream:stream.snapshot()}, true)
  f.emit('tool/call', { turn: 1, step: 1, callId:call.id,name:call.name,arguments:call.arguments })
  f.emit('tool/result', { turn: 1, step: 1, message: createToolResultMessage({callId:call.id,content:[{type:'text',text:'written'}],isError:false}) }, true)
  f.emit('step/end', { turn:1,step:1 })
  f.emit('turn/end', { turn:1,reason:{kind:'completed'} })
}

async function reloadV2(session, directory) {
  const rows = [codec.encodeHeader({...session.header,delegationDepth:0},session.inheritedEventCount),
    ...session.snapshotEvents().map(event => codec.encodeEvent(event))]
  const file = join(directory,'synthetic-session-v2.jsonl')
  await writeFile(file,rows.map(row=>JSON.stringify(row)).join('\n')+'\n')
  const physical = (await readFile(file,'utf8')).trimEnd().split('\n').map(line=>JSON.parse(line))
  const decoder = codec.createDecoder(physical.shift(),'strict'), events = []
  const sink = {emitEvent:event=>events.push(event),emitRun:run=>events.push(...run.expand())}
  for (const row of physical) decoder.decodeRow(row,sink)
  const inheritedEventCount = decoder.finish(sink)
  const artifact = restoreReleasedV2Artifact({header:decoder.header,events,inheritedEventCount},KNOWN_SESSION_EVENT_TYPES)
  return Session.fromRestore(session.id,artifact.events,artifact.header,artifact.inheritedEventCount,'detached')
}

test('0.1.3 asynchronous Agent preparation finishes before inspection and one prompt admission', async () => {
  const f = fixture(); f.detach()
  try {
    const preparing = f.port.prepare(f.session.id)
    assert.equal(f.calls.inspections,0)
    const probe = await preparing
    assert.equal(probe.sessionId,f.session.id)
    const run = await f.begin()
    assert.equal(f.calls.prompts.length,1)
    assert.equal(f.calls.prompts[0].requestId,run.requestId)
    assert.equal(f.calls.prompts[0].mode,'queue')
  } finally { await f.service.close() }
})

test('0.1.3 queue cancellation preserves foreign pending and steered messages', async () => {
  const f = fixture()
  try {
    const old = f.human('old-request'), foreign = f.human('new-request'), steer = f.human('foreign-steer')
    f.agent.inbox.nextTurn = [foreign,old]; f.agent.inbox.nextStep = [steer]
    assert.equal(await f.port.stop({sessionId:f.session.id,requestId:'old-request'}),'queue-removed')
    assert.equal(f.calls.queue[0].itemId,old.id)
    assert.deepEqual(f.agent.inbox.nextTurn,[foreign]); assert.deepEqual(f.agent.inbox.nextStep,[steer])
    assert.equal(f.calls.cancels.length,0)
    await assert.rejects(f.port.send(f.session.id,'old-request','stale'),e=>e.code==='execution.changed-before-send')
    assert.equal(f.calls.prompts.length,0)
  } finally { await f.service.close() }
})

test('0.1.3 cancellation requires the current uniquely owned turn even after steering', async () => {
  const f = fixture()
  try {
    f.agent.status='running'; f.emit('turn/start',{turn:2}); f.emit('user/message',f.human('current'),true)
    await assert.rejects(f.port.stop({sessionId:f.session.id,requestId:'old',turn:1}),e=>e.code==='execution.not-owner')
    assert.equal(f.calls.cancels.length,0)
    assert.equal(await f.port.stop({sessionId:f.session.id,requestId:'current',turn:2}),'requested')
    f.emit('user/message',f.human('foreign-steer'),true)
    await assert.rejects(f.port.stop({sessionId:f.session.id,requestId:'current',turn:2}),e=>e.code==='execution.not-owner')
    assert.equal(f.calls.cancels.length,1)
  } finally { await f.service.close() }
})

test('official v2 Assistant codec survives cold inspect and host-index recovery without resending', async () => {
  const directory = await mkdtemp(join(tmpdir(),'mc-v2-')), f = fixture()
  let g
  try {
    const run = await f.begin(); await f.service.close()
    complete(f,run.requestId)
    const restored = await reloadV2(f.session,directory)
    assert.equal(restored.header.version,2)
    const assistant = restored.snapshotEvents().find(e=>e.type==='assistant/message')
    assert.ok(assistant.data.stream.some(record=>record.type==='text-chunks'))
    assert.equal(assistant.sourceEventSeqs,undefined)
    g = fixture({session:restored,saved:f.repo.data})
    const inspected = await g.port.inspect(restored.id)
    assert.equal(inspected.events.find(e=>e.type==='assistant/message').data.message.id,assistant.data.message.id)
    const view = await g.service.status(g.task.taskId)
    assert.equal(view.run.runId,run.runId); assert.equal(view.run.requestId,run.requestId)
    assert.equal(view.run.status,'completed'); assert.equal(view.run.output,'v2 result')
    assert.equal(view.run.tools[0].status,'returned'); assert.equal(view.run.toolErrors,0)
    assert.equal(g.calls.prompts.length,0)
    assert.ok(!JSON.stringify(g.repo.data).includes('text-chunks'))
    assert.ok(!JSON.stringify(g.repo.data).includes('fixture\\\":true'))
    const repeated = await g.service.status(g.task.taskId)
    assert.equal(repeated.run.runId,run.runId); assert.equal(g.calls.prompts.length,0)
  } finally { await f.service.close(); await g?.service.close(); await rm(directory,{recursive:true,force:true}) }
})

test('corrupt execution index cannot overwrite old task data or admit a replacement prompt', async () => {
  const directory = await mkdtemp(join(tmpdir(),'mc-v2-index-'))
  const file = join(directory,'execution-v1.json'); await writeFile(file,'{corrupt-v2-test')
  const f = fixture({repository:new ExecutionFile(file)})
  try {
    const before=f.source.snapshot()
    assert.equal((await f.service.status(f.task.taskId)).enabled,false)
    await assert.rejects(f.service.preview(f.task.taskId))
    assert.deepEqual(f.source.snapshot(),before)
    assert.equal(await readFile(file,'utf8'),'{corrupt-v2-test'); assert.equal(f.calls.prompts.length,0)
  } finally { await f.service.close(); await rm(directory,{recursive:true,force:true}) }
})
