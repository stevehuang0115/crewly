/**
 * CrewNowSection — "Your crew right now" on the Dashboard
 * (specs/2026-10-02-ui-redesign.md, Dashboard).
 *
 * One line per working agent ("Owen · CE — working on CE-81 …"), each
 * opening that agent's chat; the first five show, then "Show all N".
 * Agents that are up but idle share one quiet line. Stopped agents are on
 * the Teams page ("All agents").
 *
 * @module components/Dashboard/CrewNowSection
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { ShowAll } from '@crewly/ui/ShowAll';
import { ROUTES } from '@/constants/routes.constants';
import { agentChatLink } from '@/utils/team-chat.utils';
import type { CrewSnapshot } from './dashboard.utils';

/** Working agents visible before "Show all N". */
export const CREW_VISIBLE = 5;

/** Idle names listed before "+N". */
export const IDLE_NAMES_SHOWN = 8;

/**
 * The idle line ("6 idle — Sam, Max, Pia").
 *
 * @param names - Idle agent names
 * @returns One line, or null when nobody is idle
 */
export function idleLine(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  const shown = names.slice(0, IDLE_NAMES_SHOWN).join(', ');
  const rest = names.length - IDLE_NAMES_SHOWN;
  return `${names.length} idle — ${shown}${rest > 0 ? ` and ${rest} more` : ''}`;
}

/** Props of {@link CrewNowSection}. */
export interface CrewNowSectionProps {
  crew: CrewSnapshot;
}

/**
 * The crew section.
 *
 * @param props - {@link CrewNowSectionProps}
 * @returns Section
 */
export const CrewNowSection: React.FC<CrewNowSectionProps> = ({ crew }) => {
  const idle = idleLine(crew.idle);
  return (
    <section aria-labelledby="crew-now-title" data-testid="crew-now">
      <div className="flex items-baseline justify-between gap-4 px-4 pb-2">
        <h2 id="crew-now-title" className="text-lg font-extrabold text-text">Your crew right now</h2>
        <Link to={ROUTES.teams} className="text-sm font-bold text-primary-text no-underline hover:text-text">
          All agents
        </Link>
      </div>
      {crew.working.length === 0 ? (
        <p className="border-t border-border-soft px-4 py-3 text-[13px] text-text-2">Nobody is working right now.</p>
      ) : (
        <ShowAll as="ul" limit={CREW_VISIBLE} showLessLabel="Show fewer" className="m-0 p-0" data-testid="crew-now-list">
          {crew.working.map((c) => (
            <li key={c.session} className="list-none border-t border-border-soft">
              <Link
                to={agentChatLink(c.session)}
                className="block truncate rounded-[var(--crewly-radius-sm)] px-4 py-3 text-[15px] leading-[22px] text-text no-underline transition-colors hover:bg-surface"
                data-testid={`crew-${c.session}`}
              >
                <span className="font-semibold">{c.name}</span>
                <span className="text-text-2"> · {c.team} — {c.doing ?? 'working'}</span>
              </Link>
            </li>
          ))}
        </ShowAll>
      )}
      {idle && <p className="border-t border-border-soft px-4 py-3 text-[13px] text-text-2" data-testid="crew-idle">{idle}</p>}
    </section>
  );
};

export default CrewNowSection;
