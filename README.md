# Codex Telegram Bridge

A personal Telegram DM client for `codex app-server`, meant to approximate the concise Claude Telegram plugin flow from your phone.

V2 channel mode is the default. It gives Codex text-only Telegram tools and only sends Telegram messages when Codex explicitly calls those tools. V1 relay mode remains available with `--mode relay`.

This is not an always-on service, not an official OpenAI integration, and not a general multi-user bot. Use it at your own risk.

## What It Does

- Spawns `codex app-server --listen stdio://`.
- Speaks newline-delimited JSON-RPC to the app-server.
- Polls a dedicated Telegram bot for text messages.
- Pairs exactly one Telegram user by default, then drops unknown users.
- Accepts private Telegram DM chats only; group and channel chats are ignored.
- Starts one Codex thread, supports `/new`, `/status`, `/stop`, `/more`, `/tgon`, `/tgoff`, and `/help`.
- Sends normal Telegram text as `turn/start`, wrapped with Telegram channel metadata in V2 channel mode.
- Sends follow-up text during an active turn as `turn/steer`.
- Reacts to normal inbound prompts and shows Telegram typing instead of sending separate "sent" acknowledgements.
- In V2 channel mode, exposes `telegram.reply`, `telegram.react`, and `telegram.edit_message` dynamic tools to Codex.
- In V2 channel mode, never auto-relays normal model output to Telegram. If Codex finishes without `telegram.reply`, Telegram receives only a warning.
- In V1 relay mode, keeps Telegram output concise: final responses are preview-sized, with `/more` available when you explicitly want the full response chunked into Telegram.
- Maps approvals to simple Telegram inline buttons for `Allow`, `Deny`, and `Cancel`.

## Boundaries

The bridge is intentionally narrow:

- Use a new dedicated Telegram bot token. Do not reuse another automation bot token.
- Text-only. Telegram photos, documents, audio, stickers, and videos are ignored.
- Private DM only. Do not add the bot to group chats; the bridge rejects non-private chats.
- No local files are uploaded to Telegram.
- V2 Telegram dynamic tools are bound to the active paired private chat and cannot send files or media.
- Approval buttons never expose `acceptForSession`, exec policy amendments, or network policy amendments.
- Approval callbacks are bound to the current thread, active turn, chat, original Telegram approval message, and a short TTL.
- Pair codes expire quickly; malformed, expired, or future-dated pair codes are rejected.
- Obvious secrets are redacted before outbound Telegram text and audit log writes.
- Audit logs record approval requests and decisions without raw secrets.
- The spawned Codex app-server child does not inherit `TELEGRAM_BOT_TOKEN` or `TELEGRAM_CODEX_STATE_DIR`.
- Telegram update offsets are persisted before update handling to avoid replaying old text after restart.
- Bridge error details stay in local logs; Telegram receives only a generic error notice.

## Requirements

- Node.js 20 or newer.
- Codex CLI available on `PATH`, or set `CODEX_BIN`.
- A dedicated Telegram bot token from BotFather.

There are no required npm package dependencies.

## Setup

Create a dedicated Telegram bot first:

1. Follow [BotFather setup](docs/botfather-setup.md).
2. Store the token outside the repo.
3. Keep the bot private-DM-only; do not add it to groups or channels.

```bash
git clone https://github.com/topher/codex-telegram-bridge.git
cd codex-telegram-bridge
node src/bridge.mjs configure
node scripts/security-check.mjs
```

Set a dedicated Telegram token:

```bash
export TELEGRAM_BOT_TOKEN="<dedicated-bot-token-from-botfather>"
```

For a safer local file workflow:

```bash
export TELEGRAM_BOT_TOKEN="$(cat ~/.codex-telegram-bridge/bot-token)"
```

The CLI also reads `~/.codex-telegram-bridge/bot-token` by default when `TELEGRAM_BOT_TOKEN` is not set. Keep that file `0600`.
If `TELEGRAM_BOT_TOKEN` is set, daemon starts keep using that env token. Use `--token-file` when you explicitly want a daemon to read a token file instead.

Optional state and binary overrides:

```bash
export TELEGRAM_CODEX_STATE_DIR="$HOME/.codex-telegram-bridge"
export CODEX_BIN="codex"
```

Keep the state directory on a filesystem that honors Unix file modes. WSL-mounted Windows drives such as `/mnt/c` or `/mnt/d` may report state files as `0777` and will fail the startup security check. State files must be regular files, not symlinks.

Start the bridge:

```bash
node src/bridge.mjs start --cwd "/mnt/d/"
```

To use the old V1 relay behavior:

```bash
node src/bridge.mjs start --cwd "/mnt/d/" --mode relay
```

Or run it in the background and toggle it on/off:

```bash
node src/bridge.mjs on --cwd "/mnt/d/"
node src/bridge.mjs status
node src/bridge.mjs off
```

`on` writes `bridge.pid` and `bridge.log` inside the state directory. The PID file does not contain the Telegram token. Use foreground `start` when debugging and `on`/`off` for normal manual use.

To let Telegram `/tgon` wake the bridge after `/tgoff`, start the lightweight wake listener:

```bash
scripts/tgwatch --cwd "/mnt/d/"
scripts/tgwatchstatus
```

The wake listener writes `wake.pid` and `wake.log` in the same private state directory. It polls Telegram only while the full bridge is off. When the full bridge is on, it backs off so it does not compete for updates.
While the full bridge is off, the wake listener handles `/tgon`, `/tgoff`, `/status`, `/help`, and `/start`; plain text gets a reminder to send `/tgon` first and then resend the message.

Convenience wrappers are also available:

```bash
scripts/tgon --cwd "/mnt/d/"
scripts/tgstatus
scripts/tgoff
scripts/tgwatchoff
```

If `scripts/tgon` is run without `--cwd`, it uses the current working directory.

Optional shell helper:

```bash
agent-tg() {
  local repo="$HOME/src/codex-telegram-bridge"
  local workspace="$HOME/src/my-project"
  local state_dir="${TELEGRAM_CODEX_STATE_DIR:-$HOME/.codex-telegram-bridge}"
  cd "$repo" || return
  scripts/tgwatchstatus --state-dir "$state_dir"
  scripts/tgstatus --state-dir "$state_dir"
  printf 'Start wake listener: scripts/tgwatch --cwd "%s" --state-dir "%s"\n' "$workspace" "$state_dir"
  printf 'Start bridge: scripts/tgon --cwd "%s" --state-dir "%s"\n' "$workspace" "$state_dir"
  env -u TELEGRAM_BOT_TOKEN -u TELEGRAM_CODEX_STATE_DIR codex "$@"
}
```

Put the function in `~/.bashrc`, `~/.bash_aliases`, or your shell's equivalent startup file, then update `repo` and `workspace` for your machine. The `env -u` wrapper keeps bridge-specific Telegram environment variables out of the interactive Codex session.

Pair your Telegram account:

1. Send `/start` to the new Telegram bot.
2. The bot replies with a local pairing command.
3. Run the command on the machine running the bridge:

```bash
node src/bridge.mjs access pair 123456
```

After pairing, restart the bridge or send another message. Only the paired Telegram user is allowed by default.

## Demo Flow

1. Run `node scripts/security-check.mjs`.
2. Start the bridge with `node src/bridge.mjs start --cwd "/mnt/d/"`.
3. In Telegram, send:

```text
Summarize 00-dashboard/NEXT.md.
```

4. While the turn is active, send:

```text
Actually focus on blockers and next actions.
```

5. Trigger a harmless approval from Codex and use `Allow`.
6. Send an image or document and verify the bridge rejects it.
7. Run `node scripts/security-check.mjs` again and inspect the audit log.

## Commands

```bash
node src/bridge.mjs configure
node src/bridge.mjs access pair <code>
node src/bridge.mjs start --cwd "/path/to/project" [--mode channel|relay]
node src/bridge.mjs on --cwd "/path/to/project" [--mode channel|relay]
node src/bridge.mjs status
node src/bridge.mjs off
node src/bridge.mjs toggle --cwd "/path/to/project" [--mode channel|relay]
node scripts/security-check.mjs
```

Telegram commands:

- `/new` starts a fresh Codex thread.
- `/status` shows bridge status.
- `/stop` interrupts the active Codex turn.
- `/more` sends the full last Codex response only in V1 relay mode.
- `/tgon` starts the full bridge when the wake listener is on and the bridge is off. If the full bridge is already running, it confirms that state and shows the local start command.
- `/tgoff` shuts down the running bridge after replying in Telegram.
- `/help` shows commands.

`/tgon` requires the wake listener. If both the full bridge and wake listener are off, no local process is polling Telegram, so use `scripts/tgwatch --cwd "/path/to/project"` or `scripts/tgon --cwd "/path/to/project"` locally.

## Threat Model Summary

Primary risks:

- A leaked Telegram bot token lets someone impersonate the bot.
- A paired Telegram account can ask Codex to inspect or change local files within Codex's configured sandbox and approval policy.
- Telegram is a third-party transport, so prompts and responses sent through it should not contain secrets.
- Approval mistakes can authorize command execution or file changes.
- V2 dynamic Telegram tools can send messages to the paired private chat, but only after app-server invokes the bridge-owned tool call.

Mitigations in this repo:

- Local allowlist defaults to one Telegram user.
- Pairing requires a local command.
- Unknown users are dropped after pairing.
- Media and document transfer are disabled.
- V2 dynamic Telegram tools validate active chat, active turn context, and text-only arguments before sending or editing anything.
- V2 channel mode warns when Codex finishes without calling `telegram.reply` instead of auto-sending normal model output.
- Outbound text and audit entries pass through secret redaction.
- Approval UI only sends `accept`, `decline`, or `cancel`.
- Approval prompts expire quickly and are canceled when thread/turn context changes or stop is requested, including failed interrupt attempts.
- Telegram bridge secrets are stripped from the Codex app-server child environment.
- Runtime allowlist reads fail closed if state is broadened beyond one user.
- `scripts/security-check.mjs` checks state/runtime file types/modes, media settings, allowlist state, pair-code validity, Telegram update offset validity, Codex binary availability, Node version, and audit/log redaction.

## Security Gates

Run:

```bash
node scripts/security-check.mjs
```

To use a non-default token file:

```bash
node scripts/security-check.mjs --token-file "/path/to/bot-token"
```

Use `--strict` before live operation:

```bash
node scripts/security-check.mjs --strict
```

The bridge also runs fail-closed startup checks for the live state directory. `start` refuses to run when the state directory or state files are group/world accessible, when media transfer config is enabled, when `telegramMode` is not `channel` or `relay`, when approval decisions are broadened beyond the supported set, when pending pair codes are malformed, expired, or future-dated, when the persisted Telegram update offset is malformed, or when state/config/audit files match known secret patterns.

Recommended gates:

- After scaffold.
- After configuration.
- Before first live run.
- After first live run.
- Before publishing.

## App Server Notes

The bridge follows the public Codex App Server shape:

- Start `codex app-server --listen stdio://`.
- Send `initialize`, then `initialized`. V2 channel mode sets `capabilities.experimentalApi=true`.
- Call `thread/start`. V2 channel mode includes experimental `dynamicTools`.
- Call `turn/start` or `turn/steer`.
- Read `item/*` and `turn/*` notifications.
- Respond to `item/tool/call` for bridge-owned Telegram dynamic tools.
- Respond to approval requests with guarded decisions.

References:

- Codex App Server docs: https://developers.openai.com/codex/app-server
- Codex open source issue/discussion path: https://developers.openai.com/codex/open-source

## License

Apache-2.0.
