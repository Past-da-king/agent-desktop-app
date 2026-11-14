import { open } from './sc.mjs'
const s = open()
console.log(JSON.stringify(await s.call('hello')))
console.log(JSON.stringify(await s.call('presence')))
const w = await s.call('windows', { minimised: true })
for (const x of w) console.log(x.hwnd, x.pid, x.process, x.className, x.minimized ? 'MIN' : '', JSON.stringify(x.title.slice(0, 50)))
s.close()
