import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { createHostApi } from '../lib/host-api.js'
import { AtomicStateStore } from '../lib/storage.js'

const testRoot = process.env.DSH_MC_TEST_TMP
assert.ok(testRoot, 'DSH_MC_TEST_TMP is required')
const work = join(testRoot, `health-browser-${randomUUID()}`)
await mkdir(work, { recursive: true })

const store = new AtomicStateStore(join(work, 'state.json'))
await store.open()
const expectedHosts = new Set()
const expectedOrigins = new Set()
const api = createHostApi({ store, expectedHosts, expectedOrigins })
let healthHeaders
const server = createServer((request, response) => {
  const path = (request.url ?? '/').split('?', 1)[0]
  if (path === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end('<!doctype html><title>Mission Control health smoke</title>')
    return
  }
  if (path === '/mission-control/health') healthHeaders = { ...request.headers }
  void api.handler(request, response)
})

let browser
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const host = `127.0.0.1:${address.port}`
  const origin = `http://${host}`
  expectedHosts.add(host)
  expectedOrigins.add(origin)

  const channel = process.env.DSH_MC_BROWSER_CHANNEL
  browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) })
  const page = await browser.newPage()
  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  const result = await page.evaluate(async () => {
    const response = await fetch('/mission-control/health', {
      method: 'GET', credentials: 'same-origin', cache: 'no-store',
    })
    return { status: response.status, body: await response.json() }
  })

  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.equal(healthHeaders.origin, undefined)
  assert.equal(healthHeaders['sec-fetch-site'], 'same-origin')
  assert.equal(healthHeaders.host, host)
  console.log('Chromium same-origin health smoke passed without an Origin header.')
} finally {
  await browser?.close()
  await new Promise((resolve) => server.close(resolve))
  await store.close()
  await rm(work, { recursive: true, force: true })
}
