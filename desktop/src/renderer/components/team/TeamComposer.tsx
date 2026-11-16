import { ArrowUp } from 'lucide-react';
import { type FormEvent, type KeyboardEvent, useRef, useState } from 'react';
import type { TeamRun } from '../../../shared/team-types';
import { addTeamNote } from '../../api/team.api';
import { useNotificationStore } from '../../stores';
import { isRunLive } from './teamViewModel';

const PAUSED_HINTS: Partial<Record<TeamRun['status'], string>> = {
  failed: 'Notes are paused. This run ended with an error.',
  merged: 'Merged. Start a new run to continue.',
  ready: 'Ready for your review. Inspect changes, then merge when ready.',
  stopped: 'Stopped. Writer work is preserved.',
  stopping: 'Stopping agents and checks. Writer work is preserved.',
};

function NoteForm({ onSent, run }: Readonly<{ onSent: () => void; run: TeamRun }>) {
  const addToast = useNotificationStore((s) => s.addToast);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);

  const send = async () => {
    const text = note.trim();
    if (!text || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    try {
      const response = await addTeamNote({ runId: run.id, text });
      if (response.success) {
        setNote('');
        onSent();
      } else {
        addToast(response.error ?? 'Could not send your note', 'error');
      }
    } catch (error) {
      addToast(`Could not send your note: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void send();
  };

  const sendOnEnter = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  };

  return (
    <form className="team-note-composer" onSubmit={submit}>
      <textarea
        aria-label="Message the team"
        aria-busy={sending}
        data-testid="team-note-input"
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={sendOnEnter}
        placeholder="Message the team…"
        readOnly={sending}
        rows={1}
        value={note}
      />
      <div className="team-note-bar">
        <span className="team-composer-hint">Notes reach agents at their next turn</span>
        <button aria-label="Send note" className="team-send" disabled={sending || !note.trim()} type="submit">
          <ArrowUp aria-hidden="true" />
        </button>
      </div>
    </form>
  );
}

export function TeamComposer({ onSent, run }: Readonly<{ onSent: () => void; run: TeamRun }>) {
  if (isRunLive(run) && run.status !== 'stopping') return <NoteForm onSent={onSent} run={run} />;
  return (
    <div className="team-note-composer paused">
      <p className="team-composer-hint">{PAUSED_HINTS[run.status] ?? 'This run is not accepting notes.'}</p>
    </div>
  );
}
