# receipt-checker: notes for coding agents

CLAUDE.md and AGENTS.md are the same file. Edit both, or they drift.

`receipt-check` checks an AI agent's "done" receipt by rerunning its checks
from the exact commit in a clean copy. README.md describes it for people; this
file is how to work on the code.

## Rules

- Node.js 20 or later, ES modules, zero runtime dependencies. Tests use
  `node:test` and `node:assert` only.
- `npm test` passes before every commit. The suite has no conditional skips:
  the release receipt declares exact test counts, and they must match on every
  OS and Node.js version CI runs. A platform-specific test asserts both
  branches.
- Fail closed. Evidence that is missing, unreadable or ambiguous gives
  INCOMPLETE, never VERIFIED. A change that turns an INCOMPLETE into a
  VERIFIED comes with a test that shows why it is safe.
- Error messages say exactly what is wrong and where: a receipt problem names
  its line and column.
- Keep the code small and readable, one job per file in `src/`.
- Keep personal paths, email addresses, tokens and keys out of code, tests,
  fixtures and commit messages. Test repositories set their git identity on
  each command.
- Never move a pushed tag. A release goes: push main, wait for CI to pass, tag
  that commit, then commit `receipts/vX.Y.Z.json` naming it and check it with
  `node bin/receipt-check.js verify receipts/vX.Y.Z.json`. CI verifies every
  receipt in `receipts/` on each push.
- The licence is FSL-1.1-MIT. Call the project source-available, never open
  source.

## Layout

| File | Job |
|---|---|
| `src/json.js` | strict JSON with line and column for every value |
| `src/receipt.js` | the `receipt-check/1` schema and its messages |
| `src/tap.js`, `src/junit.js` | passed, failed and skipped counts from TAP and JUnit XML |
| `src/git.js` | finding the commit and exporting exactly its files |
| `src/run.js` | running one check: strict bash, timeout, scrubbed environment, offline |
| `src/verify.js` | comparing the claim with the evidence, and the verdict |
| `src/report.js` | text and JSON output |
| `src/ledger.js` | the hash-chained ledger |
| `src/cli.js` | commands, help and exit codes |
