import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHealthServer } from '../src/interfaces/http/server.ts';

describe('GET /health', () => {
  it('返回 status ok', async () => {
    const server = createHealthServer();
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('测试服务器没有端口');
    }
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/health`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: 'ok' });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
