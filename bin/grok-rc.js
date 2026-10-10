#!/usr/bin/env node
// grok-rc: mirror a Grok Build session into Claude Code Remote Control.
// The Claude app on your phone shows the Grok chat and gets push notifications.
// Messages you send from the phone are typed into the Grok terminal.
'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TAG = '⟦grok⟧';
const RELAY_SOCKET = 'grokrc';
const HOME = path.join(os.homedir(), '.grok-rc');
const SELF = path.resolve(__filename);
const MAX_ECHO = 6000;

const SYSTEM_PROMPT = [
  'You are a display relay between the user and a Grok Build coding agent that runs in a terminal.',
  `Messages that start with ${TAG} come from the Grok agent, not from the user.`,
  `- "${TAG} ECHO": reply with everything after the first line, exactly verbatim. Add nothing. Use no tools.`,
  `- "${TAG} DONE": the second line starts with "PUSH:". First call the PushNotification tool once with the text after "PUSH:" as the message (load it with ToolSearch if needed). Then reply with everything after the PUSH line, exactly verbatim.`,
  'Every other message was typed by the user. It has already been forwarded to the Grok agent automatically.',
  'For those, reply with exactly: ↪ sent to Grok',
  'Never run commands, read files, or use any tool other than ToolSearch and PushNotification.',
].join('\n');

// ---------- small helpers ----------

function tmux(socketArgs, args, opts = {}) {
  return execFileSync('tmux', [...socketArgs, ...args], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...opts,
  });
}
const relay = (args, opts) => tmux(['-L', RELAY_SOCKET], args, opts);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

function die(msg) {
  console.error(`grok-rc: ${msg}`);
  process.exit(1);
}

function stateDir(sid) {
  const d = path.join(HOME, sid);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function relayName(sid) {
  return `rc-${sid.slice(0, 8)}`;
}

// ---------- discovery ----------

function findUpdatesFile(sid) {
  const root = path.join(os.homedir(), '.grok', 'sessions');
  if (!fs.existsSync(root)) return null;
  for (const dir of fs.readdirSync(root)) {
    const f = path.join(root, dir, sid, 'updates.jsonl');
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function sessionTitle(updatesFile) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(path.dirname(updatesFile), 'summary.json'), 'utf8'));
    return s.title || s.generated_title || s.summary || null;
  } catch {
    return null;
  }
}

function procInfo(pid) {
  const r = spawnSync('ps', ['-o', 'ppid=,tty=,comm=', '-p', String(pid)], { encoding: 'utf8' });
  const m = r.stdout.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
  return m ? { ppid: Number(m[1]), tty: m[2], comm: m[3] } : null;
}

// Walk up from this process to the grok TUI and return its tty, e.g. "ttys005".
function grokTty() {
  let pid = process.ppid;
  for (let i = 0; i < 12 && pid > 1; i++) {
    const p = procInfo(pid);
    if (!p) break;
    if (/(^|\/)grok[^/]*$/.test(p.comm) && p.tty !== '??') return p.tty;
    pid = p.ppid;
  }
  return null;
}

function tmuxSockets() {
  const dir = path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((n) => path.join(dir, n)).filter((p) => {
    try { return fs.statSync(p).isSocket(); } catch { return false; }
  });
}

// Find the tmux server + pane that hosts the Grok TUI.
function findGrokPane(opts) {
  const wantPane = opts.pane || process.env.TMUX_PANE || null;
  const tty = opts.tty || grokTty();
  for (const sock of tmuxSockets()) {
    if (path.basename(sock) === RELAY_SOCKET) continue;
    let rows;
    try {
      rows = tmux(['-S', sock], ['list-panes', '-a', '-F', '#{pane_id} #{pane_tty}']).trim().split('\n');
    } catch { continue; }
    for (const row of rows) {
      const [id, ptty] = row.split(' ');
      if (tty && ptty === `/dev/${tty}`) return { socket: sock, pane: id };
      if (!tty && wantPane && id === wantPane) return { socket: sock, pane: id };
    }
  }
  return null;
}

// ---------- tmux text injection ----------

function pasteInto(socketArgs, target, text) {
  const buf = `grokrc-${process.pid}-${Date.now()}`;
  tmux(socketArgs, ['load-buffer', '-b', buf, '-'], { input: text });
  tmux(socketArgs, ['paste-buffer', '-p', '-d', '-b', buf, '-t', target]);
}

function submit(socketArgs, target) {
  tmux(socketArgs, ['send-keys', '-t', target, 'C-m']);
}

// ---------- commands ----------

async function cmdStart(opts) {
  const sid = opts.session || process.env.GROK_SESSION_ID;
  if (!sid) die('no Grok session found. Run this from inside Grok Build, or pass --session <id>.');
  const updates = findUpdatesFile(sid);
  if (!updates) die(`no updates.jsonl for session ${sid} under ~/.grok/sessions`);
  const target = findGrokPane(opts);
  if (!target) die('could not find the tmux pane that runs Grok. grok-rc needs Grok to run inside tmux (pass --pane %N to pick one).');

  const name = relayName(sid);
  try { relay(['has-session', '-t', name]); die(`already running for this session (tmux -L ${RELAY_SOCKET} attach -t ${name}). Use "grok-rc stop" first.`); } catch {}

  const dir = stateDir(sid);
  const title = (opts.name || sessionTitle(updates) || 'Grok Build').slice(0, 60);
  const settings = {
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: `"${process.execPath}" "${SELF}" hook`, timeout: 15 }] }],
    },
  };
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 2));
  fs.writeFileSync(path.join(dir, 'target.json'), JSON.stringify({ sid, updates, ...target, title }, null, 2));
  fs.writeFileSync(path.join(dir, 'forwarded.json'), '[]');

  const env = {
    GROKRC_SID: sid,
    GROKRC_DIR: dir,
    CLAUDE_CODE_DISABLE_NOTIFICATION_PRESENCE_CHECK: '1',
  };
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const model = opts.model || 'haiku';

  relay(['new-session', '-d', '-s', name, '-n', 'claude', '-x', '200', '-y', '50', '-c', dir, ...envArgs,
    'claude', '--rc', `Grok · ${title}`, '--model', model,
    '--settings', path.join(dir, 'settings.json'),
    '--append-system-prompt', SYSTEM_PROMPT]);
  relay(['new-window', '-d', '-t', name, '-n', 'watch', ...envArgs,
    process.execPath, SELF, 'watch']);

  console.log(`grok-rc: relay "${name}" started for session ${sid}`);
  console.log(`  Grok pane : ${target.pane} (${path.basename(target.socket)})`);
  console.log(`  Phone     : open the Claude app → Code → "Grok · ${title}"`);
  console.log(`  Inspect   : tmux -L ${RELAY_SOCKET} attach -t ${name}`);
  console.log(`  Stop      : grok-rc stop --session ${sid}`);
}

function cmdStop(opts) {
  const sid = opts.session || process.env.GROK_SESSION_ID;
  if (opts.all) {
    try { relay(['kill-server']); } catch {}
    console.log('grok-rc: all relays stopped');
    return;
  }
  if (!sid) die('pass --session <id> or --all');
  try { relay(['kill-session', '-t', relayName(sid)]); console.log('grok-rc: stopped'); }
  catch { console.log('grok-rc: no relay running for this session'); }
}

function cmdStatus() {
  let out = '';
  try { out = relay(['list-sessions', '-F', '#{session_name}']).trim(); } catch {}
  if (!out) { console.log('grok-rc: no relays running'); return; }
  for (const name of out.split('\n')) {
    let line = '';
    try { line = relay(['capture-pane', '-p', '-t', `${name}:claude`]).split('\n').find((l) => l.includes('remote-control')) || ''; } catch {}
    console.log(`${name}  ${line.trim() || '(starting)'}`);
  }
}

// UserPromptSubmit hook inside the Claude relay: forward phone messages to Grok.
function cmdHook() {
  let input = '';
  try { input = fs.readFileSync(0, 'utf8'); } catch {}
  let prompt = '';
  try { prompt = JSON.parse(input).prompt || ''; } catch {}
  // Claude wraps long pastes in <pasted_content>, so the tag can appear after a prefix.
  if (!prompt || prompt.includes(TAG) || prompt.trimStart().startsWith('/')) return;
  const dir = process.env.GROKRC_DIR;
  if (!dir) return;
  try {
    const t = JSON.parse(fs.readFileSync(path.join(dir, 'target.json'), 'utf8'));
    const sock = ['-S', t.socket];
    pasteInto(sock, t.pane, prompt);
    spawnSync('sleep', ['0.3']);
    submit(sock, t.pane);
    const fwdFile = path.join(dir, 'forwarded.json');
    const fwd = JSON.parse(fs.readFileSync(fwdFile, 'utf8')).slice(-20);
    fwd.push(prompt.trim());
    fs.writeFileSync(fwdFile, JSON.stringify(fwd));
  } catch (e) {
    fs.appendFileSync(path.join(dir, 'hook.log'), `${new Date().toISOString()} ${e.message}\n`);
  }
}

// Tail Grok's updates.jsonl and post the chat into the Claude relay.
async function cmdWatch() {
  const dir = process.env.GROKRC_DIR;
  const t = JSON.parse(fs.readFileSync(path.join(dir, 'target.json'), 'utf8'));
  const name = relayName(t.sid);
  const claudePane = `${name}:claude`;
  const log = (m) => console.log(`${new Date().toLocaleTimeString()} ${m}`);

  // Wait for Remote Control to come up.
  for (let i = 0; i < 90; i++) {
    let screen = '';
    try { screen = relay(['capture-pane', '-p', '-t', claudePane]); } catch {}
    if (/remote-control is active/i.test(screen)) break;
    // The relay runs in its own state folder under ~/.grok-rc; trusting it is safe.
    if (/Yes, I trust this folder/.test(screen)) {
      relay(['send-keys', '-t', claudePane, 'Down']);
      await sleep(300);
      submit(['-L', RELAY_SOCKET], claudePane);
    }
    await sleep(1000);
  }

  const queue = [];
  const enqueue = (kind, body, push) => {
    body = body.trim();
    if (!body) return;
    if (body.length > MAX_ECHO) body = `${body.slice(0, MAX_ECHO)}\n… [truncated, ${body.length - MAX_ECHO} more chars in the terminal]`;
    const head = kind === 'DONE' ? `${TAG} DONE\nPUSH: ${push}` : `${TAG} ECHO`;
    queue.push(`${head}\n${body}`);
  };

  // Send one queued message at a time, only when Claude is idle at its prompt.
  (async function sender() {
    for (;;) {
      if (queue.length) {
        let screen = '';
        try { screen = relay(['capture-pane', '-p', '-t', claudePane]); } catch { process.exit(0); }
        const busy = /esc to interrupt|Thinking|Cogitat|✻ [A-Z][a-z]+…/.test(screen.split('\n').slice(-12).join('\n'));
        if (!busy) {
          const msg = queue.shift();
          pasteInto(['-L', RELAY_SOCKET], claudePane, msg);
          await sleep(400);
          submit(['-L', RELAY_SOCKET], claudePane);
          log(`sent ${msg.split('\n')[0]} (${msg.length} chars)`);
          await sleep(2500);
          continue;
        }
      }
      await sleep(700);
    }
  })();

  enqueue('ECHO', `🔗 Connected to Grok Build session "${t.title}".\nMessages you send here are typed into the Grok terminal.`);

  const forwarded = () => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, 'forwarded.json'), 'utf8')); } catch { return []; }
  };

  let pos = fs.statSync(t.updates).size;
  let partial = '';
  let userText = '';
  let agentText = '';
  let tools = [];
  let lastUser = '';

  const flushUser = () => {
    const u = userText.trim();
    userText = '';
    if (!u) return;
    lastUser = u;
    if (forwarded().includes(u)) return; // came from the phone, already visible there
    enqueue('ECHO', `🧑 (terminal) ${u}`);
  };
  const flushAgent = () => {
    const a = agentText.trim();
    agentText = '';
    if (a) enqueue('ECHO', a);
  };

  const handle = (j) => {
    const u = j?.params?.update;
    if (!u) return;
    const kind = u.sessionUpdate;
    if (u._meta?.isReplay || j?.params?._meta?.isReplay) return;
    if (kind === 'user_message_chunk') { userText += u.content?.text || ''; return; }
    if (userText) flushUser();
    if (kind === 'agent_message_chunk') agentText += u.content?.text || '';
    else if (kind === 'tool_call') {
      if (agentText.trim()) flushAgent();
      tools.push(u.title || u.kind || 'tool');
    } else if (kind === 'turn_completed') {
      const final = agentText.trim();
      agentText = '';
      const n = tools.length;
      tools = [];
      const stop = u.stop_reason && u.stop_reason !== 'end_turn' ? ` · ${u.stop_reason}` : '';
      const footer = `\n\n— Grok finished${n ? ` · ${n} tool call${n === 1 ? '' : 's'}` : ''}${stop}`;
      const firstLine = (final || u.agent_result || 'Turn finished').replace(/\s+/g, ' ');
      const push = `Grok: ${firstLine}`.slice(0, 180);
      enqueue('DONE', `${final || u.agent_result || '(no text reply)'}${footer}`, push);
      lastUser = '';
    }
  };

  log(`watching ${t.updates}`);
  for (;;) {
    let size;
    try { size = fs.statSync(t.updates).size; } catch { await sleep(1000); continue; }
    if (size < pos) pos = 0;
    if (size > pos) {
      const fd = fs.openSync(t.updates, 'r');
      const buf = Buffer.alloc(size - pos);
      fs.readSync(fd, buf, 0, buf.length, pos);
      fs.closeSync(fd);
      pos = size;
      const lines = (partial + buf.toString('utf8')).split('\n');
      partial = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try { handle(JSON.parse(line)); } catch {}
      }
    }
    await sleep(500);
  }
}

function cmdInstallSkill() {
  const src = path.join(__dirname, '..', 'skills', 'grok-rc', 'SKILL.md');
  for (const base of [path.join(os.homedir(), '.grok', 'skills'), path.join(os.homedir(), '.claude', 'skills')]) {
    const d = path.join(base, 'grok-rc');
    fs.mkdirSync(d, { recursive: true });
    fs.copyFileSync(src, path.join(d, 'SKILL.md'));
    console.log(`installed ${path.join(d, 'SKILL.md')}`);
  }
}

function help() {
  console.log(`grok-rc — mirror a Grok Build session to the Claude app (Claude Code Remote Control)

Usage:
  grok-rc start [--session <id>] [--pane %N] [--name <title>] [--model haiku]
  grok-rc stop [--session <id> | --all]
  grok-rc status
  grok-rc install-skill     copy the /grok-rc skill into ~/.grok/skills and ~/.claude/skills

Run "start" from inside a Grok Build session (Grok must run inside tmux).`);
}

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  const cmd = opts._[0];
  switch (cmd) {
    case 'start': return cmdStart(opts);
    case 'stop': return cmdStop(opts);
    case 'status': return cmdStatus();
    case 'hook': return cmdHook();
    case 'watch': return cmdWatch();
    case 'install-skill': return cmdInstallSkill();
    default: return help();
  }
})();
