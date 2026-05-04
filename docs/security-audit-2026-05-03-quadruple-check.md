# Codex Telegram Bridge Security Audit - Quadruple Check

Date: 2026-05-03

## Scope

Repository path: `codex-telegram-bridge`

Reviewed runtime, CLI, tests, security check script, and public docs:

- `src/bridge.mjs`
- `scripts/security-check.mjs`
- `test/bridge.test.mjs`
- `README.md`
- `SECURITY.md`
- `docs/openai-proposal.md`

## Result

No known exploitable repository-level security findings remain after this fourth pass.

The bridge remains a personal, single-user, text-only Telegram transport for a local Codex app-server. It is not a shared multi-user service, and it still depends on the operator keeping the Telegram account, bot token, machine, state directory, and Codex approval policy secure.

## Fourth-Pass Fixes

- Future-dated pair-code timestamps now fail closed instead of extending code validity.
- Startup security checks now validate pending pair-code shape, count, timestamp freshness, and future dating.
- Approval callbacks now expire by age in addition to being bound to the current chat, original Telegram message, thread, and active turn.
- Telegram send/edit helpers now force internal `chat_id`, `message_id`, and redacted `text` after merging optional payload extras, preventing future internal override mistakes.
- Docs now describe pair-code validation, approval callback expiry, and the expanded security gate.

## Validated Controls

- Single paired Telegram user enforced; broadened allowlists fail closed.
- Non-private Telegram chats ignored.
- Media and document inputs rejected.
- Approval decisions limited to `accept`, `decline`, and `cancel`.
- Approval callbacks bound to original message/context and TTL.
- Pending approvals canceled on new thread, stop failure, and app-server thread-change notifications.
- Telegram update offsets persisted before handling updates and validated at startup.
- State directory and files require restrictive POSIX modes and regular files; symlinks rejected.
- Telegram bridge secrets stripped before spawning Codex app-server.
- JSON-RPC protocol errors and Telegram-facing bridge errors do not echo raw child output or stack details.
- Outbound Telegram text and audit entries pass through common secret redaction patterns.

## Verification

Passed:

- `npm test`
- `node test/bridge.test.mjs` - 29/29 subtests passed
- `node --check src/bridge.mjs`
- `node --check scripts/security-check.mjs`
- `node scripts/security-check.mjs --state-dir /tmp/codex-telegram-bridge-review-20260503-quadcheck-safe`
- `TELEGRAM_BOT_TOKEN=... CODEX_BIN=/usr/bin/node node scripts/security-check.mjs --state-dir /tmp/codex-telegram-bridge-review-20260503-quadcheck-safe`
- `TELEGRAM_BOT_TOKEN=... CODEX_BIN=/usr/bin/node node scripts/security-check.mjs --strict --state-dir /tmp/codex-telegram-bridge-review-20260503-quadcheck-paired`
- Unsafe state dir startup probe rejected with `FAIL state-dir-mode`.
- Future-dated pending pair-code probe rejected with `FAIL pair-codes`.
- Previous stale-approval proof-of-concept now resolves to `cancel` instead of `accept`.
- `find state -maxdepth 3 -type f -print` found no generated state files in the repo.
- Literal-secret scan found only redaction regexes, docs placeholders, and test assertions.

## Residual Risk

- Telegram itself is a third-party message transport; prompts and outputs sent through it may be retained outside the local machine.
- A compromised paired Telegram account can drive Codex within the configured local sandbox and approval policy.
- A leaked bot token can allow bot impersonation until rotated.
- A live end-to-end smoke with a real dedicated Telegram bot token was not run in this audit environment.
