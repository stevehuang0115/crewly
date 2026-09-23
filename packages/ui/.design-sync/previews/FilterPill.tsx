import React from 'react';
import { FilterPill } from '@crewly/ui';

export const Row = () => (
  <div className="flex gap-2">
    <FilterPill isActive onClick={() => {}} count={12}>All</FilterPill>
    <FilterPill isActive={false} onClick={() => {}} count={4}>Running</FilterPill>
    <FilterPill isActive={false} onClick={() => {}} count={2}>Blocked</FilterPill>
    <FilterPill isActive={false} onClick={() => {}} disabled>Archived</FilterPill>
  </div>
);
