import type { AgentName } from 'muxbase/core';
import { UsersRound } from 'lucide-react';
import { formatAgentLabel } from '../../lib/formatters';
import { AgentBrandIcon } from '../shared/agent-brand-icons';
import { TeamAgentField } from './TeamAgentField';
import { TeamDuelWriterFields } from './TeamDuelWriterFields';
import { type TeamDisclosureState, TeamLaunchDisclosure } from './TeamLaunchDisclosure';
import { TeamLaunchPipeline } from './TeamLaunchPipeline';
import { hasDistinctDuelSides, presentAgents, type RosterRow } from './teamLaunchModel';
import { TEAM_MODE_COPY } from './teamModeOptions';
import { ROLE_COPY, TeamRoster } from './TeamRoster';
import type { TeamLaunchDraft } from './useTeamLaunchDraft';

interface TeamCatalog {
  all: AgentName[];
  readers: AgentName[];
}

interface TeamMemberFieldsProps {
  catalog: TeamCatalog;
  domain: string;
  draft: TeamLaunchDraft;
  onDomainChange: (domain: string) => void;
  onDraftChange: (draft: TeamLaunchDraft) => void;
  reviewer?: AgentName;
  reviewerOptions: AgentName[];
}

type TeamLaunchTeamProps = TeamMemberFieldsProps & TeamDisclosureState;

const label = (agent?: AgentName) => (agent ? formatAgentLabel(agent) : 'No agent');
const enabledRows = (draft: TeamLaunchDraft) => draft.rows.filter((row) => row.enabled);
const councilReviewers = (draft: TeamLaunchDraft) => enabledRows(draft).filter((row) => row.role !== 'developer').map((row) => row.agent);
const councilWriter = (draft: TeamLaunchDraft) => draft.rows.find((row) => row.role === 'developer')?.agent;
const rowAgents = (row: RosterRow, catalog: TeamCatalog) => (row.role === 'developer' ? catalog.all : catalog.readers);

function teamLineup(draft: TeamLaunchDraft, reviewer?: AgentName): { agents: AgentName[]; summary: string } {
  if (draft.mode === 'council') {
    const reviewers = councilReviewers(draft).length;
    return { agents: enabledRows(draft).map((row) => row.agent), summary: `${label(councilWriter(draft))} writes · ${reviewers} ${reviewers === 1 ? 'reviewer' : 'reviewers'}` };
  }
  if (draft.mode === 'duel') {
    return { agents: presentAgents([draft.writer, draft.secondWriter, reviewer]), summary: `${label(draft.writer)} vs ${label(draft.secondWriter)} · ${label(reviewer)} compares` };
  }
  return { agents: presentAgents([draft.writer, reviewer]), summary: `${label(draft.writer)} writes · ${label(reviewer)} reviews` };
}

function councilWarnings(draft: TeamLaunchDraft, catalog: TeamCatalog): string[] {
  return enabledRows(draft)
    .filter((row) => !rowAgents(row, catalog).includes(row.agent))
    .map((row) => `${ROLE_COPY[row.role].name}: ${label(row.agent)} is not available. Choose another agent.`);
}

function pairWarnings(draft: TeamLaunchDraft, catalog: TeamCatalog, reviewer?: AgentName): string[] {
  const warnings: string[] = [];
  if (draft.writer && !catalog.all.includes(draft.writer)) warnings.push(`Your saved writer ${label(draft.writer)} is not available. Install it or choose a writer for this run.`);
  if (draft.reviewer && !catalog.readers.includes(draft.reviewer)) warnings.push(`Your saved reviewer ${label(draft.reviewer)} is not available for read-only review. Install it or choose a reviewer for this run.`);
  if (draft.mode === 'duel' && !hasDistinctDuelSides(draft)) warnings.push('Choose different agents, models, or effort settings for the two writers.');
  if (!reviewer && draft.reviewer && catalog.readers.includes(draft.reviewer)) warnings.push('Install a different review-capable agent from the writer for independent review.');
  return warnings;
}

function AvatarStack({ agents }: Readonly<{ agents: AgentName[] }>) {
  return (
    <span aria-hidden="true" className="team-lineup">
      {agents.map((agent, index) => <span className="team-lineup-avatar" key={`${agent}-${index}`}><AgentBrandIcon agent={agent} size="sm" /></span>)}
    </span>
  );
}

function TeamMemberFields({ catalog, domain, draft, onDomainChange, onDraftChange, reviewer, reviewerOptions }: Readonly<TeamMemberFieldsProps>) {
  if (draft.mode === 'council') {
    const domainEnabled = draft.rows.some((row) => row.role === 'domain' && row.enabled);
    return (
      <>
        <TeamRoster all={catalog.all} onChange={(row) => onDraftChange({ ...draft, rows: draft.rows.map((item) => item.role === row.role ? row : item) })} readers={catalog.readers} rows={draft.rows} />
        {domainEnabled && (
          <label className="team-launch-section">
            <span className="team-launch-section-label">Domain</span>
            <input aria-label="Domain" className="team-field" onChange={(event) => onDomainChange(event.target.value)} placeholder="For example Payments" value={domain} />
          </label>
        )}
      </>
    );
  }
  return (
    <div className={draft.mode === 'duel' ? 'team-launch-agent-fields duel' : 'team-launch-agent-fields'}>
      {draft.mode === 'duel' ? <TeamDuelWriterFields agents={catalog.all} draft={draft} onChange={onDraftChange} />
        : <TeamAgentField agents={catalog.all} label="Writer" onChange={(writer) => onDraftChange({ ...draft, writer })} value={draft.writer} />}
      <TeamAgentField agents={reviewerOptions} label={draft.mode === 'duel' ? 'Comparator' : 'Reviewer'} onChange={(agent) => onDraftChange({ ...draft, reviewer: agent })} value={reviewer} />
      {reviewer && reviewer !== draft.reviewer && <p>Your saved reviewer matches a writer. This run uses {label(reviewer)} for independent review; defaults are unchanged.</p>}
    </div>
  );
}

export function TeamLaunchTeam({ attention, detailsRef, onToggle, open, ...fields }: Readonly<TeamLaunchTeamProps>) {
  const { catalog, draft, reviewer } = fields;
  const council = draft.mode === 'council';
  const lineup = teamLineup(draft, reviewer);
  const warnings = council ? councilWarnings(draft, catalog) : pairWarnings(draft, catalog, reviewer);
  return (
    <TeamLaunchDisclosure
      aside={<AvatarStack agents={lineup.agents} />} attention={attention || warnings.length > 0} detailsRef={detailsRef} icon={UsersRound}
      onToggle={onToggle} open={open} summary={lineup.summary} testId="team-config" title="Team"
    >
      <section className="team-launch-flow">
        <p className="team-disclosure-note">{TEAM_MODE_COPY[draft.mode]}</p>
        <TeamLaunchPipeline plan={{
          councilReviewers: council ? councilReviewers(draft) : [],
          mode: draft.mode, policy: draft.policy,
          reviewer: council ? councilReviewers(draft)[0] : reviewer,
          secondWriter: draft.secondWriter,
          writer: council ? councilWriter(draft) : draft.writer,
        }} />
      </section>
      <TeamMemberFields {...fields} />
      {warnings.map((warning) => <p className="team-disclosure-warning" key={warning} role="alert">{warning}</p>)}
    </TeamLaunchDisclosure>
  );
}
