import { Router } from 'express';
import type { ApiContext } from '../types.js';
import { listTeamCronTasks } from '../system/cron-task.controller.js';
import { cacheResponse, invalidateCache } from '../../middleware/cache.middleware.js';
import { REDIS_CONSTANTS } from '../../../../config/constants.js';
import {
  createTeam,
  getTeams,
  getTeam,
  updateTeam,
  startTeam,
  stopTeam,
  getTeamWorkload,
  deleteTeam,
  getTeamMemberSession,
  addTeamMember,
  updateTeamMember,
  deleteTeamMember,
  startTeamMember,
  stopTeamMember,
  reportMemberReady,
  registerMemberStatus,
  generateMemberContext,
  injectContextIntoSession,
  refreshMemberContext,
  getTeamActivityStatus,
  updateTeamMemberRuntime,
  archiveTeam
} from './team.controller.js';
import { exportTeam, importTeam } from './team-export.controller.js';

/**
 * Creates team router with all team-related endpoints
 * @param context - API context with services
 * @returns Express router configured with team routes
 */
export function createTeamRouter(context: ApiContext): Router {
  const router = Router();

  // Cache keys for invalidation on mutations
  const teamsCacheKeys = [REDIS_CONSTANTS.KEYS.TEAMS_LIST];

  // Team CRUD operations
  router.post('/', invalidateCache(teamsCacheKeys), createTeam.bind(context));
  router.get('/', cacheResponse(REDIS_CONSTANTS.KEYS.TEAMS_LIST, REDIS_CONSTANTS.TTL.TEAMS_LIST), getTeams.bind(context));
  router.get('/:id', getTeam.bind(context));
  router.put('/:id', invalidateCache(teamsCacheKeys), updateTeam.bind(context));
  router.patch('/:id', invalidateCache(teamsCacheKeys), updateTeam.bind(context));
  router.delete('/:id', invalidateCache(teamsCacheKeys), deleteTeam.bind(context));

  // Team lifecycle management
  router.post('/:id/start', invalidateCache(teamsCacheKeys), startTeam.bind(context));
  router.post('/:id/stop', invalidateCache(teamsCacheKeys), stopTeam.bind(context));
  router.post('/:id/archive', invalidateCache(teamsCacheKeys), archiveTeam.bind(context));
  router.get('/:id/workload', getTeamWorkload.bind(context));

  // Team member management
  router.post('/:id/members', invalidateCache(teamsCacheKeys), addTeamMember.bind(context));
  router.put('/:teamId/members/:memberId', invalidateCache(teamsCacheKeys), updateTeamMember.bind(context));
  router.patch('/:teamId/members/:memberId', invalidateCache(teamsCacheKeys), updateTeamMember.bind(context));
  router.delete('/:teamId/members/:memberId', invalidateCache(teamsCacheKeys), deleteTeamMember.bind(context));

  // Team member lifecycle
  router.post('/:teamId/members/:memberId/start', startTeamMember.bind(context));
  router.post('/:teamId/members/:memberId/stop', stopTeamMember.bind(context));

  // Team member sessions and monitoring
  router.get('/:teamId/members/:memberId/session', getTeamMemberSession.bind(context));
  router.post('/members/ready', reportMemberReady.bind(context));
  router.post('/members/register', registerMemberStatus.bind(context));

  // Context management
  router.get('/:teamId/members/:memberId/context', generateMemberContext.bind(context));
  router.post('/:teamId/members/:memberId/context/inject', injectContextIntoSession.bind(context));
  router.post('/:teamId/members/:memberId/context/refresh', refreshMemberContext.bind(context));

  // Team-scoped cron tasks
  router.get('/:id/cron-tasks', listTeamCronTasks);

  // Team activity monitoring
  router.get('/activity-status', getTeamActivityStatus.bind(context));

  // Runtime management
  router.put('/:teamId/members/:memberId/runtime', updateTeamMemberRuntime.bind(context));

  // Team export/import
  router.get('/:teamId/export', exportTeam.bind(context));
  router.post('/import', importTeam.bind(context));

  return router;
}