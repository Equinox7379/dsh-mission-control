import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { Readable } from 'node:stream'
import { createInitialState, applyCommand, validateState } from '../lib/domain.js'
import { applyWorkCommand } from '../lib/workflow.js'
import { AtomicStateStore } from '../lib/storage.js'
import { TaskExecutionService } from '../lib/execution/runner.js'
import { ExecutionFile } from '../lib/execution/store.js'
import { createDsh013ExecutionPort } from '../lib/execution/dsh013.js'
import { executionApi } from '../lib/execution/http.js'
import { createHostApi } from '../lib/host-api.js'
import { createOpenBindSession, unbindSession } from '../lib/session-saga.js'
import { MissionControlClientStore } from '../lib/client-store.js'
import { selectTasks, taskSignal } from '../lib/workbench/model.js'

const tick = () => new Promise(r => setImmediate(r))
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function stateFixture() {
  let s = createInitialState()
  for (const c of [
    { type:'project.create', projectId:'project-one',title:'合成项目' },
    { type:'task.create',taskId:'task-one',projectId:'project-one',title:'合成任务',objective:'不可泄露的合成目标',acceptanceCriteria:['检查结果'] },
    { type:'task.bind-session',taskId:'task-one',expectedEntityRevision:0,sessionId:'session-one' },
  ]) s=applyCommand(s,s.revision,c)
  return s
}
const accept = s => ({ type:'task.accept',taskId:'task-one',expectedEntityRevision:s.tasks['task-one'].revision,evidenceId:'evidence-accept',note:'我已核对文件与运行结果。',confirmed:true,actorRole:'owner' })
function memoryIo(initial) {
  const files=new Map(initial===undefined?[]:[['state.json',initial]]); const writes=[]
  return { files,writes,failBackup:false,failRename:false,
    async ensureDir(){}, async read(p){if(!files.has(p))throw Object.assign(new Error('missing'),{code:'ENOENT'});return files.get(p)},
    async write(p,v){if(this.failBackup&&p.includes('pre-migration'))throw new Error('backup failed');if(files.has(p))throw new Error('exclusive');files.set(p,v);writes.push(p)},
    async rename(a,b){if(this.failRename)throw new Error('rename failed');files.set(b,files.get(a));files.delete(a)},async remove(p){files.delete(p)} }
}
function executionFixture(saved) {
  let state=stateFixture(),clock=100000,listener
  const source={snapshot:()=>structuredClone(state)}
  const repo={ data:saved?structuredClone(saved):{version:1,runs:{}}, fail:false, writes:0,
    async load(){return structuredClone(this.data)},async save(s){if(this.fail)throw new Error('disk');this.data=structuredClone(s);this.writes++} }
  const live={ sessionId:'session-one',cwd:'/synthetic/work',model:'p / m',modelIdentity:'m',running:false,queued:0,lastSeq:-1 }
  const calls=[],events=[],stops=[]
  const port={ capable:()=>true,team:()=>live.team,probe:async()=>({...live}),prepare:async()=>({...live}),inspect:async()=>({events:[...events]}),
    send:async(...args)=>{calls.push(args);return {accepted:true}},stop:async r=>{stops.push(r);return 'requested'},subscribe:fn=>{listener=fn;return()=>{listener=undefined}} }
  const service=new TaskExecutionService(source,repo,port,()=>clock,12)
  return {service,source,repo,live,port,calls,events,stops,get state(){return state},set state(s){state=s},advance(n){clock+=n},
    emit(type,data){const e={type,data,seq:events.length,time:clock++};events.push(e);live.lastSeq=e.seq;listener?.(live.sessionId,e)},
    async begin(intent='intent-one'){const p=await service.preview('task-one');const r=await service.start(p.previewId,intent);await tick();await service.status('task-one');return r} }
}
async function tmp() {
  const root=process.env.DSH_MC_TEST_TMP
  assert.ok(root&&isAbsolute(root),'Provide an isolated absolute DSH_MC_TEST_TMP')
  assert.notEqual(resolve(root),resolve(homedir()))
  if(process.env.DSH_HOME)assert.ok(!resolve(root).startsWith(resolve(process.env.DSH_HOME)))
  await mkdir(root,{recursive:true});return mkdtemp(join(root,'redesign-'))
}

test('acceptance atomically records human evidence and done while retaining v1 and original state',()=>{
  const s=stateFixture(),original=JSON.stringify(s);const next=applyWorkCommand(s,s.revision,accept(s))
  assert.equal(JSON.stringify(s),original);assert.equal(next.schemaVersion,1);assert.equal(next.revision,s.revision+1)
  assert.equal(next.tasks['task-one'].phase,'done');assert.equal(next.tasks['task-one'].sessionBinding.sessionId,'session-one')
  assert.equal(next.evidence['evidence-accept'].producer.kind,'human');assert.equal(next.evidence['evidence-accept'].type,'manual-acceptance')
  assert.equal(next.audit.length,s.audit.length+2);assert.deepEqual(validateState(next),next)
})
for (const kind of ['confirmation','role','note','revision','duplicate']) test(`acceptance rejects invalid ${kind} without changing source`,()=>{
  const s=stateFixture(),c=accept(s),before=JSON.stringify(s)
  if(kind==='confirmation')c.confirmed=false;if(kind==='role')c.actorRole='plugin';if(kind==='note')c.note='';if(kind==='revision')c.expectedEntityRevision--
  if(kind==='duplicate'){const next=applyWorkCommand(s,s.revision,c);assert.throws(()=>applyWorkCommand(next,next.revision,{...c,expectedEntityRevision:next.tasks['task-one'].revision}));return}
  assert.throws(()=>applyWorkCommand(s,s.revision,c));assert.equal(JSON.stringify(s),before)
})
for(const state of ['pending','rejected'])test(`acceptance retains ${state} plan requirement`,()=>{
  let s=stateFixture();s=applyCommand(s,s.revision,{type:'task.transition',taskId:'task-one',expectedEntityRevision:1,phase:'planning'})
  s=applyCommand(s,s.revision,{type:'approval.request',approvalId:'approval-one',taskId:'task-one',expectedEntityRevision:2,summary:'计划'})
  if(state==='rejected')s=applyCommand(s,s.revision,{type:'approval.decide',approvalId:'approval-one',expectedEntityRevision:0,decision:'rejected',actorRole:'owner'})
  assert.throws(()=>applyWorkCommand(s,s.revision,accept(s)),e=>e.code==='approval-required')
})
test('required evidence and unfinished dependencies cannot be bypassed by manual acceptance',()=>{
  let s=stateFixture();s=applyCommand(s,s.revision,{type:'task.update',taskId:'task-one',expectedEntityRevision:1,requiredEvidence:['test']})
  assert.throws(()=>applyWorkCommand(s,s.revision,accept(s)),e=>e.code==='evidence-required')
  s=applyCommand(s,s.revision,{type:'evidence.append',taskId:'task-one',evidenceId:'evidence-test',evidenceType:'test',status:'pass',label:'测试',summary:'真实合成测试',producer:{kind:'human',name:'测试者'}})
  s=applyCommand(s,s.revision,{type:'task.create',taskId:'task-before',projectId:'project-one',title:'前置任务'})
  s=applyCommand(s,s.revision,{type:'task.update',taskId:'task-one',expectedEntityRevision:2,dependencies:['task-before']})
  assert.throws(()=>applyWorkCommand(s,s.revision,accept(s)),e=>e.code==='dependency-incomplete')
})
test('explicit reopen preserves binding, plan, evidence and approval history',()=>{
  let s=stateFixture();s=applyCommand(s,s.revision,{type:'task.update',taskId:'task-one',expectedEntityRevision:1,planMarkdown:'保留计划'})
  s=applyWorkCommand(s,s.revision,accept(s));const before=structuredClone(s)
  const next=applyWorkCommand(s,s.revision,{type:'task.reopen',taskId:'task-one',expectedEntityRevision:s.tasks['task-one'].revision,confirmed:true,actorRole:'owner'})
  assert.equal(next.tasks['task-one'].phase,'draft');assert.equal(next.tasks['task-one'].completedAt,undefined)
  assert.deepEqual(next.evidence,before.evidence);assert.deepEqual(next.approvals,before.approvals)
  assert.deepEqual(next.tasks['task-one'].sessionBinding,before.tasks['task-one'].sessionBinding);assert.equal(next.tasks['task-one'].planMarkdown,'保留计划')
})
test('duplicate audit IDs are rejected instead of silently accepted',()=>{const s=stateFixture();s.audit[1].auditId=s.audit[0].auditId;assert.throws(()=>validateState(s),e=>e.code==='state-malformed')})
test('valid v1 data loads without rewriting any bytes',async()=>{
  const raw=JSON.stringify(stateFixture(),null,3)+'\n';const io=memoryIo(raw),store=new AtomicStateStore('state.json',io)
  await store.open();await store.close();assert.equal(io.writes.length,0);assert.equal(io.files.get('state.json'),raw)
})
for(const raw of ['{bad','{"schemaVersion":999}',JSON.stringify({...stateFixture(),tasks:[]})])test('malformed data retains original bytes and performs no writes',async()=>{
  const io=memoryIo(raw),store=new AtomicStateStore('state.json',io);await assert.rejects(store.open());assert.equal(io.writes.length,0);assert.equal(io.files.get('state.json'),raw)
})
const legacy=()=>JSON.stringify({schemaVersion:1,revision:0,projects:{'project-old':{name:'旧项目',createdAt:'2026-01-01'}},tasks:{'task-old':{projectId:'project-old',title:'旧任务',status:'draft',sessionId:'session-old',acceptanceCriteria:'保持关联',createdAt:'2026-01-01'}},taskRuns:{},approvals:{},evidence:{},audit:[],settings:{}})
test('legacy migration preserves and reads back raw pre-migration file before replacement',async()=>{
  const raw=legacy(),io=memoryIo(raw),store=new AtomicStateStore('state.json',io);const s=await store.open()
  assert.equal(s.tasks['task-old'].sessionBinding.sessionId,'session-old');assert.equal(s.schemaVersion,1)
  const backups=[...io.files].filter(([p])=>p.includes('pre-migration'));assert.equal(backups.length,1);assert.equal(backups[0][1],raw)
  await store.close()
})
test('failed migration backup leaves original data and does not publish migrated state',async()=>{
  const raw=legacy(),io=memoryIo(raw);io.failBackup=true;const store=new AtomicStateStore('state.json',io)
  await assert.rejects(store.open(),/backup failed/);assert.equal(io.files.get('state.json'),raw);assert.equal(io.writes.length,0)
})
test('atomic acceptance write failure retains task and evidence together',async()=>{
  const raw=JSON.stringify(stateFixture()),io=memoryIo(raw),store=new AtomicStateStore('state.json',io);await store.open();io.failRename=true
  await assert.rejects(store.execute(store.snapshot().revision,accept(store.snapshot())))
  assert.equal(io.files.get('state.json'),raw);assert.equal(store.snapshot().tasks['task-one'].phase,'draft');assert.deepEqual(store.snapshot().evidence,{})
})
test('execution index corrupt JSON never becomes an empty persisted file',async()=>{
  const dir=await tmp(),path=join(dir,'execution-v1.json');await writeFile(path,'{"runs":broken');const file=new ExecutionFile(path)
  await assert.rejects(file.load(),e=>e.code==='execution.storage-unavailable');assert.equal(await readFile(path,'utf8'),'{"runs":broken')
})
test('same intent double click dispatches once; completed model turn does not accept task',async()=>{
  const f=executionFixture(),p=await f.service.preview('task-one');const [a,b]=await Promise.all([f.service.start(p.previewId,'intent-one'),f.service.start(p.previewId,'intent-one')]);await tick()
  assert.equal(a.runId,b.runId);assert.equal(f.calls.length,1)
  f.emit('turn/start',{turn:1});f.emit('user/message',{source:{kind:'user',rpcId:a.requestId}});f.emit('assistant/message',{turn:1,message:{content:[{type:'text',text:'模型称完成'}]}});f.emit('turn/end',{turn:1,reason:{kind:'completed'}})
  const v=await f.service.status('task-one');assert.equal(v.run.status,'completed');assert.equal(f.state.tasks['task-one'].phase,'draft');await f.service.close()
})
test('persistence failure before dispatch sends zero prompts',async()=>{
  const f=executionFixture(),p=await f.service.preview('task-one');f.repo.fail=true;await assert.rejects(f.service.start(p.previewId,'intent-one'));await tick();assert.equal(f.calls.length,0);f.repo.fail=false;await f.service.close()
})
test('timeout and host recreation retain uncertainty and never resend',async()=>{
  const f=executionFixture(),receipt=gate();f.port.send=async(...a)=>{f.calls.push(a);return receipt.promise};const r=await f.begin();await new Promise(r=>setTimeout(r,25))
  assert.equal((await f.service.status('task-one')).run.status,'unconfirmed');await f.service.close();const g=executionFixture(f.repo.data)
  assert.equal((await g.service.status('task-one')).run.status,'unconfirmed');assert.equal(g.calls.length,0);assert.equal(f.calls.length,1)
  receipt.resolve({accepted:true});await tick();assert.equal(f.stops.length,0);await g.service.close()
})
for(const mode of ['active','unconfirmed','team-busy','team-unavailable','queued','foreign-running'])test(`acceptance and binding guard rejects ${mode}`,async()=>{
  const f=executionFixture();if(mode==='active')await f.begin();if(mode==='unconfirmed'){f.port.send=async()=>{throw Error('lost')};await f.begin()}
  if(mode==='team-busy')f.live.team={state:'live',busy:true,members:[],pendingMessages:0,sessionId:'session-one'}
  if(mode==='team-unavailable')f.live.team={state:'unavailable',busy:false,members:[],pendingMessages:0,sessionId:'session-one'}
  if(mode==='queued')f.live.queued=1;if(mode==='foreign-running')f.live.running=true
  let writes=0;await assert.rejects(f.service.withIdleTask('task-one',async()=>{writes++}));assert.equal(writes,0);await f.service.close()
})
test('acceptance holds the same serialization lock as a competing start',async()=>{
  const f=executionFixture(),p=await f.service.preview('task-one'),saving=gate(),entered=gate()
  const acceptance=f.service.withIdleTask('task-one',async()=>{entered.resolve();await saving.promise;f.state=applyWorkCommand(f.state,f.state.revision,accept(f.state))})
  await entered.promise;const sending=f.service.start(p.previewId,'intent-two');const rejected=assert.rejects(sending,e=>e.code==='execution.task-closed')
  saving.resolve();await acceptance;await rejected;assert.equal(f.calls.length,0);await f.service.close()
})
test('completed Lead with busy Team stays in overview without exposing output or prompting',async()=>{
  const f=executionFixture(),r=await f.begin();f.emit('turn/start',{turn:1});f.emit('user/message',{source:{kind:'user',rpcId:r.requestId}});f.emit('assistant/message',{turn:1,message:{content:[{type:'text',text:'PRIVATE-OUTPUT'}]}});f.emit('turn/end',{turn:1,reason:{kind:'completed'}})
  f.live.team={state:'live',busy:true,members:[],pendingMessages:1,sessionId:'session-one'}
  const overview=await f.service.overview();assert.equal(overview.activeTaskId,'task-one');assert.equal(overview.runs[0].teamBusy,true);assert.ok(!JSON.stringify(overview).includes('PRIVATE-OUTPUT'))
  await assert.rejects(f.service.preview('task-one'));assert.equal(f.calls.length,1);await f.service.close()
})
test('unknown ownership cannot stop foreign work and plugin close never calls stop',async()=>{
  const f=executionFixture(),r=await f.begin();f.emit('turn/start',{turn:1});f.emit('user/message',{source:{kind:'user',rpcId:'foreign'}})
  await f.service.status('task-one');await assert.rejects(f.service.stop('task-one',r.runId));await f.service.close();assert.equal(f.stops.length,0)
})
test('manual release requires idle Lead and Team; never resends',async()=>{
  const f=executionFixture();f.port.send=async()=>{throw Error('lost')};const r=await f.begin();f.live.team={state:'live',busy:true,members:[],pendingMessages:1}
  await assert.rejects(f.service.acknowledge('task-one',r.runId));f.live.team.busy=false
  const released=await f.service.acknowledge('task-one',r.runId);assert.ok(released.releasedAt);assert.equal(f.calls.length,0);assert.equal(f.stops.length,0);await f.service.close()
})
test('rc.2 adapter cold reads do not wake a Team and remove only the owned queue message',async()=>{
  const requests=[],events=[];let warm=false
  const agent={id:'s',status:'idle',session:{header:{id:'s',cwd:'/work'},snapshotEvents:()=>events},inbox:{nextTurn:[{id:'mine',source:{kind:'user',rpcId:'rpc'}},{id:'other',source:{kind:'user',rpcId:'foreign'}}],nextStep:[]}}
  const controller={inspect:async()=>({meta:agent.session.header,events}),resolveAgent:async()=>{throw Error('must not resume')},prompt(){throw Error('must not prompt')},cancel(){throw Error('must not cancel')},updateQueue:async r=>requests.push(r)}
  const port=createDsh013ExecutionPort({get:n=>({agents:{get:()=>warm?agent:undefined},agentTeams:{membership:()=>({role:'lead',root:agent,id:'s'}),listMembers:()=>[]},agentDefaultModel:{currentSelection:()=>({provider:'p',model:'m'})}}[n]),on:()=>()=>{}},controller)
  assert.equal(port.team('s').state,'inactive');await port.probe('s');assert.equal(warm,false);warm=true
  assert.equal(await port.stop({sessionId:'s',requestId:'rpc'}),'queue-removed');assert.equal(requests.length,1);assert.equal(requests[0].itemId,'mine')
})

async function request(api,method,args={},options={}) {
  const envelope={v:1,requestId:'mc-test',method,args,...(options.revision===undefined?{}:{expectedStateRevision:options.revision})}
  const req=Readable.from([Buffer.from(JSON.stringify(envelope))]);req.url='/mission-control/api';req.method='POST';req.socket={remoteAddress:'127.0.0.1'}
  req.headers={host:'127.0.0.1:31980',origin:'http://127.0.0.1:31980','sec-fetch-site':'same-origin','content-type':'application/json','x-mission-control-csrf':'test-csrf',cookie:'fixture-auth',...options.headers}
  if(options.remote)req.socket.remoteAddress=options.remote
  let status,body;const res={writeHead(s){status=s},end(data){body=JSON.parse(data)}};await api.handler(req,res);return {status,body}
}
async function apiFixture() {
  const store=new AtomicStateStore('state.json',memoryIo(JSON.stringify(stateFixture())));await store.open()
  let guardCalls=0,refuse=false
  const api=createHostApi({store,expectedHosts:new Set(['127.0.0.1:31980']),expectedOrigins:new Set(['http://127.0.0.1:31980']),csrf:'test-csrf',authenticate:r=>r.headers.cookie==='fixture-auth',execution:{handle:async()=>({runs:[],enabled:true}),guardTask:async(id,work)=>{guardCalls++;if(refuse)throw Error('guard failed');return work()}}})
  return {store,api,get guardCalls(){return guardCalls},set refuse(v){refuse=v}}
}
for(const [label,headers,remote]of [
 ['wrong origin',{origin:'https://evil.invalid'}],['missing csrf',{'x-mission-control-csrf':undefined}],['wrong host',{host:'example.invalid'}],['no official authentication',{cookie:undefined}],['cross site',{'sec-fetch-site':'cross-site'}],['non loopback',{},'192.0.2.3'],
])test(`Host guard refuses ${label} without mutating`,async()=>{
  const f=await apiFixture(),s=f.store.snapshot();const r=await request(f.api,'task.accept',Object.fromEntries(Object.entries(accept(s)).filter(([k])=>k!=='type')),{headers,remote,revision:s.revision})
  assert.ok(r.status>=400);assert.deepEqual(f.store.snapshot(),s);assert.equal(f.guardCalls,0)
})
test('official authenticated Desktop proxy may omit Origin only with valid admission; accept runs under guard',async()=>{
  const f=await apiFixture(),s=f.store.snapshot();const args=Object.fromEntries(Object.entries(accept(s)).filter(([k])=>k!=='type'))
  const r=await request(f.api,'task.accept',args,{headers:{origin:undefined,'sec-fetch-site':undefined},revision:s.revision})
  assert.equal(r.status,200);assert.equal(r.body.result.tasks['task-one'].phase,'done');assert.equal(f.guardCalls,1)
})
test('unknown acceptance fields and missing confirmation cannot enter domain mutation',async()=>{
  const f=await apiFixture(),s=f.store.snapshot(),args=Object.fromEntries(Object.entries(accept(s)).filter(([k])=>k!=='type'))
  assert.equal((await request(f.api,'task.accept',{...args,unsafe:true},{revision:s.revision})).status,400)
  delete args.confirmed;assert.equal((await request(f.api,'task.accept',args,{revision:s.revision})).status,400);assert.deepEqual(f.store.snapshot(),s)
})
test('Host cannot accept when execution guard fails or is unavailable',async()=>{
  const f=await apiFixture(),s=f.store.snapshot(),args=Object.fromEntries(Object.entries(accept(s)).filter(([k])=>k!=='type'));f.refuse=true
  const r=await request(f.api,'task.accept',args,{revision:s.revision});assert.equal(r.body.ok,false);assert.deepEqual(f.store.snapshot(),s)
  const api=createHostApi({store:f.store,expectedHosts:new Set(['127.0.0.1:31980']),expectedOrigins:new Set(['http://127.0.0.1:31980']),csrf:'test-csrf'})
  const absent=await request(api,'task.accept',args,{revision:s.revision});assert.equal(absent.body.ok,false);assert.deepEqual(f.store.snapshot(),s)
})
test('execution API overview is read-only and rejects unexpected parameters',async()=>{
  const f=executionFixture(),api=executionApi(f.service);await api.handle('execution.overview',{});assert.equal(f.calls.length,0)
  await assert.rejects(api.handle('execution.overview',{start:true}));await f.service.close()
})

test('created Session ID survives both binding exception and failed repair persistence',async()=>{
  let created=0;const s=stateFixture();const store={getSnapshot:()=>({state:s}),mutate:async()=>{throw Error('network')}}
  const r=await createOpenBindSession(s.tasks['task-one'],{create:async()=>{created++;return{id:'session-created'}},open:async()=>{}},store)
  assert.equal(created,1);assert.equal(r.status,'binding-incomplete');assert.equal(r.sessionId,'session-created')
})
test('created Session ID survives open failure plus repair write failure',async()=>{
  const s=stateFixture(),r=await createOpenBindSession(s.tasks['task-one'],{create:async()=>({id:'session-created'}),open:async()=>{throw Error('open failed')}},{getSnapshot:()=>({state:s}),mutate:async()=>{throw Error('disk')}})
  assert.equal(r.status,'binding-incomplete');assert.equal(r.sessionId,'session-created')
})
test('unbind without a valid save receipt does not claim success',async()=>{
  const s=stateFixture();assert.equal(await unbindSession(s.tasks['task-one'],{mutate:async()=>({phase:'closed'})}),false)
})
test('queue retains archived but busy work; stale results are not shown as accepted',()=>{
  const s=stateFixture();s.projects['project-one'].status='archived'
  const r={taskId:'task-one',runId:'r',sessionId:'session-one',status:'unconfirmed',updatedAt:0,taskRevision:1}
  assert.equal(selectTasks(s,{enabled:true,runs:[r]},{filter:'open'}).length,1)
  const signal=taskSignal(s.tasks['task-one'],{...r,status:'completed',taskRevision:0},s);assert.match(signal.label,/改|核对/)
  assert.notEqual(signal.kind,'done')
})

async function clientFixture(handler) {
  const original=globalThis.fetch,calls=[];let revision=0
  globalThis.fetch=async(url,opts={})=>{
    if(String(url).endsWith('/health'))return Response.json({ok:true,pluginVersion:'0.3.0-rc.1',protocolFingerprint:'fp',certifiedDsh:'0.1.7-rc.2',storage:'ready'})
    const e=JSON.parse(opts.body);calls.push({e,opts});let result
    if(e.method==='system.handshake')result={csrf:'c'.repeat(43),protocolFingerprint:'fp'}
    else if(handler) {const special=await handler(e,opts);if(special instanceof Response)return special;if(special!==undefined)result=special}
    result??={...stateFixture(),revision:revision++}
    return Response.json({v:1,requestId:e.requestId,ok:true,result})
  }
  const client=new MissionControlClientStore();await client.connect()
  return {client,calls,close(){client.close();globalThis.fetch=original}}
}
test('delayed refresh cannot roll back a completed mutation',async()=>{
  const hold=gate(),entered=gate();let reads=0
  const f=await clientFixture(async e=>{if(e.method==='state.snapshot'){if(reads++===0)return{...stateFixture(),revision:0};entered.resolve();await hold.promise;return{...stateFixture(),revision:0}}return {...stateFixture(),revision:1}})
  try{const reading=f.client.refresh();await entered.promise;await f.client.mutate({type:'settings.update',ownerLabel:'用户'});hold.resolve();await reading;assert.equal(f.client.getSnapshot().state.revision,1)}finally{f.close()}
})
test('independent reads never abort an in-flight mutation',async()=>{
  const hold=gate(),entered=gate();let writeSignal
  const f=await clientFixture(async(e,o)=>{if(e.method==='settings.update'){writeSignal=o.signal;entered.resolve();await hold.promise;return {...stateFixture(),revision:20}}})
  try{const saving=f.client.mutate({type:'settings.update',ownerLabel:'用户'});await entered.promise;await f.client.read('audit.page',{});assert.equal(writeSignal.aborted,false);hold.resolve();await saving;assert.equal(f.client.getSnapshot().state.revision,20)}finally{f.close()}
})
test('mutations serialize and use latest acknowledged state revision',async()=>{
  let revision=0;const observed=[];const f=await clientFixture(async e=>{if(e.method==='state.snapshot')return {...stateFixture(),revision};observed.push(e.expectedStateRevision);return {...stateFixture(),revision:++revision}})
  try{await Promise.all([f.client.mutate({type:'settings.update',ownerLabel:'A'}),f.client.mutate({type:'settings.update',ownerLabel:'B'})]);assert.deepEqual(observed,[0,1])}finally{f.close()}
})
test('disconnect or malformed send receipt causes no client replay on reconnect',async()=>{
  let starts=0;const f=await clientFixture(async e=>{if(e.method==='execution.start'){starts++;return Response.json({v:1,requestId:'wrong',ok:true,result:{}})}})
  try{await assert.rejects(f.client.executionCall('execution.start',{previewId:'p',intentId:'i'}));await f.client.connect();await f.client.refresh();assert.equal(starts,1)}finally{f.close()}
})
test('closing client aborts observation but never requests cancellation',async()=>{
  const f=await clientFixture();f.client.close();assert.equal(f.client.getSnapshot().phase,'closed');assert.ok(f.calls.every(c=>c.e.method!=='execution.stop'));f.close()
})
