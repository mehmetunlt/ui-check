/**
 * Which tab a run drives. Every caller (an agent session, a terminal) gets a tab of its own in the
 * one Chrome, so cookies and sign-ins stay shared while pages do not, and a lock per tab makes two
 * runs of one caller take turns instead of driving it at once. The tabs are listed in a small JSON
 * file next to the profile; a tab nobody used for a few hours is closed by the next run.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, closeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export type Proc = { pid: number; ppid: number; start: string; comm: string }

/** Processes between the caller and ui-check: shells, package runners, node itself. */
const WRAPPERS = /^(sh|bash|zsh|dash|ksh|fish|tcsh|csh|env|npm|npx|pnpm|yarn|tsx|node|timeout|xargs|nice|time)$/

/**
 * Who is calling: UI_CHECK_SESSION when set, else the Claude Code session, else the nearest
 * ancestor process that is not a shell or runner (by pid and start time, so a reused pid is a new caller).
 */
export function callerId(env: Record<string, string | undefined>, procs: readonly Proc[], selfPid: number): string {
  if (env.UI_CHECK_SESSION) return `session:${env.UI_CHECK_SESSION}`
  if (env.CLAUDE_CODE_SESSION_ID) return `claude:${env.CLAUDE_CODE_SESSION_ID}`
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  let p = byPid.get(byPid.get(selfPid)?.ppid ?? -1)
  for (let hops = 0; p && hops < 30; hops++) {
    // A login shell (-zsh) is a terminal of its own; other shells and runners are passed through.
    if (p.comm.startsWith('-') || !WRAPPERS.test(basename(p.comm))) return `proc:${basename(p.comm)}:${p.pid}:${p.start}`
    p = byPid.get(p.ppid)
  }
  return 'default'
}

/** The tab's key: the caller, and the project it runs in (a git checkout or worktree), unless UI_CHECK_SESSION names it. */
export function sessionKey(caller: string, root: string): string {
  const id = caller.startsWith('session:') ? caller : `${caller}\n${root}`
  return createHash('sha1').update(id).digest('hex').slice(0, 12)
}

/** The nearest directory holding .git, else the directory itself. */
export function projectRoot(cwd: string): string {
  for (let d = cwd; ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return d
    if (dirname(d) === d) return cwd
  }
}

export function listProcs(): Proc[] {
  try {
    const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,lstart=,comm='], { encoding: 'utf8', timeout: 3_000 })
    return out.split('\n').flatMap((l) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(l)
      return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), start: m[3]!.replace(/\s+/g, ' '), comm: m[4]!.trim() }] : []
    })
  } catch { return [] }
}

export function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The pid holding a lock file, if that process is still alive. */
export function lockHolder(file: string): number | null {
  try {
    const pid = Number(readFileSync(file, 'utf8'))
    return alive(pid) ? pid : null
  } catch { return null }
}

/**
 * Takes a lock file (this pid inside), waiting while a live process holds it; a dead holder's lock
 * is taken over. Returns the release. `onWait` is told once whom it waits for.
 */
export async function acquireLock(file: string, waitMs: number, onWait?: (pid: number) => void): Promise<() => void> {
  mkdirSync(dirname(file), { recursive: true })
  const deadline = Date.now() + waitMs
  let told = false
  for (;;) {
    try {
      const fd = openSync(file, 'wx')
      writeFileSync(fd, String(process.pid))
      closeSync(fd)
      let released = false
      return () => { if (!released) { released = true; rmSync(file, { force: true }) } }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    const holder = lockHolder(file)
    if (holder === null) {
      // Written a moment ago and not yet filled in, or left by a run that died.
      await sleep(30)
      if (lockHolder(file) === null) rmSync(file, { force: true })
      continue
    }
    if (Date.now() > deadline) throw new Error(`another ui-check run (pid ${holder}) is still using this session's tab; set UI_CHECK_SESSION to run in parallel`)
    if (!told) { told = true; onWait?.(holder) }
    await sleep(150)
  }
}

/** `scheme`: the colour scheme a session's `dark` or `light` step set on its own tab (kept across runs). */
export type Registry = Record<string, { target: string; used: number; scheme?: 'dark' | 'light' }>

export function readRegistry(file: string): Registry {
  try { return JSON.parse(readFileSync(file, 'utf8')) as Registry } catch { return {} }
}

export function writeRegistry(file: string, reg: Registry): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(reg, null, 1))
  renameSync(tmp, file)
}

/** A tab idle this long is closed by the next run. */
export const TAB_IDLE_MS = 3 * 3600 * 1000
/** Sessions used this recently keep Chrome open on --close. */
export const ACTIVE_MS = 10 * 60 * 1000

/** Other sessions' entries that are stale (idle past TAB_IDLE_MS and not locked). */
export function staleSessions(reg: Registry, mine: string, now: number, locked: (key: string) => boolean): string[] {
  return Object.entries(reg).filter(([k, v]) => k !== mine && now - v.used > TAB_IDLE_MS && !locked(k)).map(([k]) => k)
}

/** Other sessions still in use: locked, or used within ACTIVE_MS. */
export function activeSessions(reg: Registry, mine: string, now: number, locked: (key: string) => boolean): string[] {
  return Object.entries(reg).filter(([k, v]) => k !== mine && (locked(k) || now - v.used < ACTIVE_MS)).map(([k]) => k)
}
