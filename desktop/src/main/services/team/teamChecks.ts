import { fork } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { gitOrThrow } from '../git/gitDiff.js';

const CHECK_TIMEOUT_MS = 10 * 60 * 1000;
const CHECK_OUTPUT_TAIL = 6000;

interface TeamCheckResult {
  output: string;
  passed: boolean;
}

function packageManager(projectRoot: string): string {
  if (existsSync(join(projectRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(projectRoot, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

export function detectCheckCommand(projectRoot: string): string | undefined {
  const manifest = join(projectRoot, 'package.json');
  if (!existsSync(manifest)) return undefined;
  const { scripts } = JSON.parse(readFileSync(manifest, 'utf-8')) as { scripts?: Record<string, string> };
  return scripts?.test ? `${packageManager(projectRoot)} test` : undefined;
}

export async function runTeamCheck(cwd: string, command: string, signal?: AbortSignal): Promise<TeamCheckResult> {
  if (signal?.aborted) return { output: 'Check cancelled', passed: false };
  return new Promise((resolve) => {
    const child = fork(new URL('./teamCheckOwner.mjs', import.meta.url), [], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      execArgv: [],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let result: TeamCheckResult | undefined;
    let failure = '';
    const send = (request: { type: 'cancel' } | { cwd: string; command: string; timeoutMs: number }) => {
      if (child.connected) child.send(request, (error) => { if (error) failure = error.message; });
    };
    const abort = () => send({ type: 'cancel' });
    child.stderr?.on('data', (chunk: Buffer) => { failure = `${failure}${chunk.toString()}`.slice(-CHECK_OUTPUT_TAIL); });
    child.on('message', (message: unknown) => {
      if (typeof message !== 'object' || message === null) return;
      const response = message as Partial<TeamCheckResult>;
      if (typeof response.output === 'string' && typeof response.passed === 'boolean') result = { output: response.output, passed: response.passed };
    });
    child.on('error', (error) => { failure = error.message; });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (result && code === 0 && !failure) resolve(result);
      else resolve({
        output: `${result?.output ?? ''}\n${failure || `Owned check exited with code ${code} without a valid result`}`.trim().slice(-CHECK_OUTPUT_TAIL),
        passed: false,
      });
    });
    signal?.addEventListener('abort', abort, { once: true });
    send({ command, cwd, timeoutMs: CHECK_TIMEOUT_MS });
    if (signal?.aborted) abort();
  });
}

export async function changedFiles(projectRoot: string, from: string, to: string): Promise<string[]> {
  const output = await gitOrThrow(projectRoot, ['diff', '--name-only', from, to]);
  return output.split('\n').filter(Boolean);
}
