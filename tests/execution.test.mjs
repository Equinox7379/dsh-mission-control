import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskExecutionService } from '../lib/execution/runner.js'
import { ExecutionFile } from '../lib/execution/store.js'
import { foldExecution, replayExecution } from '../lib/execution/fold.js'
import { buildTaskPrompt } from '../lib/execution/prompt.js'
import { executionApi } from '../lib/execution/http.js'
import { createAlpha4ExecutionPort } from '../lib/execution/alpha4.js'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const controllerRequire = createRequire(require.resolve('@deepseek-ai/dsh-api-session-controller'))
const { createToolResultMessage } = await import(pathToFileURL(controllerRequire.resolve('@deepseek-ai/dsh-llm')).href)
const { Context, Service } = await import(pathToFileURL(controllerRequire.resolve('@deepseek-ai/cordis')).href)

const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture(saved) {
  let clock = 100_000, callback
  const task = { taskId: 'task-one', projectId: 'project-one', revision: 2, title: '修复小项目', objective: '修改标题并运行真实测试', acceptanceCriteria: ['标题正确'], phase: 'draft', sessionBinding: { sessionId: 'session-one' } }
  const source = { snapshot: () => ({ tasks: { 'task-one': structuredClone(task) }, projects: { 'project-one': { title: '练习项目' } } }) }
  const repo = { data: saved ? structuredClone(saved) : {version:1,runs:{}}, fail:false, writes:0,
    async load(){return structuredClone(this.data)}, async save(state){if(this.fail)throw new Error('disk');this.data=structuredClone(state);this.writes++} }
  const live = { sessionId:'session-one', cwd:'/workspace/demo', model:'provider / model', running:false, queued:0,lastSeq:-1 }
  const calls = [], events = []
  const port = {
    capable:()=>true, probe:async()=>({...live}), prepare:async()=>({...live}), inspect:async()=>({events: [...events]}),
    send:async(...args)=>{ calls.push(args);return {accepted:true} },
    stop:async()=> 'requested', subscribe:fn=>{ callback=fn;return()=>{callback=undefined} },
  }
  const service = new TaskExecutionService(source, repo, port, ()=>clock, 50)
  const emit = (type,data) => { const event={type,data,seq:events.length,time:clock++};events.push(event);live.lastSeq=event.seq;callback?.(live.sessionId,event);return event }
  const begin = async(id='intent-one') => { const p=await service.preview(task.taskId); const r=await service.start(p.previewId,id);await tick();await service.status(task.taskId);return r }
  return { service,task,source,repo,port,live,calls,events,emit,begin,advance:(n)=>{clock+=n} }
}

test('preview uses saved task and bound workspace; creates no session or prompt', async()=>{
  const f=fixture();const p=await f.service.preview('task-one')
  assert.match(p.prompt,/修改标题并运行真实测试/);assert.match(p.prompt,/不提升权限/)
  assert.equal(p.cwd,'/workspace/demo');assert.equal(f.calls.length,0);assert.equal(f.task.phase,'draft')
  await f.service.close()
})
test('same intent and parallel starts submit exactly one official prompt', async()=>{
  const f=fixture();const p=await f.service.preview('task-one')
  const [a,b]=await Promise.all([f.service.start(p.previewId,'intent-one'),f.service.start(p.previewId,'intent-one')])
  await tick();assert.equal(a.runId,b.runId);assert.equal(f.calls.length,1)
  assert.equal(f.calls[0][0],'session-one');assert.equal(f.calls[0][1],a.requestId)
  assert.equal(f.task.phase,'draft');assert.equal((await f.service.status('task-one')).run.status,'accepted')
  await f.service.close()
})
test('different intent is blocked while a run is active', async()=>{
  const f=fixture();await f.begin();const p=await f.service.preview('task-one')
  await assert.rejects(f.service.start(p.previewId,'intent-two'),e=>e.code==='execution.busy')
  assert.equal(f.calls.length,1);await f.service.close()
})
test('write-before-send failure sends nothing', async()=>{
  const f=fixture();const p=await f.service.preview('task-one');f.repo.fail=true
  await assert.rejects(f.service.start(p.previewId,'intent-one'));await tick();assert.equal(f.calls.length,0)
  f.repo.fail=false;await f.service.close()
})
test('task revision, expired preview and changed session are rejected before send', async()=>{
  for(const mode of ['task','expired','model','busy']){
    const f=fixture();const p=await f.service.preview('task-one')
    if(mode==='task')f.task.revision++
    if(mode==='expired')f.advance(121000)
    if(mode==='model')f.live.model='other'
    if(mode==='busy')f.live.running=true
    await assert.rejects(f.service.start(p.previewId,'intent-one'));assert.equal(f.calls.length,0)
    await f.service.close()
  }
})
test('an official completed turn produces a model-labelled summary, not a test PASS', async()=>{
  const f=fixture();const r=await f.begin()
  f.emit('turn/start',{turn:3});f.emit('user/message',{source:{kind:'user',rpcId:r.requestId}})
  f.emit('tool/call',{turn:3,step:0,callId:'call-one',name:'shell',arguments:'PRIVATE RAW ARGUMENT'})
  f.emit('tool/result',{turn:3,step:0,message:{source:{kind:'tool',callId:'call-one'},content:[{text:'tests passed'}]}})
  f.emit('assistant/message',{turn:3,step:0,message:{content:[{type:'text',text:'已经修改标题，模型称测试通过。'}]}})
  f.emit('turn/end',{turn:3,reason:{kind:'completed'}})
  const {run}=await f.service.status('task-one')
  assert.equal(run.status,'completed');assert.equal(run.tools[0].status,'returned');assert.equal(run.toolCalls,1)
  assert.match(run.output,/模型称/);assert.equal(run.outputSeq,4)
  assert.ok(!JSON.stringify(run).includes('PRIVATE RAW ARGUMENT'));assert.equal(f.task.phase,'draft')
  await f.service.close()
})
test('another turn end or old output cannot complete this request',async()=>{
  const f=fixture();await f.begin();f.emit('turn/end',{turn:77,reason:{kind:'completed'}})
  assert.equal((await f.service.status('task-one')).run.status,'accepted');await f.service.close()
})
test('foreign user input detaches attribution and cannot cancel that turn',async()=>{
  const f=fixture();const r=await f.begin();let stops=0;f.port.stop=async()=>{stops++;return 'requested'}
  f.emit('turn/start',{turn:1});f.emit('user/message',{source:{kind:'user',rpcId:'foreign'}})
  assert.equal((await f.service.status('task-one')).run.status,'detached')
  await assert.rejects(f.service.stop('task-one',r.runId));assert.equal(stops,0);await f.service.close()
})
test('cancel receipt is stopping, never fake completed or process kill',async()=>{
  const f=fixture();const r=await f.begin();f.emit('turn/start',{turn:1});f.emit('user/message',{source:{kind:'user',rpcId:r.requestId}})
  await f.service.status('task-one');let stops=0;f.port.stop=async()=>{stops++;return 'requested'}
  assert.equal((await f.service.stop('task-one',r.runId)).status,'stopping')
  await f.service.stop('task-one',r.runId);assert.equal(stops,1)
  f.emit('turn/end',{turn:1,reason:{kind:'aborted',reason:{kind:'user'}}})
  assert.equal((await f.service.status('task-one')).run.status,'cancelled');await f.service.close()
})
test('queued cancellation removes only the owned queued request',async()=>{
  const f=fixture();const r=await f.begin();f.port.stop=async()=> 'queue-removed'
  assert.equal((await f.service.stop('task-one',r.runId)).status,'cancelled');await f.service.close()
})
test('uncertain admission is not resent; later correlated events can recover it',async()=>{
  const f=fixture();f.port.send=async(...args)=>{f.calls.push(args);throw new Error('transport ended')}
  const r=await f.begin();assert.equal((await f.service.status('task-one')).run.status,'unconfirmed')
  await f.service.start('expired-preview',r.intentId);assert.equal(f.calls.length,1)
  f.emit('turn/start',{turn:9});f.emit('user/message',{source:{kind:'user',rpcId:r.requestId}});f.emit('turn/end',{turn:9,reason:{kind:'completed'}})
  assert.equal((await f.service.status('task-one')).run.status,'completed');await f.service.close()
})
test('hanging admission stays unconfirmed; acknowledgement cannot release an outstanding send',async()=>{
  const f=fixture();let finish;f.port.send=(...args)=>{f.calls.push(args);return new Promise(r=>{finish=r})}
  const r=await f.begin();await new Promise(r=>setTimeout(r,65))
  assert.equal((await f.service.status('task-one')).run.status,'unconfirmed')
  await assert.rejects(f.service.acknowledge('task-one',r.runId),e=>e.code==='execution.still-active')
  finish({accepted:true});await tick();await f.service.close()
})
test('host restart reads prior events, never resends',async()=>{
  const f=fixture();const r=await f.begin();await f.service.close()
  const g=fixture(f.repo.data)
  g.events.push({type:'turn/start',seq:0,time:1,data:{turn:8}},
    {type:'user/message',seq:1,time:2,data:{source:{kind:'user',rpcId:r.requestId}}},
    {type:'assistant/message',seq:2,time:3,data:{turn:8,message:{content:[{type:'text',text:'原结果'}]}}},
    {type:'turn/end',seq:3,time:4,data:{turn:8,reason:{kind:'completed'}}})
  const view=await g.service.status('task-one');assert.equal(view.run.status,'completed');assert.equal(view.run.output,'原结果');assert.equal(g.calls.length,0)
  await g.service.close()
})
test('empty recovery becomes unconfirmed, not an automatic restart',async()=>{
  const f=fixture();await f.begin();await f.service.close();const g=fixture(f.repo.data)
  assert.equal((await g.service.status('task-one')).run.status,'unconfirmed');assert.equal(g.calls.length,0);await g.service.close()
})
test('service failure does not blank the legacy task source',async()=>{
  const f=fixture();f.repo.load=async()=>{throw new Error('corrupt')}
  const other=new TaskExecutionService(f.source,f.repo,f.port)
  const view=await other.status('task-one');assert.equal(view.enabled,false);assert.equal(f.source.snapshot().tasks['task-one'].title,'修复小项目')
  await other.close();await f.service.close()
})
test('API rejects extra fields, missing explicit acknowledgement, and arbitrary commands',async()=>{
  const f=fixture();const api=executionApi(f.service)
  await assert.rejects(api.handle('execution.start',{previewId:'p',intentId:'i',command:'rm'}))
  await assert.rejects(api.handle('execution.acknowledge',{taskId:'task-one',runId:'r',confirmed:false}))
  await assert.rejects(api.handle('execution.shell',{}));assert.equal(f.calls.length,0);await f.service.close()
})
test('file store survives restart and rejects corrupt files without replacement',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'mc-exec-'));try{
    const path=join(dir,'execution-v1.json');const file=new ExecutionFile(path)
    assert.deepEqual(await file.load(),{version:1,runs:{}})
    const f=fixture();const r=await f.begin();await file.save({version:1,runs:{'task-one':r}})
    assert.equal((await new ExecutionFile(path).load()).runs['task-one'].runId,r.runId)
    await writeFile(path,'{corrupt');await assert.rejects(file.load());assert.equal(await readFile(path,'utf8'),'{corrupt');await f.service.close()
  }finally{await rm(dir,{recursive:true,force:true})}
})
test('oversized goals fail before sending and closed tasks cannot start',async()=>{
  const f=fixture();f.task.objective='中'.repeat(20000);await assert.rejects(f.service.preview('task-one'))
  f.task.objective='goal';f.task.phase='done';await assert.rejects(f.service.preview('task-one'));assert.equal(f.calls.length,0);await f.service.close()
})

test('alpha.4 adapter calls official prompt exactly and removes only our inbox item',async()=>{
  let handler, sent, removed, cancelled=0
  const agent={id:'session-one',status:'idle',session:{header:{id:'session-one',cwd:'/work'},snapshotEvents:()=>[]},inbox:{nextTurn:[],nextStep:[]}}
  const controller={inspect:async()=>({meta:agent.session.header,events:[]}),resolveAgent:async()=>({agent}),
    prompt:async(req)=>{sent=req;return {accepted:true}},cancel:()=>{cancelled++;return{accepted:true}},updateQueue:req=>{removed=req;return{accepted:true}}}
  const ctx={agents:{get:()=>agent},on:(_name,cb)=>{handler=cb;return()=>{}},workspaceRegistry:{list:()=>[]},agentDefaultModel:{currentSelection:()=>({provider:'provider',model:'model'})}}
  const port=createAlpha4ExecutionPort(ctx,controller);assert.equal(port.capable(),true)
  await port.prepare('session-one');await port.send('session-one','rpc-one','payload',{baseSeq:-1,cwd:'/work'})
  assert.deepEqual(sent,{sessionId:'session-one',requestId:'rpc-one',mode:'queue',content:[{type:'text',text:'payload'}]})
  agent.inbox.nextTurn=[{id:'m-other',source:{kind:'user',rpcId:'other'}},{id:'m-own',source:{kind:'user',rpcId:'rpc-one'}}]
  assert.equal(await port.stop({sessionId:'session-one',requestId:'rpc-one'}),'queue-removed')
  assert.equal(removed.itemId,'m-own');assert.equal(cancelled,0)
})
test('alpha.4 adapter refuses cancel after another human instruction or turn completion',async()=>{
  let cancelled=0
  const events=[{seq:0,type:'turn/start',data:{turn:2}},{seq:1,type:'user/message',data:{source:{kind:'user',rpcId:'rpc-one'}}}]
  const agent={status:'running',session:{snapshotEvents:()=>events},inbox:{nextTurn:[],nextStep:[]}}
  const controller={cancel:()=>{cancelled++},inspect:async()=>({}),resolveAgent:async()=>({agent}),prompt(){},updateQueue(){}}
  const port=createAlpha4ExecutionPort({agents:{get:()=>agent},on:()=>()=>{}},controller)
  await port.stop({sessionId:'s',requestId:'rpc-one',turn:2});assert.equal(cancelled,1)
  events.push({seq:2,type:'user/message',data:{source:{kind:'user',rpcId:'other'}}})
  await assert.rejects(port.stop({sessionId:'s',requestId:'rpc-one',turn:2}));assert.equal(cancelled,1)
})
test('special project/session mismatch and subagent sessions are refused',async()=>{
  const f=fixture();f.live.origin='subagent';await assert.rejects(f.service.preview('task-one'))
  delete f.live.origin;f.source.snapshot=()=>({tasks:{'task-one':f.task},projects:{'project-one':{title:'p',workspaceId:'different'}}})
  await assert.rejects(f.service.preview('task-one'));assert.equal(f.calls.length,0);await f.service.close()
})

test('an orphaned turn without end becomes unconfirmed when DSH is idle',async()=>{
  const f=fixture();const r=await f.begin();f.emit('turn/start',{turn:1});f.emit('user/message',{source:{kind:'user',rpcId:r.requestId}})
  assert.equal((await f.service.status('task-one')).run.status,'running')
  f.advance(11000);assert.equal((await f.service.status('task-one')).run.status,'unconfirmed');assert.equal(f.calls.length,1);await f.service.close()
})
test('a stop before admission does not disable stopping the later real turn',async()=>{
  const f=fixture();let finish;f.port.send=(...args)=>{f.calls.push(args);return new Promise(resolve=>{finish=resolve})}
  const r=await f.begin();f.port.stop=async()=> 'already-idle'
  const uncertain=await f.service.stop('task-one',r.runId);assert.equal(uncertain.status,'unconfirmed');assert.equal(uncertain.stopRequestedAt,undefined)
  finish({accepted:true});await tick();f.emit('turn/start',{turn:2});f.emit('user/message',{source:{kind:'user',rpcId:r.requestId}});await f.service.status('task-one')
  let count=0;f.port.stop=async()=>{count++;return'requested'};await f.service.stop('task-one',r.runId);assert.equal(count,1);await f.service.close()
})
test('close during asynchronous load leaves no event listener behind',async()=>{
  let release, subscribed=0, unsubscribed=0
  const source={snapshot:()=>({tasks:{},projects:{}})}
  const repo={load:()=>new Promise(resolve=>{release=resolve}),save:async()=>{}}
  const port={capable:()=>true,subscribe:()=>{subscribed++;return()=>{unsubscribed++}}}
  const service=new TaskExecutionService(source,repo,port)
  const closing=service.close();release({version:1,runs:{}});await closing;assert.equal(subscribed,unsubscribed)
})
test('late admission completion after disposal cannot write state or send twice',async()=>{
  const f=fixture();let finish;f.port.send=(...args)=>{f.calls.push(args);return new Promise(resolve=>{finish=resolve})}
  await f.begin();await f.service.close();const count=f.repo.writes
  finish({accepted:true});await tick();assert.equal(f.repo.writes,count);assert.equal(f.calls.length,1)
})
test('alpha.4 admission guard rejects a raced session before prompt dispatch',async()=>{
  let calls=0
  const agent={id:'session-one',status:'running',session:{header:{cwd:'/work'},snapshotEvents:()=>[]},inbox:{nextTurn:[],nextStep:[]}}
  const controller={inspect(){},resolveAgent(){},prompt:()=>{calls++;return{accepted:true}},cancel(){},updateQueue(){}}
  const port=createAlpha4ExecutionPort({agents:{get:()=>agent},on:()=>()=>{}},controller)
  await assert.rejects(port.send('session-one','rpc-one','text',{baseSeq:-1,cwd:'/work'}),e=>e.code==='execution.changed-before-send')
  assert.equal(calls,0)
})
test('alpha.4 preview refuses the DSH data/profile directory as a project workspace',async()=>{
  const controller={inspect:async()=>({meta:{id:'s',cwd:'C:\\Users\\u\\.dsh\\profiles\\web'},events:[]})}
  const port=createAlpha4ExecutionPort({agents:{get:()=>undefined}},controller,'C:\\Users\\u\\.dsh')
  await assert.rejects(port.probe('s'),e=>e.code==='execution.protected-workspace')
})
test('task mutation during admission-record persistence is rejected before the external call',async()=>{
  const f=fixture();const p=await f.service.preview('task-one');const save=f.repo.save.bind(f.repo)
  f.repo.save=async state=>{await save(state);if(state.runs['task-one']?.status==='dispatching')f.task.revision++}
  await f.service.start(p.previewId,'intent-one');await tick()
  assert.equal(f.calls.length,0);assert.equal((await f.service.status('task-one')).run.status,'failed');await f.service.close()
})

test('official tool-result error blocks count permission refusals without structured event errors',async()=>{
  const f=fixture();const r=await f.begin()
  f.emit('turn/start',{turn:1});f.emit('user/message',{source:{kind:'user',rpcId:r.requestId}})
  f.emit('tool/call',{turn:1,step:0,callId:'call-denied',name:'write',arguments:'{}'})
  f.emit('tool/result',{turn:1,step:0,message:createToolResultMessage({callId:'call-denied',content:[{type:'text',text:'Error: permission denied'}],isError:true})})
  f.emit('turn/end',{turn:1,reason:{kind:'completed'}})
  const {run}=await f.service.status('task-one')
  assert.equal(run.toolErrors,1);assert.equal(run.tools[0].status,'error');assert.equal(run.status,'completed')
  assert.ok(!JSON.stringify(run).includes('permission denied'),'Do not duplicate raw tool output')
  await f.service.close()
})

test('new-session default model changes invalidate preview, preparation and final send without a prompt',async()=>{
  for(const stage of ['preview','prepare','persist']){
    const f=fixture();let selection={provider:'provider',model:'model-A',reasoningEffort:'low'}
    const agent={id:'session-one',status:'idle',session:{header:{id:'session-one',cwd:'/workspace/demo'},snapshotEvents:()=>[]},inbox:{nextTurn:[],nextStep:[]}}
    const changed=()=>{selection={...selection,model:stage==='persist'?'model-A':'model-B',reasoningEffort:'high'}}
    const controller={inspect:async()=>({meta:agent.session.header,events:[]}),resolveAgent:async()=>{if(stage==='prepare')changed();return{agent}},
      prompt:async(request)=>{f.calls.push(request);return{accepted:true}},cancel(){},updateQueue(){}}
    Object.assign(f.port,createAlpha4ExecutionPort({agents:{get:()=>agent},agentDefaultModel:{currentSelection:()=>selection},on:()=>()=>{}},controller))
    const preview=await f.service.preview('task-one');assert.equal(preview.model,'provider / model-A · low')
    if(stage==='preview')changed()
    if(stage==='persist'){
      const save=f.repo.save.bind(f.repo);f.repo.save=async state=>{await save(state);if(state.runs['task-one']?.status==='dispatching')changed()}
      await f.service.start(preview.previewId,'intent-one');await tick()
      assert.equal((await f.service.status('task-one')).run.status,'failed')
    }else await assert.rejects(f.service.start(preview.previewId,'intent-one'),e=>e.code==='execution.session-changed')
    assert.equal(f.calls.length,0,stage);await f.service.close()
  }
})

test('cold model preview preserves an unconsumed selection over other request headers',async()=>{
  const events=[{seq:0,type:'model/selection',data:{provider:'p',model:'chosen',reasoningEffort:'high'}},
    {seq:1,type:'request/header',data:{header:{config:{provider:'p',model:'previous'}}}}]
  let resumed=0
  const controller={inspect:async()=>({meta:{id:'s',cwd:'/work'},events}),resolveAgent:async()=>{resumed++}}
  const port=createAlpha4ExecutionPort({agents:{get:()=>undefined},agentDefaultModel:{currentSelection:()=>({provider:'p',model:'default'})}},controller)
  assert.equal((await port.probe('s')).model,'p / chosen · high')
  events.push({seq:2,type:'request/header',data:{header:{config:{provider:'p',model:'chosen',reasoningEffort:'high'}}}})
  assert.equal((await port.probe('s')).model,'p / chosen · high');assert.equal(resumed,0)
})

test('adapter initializes inside a real Cordis scope without requiring optional execution services',async()=>{
  const root=new Context()
  const agent={id:'s',status:'idle',session:{header:{id:'s',cwd:'/work'},snapshotEvents:()=>[]},inbox:{nextTurn:[],nextStep:[]}}
  const controller={inspect:async()=>({meta:agent.session.header,events:[]}),resolveAgent:async()=>({agent}),prompt(){},cancel(){},updateQueue(){}}
  await root.plugin(class extends Service {
    constructor(ctx){super(ctx,'agents')}
    get(){return agent}
  })
  await root.plugin(class extends Service {
    constructor(ctx){super(ctx,'agentDefaultModel')}
    currentSelection(){return{provider:'lab',model:'default'}}
  })
  root.provide('sessionController',controller)
  let port,dispose
  try{
    await root.inject(['sessionController'],scope=>{
      assert.throws(()=>scope.agents,/without inject/,'This must exercise the real framework boundary')
      port=createAlpha4ExecutionPort(scope,scope.sessionController)
      dispose=port.subscribe(()=>{})
    })
    assert.equal(port.capable(),true)
    assert.equal((await port.probe('s')).model,'lab / default')
  }finally{dispose?.();await root.fiber.dispose()}
})
