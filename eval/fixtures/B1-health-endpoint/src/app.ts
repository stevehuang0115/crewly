/**
 * Express application setup.
 * The agent needs to add a /health route here.
 */

import express from 'express';

const app = express();

app.use(express.json());

/** Root endpoint */
app.get('/', (_req, res) => {
  res.json({ message: 'Hello from B1 fixture' });
});

// TODO: Add /health endpoint

export { app };
