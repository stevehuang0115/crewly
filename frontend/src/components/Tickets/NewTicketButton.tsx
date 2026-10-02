/**
 * NewTicketButton — the Tickets page's "New ticket" action. Opens the
 * New ticket form (a project ticket); projects and teams load when it opens.
 *
 * @module components/Tickets/NewTicketButton
 */

import React, { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@crewly/ui/Button';
import type { Team } from '../../types';
import { apiService } from '../../services/api.service';
import { TICKET_BOARD_TEXT } from '../../constants/tickets.constants';
import { ProjectTicketDialog } from './ProjectTicketDialog';
import type { BoardProject } from './board.utils';

/** Props for {@link NewTicketButton}. */
export interface NewTicketButtonProps {
  /** Called after a ticket was created */
  onCreated: () => void;
}

/**
 * Render the button and its form.
 *
 * @param props - {@link NewTicketButtonProps}
 * @returns The button
 */
export const NewTicketButton: React.FC<NewTicketButtonProps> = ({ onCreated }) => {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<BoardProject[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);

  const handleOpen = (): void => {
    setOpen(true);
    void Promise.resolve()
      .then(() => apiService.getProjects())
      .then((p) => setProjects((p ?? []).map((x) => ({ id: x.id, name: x.name }))))
      .catch(() => setProjects([]));
    void Promise.resolve()
      .then(() => apiService.getTeams())
      .then((t) => setTeams(t ?? []))
      .catch(() => setTeams([]));
  };

  return (
    <>
      <Button size="sm" icon={Plus} onClick={handleOpen} data-testid="tickets-new-ticket">
        {TICKET_BOARD_TEXT.NEW_TICKET}
      </Button>
      <ProjectTicketDialog
        open={open}
        ticket={null}
        projects={projects}
        teams={teams}
        onClose={() => setOpen(false)}
        onSaved={onCreated}
      />
    </>
  );
};
