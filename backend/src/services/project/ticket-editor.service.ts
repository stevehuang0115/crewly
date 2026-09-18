import * as fs from 'fs/promises';
import * as path from 'path';
import { existsSync } from 'fs';
import { parse as parseYAML, stringify as stringifyYAML } from 'yaml';
import { Ticket, TicketFilter } from '../../types/index.js';
import {
  ContinuationTrackingData,
  IterationRecord,
  QualityGates,
  QualityGateStatus,
  REQUIRED_QUALITY_GATES,
} from '../../types/task-tracking.types.js';
import { CONTINUATION_CONSTANTS } from '../../constants.js';
import { v4 as uuidv4 } from 'uuid';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { resolveProjectDataDir } from '../core/crewly-home.utils.js';

export interface Subtask {
  id: string;
  title: string;
  completed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ExtendedTicket extends Omit<Ticket, 'projectId'> {
  tags?: string[];
  subtasks: Subtask[];
  dueDate?: string;
  estimatedHours?: number;
  actualHours?: number;
  /** Continuation tracking data */
  continuation?: ContinuationTrackingData;
  /** Quality gate statuses */
  qualityGates?: QualityGates;
}

export interface TicketTemplate {
  title: string;
  description: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  status: 'open' | 'in_progress' | 'review' | 'done' | 'blocked';
  assignedTo?: string;
  tags?: string[];
  subtasks?: Array<{
    title: string;
    completed: boolean;
  }>;
  dueDate?: string;
  estimatedHours?: number;
}

export class TicketEditorService {
  private ticketsDir: string;
  private readonly logger: ComponentLogger = LoggerService.getInstance().createComponentLogger('TicketEditorService');

  constructor(projectPath?: string) {
    this.ticketsDir = path.join(resolveProjectDataDir(path.resolve(projectPath ?? process.cwd())), 'tasks');
  }

  async ensureTicketsDirectory(): Promise<void> {
    if (!existsSync(this.ticketsDir)) {
      await fs.mkdir(this.ticketsDir, { recursive: true });
    }
  }

  async createTicket(template: TicketTemplate): Promise<ExtendedTicket> {
    await this.ensureTicketsDirectory();

    const ticket: ExtendedTicket = {
      id: uuidv4(),
      title: template.title,
      description: template.description,
      status: template.status,
      priority: template.priority,
      assignedTo: template.assignedTo,
      tags: template.tags || [],
      subtasks: template.subtasks?.map(st => ({
        id: uuidv4(),
        title: st.title,
        completed: st.completed,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })) || [],
      dueDate: template.dueDate,
      estimatedHours: template.estimatedHours,
      actualHours: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const fileName = `${ticket.id}.yaml`;
    const filePath = path.join(this.ticketsDir, fileName);
    
    const yamlContent = stringifyYAML(ticket);

    await fs.writeFile(filePath, yamlContent, 'utf-8');
    return ticket;
  }

  async updateTicket(ticketId: string, updates: Partial<TicketTemplate>): Promise<ExtendedTicket> {
    const ticket = await this.getTicket(ticketId);
    if (!ticket) {
      throw new Error(`Ticket ${ticketId} not found`);
    }

    const updatedTicket: ExtendedTicket = {
      ...ticket,
      ...(updates as any),
      updatedAt: new Date().toISOString()
    };

    const fileName = `${ticketId}.yaml`;
    const filePath = path.join(this.ticketsDir, fileName);
    
    const yamlContent = stringifyYAML(updatedTicket);

    await fs.writeFile(filePath, yamlContent, 'utf-8');
    return updatedTicket;
  }

  async getTicket(ticketId: string): Promise<ExtendedTicket | null> {
    const fileName = `${ticketId}.yaml`;
    const filePath = path.join(this.ticketsDir, fileName);

    if (!existsSync(filePath)) {
      return null;
    }

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return parseYAML(content) as ExtendedTicket;
    } catch (error) {
      this.logger.error('Error reading ticket', { ticketId, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  async getAllTickets(filter?: TicketFilter): Promise<ExtendedTicket[]> {
    await this.ensureTicketsDirectory();

    if (!existsSync(this.ticketsDir)) {
      return [];
    }

    const files = await fs.readdir(this.ticketsDir);
    const yamlFiles = files.filter(file => file.endsWith('.yaml'));
    
    const tickets: ExtendedTicket[] = [];
    
    for (const file of yamlFiles) {
      const filePath = path.join(this.ticketsDir, file);
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const ticket = parseYAML(content) as ExtendedTicket;
        
        // Apply filters
        if (filter) {
          if (filter.status && ticket.status !== filter.status) continue;
          if (filter.assignedTo && ticket.assignedTo !== filter.assignedTo) continue;
          if (filter.priority && ticket.priority !== filter.priority) continue;
        }
        
        tickets.push(ticket);
      } catch (error) {
        this.logger.error('Error reading ticket file', { file, error: error instanceof Error ? error.message : String(error) });
      }
    }

    // Sort by priority and created date
    return tickets.sort((a, b) => {
      const priorityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
      const aPriority = priorityOrder[a.priority] || 0;
      const bPriority = priorityOrder[b.priority] || 0;
      
      if (aPriority !== bPriority) {
        return bPriority - aPriority; // Higher priority first
      }
      
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }

  async deleteTicket(ticketId: string): Promise<boolean> {
    const fileName = `${ticketId}.yaml`;
    const filePath = path.join(this.ticketsDir, fileName);

    if (!existsSync(filePath)) {
      return false;
    }

    try {
      await fs.unlink(filePath);
      return true;
    } catch (error) {
      this.logger.error('Error deleting ticket', { ticketId, error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }

  async addSubtask(ticketId: string, subtaskTitle: string): Promise<ExtendedTicket | null> {
    const ticket = await this.getTicket(ticketId);
    if (!ticket) {
      return null;
    }

    const newSubtask = {
      id: uuidv4(),
      title: subtaskTitle,
      completed: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    ticket.subtasks.push(newSubtask);
    ticket.updatedAt = new Date().toISOString();

    return await this.updateTicket(ticketId, ticket as any);
  }

  async toggleSubtask(ticketId: string, subtaskId: string): Promise<ExtendedTicket | null> {
    const ticket = await this.getTicket(ticketId);
    if (!ticket) {
      return null;
    }

    const subtask = ticket.subtasks.find(st => st.id === subtaskId);
    if (!subtask) {
      return null;
    }

    subtask.completed = !subtask.completed;
    subtask.updatedAt = new Date().toISOString();
    ticket.updatedAt = new Date().toISOString();

    return await this.updateTicket(ticketId, ticket as any);
  }

  async getTicketsByAssignee(assignedTo: string): Promise<ExtendedTicket[]> {
    return await this.getAllTickets({ assignedTo });
  }

  async getTicketsByStatus(status: string): Promise<ExtendedTicket[]> {
    return await this.getAllTickets({ status });
  }

  async getTicketsByPriority(priority: string): Promise<ExtendedTicket[]> {
    return await this.getAllTickets({ priority });
  }

  // Template management
  async createTicketTemplate(name: string, template: TicketTemplate): Promise<void> {
    const templatesDir = path.join(this.ticketsDir, 'templates');
    if (!existsSync(templatesDir)) {
      await fs.mkdir(templatesDir, { recursive: true });
    }

    const templatePath = path.join(templatesDir, `${name}.yaml`);
    const yamlContent = stringifyYAML(template);

    await fs.writeFile(templatePath, yamlContent, 'utf-8');
  }

  async getTicketTemplate(name: string): Promise<TicketTemplate | null> {
    const templatesDir = path.join(this.ticketsDir, 'templates');
    const templatePath = path.join(templatesDir, `${name}.yaml`);

    if (!existsSync(templatePath)) {
      return null;
    }

    try {
      const content = await fs.readFile(templatePath, 'utf-8');
      return parseYAML(content) as TicketTemplate;
    } catch (error) {
      this.logger.error('Error reading template', { name, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  async getAllTemplates(): Promise<string[]> {
    const templatesDir = path.join(this.ticketsDir, 'templates');

    if (!existsSync(templatesDir)) {
      return [];
    }

    const files = await fs.readdir(templatesDir);
    return files.filter(file => file.endsWith('.yaml')).map(file => file.replace('.yaml', ''));
  }

  // ============================================
  // Iteration Tracking
  // ============================================

  /**
   * Increment the iteration count for a ticket
   *
   * @param ticketId - Ticket identifier
   * @param record - Iteration record (timestamp will be added)
   * @returns New iteration count
   */
  async incrementIteration(
    ticketId: string,
    record: Omit<IterationRecord, 'timestamp'>
  ): Promise<number> {
    const ticket = await this.getTicket(ticketId);
    if (!ticket) {
      throw new Error(`Ticket ${ticketId} not found`);
    }

    // Initialize continuation tracking if needed
    if (!ticket.continuation) {
      ticket.continuation = {
        iterations: 0,
        maxIterations: CONTINUATION_CONSTANTS.ITERATIONS.DEFAULT_MAX,
        iterationHistory: [],
      };
    }

    // Increment and record
    ticket.continuation.iterations++;
    ticket.continuation.lastIteration = new Date().toISOString();
    ticket.continuation.iterationHistory.push({
      ...record,
      timestamp: new Date().toISOString(),
    });

    // Trim history if too long (keep last 20)
    if (ticket.continuation.iterationHistory.length > 20) {
      ticket.continuation.iterationHistory = ticket.continuation.iterationHistory.slice(-20);
    }

    await this.updateTicket(ticketId, ticket as unknown as Partial<TicketTemplate>);
    return ticket.continuation.iterations;
  }

  /**
   * Set the maximum iterations for a ticket
   *
   * @param ticketId - Ticket identifier
   * @param max - Maximum iterations allowed
   */
  async setMaxIterations(ticketId: string, max: number): Promise<void> {
    const ticket = await this.getTicket(ticketId);
    if (!ticket) {
      throw new Error(`Ticket ${ticketId} not found`);
    }

    // Clamp to absolute max
    const clampedMax = Math.min(max, CONTINUATION_CONSTANTS.ITERATIONS.ABSOLUTE_MAX);

    if (!ticket.continuation) {
      ticket.continuation = {
        iterations: 0,
        maxIterations: clampedMax,
        iterationHistory: [],
      };
    } else {
      ticket.continuation.maxIterations = clampedMax;
    }

    await this.updateTicket(ticketId, ticket as unknown as Partial<TicketTemplate>);
  }

  /**
   * Get the iteration count for a ticket
   *
   * @param ticketId - Ticket identifier
   * @returns Current and max iteration counts
   */
  async getIterationCount(ticketId: string): Promise<{ current: number; max: number }> {
    const ticket = await this.getTicket(ticketId);
    if (!ticket) {
      throw new Error(`Ticket ${ticketId} not found`);
    }

    return {
      current: ticket.continuation?.iterations || 0,
      max: ticket.continuation?.maxIterations || CONTINUATION_CONSTANTS.ITERATIONS.DEFAULT_MAX,
    };
  }

  /**
   * Get the iteration history for a ticket
   *
   * @param ticketId - Ticket identifier
   * @returns Iteration history
   */
  async getIterationHistory(ticketId: string): Promise<IterationRecord[]> {
    const ticket = await this.getTicket(ticketId);
    if (!ticket) {
      throw new Error(`Ticket ${ticketId} not found`);
    }

    return ticket.continuation?.iterationHistory || [];
  }

  /**
   * Reset iterations for a ticket (e.g., when re-assigning)
   *
   * @param ticketId - Ticket identifier
   */
  async resetIterations(ticketId: string): Promise<void> {
    const ticket = await this.getTicket(ticketId);
    if (!ticket) {
      throw new Error(`Ticket ${ticketId} not found`);
    }

    if (ticket.continuation) {
      ticket.continuation.iterations = 0;
      ticket.continuation.iterationHistory = [];
      ticket.continuation.lastIteration = undefined;
    }

    // Also reset quality gates
    if (ticket.qualityGates) {
      for (const gate of Object.keys(ticket.qualityGates)) {
        ticket.qualityGates[gate] = { passed: false };
      }
    }

    await this.updateTicket(ticketId, ticket as unknown as Partial<TicketTemplate>);
  }

  // ============================================
  // Quality Gates
  // ============================================

  /**
   * Update the status of a quality gate
   *
   * @param ticketId - Ticket identifier
   * @param gateName - Gate name (typecheck, tests, lint, build, or custom)
   * @param status - Gate status
   */
  async updateQualityGate(
    ticketId: string,
    gateName: string,
    status: Omit<QualityGateStatus, 'lastRun'>
  ): Promise<void> {
    const ticket = await this.getTicket(ticketId);
    if (!ticket) {
      throw new Error(`Ticket ${ticketId} not found`);
    }

    if (!ticket.qualityGates) {
      ticket.qualityGates = {};
    }

    // Truncate output if too long (max 1000 chars)
    const output = status.output ? status.output.slice(0, 1000) : undefined;

    ticket.qualityGates[gateName] = {
      passed: status.passed,
      output,
      lastRun: new Date().toISOString(),
    };

    await this.updateTicket(ticketId, ticket as unknown as Partial<TicketTemplate>);
  }

  /**
   * Get all quality gates for a ticket
   *
   * @param ticketId - Ticket identifier
   * @returns Quality gates
   */
  async getQualityGates(ticketId: string): Promise<QualityGates> {
    const ticket = await this.getTicket(ticketId);
    if (!ticket) {
      throw new Error(`Ticket ${ticketId} not found`);
    }

    return ticket.qualityGates || {};
  }

  /**
   * Check if all required quality gates are passing
   *
   * @param ticketId - Ticket identifier
   * @returns True if all required gates pass
   */
  async areAllGatesPassing(ticketId: string): Promise<boolean> {
    const gates = await this.getQualityGates(ticketId);

    return REQUIRED_QUALITY_GATES.every((gate) => gates[gate]?.passed === true);
  }

  /**
   * Get failed quality gates
   *
   * @param ticketId - Ticket identifier
   * @returns Array of failed gate names and statuses
   */
  async getFailedGates(ticketId: string): Promise<Array<{ name: string; status: QualityGateStatus }>> {
    const gates = await this.getQualityGates(ticketId);
    const failed: Array<{ name: string; status: QualityGateStatus }> = [];

    for (const gate of REQUIRED_QUALITY_GATES) {
      if (gates[gate] && !gates[gate]!.passed) {
        failed.push({ name: gate, status: gates[gate]! });
      }
    }

    return failed;
  }

  /**
   * Initialize quality gates with default values
   *
   * @param ticketId - Ticket identifier
   */
  async initializeQualityGates(ticketId: string): Promise<void> {
    const ticket = await this.getTicket(ticketId);
    if (!ticket) {
      throw new Error(`Ticket ${ticketId} not found`);
    }

    ticket.qualityGates = {
      typecheck: { passed: false },
      tests: { passed: false },
      lint: { passed: false },
      build: { passed: false },
    };

    await this.updateTicket(ticketId, ticket as unknown as Partial<TicketTemplate>);
  }
}