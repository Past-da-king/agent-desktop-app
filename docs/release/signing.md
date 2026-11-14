# Signing a release (how the app trusts its own updates)

Since review finding S1 (14 Nov 2026) the app only installs an installer through `app_update` when:

1. a signed manifest `Agent-<version>-setup.exe.release.json` sits next to it,
2. the signature is valid for one of the Ed25519 public keys pinned in `apps/desktop/src/main/release-verify.ts` (`RELEASE_KEYS`),
3. the file's size and sha256 are exactly the signed ones, and the version is newer than the running one,
4. Ayanda says yes on an approval card: "Install Agent <version>, verified publisher <name>, key <fingerprint>, sha256 <short>".

The verified bytes are then copied to `<userData>/update-staging/` and only that copy runs. The launcher hashes the copy again
(through a handle nobody else can write to) immediately before it starts it, and refuses on any difference or when it was
given no digest. Unsigned, changed, older or equal files, and manifests from unknown keys, are refused with the reason.

## The release step (run after the installer is built, as the last step)

```
node tools/release/sign-release.mjs sign \
  --installer apps/desktop/release/Agent-<version>-setup.exe \
  --commit "$(git rev-parse HEAD)"
```

- Writes `Agent-<version>-setup.exe.release.json` next to the installer and verifies it before returning.
- Always ship and copy the two files together (for example both into `C:\Users\past9\Downloads\agent\`).
- The private key is read from `--key`, else `$AGENT_RELEASE_KEY_FILE`, else `~/.config/agent-release/ed25519.key`
  (impetix server, chmod 600, outside every repo). The same key is in the Vault as `agent-desktop-release-key`
  (use it as `{{vault:agent-desktop-release-key}}`; never write the value into a file in a repo, a memory or a chat).
- Check a signed pair: `node tools/release/sign-release.mjs verify --installer <exe> --pub <file with the public key base64>`.
- Pass `--publisher "Name"` only if it is the name pinned for the key (the app refuses a manifest whose publisher is not the key's).

Current key: id `73fe5d2e79848263`, fingerprint `73fe 5d2e 7984 8263`, publisher `Ayanda Phaketsi`.

## Rotating the key

1. `node tools/release/sign-release.mjs keygen --out <new.key>` prints the new key id and the public key (base64 SPKI).
2. Add `{ id, publisher, publicKey }` to `RELEASE_KEYS` and release a build SIGNED WITH THE OLD KEY that carries the list.
3. Once installed, sign with the new key. Drop the old entry in a later release.
Keep the new private key only in the Vault and `~/.config/agent-release/`.

## The first build that carries this

The app Ayanda has installed today (0.2.13x) has the OLD updater: it checks only the file name and has no manifest check or
approval card. It installs the first signed build (the one containing this change) the old way. From that build on, every
update must be signed, confirmed and verified as above. So the first signed release should be installed by a person
(double-click the installer or `app_update` on the old app), not assumed to have been verified by the new code.
A build from before the key existed cannot be signed after the fact: sign the first build with the commit it came from.

## What this does and does not cover

- Covers: an agent or another tool pointing `app_update` at a planted or swapped file; a file changed between the check and the launch.
- Does not cover: something already running as Ayanda that can also edit the launcher script in `<userData>/updates/` (same
  user, same rights as the app). The signed digest is also passed on the launcher's command line (not a file) so a changed
  parameters file is detected, but a fully compromised user session cannot be defended from inside the app.
- The installer is not Authenticode-signed (no certificate); Windows SmartScreen still treats it as unknown. The launcher clears the
  downloaded-file mark only after the digest was verified against the signed manifest.
