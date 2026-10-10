---
name: grok-rc
description: Mirror the current Grok Build session to the Claude mobile app through Claude Code Remote Control (/rc). The phone shows the chat, gets a push notification when each turn finishes, and can send messages back into the Grok terminal. Use when the user says /grok-rc, "remote control", "send this session to my phone", "notify my phone", or wants to follow or drive a Grok session from the Claude app.
---

# grok-rc

`grok-rc` connects a running Grok Build session to Claude Code Remote Control. You get these from the Claude app on your phone:

- Every user message and every Grok reply, mirrored into a Claude Code session named `Grok · <title>`.
- A push notification when a Grok turn finishes.
- Messages you type in the Claude app are typed into the Grok terminal and submitted.

## Requirements

- Grok Build runs inside **tmux**. grok-rc types phone messages into that tmux pane.
- Claude Code is installed and signed in with a subscription that includes Remote Control. Turn on "Push when Claude decides" in `/config` in Claude Code.
- Node.js 18 or later.

## Start

Run this from inside the Grok session you want to mirror:

```bash
npx -y grok-rc start
```

It reads `GROK_SESSION_ID` and finds the Grok tmux pane by itself. Optional flags:

- `--name "<title>"` sets the session name shown in the Claude app.
- `--pane %N` picks the tmux pane when auto-detection fails.
- `--session <id>` mirrors a different session.
- `--push` sends a phone push when each Grok turn finishes (one tiny Claude turn each).
- `--model <model>` sets the model the Claude relay uses for push turns. The default is `haiku`.

Then tell the user to open the Claude app, go to Code, and open `Grok · <title>`.

## Models

- **Grok's model:** from the Claude app, send `@grok /model grok-4.6` (any Grok `/model` argument). The `@grok` prefix forwards a slash command to Grok. A message that starts with a bare `/` goes to the Claude relay.
- **Relay model:** the relay model runs only for `--push` turns, so a small model is enough. The default is `haiku`. Pick another with `grok-rc start --model sonnet` (any `claude --model` value), or set `GROK_RC_MODEL` in your environment.

## Manage

```bash
npx -y grok-rc status             # list running relays
npx -y grok-rc stop               # stop the relay for this session
npx -y grok-rc stop --all
tmux -L grokrc attach -t rc-<first 8 chars of session id>   # watch the relay
```

## How it works

1. A hidden Claude Code session runs `claude --rc` in its own tmux server (`-L grokrc`). It acts as a relay.
2. A watcher tails `~/.grok/sessions/<cwd>/<session>/updates.jsonl`, saves each new message to a file, and submits a short ID like `⟦grok⟧ 12` to the relay. A `UserPromptSubmit` hook blocks that prompt and puts the saved text in the block notice, which Remote Control syncs to the Claude app. No model runs. With `--push`, the relay also gets one tiny turn per Grok reply to call `PushNotification`.
3. A `UserPromptSubmit` hook in the relay catches messages typed on the phone and pastes them into the Grok tmux pane.

## Limits

- Free by default: both directions run through a Claude Code hook that blocks the prompt, so no model turn runs and no Claude usage is spent. Grok messages appear in the Claude app as hook notices.
- `--push` adds a phone push when each Grok turn finishes. Only the model can send a push, so that costs one tiny relay turn per Grok reply.
- Text longer than 6,000 characters is cut in the mirror. The full text stays in the terminal.
- Tool calls are counted in the summary at the end of each turn. Grok's permission prompts are not mirrored, so run Grok in a mode that does not stop for approval if you plan to drive it from the phone.
