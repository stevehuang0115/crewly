import React from 'react';
import { CollapsibleSection } from '@crewly/ui';

export const Advanced = () => (
  <div className="w-[560px]">
    <CollapsibleSection title="Advanced" summary="Probe interval, per-agent chains">
      <p className="text-sm text-text-2">Advanced runtime settings live here.</p>
    </CollapsibleSection>
  </div>
);

export const Open = () => (
  <div className="w-[560px]">
    <CollapsibleSection title="More" defaultOpen>
      <p className="text-sm text-text-2">Cron jobs, feed and team settings.</p>
    </CollapsibleSection>
  </div>
);
