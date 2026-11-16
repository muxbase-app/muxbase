import { ChevronDown, type LucideIcon } from 'lucide-react';
import type { ReactNode, Ref } from 'react';

export interface TeamDisclosureState {
  attention: boolean;
  detailsRef: Ref<HTMLDetailsElement>;
  onToggle: (open: boolean) => void;
  open: boolean;
}

export function TeamLaunchDisclosure({ aside, attention, children, detailsRef, icon: Icon, onToggle, open, summary, testId, title }: Readonly<TeamDisclosureState & {
  aside?: ReactNode; children: ReactNode; icon: LucideIcon; summary: string; testId: string; title: string;
}>) {
  return (
    <details className="team-disclosure" data-testid={testId} onToggle={(event) => onToggle(event.currentTarget.open)} open={open} ref={detailsRef}>
      <summary>
        <Icon aria-hidden="true" className="team-disclosure-icon" />
        <span className="team-disclosure-title">{title}</span>
        {aside}
        <span className="team-disclosure-summary">{summary}</span>
        {attention && <span className="team-disclosure-flag">Needs attention</span>}
        <ChevronDown aria-hidden="true" className="team-disclosure-chevron" />
      </summary>
      <div className="team-disclosure-body">{children}</div>
    </details>
  );
}
