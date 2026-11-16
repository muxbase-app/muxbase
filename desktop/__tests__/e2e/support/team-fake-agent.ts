import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

interface TeamPacket {
  example: Record<string, unknown>;
  kind: 'build' | 'design' | 'review' | 'compare';
  round: string;
  text: string;
}

export const TEAM_FIXTURE_PACKAGE_NAME = 'muxbase-team-hermetic-fixture';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function readTeamPacket(input: string, worktreeRoot = process.cwd()): TeamPacket | undefined {
  const reference = input.match(/(?:\/[A-Za-z0-9_./-]+\/)?\.muxbase\/team\/round-[A-Za-z0-9_.-]+\.md/)?.[0];
  const text = reference ? readFileSync(resolve(worktreeRoot, reference), 'utf8') : input;
  const block = text.match(/```(?:team-position|json)\s*([\s\S]*?)\s*```/);
  if (!block) return undefined;
  const example: unknown = JSON.parse(block[1]);
  if (!isRecord(example)) throw new Error('Team fixture received a non-object reply template');
  const round = typeof example.round === 'string' ? example.round : undefined;
  if (!round) throw new Error('Team fixture received a packet without a round ID');
  const kind = /Your task:.*Duel comparison/i.test(text) ? 'compare'
    : /Your task:.*code review/i.test(text) ? 'review'
      : /Your task:.*build/i.test(text) ? 'build' : 'design';
  return { example, kind, round, text };
}

export function positionForPacket(packet: TeamPacket): Record<string, unknown> {
  const position: Record<string, unknown> = {
    ...packet.example,
    evidence: ['The fixture source and provided checks were inspected'],
    objections: [],
    round: packet.round,
    summary: 'Update answer.json to 42 and preserve the independent writer identity',
  };
  delete position.needsHuman;
  if (packet.kind === 'design') {
    position.proposal = {
      cost: 'One local source edit and the provided check',
      gain: 'The answer matches the requested value',
      risk: 'The provided check protects the value and writer identity',
      summary: 'Set answer to 42, retain the writer identity, and run the provided checks',
      title: 'Update the fixture answer',
    };
    position.supports = 'developer';
  } else {
    delete position.proposal;
    delete position.supports;
  }
  if (packet.kind === 'review' || packet.kind === 'compare') position.verdict = 'approve';
  else delete position.verdict;
  if (packet.kind === 'compare') position.supports = 'developer';
  return position;
}

function runFakeAgent(): void {
  if (process.env.MUXBASE_E2E_TEAM_FAKE !== '1'
    || !basename(homedir()).startsWith('muxbase-home-e2e-')) {
    throw new Error('Team fake agents require the isolated E2E runner HOME');
  }
  const manifest: unknown = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
  if (!isRecord(manifest) || manifest.name !== TEAM_FIXTURE_PACKAGE_NAME) {
    throw new Error('Team fake agents only run inside the owned fixture project');
  }
  const agent = process.argv[2];
  const args = process.argv.slice(3);
  if (agent !== 'claude' && agent !== 'codex') throw new Error(`Unsupported Team fixture agent: ${agent}`);
  if (args.includes('-p') || args.includes('--print') || args.includes('exec')) {
    const result = 'feat: apply team fixture result';
    const lastMessageIndex = args.indexOf('--output-last-message');
    if (lastMessageIndex >= 0) writeFileSync(args[lastMessageIndex + 1], result);
    process.stdout.write(args.includes('--output-format')
      ? `${JSON.stringify({ type: 'result', result })}\n` : `${result}\n`);
    return;
  }
  process.title = agent;
  const cwd = process.cwd();
  const sessionId = randomUUID();
  const now = new Date();
  const sessionDirectory = agent === 'claude'
    ? join(homedir(), '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))
    : join(homedir(), '.codex', 'sessions', String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  mkdirSync(sessionDirectory, { recursive: true });
  const sessionFile = join(sessionDirectory, agent === 'claude'
    ? `${sessionId}.jsonl` : `rollout-${now.toISOString().replace(/:/g, '-')}-${sessionId}.jsonl`);
  const audit = join(homedir(), 'team-fake-launches.ndjson');
  appendFileSync(audit, `${JSON.stringify({ agent, args, cwd, paneId: process.env.MUXBASE_PANE_ID })}\n`);
  let tokens = 0;
  let turn = 0;
  let input = '';
  let pending: ReturnType<typeof setTimeout> | undefined;
  const readOnly = args.includes('read-only') || args.includes('plan');
  const writeEntry = (entry: Record<string, unknown>) => {
    appendFileSync(sessionFile, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`);
  };
  const hook = (hookEvent: string) => {
    const hookPath = join(homedir(), '.muxbase', 'internal',
      agent === 'claude' ? 'record-claude-session.cjs' : 'record-codex-activity.cjs');
    if (!existsSync(hookPath)) throw new Error(`Team fixture lifecycle hook is missing: ${hookPath}`);
    const result = spawnSync(process.execPath, [hookPath], {
      encoding: 'utf8',
      input: JSON.stringify({
        background_tasks: [],
        cwd,
        hook_event_name: hookEvent,
        prompt_id: `${sessionId}-${turn}`,
        session_crons: [],
        session_id: sessionId,
        transcript_path: sessionFile,
        turn_id: `${sessionId}-${turn}`,
      }),
    });
    if (result.status !== 0) throw new Error(`Team fixture hook failed: ${result.stderr}`);
  };
  const event = (type: string, payload: Record<string, unknown> = {}) => {
    writeEntry({ type: 'event_msg', payload: { type, ...payload } });
  };
  const userMessage = (text: string) => {
    turn += 1;
    hook('UserPromptSubmit');
    hook('PreToolUse');
    if (agent === 'claude') {
      writeEntry({ type: 'user', sessionId, message: { role: 'user', content: text } });
    } else {
      event('task_started');
      writeEntry({ type: 'response_item', payload: {
        type: 'message', role: 'user', content: [{ type: 'input_text', text }],
      } });
    }
  };
  const assistantMessage = (text: string, usage: number) => {
    tokens += usage;
    if (agent === 'claude') {
      writeEntry({ type: 'assistant', sessionId, message: {
        content: [{ type: 'text', text }],
        id: randomUUID(),
        model: 'team-fixture',
        role: 'assistant',
        stop_reason: 'end_turn',
        usage: { input_tokens: usage / 2, output_tokens: usage / 2 },
      } });
    } else {
      writeEntry({ type: 'response_item', payload: {
        type: 'message', role: 'assistant', content: [{ type: 'output_text', text }],
      } });
      event('token_count', { info: {
        total_token_usage: { input_tokens: tokens / 2, output_tokens: tokens / 2, total_tokens: tokens },
      } });
      event('task_complete');
    }
    process.stdout.write(`${text}\n`);
    hook('Stop');
  };
  const checkSource = () => {
    const checked = spawnSync(process.execPath, ['--test', 'check.test.mjs'], { cwd, encoding: 'utf8' });
    if (checked.status !== 0) throw new Error(`Team fixture source check failed: ${checked.stdout}${checked.stderr}`);
  };
  const respond = (text: string) => {
    appendFileSync(audit, `${JSON.stringify({ input: text, paneId: process.env.MUXBASE_PANE_ID })}\n`);
    const packet = readTeamPacket(text);
    if (!packet) {
      userMessage(text);
      assistantMessage(`MUXBASE_FAKE_AGENT_READY ${agent}`, 16);
      return;
    }
    userMessage(text);
    pending = setTimeout(() => {
      pending = undefined;
      if (packet.kind === 'build') {
        if (readOnly) throw new Error('Read-only Team fixture was asked to build');
        writeFileSync(join(cwd, 'answer.json'), `${JSON.stringify({ answer: 42, writer: agent })}\n`);
        checkSource();
      } else if (packet.kind === 'review') checkSource();
      else if (packet.kind === 'compare') {
        const refs = [...new Set(packet.text.match(/[a-f0-9]{40}/g) ?? [])];
        const candidates = refs.map((ref) => {
          const shown = spawnSync('git', ['show', `${ref}:answer.json`], { cwd, encoding: 'utf8' });
          if (shown.status !== 0) throw new Error(`Cannot inspect Team candidate ${ref}: ${shown.stderr}`);
          const answer: unknown = JSON.parse(shown.stdout);
          return isRecord(answer) && answer.answer === 42;
        });
        if (candidates.filter(Boolean).length < 2) throw new Error('Duel fixture did not receive two frozen candidates');
      }
      assistantMessage(`\`\`\`team-position\n${JSON.stringify(positionForPacket(packet))}\n\`\`\``, 200);
    }, 80);
  };
  const interrupt = (exit: boolean) => {
    if (pending) clearTimeout(pending);
    pending = undefined;
    input = '';
    assistantMessage('Interrupted; fixture is idle', 2);
    if (exit) {
      hook('SessionEnd');
      process.exit(0);
    }
  };

  if (agent === 'codex') {
    writeEntry({ type: 'session_meta', payload: { id: sessionId, cwd, model: 'team-fixture' } });
  } else writeFileSync(sessionFile, '');
  hook('SessionStart');
  userMessage('Team fixture initialized');
  assistantMessage(`MUXBASE_FAKE_AGENT_READY ${agent}`, 16);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (data: string) => {
    if (data === '\u001b' || data.includes('\u0003')) {
      interrupt(agent === 'codex');
      return;
    }
    input += data.replace(/\u001b\[20[01]~/g, '');
    const enter = input.indexOf('\r');
    if (enter >= 0) {
      const message = input.slice(0, enter);
      input = input.slice(enter + 1);
      respond(message);
    }
  });
  process.on('SIGINT', () => interrupt(true));
  process.on('SIGTERM', () => {
    if (pending) clearTimeout(pending);
    hook('SessionEnd');
    process.exit(0);
  });
  const initial = args.find((arg) => arg.includes('round-') || arg.includes('```team-position'));
  if (initial) respond(initial);
  process.stdin.resume();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runFakeAgent();
