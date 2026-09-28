import { Project, Team } from '../../types';

export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'folder';
  icon: string;
  children?: FileTreeNode[];
}

export interface ProjectDetailState {
  project: Project | null;
  assignedTeams: Team[];
  /** Open (not cancelled) project tickets */
  ticketCount: number;
  loading: boolean;
  error: string | null;
}

export interface AlignmentStatus {
  hasAlignmentIssues: boolean;
  alignmentFilePath: string | null;
  content: string | null;
}

export interface ProjectStats {
  totalFiles: number;
  totalDirectories: number;
  hasInitialGoalMd: boolean;
  hasInitialUserJourneyMd: boolean;
  specFiles: string[];
}

export type TabType = 'detail' | 'editor' | 'tasks' | 'teams';

export interface BuildSpecsWorkflowStep {
  id: number;
  name: string;
  delayMinutes: number;
  status: 'pending' | 'scheduled' | 'completed';
  scheduledAt?: Date;
}

export interface BuildSpecsWorkflow {
  isActive: boolean;
  steps: BuildSpecsWorkflowStep[];
}

export interface DetailViewProps {
  project: Project;
  onAddGoal: () => void;
  onEditGoal: () => void;
  onAddUserJourney: () => void;
  onEditUserJourney: () => void;
  onBuildSpecs: () => void;
  buildSpecsWorkflow: BuildSpecsWorkflow;
  alignmentStatus: AlignmentStatus;
  onContinueWithMisalignment: () => void;
  onViewAlignment: () => void;
  selectedBuildSpecsTeam: string;
  setSelectedBuildSpecsTeam: (value: string) => void;
  availableTeams: any[];
}

// EditorView specific types
export interface EditorViewProps {
  project: Project;
  selectedFile: string | null;
  onFileSelect: (file: string | null) => void;
  setIsMarkdownEditorOpen: (open: boolean) => void;
}

export interface FileTreeViewProps {
  files: FileTreeNode[];
  selectedFile: string | null;
  expandedFolders: Set<string>;
  onFileSelect: (path: string | null) => void;
  onToggleFolder: (path: string) => void;
  level?: number;
}

export interface FileLoadingState {
  fileContent: string;
  loadingFile: boolean;
  fileError: string | null;
}

export interface ProjectFilesState {
  projectFiles: FileTreeNode[];
  expandedFolders: Set<string>;
}

// TeamsView specific types
export interface TeamsViewProps {
  assignedTeams: Team[];
  onUnassignTeam: (teamId: string, teamName: string) => void;
  openTerminalWithSession: (sessionName: string) => void;
  onAssignTeam?: () => void;
  projectName?: string;
  onViewTeam?: (teamId: string) => void;
  onEditTeam?: (teamId: string) => void;
}

