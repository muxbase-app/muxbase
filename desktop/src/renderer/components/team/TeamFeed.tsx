import { Check, ChevronRight, X } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { TeamFeedItem, TeamRoleId, TeamRun } from '../../../shared/team-types';
import { formatAgentLabel } from '../../lib/formatters';
import { TeamCopyButton } from './TeamCopyButton';
import { TeamDecisionCard } from './TeamDecisionCard';
import type { CheckItem, FeedBlock, FeedSegment, MessageItem } from './teamFeedModel';
import { TeamSealedRound } from './TeamSealedRound';
import { memberFor, ROLE_COLORS, roleMark, roleName } from './teamViewModel';

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

function labelTone(label: string): string {
  if (/^(Objection|Blocks|Rebuts)/.test(label)) return 'hot';
  if (/^(Concedes|Approves|Backs)/.test(label)) return 'ok';
  return '';
}

export function TeamTime({ at }: Readonly<{ at: number }>) {
  const date = new Date(at);
  return <time dateTime={date.toISOString()} title={date.toLocaleString()}>{CLOCK.format(date)}</time>;
}

function SpeakerGroup({ items, role, run }: Readonly<{ items: MessageItem[]; role: TeamRoleId; run: TeamRun }>) {
  const member = memberFor(run, role);
  return (
    <article className="team-group" style={{ '--c': ROLE_COLORS[role] } as CSSProperties}>
      <div aria-hidden="true" className="team-avatar">{roleMark(run, role)}</div>
      <header className="team-who">
        <b>{roleName(run, role)}</b>
        {member && <span>{formatAgentLabel(member.agent)} · {member.readOnly ? 'read-only' : 'writer'}</span>}
        <TeamTime at={items[0].at} />
      </header>
      <div className="team-msgs">
        {items.map((item) => (
          <div className="team-msg" key={item.id}>
            <p>{item.label && <span className={`team-kind ${labelTone(item.label)}`}>{item.label}</span>}{item.text}</p>
            {item.evidence.length > 0 && (
              <div className="team-refs">{item.evidence.map((reference) => <span key={reference}>{reference}</span>)}</div>
            )}
          </div>
        ))}
      </div>
    </article>
  );
}

function TeamCheckRow({ item }: Readonly<{ item: CheckItem }>) {
  const transcript = `$ ${item.command}\n\n${item.output || 'The command produced no output.'}`;
  return (
    <details className={`team-check${item.passed ? '' : ' bad'}`} data-testid="team-check">
      <summary>
        {item.passed ? <Check aria-hidden="true" className="team-check-icon" /> : <X aria-hidden="true" className="team-check-icon" />}
        <span className="team-check-cmd" title={item.command}>{item.command}</span>
        <span className="team-check-res">{item.passed ? 'passed' : 'failed'}</span>
        <ChevronRight aria-hidden="true" className="team-chevron" />
      </summary>
      <div className="team-out">
        <pre aria-label={`Check output: ${item.command}`} role="region" tabIndex={0}>{transcript}</pre>
        <TeamCopyButton label={`Copy output of ${item.command}`} text={transcript} />
      </div>
    </details>
  );
}

function ChecksGroup({ items }: Readonly<{ items: CheckItem[] }>) {
  const passed = items.filter((item) => item.passed).length;
  return (
    <div className="team-checks">
      <header>
        <b>{passed === items.length ? 'Checks passed' : 'Checks'}</b>
        <span>{passed} of {items.length} passed · <TeamTime at={items[items.length - 1].at} /></span>
      </header>
      {items.map((item) => <TeamCheckRow item={item} key={item.id} />)}
    </div>
  );
}

export function TeamFeedEntry({ item, run }: Readonly<{ item: TeamFeedItem; run: TeamRun }>) {
  switch (item.kind) {
    case 'agreed':
      return (
        <p className="team-sys good" data-testid="team-agreed" title={item.text}>
          <Check aria-hidden="true" /><span><b>Agreed</b> · {item.title} · {item.votes}</span>
        </p>
      );
    case 'check':
      return <TeamCheckRow item={item} />;
    case 'decision': {
      const decision = run.decisions.find((candidate) => candidate.id === item.decisionId);
      return decision ? <TeamDecisionCard decision={decision} run={run} /> : null;
    }
    case 'human':
      return (
        <div className="team-you">
          <span>You · <TeamTime at={item.at} /></span>
          <p>{item.text}</p>
        </div>
      );
    case 'lead':
      return <p className="team-sys">{item.text}</p>;
    default:
      return null;
  }
}

function Block({ block, run }: Readonly<{ block: FeedBlock; run: TeamRun }>) {
  if (block.kind === 'speaker') return <SpeakerGroup items={block.items} role={block.role} run={run} />;
  if (block.kind === 'checks') return <ChecksGroup items={block.items} />;
  return <TeamFeedEntry item={block.item} run={run} />;
}

function RoundHeading({ segment }: Readonly<{ segment: FeedSegment }>) {
  return (
    <>
      <span className="team-round-title">{segment.title}</span>
      <span className="team-round-sum">— {segment.summary}</span>
      <span aria-hidden="true" className="team-round-line" />
      {segment.at !== undefined && <TeamTime at={segment.at} />}
    </>
  );
}

function Blocks({ blocks, run }: Readonly<{ blocks: FeedBlock[]; run: TeamRun }>) {
  return blocks.map((block) => <div className="team-enter" key={block.key}><Block block={block} run={run} /></div>);
}

function Segment({ run, segment }: Readonly<{ run: TeamRun; segment: FeedSegment }>) {
  const { round } = segment;
  if (!round) return <Blocks blocks={segment.blocks} run={run} />;
  return (
    <>
      <details className="team-round" data-round-kind={round.kind} open={!segment.collapsed}>
        <summary className="team-round-head">
          <ChevronRight aria-hidden="true" className="team-chevron" />
          <RoundHeading segment={segment} />
        </summary>
        <div className="team-round-body">
          {!round.closedAt && <TeamSealedRound round={round} run={run} />}
          <Blocks blocks={segment.blocks} run={run} />
        </div>
      </details>
      <Blocks blocks={segment.pinned} run={run} />
    </>
  );
}

export function TeamFeed({ run, segments }: Readonly<{ run: TeamRun; segments: FeedSegment[] }>) {
  return segments.map((segment) => <Segment key={segment.key} run={run} segment={segment} />);
}
