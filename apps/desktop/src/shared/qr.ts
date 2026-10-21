/**
 * A QR code encoder (ISO/IEC 18004), byte mode, error correction M, versions 1 to 40. Small port of the well-known
 * reference algorithm (Project Nayuki's qrcodegen, MIT), so the pairing QR needs no dependency. Pure: runs in the
 * main process and the renderer alike. Returns rows of modules, true = dark, without the quiet zone.
 */

const ECC_PER_BLOCK_M = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28]
const BLOCKS_M = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49]
/** Format bits for level M. */
const ECL_BITS_M = 0

function rawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2
    result -= (25 * numAlign - 10) * numAlign - 55
    if (ver >= 7) result -= 36
  }
  return result
}

function dataCodewords(ver: number): number {
  return Math.floor(rawDataModules(ver) / 8) - (ECC_PER_BLOCK_M[ver] ?? 0) * (BLOCKS_M[ver] ?? 0)
}

function gfMul(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z & 0xff
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0)
  result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = gfMul(result[j] ?? 0, root)
      if (j + 1 < degree) result[j] = (result[j] ?? 0) ^ (result[j + 1] ?? 0)
    }
    root = gfMul(root, 0x02)
  }
  return result
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0)
  for (const b of data) {
    const factor = b ^ (result.shift() ?? 0)
    result.push(0)
    divisor.forEach((coef, i) => {
      result[i] = (result[i] ?? 0) ^ gfMul(coef, factor)
    })
  }
  return result
}

function utf8Bytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text))
}

/** The smallest version that holds `byteCount` bytes in byte mode at level M, or 0 when none does. */
export function versionFor(byteCount: number): number {
  for (let ver = 1; ver <= 40; ver += 1) {
    const countBits = ver <= 9 ? 8 : 16
    if (4 + countBits + byteCount * 8 <= dataCodewords(ver) * 8) return ver
  }
  return 0
}

class Grid {
  readonly size: number
  readonly modules: boolean[][]
  readonly isFunction: boolean[][]

  constructor(readonly ver: number) {
    this.size = ver * 4 + 17
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false))
    this.isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false))
  }

  set(x: number, y: number, dark: boolean): void {
    const row = this.modules[y]
    const fn = this.isFunction[y]
    if (row === undefined || fn === undefined) return
    row[x] = dark
    fn[x] = true
  }

  drawFunctionPatterns(): void {
    const size = this.size
    for (let i = 0; i < size; i += 1) {
      this.set(6, i, i % 2 === 0)
      this.set(i, 6, i % 2 === 0)
    }
    this.finder(3, 3)
    this.finder(size - 4, 3)
    this.finder(3, size - 4)
    const positions = this.alignmentPositions()
    const n = positions.length
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue
        this.alignment(positions[i] ?? 0, positions[j] ?? 0)
      }
    }
    this.formatBits(0)
    this.versionBits()
  }

  private finder(x: number, y: number): void {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy))
        const xx = x + dx
        const yy = y + dy
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) this.set(xx, yy, dist !== 2 && dist !== 4)
      }
    }
  }

  private alignment(x: number, y: number): void {
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) this.set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
    }
  }

  private alignmentPositions(): number[] {
    if (this.ver === 1) return []
    const numAlign = Math.floor(this.ver / 7) + 2
    const step = this.ver === 32 ? 26 : Math.ceil((this.ver * 4 + 4) / (numAlign * 2 - 2)) * 2
    const result = [6]
    for (let pos = this.size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos)
    return result
  }

  formatBits(mask: number): void {
    const data = (ECL_BITS_M << 3) | mask
    let rem = data
    for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    const bits = ((data << 10) | rem) ^ 0x5412
    const bit = (i: number): boolean => ((bits >>> i) & 1) !== 0
    for (let i = 0; i <= 5; i += 1) this.set(8, i, bit(i))
    this.set(8, 7, bit(6))
    this.set(8, 8, bit(7))
    this.set(7, 8, bit(8))
    for (let i = 9; i < 15; i += 1) this.set(14 - i, 8, bit(i))
    for (let i = 0; i < 8; i += 1) this.set(this.size - 1 - i, 8, bit(i))
    for (let i = 8; i < 15; i += 1) this.set(8, this.size - 15 + i, bit(i))
    this.set(8, this.size - 8, true)
  }

  private versionBits(): void {
    if (this.ver < 7) return
    let rem = this.ver
    for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const bits = (this.ver << 12) | rem
    for (let i = 0; i < 18; i += 1) {
      const dark = ((bits >>> i) & 1) !== 0
      const a = this.size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      this.set(a, b, dark)
      this.set(b, a, dark)
    }
  }

  drawCodewords(data: number[]): void {
    let i = 0
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5
      for (let vert = 0; vert < this.size; vert += 1) {
        for (let j = 0; j < 2; j += 1) {
          const x = right - j
          const upward = ((right + 1) & 2) === 0
          const y = upward ? this.size - 1 - vert : vert
          const row = this.modules[y]
          if (row !== undefined && !(this.isFunction[y]?.[x] ?? true) && i < data.length * 8) {
            row[x] = (((data[i >>> 3] ?? 0) >>> (7 - (i & 7))) & 1) !== 0
            i += 1
          }
        }
      }
    }
  }

  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y += 1) {
      const row = this.modules[y]
      if (row === undefined) continue
      for (let x = 0; x < this.size; x += 1) {
        if (this.isFunction[y]?.[x] === true) continue
        let invert: boolean
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break
          case 1: invert = y % 2 === 0; break
          case 2: invert = x % 3 === 0; break
          case 3: invert = (x + y) % 3 === 0; break
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
        }
        if (invert) row[x] = !row[x]
      }
    }
  }

  /** The standard penalty score (rules 1 to 4); lower is easier to scan. */
  penalty(): number {
    const size = this.size
    const at = (x: number, y: number): boolean => this.modules[y]?.[x] === true
    let score = 0
    // Rule 1: runs of five or more in a row or column.
    for (let pass = 0; pass < 2; pass += 1) {
      for (let a = 0; a < size; a += 1) {
        let run = 1
        for (let b = 1; b < size; b += 1) {
          const same = pass === 0 ? at(b, a) === at(b - 1, a) : at(a, b) === at(a, b - 1)
          if (same) run += 1
          else {
            if (run >= 5) score += run - 2
            run = 1
          }
        }
        if (run >= 5) score += run - 2
      }
    }
    // Rule 2: 2x2 blocks of one colour.
    for (let y = 0; y < size - 1; y += 1) {
      for (let x = 0; x < size - 1; x += 1) {
        const c = at(x, y)
        if (c === at(x + 1, y) && c === at(x, y + 1) && c === at(x + 1, y + 1)) score += 3
      }
    }
    // Rule 3: finder-like patterns 1:1:3:1:1 with four light modules on a side.
    const patterns = [
      [true, false, true, true, true, false, true, false, false, false, false],
      [false, false, false, false, true, false, true, true, true, false, true],
    ]
    for (let a = 0; a < size; a += 1) {
      for (let b = 0; b + 11 <= size; b += 1) {
        for (const pattern of patterns) {
          if (pattern.every((dark, k) => at(b + k, a) === dark)) score += 40
          if (pattern.every((dark, k) => at(a, b + k) === dark)) score += 40
        }
      }
    }
    // Rule 4: balance of dark and light.
    let dark = 0
    for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) if (at(x, y)) dark += 1
    const total = size * size
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1
    score += Math.max(0, k) * 10
    return score
  }
}

function codewordsFor(bytes: number[], ver: number): number[] {
  const bits: number[] = []
  const push = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1)
  }
  push(0x4, 4)
  push(bytes.length, ver <= 9 ? 8 : 16)
  for (const b of bytes) push(b, 8)
  const capacity = dataCodewords(ver) * 8
  push(0, Math.min(4, capacity - bits.length))
  push(0, (8 - (bits.length % 8)) % 8)
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8)
  const data: number[] = []
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0))

  const numBlocks = BLOCKS_M[ver] ?? 1
  const eccLen = ECC_PER_BLOCK_M[ver] ?? 0
  const rawCodewords = Math.floor(rawDataModules(ver) / 8)
  const numShort = numBlocks - (rawCodewords % numBlocks)
  const shortLen = Math.floor(rawCodewords / numBlocks)
  const divisor = rsDivisor(eccLen)
  const blocks: number[][] = []
  for (let i = 0, k = 0; i < numBlocks; i += 1) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1))
    k += dat.length
    const ecc = rsRemainder(dat, divisor)
    if (i < numShort) dat.push(0)
    blocks.push(dat.concat(ecc))
  }
  const result: number[] = []
  const width = blocks[0]?.length ?? 0
  for (let i = 0; i < width; i += 1) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= numShort) result.push(block[i] ?? 0)
    })
  }
  return result
}

/** The QR code for `text` (UTF-8, byte mode, level M). `mask` forces one mask (tests); otherwise the best is picked. */
export function qrMatrix(text: string, mask?: number): boolean[][] {
  const bytes = utf8Bytes(text)
  const ver = versionFor(bytes.length)
  if (ver === 0) throw new Error('Too long for a QR code.')
  const codewords = codewordsFor(bytes, ver)
  const build = (m: number): Grid => {
    const grid = new Grid(ver)
    grid.drawFunctionPatterns()
    grid.drawCodewords(codewords)
    grid.applyMask(m)
    grid.formatBits(m)
    return grid
  }
  if (mask !== undefined) return build(mask).modules
  let best: Grid | null = null
  let bestScore = Infinity
  for (let m = 0; m < 8; m += 1) {
    const grid = build(m)
    const score = grid.penalty()
    if (score < bestScore) {
      best = grid
      bestScore = score
    }
  }
  return (best ?? build(0)).modules
}
