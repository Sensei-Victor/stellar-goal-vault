import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('./services/sorobanRpc', () => ({
  ensureSorobanRefundConfig: vi.fn(),
}));
vi.mock('./services/eventIndexer', () => ({
  getIndexerStatus: vi.fn().mockReturnValue({
    lastSuccessfulPollTime: Date.now(),
    lastKnownLedger: 1,
    isHealthy: true,
    consecutiveFailures: 0,
    lagMs: 0,
  }),
  startEventIndexer: vi.fn(),
  stopEventIndexer: vi.fn(),
}));

import type { Express } from 'express';

import { REQUEST_ID_HEADER } from './middleware/requestId';
import { logger } from './logger';

const TEST_DB_PATH = path.join(
  '/tmp',
  `stellar-goal-vault-request-id-${process.pid}-${Date.now()}.db`,
);

process.env.DB_PATH = TEST_DB_PATH;
process.env.CONTRACT_ID = '';
process.env.NODE_ENV = 'test';

let app: Express;

beforeAll(async () => {
  fs.rmSync(TEST_DB_PATH, { force: true });
  const { initCampaignStore } = await import('./services/campaignStore');
  ({ app } = await import('./index'));
  initCampaignStore();
});

afterAll(() => {
  fs.rmSync(TEST_DB_PATH, { force: true });
});

describe('request id middleware', () => {
  it('echoes an incoming X-Request-ID header', async () => {
    const response = await request(app)
      .get('/api/health')
      .set(REQUEST_ID_HEADER, 'client-request-123');

    expect(response.status).toBe(200);
    expect(response.headers[REQUEST_ID_HEADER.toLowerCase()]).toBe('client-request-123');
  });

  it('generates X-Request-ID when the header is missing', async () => {
    const response = await request(app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.headers[REQUEST_ID_HEADER.toLowerCase()]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('includes request id in structured request logs', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);

    await request(app).get('/api/health').set(REQUEST_ID_HEADER, 'log-context-request-id');

    const httpRequestCall = infoSpy.mock.calls
      .map(([payload]) => payload as { event?: string; requestId?: string })
      .find((payload) => payload?.event === 'http_request');

    expect(httpRequestCall).toBeDefined();
    expect(httpRequestCall?.requestId).toBe('log-context-request-id');

    infoSpy.mockRestore();
  });
});
