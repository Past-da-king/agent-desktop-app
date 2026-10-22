#!/usr/bin/env node
/**
 * Builds the headless node: dist-headless/agent-node.mjs (one ESM file, no Electron) and the Linux tarball
 * dist-headless/agent-node-<version>-linux.tgz (the bundle, its few runtime packages, README, install.sh).
 *
 *   node scripts/build-headless.mjs            bundle + tarball
 *   node scripts/build-headless.mjs --bundle   bundle only (tests)
 *
 * The Claude Agent SDK and Codex SDK stay outside the bundle (they start their engines as files next to themselves).
 * Their engine binaries (hundreds of MB) are optional dependencies and are left out: the node uses the claude or
 * codex already installed on the machine (install.sh finds them; AGENT_CLAUDE_PATH / AGENT_CODEX_PATH).
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const desktop = join(root, 'apps', 'desktop')
const out = join(root, 'dist-headless')
const bundleOnly = process.argv.includes('--bundle')

const pkg = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'))
const version = pkg.version
const sdkVersion = (name) => JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version
const EXTERNAL = ['@anthropic-ai/claude-agent-sdk', '@openai/codex-sdk']
const shim = join(desktop, 'src', 'headless', 'electron-shim.ts')

mkdirSync(out, { recursive: true })
const result = await build({
  entryPoints: [join(desktop, 'src', 'headless', 'main.ts')],
  outfile: join(out, 'agent-node.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  metafile: true,
  external: EXTERNAL,
  alias: { '@agent/core': join(root, 'packages', 'core', 'src', 'index.ts'), electron: shim },
  define: { __AGENT_VERSION__: JSON.stringify(version) },
  // Bundled CommonJS reaches for require and __dirname; give the ESM file both.
  banner: {
    js: [
      "import { createRequire as __agentCreateRequire } from 'node:module';",
      "import { fileURLToPath as __agentFileUrl } from 'node:url';",
      "import { dirname as __agentDirname } from 'node:path';",
      'const require = __agentCreateRequire(import.meta.url);',
      'const __filename = __agentFileUrl(import.meta.url);',
      'const __dirname = __agentDirname(__filename);',
    ].join('\n'),
  },
  logLevel: 'warning',
})

// Nothing may reach the real Electron: only the shim stands in for it.
const externals = new Set()
for (const output of Object.values(result.metafile.outputs)) for (const imp of output.imports) if (imp.external) externals.add(imp.path)
const bad = [...externals].filter((name) => !name.startsWith('node:') && !EXTERNAL.includes(name))
if (bad.length > 0) {
  console.error(`The headless bundle imports packages it does not ship: ${bad.join(', ')}`)
  process.exit(1)
}
const inputs = Object.keys(result.metafile.inputs)
if (inputs.some((file) => /node_modules[\\/]electron[\\/]/.test(file))) {
  console.error('The headless bundle pulled in the real electron package.')
  process.exit(1)
}
console.log(`bundle: dist-headless/agent-node.mjs (${inputs.length} modules, version ${version})`)
if (bundleOnly) process.exit(0)

// ---- the tarball ----
const stage = join(out, 'stage', 'agent-node')
rmSync(join(out, 'stage'), { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
cpSync(join(out, 'agent-node.mjs'), join(stage, 'agent-node.mjs'))
const packDir = join(desktop, 'src', 'headless', 'pack')
cpSync(join(packDir, 'README.md'), join(stage, 'README.md'))
cpSync(join(packDir, 'install.sh'), join(stage, 'install.sh'))
chmodSync(join(stage, 'install.sh'), 0o755)
writeFileSync(
  join(stage, 'package.json'),
  `${JSON.stringify(
    {
      name: 'agent-node',
      version,
      private: true,
      type: 'module',
      description: 'The agent as a service, without a screen.',
      engines: { node: '>=22.13' },
      dependencies: Object.fromEntries(EXTERNAL.map((name) => [name, sdkVersion(name)])),
    },
    null,
    2,
  )}\n`,
)
// The SDKs and their peers, without the optional engine binaries and without install scripts.
execFileSync('npm', ['install', '--omit=optional', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline', '--legacy-peer-deps=false'], {
  cwd: stage,
  stdio: 'inherit',
})
for (const binary of ['@anthropic-ai/claude-agent-sdk-linux-x64', '@openai/codex-linux-x64']) {
  rmSync(join(stage, 'node_modules', binary), { recursive: true, force: true })
}
const tarball = join(out, `agent-node-${version}-linux.tgz`)
execFileSync('tar', ['czf', tarball, '-C', join(out, 'stage'), 'agent-node'], { stdio: 'inherit' })
const size = Math.round(Number(execFileSync('stat', ['-c', '%s', tarball]).toString().trim()) / 1024 / 1024)
console.log(`tarball: dist-headless/agent-node-${version}-linux.tgz (${size} MB)`)
if (!existsSync(tarball)) process.exit(1)
