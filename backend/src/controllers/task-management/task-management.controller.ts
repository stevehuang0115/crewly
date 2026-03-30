import { Request, Response } from 'express';
import type { ApiController } from '../api.controller.js';
import type { ApiContext } from '../types.js';
import { readFile, writeFile, mkdir, rename, readdir, stat, unlink } from 'fs/promises';
import { join, basename, dirname, resolve, relative } from 'path';
import { existsSync } from 'fs';
import { resolveStepConfig } from '../../utils/prompt-resolver.js';
import { updateAgentHeartbeat } from '../../services/agent/agent-heartbeat.service.js';
import { CREWLY_CONSTANTS } from '../../constants.js';
import { LoggerService } from '../../services/core/logger.service.js';
import { TaskPlanningService } from '../../services/agent/task-planning.service.js';
import { TaskOutputValidatorService } from '../../services/quality/task-output-validator.service.js';
import { TracingService } from '../../services/core/tracing.service.js';
import { TRACING_CONSTANTS } from '../../constants.js';
import { TASK_OUTPUT_CONSTANTS, type TaskOutputRetryInfo, type TaskOutputSchema } from '../../types/task-output.types.js';
import type { EventBusService } from '../../services/event-bus/event-bus.service.js';

import type { InProgressTask } from '../../types/task-tracking.types.js';

const logger = LoggerService.getInstance().createComponentLogger('TaskManagementController');

/** Module-level reference to EventBusService for auto-cleanup on task completion */
let eventBusService: EventBusService | null = null;

/**
 * Publish a task:completed event to the EventBus (#137) and send a Slack
 * notification to the user (#202). Both are fire-and-forget — errors are
 * logged but do not block task completion.
 *
 * @param task - The completed task metadata
 * @param sessionName - The session that completed the task
 */
function publishTaskCompletedEvent(task: InProgressTask, sessionName?: string): void {
	if (!eventBusService) return;
	try {
		eventBusService.publish({
			id: `task-completed-${task.id}-${Date.now()}`,
			type: 'task:completed' as any,
			timestamp: new Date().toISOString(),
			teamId: task.teamId || '',
			teamName: '',
			memberId: task.assignedTeamMemberId || '',
			memberName: '',
			sessionName: sessionName || task.assignedSessionName || '',
			previousValue: task.status,
			newValue: 'completed',
			changedField: 'taskStatus',
		});
	} catch (err) {
		logger.warn('Failed to publish task:completed event (non-fatal)', {
			taskId: task.id,
			error: err instanceof Error ? err.message : String(err),
		});
	}

	// #202: Auto-notify user via Slack when any task completes (including background deploys)
	notifyTaskCompletedViaSlack(task, sessionName);
}

/**
 * Send a Slack notification for task completion (#202).
 * Uses lazy import to avoid circular dependencies. Fire-and-forget.
 *
 * @param task - The completed task
 * @param sessionName - The session that completed the task
 */
function notifyTaskCompletedViaSlack(task: InProgressTask, sessionName?: string): void {
	import('../../services/orchestrator/slack-bridge-lazy.js')
		.then(({ getSlackBridgeLazy }) => getSlackBridgeLazy())
		.then(bridge => {
			const agentName = sessionName || task.assignedSessionName || 'unknown';
			const projectName = task.teamId || 'crewly';
			return bridge.notifyTaskCompleted(task.taskName, agentName, projectName);
		})
		.catch(err => {
			logger.debug('Slack task-completion notification skipped (non-fatal)', {
				taskId: task.id,
				error: err instanceof Error ? err.message : String(err),
			});
		});
}

/**
 * Set the EventBusService instance for task monitoring cleanup.
 * Called during server initialization.
 *
 * @param service - The EventBusService instance
 */
export function setEventBusServiceForTaskCleanup(service: EventBusService): void {
	eventBusService = service;
}

/**
 * Get the current EventBusService reference (exposed for testing).
 *
 * @returns The EventBusService or null
 */
export function getEventBusServiceForTaskCleanup(): EventBusService | null {
	return eventBusService;
}

/**
 * Creates a new task MD file in the project's .crewly/tasks/ directory.
 * Optionally assigns it immediately if a sessionName is provided.
 *
 * @param req - Request containing projectPath, task, priority, sessionName (optional), milestone (optional)
 * @param res - Response with success status, created task path, and status
 */
export async function createTask(this: ApiController, req: Request, res: Response): Promise<void> {
	return TracingService.getInstance().withSpan(TRACING_CONSTANTS.SPANS.TASK_CREATE, {
		attributes: {
			'task.priority': req.body.priority || 'medium',
			'task.milestone': req.body.milestone || 'delegated',
		}
	}, async (span) => {
		try {
			const {
			projectPath,
			task,
			priority = 'medium',
			sessionName,
			milestone = 'delegated',
			outputSchema,
		} = req.body;

		if (!projectPath) {
			res.status(400).json({ success: false, error: 'projectPath is required' });
			return;
		}

		if (!task) {
			res.status(400).json({ success: false, error: 'task is required' });
			return;
		}

		// Determine initial status folder based on whether an assignee is provided
		const statusFolder = sessionName ? 'in_progress' : 'open';
		const tasksDir = join(projectPath, '.crewly', 'tasks', milestone, statusFolder);

		// Ensure directory exists
		await ensureDirectoryExists(tasksDir);

		// Generate sanitized filename from task description
		const sanitizedName = task
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '_')
			.replace(/^_|_$/g, '')
			.substring(0, 80);
		const timestamp = Date.now();
		const fileName = `${sanitizedName}_${timestamp}.md`;
		const taskPath = join(tasksDir, fileName);

		// Build task markdown content
		let taskContent = `# ${task}\n\n## Task Information\n- **Priority**: ${priority}\n- **Milestone**: ${milestone}\n- **Created at**: ${new Date().toISOString()}\n- **Status**: ${statusFolder === 'in_progress' ? 'In Progress' : 'Open'}\n`;

		if (sessionName) {
			taskContent += `\n## Assignment Information\n- **Assigned to**: ${sessionName}\n- **Assigned at**: ${new Date().toISOString()}\n- **Status**: In Progress\n`;
		}

		taskContent += `\n## Task Description\n\n${task}\n`;

		// Embed output schema if provided
		if (outputSchema && typeof outputSchema === 'object') {
			const validator = TaskOutputValidatorService.getInstance();
			taskContent += validator.generateSchemaMarkdown(outputSchema);
		}

		await writeFile(taskPath, taskContent, 'utf-8');

		// Create planning files (plan.md, findings.md, progress.md) when task is assigned
		if (sessionName) {
			try {
				const planningService = TaskPlanningService.getInstance();
				await planningService.createPlanningFiles({
					taskFilePath: taskPath,
					taskTitle: task,
					priority,
					sessionName,
				});
			} catch (planErr) {
				logger.warn('Failed to create planning files (non-fatal)', {
					error: planErr instanceof Error ? planErr.message : String(planErr),
				});
			}
		}

		// If assigned, track via TaskTrackingService
		let trackedTaskId: string | undefined;
		if (sessionName) {
			try {
				const projects = await this.storageService.getProjects();
				const project = projects.find(p => projectPath.startsWith(p.path));
				if (project) {
					const teams = await this.storageService.getTeams();
					let teamId = '';
					let memberId = '';
					for (const team of teams) {
						const member = team.members.find(m => m.sessionName === sessionName);
						if (member) {
							teamId = team.id;
							memberId = member.id;
							break;
						}
					}
					if (teamId) {
						const trackedTask = await this.taskTrackingService.assignTask(
							project.id,
							teamId,
							taskPath,
							task,
							'delegated',
							memberId,
							sessionName
						);
						trackedTaskId = trackedTask?.id;
					}
				}
			} catch (trackingError) {
				logger.warn('Failed to track task assignment', { error: trackingError instanceof Error ? trackingError.message : String(trackingError) });
				// Non-fatal - the file was still created
			}
		}

		res.json({
			success: true,
			message: `Task file created: ${fileName}`,
			taskPath,
			fileName,
			status: statusFolder,
			milestone,
			taskId: trackedTaskId,
		});
	} catch (error) {
		logger.error('Error creating task', { error: error instanceof Error ? error.message : String(error) });
		res.status(500).json({ success: false, error: 'Failed to create task' });
	}
	});
}

/**
 * Assigns a task to a team member by moving it from open/ to in_progress/ folder
 *
 * @param req - Request containing taskPath and memberId
 * @param res - Response with success status and task information
 */
export async function assignTask(this: ApiController, req: Request, res: Response): Promise<void> {
	return TracingService.getInstance().withSpan(TRACING_CONSTANTS.SPANS.TASK_ASSIGN, {
		attributes: {
			'task.path': req.body.taskPath || 'unknown',
			'agent.session': req.body.sessionName || 'unknown',
		}
	}, async (span) => {
		try {
			const { taskPath, sessionName } = req.body;

		// Update agent heartbeat (proof of life)
		try {
			await updateAgentHeartbeat(sessionName, undefined, CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE);
		} catch (error) {
			logger.warn('Failed to update agent heartbeat', { error: error instanceof Error ? error.message : String(error) });
			// Continue execution - heartbeat failures shouldn't break task assignment
		}

		if (!taskPath) {
			res.status(400).json({ success: false, error: 'taskPath is required' });
			return;
		}

		if (!sessionName) {
			res.status(400).json({ success: false, error: 'sessionName is required' });
			return;
		}

		// Verify source task file exists
		if (!existsSync(taskPath)) {
			res.status(200).json({
				success: false,
				error: 'Task file does not exist at the specified path',
				details: `No task file found at: ${taskPath}. Make sure the task file exists in the open/ folder.`,
				taskPath,
				suggestion: 'Verify the task file path is correct and the file exists'
			});
			return;
		}

		// Ensure task is in open/ folder
		if (!taskPath.includes('/open/')) {
			res.status(200).json({
				success: false,
				error: 'Task is not in the correct folder for assignment',
				details: `Task must be in open/ folder to be assigned. Current path: ${taskPath}`,
				taskPath,
				expectedFolder: 'open',
				currentFolder: taskPath.includes('/in_progress/') ? 'in_progress' : taskPath.includes('/done/') ? 'done' : taskPath.includes('/blocked/') ? 'blocked' : 'unknown'
			});
			return;
		}

		// Parse task information
		const taskContent = await readFile(taskPath, 'utf-8');
		const taskInfo = parseTaskInfo(taskContent, basename(taskPath));
		
		// Extract project and team information from task path
		const pathMatch = taskPath.match(/\/([^/]+)\/\.crewly/);
		if (!pathMatch) {
			res.status(400).json({ success: false, error: 'Cannot determine project from task path' });
			return;
		}
		const projectPath = taskPath.substring(0, taskPath.indexOf('.crewly'));
		
		// Find project by path
		const projects = await this.storageService.getProjects();
		const project = projects.find(p => resolve(p.path) === resolve(projectPath));
		if (!project) {
			res.status(404).json({ success: false, error: 'Project not found' });
			return;
		}
		
		// Find team and member by sessionName
		const teams = await this.storageService.getTeams();
		let teamId = '';
		let memberId = '';
		for (const team of teams) {
			const member = team.members.find(m => m.sessionName === sessionName);
			if (member) {
				teamId = team.id;
				memberId = member.id;
				break;
			}
		}
		if (!teamId) {
			res.status(404).json({ success: false, error: 'Team member not found for sessionName' });
			return;
		}

		// Create target path in in_progress/ folder
		const fileName = basename(taskPath);
		const targetPath = taskPath.replace('/open/', '/in_progress/');
		const targetDir = dirname(targetPath);

		// Ensure in_progress directory exists
		await ensureDirectoryExists(targetDir);

		// Read, update, and move task file
		const updatedContent = addTaskAssignmentInfo(taskContent, memberId, sessionName);

		await writeFile(targetPath, updatedContent, 'utf-8');
		await unlinkFile(taskPath);
		
		// Add to task tracking
		await this.taskTrackingService.assignTask(
			project.id,
			teamId,
			targetPath,
			taskInfo.title || taskInfo.fileName,
			taskInfo.targetRole || 'unknown',
			memberId,
			sessionName
		);

		res.json({
			success: true,
			message: `Task ${fileName} assigned to member ${sessionName}`,
			originalPath: taskPath,
			newPath: targetPath,
			memberId,
			sessionName,
			status: 'in_progress',
		});
	} catch (error) {
		logger.error('Error assigning task', { error: error instanceof Error ? error.message : String(error) });
		res.status(500).json({ success: false, error: 'Failed to assign task' });
	}
	});
}

/**
 * Completes a task by moving it from in_progress/ to done/ folder
 *
 * @param req - Request containing taskPath
 * @param res - Response with success status and completion information
 */
export async function completeTask(
	this: ApiController,
	req: Request,
	res: Response
): Promise<void> {
	return TracingService.getInstance().withSpan(TRACING_CONSTANTS.SPANS.TASK_COMPLETE, {
		attributes: {
			'task.path': req.body.taskPath || 'unknown',
			'agent.session': req.body.sessionName || 'unknown',
		}
	}, async (span) => {
		try {
			const { taskPath, sessionName, output, qualityScore } = req.body;

		// Update agent heartbeat (proof of life)
		try {
			await updateAgentHeartbeat(sessionName, undefined, CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE);
		} catch (error) {
			logger.warn('Failed to update agent heartbeat', { error: error instanceof Error ? error.message : String(error) });
			// Continue execution - heartbeat failures shouldn't break task completion
		}

		if (!taskPath) {
			res.status(400).json({ success: false, error: 'taskPath is required' });
			return;
		}

		// Verify source task file exists
		if (!existsSync(taskPath)) {
			res.status(200).json({
				success: false,
				error: 'Task file does not exist at the specified path',
				details: `No task file found at: ${taskPath}. Make sure the task has been properly assigned and is in the in_progress folder.`,
				taskPath,
				suggestion: 'Check if the task file exists and use accept_task first to move it from open/ to in_progress/'
			});
			return;
		}

		// Ensure task is in in_progress/ folder
		if (!taskPath.includes('/in_progress/')) {
			res.status(200).json({
				success: false,
				error: 'Task is not in the correct folder for completion',
				details: `Task must be in in_progress/ folder to be completed. Current path: ${taskPath}. Use accept_task first to move the task from open/ to in_progress/.`,
				taskPath,
				expectedFolder: 'in_progress',
				currentFolder: taskPath.includes('/open/') ? 'open' : taskPath.includes('/done/') ? 'done' : taskPath.includes('/blocked/') ? 'blocked' : 'unknown',
				action: 'Use accept_task tool first to assign the task'
			});
			return;
		}

		// Read task content to check for output schema
		const taskContent = await readFile(taskPath, 'utf-8');
		const validator = TaskOutputValidatorService.getInstance();
		const schema = validator.extractSchemaFromMarkdown(taskContent);

		// If task has an output schema, validate the output
		if (schema) {
			if (!output || typeof output !== 'object') {
				res.status(200).json({
					success: false,
					error: 'Task requires structured output but none was provided',
					details: 'This task has an output schema. Provide an "output" object matching the schema.',
					taskPath,
				});
				return;
			}

			// Check output size
			const sizeCheck = validator.validateOutputSize(output);
			if (!sizeCheck.valid) {
				res.status(200).json({
					success: false,
					error: 'Output size exceeds maximum',
					details: sizeCheck.error,
					taskPath,
				});
				return;
			}

			// Validate output against schema
			const validationResult = validator.validate(output, schema);

			if (!validationResult.valid) {
				// Check retry info
				const existingRetryInfo = validator.extractRetryInfoFromMarkdown(taskContent);
				const retryCount = existingRetryInfo ? existingRetryInfo.retryCount + 1 : 1;
				const maxRetries = TASK_OUTPUT_CONSTANTS.MAX_RETRIES;

				if (retryCount > maxRetries) {
					// Max retries exceeded - move to blocked
					const blockedPath = taskPath.replace('/in_progress/', '/blocked/');
					const blockedDir = dirname(blockedPath);
					await ensureDirectoryExists(blockedDir);

					const failureInfo = `\n\n${TASK_OUTPUT_CONSTANTS.SECTION_HEADERS.VALIDATION_FAILURE}\n- **Status**: Blocked (max validation retries exceeded)\n- **Retry count**: ${retryCount}/${maxRetries}\n- **Errors**: ${validationResult.errors.join('; ')}\n- **Blocked at**: ${new Date().toISOString()}\n`;
					const blockedContent = taskContent + failureInfo;

					await writeFile(blockedPath, blockedContent, 'utf-8');
					await unlinkFile(taskPath);

					res.status(200).json({
						success: false,
						validationFailed: true,
						maxRetriesExceeded: true,
						errors: validationResult.errors,
						retryCount,
						maxRetries,
						message: `Task moved to blocked/ after ${maxRetries} failed validation attempts`,
						taskPath: blockedPath,
					});
					return;
				}

				// Retries remaining - update retry info in task file
				const retryInfo: TaskOutputRetryInfo = {
					retryCount,
					maxRetries,
					lastErrors: validationResult.errors,
					lastAttemptAt: new Date().toISOString(),
				};

				// Remove existing retry info section if present, then append new one
				const retryHeader = TASK_OUTPUT_CONSTANTS.SECTION_HEADERS.RETRY_INFO;
				let updatedTaskContent = taskContent;
				const retryHeaderIdx = updatedTaskContent.indexOf(retryHeader);
				if (retryHeaderIdx !== -1) {
					// Find the end of the retry section (next ## header or end of file)
					const afterRetry = updatedTaskContent.substring(retryHeaderIdx + retryHeader.length);
					const nextSectionMatch = afterRetry.match(/\n## /);
					if (nextSectionMatch && nextSectionMatch.index !== undefined) {
						updatedTaskContent = updatedTaskContent.substring(0, retryHeaderIdx) +
							updatedTaskContent.substring(retryHeaderIdx + retryHeader.length + nextSectionMatch.index);
					} else {
						updatedTaskContent = updatedTaskContent.substring(0, retryHeaderIdx);
					}
				}

				updatedTaskContent += validator.generateRetryMarkdown(retryInfo);
				await writeFile(taskPath, updatedTaskContent, 'utf-8');

				res.status(200).json({
					success: false,
					validationFailed: true,
					errors: validationResult.errors,
					retryCount,
					maxRetries,
					message: `Output validation failed. ${maxRetries - retryCount} retries remaining.`,
					taskPath,
				});
				return;
			}

			// Validation passed - store output file alongside the done task
			const doneTargetPath = taskPath.replace('/in_progress/', '/done/');
			const outputFilePath = doneTargetPath.replace(/\.md$/, TASK_OUTPUT_CONSTANTS.OUTPUT_FILE_EXTENSION);
			const doneDir = dirname(doneTargetPath);
			await ensureDirectoryExists(doneDir);

			const outputData = {
				output,
				producedAt: new Date().toISOString(),
				sessionName: sessionName || 'unknown',
			};
			await writeFile(outputFilePath, JSON.stringify(outputData, null, 2), 'utf-8');

			// Move task to done
			const updatedContent = addTaskCompletionInfo(taskContent);
			await writeFile(doneTargetPath, updatedContent, 'utf-8');
			await unlinkFile(taskPath);

			// Remove from task tracking and clean up monitoring
			const allTasksWithSchema = await this.taskTrackingService.getAllInProgressTasks();
			const taskToRemoveWithSchema = allTasksWithSchema.find(t => t.taskFilePath === taskPath);
			let cleanupResultSchema = { cancelledSchedules: 0, unsubscribedEvents: 0 };
			if (taskToRemoveWithSchema) {
				// #174: Store quality score on task before completing
				if (typeof qualityScore === 'number' && qualityScore >= 0 && qualityScore <= 100) {
					taskToRemoveWithSchema.qualityScore = qualityScore;
					taskToRemoveWithSchema.scoredAt = new Date().toISOString();
					taskToRemoveWithSchema.scoredBy = sessionName;
				}
				publishTaskCompletedEvent(taskToRemoveWithSchema, sessionName);
				cleanupResultSchema = await cleanupTaskMonitoring(this, taskToRemoveWithSchema);
				await this.taskTrackingService.removeTask(taskToRemoveWithSchema.id);
			}

			res.json({
				success: true,
				message: `Task ${basename(taskPath)} marked as completed with validated output`,
				originalPath: taskPath,
				newPath: doneTargetPath,
				outputPath: outputFilePath,
				status: 'done',
				completedAt: new Date().toISOString(),
				monitoringCleanup: cleanupResultSchema,
			});
			return;
		}

		// No schema - original behavior (backward compatible)
		const fileName = basename(taskPath);
		const targetPath = taskPath.replace('/in_progress/', '/done/');
		const targetDir = dirname(targetPath);

		// Ensure done directory exists
		await ensureDirectoryExists(targetDir);

		// Read, update, and move task file
		const updatedContent = addTaskCompletionInfo(taskContent);

		await writeFile(targetPath, updatedContent, 'utf-8');
		await unlinkFile(taskPath);

		// Remove from task tracking and clean up monitoring
		const allTasks = await this.taskTrackingService.getAllInProgressTasks();
		const taskToRemove = allTasks.find(t => t.taskFilePath === taskPath);
		let cleanupResult = { cancelledSchedules: 0, unsubscribedEvents: 0 };
		if (taskToRemove) {
			// #174: Store quality score on task before completing
			if (typeof qualityScore === 'number' && qualityScore >= 0 && qualityScore <= 100) {
				taskToRemove.qualityScore = qualityScore;
				taskToRemove.scoredAt = new Date().toISOString();
				taskToRemove.scoredBy = sessionName;
			}
			publishTaskCompletedEvent(taskToRemove, sessionName);
			cleanupResult = await cleanupTaskMonitoring(this, taskToRemove);
			await this.taskTrackingService.removeTask(taskToRemove.id);
		}

		res.json({
			success: true,
			message: `Task ${fileName} marked as completed`,
			originalPath: taskPath,
			newPath: targetPath,
			status: 'done',
			completedAt: new Date().toISOString(),
			monitoringCleanup: cleanupResult,
		});
	} catch (error) {
		logger.error('Error completing task', { error: error instanceof Error ? error.message : String(error) });
		res.status(500).json({ success: false, error: 'Failed to complete task' });
	}
	});
}

/**
 * Blocks a task by moving it from in_progress/ to blocked/ folder
 *
 * @param req - Request containing taskPath and blockReason
 * @param res - Response with success status and block information
 */
export async function blockTask(this: ApiController, req: Request, res: Response): Promise<void> {
	try {
		const { taskPath, blockReason } = req.body;

		if (!taskPath) {
			res.status(400).json({ success: false, error: 'taskPath is required' });
			return;
		}

		// Verify source task file exists
		if (!existsSync(taskPath)) {
			res.status(200).json({
				success: false,
				error: 'Task file does not exist at the specified path',
				details: `No task file found at: ${taskPath}. Make sure the task has been properly assigned and is in the in_progress folder.`,
				taskPath,
				suggestion: 'Check if the task file exists and use accept_task first to move it from open/ to in_progress/'
			});
			return;
		}

		// Ensure task is in in_progress/ folder
		if (!taskPath.includes('/in_progress/')) {
			res.status(200).json({
				success: false,
				error: 'Task is not in the correct folder for blocking',
				details: `Task must be in in_progress/ folder to be blocked. Current path: ${taskPath}. Use accept_task first to assign the task.`,
				taskPath,
				expectedFolder: 'in_progress',
				currentFolder: taskPath.includes('/open/') ? 'open' : taskPath.includes('/done/') ? 'done' : taskPath.includes('/blocked/') ? 'blocked' : 'unknown',
				action: 'Use accept_task tool first to assign the task'
			});
			return;
		}

		// Create target path in blocked/ folder
		const fileName = basename(taskPath);
		const targetPath = taskPath.replace('/in_progress/', '/blocked/');
		const targetDir = dirname(targetPath);

		// Ensure blocked directory exists
		await ensureDirectoryExists(targetDir);

		// Read, update, and move task file
		const taskContent = await readFile(taskPath, 'utf-8');
		const updatedContent = addTaskBlockInfo(taskContent, blockReason);

		await writeFile(targetPath, updatedContent, 'utf-8');
		await unlinkFile(taskPath);

		res.json({
			success: true,
			message: `Task ${fileName} marked as blocked`,
			originalPath: taskPath,
			newPath: targetPath,
			status: 'blocked',
			blockReason: blockReason || 'No reason provided',
			blockedAt: new Date().toISOString(),
		});
	} catch (error) {
		logger.error('Error blocking task', { error: error instanceof Error ? error.message : String(error) });
		res.status(500).json({ success: false, error: 'Failed to block task' });
	}
}

/**
 * Unblocks a task by moving it from blocked/ to open/ folder for reassignment
 *
 * @param req - Request containing taskPath and optional unblockNote
 * @param res - Response with success status and unblock information
 */
export async function unblockTask(this: ApiController, req: Request, res: Response): Promise<void> {
	try {
		const { taskPath, unblockNote } = req.body;

		if (!taskPath) {
			res.status(400).json({ success: false, error: 'taskPath is required' });
			return;
		}

		// Verify task file exists
		if (!existsSync(taskPath)) {
			res.status(404).json({
				success: false,
				error: 'Task file not found',
				path: taskPath,
			});
			return;
		}

		// Verify task is in blocked/ folder
		if (!taskPath.includes('/blocked/')) {
			res.status(400).json({
				success: false,
				error: 'Task is not in the blocked folder',
				details: `Task must be in blocked/ folder to be unblocked. Current path: ${taskPath}`,
				currentFolder: taskPath.includes('/open/') ? 'open' : taskPath.includes('/in_progress/') ? 'in_progress' : taskPath.includes('/done/') ? 'done' : 'unknown',
			});
			return;
		}

		// Read current task content
		const taskContent = await readFile(taskPath, 'utf-8');
		const fileName = basename(taskPath);

		// Create target path in open/ folder
		const targetPath = taskPath.replace('/blocked/', '/open/');

		// Ensure open directory exists
		await mkdir(dirname(targetPath), { recursive: true });

		// Add unblock information to task content
		const updatedContent = addTaskUnblockInfo(taskContent, unblockNote);

		// Move file and update content
		await writeFile(targetPath, updatedContent, 'utf-8');
		await unlink(taskPath);

		res.json({
			success: true,
			message: `Task ${fileName} unblocked and moved to open folder for reassignment`,
			taskPath: targetPath,
			fileName,
			status: 'open',
			unblockNote: unblockNote || 'No note provided',
			unblockedAt: new Date().toISOString(),
		});
	} catch (error) {
		logger.error('Error unblocking task', { error: error instanceof Error ? error.message : String(error) });
		res.status(500).json({ success: false, error: 'Failed to unblock task' });
	}
}

/**
 * Gets the next available task from the open/ folder
 *
 * @param req - Request containing optional taskGroup filter
 * @param res - Response with next available task information
 */
export async function takeNextTask(
	this: ApiController,
	req: Request,
	res: Response
): Promise<void> {
	try {
		const { taskGroup, projectPath } = req.body;

		if (!projectPath) {
			res.status(400).json({ success: false, error: 'projectPath is required' });
			return;
		}

		// Construct path to open tasks
		const openTasksPath = taskGroup
			? join(projectPath, '.crewly', 'tasks', taskGroup, 'open')
			: join(projectPath, '.crewly', 'tasks', 'm0_build_spec_tasks', 'open');

		if (!existsSync(openTasksPath)) {
			res.status(404).json({
				success: false,
				error: 'No open tasks directory found',
				path: openTasksPath,
			});
			return;
		}

		// Get all .md files in open directory
		const files = await readdir(openTasksPath);
		const taskFiles = files.filter((f) => f.endsWith('.md')).sort();

		if (taskFiles.length === 0) {
			res.status(404).json({
				success: false,
				error: 'No open tasks available',
				path: openTasksPath,
			});
			return;
		}

		// Get the first task (sorted alphabetically)
		const nextTaskFile = taskFiles[0];
		const taskPath = join(openTasksPath, nextTaskFile);
		const taskContent = await readFile(taskPath, 'utf-8');

		// Parse basic task info from markdown
		const taskInfo = parseTaskInfo(taskContent, nextTaskFile);

		res.json({
			success: true,
			task: {
				taskPath,
				...taskInfo,
			},
			totalAvailable: taskFiles.length,
			openTasksPath,
		});
	} catch (error) {
		logger.error('Error getting next task', { error: error instanceof Error ? error.message : String(error) });
		res.status(500).json({ success: false, error: 'Failed to get next task' });
	}
}

/**
 * Synchronizes task status across the system
 *
 * @param req - Request containing projectPath and optional taskGroup
 * @param res - Response with sync status and task counts
 */
export async function syncTaskStatus(
	this: ApiController,
	req: Request,
	res: Response
): Promise<void> {
	try {
		const { projectPath, taskGroup } = req.body;

		if (!projectPath) {
			res.status(400).json({ success: false, error: 'projectPath is required' });
			return;
		}

		// Construct base tasks path
		const basePath = taskGroup
			? join(projectPath, '.crewly', 'tasks', taskGroup)
			: join(projectPath, '.crewly', 'tasks', 'm0_build_spec_tasks');

		if (!existsSync(basePath)) {
			res.status(404).json({
				success: false,
				error: 'Tasks directory not found',
				path: basePath,
			});
			return;
		}

		// Count tasks in each status folder
		const statusCounts = {
			open: 0,
			in_progress: 0,
			blocked: 0,
			done: 0,
		};

		const statusDirs = ['open', 'in_progress', 'blocked', 'done'];

		for (const status of statusDirs) {
			const statusPath = join(basePath, status);
			if (existsSync(statusPath)) {
				const files = await readdir(statusPath);
				statusCounts[status as keyof typeof statusCounts] = files.filter((f) =>
					f.endsWith('.md')
				).length;
			}
		}

		// Calculate progress percentage
		const totalTasks = Object.values(statusCounts).reduce((sum, count) => sum + count, 0);
		const completedTasks = statusCounts.done;
		const progressPercentage =
			totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

		res.json({
			success: true,
			syncedAt: new Date().toISOString(),
			projectPath,
			taskGroup: taskGroup || 'm0_build_spec_tasks',
			statusCounts,
			totalTasks,
			completedTasks,
			progressPercentage,
		});
	} catch (error) {
		logger.error('Error syncing task status', { error: error instanceof Error ? error.message : String(error) });
		res.status(500).json({ success: false, error: 'Failed to sync task status' });
	}
}

/**
 * Gets team progress across all task groups for a project
 *
 * @param req - Request containing projectPath
 * @param res - Response with comprehensive team progress information
 */
export async function getTeamProgress(
	this: ApiController,
	req: Request,
	res: Response
): Promise<void> {
	try {
		const { projectPath } = req.body;

		if (!projectPath) {
			res.status(400).json({ success: false, error: 'projectPath is required' });
			return;
		}

		const tasksBasePath = join(projectPath, '.crewly', 'tasks');

		if (!existsSync(tasksBasePath)) {
			res.status(404).json({
				success: false,
				error: 'Tasks directory not found',
				path: tasksBasePath,
			});
			return;
		}

		// Get all task groups (subdirectories in tasks/)
		const taskGroups = await readdir(tasksBasePath);
		const progressData = [];

		for (const taskGroup of taskGroups) {
			const groupPath = join(tasksBasePath, taskGroup);
			const groupStat = await stat(groupPath);

			if (groupStat.isDirectory()) {
				const statusCounts = {
					open: 0,
					in_progress: 0,
					blocked: 0,
					done: 0,
				};

				const statusDirs = ['open', 'in_progress', 'blocked', 'done'];

				for (const status of statusDirs) {
					const statusPath = join(groupPath, status);
					if (existsSync(statusPath)) {
						const files = await readdir(statusPath);
						statusCounts[status as keyof typeof statusCounts] = files.filter((f) =>
							f.endsWith('.md')
						).length;
					}
				}

				const totalTasks = Object.values(statusCounts).reduce(
					(sum, count) => sum + count,
					0
				);
				const completedTasks = statusCounts.done;
				const progressPercentage =
					totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

				progressData.push({
					taskGroup,
					statusCounts,
					totalTasks,
					completedTasks,
					progressPercentage,
				});
			}
		}

		// Calculate overall progress
		const overallStats = progressData.reduce(
			(acc, group) => ({
				totalTasks: acc.totalTasks + group.totalTasks,
				completedTasks: acc.completedTasks + group.completedTasks,
			}),
			{ totalTasks: 0, completedTasks: 0 }
		);

		const overallProgress =
			overallStats.totalTasks > 0
				? Math.round((overallStats.completedTasks / overallStats.totalTasks) * 100)
				: 0;

		res.json({
			success: true,
			projectPath,
			reportedAt: new Date().toISOString(),
			overallProgress,
			overallStats,
			taskGroups: progressData,
		});
	} catch (error) {
		logger.error('Error getting team progress', { error: error instanceof Error ? error.message : String(error) });
		res.status(500).json({ success: false, error: 'Failed to get team progress' });
	}
}

/**
 * Starts task execution by sending assignment prompt to orchestrator
 * Initiates monitoring process to detect task acceptance with retry logic
 *
 * @param req - Request containing task execution parameters
 * @param res - Response with execution status and monitoring information
 */
export async function startTaskExecution(
	this: ApiContext,
	req: Request,
	res: Response
): Promise<void> {
	try {
		const {
			taskPath,
			projectPath,
			projectName,
			taskId,
			taskTitle,
			taskDescription,
			taskPriority = 'medium',
			taskMilestone = 'm0_initial_tasks',
			retryCount = 3,
			timeoutSeconds = 30,
		} = req.body;

		if (!taskPath || !projectPath || !projectName) {
			res.status(400).json({
				success: false,
				error: 'Missing required fields: taskPath, projectPath, projectName',
			});
			return;
		}

		// Verify task file exists in open/ folder
		if (!existsSync(taskPath)) {
			res.status(404).json({
				success: false,
				error: `Task file not found: ${taskPath}`,
			});
			return;
		}

		if (!taskPath.includes('/open/')) {
			res.status(400).json({
				success: false,
				error: 'Task must be in open/ folder to be started',
			});
			return;
		}

		// Load assignment prompt template
		const promptTemplate = await readFile(
			join(process.cwd(), 'config', 'orchestrator_tasks', 'prompts', 'assign-task-orchestrator-prompt-template.md'),
			'utf-8'
		);

		// Replace template variables
		const assignmentPrompt = promptTemplate
			.replace(/\{projectName\}/g, projectName)
			.replace(/\{projectPath\}/g, projectPath)
			.replace(/\{taskId\}/g, taskId || basename(taskPath, '.md'))
			.replace(/\{taskTitle\}/g, taskTitle || 'Task Assignment')
			.replace(
				/\{taskDescription\}/g,
				taskDescription || 'Please check task file for details'
			)
			.replace(/\{taskPriority\}/g, taskPriority)
			.replace(/\{taskMilestone\}/g, taskMilestone);

		// Find orchestrator session
		const sessions = await this.tmuxService.listSessions();
		const orchestratorSession = sessions.find(
			(s) => s.sessionName.includes('orc') || s.sessionName.includes('orchestrator')
		);

		if (!orchestratorSession) {
			res.status(404).json({
				success: false,
				error: 'Orchestrator session not found. Please ensure orchestrator is running.',
			});
			return;
		}

		// Send assignment prompt to orchestrator
		await this.tmuxService.sendMessage(orchestratorSession.sessionName, assignmentPrompt);

		// Start monitoring for task acceptance
		const monitoringId = `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

		// Initialize task assignment monitor
		const monitorResult = await this.taskAssignmentMonitor.startMonitoring({
			monitoringId,
			taskPath,
			originalPath: taskPath,
			targetPath: taskPath.replace('/open/', '/in_progress/'),
			orchestratorSession: orchestratorSession.sessionName,
			assignmentPrompt,
			retryCount,
			timeoutSeconds,
			projectPath,
			taskId: taskId || basename(taskPath, '.md'),
		});

		res.json({
			success: true,
			message: `Task execution started. Assignment sent to orchestrator.`,
			monitoringId,
			orchestratorSession: orchestratorSession.sessionName,
			taskPath,
			monitoring: monitorResult,
			retryCount,
			timeoutSeconds,
		});
	} catch (error) {
		logger.error('Error starting task execution', { error: error instanceof Error ? error.message : String(error) });
		res.status(500).json({
			success: false,
			error: 'Failed to start task execution',
			details: error instanceof Error ? error.message : String(error),
		});
	}
}

/**
 * Recovers abandoned in-progress tasks when orchestrator starts
 *
 * @param req - Request containing sessionName (optional)
 * @param res - Response with recovery report
 */
export async function recoverAbandonedTasks(this: ApiController, req: Request, res: Response): Promise<void> {
	try {
		logger.info('Starting abandoned task recovery');

		// Function to get current team status from storage
		const getTeamStatus = async () => {
			const teams = await this.storageService.getTeams();
			return teams;
		};

		// Run recovery
		const report = await this.taskTrackingService.recoverAbandonedTasks(getTeamStatus);

		logger.info('Recovery completed', { report });

		res.json({
			success: true,
			message: `Task recovery completed. Recovered: ${report.recovered}, Skipped: ${report.skipped}`,
			data: report
		});

	} catch (error) {
		logger.error('Recovery failed', { error: error instanceof Error ? error.message : String(error) });
		res.status(500).json({
			success: false,
			error: 'Failed to recover abandoned tasks',
			details: error instanceof Error ? error.message : String(error)
		});
	}
}

export async function createTasksFromConfig(
	this: ApiContext,
	req: Request,
	res: Response
): Promise<void> {
	try {
		const { projectId, projectName, projectPath, configType } = req.body;

		if (!projectId || !projectName || !projectPath) {
			res.status(400).json({
				success: false,
				error: 'Missing required fields: projectId, projectName, projectPath',
			});
			return;
		}

		// Read initial goal and user journey from saved .md files
		const specsPath = join(projectPath, '.crewly', 'specs');
		const goalFilePath = join(specsPath, 'initial_goal.md');
		const journeyFilePath = join(specsPath, 'initial_user_journey.md');

		let initialGoal = 'No specific goal provided';
		let userJourney = 'Standard user workflow - register, login, use core features';

		try {
			if (existsSync(goalFilePath)) {
				initialGoal = await readFile(goalFilePath, 'utf-8');
				logger.info('Loaded initial goal', { goalFilePath });
			} else {
				logger.warn('Initial goal file not found', { goalFilePath });
			}
		} catch (error) {
			logger.warn('Failed to read initial goal file', { error: error instanceof Error ? error.message : String(error) });
		}

		try {
			if (existsSync(journeyFilePath)) {
				userJourney = await readFile(journeyFilePath, 'utf-8');
				logger.info('Loaded user journey', { journeyFilePath });
			} else {
				logger.warn('Initial user journey file not found', { journeyFilePath });
			}
		} catch (error) {
			logger.warn('Failed to read initial user journey file', { error: error instanceof Error ? error.message : String(error) });
		}

		// Load the configuration based on configType
		const configPath = join(process.cwd(), 'config', 'task_starters', `${configType}.json`);

		let configContent;
		try {
			configContent = JSON.parse(await readFile(configPath, 'utf-8'));
		} catch (error) {
			logger.error('Error loading config', { configType, error: error instanceof Error ? error.message : String(error) });
			res.status(500).json({
				success: false,
				error: `Failed to load ${configType} configuration`,
			});
			return;
		}

		if (!configContent.steps || !Array.isArray(configContent.steps)) {
			res.status(500).json({
				success: false,
				error: `Invalid ${configType} configuration: missing steps`,
			});
			return;
		}

		// Create tasks directory for initial tasksß
		const taskDirName = 'm0_initial_tasks';
		const tasksDir = join(projectPath, '.crewly', 'tasks', taskDirName, 'open');

		try {
			await ensureDirectoryExists(tasksDir);
		} catch (error) {
			logger.error('Error creating tasks directory', { error: error instanceof Error ? error.message : String(error) });
			res.status(500).json({ success: false, error: 'Failed to create tasks directory' });
			return;
		}

		// Generate task files from configuration steps
		const createdTasks = [];

		for (let i = 0; i < configContent.steps.length; i++) {
			const step = configContent.steps[i];
			const taskNumber = String(i + 1).padStart(2, '0');
			const fileName = `${taskNumber}_${step.name
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '_')}.md`;
			const filePath = join(tasksDir, fileName);

			// Generate task markdown content using loaded values from .md files
			const taskContent = await generateTaskMarkdown(step, {
				projectId,
				projectName,
				projectPath,
				initialGoal,
				userJourney,
			});

			try {
				await writeFile(filePath, taskContent, 'utf-8');
				createdTasks.push({
					step: i + 1,
					name: step.name,
					fileName,
					targetRole: step.targetRole,
					delayMinutes: step.delayMinutes || 0,
				});
			} catch (error) {
				logger.error('Error creating task file', { fileName, error: error instanceof Error ? error.message : String(error) });
				res.status(500).json({
					success: false,
					error: `Failed to create task file: ${fileName}`,
				});
				return;
			}
		}

		res.json({
			success: true,
			message: `Successfully created ${createdTasks.length} build spec task files in ${tasksDir}`,
			tasksDirectory: tasksDir,
			createdTasks,
			totalSteps: configContent.steps.length,
		});
	} catch (error) {
		logger.error('Error creating tasks from config', { error: error instanceof Error ? error.message : String(error) });
		res.status(500).json({
			success: false,
			error: 'Failed to create tasks from configuration',
		});
	}
}

// Helper function to ensure directory exists
async function ensureDirectoryExists(dirPath: string): Promise<void> {
	if (!existsSync(dirPath)) {
		await mkdir(dirPath, { recursive: true });
	}
}

/** Shape of a build step from the project config. */
interface BuildStep {
	id: number;
	name: string;
	targetRole: string;
	delayMinutes?: number;
	prompts?: string[];
	prompt_file?: string;
	verification?: {
		type: string;
		paths?: string[];
		min_files?: number;
		file_pattern?: string;
	};
	conditional?: string;
	outputSchema?: TaskOutputSchema;
}

/** Variables resolved from the project context. */
interface ProjectVars {
	projectId: string;
	projectName: string;
	projectPath: string;
	initialGoal: string;
	userJourney: string;
}

/** Parsed task info extracted from markdown content. */
interface ParsedTaskInfo {
	fileName: string;
	title?: string;
	targetRole?: string;
	estimatedDelay?: string;
	[key: string]: string | undefined;
}

// Helper function to generate task markdown content
async function generateTaskMarkdown(step: BuildStep, projectVars: ProjectVars): Promise<string> {
	const { projectId, projectName, projectPath, initialGoal, userJourney } = projectVars;

	// Resolve prompts using the prompt resolver utility
	const templateVars = {
		PROJECT_NAME: projectName,
		PROJECT_PATH: projectPath,
		INITIAL_GOAL: initialGoal,
		USER_JOURNEY: userJourney,
		PROJECT_ID: projectId
	};

	// Use prompt resolver to handle both prompt_file and legacy prompts array
	const resolvedStep = await resolveStepConfig(step, templateVars);
	const processedPrompts = resolvedStep.prompts;

	// Generate markdown content
	const markdown = `# ${step.name}

## Task Information
- **Step**: ${step.id}
- **Target Role**: ${step.targetRole}
- **Estimated Delay**: ${step.delayMinutes || 0} minutes
- **Project**: ${projectName}
- **Project Path**: ${projectPath}

## Project Context
**Initial Goal**: ${initialGoal}

**User Journey**: ${userJourney}

## Task Description

${processedPrompts.join('\n\n')}

## Verification Criteria
${
	step.verification
		? `
- **Type**: ${step.verification.type}
${step.verification.paths ? `- **Required Paths**: ${step.verification.paths.join(', ')}` : ''}
${step.verification.min_files ? `- **Minimum Files**: ${step.verification.min_files}` : ''}
${step.verification.file_pattern ? `- **File Pattern**: ${step.verification.file_pattern}` : ''}
`
		: 'No specific verification criteria defined.'
}

## Conditional Requirements
${
	step.conditional
		? `This task should only be executed: ${step.conditional}`
		: 'No conditional requirements.'
}

---
*Generated from configuration with prompt resolution*
*Task can be assigned to orchestrator for execution when ready*
`;

	// Embed output schema if present in step config
	if (step.outputSchema && typeof step.outputSchema === 'object') {
		const validator = TaskOutputValidatorService.getInstance();
		return markdown + validator.generateSchemaMarkdown(step.outputSchema);
	}

	return markdown;
}

// Helper function to delete a file
async function unlinkFile(filePath: string): Promise<void> {
	const { unlink } = await import('fs/promises');
	await unlink(filePath);
}

// Helper function to add assignment information to task content
function addTaskAssignmentInfo(content: string, memberId: string, sessionName?: string): string {
	const assignmentInfo = `\n\n## Assignment Information\n- **Assigned to**: ${memberId}\n- **Session**: ${
		sessionName || 'N/A'
	}\n- **Assigned at**: ${new Date().toISOString()}\n- **Status**: In Progress\n`;
	return content + assignmentInfo;
}

// Helper function to add completion information to task content
function addTaskCompletionInfo(content: string): string {
	const completionInfo = `\n\n## Completion Information\n- **Status**: Completed\n- **Completed at**: ${new Date().toISOString()}\n`;
	return content + completionInfo;
}

// Helper function to add block information to task content
function addTaskBlockInfo(content: string, blockReason?: string): string {
	const blockInfo = `\n\n## Block Information\n- **Status**: Blocked\n- **Block reason**: ${
		blockReason || 'No reason provided'
	}\n- **Blocked at**: ${new Date().toISOString()}\n`;
	return content + blockInfo;
}

// Helper function to add unblock information to task content
function addTaskUnblockInfo(content: string, unblockNote?: string): string {
	const unblockInfo = `\n\n## Unblock Information\n- **Status**: Unblocked (moved to open for reassignment)\n- **Unblock note**: ${
		unblockNote || 'No note provided'
	}\n- **Unblocked at**: ${new Date().toISOString()}\n`;
	return content + unblockInfo;
}

// Helper function to parse basic task information from markdown content
function parseTaskInfo(content: string, fileName: string): ParsedTaskInfo {
	const lines = content.split('\n');
	const info: ParsedTaskInfo = { fileName };

	// Extract title (first # heading)
	const titleMatch = lines.find((line) => line.startsWith('# '));
	if (titleMatch) {
		info.title = titleMatch.substring(2).trim();
	}

	// Extract target role from task information section
	const targetRoleMatch = lines.find((line) => line.includes('**Target Role**:'));
	if (targetRoleMatch) {
		info.targetRole = targetRoleMatch.split('**Target Role**:')[1]?.trim();
	}

	// Extract estimated delay
	const delayMatch = lines.find((line) => line.includes('**Estimated Delay**:'));
	if (delayMatch) {
		const delayText = delayMatch.split('**Estimated Delay**:')[1]?.trim();
		info.estimatedDelay = delayText;
	}

	return info;
}

/**
 * Reads a task file from the filesystem with security validation
 *
 * @param req - Request containing taskPath
 * @param res - Response with task file content
 */
export async function readTask(this: ApiController, req: Request, res: Response): Promise<void> {
	try {
		const { taskPath } = req.body;

		if (!taskPath) {
			res.status(400).json({ success: false, error: 'taskPath is required' });
			return;
		}

		// Security validation: ensure path is within allowed directories
		const resolvedPath = resolve(taskPath);
		const allowedPattern = /\.crewly[\/\\]tasks[\/\\]/;

		if (!allowedPattern.test(resolvedPath)) {
			res.status(403).json({
				success: false,
				error: 'Access denied: path must be within .crewly/tasks/ directory'
			});
			return;
		}

		// Verify file exists
		if (!existsSync(taskPath)) {
			res.status(200).json({
				success: false,
				error: 'Task file does not exist at the specified path',
				details: `No task file found at: ${taskPath}. Verify the path is correct and the file exists.`,
				taskPath,
				suggestion: 'Check that the file path is correct and the file exists in the filesystem'
			});
			return;
		}

		// Read file content
		const content = await readFile(taskPath, 'utf-8');

		res.json({
			success: true,
			content: content,
			taskPath: taskPath,
			fileSize: content.length,
		});
	} catch (error) {
		logger.error('Error reading task', { error: error instanceof Error ? error.message : String(error) });
		res.status(500).json({ success: false, error: 'Failed to read task file' });
	}
}

/**
 * Retrieves the stored output JSON for a completed task.
 *
 * @param req - Request containing taskPath (path to the .md file in done/)
 * @param res - Response with the parsed output data
 */
export async function getTaskOutput(this: ApiController, req: Request, res: Response): Promise<void> {
	try {
		const { taskPath } = req.body;

		if (!taskPath) {
			res.status(400).json({ success: false, error: 'taskPath is required' });
			return;
		}

		// Derive the output file path from the task file path
		const outputFilePath = taskPath.replace(/\.md$/, TASK_OUTPUT_CONSTANTS.OUTPUT_FILE_EXTENSION);

		if (!existsSync(outputFilePath)) {
			res.status(200).json({
				success: false,
				error: 'No output file found for this task',
				details: `Expected output at: ${outputFilePath}`,
				taskPath,
			});
			return;
		}

		const rawContent = await readFile(outputFilePath, 'utf-8');
		const outputData = JSON.parse(rawContent);

		res.json({
			success: true,
			data: outputData,
			outputPath: outputFilePath,
		});
	} catch (error) {
		logger.error('Error getting task output', { error: error instanceof Error ? error.message : String(error) });
		res.status(500).json({ success: false, error: 'Failed to get task output' });
	}
}

/**
 * POST /api/task-management/request-review
 *
 * Request a code review for a completed task. Logs the review request
 * and returns success. In the future this may notify the reviewer agent
 * or broadcast a review request to the team.
 *
 * @param req - Request with body: { ticketId, reviewer?, message?, branch? }
 * @param res - Response with { success, data: { message: string } }
 */
export async function requestReview(
	this: ApiController,
	req: Request,
	res: Response
): Promise<void> {
	try {
		const { ticketId, reviewer, message, branch } = req.body;

		if (!ticketId) {
			res.status(400).json({
				success: false,
				error: 'ticketId is required',
			});
			return;
		}

		logger.info('Review requested', {
			ticketId,
			reviewer: reviewer || 'any',
			branch: branch || 'current',
			message: message || 'No message provided',
		});

		res.json({
			success: true,
			data: {
				message: 'Review requested',
				ticketId,
				reviewer: reviewer || null,
				branch: branch || null,
				requestedAt: new Date().toISOString(),
			},
		});
	} catch (error) {
		logger.error('Error requesting review', { error: error instanceof Error ? error.message : String(error) });
		res.status(500).json({
			success: false,
			error: 'Failed to request review',
		});
	}
}

/**
 * Cleans up monitoring resources (scheduled checks and event subscriptions)
 * linked to a task. Called automatically when a task is completed.
 *
 * @param controller - The ApiController instance (for schedulerService access)
 * @param task - The task whose monitoring to clean up
 * @returns Object with counts of cancelled schedules and unsubscribed events
 */
async function cleanupTaskMonitoring(
	controller: ApiController,
	task: { scheduleIds?: string[]; subscriptionIds?: string[] }
): Promise<{ cancelledSchedules: number; unsubscribedEvents: number }> {
	let cancelledSchedules = 0;
	let unsubscribedEvents = 0;

	// Cancel linked schedules
	if (task.scheduleIds && task.scheduleIds.length > 0) {
		for (const scheduleId of task.scheduleIds) {
			try {
				controller.schedulerService.cancelCheck(scheduleId);
				cancelledSchedules++;
			} catch (error) {
				logger.warn('Failed to cancel schedule during task cleanup', {
					scheduleId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	// Unsubscribe linked event subscriptions
	if (task.subscriptionIds && task.subscriptionIds.length > 0 && eventBusService) {
		for (const subscriptionId of task.subscriptionIds) {
			try {
				eventBusService.unsubscribe(subscriptionId);
				unsubscribedEvents++;
			} catch (error) {
				logger.warn('Failed to unsubscribe event during task cleanup', {
					subscriptionId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	if (cancelledSchedules > 0 || unsubscribedEvents > 0) {
		logger.info('Task monitoring cleaned up', { cancelledSchedules, unsubscribedEvents });
	}

	return { cancelledSchedules, unsubscribedEvents };
}

/**
 * Adds monitoring IDs (schedule and subscription IDs) to tasks for a given agent session.
 * Called by delegate-task after setting up auto-monitoring to link monitoring resources
 * to the task for auto-cleanup on completion.
 *
 * @param req - Request containing sessionName, scheduleIds, subscriptionIds
 * @param res - Response with success status
 */
export async function addMonitoring(this: ApiController, req: Request, res: Response): Promise<void> {
	try {
		const { sessionName, scheduleIds = [], subscriptionIds = [] } = req.body;

		if (!sessionName) {
			res.status(400).json({ success: false, error: 'sessionName is required' });
			return;
		}

		if (scheduleIds.length === 0 && subscriptionIds.length === 0) {
			res.status(400).json({ success: false, error: 'At least one scheduleId or subscriptionId is required' });
			return;
		}

		// Find the most recent task assigned to this session
		const tasks = await this.taskTrackingService.getTasksBySessionName(sessionName);

		if (tasks.length === 0) {
			// No tracked task found — store IDs anyway by finding any in_progress_tasks entry
			logger.warn('No tracked tasks found for session, storing monitoring IDs for session-level cleanup', { sessionName });
			res.json({
				success: true,
				message: 'No tracked task found for session; monitoring IDs noted but not linked to a task',
				sessionName,
				scheduleIds,
				subscriptionIds,
			});
			return;
		}

		// Link to the most recently assigned task
		const latestTask = tasks.sort((a, b) => new Date(b.assignedAt).getTime() - new Date(a.assignedAt).getTime())[0];

		await this.taskTrackingService.addMonitoringIds(
			latestTask.id,
			scheduleIds,
			subscriptionIds
		);

		res.json({
			success: true,
			message: 'Monitoring IDs linked to task',
			taskId: latestTask.id,
			taskName: latestTask.taskName,
			scheduleIds,
			subscriptionIds,
		});
	} catch (error) {
		logger.error('Error adding monitoring IDs', { error: error instanceof Error ? error.message : String(error) });
		res.status(500).json({ success: false, error: 'Failed to add monitoring IDs' });
	}
}

/**
 * Completes all tasks assigned to a given agent session.
 *
 * Called by the report-status skill when an agent reports status=done.
 * Finds all in-progress/assigned tasks for the session, marks them as
 * completed in task tracking, and cleans up monitoring resources.
 *
 * @param req - Request containing sessionName
 * @param res - Response with list of completed tasks
 */
export async function completeTasksBySession(this: ApiController, req: Request, res: Response): Promise<void> {
	try {
		const { sessionName } = req.body;

		if (!sessionName) {
			res.status(400).json({ success: false, error: 'sessionName is required' });
			return;
		}

		const tasks = await this.taskTrackingService.getTasksBySessionName(sessionName);
		const activeTasks = tasks.filter(t => t.status === 'assigned' || t.status === 'active');

		if (activeTasks.length === 0) {
			res.json({
				success: true,
				message: 'No active tasks found for session',
				sessionName,
				completedCount: 0,
				completedTasks: [],
			});
			return;
		}

		const completedTasks: string[] = [];
		let totalCancelledSchedules = 0;
		let totalUnsubscribedEvents = 0;

		for (const task of activeTasks) {
			try {
				// Move task file from in_progress/ to done/ if it exists
				if (task.taskFilePath && task.taskFilePath.includes('/in_progress/') && existsSync(task.taskFilePath)) {
					try {
						const targetPath = task.taskFilePath.replace('/in_progress/', '/done/');
						const targetDir = dirname(targetPath);
						await ensureDirectoryExists(targetDir);

						const taskContent = await readFile(task.taskFilePath, 'utf-8');
						const updatedContent = addTaskCompletionInfo(taskContent);
						await writeFile(targetPath, updatedContent, 'utf-8');
						await unlink(task.taskFilePath);

						logger.debug('Moved task file to done', {
							taskId: task.id,
							from: task.taskFilePath,
							to: targetPath,
						});
					} catch (fileError) {
						logger.warn('Failed to move task file to done (continuing with tracking cleanup)', {
							taskId: task.id,
							taskFilePath: task.taskFilePath,
							error: fileError instanceof Error ? fileError.message : String(fileError),
						});
					}
				}

				// Clean up monitoring resources
				const cleanup = await cleanupTaskMonitoring(this, task);
				totalCancelledSchedules += cleanup.cancelledSchedules;
				totalUnsubscribedEvents += cleanup.unsubscribedEvents;

				// Remove from tracking
				await this.taskTrackingService.removeTask(task.id);
				completedTasks.push(task.taskName);

				logger.info('Auto-completed task for session', {
					taskId: task.id,
					taskName: task.taskName,
					sessionName,
				});
			} catch (error) {
				logger.warn('Failed to auto-complete task', {
					taskId: task.id,
					taskName: task.taskName,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		res.json({
			success: true,
			message: `Completed ${completedTasks.length} task(s) for session ${sessionName}`,
			sessionName,
			completedCount: completedTasks.length,
			completedTasks,
			monitoringCleanup: {
				cancelledSchedules: totalCancelledSchedules,
				unsubscribedEvents: totalUnsubscribedEvents,
			},
		});
	} catch (error) {
		logger.error('Error completing tasks by session', { error: error instanceof Error ? error.message : String(error) });
		res.status(500).json({ success: false, error: 'Failed to complete tasks by session' });
	}
}

/**
 * GET /task-management/tasks
 *
 * List task files for a project, optionally filtered by status.
 * Returns task filenames and paths grouped by milestone.
 *
 * @param req - Request with query: { projectPath, status? }
 * @param res - Response with { success, tasks }
 */
/**
 * Detect and optionally clean up orphan tasks — tasks stuck in progress
 * assigned to agents that no longer exist or have been inactive too long.
 *
 * POST /api/task-management/cleanup
 * Body:
 *   - action: 'detect' (default, dry run) | 'cancel' | 'reopen'
 *   - staleThresholdHours: number (default 24)
 *   - taskIds: string[] (optional, specific tasks to clean; if omitted, cleans all detected orphans)
 *
 * @param req - Request with cleanup parameters
 * @param res - Response with orphan detection/cleanup report
 * @see https://github.com/stevehuang0115/crewly/issues/168
 */
export async function cleanupOrphanTasks(this: ApiController, req: Request, res: Response): Promise<void> {
	try {
		const {
			action = 'detect',
			staleThresholdHours = 24,
			taskIds,
		} = req.body;

		const staleThresholdMs = staleThresholdHours * 60 * 60 * 1000;

		const getTeamStatus = async () => {
			return await this.storageService.getTeams();
		};

		// Step 1: Detect orphan tasks
		const orphans = await this.taskTrackingService.detectOrphanTasks(getTeamStatus, staleThresholdMs);

		if (action === 'detect') {
			res.json({
				success: true,
				message: `Found ${orphans.length} orphan task(s)`,
				data: {
					orphanCount: orphans.length,
					orphans: orphans.map(t => ({
						id: t.id,
						taskName: t.taskName,
						assignedSessionName: t.assignedSessionName,
						assignedTeamMemberId: t.assignedTeamMemberId,
						status: t.status,
						assignedAt: t.assignedAt,
						staleSinceHours: Math.round(t.staleSinceMs / (60 * 60 * 1000) * 10) / 10,
						taskFilePath: t.taskFilePath,
					})),
				},
			});
			return;
		}

		// Step 2: Clean up
		const idsToClean = taskIds || orphans.map(t => t.id);
		if (idsToClean.length === 0) {
			res.json({ success: true, message: 'No orphan tasks to clean up', data: { cleaned: 0 } });
			return;
		}

		const cleanupAction = action === 'reopen' ? 'reopen' : 'cancel';
		const report = await this.taskTrackingService.cleanupOrphanTasks(idsToClean, cleanupAction);

		logger.info('Orphan task cleanup completed', {
			action: cleanupAction,
			cleaned: report.cleaned,
			errors: report.errors.length,
		});

		res.json({
			success: true,
			message: `Cleaned ${report.cleaned} orphan task(s) (action: ${cleanupAction})`,
			data: {
				cleaned: report.cleaned,
				errors: report.errors,
				totalOrphansDetected: orphans.length,
			},
		});
	} catch (error) {
		logger.error('Orphan task cleanup failed', { error: error instanceof Error ? error.message : String(error) });
		res.status(500).json({
			success: false,
			error: 'Failed to clean up orphan tasks',
			details: error instanceof Error ? error.message : String(error),
		});
	}
}

export async function listTasks(this: ApiController, req: Request, res: Response): Promise<void> {
	try {
		const projectPath = req.query.projectPath as string;
		const statusFilter = req.query.status as string | undefined;

		if (!projectPath) {
			res.status(400).json({ success: false, error: 'projectPath query parameter is required' });
			return;
		}

		// Validate status filter against known values to prevent path traversal
		const VALID_STATUSES = ['open', 'in_progress', 'blocked', 'done'] as const;
		if (statusFilter && !VALID_STATUSES.includes(statusFilter as typeof VALID_STATUSES[number])) {
			res.status(400).json({ success: false, error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
			return;
		}

		// Resolve and validate project path to prevent directory traversal
		const resolvedPath = resolve(projectPath);
		const tasksBasePath = join(resolvedPath, '.crewly', 'tasks');
		if (!existsSync(tasksBasePath)) {
			res.json({ success: true, tasks: [] });
			return;
		}

		const tasks: Array<{ name: string; path: string; milestone: string; status: string }> = [];
		const milestones = await readdir(tasksBasePath);

		for (const milestone of milestones) {
			const milestonePath = join(tasksBasePath, milestone);
			const milestoneStat = await stat(milestonePath).catch(() => null);
			if (!milestoneStat?.isDirectory()) continue;

			const statusDirs = statusFilter ? [statusFilter] : [...VALID_STATUSES];
			for (const status of statusDirs) {
				const statusPath = join(milestonePath, status);
				if (!existsSync(statusPath)) continue;

				const files = await readdir(statusPath);
				for (const file of files) {
					if (file.endsWith('.md')) {
						tasks.push({
							name: file.replace('.md', ''),
							path: join(statusPath, file),
							milestone,
							status,
						});
					}
				}
			}
		}

		res.json({ success: true, tasks });
	} catch (error) {
		logger.error('Error listing tasks', { error: error instanceof Error ? error.message : String(error) });
		res.status(500).json({ success: false, error: 'Failed to list tasks' });
	}
}

/**
 * Score a completed task's quality (#174).
 * Called by the auditor's score-task skill after task:completed events.
 * Updates the task's qualityScore in the tracking data.
 *
 * @param req - Request containing taskId, qualityScore, and optional scoredBy
 * @param res - Response with success status
 */
export async function scoreTask(this: ApiController, req: Request, res: Response): Promise<void> {
	try {
		const { taskId, qualityScore, scoredBy } = req.body;

		if (!taskId) {
			res.status(400).json({ success: false, error: 'taskId is required' });
			return;
		}

		if (typeof qualityScore !== 'number' || qualityScore < 0 || qualityScore > 100) {
			res.status(400).json({ success: false, error: 'qualityScore must be a number between 0 and 100' });
			return;
		}

		// Load task data directly for in-place update
		const taskData = await this.taskTrackingService.loadTaskData();
		const task = taskData.tasks.find(t => t.id === taskId);

		if (task) {
			// Task still in tracking — update in place and persist
			task.qualityScore = qualityScore;
			task.scoredAt = new Date().toISOString();
			task.scoredBy = scoredBy || 'auditor';
			await this.taskTrackingService.saveTaskData(taskData);

			logger.info('Task scored', { taskId, qualityScore, scoredBy: scoredBy || 'auditor' });
			res.json({ success: true, message: 'Task scored successfully', taskId, qualityScore });
		} else {
			// Task already removed from tracking — score acknowledged
			logger.warn('Task not found in tracking (may already be completed)', { taskId });
			res.json({ success: true, message: 'Score acknowledged but task already completed', taskId, qualityScore });
		}
	} catch (error) {
		logger.error('Error scoring task', { error: error instanceof Error ? error.message : String(error) });
		res.status(500).json({ success: false, error: 'Failed to score task' });
	}
}

/**
 * Record a task handoff from one agent to another (F12).
 *
 * POST /api/task-management/handoff
 * Body: { from, to, taskPath?, reason, progress?, projectPath? }
 *
 * Updates the task tracking data to reflect the handoff and logs the event.
 *
 * @param req - Request with handoff parameters
 * @param res - Response with handoff record
 */
export async function recordHandoff(this: ApiController, req: Request, res: Response): Promise<void> {
	try {
		const { from, to, taskPath, reason, progress, projectPath } = req.body;

		if (!from || !to || !reason) {
			res.status(400).json({ success: false, error: 'from, to, and reason are required' });
			return;
		}

		// Find the task being handed off (by assignedSessionName)
		const tasks = await this.taskTrackingService.getTasksBySessionName(from);
		const activeTask = tasks.find(t =>
			t.status === 'assigned' || t.status === 'active' || t.status === 'working'
		);

		if (activeTask) {
			// Update task assignment to new agent
			const data = await this.taskTrackingService.loadTaskData();
			const task = data.tasks.find(t => t.id === activeTask.id);
			if (task) {
				task.assignedSessionName = to;
				task.status = 'assigned';
				task.statusHistory = task.statusHistory || [];
				task.statusHistory.push({
					timestamp: new Date().toISOString(),
					fromStatus: activeTask.status,
					toStatus: 'assigned',
					message: `Handed off from ${from} to ${to}: ${reason}`,
					reportedBy: from,
				});
				await this.taskTrackingService.saveTaskData(data);
			}
		}

		logger.info('Task handoff recorded', { from, to, reason, taskId: activeTask?.id });

		res.json({
			success: true,
			handoff: {
				from,
				to,
				reason,
				taskId: activeTask?.id || null,
				taskPath: taskPath || null,
				progress: progress || null,
				timestamp: new Date().toISOString(),
			},
		});
	} catch (error) {
		logger.error('Error recording handoff', { error: error instanceof Error ? error.message : String(error) });
		res.status(500).json({ success: false, error: 'Failed to record handoff' });
	}
}

/**
 * Accept a task — agent acknowledges the task with a structured understanding.
 * Transitions task from 'assigned' to 'accepted'.
 *
 * @param req - Request containing taskId, sessionName, and understanding
 * @param res - Response with the updated task or error
 */
export async function acceptTask(this: ApiController, req: Request, res: Response): Promise<void> {
	try {
		const { taskId, sessionName, understanding } = req.body;

		if (!taskId) {
			res.status(400).json({ success: false, error: 'taskId is required' });
			return;
		}
		if (!sessionName) {
			res.status(400).json({ success: false, error: 'sessionName is required' });
			return;
		}
		if (!understanding) {
			res.status(400).json({ success: false, error: 'understanding is required — provide your interpretation of the task scope and deliverables' });
			return;
		}

		const task = await this.taskTrackingService.acceptTask(taskId, sessionName, understanding);

		logger.info('Task accepted', { taskId, sessionName, understanding: understanding.substring(0, 100) });

		res.json({
			success: true,
			message: `Task '${task.taskName}' accepted`,
			task,
		});
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		logger.error('Error accepting task', { error: msg });
		res.status(400).json({ success: false, error: msg });
	}
}

/**
 * Request clarification on a task — agent signals that the task description is unclear.
 * Transitions task from 'assigned' or 'accepted' to 'needs_clarification'.
 *
 * @param req - Request containing taskId, sessionName, and question
 * @param res - Response with the updated task or error
 */
export async function requestClarification(this: ApiController, req: Request, res: Response): Promise<void> {
	try {
		const { taskId, sessionName, question } = req.body;

		if (!taskId) {
			res.status(400).json({ success: false, error: 'taskId is required' });
			return;
		}
		if (!sessionName) {
			res.status(400).json({ success: false, error: 'sessionName is required' });
			return;
		}
		if (!question) {
			res.status(400).json({ success: false, error: 'question is required — describe what you need clarified' });
			return;
		}

		const task = await this.taskTrackingService.requestClarification(taskId, sessionName, question);

		logger.info('Task clarification requested', { taskId, sessionName, question: question.substring(0, 100) });

		res.json({
			success: true,
			message: `Clarification requested for task '${task.taskName}'`,
			task,
		});
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		logger.error('Error requesting clarification', { error: msg });
		res.status(400).json({ success: false, error: msg });
	}
}

/**
 * Save working notes for a task — persists agent's current working state
 * across session restarts.
 *
 * @param req - Request containing taskId, sessionName, and notes
 * @param res - Response with success status
 */
export async function saveWorkingNotes(this: ApiController, req: Request, res: Response): Promise<void> {
	try {
		const { taskId, sessionName, notes } = req.body;

		if (!taskId) {
			res.status(400).json({ success: false, error: 'taskId is required' });
			return;
		}
		if (!sessionName) {
			res.status(400).json({ success: false, error: 'sessionName is required' });
			return;
		}
		if (notes === undefined || notes === null) {
			res.status(400).json({ success: false, error: 'notes is required' });
			return;
		}

		await this.taskTrackingService.updateWorkingNotes(taskId, sessionName, notes);

		logger.info('Working notes saved', { taskId, sessionName, notesLength: notes.length });

		res.json({
			success: true,
			message: 'Working notes saved',
		});
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		logger.error('Error saving working notes', { error: msg });
		res.status(400).json({ success: false, error: msg });
	}
}
