import React, { useState } from 'react';
import { UnderlineTabs } from '@crewly/ui';

export const Settings = () => {
  const [tab, setTab] = useState('runtimes');
  return (
    <div className="w-[760px]">
      <UnderlineTabs
        value={tab}
        onChange={setTab}
        aria-label="Settings sections"
        tabs={[
          { value: 'general', label: 'General' },
          { value: 'runtimes', label: 'Runtimes' },
          { value: 'roles', label: 'Roles' },
          { value: 'api-keys', label: 'API Keys' },
          { value: 'credentials', label: 'Credentials' },
          { value: 'cloud', label: 'Cloud & devices' },
          { value: 'security', label: 'Security' },
          { value: 'system', label: 'System' },
        ]}
      />
    </div>
  );
};

export const WithCounts = () => (
  <div className="w-[520px]">
    <UnderlineTabs
      value="board"
      onChange={() => {}}
      tabs={[
        { value: 'board', label: 'Board', count: 12 },
        { value: 'requests', label: 'Requests', count: 4 },
        { value: 'runs', label: 'Runs', count: 2, attention: true },
      ]}
    />
  </div>
);
