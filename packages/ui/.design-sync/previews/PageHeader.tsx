import React from 'react';
import { PageHeader, UnderlineTabs, Button, OverflowMenu } from '@crewly/ui';
import { Plus, MoreHorizontal } from 'lucide-react';

export const WithTabs = () => (
  <div className="w-[880px]">
    <PageHeader
      title="Tickets"
      subtitle="Everything your crew is working on"
      actions={
        <>
          <Button icon={Plus} size="sm">New ticket</Button>
          <OverflowMenu icon={MoreHorizontal} label="More page actions" items={[{ label: 'Archived tickets', onClick: () => {} }]} />
        </>
      }
      tabs={
        <UnderlineTabs
          value="board"
          onChange={() => {}}
          tabs={[
            { value: 'board', label: 'Board' },
            { value: 'requests', label: 'Requests', count: 4 },
            { value: 'runs', label: 'Runs', count: 2, attention: true },
          ]}
        />
      }
    />
  </div>
);

export const DetailPage = () => (
  <div className="w-[880px]">
    <PageHeader
      eyebrow={<a href="#" className="text-primary-text">← Tickets</a>}
      title="CE-81 · Pricing page"
      subtitle="Atlas · Think Tank · updated 2h ago"
    />
  </div>
);
