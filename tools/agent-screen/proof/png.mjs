// Proof only: reads a PNG (8-bit RGB or RGBA, not interlaced) into raw pixels, to check what a capture really shows.
import { inflateSync } from 'node:zlib'

export function decodePng(buffer) {
  let at = 8
  let width = 0, height = 0, channels = 3
  const data = []
  while (at < buffer.length) {
    const length = buffer.readUInt32BE(at)
    const type = buffer.toString('latin1', at + 4, at + 8)
    const body = buffer.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4)
      if (body[8] !== 8 || (body[9] !== 2 && body[9] !== 6) || body[12] !== 0) throw new Error(`png kind not handled: depth ${body[8]} colour ${body[9]}`)
      channels = body[9] === 6 ? 4 : 3
    } else if (type === 'IDAT') data.push(body)
    else if (type === 'IEND') break
    at += 12 + length
  }
  const raw = inflateSync(Buffer.concat(data))
  const stride = width * channels
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const out = pixels.subarray(y * stride, (y + 1) * stride)
    const up = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels] : 0
      const b = up ? up[x] : 0
      const c = up && x >= channels ? up[x - channels] : 0
      let v = line[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c }
      out[x] = v & 255
    }
  }
  return { width, height, channels, pixels }
}

/** The box around every pixel within `tolerance` of a colour, or null. Coordinates are in the picture. */
export function boxOfColour(png, [r, g, b], tolerance = 6) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, count = 0
  const { width, height, channels, pixels } = png
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels
      if (Math.abs(pixels[i] - r) <= tolerance && Math.abs(pixels[i + 1] - g) <= tolerance && Math.abs(pixels[i + 2] - b) <= tolerance) {
        count++
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  return count === 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1, count }
}
