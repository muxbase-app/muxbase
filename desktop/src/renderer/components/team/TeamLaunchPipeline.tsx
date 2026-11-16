import type { AgentName } from 'muxbase/core';
import { ChevronRight, FlaskConical, GitMerge, type LucideIcon, MousePointerClick, Scale } from 'lucide-react';
import { Fragment } from 'react';
import type { TeamMode } from '../../../shared/team-settings';
import type { TeamPolicy } from '../../../shared/team-types';
import { formatAgentLabel } from '../../lib/formatters';
import { AgentBrandIcon } from '../shared/agent-brand-icons';

interface PipelineStep {
  agents?: Array<AgentName | undefined>;
  human?: boolean;
  icon?: LucideIcon;
  label: string;
}

export interface TeamPipelinePlan {
  councilReviewers: AgentName[];
  mode: TeamMode;
  policy: TeamPolicy;
  reviewer?: AgentName;
  secondWriter?: AgentName;
  writer?: AgentName;
}

const CHECKS: PipelineStep = { icon: FlaskConical, label: 'Checks' };
const MERGE: PipelineStep = { human: true, icon: GitMerge, label: 'You merge' };

function pipelineSteps(plan: TeamPipelinePlan): PipelineStep[] {
  if (plan.mode === 'duel') {
    return [
      { agents: [plan.writer, plan.secondWriter], label: 'Both build' },
      CHECKS,
      { agents: [plan.reviewer], icon: Scale, label: 'Compares' },
      { human: true, icon: MousePointerClick, label: 'You pick' },
      { agents: [plan.reviewer], label: 'Reviews' },
      MERGE,
    ];
  }
  const build: PipelineStep[] = [{ agents: [plan.writer], label: 'Writes' }, CHECKS, { agents: [plan.reviewer], label: 'Reviews' }, MERGE];
  if (plan.mode === 'pair') return build;
  const design: PipelineStep[] = [{ agents: [plan.writer, ...plan.councilReviewers], label: `${plan.councilReviewers.length + 1} roles debate` }];
  if (plan.policy === 'every-gate') design.push({ human: true, icon: MousePointerClick, label: 'You approve' });
  return [...design, ...build];
}

function StepAvatar({ step }: Readonly<{ step: PipelineStep }>) {
  const agents = step.agents?.filter((agent): agent is AgentName => Boolean(agent)) ?? [];
  if (agents.length > 0) {
    return (
      <span className="team-pipe-avatars">
        {agents.map((agent, index) => <span className="team-pipe-avatar" key={`${agent}-${index}`}><AgentBrandIcon agent={agent} size="sm" /></span>)}
      </span>
    );
  }
  const Icon = step.icon;
  return Icon ? <span className="team-pipe-avatar"><Icon aria-hidden="true" /></span> : null;
}

function stepTitle(step: PipelineStep): string {
  const agents = step.agents?.filter(Boolean).map((agent) => formatAgentLabel(agent)) ?? [];
  return agents.length > 0 ? `${agents.join(' and ')}: ${step.label}` : step.label;
}

export function TeamLaunchPipeline({ plan }: Readonly<{ plan: TeamPipelinePlan }>) {
  const steps = pipelineSteps(plan);
  return (
    <ol aria-label="What happens when you start" className="team-pipe" data-testid="team-pipeline">
      {steps.map((step, index) => (
        <Fragment key={`${step.label}-${index}`}>
          {index > 0 && <li aria-hidden="true" className="team-pipe-arrow"><ChevronRight /></li>}
          <li className={step.human ? 'team-pipe-step human' : 'team-pipe-step'} style={{ animationDelay: `${index * 45}ms` }} title={stepTitle(step)}>
            <StepAvatar step={step} />
            <span>{step.label}</span>
          </li>
        </Fragment>
      ))}
    </ol>
  );
}
