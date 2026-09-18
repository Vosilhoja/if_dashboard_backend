const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const app = require('./server');

const protectedEndpoints = [
  ['GET', '/api/auth/me'],
  ['POST', '/api/auth/logout'],
  ['POST', '/api/auth/telegram-link-code'],
  ['GET', '/api/admin/roles'],
  ['GET', '/api/admin/users'],
  ['GET', '/api/admin/statuses'],
  ['GET', '/api/data'],
  ['GET', '/api/data/period'],
  ['GET', '/api/data/analytics'],
  ['GET', '/api/data/settings-info'],
  ['GET', '/api/data/settings'],
  ['PUT', '/api/data/settings'],
  ['POST', '/api/data/sheets/main/sync'],
  ['GET', '/api/data/search?q=123'],
  ['GET', '/api/data/sheets/main'],
  ['POST', '/api/calls'],
  ['GET', '/api/ai/history'],
  ['DELETE', '/api/ai/history'],
  ['POST', '/api/ai/chat'],
  ['POST', '/api/ai/insights'],
  ['GET', '/api/stats/weekly'],
  ['GET', '/api/stats/monthly'],
  ['GET', '/api/stats/summary'],
  ['GET', '/api/status/test'],
];

function request(server, method, path) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const req = http.request({
      host: '127.0.0.1',
      port: address.port,
      method,
      path,
      headers: { 'content-type': 'application/json' },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res));
    });
    req.on('error', reject);
    req.end();
  });
}

test('health endpoint is available and all protected routes reject missing auth', async () => {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const health = await request(server, 'GET', '/health');
    assert.equal(health.statusCode, 200);
    for (const [method, path] of protectedEndpoints) {
      const response = await request(server, method, path);
      assert.equal(response.statusCode, 401, `${method} ${path} should require auth`);
    }
    const missing = await request(server, 'GET', '/api/does-not-exist');
    assert.equal(missing.statusCode, 404);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
