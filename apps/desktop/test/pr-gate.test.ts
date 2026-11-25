import { afterEach, describe, expect, it, vi } from 'vitest'
import { reviewableCall } from '../src/main/runtime/pr-gate'
import { DEFAULT_SETTINGS, type ToolContext } from '@agent/core'
import { Store } from '../src/main/db'
import { PrGate, ATTESTATION_FIELDS, withPrGate } from '../src/main/runtime/pr-gate'
describe('PR reviewability detection', () => {
  it.each([
    'gh pr create --title Test', 'gh pr ready 12', 'gh pr edit 12 --add-reviewer jane',
    "bash -lc 'gh pr ready 12'", "wsl -- ssh host 'gh pr ready 12'",
    'FOO=bar gh pr ready', 'echo ok && gh pr ready', 'gh pr list; gh pr ready',
    'gh api repos/a/b/pulls -f title=test',
    'gh api -X PATCH repos/a/b/pulls/3 -F draft=false',
    'gh api repos/a/b/pulls/3/requested_reviewers -X POST',
    "gh api graphql -f query='mutation { markPullRequestReadyForReview(input:{pullRequestId:\"x\"}) { clientMutationId } }'",
    'gh pr comment 3 --body "Ready for review"',
    'curl -X POST https://api.github.com/repos/a/b/pulls -d \'{"title":"test"}\'',
    'Invoke-RestMethod -Method Post -Uri https://api.github.com/repos/a/b/pulls -Body \'{"title":"test"}\'',
  ])('blocks %s', command => expect(reviewableCall('shell_run', { command })).toBe(true))
  it.each([
    'gh pr list', 'gh pr view', 'gh pr checks', 'gh pr diff', 'gh pr create --draft',
    'gh pr create -d --title Test', 'gh pr ready --undo',
    'echo "gh pr ready"', 'printf "%s" "gh pr ready"', 'grep "gh pr ready" README.md',
    'gh api repos/a/b/pulls -X GET',
    'curl https://api.github.com/repos/a/b/pulls',
    'gh pr comment 3 --body "Thanks"',
    'gh api repos/a/b/pulls -F draft=true',
  ])('passes %s', command => expect(reviewableCall('shell_run', { command })).toBe(false))
  it.each([
    ['browser_fetch', {url:'https://api.github.com/repos/a/b/pulls',method:'POST',body:'{"title":"test"}'},true],
    ['browser_fetch', {url:'https://api.github.com/repos/a/b/pulls',method:'POST',body:'{"draft":true}'},false],
    ['browser_fetch', {url:'https://example.com/repos/a/b/pulls',method:'POST'},false],
    ['apps_run', {slug:'GITHUB_CREATE_A_PULL_REQUEST',arguments:{title:'test'}},true],
    ['apps_run', {slug:'GITHUB_CREATE_A_PULL_REQUEST',arguments:{draft:true}},false],
    ['apps_run', {slug:'GITHUB_REQUEST_REVIEWERS_FOR_A_PULL_REQUEST',arguments:{}},true],
    ['apps_run', {slug:'GITHUB_CREATE_AN_ISSUE_COMMENT',arguments:{body:'Ready for review'}},true],
  ])('%s %j', (name,args,expected) => expect(reviewableCall(name as string,args as Record<string, unknown>)).toBe(expected))
})

const stores: Store[] = []
afterEach(() => stores.splice(0).forEach(s => s.close()))
const ctx = {owner:'helper:author-agent',agentLabel:'author-agent',chat:'project-chat'} as ToolContext
function setup(on = true) {
  const store = new Store(':memory:'); stores.push(store)
  const settings = {...DEFAULT_SETTINGS,prGateEnabled:on,prGateSkillPages:[] as string[]}
  let now = 1_000_000
  const gate = new PrGate(store,()=>settings,()=>now)
  const args = {command:'gh pr ready 12'}
  const evidence = Object.fromEntries(ATTESTATION_FIELDS.map(k=>[k,k + ' verified with evidence at /tmp/proof-report.md']))
  evidence.reviewerAgentId = 'helper:independent-review-agent'
  const hold = async () => {
    const result = await gate.check('shell_run',args,ctx)
    return result!.match(/Gate id: ([a-f0-9-]+)/)![1]!
  }
  return {store,settings,gate,args,evidence,hold,expire:()=>{now+=24 * 60 * 60_000 + 1}}
}
describe('PR gate flow',()=>{
  it('off passes and draft creates pass freely',async()=>{
    const t=setup(false)
    expect(await t.gate.check('shell_run',t.args,ctx)).toBeNull()
    t.settings.prGateEnabled=true
    expect(await t.gate.check('shell_run',{command:'gh pr create --draft'},ctx)).toBeNull()
  })
  it('holds without executing and loads full live checklist',async()=>{
    const t=setup()
    t.settings.prGateSkillPages=['Review policy']
    await t.store.upsert('memory',{title:'Review policy',body:'Live policy body with exact full instructions',kind:'fact',topics:'review',pinned:false,source:'user'})
    expect(await t.gate.check('shell_run',t.args,ctx)).toContain('Live policy body with exact full instructions')
    const run=vi.fn(async()=> 'ran')
    const [tool]=withPrGate([{spec:{name:'shell_run',description:'',schema:{}},run}],t.gate)
    expect(await tool!.run(t.args,ctx)).toContain('NOT RUN')
    expect(run).not.toHaveBeenCalled()
  })
  it('refuses empty and boilerplate evidence',async()=>{
    const t=setup(), id=await t.hold()
    expect(await t.gate.attest(id,{},ctx)).toContain('Refused')
    expect(await t.gate.attest(id,Object.fromEntries(ATTESTATION_FIELDS.map(k=>[k,'n/a'])),ctx)).toContain('Refused')
  })
  it('refuses self review',async()=>{
    const t=setup(),id=await t.hold()
    expect(await t.gate.attest(id,{...t.evidence,reviewerAgentId:ctx.owner},ctx)).toContain('different agent')
  })
  it('binds identity and command; passes once; refuses replay',async()=>{
    const t=setup(),id=await t.hold()
    expect(await t.gate.attest(id,t.evidence,{...ctx,owner:'helper:another-agent'})).toContain('Refused')
    expect(await t.gate.attest(id,t.evidence,ctx)).toContain('recorded')
    expect(await t.gate.check('shell_run',{command:'gh pr ready 13'},ctx)).toContain('NOT RUN')
    expect(await t.gate.check('shell_run',t.args,ctx)).toBeNull()
    expect(await t.gate.check('shell_run',t.args,ctx)).toContain('NOT RUN')
    expect(await t.gate.attest(id,t.evidence,ctx)).toContain('Refused')
    expect((await t.store.list('chat_item')).filter(r=>r.kind==='pr_gate').length).toBeGreaterThan(5)
  })
  it('expires and prevents simultaneous double consumption',async()=>{
    const t=setup(),id=await t.hold()
    await t.gate.attest(id,t.evidence,ctx)
    const results=await Promise.all([t.gate.check('shell_run',t.args,ctx),t.gate.check('shell_run',t.args,ctx)])
    expect(results.filter(r=>r===null)).toHaveLength(1)
    const next=await t.hold(); t.expire()
    expect(await t.gate.attest(next,t.evidence,ctx)).toContain('Refused')
  })
})

describe('more transports and quoting',()=>{
  it.each([
    ['shell_run',{command:'gh pr list | gh pr ready 3'}],
    ['PowerShell',{command:'gh pr list\ngh pr ready 3'}],
    ['PowerShell',{command:'powershell -Command "gh pr ready 3"'}],
    ['shell_run',{command:'wsl -d Ubuntu -- bash -lc "gh pr ready 3"'}],
    ['shell_run',{command:'gh api repos/o/r/issues/4/comments -f body="Ready for review now."'}],
    ['shell_run',{command:'curl --request PATCH https://api.github.com/repos/o/r/pulls/4 --json \'{"draft":false}\''}],
    ['shell_run',{command:'gh api graphql -f query="mutation { requestReviews(input:{pullRequestId:\\"test\\"}) { clientMutationId } }"'}],
    ['browser_fetch',{method:'POST',url:'https://api.github.com/repos/o/r/pulls/1/requested_reviewers',body:'{}'}],
    ['browser_fetch',{method:'PATCH',url:'https://api.github.com/repos/o/r/pulls/1',body:'{"draft":false}'}],
    ['browser_fetch',{method:'POST',url:'https://api.github.com/graphql',body:'{"query":"mutation { requestReviews(input:{}) {clientMutationId} }"}'}],
    ['browser_eval',{js:'fetch("https://api.github.com/repos/o/r/pulls", {method:"POST",body:JSON.stringify({title:"test"})})'}],
    ['apps_run',{slug:'GITHUB_UPDATE_A_PULL_REQUEST',arguments:{draft:false}}],
  ])('detects %s %j',(name,args)=>expect(reviewableCall(name,args)).toBe(true))
  it.each([
    ['shell_run',{command:'gh api repos/o/r/pulls/4 -X PATCH -f title=changed'}],
    ['shell_run',{command:'gh api repos/o/r/issues/4/comments -X GET'}],
    ['shell_run',{command:'curl --json \'{"draft":true}\' https://api.github.com/repos/o/r/pulls'}],
    ['browser_fetch',{method:'GET',url:'https://api.github.com/repos/o/r/pulls'}],
    ['apps_run',{slug:'GITHUB_GET_A_PULL_REQUEST',arguments:{}}],
    ['apps_run',{slug:'GITHUB_CREATE_AN_ISSUE_COMMENT',arguments:{body:'Review finished, thanks'}}],
  ])('allows %s %j',(name,args)=>expect(reviewableCall(name,args)).toBe(false))
})

it('R7 heredoc syntax with sensitive text holds', () => expect(reviewableCall('shell_run', { command: 'cat <<EOF\ngh pr ready 3\nEOF' })).toBe(true))
