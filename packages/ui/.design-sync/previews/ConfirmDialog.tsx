import React from 'react';
import { ConfirmDialog } from '@crewly/ui';

export const Warning = () => (
  <div className="h-[460px]">
  <ConfirmDialog
    isOpen
    onConfirm={() => {}}
    onCancel={() => {}}
    type="warning"
    title="Restart orchestrator?"
    message="Messages in flight are re-delivered after it comes back."
    confirmText="Restart"
  />
  </div>
);
