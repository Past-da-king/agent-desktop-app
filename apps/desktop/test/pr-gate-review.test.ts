import { describe, expect, it } from 'vitest'
import { reviewableCall } from '../src/main/runtime/pr-gate'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inlineCommentFile } from '../src/main/runtime/pr-gate-detect'
describe('review findings: shell grammar and all review surfaces',()=>{
 it.each([
  '(gh pr ready 3)','{ gh pr ready 3; }','if true; then gh pr ready 3; fi',
  'for n in 3; do gh pr ready $n; done','! gh pr ready 3',
  'echo "$(gh pr ready 3)"','echo \`gh pr ready 3\`',
  'xargs gh pr ready','eval "gh pr ready 3"','timeout 30 gh pr ready 3',
  'time gh pr ready 3','sudo -u bob gh pr ready 3','wsl -d Ubuntu gh pr ready 3',
  "ssh -p 22 host 'gh pr ready 3'",'gh pr \\\nready 3',
  'bash <<EOF\ngh pr ready 3\nEOF','echo "gh pr ready 3" | bash',
  'cat <<EOF >/dev/null; gh pr ready 3\nDocs\nEOF',
  'gh pr new','gh issue comment 3 -b "Ready for review"',
  'gh pr review 3 --comment -b "Ready for review"',
  'gh pr merge 3','gh api repos/o/r/pulls/3/merge -X PUT',
  'gh api /graphql -f query="mutation { mergePullRequest(input:{}) {clientMutationId} }"',
  'gh api graphql -f query="mutation { createPullRequest(input:{title:\\"test\\"}) {clientMutationId} }"',
  'gh api repos/o/r/pulls/3 --input - -X PATCH',
  'gh api repos/o/r/issues/3/comments --input file.json',
  'gh api graphql -F query=@query.graphql',
  'curl -X PATCH https://api.github.com/repos/o/r/pulls/3 -d @file.json',
  'curl -X POST https://api.github.com/repos/o/r/issues/3/comments -d @file.json',
  'gh alias set rr "pr ready" && gh rr 3',
  '$G pr ready 3',
 ])('holds %s',command=>expect(reviewableCall('shell_run',{command})).toBe(true))
 it.each([
  'gh pr create --dry-run','gh pr create --draft=1',
  'gh pr comment 3 -b "Not ready for review yet"',
  'echo "gh pr ready 3"',
  'gh pr review 3 --comment -b "Looks good"',
 ])('passes %s',command=>expect(reviewableCall('shell_run',{command})).toBe(false))
 it.each([
  ['browser_fetch',{from:'r12'}],
  ['browser_fetch',{url:'https://github.com/o/r/pull/3/ready_for_review',method:'POST'}],
  ['browser_fetch',{url:'https://api.github.com/repos/o/r/pulls/3/merge',method:'PUT'}],
  ['browser_act',{action:'click',name:'Ready for review',pageUrl:'https://github.com/o/r/pull/3'}],
  ['browser_act',{action:'click',name:'Merge pull request',pageUrl:'https://github.com/o/r/pull/3'}],
  ['browser_click',{index:3,pageUrl:'https://github.com/o/r/pull/3'}],
  ['webapp_run',{app:'GitHub',tool:'ready_pull_request'}],
  ['apps_run',{slug:'GITHUB_MERGE_A_PULL_REQUEST',arguments:{}}],
 ])('holds %s %j',(tool,args)=>expect(reviewableCall(tool,args)).toBe(true))
 it('does not hold review approval or unrelated buttons',()=>{
  expect(reviewableCall('apps_run',{slug:'GITHUB_CREATE_A_REVIEW_FOR_A_PULL_REQUEST',arguments:{event:'APPROVE'}})).toBe(false)
  expect(reviewableCall('browser_act',{action:'click',name:'Ready for review',pageUrl:'https://example.com'})).toBe(false)
 })
})

it('snapshots readable comment bodies and holds unknown ones',()=>{
 const dir=mkdtempSync(join(tmpdir(),'pr-body-'))
 try{
  const path=join(dir,'body.md');writeFileSync(path,'Not ready for review yet')
  const original={command:'gh pr comment 3 --body-file body.md',cwd:dir}
  const captured=inlineCommentFile('shell_run',original)
  expect(reviewableCall('shell_run',captured)).toBe(false)
  writeFileSync(path,'Ready for review')
  expect(reviewableCall('shell_run',inlineCommentFile('shell_run',original))).toBe(true)
  expect(reviewableCall('shell_run',inlineCommentFile('shell_run',{...original,command:'gh pr comment 3 --body-file missing.md'}))).toBe(true)
  expect(captured['command']).not.toContain('--body-file')
 }finally{rmSync(dir,{recursive:true,force:true})}
})

it('R7 heredoc syntax with sensitive text holds', () => expect(reviewableCall('shell_run', { command: 'cat <<EOF\ngh pr ready 3\nEOF' })).toBe(true))
