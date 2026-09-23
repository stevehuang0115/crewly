import React from 'react';
import { ConfirmPopup } from '@crewly/ui';

export const DeleteTeam = () => (
  <div className="h-[460px]">
  <ConfirmPopup
    isOpen
    onClose={() => {}}
    onConfirm={() => {}}
    title="Delete Growth team?"
    message="Its three agents stop and their Slack apps are removed. Tasks and files stay."
    confirmText="Delete"
    confirmVariant="danger"
  />
  </div>
);
