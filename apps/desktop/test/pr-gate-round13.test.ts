/**
 * Round 13 review follow-up (m3): heredoc bodies that are only data (a commit message, a notes file) are not
 * sending text, while a heredoc that feeds a shell, and any write after it, is still held.
 */
import { expect, it } from 'vitest'

import { reviewableCall } from '../src/main/runtime/pr-gate-detect'

it.each([
  "git commit -m \"$(cat <<'EOF'\nDocs: gh pr merge is gated\nEOF\n)\"",
  'cat <<EOF > notes.md\nRemember: gh pr ready 3 needs a review first\nEOF',
  'cat <<EOF >> notes.md\ngh pr merge 1 is held\nEOF',
  "cat <<'EOF' | tee notes.md\ngh pr ready 3\nEOF",
])('R13 m3 a data heredoc that names a sending action passes: %s', (command) => {
  expect(reviewableCall('shell_run', { command })).toBe(false)
  expect(reviewableCall('PowerShell', { command })).toBe(false)
})

it.each([
  "cat > /tmp/body.md <<'EOF'\nIt's ready.\nEOF\n# post it\ngh pr ready 19",
  'cat <<EOF > notes.md\nnotes\nEOF\ngh pr merge 1',
  "git commit -m \"$(cat <<'EOF'\nmessage\nEOF\n)\" && gh pr ready 3",
  'cat <<EOF\ngh pr ready 3\nEOF',
  "bash <<'EOF'\ngh pr merge 1\nEOF",
])('R13 m3 a heredoc that is not plain data, or a write after it, is still held: %s', (command) => {
  expect(reviewableCall('shell_run', { command })).toBe(true)
})
