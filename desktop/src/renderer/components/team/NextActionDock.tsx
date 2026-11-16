import { Hand, Scale, TriangleAlert } from 'lucide-react';
import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useCallback, useEffect, useId, useRef } from 'react';
import type { TeamDecision, TeamRound, TeamRun } from '../../../shared/team-types';
import { wrapTabFocus } from '../shared/ModalSurface';
import { TeamDecisionCard } from './TeamDecisionCard';
import { TeamFinalCard } from './TeamFinalCard';
import { activeDecision, isFailureDecision, openRound, pendingRoles, roleName, roundQuestion } from './teamViewModel';

const NAMES = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });
const OPEN_MODAL_SELECTOR = '[role="dialog"][aria-modal="true"]';

export interface DecisionSheet {
  onClose: () => void;
  onOpen: () => void;
  open: boolean;
}

function Dock({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <section aria-label="Next action" className="team-next-action" data-testid="team-next-action" tabIndex={-1}>
      {children}
    </section>
  );
}

function isTyping(element: Element | null): boolean {
  return element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement;
}

function isComposerTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.team-note-composer') !== null;
}

function hasOtherModal(sheet: HTMLElement | null): boolean {
  return [...document.querySelectorAll(OPEN_MODAL_SELECTOR)].some((element) => element !== sheet);
}

function trapTab(event: ReactKeyboardEvent<HTMLDivElement>): void {
  if (event.key === 'Tab' && !hasOtherModal(event.currentTarget)) wrapTabFocus(event.currentTarget, event.nativeEvent);
}

function decisionIcon(run: TeamRun, decision: TeamDecision): ReactNode {
  if (decision.kind === 'duel-winner') return <Scale />;
  return isFailureDecision(run, decision) ? <TriangleAlert /> : <Hand />;
}

function DecisionDock({ decision, run, sheet }: Readonly<{ decision: TeamDecision; run: TeamRun; sheet: DecisionSheet }>) {
  const sheetId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const { onClose, onOpen, open } = sheet;
  const close = useCallback(() => {
    onClose();
    triggerRef.current?.focus();
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;
    if (!isTyping(document.activeElement)) sheetRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isComposerTarget(event.target) && !hasOtherModal(sheetRef.current)) close();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [close, open]);

  return (
    <Dock>
      {open && <div aria-hidden="true" className="team-scrim" onClick={close} />}
      <div
        aria-label={decision.title}
        aria-modal={open ? true : undefined}
        className="team-sheet"
        hidden={!open}
        id={sheetId}
        onKeyDown={trapTab}
        ref={sheetRef}
        role="dialog"
        tabIndex={-1}
      >
        <TeamDecisionCard decision={decision} onClose={close} run={run} />
      </div>
      <div className={isFailureDecision(run, decision) ? 'team-bar danger' : 'team-bar attention'}>
        <span aria-hidden="true" className="team-bar-icon">{decisionIcon(run, decision)}</span>
        <div className="team-bar-text">
          <span className="team-bar-title">{decision.title}</span>
          <span className="team-bar-ctx">{decision.why}</span>
        </div>
        <div className="team-bar-actions">
          <button
            aria-controls={sheetId}
            aria-expanded={open}
            className="team-primary"
            onClick={open ? close : onOpen}
            ref={triggerRef}
            type="button"
          >
            {decision.kind === 'duel-winner' ? 'Compare and choose' : 'Decide'}
          </button>
        </div>
      </div>
    </Dock>
  );
}

function WorkingBar({ round, run }: Readonly<{ round: TeamRound; run: TeamRun }>) {
  const waiting = pendingRoles(round).map((role) => roleName(run, role));
  const progress = `Round ${round.number} in progress`;
  return (
    <div className="team-bar working">
      <span aria-hidden="true" className="team-bar-icon"><span className="team-spin" /></span>
      <div className="team-bar-text">
        <span className="team-bar-title">{waiting.length > 0 ? `${progress} · waiting for ${NAMES.format(waiting)}` : progress}</span>
        <span className="team-bar-ctx">{roundQuestion(round)}</span>
      </div>
    </div>
  );
}

export function NextActionDock({ run, sheet }: Readonly<{ run: TeamRun; sheet: DecisionSheet }>) {
  const decision = activeDecision(run);
  if (decision) return <DecisionDock decision={decision} key={decision.id} run={run} sheet={sheet} />;
  if (run.status === 'ready' || run.status === 'merged') return <Dock><TeamFinalCard run={run} /></Dock>;
  const round = openRound(run);
  if (round && (run.status === 'running' || run.status === 'starting')) return <Dock><WorkingBar round={round} run={run} /></Dock>;
  return null;
}
