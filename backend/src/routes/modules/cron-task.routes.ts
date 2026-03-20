import { Router } from 'express';
import * as cronTaskHandlers from '../../controllers/system/cron-task.controller.js';

export function registerCronTaskRoutes(router: Router): void {
	router.post('/cron-tasks', cronTaskHandlers.createCronTask);
	router.get('/cron-tasks', cronTaskHandlers.listCronTasks);
	router.patch('/cron-tasks/:id', cronTaskHandlers.updateCronTask);
	router.delete('/cron-tasks/:id', cronTaskHandlers.deleteCronTask);
}
