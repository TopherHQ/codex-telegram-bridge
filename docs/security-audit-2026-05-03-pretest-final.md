# Security Audit: Pre-Test Final

Date: 2026-05-03

Result: no reportable security findings remain in the audited working tree.

## Scope

- `src/bridge.mjs`
- `scripts/security-check.mjs`
- `scripts/tgon`
- `scripts/tgoff`
- `scripts/tgstatus`
- `scripts/tgwatch`
- `scripts/tgwatchoff`
- `scripts/tgwatchstatus`
- `package.json`
- Live paired state under `~/.codex-telegram-bridge`
- Bash helper `agent-tg`

## Fixes Made

- Wake listener no longer silently consumes paired-user plain text while the full bridge is off. It now tells the user to send `/tgon` and then resend the message.
- Wake listener now answers unknown off-mode slash commands with bounded help instead of dropping them silently.
- Bridge and wake daemon starts no longer let a default token file override an explicitly supplied `TELEGRAM_BOT_TOKEN`.
- Empty repo-local generated `state/check` directories were removed.
- The running wake listener was restarted so the live process uses the audited code.

## Security Properties Confirmed

- Private DM and single paired-user checks gate Telegram text and commands.
- Multi-user allowlist state fails closed.
- Pair codes are capped, TTL-bound, and malformed/expired/future-dated records fail closed.
- Telegram update offsets persist before update handling.
- Telegram media/files are rejected.
- Approval buttons expose only `accept`, `decline`, and `cancel`.
- Approval callbacks bind to paired user, private chat, original Telegram message, current thread, current turn, and TTL.
- Pending approvals are canceled on thread/turn changes, `/stop`, and shutdown.
- Codex app-server child env strips Telegram bridge secrets.
- Daemon argv and PID metadata do not include Telegram bot tokens.
- State/runtime/token files are regular private files; symlinks and open modes fail checks.
- Runtime PID files are verified against expected bridge/wake command lines before stop commands signal a process.
- Telegram-facing bridge errors are generic; local logs get redacted detail.

## Verification

- `node --check src/bridge.mjs`
- `node --check scripts/security-check.mjs`
- `npm test`
- `node test/bridge.test.mjs` passed 40/40 subtests.
- `node scripts/security-check.mjs --strict --state-dir /home/topher/.codex-telegram-bridge --token-file /home/topher/.codex-telegram-bridge/bot-token`
- Literal secret scan found only redaction/test regex references.
- Repo-local `state/` no longer exists.
- Persistent state directory is `0700`; token/state/audit/runtime files are `0600`.
- Real-process verification outside the Codex PID sandbox: wake listener is on, full bridge is off, and `agent-tg` reports the same.

Full Codex Security scan artifacts were written to:

`/tmp/codex-security-scans/codex-telegram-bridge/working-tree_20260503T114355Z/report.md`

## Residual Risk

- Telegram is still a third-party transport; do not send secrets through the bridge.
- A compromised paired Telegram account can drive Codex within the configured local sandbox and approval policy.
- Telegram `/tgon` only works while the lightweight wake listener is running.
