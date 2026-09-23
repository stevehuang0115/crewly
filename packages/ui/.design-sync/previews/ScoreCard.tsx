import React from 'react';
import { ScoreCard } from '@crewly/ui';

export const Dashboard = () => (
  <div className="w-56"><ScoreCard label="Active agents" value={7} /></div>
);

export const Clickable = () => (
  <div className="w-56"><ScoreCard label="Waiting for approval" value={2} isClickable onClick={() => {}} /></div>
);

export const CustomValue = () => (
  <div className="w-56">
    <ScoreCard label="Spend this month">
      <span>$14.20 <span className="text-sm text-text-secondary-dark font-normal">of $50</span></span>
    </ScoreCard>
  </div>
);
