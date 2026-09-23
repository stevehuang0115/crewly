import React from 'react';
import { Tooltip, IconButton } from '@crewly/ui';
import { RefreshCw, Trash2 } from 'lucide-react';

export const OnIconButtons = () => (
  <div className="flex items-center gap-6 pt-10 pb-2 px-10">
    <Tooltip content="Restart agent" open><IconButton icon={RefreshCw} aria-label="Restart" variant="outline" /></Tooltip>
    <Tooltip content="Delete team" side="right" open><IconButton icon={Trash2} aria-label="Delete" variant="danger" /></Tooltip>
  </div>
);
