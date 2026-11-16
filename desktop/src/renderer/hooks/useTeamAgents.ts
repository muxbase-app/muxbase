import type { AgentName } from 'muxbase/core';
import { useCallback, useEffect, useState } from 'react';
import { listAgents } from '../api/agent.api';

export function useTeamAgents() {
  const [catalog, setCatalog] = useState<{ all: AgentName[]; error: string | null; loading: boolean; readers: AgentName[] }>({
    all: [], error: null, loading: true, readers: [],
  });
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => {
    setCatalog((current) => ({ ...current, error: null, loading: true }));
    setAttempt((value) => value + 1);
  }, []);
  useEffect(() => {
    let disposed = false;
    void Promise.all([listAgents(), listAgents('review')]).then(([all, readers]) => {
      if (!disposed) setCatalog({ all, error: null, loading: false, readers });
    }).catch((error: unknown) => {
      if (!disposed) setCatalog({
        all: [], error: error instanceof Error ? error.message : String(error), loading: false, readers: [],
      });
    });
    return () => { disposed = true; };
  }, [attempt]);
  return { ...catalog, reload };
}
