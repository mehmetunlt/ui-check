/**
 * Before a screenshot is judged (see, nosee, look): give the page a moment to finish. Right after a
 * client-side navigation the screenshot can otherwise catch the old screen or a half-painted one.
 */
import type { Page, Request } from 'playwright-core'

/** Page code: resolves once fonts are loaded and nothing changed (DOM or layout) for quietMs, or at maxMs; then a painted frame. */
const QUIET_JS = new Function('o', `
  const start = performance.now()
  return new Promise((resolve) => {
    let last = start
    let fonts = !document.fonts
    if (document.fonts) document.fonts.ready.then(() => { fonts = true })
    const mo = new MutationObserver(() => { last = performance.now() })
    mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true })
    let po = null
    try { po = new PerformanceObserver(() => { last = performance.now() }); po.observe({ type: 'layout-shift' }) } catch {}
    const tick = () => {
      const now = performance.now()
      if ((fonts && now - last >= o.quietMs) || now - start >= o.maxMs) {
        mo.disconnect()
        if (po) po.disconnect()
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(now - start)))
        return
      }
      setTimeout(tick, 40)
    }
    tick()
  })
`) as (o: { quietMs: number; maxMs: number }) => Promise<number>

type Net = { open: Set<Request>; last: number }
const nets = new WeakMap<Page, Net>()
/** Long-lived streams would never let the page look settled. */
const IGNORED_TYPES = new Set(['websocket', 'eventsource', 'media', 'manifest', 'ping', 'other'])

/**
 * Requests in flight on the page, counted from now on. Playwright's networkidle is a load event:
 * after a client-side navigation (a Next.js RSC fetch, say) it has long fired, so it is no help there.
 */
export function trackRequests(page: Page): Net {
  let net = nets.get(page)
  if (net) return net
  const n: Net = { open: new Set(), last: 0 }
  const done = (r: Request) => { if (n.open.delete(r)) n.last = Date.now() }
  page.on('request', (r) => { if (!IGNORED_TYPES.has(r.resourceType())) { n.open.add(r); n.last = Date.now() } })
  page.on('requestfinished', done)
  page.on('requestfailed', done)
  nets.set(page, n)
  return n
}

/**
 * Waits until no request is in flight and the screen has not changed (DOM, layout, fonts) for
 * `quietMs`, at most `maxMs` in all. Returns the ms waited.
 */
export async function settleForLook(page: Page, maxMs = 2_000, quietMs = 300): Promise<number> {
  const net = trackRequests(page)
  const began = Date.now()
  const deadline = began + maxMs
  await page.waitForLoadState('networkidle', { timeout: Math.min(1_000, maxMs) }).catch(() => {})
  while (Date.now() < deadline) {
    while (net.open.size > 0 && Date.now() < deadline) await sleep(40)
    const left = deadline - Date.now()
    if (left <= 0) break
    await page.evaluate(QUIET_JS, { quietMs, maxMs: left }).catch(() => {})
    if (net.open.size === 0 && Date.now() - net.last >= quietMs) break
  }
  return Date.now() - began
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
