import request from 'supertest';
import { afterEach, it, expect, vi } from 'vitest';
import { createApp } from '../src/factory.ts';
import { createDatabase } from '../src/core/database.ts';
import { record, todo } from './fixture.ts';

afterEach(() => vi.restoreAllMocks());

function setup() {
  const database = createDatabase('postgresql://test:test@localhost:5432/test');
  return { app: createApp(database), database };
}

it('mounts the health check under /api', async () => {
  const { app, database } = setup();
  vi.spyOn(database.todo, 'findFirst').mockResolvedValue(null);
  const response = await request(app).get('/api/health');
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ status: 'ok' });
});
it('mounts the todos router backed by the Prisma repository', async () => {
  const { app, database } = setup();
  const findMany = vi.spyOn(database.todo, 'findMany').mockResolvedValue([record]);
  const response = await request(app).get('/api/todos');
  expect(response.status).toBe(200);
  expect(response.body).toEqual([todo]);
  expect(findMany).toHaveBeenCalledOnce();
});
it('does not advertise Express in the X-Powered-By header', async () => {
  const { app, database } = setup();
  vi.spyOn(database.todo, 'findFirst').mockResolvedValue(null);
  const response = await request(app).get('/api/health');
  expect(response.headers['x-powered-by']).toBeUndefined();
});
it('serves the OpenAPI specification as JSON', async () => {
  const { app } = setup();
  const response = await request(app).get('/openapi.json');
  expect(response.status).toBe(200);
  expect(response.headers['content-type']).toMatch(/application\/json/);
  expect(response.body.openapi).toBe('3.0.3');
  expect(response.body.info).toEqual({ title: 'Taskly App Node API', version: '1.0.0' });
});
it('serves the Swagger UI under /docs', async () => {
  const { app } = setup();
  const response = await request(app).get('/docs/');
  expect(response.status).toBe(200);
  expect(response.headers['content-type']).toMatch(/text\/html/);
  expect(response.text).toContain('swagger-ui');
});
it.each([['GET', '/unknown'], ['GET', '/api/unknown'], ['PUT', '/api/todos']])('responds 404 JSON for unmatched route %s %s', async (method, path) => {
  const { app } = setup();
  const response = await request(app)[method.toLowerCase() as 'get' | 'put'](path);
  expect(response.status).toBe(404);
  expect(response.body).toEqual({ detail: 'Not Found' });
});
it('responds 422 for malformed JSON without calling the database', async () => {
  const { app, database } = setup();
  const create = vi.spyOn(database.todo, 'create');
  const response = await request(app).post('/api/todos').set('Content-Type', 'application/json').send('{"title":');
  expect(response.status).toBe(422);
  expect(response.body).toEqual({ detail: 'Invalid JSON.' });
  expect(create).not.toHaveBeenCalled();
});
it('responds 413 for a JSON body larger than the parser limit', async () => {
  const { app, database } = setup();
  const create = vi.spyOn(database.todo, 'create');
  const response = await request(app).post('/api/todos').set('Content-Type', 'application/json')
    .send(JSON.stringify({ title: 'Task', description: 'x'.repeat(200 * 1024) }));
  expect(response.status).toBe(413);
  expect(response.body).toEqual({ detail: 'Request body too large.' });
  expect(create).not.toHaveBeenCalled();
});
it('logs unexpected errors and responds with a generic 500', async () => {
  const { app, database } = setup();
  const failure = new Error('Database unavailable');
  vi.spyOn(database.todo, 'findMany').mockRejectedValue(failure);
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  const response = await request(app).get('/api/todos');
  expect(response.status).toBe(500);
  expect(response.body).toEqual({ detail: 'Internal Server Error' });
  expect(consoleError).toHaveBeenCalledWith(failure);
});
it('treats thrown non-object values as unexpected errors', async () => {
  const { app, database } = setup();
  vi.spyOn(database.todo, 'findFirst').mockRejectedValue('boom');
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  const response = await request(app).get('/api/health');
  expect(response.status).toBe(500);
  expect(response.body).toEqual({ detail: 'Internal Server Error' });
  expect(consoleError).toHaveBeenCalledWith('boom');
});
