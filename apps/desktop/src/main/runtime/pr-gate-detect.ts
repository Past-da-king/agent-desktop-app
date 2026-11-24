import { parse, quote } from 'shell-quote'
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
type Args = Record<string, unknown>
function object(value: unknown): Args {
  if (typeof value === 'string') {
    try { return object(JSON.parse(value)) } catch {
      const params = new URLSearchParams(value)
      return Object.fromEntries(params)
    }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Args : {}
}
function unreadable(v: unknown): boolean { return typeof v === 'string' && /(^@|\$\{?[\w]|\{\{vault:)/.test(v) }
export function readyComment(v: unknown): boolean {
  return typeof v === 'string' && !/\bnot\s+ready\s+for\s+review\b/i.test(v) && /\bready\s+for\s+review\b/i.test(v)
}
function graph(query: unknown): boolean {
  if (typeof query !== 'string' || unreadable(query)) return true
  if (/\b(markPullRequestReadyForReview|requestReviews|mergePullRequest|enablePullRequestAutoMerge)\s*\(/.test(query)) return true
  if (/\bcreatePullRequest\s*\(/.test(query) && !/\bdraft\s*:\s*true\b/.test(query)) return true
  return /\b(addComment|addPullRequestReview)\s*\(/.test(query) && readyComment(query)
}
export function githubWrite(url: string, method: string, body: unknown, unknownBody = false): boolean {
  let path = url, web = false
  if (/^https?:/i.test(url)) {
    try {
      const parsed = new URL(url)
      if (!['api.github.com','github.com'].includes(parsed.hostname)) return false
      web = parsed.hostname === 'github.com'; path = parsed.pathname
    } catch { return false }
  }
  if (!/^(POST|PATCH|PUT)$/i.test(method)) return false
  const data = object(body), opaque = unknownBody || unreadable(body)
  if (/(^|\/)graphql(?:\?|$)/i.test(path)) return opaque || graph(data['query'])
  if (web) {
    if (/\/pull\/\d+\/(?:ready_for_review|review-requests|merge|auto_merge)(?:\/|$)/i.test(path)) return true
    if (/\/(?:pulls|pull\/(?:new|create)|compare)(?:\/|$)/i.test(path)) return opaque || data['draft'] !== true
    if (/\/(?:issues|pull)\/\d+\/comments?(?:\/|$)/i.test(path)) return opaque || readyComment(data['body'] ?? data['comment[body]'])
  }
  if (/\/pulls\/\d+\/(?:requested_reviewers|merge|auto_merge)(?:\?|$)/i.test(path)) return true
  if (/\/pulls(?:\?|$)/i.test(path) && /^POST$/i.test(method)) return opaque || ![true,'true'].includes(data['draft'] as boolean | string)
  if (/\/pulls\/\d+(?:\?|$)/i.test(path)) return opaque || [false,'false'].includes(data['draft'] as boolean | string)
  return /\/issues\/\d+\/comments(?:\?|$)/i.test(path) && (opaque || unreadable(data['body']) || readyComment(data['body']))
}
function option(words: string[], ...names: string[]): string | undefined {
  for (let i=0;i<words.length;i++) for (const name of names) {
    const word=words[i]??''
    if(word.toLowerCase()===name.toLowerCase())return words[i+1]
    if(word.toLowerCase().startsWith(name.toLowerCase()+'='))return word.slice(name.length+1)
    if(/^-[a-zA-Z]$/.test(name)&&word.startsWith(name)&&word.length>2)return word.slice(2)
  }
  return undefined
}
function base(w:string):string{return w.split(/[\\/]/).pop()!.replace(/\.exe$/i,'').toLowerCase()}
function gh(args:string[]):boolean{
  if(args.includes('--dry-run'))return false
  const issue=args.indexOf('issue'),pr=args.indexOf('pr'),rest=args.indexOf('api')
  const comment=():boolean=>readyComment(option(args,'--body','-b'))||args.includes('--body-file')||args.includes('-F')||unreadable(option(args,'--body','-b'))
  if(issue>=0&&args[issue+1]==='comment')return comment()
  if(pr>=0){
    const action=args[pr+1]
    if(action==='create'||action==='new')return !args.some(w=>/^--draft(?:=(?:true|1))?$/.test(w)||w==='-d')
    if(action==='ready')return !args.includes('--undo')
    if(['merge','review-request','request-review'].includes(action??''))return true
    if(action==='edit')return args.some(w=>/^--add-reviewer(?:=|$)/.test(w))
    if(action==='comment'||action==='review')return comment()
    return !['list','view','checks','diff','status','checkout','close','reopen','lock','unlock'].includes(action??'')
  }
  if(args[0]==='alias'&&args[1]==='set')return shell('gh '+args.slice(3).join(' '),1)
  if(rest>=0){
    const path=args.slice(rest+1).find(w=>/^(?:\/?repos\/|https:\/\/|\/?graphql$)/.test(w))??''
    const data:Args={};let opaque=args.includes('--input')
    for(let i=rest+1;i<args.length;i++){
      const word=args[i]!;let field:string|undefined
      if(/^(?:-f|-F|--field|--raw-field)$/.test(word))field=args[++i]
      else if(/^(?:-f|-F)[^=]+=/.test(word))field=word.slice(2)
      else if(/^--(?:raw-)?field=/.test(word))field=word.slice(word.indexOf('=')+1)
      if(field){const equal=field.indexOf('=');if(equal>=0){const value=field.slice(equal+1);data[field.slice(0,equal)]=value;opaque ||= unreadable(value)}}
    }
    const method=option(args,'-X','--method')??(opaque||Object.keys(data).length?'POST':'GET')
    return githubWrite(path,method,data,opaque)
  }
  return !['auth','repo','issue','run','workflow','release','search','status','config','extension','gist','label','project','cache','codespace','secret','variable','browse','alias','help','--help','--version'].includes(args[0]??'')
}
const SHELLS=new Set(['bash','sh','zsh','dash','pwsh','powershell'])
const INERT=new Set(['echo','printf','grep','rg','cat','write-output','write-host','git'])
const PREFIX=new Set(['then','do','else','elif','if','while','until','!','{','}'])
function argv(words:string[],depth:number):boolean{
  if(depth>12)return true
  let start=0
  while(PREFIX.has(words[start]??'')||/^[\w_]+=/.test(words[start]??''))start++
  words=words.slice(start)
  const exe=base(words[0]??''),args=words.slice(1)
  if(!exe||INERT.has(exe))return false
  if(exe==='eval')return shell(args.join(' '),depth+1)
  if(SHELLS.has(exe)){
    const i=args.findIndex(w=>/^-(?:[a-z]*c|command)$/i.test(w))
    return i>=0?shell(args.slice(i+1).join(' '),depth+1):true
  }
  if(exe==='wsl'){
    let i=0
    while(i<args.length){
      const a=args[i]!
      if(a==='--'||a==='-e'||a==='--exec'){i++;break}
      if(['-d','--distribution','-u','--user','--cd'].includes(a)){i+=2;continue}
      if(a.startsWith('-')){i++;continue}
      break
    }
    return shell(args.slice(i).join(' '),depth+1)
  }
  if(exe==='ssh'){
    let i=0
    while(args[i]?.startsWith('-')){const a=args[i++]!;if(['-p','-i','-l','-o','-F','-J','-S'].includes(a))i++}
    return shell(args.slice(i+1).join(' '),depth+1)
  }
  if(['env','sudo','command','exec','nohup','xargs','timeout','time'].includes(exe)){
    const i=args.findIndex(w=>['gh','curl','irm','invoke-restmethod',...SHELLS].includes(base(w)))
    return i>=0?argv(args.slice(i),depth+1):args.some(w=>/\b(?:gh|github)\b/i.test(w))
  }
  if(exe==='gh')return gh(args)
  if(['curl','invoke-restmethod','irm','invoke-webrequest','iwr','fetch'].includes(exe)){
    const url=args.find(w=>/^https:\/\/(?:api\.)?github\.com\//i.test(w))??''
    const body=option(args,'-d','--data','--data-raw','--data-binary','--json','-Body')
    return githubWrite(url,option(args,'-X','--request','-Method')??(body===undefined?'GET':'POST'),body,unreadable(body))
  }
  if(['node','python','python3'].includes(exe))return script(option(args,'-e','--eval','-c')??'')
  if(exe.startsWith('$')&&args.some(w=>/^(pr|issue|api)$/.test(w)))return true
  const ghIndex=words.findIndex(w=>base(w)==='gh')
  return ghIndex>0&&gh(words.slice(ghIndex+1))
}
/** Active substitutions are executable; strings in single quotes remain inert. */
function substitutions(source:string):string[]{
  const out:string[]=[];let quote=''
  for(let i=0;i<source.length;i++){
    const c=source[i]!
    if(c==='\\'){i++;continue}
    if(c==="'"&&quote!=='"'){quote=quote==="'"?'':"'";continue}
    if(c==='"'&&quote!=="'"){quote=quote==='"'?'':'"';continue}
    if(quote==="'")continue
    if(c==='\x60'){
      let j=i+1;while(j<source.length&&source[j]!=='\x60'){if(source[j]==='\\')j++;j++}
      out.push(source.slice(i+1,j));i=j;continue
    }
    if(c==='$'&&source[i+1]==='('){
      let j=i+2,level=1,q=''
      for(;j<source.length;j++){
        const x=source[j]!
        if(x==='\\'){j++;continue}
        if(q){if(x===q)q='';continue}
        if(x==="'"||x==='"'){q=x;continue}
        if(x==='(')level++
        if(x===')'){level--;if(level===0)break}
      }
      out.push(source.slice(i+2,j));i=j
    }
  }
  return out
}
/** shell-quote supplies operators, quoted words, comments and variable boundaries. */
function shell(source:string,depth=0):boolean{
  if(depth>12)return true
  source=source.replace(/\\\r?\n|\x60\r?\n/g,'')
  const lines=source.split('\n'),kept:string[]=[],bodies:string[]=[]
  for(let i=0;i<lines.length;i++){
    const header=lines[i]!,match=header.match(/<<-?\s*['"]?([\w]+)['"]?/)
    if(!match){kept.push(header);continue}
    kept.push(header.replace(match[0],''))
    const body:string[]=[]
    while(++i<lines.length&&lines[i]!.trim()!==match[1])body.push(lines[i]!)
    if(/\b(?:bash|sh|zsh|pwsh|powershell)\b/.test(header))bodies.push(body.join('\n'))
  }
  if(bodies.some(b=>shell(b,depth+1)))return true
  source=kept.join('\n')
  if(substitutions(source).some(s=>shell(s,depth+1)))return true
  let q='',normal=''
  for(let i=0;i<source.length;i++){
    const c=source[i]!
    if(c==='\\'){normal+=c+(source[++i]??'');continue}
    if(c==="'"||c==='"'){if(!q)q=c;else if(q===c)q=''}
    normal+=c==='\n'&&!q?';':c
  }
  try{
    const entries=parse(normal,key=>'$'+key),parts:string[][]=[[]]
    for(const entry of entries){
      if(typeof entry==='string')parts[parts.length-1]!.push(entry)
      else if('op'in entry&&entry.op!=='glob')parts.push([])
    }
    if(/\|\s*(?:bash|sh|zsh|pwsh|powershell)\b/.test(normal))return true
    return parts.some(part=>argv(part,depth))
  }catch{return /\b(?:gh|github|bash|pwsh|powershell)\b/.test(source)}
}
function script(code:string):boolean{
  const url=code.match(/https:\/\/(?:api\.)?github\.com\/[^'"\s)]+/)?.[0]
  if(!url&&!/github\.com/.test(code))return false
  if(/\.(?:click|submit)\s*\(/.test(code))return true
  if(!/\b(fetch|requests\.(?:post|patch|put)|urlopen)\b/.test(code))return false
  const method=code.match(/(?:method\s*[:=]\s*['"]|requests\.)(post|patch|put)/i)?.[1]??'GET'
  return githubWrite(url??'https://api.github.com/graphql',method,{draft:/\bdraft['"]?\s*:\s*true\b/.test(code),query:code,body:code},!url)
}
export function reviewableCall(name:string,input:Args):boolean{
  name=name.replace(/^mcp__agent__/,'')
  if(['shell_run','Bash','PowerShell','exec_command'].includes(name))return shell(String(input['command']??input['cmd']??''))
  if(name==='device_tool')return false // The destination enforces its own gate exactly once.
  if(name==='browser_fetch'){
    if(input['from']&&!input['_resolvedReplay'])return true
    return githubWrite(String(input['url']??''),String(input['method']??'GET'),input['body'],input['_unknownBody']===true)
  }
  if(['browser_act','browser_click'].includes(name)){
    if(!/^https:\/\/github\.com(?:\/|$)/i.test(String(input['pageUrl']??'')))return false
    if(name==='browser_click')return true
    return /click|press|select|check/.test(String(input['action']))&&(!input['name']||/ready\s+for\s+review|request\s+review|create\s+pull\s+request|merge\s+pull\s+request/i.test(String(input['name']??'')))
  }
  if(name==='browser_eval'||name==='run_code')return script(String(input['js']??input['code']??''))
  if(name==='webapp_run')return /github/i.test(String(input['app']))&&/(?:create|open|ready|request|merge).*(?:pull|pr|review)|(?:pull|pr).*(?:create|open|ready|merge)/i.test(String(input['tool']))
  if(name==='apps_run'){
    const slug=String(input['slug']??'').toUpperCase(),args=object(input['arguments'])
    if(!slug.startsWith('GITHUB_'))return false
    if(/REQUEST.*REVIEW|MARK.*READY.*REVIEW|MERGE.*PULL_REQUEST/.test(slug))return true
    if(/^GITHUB_CREATE_(?:A_)?PULL_REQUEST$/.test(slug))return args['draft']!==true
    if(/(?:UPDATE|EDIT).*PULL_REQUEST/.test(slug))return args['draft']===false
    if(/CREATE.*(?:COMMENT|REVIEW)/.test(slug))return readyComment(args['body'])
    if(/GRAPHQL/.test(slug))return graph(args['query'])
  }
  return false
}

/** Approvals are observed for audit, but do not require the reviewability grant. */
export function reviewApproval(name:string,input:Args):boolean {
  if(name==='apps_run')return /^GITHUB_.*CREATE.*REVIEW/.test(String(input['slug'])) && String(object(input['arguments'])['event']).toUpperCase()==='APPROVE'
  if(['shell_run','Bash','PowerShell'].includes(name)){
    try{
      const words=parse(String(input['command']??''),key=>'$'+key)
      const ghAt=words.findIndex(w=>typeof w==='string'&&base(w)==='gh')
      return ghAt>=0&&words[ghAt+1]==='pr'&&words[ghAt+2]==='review'&&words.includes('--approve')
    }catch{return false}
  }
  return false
}

/** Snapshot a readable direct comment body into argv, so execution uses the bytes we checked. */
export function inlineCommentFile(name:string,input:Args,cwd?:string):Args{
  if(!['shell_run','Bash','PowerShell'].includes(name))return input
  try{
    const entries=parse(String(input['command']??''),key=>'$'+key)
    if(!entries.every(e=>typeof e==='string'))return input
    const words=entries as string[],ghAt=words.findIndex(w=>base(w)==='gh')
    if(ghAt!==0||!['pr','issue'].includes(words[ghAt+1]??'')||words[ghAt+2]!=='comment')return input
    const at=words.findIndex(w=>w==='--body-file'||w==='-F')
    const file=words[at+1]
    if(at<0||!file||file==='-'||unreadable(file))return input
    const path=resolve(String(input['cwd']??cwd??homedir()),file)
    if(statSync(path).size>1_000_000)return input
    const body=readFileSync(path,'utf8')
    if(body.includes('{{vault:'))return input
    words.splice(at,2,'--body',body)
    return {...input,command:quote(words)}
  }catch{return input}
}
