import express from 'express';
import { createServer, type Server as NetServer, type AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import { start } from '../src/core/lifespan.ts';
import { createDatabase, initialize } from '../src/core/database.ts';
import { resolveDatabaseUrl } from '../src/core/config.ts';
import { createApp } from '../src/factory.ts';

vi.mock('../src/core/database.ts', () => ({ createDatabase: vi.fn(), initialize: vi.fn() }));
vi.mock('../src/core/config.ts', () => ({ resolveDatabaseUrl: vi.fn() }));
vi.mock('../src/factory.ts', () => ({ createApp: vi.fn() }));

const servers: (Server | NetServer)[] = [];
const originalExitCode = process.exitCode;

function setup() {
  const database = { $connect: vi.fn().mockResolvedValue(undefined), $disconnect: vi.fn().mockResolvedValue(undefined) };
  vi.mocked(resolveDatabaseUrl).mockReturnValue('postgresql://u:p@db:5432/tasks');
  vi.mocked(createDatabase).mockReturnValue(database as never);
  vi.mocked(initialize).mockResolvedValue(undefined);
  vi.mocked(createApp).mockImplementation(() => express());
  const handlers: Record<string, () => void> = {};
  const once = vi.spyOn(process, 'once').mockImplementation(((event: string, handler: () => void) => {
    handlers[event] = handler;
    return process;
  }) as typeof process.once);
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  return { database, handlers, once, exit, log };
}

async function startTracked() {
  const result = await start();
  servers.push(result.server);
  return result;
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  vi.stubEnv('API_PORT', '0');
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  process.exitCode = originalExitCode;
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  })));
});

it('connects, initializes the schema and serves the app on API_PORT', async () => {
  const { database, log } = setup();
  const { server, database: returned } = await startTracked();
  expect(createDatabase).toHaveBeenCalledWith('postgresql://u:p@db:5432/tasks');
  expect(database.$connect).toHaveBeenCalledOnce();
  expect(initialize).toHaveBeenCalledWith(database);
  expect(createApp).toHaveBeenCalledWith(database);
  expect(returned).toBe(database);
  expect(server.listening).toBe(true);
  const address = server.address() as AddressInfo;
  expect(address.address).toBe('0.0.0.0');
  expect(address.port).toBeGreaterThan(0);
  expect(log).toHaveBeenCalledWith(`Taskly App Node API listening on port ${address.port}`);
  expect(database.$disconnect).not.toHaveBeenCalled();
});
it('defaults to port 8000 when API_PORT is not set', async () => {
  setup();
  vi.stubEnv('API_PORT', '');
  const listen = vi.fn((port: number, host: string, callback: () => void) => express().listen(0, host, callback));
  vi.mocked(createApp).mockReturnValue({ listen } as never);
  await startTracked();
  expect(listen).toHaveBeenCalledWith(8000, '0.0.0.0', expect.any(Function));
});
it('registers the same graceful shutdown handler for SIGTERM and SIGINT', async () => {
  const { handlers, once } = setup();
  await startTracked();
  expect(once).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
  expect(once).toHaveBeenCalledWith('SIGINT', expect.any(Function));
  expect(handlers.SIGTERM).toBe(handlers.SIGINT);
});
it('disconnects and rethrows when the database connection fails', async () => {
  const { database } = setup();
  database.$connect.mockRejectedValue(new Error('connection refused'));
  await expect(start()).rejects.toThrow('connection refused');
  expect(database.$disconnect).toHaveBeenCalledOnce();
  expect(initialize).not.toHaveBeenCalled();
  expect(createApp).not.toHaveBeenCalled();
});
it('disconnects and rethrows when schema initialization fails', async () => {
  const { database } = setup();
  vi.mocked(initialize).mockRejectedValue(new Error('permission denied'));
  await expect(start()).rejects.toThrow('permission denied');
  expect(database.$disconnect).toHaveBeenCalledOnce();
  expect(createApp).not.toHaveBeenCalled();
});
it('fails to start, disconnects and registers no signal handlers when the port is already in use', async () => {
  const { database, once, log } = setup();
  const occupier = createServer();
  servers.push(occupier);
  await new Promise<void>((resolve) => occupier.listen(0, '0.0.0.0', resolve));
  vi.stubEnv('API_PORT', String((occupier.address() as AddressInfo).port));
  await expect(start()).rejects.toThrow();
  expect(database.$disconnect).toHaveBeenCalledOnce();
  expect(once).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
});
it('closes the server and disconnects on shutdown without forcing an exit', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const { database, handlers, exit } = setup();
  let disconnected!: () => void;
  const called = new Promise<void>((resolve) => { disconnected = resolve; });
  database.$disconnect.mockImplementation(() => { disconnected(); return Promise.resolve(undefined); });
  const { server } = await startTracked();
  handlers.SIGTERM();
  await called;
  await flush();
  expect(server.listening).toBe(false);
  expect(database.$disconnect).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(10000);
  expect(exit).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(originalExitCode);
});
it('logs a failed disconnect on shutdown and sets a failing exit code', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const { database, handlers, exit } = setup();
  const failure = new Error('disconnect failed');
  database.$disconnect.mockRejectedValue(failure);
  let logged!: () => void;
  const called = new Promise<void>((resolve) => { logged = resolve; });
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => logged());
  await startTracked();
  handlers.SIGINT();
  await called;
  await flush();
  expect(consoleError).toHaveBeenCalledWith(failure);
  expect(process.exitCode).toBe(1);
  process.exitCode = originalExitCode;
  vi.advanceTimersByTime(10000);
  expect(exit).not.toHaveBeenCalled();
});
it('forces exit with code 1 when shutdown does not finish within 10 seconds', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const { database, handlers, exit } = setup();
  database.$disconnect.mockReturnValue(new Promise(() => {}));
  await startTracked();
  handlers.SIGTERM();
  await flush();
  vi.advanceTimersByTime(9999);
  expect(exit).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(exit).toHaveBeenCalledWith(1);
});
