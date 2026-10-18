/**
 * A render as the quick look reads it (dlook, design quality spec §9a): the classifier takes
 * PNG or JPEG within fixed limits and rejects (never resizes) anything else, so every render is
 * fitted here first. A tall page is cut from the top to 1.8 times its width (the critic's 1440 by
 * 2600 cut; a caller may pass another `maxAspect`: quick_check keeps 2.5, so a phone screen keeps
 * its fold), then scaled to at most 1568 a side and at least 280 (which also meets the pixel
 * minimum); a strip still thinner than that is padded on white. Transparency reads white (a logo
 * sheet), and the result is a JPEG. The bytes are decoded and redrawn, never run.
 *
 * Memory: the size is read from the header before anything is decoded. A PNG is decoded already
 * shrunk and cut (png.ts decodePngScaled, streamed, as the critic reads renders), so a huge or
 * crafted PNG costs only the picture it becomes. The API runs in about 1 GB, so what would be
 * decoded is capped before decoding: at most LOOK_MAX_DECODE_SIDE (4096) px wide and
 * LOOK_MAX_DECODE_PIXELS (16.7 MP), counting for a PNG only the rows read (the top, `maxAspect`
 * times its width: 1.8 by default, 2.5 for quick_check, so a wider PNG reaches the cap sooner there) and for a JPEG the whole picture (the library has no downscale on decode for JPEG, so
 * it is decoded whole: at most about 67 MB). Any file over LOOK_MAX_INPUT_BYTES is refused. One
 * fit runs at a time in this process.
 * Encoder: @napi-rs/canvas, as the engine's read_file previews.
 */
import { imageInfo } from './classifier/images.ts'
import { IMAGE_MAX_SIDE, IMAGE_MIN_PIXELS } from './classifier/types.ts'
import { decodePngScaled } from './png.ts'

/** The short side at least: above the endpoint's 256, and 280 x 280 meets its pixel minimum too. */
export const LOOK_MIN_SIDE = Math.ceil(Math.sqrt(IMAGE_MIN_PIXELS))
/** Height over width kept from the top of a tall page. */
export const LOOK_MAX_ASPECT = 1.8
export const LOOK_JPEG_QUALITY = 82
/** A render file larger than this is refused before it is read. */
export const LOOK_MAX_INPUT_BYTES = 40 * 1024 * 1024
/** Wider (or, for a JPEG, taller) than this is refused before decoding. */
export const LOOK_MAX_DECODE_SIDE = 4_096
/** More pixels than this to decode is refused (a JPEG whole; a PNG's rows that are read). */
export const LOOK_MAX_DECODE_PIXELS = 16_700_000

let queue: Promise<unknown> = Promise.resolve()

/**
 * The render, fitted for the quick look, as a JPEG. Rejects when the bytes are too big or can't be decoded as an image.
 * `maxAspect`: height over width kept from the top (default LOOK_MAX_ASPECT; quick_check keeps a phone screen whole).
 */
export function fitForLook(png: Uint8Array, opts: { maxAspect?: number } = {}): Promise<Uint8Array> {
  const aspect = opts.maxAspect && opts.maxAspect > 0 ? opts.maxAspect : LOOK_MAX_ASPECT
  const run = queue.then(() => fit(png, aspect), () => fit(png, aspect))
  queue = run.catch(() => {})
  return run
}

async function fit(bytes: Uint8Array, aspect: number): Promise<Uint8Array> {
  if (!bytes || bytes.length > LOOK_MAX_INPUT_BYTES) throw new Error('the render is too large to look at')
  const info = imageInfo(bytes)
  if (!info || !info.width || !info.height) throw new Error('not a PNG or JPEG render')
  const canvas = await import('@napi-rs/canvas')
  // The source, already cut to the kept rows: [what to draw, its width, its height].
  let src: { draw: Parameters<ReturnType<ReturnType<typeof canvas.createCanvas>['getContext']>['drawImage']>[0]; width: number; height: number }
  if (info.format === 'png') {
    const rows = Math.min(info.height, Math.round(info.width * aspect))
    if (info.width > LOOK_MAX_DECODE_SIDE || info.width * rows > LOOK_MAX_DECODE_PIXELS) throw new Error('the render is too large to look at')
    const toWidth = Math.min(info.width, IMAGE_MAX_SIDE)
    const img = await decodePngScaled(bytes, { toWidth, maxHeight: Math.round(toWidth * aspect) })
    if ('error' in img) throw new Error(img.error)
    const c = canvas.createCanvas(img.width, img.height)
    c.getContext('2d').putImageData(new canvas.ImageData(new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.byteLength), img.width, img.height), 0, 0)
    src = { draw: c, width: img.width, height: img.height }
  } else {
    if (info.width > LOOK_MAX_DECODE_SIDE || info.height > LOOK_MAX_DECODE_SIDE || info.width * info.height > LOOK_MAX_DECODE_PIXELS) throw new Error('the render is too large to look at')
    const img = await canvas.loadImage(Buffer.from(bytes))
    src = { draw: img, width: img.width, height: img.height }
  }
  const sw = src.width
  const sh = Math.min(src.height, Math.round(src.width * aspect))
  // Shrink the long side to the limit; grow when the short side is under the floor and the long side allows it.
  let scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(sw, sh))
  if (Math.min(sw, sh) * scale < LOOK_MIN_SIDE) scale = Math.min(IMAGE_MAX_SIDE / Math.max(sw, sh), LOOK_MIN_SIDE / Math.min(sw, sh))
  const dw = Math.max(1, Math.round(sw * scale)), dh = Math.max(1, Math.round(sh * scale))
  const cw = Math.max(LOOK_MIN_SIDE, dw), ch = Math.max(LOOK_MIN_SIDE, dh)
  const out = canvas.createCanvas(cw, ch)
  const g = out.getContext('2d')
  g.fillStyle = '#ffffff'
  g.fillRect(0, 0, cw, ch)
  g.drawImage(src.draw, 0, 0, sw, sh, Math.floor((cw - dw) / 2), Math.floor((ch - dh) / 2), dw, dh)
  return new Uint8Array(await out.encode('jpeg', LOOK_JPEG_QUALITY))
}
