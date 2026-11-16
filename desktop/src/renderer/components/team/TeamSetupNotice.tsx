import { Plug } from 'lucide-react';
import { useState } from 'react';
import { useElectronSettingsStore } from '../../stores/electron-settings.store';

export function TeamSetupNotice() {
  const update = useElectronSettingsStore((s) => s.update);
  const [enabling, setEnabling] = useState(false);

  const enable = async () => {
    setEnabling(true);
    await update('enableAgentLifecycleAdapters', true);
    setEnabling(false);
  };

  return (
    <section aria-label="Team setup" className="team-setup">
      <Plug aria-hidden="true" className="team-setup-icon" />
      <p>
        <b>Let Team see when agents are ready.</b>{' '}
        Installs local lifecycle hooks for supported agents. No prompt or tool content is recorded.
      </p>
      <button className="team-primary" data-testid="team-enable-adapters" disabled={enabling} onClick={() => void enable()} type="button">
        {enabling ? 'Enabling…' : 'Enable'}
      </button>
    </section>
  );
}
