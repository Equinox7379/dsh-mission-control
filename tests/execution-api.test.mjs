import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHostApi } from '../lib/host-api.js'
import { executionApi } from '../lib/execution/http.js'

async function serverFixture(run) {
  const hosts=new Set(), origins=new Set(), calls=[]
  const service={
    preview:async id=>{calls.push(['preview',id]);return{previewId:'preview-one'}},
    start:async(...args)=>{calls.push(['start',...args]);return{runId:'execution-one'}},
    status:async()=>({enabled:true}),stop:async()=>({status:'stopping'}),acknowledge:async()=>({releasedAt:1}),
  }
  const api=createHostApi({store:{snapshot:()=>({revision:0})},expectedHosts:hosts,expectedOrigins:origins,csrf:'fixed-testing-csrf-at-least-32-characters',execution:executionApi(service)})
  const server=createServer((req,res)=>{void api.handler(req,res)})
  server.listen(0,'127.0.0.1');await once(server,'listening')
  const authority=`127.0.0.1:${server.address().port}`,base=`http://${authority}`;hosts.add(authority);origins.add(base)
  const request=async(method,args={},override={})=>{
    const headers={'content-type':'application/json',origin:base,'sec-fetch-site':'same-origin','x-mission-control-csrf':api.csrf,...override}
    for(const key of Object.keys(headers))if(headers[key]===undefined)delete headers[key]
    const response=await fetch(base+'/mission-control/api',{method:'POST',headers,body:JSON.stringify({v:1,requestId:'mc-execution-test',method,args})})
    return{status:response.status,body:await response.json()}
  }
  try{await run({request,calls,base})}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
}

test('real Host API never dispatches execution without exact Origin and existing CSRF',()=>serverFixture(async({request,calls})=>{
  const args={previewId:'preview-one',intentId:'intent-one'}
  for(const headers of [{origin:undefined},{origin:'null'},{origin:'https://outside.test'},{'x-mission-control-csrf':'wrong'},{'sec-fetch-site':'cross-site'}]){
    const result=await request('execution.start',args,headers);assert.notEqual(result.status,200)
  }
  assert.equal(calls.length,0)
}))
test('real guarded route dispatches only explicitly requested start, not health/status reads',()=>serverFixture(async({request,calls,base})=>{
  const health=await fetch(base+'/mission-control/health',{headers:{'sec-fetch-site':'same-origin'}});assert.equal(health.status,200)
  assert.equal((await request('execution.status',{taskId:'task-one'})).status,200);assert.equal(calls.length,0)
  const started=await request('execution.start',{previewId:'preview-one',intentId:'intent-one'})
  assert.equal(started.status,200);assert.equal(started.body.requestId,'mc-execution-test');assert.equal(started.body.result.runId,'execution-one');assert.equal(calls.length,1)
}))
test('execution HTTP rejects extra write arguments, unknown commands and absent explicit acknowledgement',()=>serverFixture(async({request,calls})=>{
  assert.notEqual((await request('execution.start',{previewId:'preview-one',intentId:'intent-one',shell:'anything'})).status,200)
  assert.notEqual((await request('execution.shell',{command:'anything'})).status,200)
  assert.notEqual((await request('execution.acknowledge',{taskId:'task-one',runId:'execution-one',confirmed:false})).status,200)
  assert.equal(calls.length,0)
}))
