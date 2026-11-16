import type { TeamRun } from '../../../shared/team-types';
import { usePaneActivityStore } from '../../stores';
import { contestedItems, roleName } from './teamViewModel';

interface LaneProps {
  items: Array<{ detail?: string; key: string; text: string }>;
  lane: 'agreed' | 'contested' | 'dissent' | 'working';
  title: string;
}

function Lane({ items, lane, title }: Readonly<LaneProps>) {
  if (items.length === 0) return null;
  return (
    <section className="team-lane" data-lane={lane} data-testid={`team-lane-${lane}`}>
      <header className="team-rail-title"><span>{title}</span><span className="team-count">{items.length}</span></header>
      <ol>
        {items.map((item) => (
          <li key={item.key}>
            {item.text}
            {item.detail && <small>{item.detail}</small>}
          </li>
        ))}
      </ol>
    </section>
  );
}

function agreementTitle(text: string): string {
  return text.split(': ')[0];
}

export function TeamLedger({ run }: Readonly<{ run: TeamRun }>) {
  const activity = usePaneActivityStore((s) => s.activityByPaneId);
  const working = run.members
    .filter((member) => activity[member.paneId]?.state === 'working')
    .map((member) => ({ key: member.role, text: roleName(run, member.role), detail: `${member.agent}, ${member.readOnly ? 'read-only' : 'worktree'}` }));
  const contested = contestedItems(run).map((text) => ({ key: text, text }));
  const agreed = run.agreements.map((agreement) => ({
    detail: agreement.source,
    key: `${agreement.at}`,
    text: agreementTitle(agreement.text),
  }));
  const dissent = run.dissent.map((entry) => ({
    detail: `${roleName(run, entry.role)}, saved with ${entry.decisionLabel}`,
    key: `${entry.at}-${entry.role}`,
    text: entry.text,
  }));
  return (
    <>
      <Lane items={contested} lane="contested" title="Contested" />
      <Lane items={agreed} lane="agreed" title="Agreed" />
      <Lane items={working} lane="working" title="Working now" />
      <Lane items={dissent} lane="dissent" title="Recorded dissent" />
    </>
  );
}
