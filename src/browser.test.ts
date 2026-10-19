/**
 * ui-check against small pages served here, in a Chrome of its own (UI_CHECK_STATE, UI_CHECK_PORT),
 * so it never touches the shared one. No classifier: OPENROUTER_API_KEY is blanked.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as netServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHROME = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].find((p) => p && existsSync(p))
const skip = CHROME ? false : 'no Chrome'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const page = (body: string, head = '') => `<!doctype html><html><head><meta charset="utf-8"><title>t</title>${head}</head><body>${body}</body></html>`
type Handler = (req: IncomingMessage, res: ServerResponse) => void
const html = (body: string, head?: string): Handler => (_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page(body, head)) }

const ROUTES: Record<string, Handler> = {
  '/a': html('<h1>Page A</h1>'),
  '/b': html('<h1>Page B</h1>'),
}

let state = ''
let port = 0
let server: Server
let base = ''

async function freePort(): Promise<number> {
  const s = netServer().listen(0, '127.0.0.1')
  await new Promise((r) => s.once('listening', r))
  const p = (s.address() as AddressInfo).port
  await new Promise((r) => s.close(r))
  return p
}

before(async () => {
  if (skip) return
  state = mkdtempSync(join(tmpdir(), 'ui-check-test-'))
  port = await freePort()
  server = createServer((req, res) => {
    const h = ROUTES[new URL(req.url ?? '/', 'http://x').pathname]
    if (h) return h(req, res)
    res.writeHead(404, { 'content-type': 'text/html' })
    res.end(page('<h1>Not found</h1>'))
  }).listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  if (skip) return
  server.close()
  const pidFile = join(state, 'chrome-hidden.pid')
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf8'))
    try { process.kill(pid, 'SIGTERM') } catch {}
    for (let i = 0; i < 30; i++) {
      try { process.kill(pid, 0) } catch { break }
      await sleep(100)
    }
  }
  rmSync(state, { recursive: true, force: true, maxRetries: 5 })
})

/** One ui-check run from source; resolves with its exit code and output. */
function uiCheck(args: string[], session = 'test'): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', '--base', base, ...args], {
      cwd: REPO,
      env: { ...process.env, UI_CHECK_STATE: state, UI_CHECK_PORT: String(port), UI_CHECK_SESSION: session, OPENROUTER_API_KEY: '' },
    })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('close', (code) => resolve({ code, out }))
  })
}

/** The lines a step printed under itself (eval, read and the like). */
const printed = (out: string) => out.split('\n').filter((l) => l.startsWith('     ')).map((l) => l.slice(5))

test('each session drives its own tab', { skip }, async () => {
  await uiCheck(['open', '/a'], 'one')
  await uiCheck(['open', '/b'], 'two')
  const r = await uiCheck(['eval', 'location.pathname'], 'one')
  assert.deepEqual(printed(r.out), ['/a'], r.out)
})

test('two runs of one session take turns on its tab', { skip }, async () => {
  const slow = uiCheck(['open', '/a', 'wait', '3', 'eval', 'location.pathname'], 'three')
  await sleep(1_500)
  const other = uiCheck(['open', '/b'], 'three')
  const [r] = await Promise.all([slow, other])
  assert.deepEqual(printed(r.out), ['/a'], r.out)
  const next = await uiCheck(['eval', 'location.pathname'], 'three')
  assert.deepEqual(printed(next.out), ['/b'], next.out)
})
