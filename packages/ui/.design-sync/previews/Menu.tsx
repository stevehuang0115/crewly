import React from 'react';
import { Menu, Button } from '@crewly/ui';
import { ChevronDown, Pencil, Copy, Trash2 } from 'lucide-react';

export const Open = () => (
  <div className="h-56 flex justify-end w-80">
    <Menu
      defaultOpen
      trigger={<Button variant="secondary" size="sm" icon={ChevronDown} iconPosition="right">Actions</Button>}
      items={[
        { label: 'Rename', icon: Pencil, onSelect: () => {} },
        { label: 'Duplicate', icon: Copy, onSelect: () => {} },
        { label: 'Delete team', icon: Trash2, onSelect: () => {}, danger: true, separator: true },
      ]}
    />
  </div>
);
