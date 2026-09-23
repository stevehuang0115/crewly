import React from 'react';
import { IconButton } from '@crewly/ui';
import { RefreshCw, Trash2, Settings, Play } from 'lucide-react';

export const Default = () => <IconButton icon={RefreshCw} aria-label="Refresh" />;

export const Variants = () => (
  <div className="flex items-center gap-3">
    <IconButton icon={Play} aria-label="Start" variant="primary" />
    <IconButton icon={Settings} aria-label="Settings" variant="secondary" />
    <IconButton icon={RefreshCw} aria-label="Refresh" variant="outline" />
    <IconButton icon={Settings} aria-label="Settings" variant="ghost" />
    <IconButton icon={Trash2} aria-label="Delete" variant="danger" />
  </div>
);
