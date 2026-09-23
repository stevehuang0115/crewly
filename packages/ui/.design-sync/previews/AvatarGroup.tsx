import React from 'react';
import { AvatarGroup } from '@crewly/ui';

const team = ['Ella', 'Atlas', 'Leo', 'Max', 'Nova', 'Sam'].map((name) => ({ name }));

export const Team = () => <AvatarGroup avatars={team} max={4} size="md" />;
export const Small = () => <AvatarGroup avatars={team.slice(0, 3)} size="sm" />;
