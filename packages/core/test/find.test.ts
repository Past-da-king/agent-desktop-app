import { describe, expect, it } from 'vitest'

import { editDistance, findMatches, findProjects, findWords, folderName, parseAliases, pickMatch, queryWords, type ProjectLike } from '../src/find'

/** Ayanda's projects as they were on 22 Oct 2026 (names, a line of each description, folders). */
const PROJECTS: (ProjectLike & { id: string })[] = [
  { id: 'creek', name: 'The Creek Collection', description: 'The Creek Collection leisure sites: three Astro sites in one repo.', path: '\\\\wsl.localhost\\Ubuntu\\home\\past9\\Desktop\\projects\\to do\\creek-leisure' },
  { id: 'agent', name: 'Agent Desktop App', description: "Ayanda's own Electron agent app.", path: '\\\\wsl.localhost\\Ubuntu\\home\\past9\\agent-desktop-app' },
  { id: 'sew', name: 'Strat Edge Website', description: 'The redesigned Strat Edge website (strategyedge.co.za rebuild).', path: 'C:\\Users\\past9\\Downloads\\dc\\strategyedge-site' },
  { id: 'gw', name: 'Guavas Website', description: 'The guavas.co.uk rebuild and cutover onto Astro.', path: 'C:\\Users\\past9\\Desktop\\projects\\Guavas\\Guavas-Website-Phase-1' },
  { id: 'gls', name: 'Guavas Lender Selector', description: "Ruan's lender matching tool: business assessment and product routing.", path: 'C:\\Users\\past9\\Desktop\\projects\\Guavas\\guavas-lender-selector' },
  { id: 'sc', name: 'StudyCanvas', description: 'The Gemini Live voice tutor that draws a lesson onto an infinite canvas.', path: 'C:\\Users\\past9\\Desktop\\projects\\study-canvas' },
  { id: 'rmblr', name: 'RMBLR', description: 'The MIT Android dictation app.', path: '\\\\wsl.localhost\\Ubuntu\\home\\past9\\rmblr', aliases: ['Rumbler'] },
  { id: 'pf', name: 'Portfolio', description: 'phaketsi.vercel.app, the page a recruiter or client lands on.', path: '\\\\wsl.localhost\\Ubuntu\\home\\past9\\personal-site\\portfolio' },
  { id: 'bg', name: 'Brand Guardian', description: "The brand consistency agent: it checks work against each brand's guidelines.", path: 'C:\\Users\\past9\\Desktop\\projects\\brand-guardian' },
  { id: 'gos', name: 'GrowOS', description: "GrowFactory's parent brand and the GrowOS marketing site.", path: 'C:\\Users\\past9\\Desktop\\projects\\growfactory' },
  { id: 'apps', name: 'Applications', description: 'The job hunt: tailored CVs, cover letters and submissions.', path: '\\\\wsl.localhost\\Ubuntu\\home\\past9\\applications' },
  { id: 'imp', name: 'Impetix', description: 'His own company: Impetix Digital, the AI services site and cold outreach.', path: 'C:\\Users\\past9\\Desktop\\projects\\im' },
  { id: 'sep', name: 'Strat Edge Platform', description: 'The suite Strat Edge sells and hosts for clients.', path: '\\\\wsl.localhost\\Ubuntu\\home\\past9\\strat-edge-platform' },
  { id: 'seid', name: 'Strat Edge ID', description: 'The spine: universal login with compulsory authenticator.', path: 'C:\\Users\\past9\\Downloads\\dc\\strat-edge-id' },
  { id: 'pro', name: 'Prospect', description: 'Lead generation and data mining with Gemini grounded search.', path: 'C:\\Users\\past9\\Downloads\\dc\\strat-intel' },
  { id: 'pp', name: 'Project Portal', description: 'The delivery tool: projects, baseline schedules, risk register.', path: 'C:\\Users\\past9\\Downloads\\dc\\strat-edge-portal' },
  { id: 'crm', name: 'Mthashana CRM', description: 'The Mthashana TVET partnerships instrument.', path: 'C:\\Users\\past9\\Downloads\\dc\\crm-1' },
  { id: 'fin', name: 'Finance', description: 'The money spine outside the ERP: multi-entity double-entry ledger.', path: 'C:\\Users\\past9\\Downloads\\dc\\finance' },
  { id: 'lc', name: 'LondaCorp ERP', description: 'The production LondaCorp ERP for the construction client.', path: '\\\\wsl.localhost\\Ubuntu\\home\\past9\\apps\\londacorp-production' },
  { id: 'cr', name: 'Creek Retreats', description: 'The parent: the Creek Retreats group umbrella site.', path: '\\\\wsl.localhost\\Ubuntu\\home\\past9\\Desktop\\projects\\to do\\creek-retreats' },
]

const top = (query: string): string | undefined => findProjects(query, PROJECTS)[0]?.item.name
const winner = (query: string): string | undefined => pickMatch(findProjects(query, PROJECTS)).winner?.item.name

describe('finding a project the way it is said', () => {
  it('"show me the lender select" finds Guavas Lender Selector', () => {
    expect(top('show me the lender select')).toBe('Guavas Lender Selector')
    expect(winner('show me the lender select')).toBe('Guavas Lender Selector')
  })

  it('"strategic website" (dictation for Strat Edge) finds Strat Edge Website', () => {
    expect(top('strategic website')).toBe('Strat Edge Website')
    expect(winner('strategic website')).toBe('Strat Edge Website')
  })

  it('"creek" puts the two Creek projects first', () => {
    const names = findProjects('creek', PROJECTS).map((hit) => hit.item.name)
    expect(names.slice(0, 2).sort()).toEqual(['Creek Retreats', 'The Creek Collection'])
    // Two equally good ones: the agent asks which.
    const picked = pickMatch(findProjects('creek', PROJECTS))
    expect(picked.winner).toBeNull()
    expect(picked.close.map((hit) => hit.item.name).sort()).toEqual(['Creek Retreats', 'The Creek Collection'])
  })

  it('"creek collection" and "open the creek retreats project" pick one', () => {
    expect(winner('creek collection')).toBe('The Creek Collection')
    expect(winner('open the creek retreats project')).toBe('Creek Retreats')
  })

  it('"londa" finds LondaCorp ERP', () => {
    expect(winner('londa')).toBe('LondaCorp ERP')
  })

  it('"study canvas" finds StudyCanvas', () => {
    expect(winner('study canvas')).toBe('StudyCanvas')
    expect(winner('studycanvas')).toBe('StudyCanvas')
  })

  it('"open rumbler" finds RMBLR through its other name', () => {
    expect(winner('open rumbler')).toBe('RMBLR')
  })

  it('forgives a typo and a cut-off word', () => {
    expect(winner('lendr selctor')).toBe('Guavas Lender Selector')
    expect(winner('impetx')).toBe('Impetix')
    expect(winner('portfolo')).toBe('Portfolio')
  })

  it('finds by the description and the folder name, below the name', () => {
    expect(top('job hunt')).toBe('Applications')
    expect(top('growfactory')).toBe('GrowOS')
    // "ERP" is in LondaCorp's name and only in Finance's description: the name wins.
    const erp = findProjects('erp', PROJECTS).map((hit) => hit.item.name)
    expect(erp[0]).toBe('LondaCorp ERP')
    expect(erp).toContain('Finance')
  })

  it('finds nothing for words nowhere in any project', () => {
    expect(findProjects('banana smoothie', PROJECTS)).toEqual([])
    expect(pickMatch(findProjects('banana smoothie', PROJECTS))).toEqual({ winner: null, close: [] })
  })

  it('takes old rows with no other names, and ignores junk in them', () => {
    const odd = [{ name: 'Old One', description: '', path: '', aliases: [3, null, 'Legacy'] as unknown as string[] }]
    expect(findProjects('legacy', odd)[0]?.item.name).toBe('Old One')
    expect(findProjects('old', [{ name: 'Old One', description: '', path: '' }])).toHaveLength(1)
  })
})

describe('the words of the matcher', () => {
  it('drops filler but keeps a query that is only filler', () => {
    expect(queryWords('show me the lender select')).toEqual(['lender', 'select'])
    expect(queryWords('Open')).toEqual(['open'])
  })

  it('splits camelCase, punctuation and folder separators', () => {
    expect(findWords('StudyCanvas')).toEqual(['study', 'canvas'])
    expect(findWords('LondaCorp ERP')).toEqual(['londa', 'corp', 'erp'])
    expect(findWords('GrowOS')).toEqual(['grow', 'os'])
    expect(findWords('guavas-lender_selector')).toEqual(['guavas', 'lender', 'selector'])
    expect(folderName('C:\\Users\\x\\study-canvas\\')).toBe('study-canvas')
    expect(folderName('/home/x/rmblr')).toBe('rmblr')
  })

  it('counts edits with adjacent swaps as one', () => {
    expect(editDistance('lender', 'lender')).toBe(0)
    expect(editDistance('lednre', 'lender')).toBe(2)
    expect(editDistance('ca', 'ac')).toBe(1)
    expect(editDistance('kitten', 'sitting')).toBe(3)
    expect(editDistance('abc', 'abcdefgh', 2)).toBe(3)
  })

  it('reads other names typed on one line', () => {
    expect(parseAliases(' Rumbler,  rmblr app ; rumbler\nThe orb ')).toEqual(['Rumbler', 'rmblr app', 'The orb'])
    expect(parseAliases('')).toEqual([])
  })

  it('works for the palette pages too', () => {
    const pages = ['Home', 'Chat', 'Tasks', 'Memory', 'Routines', 'Connections', 'Settings', 'Stop all helpers', 'Add a to-do'].map((label) => ({ item: label, fields: [{ text: label, weight: 1 }] }))
    expect(findMatches('take me to settings', pages)[0]?.item).toBe('Settings')
    expect(findMatches('setings', pages)[0]?.item).toBe('Settings')
    expect(findMatches('stop helpers', pages)[0]?.item).toBe('Stop all helpers')
    expect(findMatches('mem', pages)[0]?.item).toBe('Memory')
    expect(findMatches('', pages)).toEqual([])
  })
})
