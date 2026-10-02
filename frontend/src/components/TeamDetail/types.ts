import { Team } from '../../types';

export interface Terminal {
  id: string;
  name: string;
  status: 'active' | 'inactive';
  lastOutput: string;
}

export interface TeamDetailProps {
  team: Team;
  onUpdate: () => void;
}

export interface TeamHeaderProps {
  team: Team;
  teamStatus: string;
  orchestratorSessionActive: boolean;
  onStartTeam: () => void;
  onStopTeam: () => void;
  onViewTerminal: () => void;
  onDeleteTeam: () => void;
  onEditTeam: () => void;
  /** Navigate to this team's conversation in the consolidated chat. */
  onOpenChat?: () => void;
  /** Navigate to this team's wiki vault. */
  onOpenWiki?: () => void;
  isStoppingTeam?: boolean;
  isStartingTeam?: boolean;
  /**
   * The team's goal sentence: its first active goal (or null when it has
   * none, which shows "No goal yet … Set a goal"). Undefined while loading.
   */
  goal?: { id: string; objective: string } | null;
  /** How many more goals the team owns besides `goal` */
  moreGoals?: number;
  /** Open a goal page */
  onOpenGoal?: (goalId: string) => void;
  /** Create a goal ("Set a goal") */
  onSetGoal?: () => void;
  /** Open the project picker (in the "More" section) */
  onChangeProject?: () => void;
}

export interface TeamStatsProps {
  team: Team;
  teamStatus: string;
  projectName: string | null;
}

export interface TeamDescriptionProps {
  description?: string;
}

export interface AddMemberFormProps {
  isVisible: boolean;
  onToggle: () => void;
  onAdd: (member: { name: string; role: string }) => void;
  onCancel: () => void;
  isOrchestratorTeam: boolean;
}

export interface NewMember {
  name: string;
  role: string;
}

export type TeamStatus = 'active' | 'idle';
