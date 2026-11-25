import { withGhExecution } from './pr-gate-exec'
/**
 * A review workflow guard, shared by the desktop and headless toolsets.
 * This recognises explicit GitHub operations; it is not a sandbox for arbitrary programs.
 */
import { createHash, randomUUID } from 'node:crypto'
import { hostname, homedir } from 'node:os'
import {
  schema,
  str,
  type JsonObject,
  type Settings,
  type Tool,
  type ToolContext,
} from '@agent/core'
import {
  consumeRemoteGrant,
  incomingGrantId,
  verifiedRemoteGrant,
  remoteGrantConsumed,
  incomingSigner,
  markAlreadyRan,
  takeAlreadyRan,
  beginPrGateCall,
  remoteCaller,
  prepareRemoteGrant,
  markDestinationHold,
  takeRemoteChallenge,
} from './pr-gate-remote'
import { redactSecrets } from '../logger'
import {
  prGateKey,
  newPrGateKey,
  publicKey,
  keyId,
  type PrGateSecrets,
} from './pr-gate-key'
import { DEVICE_ARG_TOOLS } from '../devices/device-tools'
import { LEARNED_RUN_TOOLS } from '../devices/learned-route'
import { listWhere, type DataStore } from './data'
import {
  reviewApproval,
  reviewableCall,
  scriptReadNotes,
  bodyFileSignature,
  cleanupCommentFile,
} from './pr-gate-detect'
export { reviewableCall } from './pr-gate-detect'

export const PR_GATE_CHAT = 'pr-gate-audit'
export const ATTESTATION_FIELDS = [
  'reviewerAgentId',
  'testProof',
  'trialMergeAndSuite',
  'featureFlagStates',
  'environmentChecks',
  'skippedTests',
  'diffHygiene',
  'finalDescription',
] as const
export const GENERIC_CHECKLIST = [
  'Read the full final diff and callers. Have a different agent review the change and fix its findings.',
  'Prove the tests fail without the fix, then pass on the final head. Run typecheck, lint, build and the full suite.',
  'Trial-merge all your open PRs onto the current target and run the suite together.',
  'Test all feature-flag states, including off and unreadable, on every output and fallback.',
  'Check required environment variables for every branch and deployment target.',
  'List every skipped test and why. Check security, migrations and rollback.',
  'Check diff hygiene: no unintended mode changes, stray files, secrets or build artifacts.',
  'Re-read the PR description at the final head; state proof, effective configuration and remaining limits.',
].join('\n')

function agentIdentity(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^(helper|chat|project|agent):/, '')
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    )
  return JSON.stringify(value) ?? 'null'
}
interface Pending {
  id: string
  key: string
  actor: string
  expires: number
  attestation?: Record<string, string>
}
export class PrGate {
  private pending = new Map<string, Pending>()
  private remoteWrites = new Map<string, number>()
  private scriptNotes = new Map<string, number>()
  private remoteKey(input: JsonObject, ctx: ToolContext): string {
    return canonical({ input, actor: this.actor(ctx) })
  }
  isRemoteWrite(input: JsonObject, ctx: ToolContext): boolean {
    for (const [key, expires] of this.remoteWrites)
      if (expires < this.now()) this.remoteWrites.delete(key)
    return this.remoteWrites.has(this.remoteKey(input, ctx))
  }
  async holdRemote(
    input: JsonObject,
    ctx: ToolContext,
    tool = 'device_tool',
  ): Promise<string | null> {
    this.remoteWrites.set(
      this.remoteKey(input, ctx),
      this.now() + 24 * 60 * 60_000,
    )
    return this.check(tool, input, ctx)
  }
  constructor(
    private store: DataStore,
    private settings: () => Settings,
    private now = Date.now,
    private transportKey: () =>
      string | undefined | Promise<string | undefined> = prGateKey,
    private verifier?: (signer: string) => Promise<string | undefined>,
    public rotate?: () => Promise<string>,
  ) {}
  async signingKey(): Promise<string | undefined> {
    return this.transportKey()
  }
  enabled(): boolean {
    return this.settings().prGateEnabled
  }
  private actor(ctx: ToolContext): string {
    const caller = remoteCaller(ctx)
    return caller.owner + ':' + caller.chat
  }
  private async log(
    ctx: ToolContext,
    tool: string,
    outcome: string,
    gateId: string,
    fields?: Record<string, string>,
  ): Promise<void> {
    await this.store.upsert('chat_item', {
      kind: 'pr_gate',
      text: outcome,
      // Never store shell commands, API headers or bodies: they may contain credentials.
      meta: JSON.stringify({
        chat: PR_GATE_CHAT,
        at: this.now(),
        actor: this.actor(ctx),
        device: hostname(),
        tool,
        gateId,
        outcome,
        attestation: fields
          ? Object.fromEntries(
              Object.entries(fields).map(([k, v]) => [
                k,
                redactSecrets(v).slice(0, 1000),
              ]),
            )
          : null,
      }),
    })
    const rows = await listWhere(this.store, 'chat_item', {
      chat: PR_GATE_CHAT,
      kind: 'pr_gate',
      newestFirst: true,
    })
    const notes = rows.filter((row) =>
      [
        'unreadable local script (not gated)',
        'review approval (not gated)',
      ].includes(row.text),
    )
    const decisions = rows.filter(
      (row) =>
        ![
          'unreadable local script (not gated)',
          'review approval (not gated)',
        ].includes(row.text),
    )
    for (const row of [...notes.slice(100), ...decisions.slice(500)])
      await this.store.remove('chat_item', row.id)
  }
  private async policyChange(
    tool: string,
    input: JsonObject,
    ctx: ToolContext,
  ): Promise<string | null> {
    const method = String(input['method'] ?? '')
      .trim()
      .replace(/^agent\./, '')
    if (
      tool === 'app_action' &&
      ['settings.reset', 'settings.resetSettings'].includes(method) &&
      this.enabled()
    ) {
      return (await ctx.approve(
        'Reset settings including PR gate',
        'This resets the PR gate to off.',
        undefined,
        { tool: 'pr_gate_policy', input: { action: 'reset' } },
      ))
        ? null
        : 'Refused: only the person resets the PR gate.'
    }
    const pages = this.settings().prGateSkillPages.map((title) =>
      title.trim().toLowerCase(),
    )
    if (!pages.length) return null
    let candidate = input
    if (tool === 'app_action' && method === 'data.upsert') {
      const args = input['args']
      if (!Array.isArray(args) || args[0] !== 'memory') return null
      candidate = args[1] as JsonObject
    } else if (tool === 'app_action') {
      const args = Array.isArray(input['args']) ? input['args'] : []
      if (
        [
          'memory.runImport',
          'memory.startTidy',
          'memory.undoTidy',
          'memory.runDaily',
        ].includes(method)
      ) {
        return (await ctx.approve(
          'Rewrite PR gate policy pages',
          pages.join(', '),
          undefined,
          {
            tool: 'pr_gate_policy',
            input: { action: method },
          },
        ))
          ? null
          : 'Refused: only the person may rewrite PR gate policy pages.'
      }
      if (method === 'data.remove' && args[0] === 'memory')
        candidate = { id: String(args[1] ?? '') }
      else if (method === 'memory.undoChange') {
        if (input['_policyUndoKnown'] !== true) {
          return (await ctx.approve(
            'Undo an unverified memory change',
            'The app could not resolve which policy page this affects.',
            undefined,
            { tool: 'pr_gate_policy', input: { action: method } },
          ))
            ? null
            : 'Refused: cannot verify the memory change.'
        }
        candidate = { id: String(input['_policyMemoryId'] ?? '') }
      } else if (method === 'memory.restoreVersion')
        candidate = { id: String(args[0] ?? '') }
      else return null
    } else if (!['memory_save', 'memory_update'].includes(tool)) return null
    const old =
      typeof candidate['id'] === 'string'
        ? await this.store.get('memory', candidate['id'].trim())
        : null
    if (
      ![old?.title, candidate['title']].some(
        (title) =>
          typeof title === 'string' &&
          pages.includes(title.trim().toLowerCase()),
      )
    )
      return null
    const title = old?.title ?? String(candidate['title'])
    const yes = await ctx.approve(
      'Change PR gate policy page',
      title,
      undefined,
      {
        tool: 'pr_gate_policy',
        input: { title },
      },
    )
    return yes
      ? null
      : 'Refused: only the person may change a configured PR gate policy page.'
  }
  async acceptRemote(
    tool: string,
    input: JsonObject,
    ctx: ToolContext,
  ): Promise<boolean> {
    const id = incomingGrantId(ctx)
    if (!id) return false
    const receipt =
      'pr-gate-used:' + createHash('sha256').update(id).digest('hex')
    const signer = incomingSigner(ctx)
    const key = this.verifier
      ? signer
        ? await this.verifier(signer)
        : undefined
      : await this.transportKey()
    if (!key) return false
    if (!verifiedRemoteGrant(ctx, tool, input, key)) return false
    if (
      remoteGrantConsumed(ctx) ||
      (await this.store.get('chat_item', receipt))
    ) {
      markAlreadyRan(ctx)
      return false
    }
    if (!consumeRemoteGrant(ctx, tool, input, key)) return false
    // Commit the tombstone BEFORE any effect can run. It survives process restart
    // and audit pruning, and contains no command, transport signature or key.
    await this.store.upsert('chat_item', {
      id: receipt,
      kind: 'pr_gate_grant_used',
      text: 'Remote PR grant consumed',
      meta: JSON.stringify({ chat: PR_GATE_CHAT, at: this.now() }),
    })
    for (const old of await listWhere(this.store, 'chat_item', {
      chat: PR_GATE_CHAT,
      kind: 'pr_gate_grant_used',
      before: this.now() - 24 * 60 * 60_000,
    }))
      await this.store.remove('chat_item', old.id)
    await this.log(ctx, tool, 'remote grant passed once', randomUUID())
    return true
  }
  async check(
    tool: string,
    input: JsonObject,
    ctx: ToolContext,
  ): Promise<string | null> {
    if (['shell_run', 'Bash', 'PowerShell'].includes(tool))
      input = {
        ...input,
        cwd: input['cwd'] ?? ctx.commandFallback?.cwd ?? homedir(),
      }
    const policy = await this.policyChange(tool, input, ctx)
    if (policy) return policy
    if (!this.settings().prGateEnabled) return null
    if (!reviewableCall(tool, input) && !this.isRemoteWrite(input, ctx)) {
      if (
        ['shell_run', 'Bash', 'PowerShell'].includes(tool) &&
        scriptReadNotes(input, tool).length
      ) {
        const noteKey = canonical({
          tool,
          notes: scriptReadNotes(input, tool),
          cwd: input['cwd'] ?? ctx.commandFallback?.cwd ?? homedir(),
          actor: this.actor(ctx),
        })
        const now = this.now()
        for (const [key, expiry] of this.scriptNotes)
          if (expiry < now) this.scriptNotes.delete(key)
        if (!this.scriptNotes.has(noteKey)) {
          this.scriptNotes.set(noteKey, now + 60 * 60_000)
          await this.log(
            ctx,
            tool,
            'unreadable local script (not gated)',
            randomUUID(),
          )
        }
      }
      if (reviewApproval(tool, input)) {
        const key = createHash('sha256')
          .update(
            canonical({
              tool,
              input: stableInput(tool, input),
              actor: this.actor(ctx),
            }),
          )
          .digest('hex')
        if (!this.scriptNotes.has(key)) {
          this.scriptNotes.set(key, this.now() + 60 * 60_000)
          await this.log(ctx, tool, 'review approval (not gated)', randomUUID())
        }
      }
      return null
    }
    const actor = this.actor(ctx),
      key = createHash('sha256')
        .update(canonical({ tool, input: stableInput(tool, input), actor }))
        .digest('hex')
    const now = this.now()
    for (const [id, p] of this.pending)
      if (p.expires < now) this.pending.delete(id)
    const match = [...this.pending.values()].find(
      (p) => p.key === key && p.actor === actor,
    )
    if (match?.attestation && match.expires >= now) {
      // Remove synchronously before awaiting a log write: concurrent calls cannot consume twice.
      this.pending.delete(match.id)
      await this.log(ctx, tool, 'passed once', match.id, match.attestation)
      return null
    }
    const pending = match ?? {
      id: randomUUID(),
      key,
      actor,
      expires: now + 24 * 60 * 60_000,
    }
    this.pending.set(pending.id, pending)
    if (!match) await this.log(ctx, tool, 'held for attestation', pending.id)
    // Memory payload substring queries are case-sensitive; titles are not.
    const pages = await this.store.list('memory')
    const wanted = this.settings().prGateSkillPages
    const found = wanted.flatMap((title) =>
      pages
        .filter(
          (p) => p.title.trim().toLowerCase() === title.trim().toLowerCase(),
        )
        .map((p) => '# ' + p.title + '\n' + p.body),
    )
    const checklist = found.length
      ? found.join('\n\n') +
        (found.length < wanted.length
          ? '\n\nMissing policy pages: use the generic checklist too.\n' +
            GENERIC_CHECKLIST
          : '')
      : GENERIC_CHECKLIST
    return (
      'PR gate: NOT RUN. This call contains a PR review or merge operation, or an unreadable payload for that operation. Inspect the payload before attesting. Gate id: ' +
      pending.id +
      '\n\n' +
      checklist +
      '\n\nCall pr_gate_attest with gateId and attestation containing non-empty evidence for: ' +
      ATTESTATION_FIELDS.join(', ') +
      '. reviewerAgentId must identify a different agent. Explain legitimate absences with evidence; empty or n/a boilerplate is refused. Then reissue this exact tool and arguments within sixty minutes of attestation. Permission is bound to this agent and chat and passes once.'
    )
  }
  async attest(id: string, value: unknown, ctx: ToolContext): Promise<string> {
    const p = this.pending.get(id),
      actor = this.actor(ctx),
      fields =
        value !== null && typeof value === 'object' && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {}
    let reason = ''
    if (!this.settings().prGateEnabled) reason = 'PR gate is off'
    else if (!p || p.actor !== actor || p.expires < this.now())
      reason = "unknown, expired, consumed or another agent\'s gate"
    else if (p.attestation) reason = 'already attested'
    else if (
      ATTESTATION_FIELDS.some(
        (k) =>
          typeof fields[k] !== 'string' ||
          String(fields[k]).trim().length < (k === 'reviewerAgentId' ? 1 : 8) ||
          /^(n\/?a|none|not applicable|yes|done|true|ok|passed)[.!]?$/i.test(
            String(fields[k]).trim(),
          ),
      )
    )
      reason = 'every field needs specific evidence, not boilerplate'
    else if (!/https?:\/\/|[\\/]/.test(String(fields['testProof'])))
      reason = 'testProof must contain a proof link or path'
    else if (
      [remoteCaller(ctx).owner, remoteCaller(ctx).agentLabel, actor]
        .filter(Boolean)
        .map((id) => agentIdentity(id!))
        .includes(agentIdentity(String(fields['reviewerAgentId'])))
    )
      reason = 'reviewer must be a different agent'
    if (reason) {
      await this.log(ctx, 'pr_gate_attest', 'refused: ' + reason, id)
      return 'Refused: ' + reason
    }
    const evidence = Object.fromEntries(
      ATTESTATION_FIELDS.map((k) => [
        k,
        String(fields[k]).trim().slice(0, 1000),
      ]),
    )
    p!.attestation = evidence
    p!.expires = this.now() + 60 * 60_000
    await this.log(ctx, 'pr_gate_attest', 'attested', id, evidence)
    return 'Attestation recorded. Reissue the identical held call once before its sixty-minute expiry.'
  }
  tools(): Tool[] {
    return [
      {
        spec: {
          name: 'pr_gate_rotate_key',
          description:
            'Rotate this brain PR gate signing key and publish its new public verification key. In-flight old grants are refused.',
          schema: schema([], {}),
        },
        run: async (_input, ctx) => {
          if (!this.rotate)
            return 'PR gate rotation is unavailable in this isolated toolset.'
          const summary = 'Rotate this brain PR gate signing key'
          const details =
            'Replace the local signing secret and publish a new public verification key. All in-flight old grants will be refused until retried after replication.'
          if (
            !(await ctx.approve(summary, details, undefined, {
              tool: 'pr_gate_rotate_key',
              input: {},
            }))
          ) {
            await this.log(ctx, 'pr_gate_rotate_key', 'declined', '')
            return 'PR gate key rotation declined.'
          }
          const result = await this.rotate()
          await this.log(ctx, 'pr_gate_rotate_key', result, '')
          return result
        },
      },
      {
        spec: {
          name: 'pr_gate_attest',
          description:
            'Attest the completed independent PR vetting evidence for a held PR gate. Reissue the identical held call afterwards; it passes once within sixty minutes of attestation.',
          schema: schema(['gateId', 'attestation'], {
            gateId: str('Gate id returned by PR gate'),
            attestation: {
              type: 'object',
              properties: Object.fromEntries(
                ATTESTATION_FIELDS.map((k) => [
                  k,
                  str('Specific evidence for ' + k),
                ]),
              ),
              required: [...ATTESTATION_FIELDS],
              additionalProperties: false,
            },
          }),
        },
        run: async (input, ctx) =>
          this.attest(String(input['gateId'] ?? ''), input['attestation'], ctx),
      },
    ]
  }
}
const gates = new WeakMap<DataStore, PrGate>()
export function prGateFor(
  store: DataStore,
  settings: () => Settings,
  secrets?: PrGateSecrets,
  selfId?: () => string,
): PrGate {
  let gate = gates.get(store)
  if (gate) return gate
  const signing = async (): Promise<string | undefined> => {
    const id = selfId?.(),
      row = id ? await store.get('device', id) : null
    if (secrets && (!row || row['revoked'] || !row.roles.includes('brain')))
      return undefined
    const key = prGateKey(secrets)
    if (row) {
      const pub = publicKey(key)
      if (row.prGatePublicKey !== pub)
        await store.upsert('device', { id: row.id, prGatePublicKey: pub })
    }
    return key
  }
  gate = new PrGate(
    store,
    settings,
    Date.now,
    signing,
    secrets
      ? async (signer) => {
          for (const row of await store.list('device'))
            if (
              !row['revoked'] &&
              row.roles.includes('brain') &&
              row.prGatePublicKey &&
              keyId(row.prGatePublicKey) === signer
            )
              return row.prGatePublicKey
          return undefined
        }
      : undefined,
  )
  const instance = gate
  if (secrets)
    instance.rotate = async () => {
      const id = selfId?.(),
        row = id ? await store.get('device', id) : null
      if (row && (row['revoked'] || !row.roles.includes('brain')))
        return 'Refused: only a brain may rotate and publish a PR gate signing key.'
      newPrGateKey(secrets)
      const key = await signing()
      return key
        ? 'PR gate key rotated and public key published: ' +
            keyId(publicKey(key))
        : 'PR gate local key rotated; publication waits for this brain Devices row.'
    }
  gates.set(store, gate)
  const observed = store as DataStore & {
    onChange?: (listener: (change?: { entity?: string }) => void) => () => void
  }
  if (secrets) {
    void signing().catch(() => undefined)
    observed.onChange?.((change) => {
      if (change?.entity === 'device') void signing().catch(() => undefined)
    })
  }
  return gate
}
const privateGates = new WeakMap<object, PrGate>()
export function gateForTools(tools: Tool[]): PrGate | undefined {
  for (const tool of tools) {
    const gate = privateGates.get(tool.spec)
    if (gate) return gate
  }
  return undefined
}
function stableInput(tool: string, input: JsonObject): JsonObject {
  if (['shell_run', 'Bash', 'PowerShell', 'exec_command'].includes(tool))
    return {
      command: input['command'] ?? input['cmd'] ?? '',
      bodyFile: bodyFileSignature(input),
      cwd: input['cwd'] ?? '',
      shell: input['shell'] ?? '',
    }
  return input
}
export type PrGateResolver = (
  tool: string,
  input: JsonObject,
  ctx: ToolContext,
) => Promise<JsonObject>
export function withPrGate(
  tools: Tool[],
  gate: PrGate,
  resolve?: PrGateResolver,
): Tool[] {
  return tools.map((tool) => {
    privateGates.set(tool.spec, gate)
    return {
      spec: tool.spec,
      run: async (input, ctx) => {
        ctx = beginPrGateCall(ctx)
        const remote =
          gate.enabled() &&
          (await gate.acceptRemote(tool.spec.name, input, ctx))
        if (takeAlreadyRan(ctx))
          return 'This gated command already ran once on this device; inspect current state, do not repeat it.'
        const effective =
          (gate.enabled() || tool.spec.name === 'app_action') && resolve
            ? await resolve(tool.spec.name, input, ctx)
            : input
        const held = remote
          ? null
          : await gate.check(tool.spec.name, effective, ctx)
        if (held) {
          cleanupCommentFile(effective)
          markDestinationHold(ctx)
          return held
        }
        const routable =
          tool.spec.name === 'device_tool' ||
          LEARNED_RUN_TOOLS.has(tool.spec.name) ||
          tool.spec.name.startsWith('browser_') ||
          DEVICE_ARG_TOOLS.has(tool.spec.name)
        if (
          routable &&
          !remote &&
          gate.enabled() &&
          (reviewableCall(tool.spec.name, effective) ||
            gate.isRemoteWrite(effective, ctx))
        ) {
          const signingKey = await gate.signingKey()
          if (signingKey && tool.spec.name === 'device_tool') {
            const args = input['args']
            if (args && typeof args === 'object' && !Array.isArray(args))
              prepareRemoteGrant(
                ctx,
                String(input['tool'] ?? ''),
                args as JsonObject,
                signingKey,
              )
          } else if (signingKey) {
            const { device: _device, ...args } = input
            void _device
            prepareRemoteGrant(ctx, tool.spec.name, args, signingKey)
          }
        }
        let result: string
        try {
          const run = () =>
            tool.run(tool.spec.name === 'shell_run' ? effective : input, ctx)
          result = ['shell_run', 'Bash', 'PowerShell', 'run_code'].includes(
            tool.spec.name,
          )
            ? await withGhExecution(gate, ctx, run, {
                tool: tool.spec.name,
                input: effective,
              })
            : await run()
        } finally {
          cleanupCommentFile(effective)
        }
        if (routable && gate.enabled() && takeRemoteChallenge(ctx))
          return (
            (await gate.holdRemote(effective, ctx, tool.spec.name)) ?? result
          )
        return result
      },
    }
  })
}
