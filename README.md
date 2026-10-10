# grok-rc

Mirror a [Grok Build](https://x.ai) session to the **Claude mobile app** through Claude Code Remote Control (`/rc`).

- See every message and reply from your Grok session on your phone.
- Get a push notification when Grok finishes a turn.
- Reply from the Claude app, and the text is typed into the Grok terminal.

```bash
npx -y grok-rc start
```

## Requirements

- Grok Build running inside **tmux**.
- [Claude Code](https://code.claude.com) signed in with a plan that includes Remote Control.
- In Claude Code, `/config` → turn on **Push when Claude decides** (mobile push).
- Node.js 18+, macOS or Linux.

## Use

From inside the Grok session you want on your phone, run:

```bash
npx -y grok-rc start --name "my task"
```

Then open the Claude app → **Code** → **Grok · my task**.

| Command | What it does |
|---|---|
| `grok-rc start [--name t] [--pane %N] [--session id] [--push] [--model haiku]` | Start a relay for the current (or given) Grok session |
| `grok-rc status` | List running relays |
| `grok-rc stop [--session id \| --all]` | Stop relays |
| `grok-rc install-skill` | Install the `/grok-rc` skill into `~/.grok/skills` and `~/.claude/skills` |

### As a skill

```bash
npx skills add vasanthsreeram/grok-rc
# or
npx -y grok-rc install-skill
```

After that, tell Grok "send this session to my phone" or run `/grok-rc`.

## Models

- **Grok's model:** from the Claude app, send `@grok /model grok-4.6` (any Grok `/model` argument). The `@grok` prefix forwards a slash command to Grok. A message that starts with a bare `/` goes to the Claude relay.
- **Relay model:** the relay model runs only for `--push` turns, so a small model is enough. The default is `haiku`. Pick another with `grok-rc start --model sonnet` (any `claude --model` value), or set `GROK_RC_MODEL` in your environment.

## How it works

```
Grok TUI (tmux pane) ──writes──▶ ~/.grok/sessions/.../updates.jsonl
        ▲                                   │ tail
        │ tmux paste (phone replies)        ▼
 UserPromptSubmit hook ◀── hidden `claude --rc` relay ──▶ Claude app (chat + push)
```

1. grok-rc starts a hidden Claude Code session with Remote Control on, in its own tmux server (`tmux -L grokrc`).
2. A watcher tails the Grok session log, saves each new message to a file, and submits a short ID like `⟦grok⟧ 12` to the relay. A `UserPromptSubmit` hook blocks that prompt and puts the saved text in the block notice. Remote Control syncs the notice to the Claude app, and no model runs. With `--push`, the relay also gets one tiny turn per Grok reply to call Claude Code's `PushNotification` tool.
3. A `UserPromptSubmit` hook catches what you type in the Claude app and pastes it into the Grok pane.

## Limits

- Free by default: both directions run through a Claude Code hook that blocks the prompt, so no model turn runs and no Claude usage is spent. Grok messages appear in the Claude app as hook notices.
- `--push` adds a phone push when each Grok turn finishes. Only the model can send a push, so that costs one tiny relay turn per Grok reply.
- Messages over 6,000 characters are cut in the mirror. The full text stays in the terminal.
- Grok's permission prompts are not mirrored. To drive Grok from the phone, run it in a mode that does not stop for approval.
- Grok Build and Claude Code are products of xAI and Anthropic. This project is not affiliated with either.

## License

MIT
