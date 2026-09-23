import React from 'react';
import { AlertDialog } from '@crewly/ui';

export const Success = () => (
  <div className="h-[460px]">
  <AlertDialog isOpen onClose={() => {}} type="success" title="Backup finished" message="Your workspace was backed up to Crewly Cloud." />
  </div>
);
