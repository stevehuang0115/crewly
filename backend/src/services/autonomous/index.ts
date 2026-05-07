/**
 * Autonomous Services
 *
 * Services that enable autonomous agent behavior.
 *
 * As of spec 2026-05-06-task-management-v1-deprecation.md, the auto-claim
 * autonomy loop lives at `services/v3/agent-auto-claim.service.ts` (V3
 * task-pool native). The legacy `AutoAssignService` (filesystem-based,
 * v1-shaped) has been retired — `BudgetService` is the only survivor in
 * this barrel.
 *
 * @module services/autonomous
 */

export { BudgetService, IBudgetService } from './budget.service.js';
