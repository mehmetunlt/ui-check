import { AsyncLocalStorage } from 'node:async_hooks'
import { MODEL_CATALOG } from './catalog.ts'

export type ModelCall = {
  model: string
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  /** Provider-reported cost in micro-USD; null when the call finished without one. */
  actualCostMicroUsd: number | null
  finishReason: string | null
  /**
   * How long the call took, ms: from its first request (retries and fallbacks
   * included) to the response's end (a stream's last byte). Set by the model
   * HTTP seam (openrouter.ts); absent for calls that are not timed. Spans
   * (Phase 41) read it; billing never does.
   */
  latencyMs?: number
  /**
   * pengine2: the call's ledger lines are written elsewhere (a coding task's own child run, one per model): it still
   * counts toward the run's cost, spend cap and budget, but the run writes no ledger line for it.
   */
  ledger?: 'elsewhere'
}

type Sink = (call: ModelCall) => void

/*
 * Ambient capture (ported from Modus llm-gateway/cost-capture.ts).
 *
 * A turn declares itself billable once and everything it causes is captured,
 * including tools it did not know it would reach — threading a sink through
 * every layer leaves the NEXT call site unbilled by default. AsyncLocalStorage
 * gives each turn its own store, so concurrent turns can't see each other's.
 *
 * Sinks nest as a stack: a child run's sink does NOT replace its parent's, it
 * is added to it, so a parent sees what its whole tree spent (Modus review: a
 * scheduled run with a $5 cap fanned out to 20 children each with its own $5
 * because a child's sink replaced the parent's).
 */
const ambient = new AsyncLocalStorage<readonly Sink[]>()

export function withCostSink<T>(sink: Sink, fn: () => Promise<T>): Promise<T> {
  return ambient.run([...(ambient.getStore() ?? []), sink], fn)
}

/**
 * Like withCostSink, but `sink` is the ONLY sink inside `fn`: nothing that
 * encloses it is billed. For a cost billed somewhere other than the
 * surrounding run (a channel's routing decision), so it is never counted twice.
 */
export function withOnlyCostSink<T>(sink: Sink, fn: () => Promise<T>): Promise<T> {
  return ambient.run([sink], fn)
}

/** Deliver a finished model call to every enclosing sink. A throwing sink never breaks the model call. */
export function reportModelCall(call: ModelCall): void {
  for (const sink of ambient.getStore() ?? []) {
    try { sink(call) } catch { /* accounting must not fail a turn */ }
  }
}

const warned = new Set<string>()

/** Tokens × catalog, ignoring any reported actual. Unknown model: 0, with a one-time warning per model id. */
export function priceFromCatalog(call: ModelCall): number {
  const row = MODEL_CATALOG[call.model]
  if (!row) {
    if (!warned.has(call.model)) {
      warned.add(call.model)
      console.warn(`[models] no catalog price for "${call.model}" and no provider cost reported; pricing at 0`)
    }
    return 0
  }
  const cached = Math.min(call.cachedInputTokens, call.inputTokens)
  const fresh = call.inputTokens - cached
  return Math.round(fresh * row.inputPerMTok + cached * row.cachedInputPerMTok + call.outputTokens * row.outputPerMTok)
}

/**
 * Micro-USD for one call: the provider's actual when present, else tokens × catalog.
 * Cached input is billed at the cache-read rate; reasoning tokens are already inside
 * outputTokens (completion_tokens includes them), so they are not added again.
 */
export function priceMicroUsd(call: ModelCall): number {
  return call.actualCostMicroUsd !== null ? call.actualCostMicroUsd : priceFromCatalog(call)
}
