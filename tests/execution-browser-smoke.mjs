/** Optional REAL DSH Lab smoke. Uses the existing Playwright dependency; never starts production. */
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { readFile, stat, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const url=process.env.DSH_MC_LAB_AUTH_URL
const sessionId=process.env.DSH_MC_LAB_SESSION_ID
const workspaceArg=process.env.DSH_MC_LAB_WORKSPACE
const labHomeArg=process.env.DSH_MC_LAB_HOME
if(!url || !sessionId || !workspaceArg || !labHomeArg)throw new Error('Set DSH_MC_LAB_AUTH_URL, DSH_MC_LAB_SESSION_ID, DSH_MC_LAB_WORKSPACE, DSH_MC_LAB_HOME for an isolated alpha.4 Lab. This script does not start DSH.')
const target=new URL(url),port=Number(target.port)
if(target.protocol!=='http:' || target.hostname!=='127.0.0.1' || !port || port<1024 || [3080,3081].includes(port))throw new Error('Refusing a production or non-loopback endpoint.')
const workspace=resolve(workspaceArg),labHome=resolve(labHomeArg)
const productionHome=resolve(process.env.USERPROFILE??process.env.HOME??'.','.dsh')
if(labHome.toLowerCase()===productionHome.toLowerCase() || workspace.toLowerCase().includes(`${productionHome.toLowerCase()}`))throw new Error('Refusing production DSH_HOME.')
const canary=join(workspace,'mission-control-run-smoke.txt')
try{await stat(canary);throw new Error('Use a fresh dedicated Lab workspace: canary already exists. No existing file was removed.')}catch(error){if(error.code!=='ENOENT')throw error}
const browser=await chromium.launch({headless:true})
const page=await browser.newPage({viewport:{width:1440,height:1000}})
const artifacts=process.env.DSH_MC_LAB_ARTIFACTS
if(artifacts)await mkdir(artifacts,{recursive:true})
const pageErrors=[]
page.on('pageerror',error=>pageErrors.push(error.message))
const consoleErrors=[]
page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text().slice(0,1200))})
let ownRun,requests=0
page.on('request',req=>{try{if(req.method()==='POST' && JSON.parse(req.postData()??'{}').method==='execution.start')requests++}catch{}})
try{
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000})
  // Synthetic data only, in the caller-confirmed isolated Lab. All mutations use the real guarded API.
  const id=crypto.randomUUID(),projectId=`project-${id}`,taskId=`task-${id}`,projectTitle=`真实运行 Lab ${id.slice(0,8)}`
  await page.evaluate(async({projectId,taskId,sessionId,projectTitle})=>{
    let csrf=''
    async function api(method,args={},revision){
      const r=await fetch('/mission-control/api',{method:'POST',headers:{'content-type':'application/json',...(csrf?{'x-mission-control-csrf':csrf}:{})},body:JSON.stringify({v:1,requestId:`mc-${crypto.randomUUID()}`,method,args,...(revision===undefined?{}:{expectedStateRevision:revision})})})
      const b=await r.json();if(!b.ok)throw new Error(b.error?.message??'Lab API failure');return b.result
    }
    csrf=(await api('system.handshake')).csrf
    let state=await api('state.snapshot')
    state=await api('project.create',{projectId,title:projectTitle},state.revision)
    state=await api('task.create',{projectId,taskId,title:'创建隔离验收文件',objective:'仅在当前工作目录中新建 mission-control-run-smoke.txt，内容严格为 MC_RUN_OK。不要提交、推送、访问网络或修改其他文件。完成后说明结果。'},state.revision)
    await api('task.bind-session',{taskId,expectedEntityRevision:state.tasks[taskId].revision,sessionId},state.revision)
  },{projectId,taskId,sessionId,projectTitle})
  const firstRunNotice=page.getByRole('button',{name:'继续',exact:true})
  if(await firstRunNotice.isVisible())await firstRunNotice.click()
  await page.getByRole('button',{name:'任务指挥台',exact:true}).click()
  await page.locator('.mc-project-rail nav > button').filter({hasText:projectTitle}).click()
  const panel=page.getByTestId('mc-execution')
  await panel.getByRole('button',{name:'交给 DSH 执行',exact:true}).click()
  await panel.getByRole('heading',{name:'确认这次执行'}).waitFor()
  const previewDirectory=await panel.locator('.mc-execution-preview dd').first().innerText()
  assert.equal(resolve(previewDirectory).toLowerCase(),workspace.toLowerCase(),'Actual bound Session cwd must equal the dedicated Lab workspace BEFORE sending.')
  if(artifacts)await page.screenshot({path:join(artifacts,'execution-preview-desktop.png')})
  await panel.getByRole('button',{name:'确认发送一次',exact:true}).click()
  await panel.getByRole('status').filter({hasText:'本轮已结束'}).waitFor({timeout:180000})
  assert.equal(requests,1,'UI must submit exactly one start')
  assert.equal((await readFile(canary,'utf8')).trim(),'MC_RUN_OK')
  if(artifacts)await page.screenshot({path:join(artifacts,'execution-result-desktop.png')})
  ownRun=await page.evaluate(async taskId=>{
    const call=async(method,args,csrf)=>{const r=await fetch('/mission-control/api',{method:'POST',headers:{'content-type':'application/json',...(csrf?{'x-mission-control-csrf':csrf}:{})},body:JSON.stringify({v:1,requestId:`mc-${crypto.randomUUID()}`,method,args})});return(await r.json()).result}
    const h=await call('system.handshake',{});return(await call('execution.status',{taskId},h.csrf)).run
  },taskId)
  await page.reload({waitUntil:'domcontentloaded'})
  await page.getByRole('button',{name:'任务指挥台',exact:true}).click()
  await page.locator('.mc-project-rail nav > button').filter({hasText:projectTitle}).click()
  await page.getByTestId('mc-execution').getByRole('status').filter({hasText:'本轮已结束'}).waitFor()
  assert.equal(requests,1,'Reload must not trigger start replay')
  await page.setViewportSize({width:390,height:844})
  await panel.scrollIntoViewIfNeeded()
  await page.waitForFunction(()=>document.querySelector('.mc-execution-start')?.disabled===true)
  assert.equal(await panel.getByRole('button',{name:'交给 DSH 执行',exact:true}).isDisabled(),true,'Narrow screen must remain read-only')
  const geometry=await page.evaluate(()=>({panelBottom:document.querySelector('.mc-execution').getBoundingClientRect().bottom,manualTop:document.querySelector('.mc-manual-actions').getBoundingClientRect().top}))
  assert.ok(geometry.manualTop>=geometry.panelBottom-1,'Manual workflow must not overlap the execution panel on narrow screens')
  if(artifacts)await page.screenshot({path:join(artifacts,'execution-result-narrow.png')})
  assert.equal(requests,1,'Changing viewport must not send a task')
  assert.deepEqual(pageErrors,[],'No uncaught browser errors')
  console.log(JSON.stringify({status:'PASS',test:'real isolated DSH task execution',taskId,runId:ownRun.runId,turn:ownRun.turn,toolCalls:ownRun.toolCalls,canaryVerified:true,startRequests:requests,viewports:['1440x1000','390x844'],productionTouched:false}))
} catch(error){
  console.error(JSON.stringify({pageErrors,consoleErrors,clientRegistered:await page.evaluate(()=>JSON.stringify(window.__DSH_BOOT__??{}).includes('dsh-mission-control')).catch(()=>false),visibleText:await page.locator('body').innerText().then(text=>text.slice(0,3500)).catch(()=>'(unavailable)')}))
  if(artifacts)await page.screenshot({path:join(artifacts,'execution-failure.png')}).catch(()=>{})
  console.error(String(error?.stack??error).replace(/token=[^\s&#)]+/gu,'token=<redacted>'));process.exitCode=1
} finally{await browser.close()}
