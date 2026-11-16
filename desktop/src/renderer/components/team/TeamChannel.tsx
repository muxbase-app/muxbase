import { ArrowDown } from 'lucide-react';
import { type KeyboardEvent, useId, useMemo, useRef, useState } from 'react';
import type { TeamFeedItem, TeamRun } from '../../../shared/team-types';
import { NextActionDock } from './NextActionDock';
import { TeamComposer } from './TeamComposer';
import { TeamDuelCandidates } from './TeamDuelCandidates';
import { TeamFeed } from './TeamFeed';
import { feedSegments, historyItems } from './teamFeedModel';
import { TeamRecoveryCard } from './TeamRecoveryCard';
import { activeDecision, isRunLive } from './teamViewModel';
import { useDecisionSheet, useErrorAnnouncement, useFocusAfterDecision } from './useChannelA11y';
import { useDockHeight, useStreamFollow } from './useChannelScroll';

type ChannelFilter = 'agreed' | 'all' | 'contested' | 'working';

const FILTERS: Array<{ id: ChannelFilter; label: string; noun: string }> = [
  { id: 'all', label: 'Everything', noun: 'activity' },
  { id: 'agreed', label: 'Agreed', noun: 'agreed activity' },
  { id: 'contested', label: 'Contested', noun: 'contested activity' },
  { id: 'working', label: 'Build activity', noun: 'build activity' },
];

function matches(item: TeamFeedItem, filter: ChannelFilter): boolean {
  return filter === 'all' || item.lane === filter;
}

function countVisible(history: TeamFeedItem[], filter: ChannelFilter): number {
  return history.filter((item) => item.kind !== 'round' && matches(item, filter)).length;
}

function emptyMessage(run: TeamRun, filter: ChannelFilter): string {
  const noun = FILTERS.find((item) => item.id === filter)?.noun ?? 'activity';
  return isRunLive(run) || run.status === 'ready' ? `No ${noun} yet.` : `No ${noun} in this run.`;
}

function FilterTabs({ filter, history, inert, onChange, panelId, tabId }: Readonly<{
  filter: ChannelFilter; history: TeamFeedItem[]; inert: boolean; onChange: (filter: ChannelFilter) => void; panelId: string; tabId: (filter: ChannelFilter) => string;
}>) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const moveTab = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = {
      ArrowLeft: (index + FILTERS.length - 1) % FILTERS.length,
      ArrowRight: (index + 1) % FILTERS.length,
      End: FILTERS.length - 1,
      Home: 0,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    onChange(FILTERS[next].id);
    tabRefs.current[next]?.focus();
  };
  return (
    <div aria-label="Team activity" className="team-tabs" inert={inert} role="tablist">
      {FILTERS.map(({ id, label }, index) => (
        <button
          aria-controls={panelId}
          aria-selected={filter === id}
          className={filter === id ? 'on' : ''}
          data-testid={`team-filter-${id}`}
          id={tabId(id)}
          key={id}
          onClick={() => onChange(id)}
          onKeyDown={(event) => moveTab(event, index)}
          ref={(node) => { tabRefs.current[index] = node; }}
          role="tab"
          tabIndex={filter === id ? 0 : -1}
          type="button"
        >
          {label} <b>{countVisible(history, id)}</b>
        </button>
      ))}
    </div>
  );
}

export function TeamChannel({ run }: Readonly<{ run: TeamRun }>) {
  const id = useId();
  const [filter, setFilter] = useState<ChannelFilter>('all');
  const decision = activeDecision(run);
  const history = useMemo(() => historyItems(run, decision?.id), [decision?.id, run]);
  const segments = useMemo(() => feedSegments(run, history, (item) => matches(item, filter))
    .filter((segment) => filter === 'all' || segment.blocks.length + segment.pinned.length > 0), [filter, history, run]);
  const { contentRef, follow, onScroll, streamRef, unread } = useStreamFollow(countVisible(history, filter), filter);
  const { bodyRef, dockRef } = useDockHeight();
  const sheet = useDecisionSheet(decision?.id);
  const announcement = useErrorAnnouncement(run);
  useFocusAfterDecision(bodyRef, decision?.id);
  const tabId = (filterId: ChannelFilter) => `${id}-${filterId}`;

  return (
    <div className="team-channel" data-testid="team-channel">
      <FilterTabs filter={filter} history={history} inert={sheet.open} onChange={setFilter} panelId={`${id}-panel`} tabId={tabId} />
      <p aria-live="polite" className="team-sr">{announcement}</p>
      <div className="team-channel-body" ref={bodyRef}>
        <div aria-labelledby={tabId(filter)} className="team-stream" id={`${id}-panel`} inert={sheet.open} onScroll={onScroll} ref={streamRef} role="tabpanel" tabIndex={0}>
          <div className="team-feed" ref={contentRef}>
            {decision?.kind !== 'duel-winner' && <TeamDuelCandidates run={run} />}
            <div aria-label="Team activity updates" className="team-log" role="log">
              <TeamFeed run={run} segments={segments} />
            </div>
            {segments.length === 0 && <p className="team-empty-note">{emptyMessage(run, filter)}</p>}
            {run.error && <TeamRecoveryCard error={run.error} run={run} />}
          </div>
        </div>
        {unread > 0 && (
          <button className="team-new-pill" onClick={follow} type="button">
            <ArrowDown aria-hidden="true" />{unread} new
          </button>
        )}
        <div className="team-dock" ref={dockRef}>
          <NextActionDock run={run} sheet={sheet} />
          <TeamComposer onSent={follow} run={run} />
        </div>
      </div>
    </div>
  );
}
