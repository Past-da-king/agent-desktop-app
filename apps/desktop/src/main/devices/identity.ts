/**
 * Who this node is: its id, the mesh it belongs to and its TLS certificate (protocol s2). Made once on first start
 * and kept in `<userData>/devices/`. The private key file is 0600 and never leaves this folder.
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { derFromPem, fingerprintOf, makeSelfSignedCert } from './cert'

export interface NodeIdentity {
  nodeId: string
  meshId: string
  keyPem: string
  certPem: string
  certDer: Buffer
  /** base64url(sha256(cert DER)). */
  fp: string
}

interface IdentityFile {
  nodeId: string
  meshId: string
}

export function newId(prefix: string, bytes = 12): string {
  return `${prefix}${randomBytes(bytes).toString('base64url')}`
}

function writePrivate(file: string, text: string): void {
  const temp = `${file}.tmp`
  writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600 })
  renameSync(temp, file)
  try {
    chmodSync(file, 0o600)
  } catch {
    // Windows has no POSIX mode; the folder sits under the user's own profile.
  }
}

function readIds(file: string): IdentityFile | null {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<IdentityFile>
    if (typeof raw.nodeId === 'string' && raw.nodeId !== '' && typeof raw.meshId === 'string' && raw.meshId !== '') {
      return { nodeId: raw.nodeId, meshId: raw.meshId }
    }
  } catch {
    // Missing or damaged: made again below.
  }
  return null
}

/** Reads the identity, making whatever is missing. A node that joins another mesh changes `meshId` with `joinMesh`. */
export function loadIdentity(dir: string): NodeIdentity {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const idFile = join(dir, 'identity.json')
  let ids = readIds(idFile)
  if (ids === null) {
    ids = { nodeId: newId('dev_'), meshId: newId('mesh_', 16) }
    writePrivate(idFile, JSON.stringify(ids, null, 2))
  }
  const keyFile = join(dir, 'node-key.pem')
  const certFile = join(dir, 'node-cert.pem')
  if (!existsSync(keyFile) || !existsSync(certFile)) {
    const made = makeSelfSignedCert(`Agent node ${ids.nodeId}`)
    writePrivate(keyFile, made.keyPem)
    writePrivate(certFile, made.certPem)
  }
  const keyPem = readFileSync(keyFile, 'utf8')
  const certPem = readFileSync(certFile, 'utf8')
  const certDer = derFromPem(certPem)
  return { ...ids, keyPem, certPem, certDer, fp: fingerprintOf(certDer) }
}

/** Joining another node's mesh (pairing as a brain): the node keeps its id and certificate, takes the mesh id. */
export function joinMesh(dir: string, identity: NodeIdentity, meshId: string): NodeIdentity {
  writePrivate(join(dir, 'identity.json'), JSON.stringify({ nodeId: identity.nodeId, meshId }, null, 2))
  return { ...identity, meshId }
}
