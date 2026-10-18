/**
 * Your own keys (owner ruling 2026-10-16): a workspace that saved its own
 * model-account key runs every model call of its runs on it. The runner
 * resolves the key once per run (runtime paid-keys.ts) and runs the engine
 * inside `withModelKey`; every model HTTP call made inside — chat through
 * the shared seam (openrouter.ts), embeddings, media, typed decisions —
 * sends it instead of ours. Ambient, like the cost sink (cost-sink.ts), so a
 * call site nobody threaded the key through is still on the right account.
 *
 * The key never leaves the Authorization header: it is not in a message, a
 * log line, an error or an event.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

const ambient = new AsyncLocalStorage<string>()

/** Run `fn` with every model call inside it on `key`; null or empty: on ours, as before. */
export function withModelKey<T>(key: string | null | undefined, fn: () => Promise<T>): Promise<T> {
  return key ? ambient.run(key, fn) : fn()
}

/** The workspace's own model key for the calls being made now, or null (ours). */
export const currentModelKey = (): string | null => ambient.getStore() ?? null

/** The Authorization header value for a model call: the ambient key, else `platformKey`. */
export const modelAuthorization = (platformKey: string): string => `Bearer ${currentModelKey() ?? platformKey}`

/** A request's init with the ambient key as its Authorization, when one is set; the same init otherwise. */
export function withAmbientModelKey(init: RequestInit | undefined): RequestInit | undefined {
  const key = currentModelKey()
  if (!key) return init
  const headers = new Headers(init?.headers)
  headers.set('authorization', `Bearer ${key}`)
  return { ...(init ?? {}), headers }
}

/** One model call made on the workspace's own key: it went through, or failed with the provider's HTTP status (null: no answer). */
export type ModelKeyCall = { ok: true } | { ok: false; status: number | null }

let keyCallListener: ((key: string, call: ModelKeyCall) => void) | null = null

/**
 * Per-key use (visual audit gap 47): the process's one listener for calls made
 * on an ambient key (runtime PaidKeys counts them against the workspace that
 * key belongs to). Null removes it. The key reaches only this listener.
 */
export function onModelKeyCall(fn: ((key: string, call: ModelKeyCall) => void) | null): void {
  keyCallListener = fn
}

/** Tell the listener about a call just made, when it went out on an ambient key; a listener never fails the call. */
export function noteModelKeyCall(call: ModelKeyCall): void {
  const key = currentModelKey()
  if (!key || !keyCallListener) return
  try { keyCallListener(key, call) } catch { /* never the caller's problem */ }
}
