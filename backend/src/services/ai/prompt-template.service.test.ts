import { PromptTemplateService, TaskAssignmentData } from './prompt-template.service';
import { readFile } from 'fs/promises';
import path from 'path';

// Mock dependencies
jest.mock('fs/promises');
jest.mock('path');

describe('PromptTemplateService', () => {
  let service: PromptTemplateService;
  const mockTaskData: TaskAssignmentData = {
    projectName: 'Test Project',
    projectPath: '/test/project',
    taskId: 'task-001',
    taskTitle: 'Test Task',
    taskDescription: 'This is a test task',
    taskPriority: 'high',
    taskMilestone: 'sprint-1'
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (path.join as jest.Mock).mockImplementation((...parts) => parts.join('/'));
    (process.cwd as jest.Mock) = jest.fn().mockReturnValue('/app');
    service = new PromptTemplateService();
  });

  describe('constructor', () => {
    it('should use default templates path if none provided', () => {
      expect(path.join).toHaveBeenCalledWith('/app', 'config', 'orchestrator_tasks', 'prompts');
    });

    it('should use custom templates path if provided', () => {
      const customPath = '/custom/templates';
      const customService = new PromptTemplateService(customPath);

      expect(customService).toBeDefined();
    });
  });

  describe('getOrchestratorTaskAssignmentPrompt', () => {
    const mockTemplate = `
Project: {projectName}
Path: {projectPath}
Task ID: {taskId}
Title: {taskTitle}
Description: {taskDescription}
Priority: {taskPriority}
Milestone: {taskMilestone}
    `;

    beforeEach(() => {
      (readFile as jest.Mock).mockResolvedValue(mockTemplate.trim());
    });

    it('should load and process orchestrator template', async () => {
      const result = await service.getOrchestratorTaskAssignmentPrompt(mockTaskData);

      expect(readFile).toHaveBeenCalledWith('/app/config/orchestrator_tasks/prompts/assign-task-orchestrator-prompt-template.md', 'utf-8');
      expect(result).toBe(`Project: Test Project
Path: /test/project
Task ID: task-001
Title: Test Task
Description: This is a test task
Priority: high
Milestone: sprint-1`);
    });

    it('should handle missing optional fields with defaults', async () => {
      const minimalData: TaskAssignmentData = {
        projectName: 'Test Project',
        projectPath: '/test/project',
        taskId: 'task-001',
        taskTitle: 'Test Task'
      };

      const result = await service.getOrchestratorTaskAssignmentPrompt(minimalData);

      expect(result).toContain('Description: No description provided');
      expect(result).toContain('Priority: medium');
      expect(result).toContain('Milestone: general');
    });

    it('should handle file read errors', async () => {
      (readFile as jest.Mock).mockRejectedValue(new Error('File not found'));

      await expect(service.getOrchestratorTaskAssignmentPrompt(mockTaskData))
        .rejects.toThrow('File not found');
    });

    it('should preserve existing values over defaults', async () => {
      const result = await service.getOrchestratorTaskAssignmentPrompt(mockTaskData);

      expect(result).toContain('Description: This is a test task');
      expect(result).toContain('Priority: high');
      expect(result).toContain('Milestone: sprint-1');
    });
  });

  describe('getTeamMemberTaskAssignmentPrompt', () => {
    const mockOrchestratorTemplate = `
Some orchestrator content
message: "📋 TASK ASSIGNMENT - {taskTitle}\\n\\n**Task File:** \\"{taskId}.md\\"\\n**Priority:** {taskPriority}"
More content after
    `;

    beforeEach(() => {
      (readFile as jest.Mock).mockResolvedValue(mockOrchestratorTemplate);
    });

    it('should extract and process team member message from orchestrator template', async () => {
      const result = await service.getTeamMemberTaskAssignmentPrompt(mockTaskData);

      expect(result).toContain('📋 TASK ASSIGNMENT - Test Task');
    });

    it('should unescape quotes in extracted message', async () => {
      const templateWithEscapedQuotes = `message: "Test message with \\"escaped quotes\\" here"`;
      (readFile as jest.Mock).mockResolvedValue(templateWithEscapedQuotes);

      const result = await service.getTeamMemberTaskAssignmentPrompt(mockTaskData);

      expect(result).toContain('Test message with');
    });

    it('should provide fallback template if extraction fails', async () => {
      const templateWithoutMessage = 'No message pattern found here';
      (readFile as jest.Mock).mockResolvedValue(templateWithoutMessage);

      const result = await service.getTeamMemberTaskAssignmentPrompt(mockTaskData);

      expect(result).toContain('📋 TASK ASSIGNMENT - Test Task');
      expect(result).toContain('**Ticket:** task-001 in `/test/project/.crewly/tickets/`');
      expect(result).toContain('**Priority:** high');
      expect(result).toContain("project-tickets claim --project '/test/project' --id task-001");
      expect(result).not.toContain('.crewly/tasks');
    });

    it('points at the project ticket even without a milestone', async () => {
      const dataWithoutMilestone = { ...mockTaskData, taskMilestone: undefined };
      const templateWithoutMessage = 'No message pattern found';
      (readFile as jest.Mock).mockResolvedValue(templateWithoutMessage);

      const result = await service.getTeamMemberTaskAssignmentPrompt(dataWithoutMilestone);

      expect(result).toContain("project-tickets show --project '/test/project' --id task-001");
    });

    it('should use default priority in fallback template', async () => {
      const dataWithoutPriority = { ...mockTaskData, taskPriority: undefined };
      const templateWithoutMessage = 'No message pattern found';
      (readFile as jest.Mock).mockResolvedValue(templateWithoutMessage);

      const result = await service.getTeamMemberTaskAssignmentPrompt(dataWithoutPriority);

      expect(result).toContain('**Priority:** medium');
    });

    it('should handle complex message patterns with multiline content', async () => {
      const complexTemplate = `
Some content before
message: "📋 TASK ASSIGNMENT\\n\\nMultiline\\nmessage\\nwith \\"quotes\\" and content"
Content after
      `;
      (readFile as jest.Mock).mockResolvedValue(complexTemplate);

      const result = await service.getTeamMemberTaskAssignmentPrompt(mockTaskData);

      expect(result).toContain('📋 TASK ASSIGNMENT');
    });
  });
});
