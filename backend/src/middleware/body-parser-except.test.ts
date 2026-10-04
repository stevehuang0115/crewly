import express from 'express';
import request from 'supertest';
import { bodyParserExcept } from './body-parser-except.js';

describe('bodyParserExcept', () => {
  const app = express();
  app.use(bodyParserExcept(['/api/apps/publish'], express.json({ limit: '1kb' })));
  app.post('*', (req, res) => {
    res.json({ parsed: req.body !== undefined && Object.keys(req.body ?? {}).length > 0 });
  });

  it('parses other paths', async () => {
    const res = await request(app).post('/api/x').send({ a: 1 });
    expect(res.body).toEqual({ parsed: true });
  });

  it('leaves the skipped path unparsed, with or without a trailing slash', async () => {
    expect((await request(app).post('/api/apps/publish').send({ a: 1 })).body).toEqual({ parsed: false });
    expect((await request(app).post('/api/apps/publish/').send({ a: 1 })).body).toEqual({ parsed: false });
  });

  it('does not apply the size limit to the skipped path', async () => {
    const res = await request(app).post('/api/apps/publish').set('Content-Type', 'application/json').send(JSON.stringify({ a: 'x'.repeat(5000) }));
    expect(res.status).toBe(200);
  });
});
