import request from 'supertest';
import express from 'express';
import healthRouter from './health.route';

const app = express();
app.use(healthRouter);

describe('GET /health', () => {
    it('should return a health check response', async () => {
        const res = await request(app).get('/health');
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('status');
        expect(res.body).toHaveProperty('uptime');
        expect(res.body).toHaveProperty('version');
        expect(res.body).toHaveProperty('timestamp');
        expect(res.body).toHaveProperty('checks');
        expect(res.body.checks).toHaveProperty('memory');
        expect(res.body.checks).toHaveProperty('eventLoop');
    });

    it('should have the correct schema', async () => {
        const res = await request(app).get('/health');
        expect(typeof res.body.status).toBe('string');
        expect(typeof res.body.uptime).toBe('number');
        expect(typeof res.body.version).toBe('string');
        expect(typeof res.body.timestamp).toBe('string');
        expect(typeof res.body.checks.memory.status).toBe('string');
        expect(typeof res.body.checks.memory.usedMb).toBe('number');
        expect(typeof res.body.checks.memory.maxMb).toBe('number');
        expect(typeof res.body.checks.eventLoop.status).toBe('string');
        expect(typeof res.body.checks.eventLoop.latencyMs).toBe('number');
    });
});
