# Security Policy

## Supported Versions

This project is pre-1.0. Security fixes target the current `main` branch unless a release branch exists.

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |

## Reporting a Vulnerability

Do not open a public issue for a vulnerability that includes secrets, tokens, exploit details, or private system paths.

Preferred report contents:

- A concise description of the issue.
- Steps to reproduce with fake tokens and sample data.
- Expected impact.
- A suggested fix, if known.

Until a private disclosure channel is published, contact the maintainer directly through the GitHub profile for `topher`. If that is not possible, open a public issue with a minimal non-sensitive description and ask for a private contact path.

## Known Risks

- Telegram is a third-party transport. Do not send secrets through the bridge.
- A leaked `TELEGRAM_BOT_TOKEN` can allow bot impersonation.
- A paired Telegram account can drive Codex against the configured `cwd`.
- Codex approvals can authorize local command execution or file changes.
- Telegram message history may retain prompts and outputs outside your machine.
- V2 channel mode exposes bridge-owned dynamic Telegram tools to Codex. Those tools can send, edit, or react only in the active paired private chat.
- Redaction is best effort and pattern-based. It cannot prove that all secrets are removed.

## Hardening Checklist

- Create a dedicated Telegram bot token for this bridge.
- Never reuse a Claude, production, admin, or shared bot token.
- Follow `docs/botfather-setup.md` and disable group access in BotFather when available.
- Store `TELEGRAM_BOT_TOKEN` in your shell or secret manager, not in repo files.
- If `TELEGRAM_BOT_TOKEN` is set, daemon starts use that env token; pass `--token-file` only when you intentionally want a token file source.
- Rotate the token in BotFather immediately if it is exposed.
- Use the bot only in a private DM. Do not add it to Telegram groups or channels.
- `/tgoff` can shut the full bridge down from the paired Telegram DM. `/tgon` can wake it only when the lightweight wake listener is running; if every local process is off, Telegram commands cannot be received.
- While only the wake listener is running, plain text is not sent to Codex; it is rejected with `/tgon` guidance so messages are not silently consumed.
- Run `node src/bridge.mjs configure`.
- Keep `telegramMode` set to `channel` for V2 behavior or `relay` for the V1 fallback. Any other value fails startup checks.
- In V2 channel mode, normal model output is not auto-sent to Telegram. Codex must use `telegram.reply`; if it does not, the bridge sends only a generic no-reply warning.
- V2 Telegram tools are text-only and reject file/media arguments, mismatched chat ids, stale turn context, and edits to messages the bridge did not send during the current turn.
- Keep `TELEGRAM_CODEX_STATE_DIR` on a filesystem that honors `0600` and `0700` modes.
- Keep bridge state as regular files. Do not symlink `config.json`, `state.json`, or `audit.jsonl`.
- The bridge strips `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CODEX_STATE_DIR` before spawning Codex; do not re-add them through a wrapper script.
- Use `node src/bridge.mjs on/off/status` for manual toggling, or `scripts/tgwatch` when you want Telegram `/tgon` wake-up. `bridge.pid`, `bridge.log`, `wake.pid`, and `wake.log` stay in the private state directory and must remain regular private files.
- Treat startup refusal on open state files as expected. Move the state directory to a POSIX-mode filesystem instead of weakening permissions.
- Pair exactly one Telegram user.
- Treat any state with multiple allowlisted Telegram users as invalid; runtime and startup checks fail closed.
- Treat malformed, expired, or future-dated pending pair codes as invalid; startup checks fail closed.
- Preserve `telegramUpdateOffset` as a non-negative integer so old Telegram updates are not replayed after restart.
- Run `node scripts/security-check.mjs --strict` before live use.
- Keep `textOnly=true`, `inboundMediaEnabled=false`, and `outboundAttachmentsEnabled=false`.
- Review every approval request. Approval buttons expire quickly; prefer `Decline` or `Cancel` when uncertain.
- Do not expose `codex app-server` WebSocket transport remotely for this bridge.
- Keep Codex CLI, Node.js, and this repo updated.
- Inspect `~/.codex-telegram-bridge/audit.jsonl` after live runs.
- Keep detailed bridge errors in local logs; Telegram receives only generic bridge error notices.

## Out of Scope

- Multi-user teams.
- Always-on service management.
- Telegram file transfer.
- Telegram voice, image, or document input.
- Approval session grants.
- Exec policy amendments.
- Network policy amendments.
- Hosting a public bridge endpoint.
