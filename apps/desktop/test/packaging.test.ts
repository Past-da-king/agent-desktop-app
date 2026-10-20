import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const config = readFileSync(join(appRoot, 'electron-builder.yml'), 'utf8')
const pkg = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
  author?: string
}
const rootPkg = JSON.parse(readFileSync(join(appRoot, '../../package.json'), 'utf8')) as {
  scripts: Record<string, string>
}

function pngSize(file: string): { width: number; height: number } {
  const bytes = readFileSync(file)
  const signature = bytes.subarray(0, 8).toString('hex')
  if (signature !== '89504e470d0a1a0a') throw new Error(`${file} is not a PNG`)
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

describe('electron-builder config', () => {
  it('uses the documented placeholder app id and product name', () => {
    expect(config).toContain('appId: app.agent.desktop')
    expect(config).toContain('productName: Agent')
  })

  it('ships an asar with only the built app and no source maps', () => {
    expect(config).toMatch(/^asar: true$/m)
    expect(config).toContain('out/**/*')
    expect(config).toContain('!**/*.map')
  })

  it('builds a per-user NSIS installer and a portable Windows build', () => {
    expect(config).toContain('target: nsis')
    expect(config).toContain('target: portable')
    expect(config).toContain('perMachine: false')
    expect(config).toContain('allowElevation: false')
    expect(config).toContain('oneClick: false')
  })

  it('builds a hardened macOS dmg and zip without baked signing credentials', () => {
    expect(config).toContain('target: dmg')
    expect(config).toContain('target: zip')
    expect(config).toContain('hardenedRuntime: true')
    expect(config).toContain('entitlements: build/entitlements.mac.plist')
    expect(config).not.toMatch(/^\s*(identity|notarize|certificate)/m)
  })

  it('builds AppImage and deb packages for Linux', () => {
    expect(config).toContain('target: AppImage')
    expect(config).toContain('target: deb')
    expect(config).toContain('icon: build/icon.png')
  })

  it('has no hardcoded update or sync server', () => {
    expect(config).toContain('publish: null')
    expect(config).not.toMatch(/https?:\/\//)
  })

  it('names no personal infrastructure', () => {
    expect(config).not.toMatch(/guavas|past9|impetix|vercel|ayanda/i)
  })

  it('keeps source maps off in the Electron build config', () => {
    const vite = readFileSync(join(appRoot, 'electron.vite.config.ts'), 'utf8')
    expect((vite.match(/sourcemap: false/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })
})

describe('package scripts', () => {
  it('offers one command per platform plus an unpacked pack', () => {
    expect(pkg.scripts['dist:win']).toContain('electron-builder --win')
    expect(pkg.scripts['dist:mac']).toContain('electron-builder --mac')
    expect(pkg.scripts['dist:linux']).toContain('electron-builder --linux')
    expect(pkg.scripts['pack']).toContain('electron-builder --dir')
  })

  it('is reachable from the repository root', () => {
    expect(rootPkg.scripts['pack']).toContain('@agent/desktop')
    expect(rootPkg.scripts['dist:win']).toContain('@agent/desktop')
    expect(rootPkg.scripts['dist:mac']).toContain('@agent/desktop')
    expect(rootPkg.scripts['dist:linux']).toContain('@agent/desktop')
  })

  it('can regenerate the icon set', () => {
    expect(pkg.scripts['make:icons']).toContain('make-icons.mjs')
    expect(rootPkg.scripts['make:icons']).toContain('make-icons.mjs')
  })

  it('gives the Linux package a maintainer', () => {
    expect(pkg.author).toBe('Agent')
    expect(config).toContain('maintainer: Agent')
  })
})

describe('application icons', () => {
  it('has a 1024 by 1024 PNG', () => {
    expect(pngSize(join(appRoot, 'build/icon.png'))).toEqual({ width: 1024, height: 1024 })
  })

  it('has a multi-size Windows ICO', () => {
    const bytes = readFileSync(join(appRoot, 'build/icon.ico'))
    expect(bytes.readUInt16LE(0)).toBe(0)
    expect(bytes.readUInt16LE(2)).toBe(1)
    const count = bytes.readUInt16LE(4)
    expect(count).toBeGreaterThanOrEqual(6)
    const sizes = new Set<number>()
    for (let index = 0; index < count; index += 1) {
      sizes.add(bytes.readUInt8(6 + index * 16) || 256)
    }
    expect(sizes.has(16)).toBe(true)
    expect(sizes.has(256)).toBe(true)
  })

  it('has an ICNS container with several representations', () => {
    const bytes = readFileSync(join(appRoot, 'build/icon.icns'))
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('icns')
    expect(bytes.readUInt32BE(4)).toBe(bytes.length)
    const types = new Set<string>()
    let at = 8
    while (at < bytes.length) {
      const type = bytes.subarray(at, at + 4).toString('ascii')
      const length = bytes.readUInt32BE(at + 4)
      expect(length).toBeGreaterThan(8)
      types.add(type)
      at += length
    }
    expect(types.has('ic07')).toBe(true)
    expect(types.has('ic10')).toBe(true)
  })

  it('writes the PNG set the packer can fall back to', () => {
    for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
      const file = join(appRoot, `build/icons/${size}x${size}.png`)
      expect(existsSync(file)).toBe(true)
      expect(pngSize(file)).toEqual({ width: size, height: size })
    }
  })

  it('has the macOS entitlements the hardened runtime needs', () => {
    const plist = readFileSync(join(appRoot, 'build/entitlements.mac.plist'), 'utf8')
    expect(plist).toContain('com.apple.security.cs.allow-jit')
    expect(plist).toContain('com.apple.security.cs.allow-unsigned-executable-memory')
  })
})

describe('installed package layout', () => {
  it('names the executable Agent rather than the scoped package name', () => {
    expect(config).toMatch(/^executableName: Agent$/m)
  })

  it('writes build output to apps/desktop/release', () => {
    expect(config).toMatch(/^directories:\n {2}output: release$/m)
    expect(config).toContain('buildResources: build')
  })

  it('includes the manifest alongside the built bundles', () => {
    expect(config).toContain('- package.json')
    expect(config).toContain('- out/**/*')
  })

  it('gives each platform a predictable artifact name', () => {
    expect(config).toContain('artifactName: ${productName}-${version}-setup.${ext}')
    expect(config).toContain('artifactName: ${productName}-${version}-portable.${ext}')
    expect(config).toContain('artifactName: ${productName}-${version}-${arch}.${ext}')
  })

  it('builds universal macOS artifacts', () => {
    expect(config).toContain('arch: [x64, arm64]')
    expect(config).toContain('public.app-category.productivity')
  })

  it('registers a Linux desktop category', () => {
    expect(config).toContain('category: Utility')
    expect(config).toContain('synopsis: A desktop home for your agent')
  })

  it('does not rebuild native modules during packaging', () => {
    expect(config).toContain('npmRebuild: false')
    expect(config).toContain('buildDependenciesFromSource: false')
  })

  it('keeps the app id a single documented placeholder', () => {
    expect((config.match(/^appId:/gm) ?? []).length).toBe(1)
    expect(config).toContain('appId is a placeholder')
  })
})
