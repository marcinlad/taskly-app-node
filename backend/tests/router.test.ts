import express from 'express';
import request from 'supertest';
import { it, expect, vi } from 'vitest';
import { createTodosRouter } from '../src/features/todos/router.ts';
import { todo } from './fixture.ts';

function setup() {
  const repository = { list: vi.fn().mockResolvedValue([todo]), create: vi.fn().mockResolvedValue(todo), get: vi.fn(), update: vi.fn(), delete: vi.fn(), deleteCompleted: vi.fn() };
  const app = express();
  app.use(express.json());
  app.use('/api/todos', createTodosRouter(repository));
  return { app, repository };
}
it('lists tasks from the repository', async () => {
  const { app, repository } = setup();
  const response = await request(app).get('/api/todos');
  expect(response.status).toBe(200);
  expect(response.body).toEqual([todo]);
  expect(repository.list).toHaveBeenCalledOnce();
});
it('creates tasks with trimmed input and defaults', async () => {
  const { app, repository } = setup();
  const response = await request(app).post('/api/todos').send({ title: '  Plan the sprint  ', priority: 'high' });
  expect(response.status).toBe(201);
  expect(response.body).toEqual(todo);
  expect(repository.create).toHaveBeenCalledWith({ title: 'Plan the sprint', description: '', priority: 'high', due_date: null, completed: false });
});
it.each([{ title: '  ' }, { title: 'x'.repeat(121) }, { title: 'Task', priority: 'urgent' }, { title: 'Task', due_date: '2026-02-30' }])(
  'rejects invalid create input without calling the repository: %j', async (payload) => {
    const { app, repository } = setup();
    expect((await request(app).post('/api/todos').send(payload)).status).toBe(422);
    expect(repository.create).not.toHaveBeenCalled();
  },
);

it('clears completed tasks and responds with the deleted count', async () => {
  const { app, repository } = setup();
  repository.deleteCompleted.mockResolvedValue(3);
  const response = await request(app).delete('/api/todos?completed=true');
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ deleted: 3 });
  expect(repository.deleteCompleted).toHaveBeenCalledOnce();
  expect(repository.deleteCompleted).toHaveBeenCalledWith();
  expect(repository.delete).not.toHaveBeenCalled();
});
it('responds with a zero count when there are no completed tasks to clear', async () => {
  const { app, repository } = setup();
  repository.deleteCompleted.mockResolvedValue(0);
  const response = await request(app).delete('/api/todos?completed=true');
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ deleted: 0 });
});
it.each(['', '?completed=false', '?completed=1', '?completed=TRUE', '?completed=', '?completed=true&completed=true', '?completed=true&all=true'])(
  'rejects clearing tasks with the query "%s" without calling the repository', async (query) => {
    const { app, repository } = setup();
    const response = await request(app).delete(`/api/todos${query}`);
    expect(response.status).toBe(422);
    expect(Array.isArray(response.body.detail)).toBe(true);
    expect(response.body.detail.length).toBeGreaterThan(0);
    expect(repository.deleteCompleted).not.toHaveBeenCalled();
    expect(repository.delete).not.toHaveBeenCalled();
  },
);
it('deletes a single task by ID without clearing completed tasks', async () => {
  const { app, repository } = setup();
  repository.delete.mockResolvedValue(true);
  const response = await request(app).delete('/api/todos/5?completed=true');
  expect(response.status).toBe(204);
  expect(repository.delete).toHaveBeenCalledWith(5);
  expect(repository.deleteCompleted).not.toHaveBeenCalled();
});

it('gets a task by its numeric ID', async () => {
  const { app, repository } = setup();
  repository.get.mockResolvedValue(todo);
  const response = await request(app).get('/api/todos/1');
  expect(response.status).toBe(200);
  expect(response.body).toEqual(todo);
  expect(repository.get).toHaveBeenCalledWith(1);
});
it('returns 404 when getting a missing task', async () => {
  const { app, repository } = setup();
  repository.get.mockResolvedValue(null);
  const response = await request(app).get('/api/todos/42');
  expect(response.status).toBe(404);
  expect(response.body).toEqual({ detail: 'Task not found.' });
  expect(repository.get).toHaveBeenCalledWith(42);
});
it.each(['abc', '0', '-1', '1.5', '9007199254740992'])('rejects the invalid task ID %s without calling the repository', async (id) => {
  const { app, repository } = setup();
  const responses = [
    await request(app).get(`/api/todos/${id}`),
    await request(app).patch(`/api/todos/${id}`).send({ completed: true }),
    await request(app).delete(`/api/todos/${id}`),
  ];
  for (const response of responses) {
    expect(response.status).toBe(422);
    expect(Array.isArray(response.body.detail)).toBe(true);
    expect(response.body.detail.length).toBeGreaterThan(0);
  }
  expect(repository.get).not.toHaveBeenCalled();
  expect(repository.update).not.toHaveBeenCalled();
  expect(repository.delete).not.toHaveBeenCalled();
});
it('updates a task with the validated, trimmed fields', async () => {
  const { app, repository } = setup();
  repository.update.mockResolvedValue({ ...todo, title: 'Renamed', completed: true });
  const response = await request(app).patch('/api/todos/7').send({ title: '  Renamed  ', completed: true });
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ ...todo, title: 'Renamed', completed: true });
  expect(repository.update).toHaveBeenCalledWith(7, { title: 'Renamed', completed: true });
});
it('passes a null due date through to clear it on update', async () => {
  const { app, repository } = setup();
  repository.update.mockResolvedValue({ ...todo, due_date: null });
  const response = await request(app).patch('/api/todos/1').send({ due_date: null });
  expect(response.status).toBe(200);
  expect(repository.update).toHaveBeenCalledWith(1, { due_date: null });
});
it('returns 404 when updating a missing task', async () => {
  const { app, repository } = setup();
  repository.update.mockResolvedValue(null);
  const response = await request(app).patch('/api/todos/99').send({ completed: true });
  expect(response.status).toBe(404);
  expect(response.body).toEqual({ detail: 'Task not found.' });
  expect(repository.update).toHaveBeenCalledWith(99, { completed: true });
});
it.each([{}, { id: 2 }, { title: '' }, { priority: 'urgent' }, { completed: 'yes' }, { due_date: '2026-13-01' }])(
  'rejects invalid update input without calling the repository: %j', async (payload) => {
    const { app, repository } = setup();
    const response = await request(app).patch('/api/todos/1').send(payload);
    expect(response.status).toBe(422);
    expect(Array.isArray(response.body.detail)).toBe(true);
    expect(repository.update).not.toHaveBeenCalled();
  },
);
it('deletes a task and responds with 204 and no body', async () => {
  const { app, repository } = setup();
  repository.delete.mockResolvedValue(true);
  const response = await request(app).delete('/api/todos/3');
  expect(response.status).toBe(204);
  expect(response.text).toBe('');
  expect(repository.delete).toHaveBeenCalledWith(3);
});
it('returns 404 when deleting a missing task', async () => {
  const { app, repository } = setup();
  repository.delete.mockResolvedValue(false);
  const response = await request(app).delete('/api/todos/3');
  expect(response.status).toBe(404);
  expect(response.body).toEqual({ detail: 'Task not found.' });
});
