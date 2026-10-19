/**
 * Before a screenshot is judged (see, nosee, look): give the page a moment to finish. Right after a
 * client-side navigation the screenshot can otherwise catch the old screen or a half-painted one.
 */
import type { Page } from 'playwright-core'

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

/** Waits for the network to go quiet and the screen to stop changing for `quietMs`, at most `maxMs` in all. Returns the ms waited. */
export async function settleForLook(page: Page, maxMs = 2_000, quietMs = 300): Promise<number> {
  const began = Date.now()
  await page.waitForLoadState('networkidle', { timeout: Math.min(1_000, maxMs) }).catch(() => {})
  const left = Math.max(0, maxMs - (Date.now() - began))
  if (left > 0) await page.evaluate(QUIET_JS, { quietMs, maxMs: left }).catch(() => {})
  return Date.now() - began
}
