import { Router, Request, Response } from 'express';
import os from 'os';
import path from 'path';
import fs from 'fs';

const router = Router();
const packageJsonPath = path.join(__dirname, '../../package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const appVersion = packageJson.version;

router.get('/health', (req: Request, res: Response) => {
  const uptime = process.uptime();
  const memoryUsage = process.memoryUsage();
  const usedMb = memoryUsage.rss / 1024 / 1024; // Resident Set Size in MB

  const memoryStatus = usedMb > 512 ? 'warning' : 'ok';

  // Simple event loop latency check (approximation)
  const hrtime = process.hrtime();
  setTimeout(() => {
    const diff = process.hrtime(hrtime);
    const latencyMs = (diff[0] * 1000 + diff[1] / 1000000); // Convert to milliseconds
    const eventLoopStatus = latencyMs > 100 ? 'warning' : 'ok';

    const overallStatus = memoryStatus === 'warning' || eventLoopStatus === 'warning' ? 'degraded' : 'healthy';

    res.status(200).json({
      status: overallStatus,
      uptime: Math.floor(uptime),
      version: appVersion,
      timestamp: new Date().toISOString(),
      checks: {
        memory: { status: memoryStatus, usedMb: parseFloat(usedMb.toFixed(2)), maxMb: 512 },
        eventLoop: { status: eventLoopStatus, latencyMs: parseFloat(latencyMs.toFixed(2)) }
      }
    });
  }, 0); // Schedule immediately to measure latency
});

export default router;
