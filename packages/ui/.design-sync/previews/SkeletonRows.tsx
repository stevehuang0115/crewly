import React from 'react';
import { SkeletonRows } from '@crewly/ui';

export const ThreeRows = () => <div className="w-[480px]"><SkeletonRows /></div>;
export const FiveRows = () => <div className="w-[480px]"><SkeletonRows count={5} /></div>;
