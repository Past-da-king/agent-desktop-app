#!/usr/bin/env node
// A stand-in for tools/agent-net in tests: it speaks the same stdout JSON lines and stdin control lines.
// Behaviour comes from env: FAKE_NET_LOG (a file it appends what it saw to), FAKE_NET_SOCKS (the socks address it
// reports), FAKE_NET_CRASH_ONCE (a marker file: when missing, it creates it and exits with code 3 after Running).
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const log = process.env.FAKE_NET_LOG ?? ''
const note = (entry) => {
  if (log !== '') appendFileSync(log, `${JSON.stringify(entry)}\n`)
}
const say = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`)
const args = process.argv.slice(2)
const flag = (name) => {
  const at = args.indexOf(name)
  return at < 0 ? '' : (args[at + 1] ?? '')
}
note({ type: 'start', args, envHasKey: 'AGENT_NET_AUTHKEY' in process.env, pid: process.pid })

let first = true
let done = false
const finish = (how) => {
  if (done) return
  done = true
  note({ type: 'stop', how })
  say({ type: 'exit' })
  process.exit(0)
}
createInterface({ input: process.stdin })
  .on('line', (line) => {
    if (first) {
      first = false
      note({ type: 'key', key: line })
      say({ type: 'status', state: 'Starting', tailnetIPs: [], peers: [] })
      setTimeout(() => {
        if (line.trim() === '') {
          say({ type: 'status', state: 'NeedsLogin', authURL: 'https://login.example.com/a/123', tailnetIPs: [], peers: [] })
          return
        }
        say({
          type: 'status',
          state: 'Running',
          tailnetIPs: ['100.64.0.9', 'fd7a:115c:a1e0::9'],
          dnsName: `${flag('--hostname')}.example.ts.net.`,
          hostname: flag('--hostname'),
          socks: process.env.FAKE_NET_SOCKS ?? '127.0.0.1:1',
          forward: { port: Number(flag('--listen-port')), to: Number(flag('--forward')) },
          peers: [{ name: 'other', dnsName: 'other.example.ts.net', ips: ['100.64.0.10'], online: true }],
        })
        const marker = process.env.FAKE_NET_CRASH_ONCE ?? ''
        if (marker !== '' && !existsSync(marker)) {
          writeFileSync(marker, 'crashed')
          setTimeout(() => process.exit(3), 50)
        }
      }, 30)
      return
    }
    const cmd = line.trim()
    if (cmd === 'quit' || cmd === 'logout') finish(cmd)
  })
  .on('close', () => finish('eof'))
