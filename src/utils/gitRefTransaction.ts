import { spawn } from 'node:child_process';
import { getEnhancedPathAsync } from './execAsync.js';

const TRANSACTION_TIMEOUT_MS = 5 * 60_000;
const OUTPUT_LIMIT = 16_000;

export async function prepareHeadUpdate(root: string, sourceSha: string, targetSha: string, reason: string) {
  const child = spawn('git', [
    '-c', 'core.filesRefLockTimeout=2000', '-c', 'core.logAllRefUpdates=true', 'update-ref', '--stdin', '-m', reason,
  ], {
    cwd: root,
    env: { ...process.env, PATH: await getEnhancedPathAsync() },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  let diagnostic = '';
  let failure: Error | undefined;
  let ended = false;
  let changed = () => {};
  const finished = new Promise<number | null>((resolve) => {
    child.once('error', (error) => { failure = error; changed(); resolve(null); });
    child.once('close', (code) => { ended = true; changed(); resolve(code); });
  });
  child.stdout.on('data', (data: Buffer) => { output = (output + data.toString()).slice(-OUTPUT_LIMIT); changed(); });
  child.stderr.on('data', (data: Buffer) => { diagnostic = (diagnostic + data.toString()).slice(-OUTPUT_LIMIT); });
  child.stdin.on('error', (error) => { failure = error; changed(); });
  const timer = setTimeout(() => {
    failure = new Error('The prepared Git publication transaction timed out.');
    changed();
    child.kill('SIGTERM');
  }, TRANSACTION_TIMEOUT_MS);
  timer.unref();
  void finished.then(() => clearTimeout(timer));

  const response = (line: string) => new Promise<void>((resolve, reject) => {
    changed = () => {
      if (output.split('\n').includes(line)) resolve();
      else if (failure || ended) reject(new Error(
        `Could not ${line.split(':')[0]} the Git publication transaction: ${failure?.message ?? diagnostic.trim()}. Team publication requires Git 2.29 or newer.`,
      ));
    };
    changed();
  });
  const abort = async () => {
    if (!ended && !child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end('abort\n');
    await finished;
  };
  try {
    child.stdin.write(`start\nupdate HEAD ${sourceSha} ${targetSha}\nprepare\n`);
    await response('prepare: ok');
  } catch (error) {
    await abort();
    throw error;
  }
  return {
    abort,
    async commit() {
      child.stdin.end('commit\n');
      await response('commit: ok');
      const code = await finished;
      if (code !== 0 || failure) throw new Error(`Git publication did not exit cleanly: ${failure?.message ?? diagnostic}`);
    },
  };
}
