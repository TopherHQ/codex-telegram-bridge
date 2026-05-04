# BotFather Setup

This bridge needs a dedicated Telegram bot token. Create a fresh bot for this bridge; do not reuse a production, admin, shared, or unrelated automation bot.

Official Telegram reference: https://core.telegram.org/bots/features#botfather

## Create the Bot

1. Open Telegram on desktop or mobile.
2. Search for `@BotFather`.
3. Verify that the chat is the official BotFather account before sending commands.
4. Send `/newbot`.
5. Choose a display name, for example `Codex Bridge`.
6. Choose a username. Telegram bot usernames must end in `bot`, for example `my_codex_bridge_bot`.
7. BotFather will return an API token. Treat it like a password.

## Recommended BotFather Settings

These settings keep the bridge aligned with its personal, private-DM-only security model:

1. Send `/setdescription`, choose the bot, and use a short description such as:

```text
Personal Codex bridge. Private use only.
```

2. Send `/setabouttext`, choose the bot, and use a short profile bio such as:

```text
Private Codex app-server bridge.
```

3. Send `/setcommands`, choose the bot, and register:

```text
new - Start a fresh Codex thread
status - Show bridge status
stop - Interrupt the active Codex turn
tgon - Show local start command
tgoff - Shut down the running bridge
help - Show commands
```

4. Send `/setjoingroups`, choose the bot, and disable group access if BotFather offers that option for the bot. The bridge only supports private DMs and rejects group/channel messages anyway; disabling group adds another guardrail.

Do not enable inline mode, Business Mode, bot-to-bot communication, payments, games, or mini app features for this bridge.

## Store the Token

Do not paste the token into chat, commit it to the repo, or put it in client-side code. Store it in your shell, secret manager, or a local file outside the repo:

```bash
mkdir -p ~/.codex-telegram-bridge
chmod 700 ~/.codex-telegram-bridge

printf '%s\n' 'PASTE_BOT_TOKEN_HERE' > ~/.codex-telegram-bridge/bot-token
chmod 600 ~/.codex-telegram-bridge/bot-token
```

For a one-off shell session:

```bash
export TELEGRAM_BOT_TOKEN="$(cat ~/.codex-telegram-bridge/bot-token)"
```

The bridge CLI also reads this default token file automatically if `TELEGRAM_BOT_TOKEN` is not set.

Then run:

```bash
node scripts/security-check.mjs --strict
```

## Rotate a Token

If the token is exposed, stop the bridge immediately, rotate the token in BotFather, update your local secret store, and run the security check again before restarting.

Telegram documents token management through BotFather; use BotFather's current token command/menu for the bot if the UI wording changes.
