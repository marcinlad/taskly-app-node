import express from 'express';
import request from 'supertest';
import { afterEach, it, expect, vi } from 'vitest';
import { createHealthRouter } from '../src/api/health.ts';
import { createDatabase } from '../src/core/database.ts';

afterEach(() => vi.restoreAllMocks());

function setup() {
  const database = createDatabase('postgresql://test:test@localhost:5432/test');
  const app = express();
  app.use('/api', createHealthRouter(database));
  return { app, database };
}

it('reports ok after a lightweight database query succeeds', async () => {
  const { app, database } = setup();
  const findFirst = vi.spyOn(database.todo, 'findFirst').mockResolvedValue(null);
  const response = await request(app).get('/api/health');
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ status: 'ok' });
  expect(findFirst).toHaveBeenCalledWith({ select: { id: true } });
});
it('forwards database failures to the error handler instead of reporting ok', async () => {
  const { app, database } = setup();
  vi.spyOn(database.todo, 'findFirst').mockRejectedValue(new Error('Database unavailable'));
  const errors: unknown[] = [];
  app.use((error: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    errors.push(error);
    res.status(503).json({ detail: 'down' });
  });
  const response = await request(app).get('/api/health');
  expect(response.status).toBe(503);
  expect(errors).toEqual([new Error('Database unavailable')]);
});
