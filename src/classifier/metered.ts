import { priceMicroUsd, withOnlyCostSink, type ModelCall } from '../models/index.ts'
import type { DecideRequest, DecisionResult, Decisions } from './types.ts'

/**
 * One decision and what it cost, for callers that bill it somewhere other
 * than the ambient run: a channel's daily budget, say. The call reports ONLY
 * to this sink — no enclosing run's sink sees it, so it is never billed twice.
 */
export async function decideMetered(decisions: Decisions, req: DecideRequest): Promise<{ result: DecisionResult; costMicroUsd: number }> {
  let costMicroUsd = 0
  const result = await withOnlyCostSink((call) => { costMicroUsd += priceMicroUsd(call) }, () => decisions.decide(req))
  return { result, costMicroUsd }
}

/**
 * A product decision with a hard deadline: `decideMetered`, but it resolves by
 * `timeoutMs` (+50 ms) whatever the client does, and hands back the model calls
 * so the caller can write them to the usage ledger (summarizeUsage(calls).perModel).
 *
 * `answered` is the result only when it is calibrated: a simulated, timed-out or
 * unavailable result is null, and the caller uses its code signal. Never throws.
 */
export async function decideWithin(decisions: Decisions, req: Omit<DecideRequest, 'signal'>, timeoutMs: number): Promise<{ answered: DecisionResult | null; calls: ModelCall[]; costMicroUsd: number }> {
  const calls: ModelCall[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs + 50) })
    const result = await Promise.race([
      withOnlyCostSink((call) => { calls.push(call) }, () => decisions.decide({ ...req, signal: AbortSignal.timeout(timeoutMs) })),
      late,
    ])
    const costMicroUsd = calls.reduce((s, c) => s + priceMicroUsd(c), 0)
    return { answered: result && result.source === 'calibrated' ? result : null, calls, costMicroUsd }
  } catch {
    return { answered: null, calls, costMicroUsd: calls.reduce((s, c) => s + priceMicroUsd(c), 0) }
  } finally {
    clearTimeout(timer)
  }
}
