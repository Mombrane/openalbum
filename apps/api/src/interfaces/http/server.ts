import { createServer, type Server } from 'node:http';

// Phase 0 只暴露存活探针。业务路由留到后续阶段的接口层。
export function createHealthServer(): Server {
  return createServer((req, res) => {
    const path = req.url?.split('?')[0];
    if (req.method === 'GET' && path === '/health') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ status: 'not_found' }));
  });
}
