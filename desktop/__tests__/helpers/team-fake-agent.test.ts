import { describe, expect, it } from 'vitest';
import { positionForPacket, readTeamPacket } from '../e2e/support/team-fake-agent.js';

function packetText(task: string, fields: Record<string, unknown> = {}): string {
  return `## Your task: ${task}\n\`\`\`team-position\n${JSON.stringify({
    round: 'fixture-round',
    summary: 'placeholder',
    ...fields,
  })}\n\`\`\``;
}

describe('external Team fake protocol', () => {
  it.each([
    ['build', 'build'],
    ['sealed proposal', 'design'],
    ['sealed code review', 'review'],
    ['sealed Duel comparison', 'compare'],
  ] as const)('recognizes the %s packet', (task, kind) => {
    expect(readTeamPacket(packetText(task))?.kind).toBe(kind);
  });

  it('does not treat a welcome message as a delivered round', () => {
    expect(readTeamPacket('Wait for the Team Room packet')).toBeUndefined();
  });

  it('reads the real relative seeded packet instruction in the member worktree', () => {
    const root = mkdtempSync(join(tmpdir(), 'muxbase-team-packet-'));
    try {
      mkdirSync(join(root, '.muxbase', 'team'), { recursive: true });
      writeFileSync(join(root, '.muxbase', 'team', 'round-fixture.md'), packetText('build'));

      const packet = readTeamPacket('Read .muxbase/team/round-fixture.md and follow it exactly.', root);

      expect(packet).toMatchObject({ kind: 'build', round: 'fixture-round' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports malformed structured packets instead of inventing a valid reply', () => {
    expect(() => readTeamPacket('```team-position\n{"round":\n```')).toThrow();
    expect(() => readTeamPacket('```team-position\n{}\n```')).toThrow(/round ID/);
  });

  it('binds replies to the packet and removes placeholder human questions', () => {
    const packet = readTeamPacket(packetText('sealed code review', {
      needsHuman: { reason: 'example only' },
      proposal: 'not a review proposal',
      supports: 'domain',
      verdict: 'changes-requested',
    }));
    if (!packet) throw new Error('Fixture packet was not parsed');

    const position = positionForPacket(packet);

    expect(position.round).toBe('fixture-round');
    expect(position.verdict).toBe('approve');
    expect(position.needsHuman).toBeUndefined();
    expect(position.proposal).toBeUndefined();
    expect(position.supports).toBeUndefined();
  });

  it('produces a real proposal and comparator preference without selecting a human winner', () => {
    const design = readTeamPacket(packetText('sealed proposal', { proposal: 'placeholder' }));
    const comparison = readTeamPacket(packetText('sealed Duel comparison'));
    if (!design || !comparison) throw new Error('Fixture packet was not parsed');

    expect(positionForPacket(design).proposal).toMatchObject({
      summary: expect.stringContaining('provided checks'),
    });
    expect(positionForPacket(comparison)).toMatchObject({ supports: 'developer', verdict: 'approve' });
    expect(positionForPacket(comparison).winnerPaneId).toBeUndefined();
  });
});
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
