import { Landmark, type LucideIcon, Swords, UsersRound } from 'lucide-react';
import { motion } from 'motion/react';
import { type KeyboardEvent, useRef } from 'react';
import type { TeamMode } from '../../../shared/team-settings';
import { TEAM_MODE_OPTIONS } from './teamModeOptions';

const STEP: Partial<Record<string, number>> = { ArrowDown: 1, ArrowLeft: -1, ArrowRight: 1, ArrowUp: -1 };
const SPRING = { bounce: 0.18, duration: 0.45, type: 'spring' } as const;
const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const MODE_ICONS: Record<TeamMode, LucideIcon> = { council: Landmark, duel: Swords, pair: UsersRound };

export function TeamModePicker({ disabled, onChange, value }: Readonly<{ disabled?: boolean; onChange: (mode: TeamMode) => void; value: TeamMode }>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = STEP[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const next = (index + step + TEAM_MODE_OPTIONS.length) % TEAM_MODE_OPTIONS.length;
    onChange(TEAM_MODE_OPTIONS[next].value);
    refs.current[next]?.focus();
  };
  return (
    <div aria-label="Team mode" className="team-modes" role="radiogroup">
      {TEAM_MODE_OPTIONS.map((option, index) => {
        const Icon = MODE_ICONS[option.value];
        const selected = option.value === value;
        return (
          <button
            aria-checked={selected}
            className={selected ? 'on' : ''}
            data-testid={`team-mode-${option.value}`}
            disabled={disabled}
            key={option.value}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => move(event, index)}
            ref={(node) => { refs.current[index] = node; }}
            role="radio"
            tabIndex={selected ? 0 : -1}
            title={option.tagline}
            type="button"
          >
            {selected && <motion.span className="team-mode-indicator" layoutId="team-mode-indicator" transition={prefersReducedMotion() ? { duration: 0 } : SPRING} />}
            <Icon aria-hidden="true" className="team-mode-icon" />
            <span className="team-mode-text">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
