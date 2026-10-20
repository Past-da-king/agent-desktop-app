// Usage: node scripts/count-tests.mjs <vitest-json> <min-total> [<path-substring> <min-for-that>]
import fs from 'node:fs'
const [, , file, minTotal, sub, minSub] = process.argv
const j = JSON.parse(fs.readFileSync(file, 'utf8'))
let total = 0, passed = 0, subPassed = 0
for (const suite of j.testResults ?? []) {
  for (const t of suite.assertionResults ?? []) {
    total++
    if (t.status === 'passed') { passed++; if (sub && suite.name.includes(sub)) subPassed++ }
  }
}
console.log(`tests: ${passed}/${total} passed${sub ? `, ${subPassed} in *${sub}*` : ''}`)
if (passed !== total) { console.log('FAIL: not all tests passed'); process.exit(1) }
if (passed < Number(minTotal)) { console.log(`FAIL: expected at least ${minTotal} tests, found ${passed}`); process.exit(1) }
if (sub && subPassed < Number(minSub)) { console.log(`FAIL: expected at least ${minSub} tests in *${sub}*, found ${subPassed}`); process.exit(1) }
