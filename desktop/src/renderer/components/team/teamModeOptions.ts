import type { TeamMode } from '../../../shared/team-settings';

export const TEAM_MODE_OPTIONS: Array<{ label: string; tagline: string; value: TeamMode }> = [
  { label: 'Pair', tagline: 'Writer + independent reviewer', value: 'pair' },
  { label: 'Duel', tagline: 'Two writers, you pick the winner', value: 'duel' },
  { label: 'Council', tagline: 'Roles agree on a design first', value: 'council' },
];

export const TEAM_MODE_COPY: Record<TeamMode, string> = {
  council: 'A writer and your selected read-only Council roles discuss the design before building and reviewing.',
  duel: 'Two writers build in separate worktrees. An independent comparator reviews both; you choose a winner and merge.',
  pair: 'One writer builds, then an independent read-only reviewer checks the change. You approve every merge.',
};
