import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { TeamRun } from '../../../shared/team-types';
import { useTeamStore } from '../../stores/team.store';
import type { DecisionSheet } from './NextActionDock';
import { recoveryCopy } from './teamViewModel';

const NEXT_FOCUS_SELECTORS = ['.team-next-action', '[data-testid="team-note-input"]'];

export function useDecisionSheet(decisionId: string | undefined): DecisionSheet {
  const markAutoOpened = useTeamStore((s) => s.markDecisionAutoOpened);
  const [openId, setOpenId] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (!decisionId || useTeamStore.getState().autoOpenedDecisionIds.includes(decisionId)) return;
    markAutoOpened(decisionId);
    setOpenId(decisionId);
  }, [decisionId, markAutoOpened]);

  const onOpen = useCallback(() => setOpenId(decisionId ?? null), [decisionId]);
  const onClose = useCallback(() => setOpenId(null), []);
  return { onClose, onOpen, open: Boolean(decisionId) && openId === decisionId };
}

export function useFocusAfterDecision(bodyRef: RefObject<HTMLDivElement | null>, decisionId: string | undefined): void {
  const previous = useRef(decisionId);

  useEffect(() => {
    const resolved = previous.current !== undefined && previous.current !== decisionId;
    previous.current = decisionId;
    const body = bodyRef.current;
    if (!resolved || !body || document.activeElement !== document.body) return;
    const target = NEXT_FOCUS_SELECTORS.map((selector) => body.querySelector<HTMLElement>(selector)).find(Boolean);
    target?.focus();
  }, [bodyRef, decisionId]);
}

export function useErrorAnnouncement(run: TeamRun): string {
  const [message, setMessage] = useState('');
  const previous = useRef(run.error);

  useEffect(() => {
    if (run.error && !previous.current) setMessage(`${recoveryCopy(run)[0]}. Details are at the end of the activity.`);
    if (!run.error) setMessage('');
    previous.current = run.error;
  }, [run]);

  return message;
}
