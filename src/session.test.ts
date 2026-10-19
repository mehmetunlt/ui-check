import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireLock, activeSessions, callerId, sessionKey, staleSessions, TAB_IDLE_MS, type Proc } from './session.ts'

const procs: Proc[] = [
  { pid: 10, ppid: 1, start: 'Mon Oct 19 05:00:00 2026', comm: '/Applications/Warp.app/Contents/MacOS/stable' },
  { pid: 20, ppid: 10, start: 'Mon Oct 19 05:01:00 2026', comm: '-zsh' },
  { pid: 30, ppid: 20, start: 'Mon Oct 19 05:02:00 2026', comm: 'claude' },
  { pid: 40, ppid: 30, start: 'Mon Oct 19 05:03:00 2026', comm: '/bin/zsh' },
  { pid: 50, ppid: 40, start: 'Mon Oct 19 05:04:00 2026', comm: 'node' },
]

test('the caller is UI_CHECK_SESSION, else the Claude Code session, else the nearest non-shell ancestor', () => {
  assert.equal(callerId({ UI_CHECK_SESSION: 'a', CLAUDE_CODE_SESSION_ID: 'c' }, procs, 50), 'session:a')
  assert.equal(callerId({ CLAUDE_CODE_SESSION_ID: 'c' }, procs, 50), 'claude:c')
  assert.equal(callerId({}, procs, 50), 'proc:claude:30:Mon Oct 19 05:02:00 2026')
  // From a terminal: the login shell is the caller.
  assert.equal(callerId({}, procs.filter((p) => p.pid !== 30).map((p) => (p.pid === 40 ? { ...p, ppid: 20 } : p)), 50), 'proc:-zsh:20:Mon Oct 19 05:01:00 2026')
  assert.equal(callerId({}, [], 50), 'default')
})

test('the session key separates projects, except for a named session', () => {
  assert.notEqual(sessionKey('claude:c', '/repo/a'), sessionKey('claude:c', '/repo/b'))
  assert.equal(sessionKey('claude:c', '/repo/a'), sessionKey('claude:c', '/repo/a'))
  assert.equal(sessionKey('session:x', '/repo/a'), sessionKey('session:x', '/repo/b'))
  assert.match(sessionKey('claude:c', '/r'), /^[0-9a-f]{12}$/)
})

test('stale and active sessions leave out this one and locked ones', () => {
  const now = 10 * TAB_IDLE_MS
  const reg = { me: { target: 't0', used: 0 }, old: { target: 't1', used: 0 }, busy: { target: 't2', used: 0 }, fresh: { target: 't3', used: now - 1_000 } }
  const locked = (k: string) => k === 'busy'
  assert.deepEqual(staleSessions(reg, 'me', now, locked), ['old'])
  assert.deepEqual(activeSessions(reg, 'me', now, locked).sort(), ['busy', 'fresh'])
})

test('a lock waits for a live holder and takes over a dead one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ui-check-lock-'))
  try {
    const file = join(dir, 'x.lock')
    writeFileSync(file, '999999999')
    const release = await acquireLock(file, 1_000)
    let waitedFor = 0
    await assert.rejects(acquireLock(file, 300, (pid) => { waitedFor = pid }), /still using/)
    assert.equal(waitedFor, process.pid)
    release()
    ;(await acquireLock(file, 300))()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
