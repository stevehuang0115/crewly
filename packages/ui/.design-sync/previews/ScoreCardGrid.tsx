import React from 'react';
import { ScoreCard, ScoreCardGrid } from '@crewly/ui';

export const Horizontal = () => (
  <div className="w-full">
    <ScoreCardGrid variant="horizontal">
      <ScoreCard label="Teams" value={4} />
      <ScoreCard label="Active agents" value={7} />
      <ScoreCard label="Open tasks" value={23} />
      <ScoreCard label="Done this week" value={41} />
    </ScoreCardGrid>
  </div>
);
