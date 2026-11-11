import { open, sleep } from './sc.mjs'
const s = open()
const hwnd = process.argv[2]
console.log('probe', JSON.stringify(await s.call('probe', { hwnd })))
const t = await s.call('tree', { hwnd, max: 80, interactiveOnly: true })
for (const n of t.nodes ?? []) console.log(n.id, n.role, JSON.stringify(n.name), n.value ?? '', JSON.stringify(n.bounds))
console.log(JSON.stringify(t.__error ? t : { seen: t.seen }))
s.close()
