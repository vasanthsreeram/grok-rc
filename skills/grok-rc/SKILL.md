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
- `--model <model>` sets the model the Claude relay runs on. The default is `haiku`.

Then tell the user to open the Claude app, go to Code, and open `Grok · <title>`.

## Manage

```bash
npx -y grok-rc status             # list running relays
npx -y grok-rc stop               # stop the relay for this session
npx -y grok-rc stop --all
tmux -L grokrc attach -t rc-<first 8 chars of session id>   # watch the relay
```

## How it works

1. A hidden Claude Code session runs `claude --rc` in its own tmux server (`-L grokrc`). It acts as a relay.
2. A watcher tails `~/.grok/sessions/<cwd>/<session>/updates.jsonl` and posts each new message into the relay. The relay echoes it verbatim, so the text appears in the Claude app. At the end of a turn the relay calls Claude's `PushNotification` tool, and that sends a push to the phone.
3. A `UserPromptSubmit` hook in the relay catches messages typed on the phone and pastes them into the Grok tmux pane.

## Limits

- Each mirrored message is one short turn on the relay's model, so it uses a little Claude usage.
- Text longer than 6,000 characters is cut in the mirror. The full text stays in the terminal.
- Tool calls are counted in the summary at the end of each turn. Grok's permission prompts are not mirrored, so run Grok in a mode that does not stop for approval if you plan to drive it from the phone.
