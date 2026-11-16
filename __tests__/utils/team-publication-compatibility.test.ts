import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertTeamPublicationSupport } from '../../src/utils/certifiedPublication.js';

const git = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('../../src/utils/execAsync.js', () => ({ execFileAsync: git.exec }));
beforeEach(() => git.exec.mockReset());

describe('Team publication compatibility before launching agents', () => {
  it.each(['git version 2.29.0', 'git version 2.54.0 (Apple Git-180)', 'git version 3.0.0'])('accepts prepared-transaction support in %s', async (version) => {
    git.exec.mockResolvedValue(version);

    await expect(assertTeamPublicationSupport('/repo')).resolves.toBeUndefined();
  });

  it.each(['git version 2.20.0', 'git version 2.28.9', 'unknown Git'])('refuses %s with an actionable error', async (version) => {
    git.exec.mockResolvedValue(version);

    await expect(assertTeamPublicationSupport('/repo')).rejects.toThrow('Git 2.29 or newer');
  });
});
