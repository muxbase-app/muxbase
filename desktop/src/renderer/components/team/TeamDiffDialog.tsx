import type { MuxBasePane } from 'muxbase/core';
import { LazyGitDiffView } from '../pane-detail/LazyGitDiffView';
import { ModalSurface } from '../shared/ModalSurface';

export function TeamDiffDialog({ description, onClose, open, pane, title }: Readonly<{
  description: string; onClose: () => void; open: boolean; pane?: MuxBasePane; title: string;
}>) {
  return (
    <ModalSurface label={title} onClose={onClose} open={open && Boolean(pane)} panelClassName="team-diff-panel">
      <header>
        <div><h2>{title}</h2><p>{description}</p></div>
        <button aria-label="Close diff" className="team-ghost" onClick={onClose} type="button">Close</button>
      </header>
      <div className="team-diff-content">{open && pane && <LazyGitDiffView pane={pane} />}</div>
    </ModalSurface>
  );
}
