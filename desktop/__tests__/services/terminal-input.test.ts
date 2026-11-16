import { describe, expect, it } from 'vitest';
import {
  submitTerminalCommand,
  writeTerminalInput,
  type TmuxInputRunner,
} from '../../src/main/services/terminal-input';

interface RecordedTmuxCommand {
  args: string[];
  input?: Buffer;
}

class RecordingTmuxInputRunner implements TmuxInputRunner {
  readonly commands: RecordedTmuxCommand[] = [];

  async run(args: readonly string[], input?: Buffer): Promise<void> {
    this.commands.push({ args: [...args], input });
  }
}

describe('writeTerminalInput', () => {
  it('writes xterm terminal response bytes through a tmux buffer without shell escaping or hex key parsing', async () => {
    const runner = new RecordingTmuxInputRunner();
    const terminalResponse = '\x1b]10;rgb:e6e6/eded/f3f3\x1b\\\x1b[?1;2c\x1b[6;1R';

    await writeTerminalInput('%19', terminalResponse, runner);

    expect(runner.commands).toHaveLength(2);

    const loadCommand = runner.commands[0];
    const pasteCommand = runner.commands[1];
    const bufferName = loadCommand.args[2];

    expect(loadCommand.args).toEqual(['load-buffer', '-b', bufferName, '-']);
    expect(loadCommand.input).toEqual(Buffer.from(terminalResponse, 'utf8'));
    expect(pasteCommand.args).toEqual(['paste-buffer', '-d', '-r', '-b', bufferName, '-t', '%19']);
  });

  it('does not call tmux for empty input', async () => {
    const runner = new RecordingTmuxInputRunner();

    await writeTerminalInput('%19', '', runner);

    expect(runner.commands).toEqual([]);
  });

  it('sends a line feed as a raw byte with the no-replacement paste flag (-r)', async () => {
    // Arrange
    const runner = new RecordingTmuxInputRunner();

    // Act
    await writeTerminalInput('%19', '\n', runner);

    // Assert
    const [loadCommand, pasteCommand] = runner.commands;
    expect(loadCommand.input).toEqual(Buffer.from('\n', 'utf8'));
    expect(pasteCommand.args).toContain('-r');
  });

  it('deletes the tmux buffer when paste fails after loading a paste-sized payload', async () => {
    // Use a payload longer than the keystroke fast-path threshold so we exercise
    // the load-buffer / paste-buffer / delete-buffer branch.
    const payload = 'hello world how are you today';
    const runner = new RecordingTmuxInputRunner();
    runner.run = async (args: readonly string[], input?: Buffer) => {
      runner.commands.push({ args: [...args], input });
      if (args[0] === 'paste-buffer') {
        throw new Error('paste failed');
      }
    };

    await expect(writeTerminalInput('%19', payload, runner)).rejects.toThrow('paste failed');

    const bufferName = runner.commands[0].args[2];
    expect(runner.commands.map((command) => command.args)).toEqual([
      ['load-buffer', '-b', bufferName, '-'],
      ['paste-buffer', '-d', '-r', '-b', bufferName, '-t', '%19'],
      ['delete-buffer', '-b', bufferName],
    ]);
  });

  it('routes single-character keystrokes through send-keys -l (avoids paste-batching)', async () => {
    // Arrange — single letter is the classic case; paste-buffer under socket
    // contention would merge several of these into one bracketed paste, which
    // is what drops/reorders characters in busy sessions.
    const runner = new RecordingTmuxInputRunner();

    // Act
    await writeTerminalInput('%19', 'h', runner);

    // Assert
    expect(runner.commands).toHaveLength(1);
    expect(runner.commands[0].args).toEqual(['send-keys', '-l', '-t', '%19', '--', 'h']);
    expect(runner.commands[0].input).toBeUndefined();
  });

  it('routes short printable strings through send-keys -l', async () => {
    // Arrange — a short burst still fits in one keystroke call
    const runner = new RecordingTmuxInputRunner();

    // Act
    await writeTerminalInput('%19', 'hello', runner);

    // Assert
    expect(runner.commands).toHaveLength(1);
    expect(runner.commands[0].args).toEqual(['send-keys', '-l', '-t', '%19', '--', 'hello']);
  });

  it('routes multi-line input through paste-buffer, not send-keys', async () => {
    // Arrange — anything with an embedded newline uses a named tmux buffer so
    // the bytes stay exact without entering command-line parsing.
    const runner = new RecordingTmuxInputRunner();

    // Act
    await writeTerminalInput('%19', 'a\nb', runner);

    // Assert
    expect(runner.commands).toHaveLength(2);
    expect(runner.commands[0].args[0]).toBe('load-buffer');
    expect(runner.commands[1].args[0]).toBe('paste-buffer');
  });
});

describe('submitTerminalCommand', () => {
  it('separates Enter from agent paste, but keeps the whole submission ordered', async () => {
    const runner = new RecordingTmuxInputRunner();

    await submitTerminalCommand('%19', 'Build the feature', runner, { isAgent: true });

    expect(runner.commands.map((command) => command.args[0])).toEqual([
      'load-buffer', 'paste-buffer', 'send-keys',
    ]);
    expect(runner.commands.at(-1)?.args).toEqual(['send-keys', '-t', '%19', 'Enter']);
  });

  it('does not interleave another command or keystroke with a delayed agent submission', async () => {
    const runner = new RecordingTmuxInputRunner();

    await Promise.all([
      submitTerminalCommand('%19', 'First task', runner, { isAgent: true }),
      submitTerminalCommand('%19', 'Second task', runner, { isAgent: true }),
      writeTerminalInput('%19', 'x', runner),
    ]);

    expect(runner.commands.map((command) => command.args[0])).toEqual([
      'load-buffer', 'paste-buffer', 'send-keys',
      'load-buffer', 'paste-buffer', 'send-keys', 'send-keys',
    ]);
    expect(runner.commands[0].input?.toString()).toBe('First task');
    expect(runner.commands[3].input?.toString()).toBe('Second task');
    expect(runner.commands.at(-1)?.args.at(-1)).toBe('x');
  });

  it('submits shell text and Enter in one tmux command list without an agent delay', async () => {
    const runner = new RecordingTmuxInputRunner();

    await submitTerminalCommand('%19', 'printf ready', runner);

    expect(runner.commands).toHaveLength(2);
    const [loadCommand, pasteCommand] = runner.commands;
    const bufferName = loadCommand.args[2];
    expect(loadCommand.args).toEqual(['load-buffer', '-b', bufferName, '-']);
    expect(loadCommand.input).toEqual(Buffer.from('printf ready', 'utf8'));
    expect(pasteCommand.args).toEqual([
      'paste-buffer', '-d', '-r', '-b', bufferName, '-t', '%19',
      ';', 'send-keys', '-t', '%19', 'Enter',
    ]);
  });

  it('sends only a real Enter key when the command is empty', async () => {
    const runner = new RecordingTmuxInputRunner();

    await submitTerminalCommand('%19', '', runner);

    expect(runner.commands).toEqual([{
      args: ['send-keys', '-t', '%19', 'Enter'],
      input: undefined,
    }]);
  });

  it('preserves Unicode, newlines, and control bytes in command text', async () => {
    const runner = new RecordingTmuxInputRunner();
    const command = 'printf "שלום"\n\x1b[31m';

    await submitTerminalCommand('%19', command, runner);

    expect(runner.commands[0].input).toEqual(Buffer.from(command, 'utf8'));
    expect(runner.commands[1].args.slice(-5)).toEqual([';', 'send-keys', '-t', '%19', 'Enter']);
  });

  it('cleans the tmux buffer when the ordered submission fails', async () => {
    const runner = new RecordingTmuxInputRunner();
    runner.run = async (args: readonly string[], input?: Buffer) => {
      runner.commands.push({ args: [...args], input });
      if (args[0] === 'paste-buffer') throw new Error('submit failed');
    };

    await expect(submitTerminalCommand('%19', 'printf ready', runner)).rejects.toThrow('submit failed');

    const bufferName = runner.commands[0].args[2];
    expect(runner.commands.at(-1)?.args).toEqual(['delete-buffer', '-b', bufferName]);
  });
});
