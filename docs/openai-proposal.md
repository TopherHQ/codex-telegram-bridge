# Proposal: Personal Telegram Client for Codex App Server

## Summary

This proposal describes a small open-source Telegram bridge for Codex App Server. The goal is to make a phone DM feel close to typing into Codex CLI, while keeping the first version personal, allowlisted, text-only, and approval-conscious.

Implementation repo:

- https://github.com/topher/codex-telegram-bridge

## Problem

Codex is most useful when it can stay close to a developer's active repository and local context. Mobile access is currently awkward for quick follow-ups, status checks, and approval decisions when the developer is away from the terminal.

Telegram DMs are a practical first transport because they support:

- One-to-one text input.
- Message edits for streaming previews.
- Inline buttons for approval decisions.
- Simple bot token setup.

## UX Goal

Approximate this workflow:

```text
Developer sends a Telegram DM -> Codex receives a turn -> Codex streams progress -> Developer steers or approves from Telegram.
```

Telegram commands:

- `/new` starts a fresh Codex thread.
- `/status` shows bridge state.
- `/stop` interrupts the active turn.
- `/help` lists commands.

Normal text starts a Codex turn. Text sent during an active turn becomes `turn/steer`.

## Architecture

The bridge is a manual-run Node 20 process:

```text
Telegram Bot API <-> Node bridge <-> codex app-server --listen stdio://
```

Codex side:

- Spawn `codex app-server --listen stdio://`.
- Send `initialize`, then `initialized`.
- Call `thread/start`.
- Call `turn/start` for the first message.
- Call `turn/steer` for follow-up messages during an active turn.
- Listen for `item/agentMessage/delta`, `item/completed`, and `turn/completed`.
- Respond to command and file-change approval requests.

Telegram side:

- Long-poll `getUpdates`.
- Pair one Telegram user through a local code flow.
- Drop unknown users after pairing.
- Reject non-private Telegram chats.
- Persist Telegram update offsets before handling updates to avoid replaying stale text after restart.
- Reject malformed, expired, or future-dated pending pair codes.
- Send streaming output by editing one preview message.
- Send final output in chunks.
- Render approval requests with inline buttons.

## Security Model

V1 is intentionally a personal bridge, not a shared service.

Controls:

- Dedicated Telegram bot token.
- Local state directory with restrictive file modes.
- One paired Telegram user by default.
- Pairing requires a command on the local machine.
- Runtime state fails closed if the allowlist is broadened beyond one user.
- Text-only input.
- No outbound local file attachments.
- Approval buttons only map to `accept`, `decline`, or `cancel`.
- Approval callbacks are bound to the originating message/context and expire quickly.
- No `acceptForSession`.
- No exec policy amendment flow.
- No network policy amendment flow.
- Best-effort redaction before Telegram output and audit log writes.
- Generic Telegram error notices; detailed bridge errors stay local.
- Repeatable `scripts/security-check.mjs`.

Known residual risks:

- Telegram remains a third-party message transport.
- Redaction is pattern-based and cannot guarantee perfect secret removal.
- The paired user can drive Codex within the local Codex configuration and approval policy.
- Approval mistakes can authorize local side effects.

## Upstream Asks

1. Confirm whether this "personal external client" pattern is acceptable for Codex App Server.
2. Confirm the preferred client name for Compliance Logs Platform metadata.
3. Clarify whether app-server approval response payloads should stay stable for external clients.
4. Recommend whether guarded clients should hide or surface unavailable decisions from `availableDecisions`.
5. Provide guidance on any minimum security expectations for public third-party clients.
6. Consider a small "external client checklist" in Codex App Server docs.

## Submission Path

Open a concise issue or discussion in `openai/codex` linking the implementation repo and this proposal. The Codex open source docs currently direct bug reports and feature requests to GitHub issues and discussions, so this should start as a proposal rather than a pull request unless maintainers ask for code upstream.

References:

- Codex App Server docs: https://developers.openai.com/codex/app-server
- Codex open source docs: https://developers.openai.com/codex/open-source
