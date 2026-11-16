import { spawn } from 'node:child_process';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';

const OUTPUT_TAIL = 6000;
const KILL_GRACE_MS = 500;
let child;
let failure = '';
let output = '';
let timeout;
let draining = false;
let closed = false;
let exitCode;
let started = false;

function terminateGroup(signal) {
  if (!child?.pid) return;
  try {
    process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function finish() {
  if (!closed || draining) return;
  clearTimeout(timeout);
  const result = {
    output: `${output}${failure ? `\n${failure}` : ''}`.slice(-OUTPUT_TAIL),
    passed: exitCode === 0 && !failure,
  };
  if (process.connected) process.send(result, () => {
    if (process.connected) process.disconnect();
  });
}

function drain(reason) {
  if (reason && !failure) failure = reason;
  if (draining || !child) return;
  draining = true;
  terminateGroup('SIGTERM');
  setTimeout(() => {
    terminateGroup('SIGKILL');
    draining = false;
    finish();
  }, KILL_GRACE_MS);
}

function start(request) {
  const { command, cwd, timeoutMs } = request;
  if (typeof command !== 'string' || typeof cwd !== 'string'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid owned-check request');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn('sh', ['-c', command], {
    cwd, detached: process.platform !== 'win32', env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const append = (chunk) => { output = `${output}${chunk.toString()}`.slice(-OUTPUT_TAIL); };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('error', (error) => {
    failure = error.message;
    drain();
  });
  child.on('exit', (code) => {
    exitCode = code;
    drain();
  });
  child.on('close', (code) => {
    closed = true;
    exitCode = code;
    finish();
  });
  timeout = setTimeout(() => drain('Check timed out'), timeoutMs);
}

process.on('message', (request) => {
  if (request?.type === 'cancel') {
    drain('Check cancelled');
  } else if (!started && process.connected) {
    started = true;
    start(request);
  }
});
process.on('disconnect', () => drain('Check launcher disconnected'));
process.on('SIGTERM', () => drain('Check owner interrupted'));
process.on('SIGINT', () => drain('Check owner interrupted'));
