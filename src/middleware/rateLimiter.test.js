const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const test = require('node:test');
const {
  apiLimiter,
  dashboardLimiter,
  dashboardRefreshLimiter,
  adminStatusLimiter,
} = require('./rateLimiter');

function request(server, path, forwardedFor) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const req = http.request({
      host: '127.0.0.1',
      port: address.port,
      path,
      headers: { 'x-forwarded-for': forwardedFor },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res));
    });
    req.on('error', reject);
    req.end();
  });
}

async function withServer(middleware, callback) {
  const app = express();
  app.set('trust proxy', 1);
  app.get('/test', middleware, (_req, res) => res.sendStatus(200));
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    await callback(server);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('refresh requests are blocked on the fourth request in one minute', async () => {
  await withServer(dashboardRefreshLimiter, async (server) => {
    const statuses = [];
    for (let index = 0; index < 4; index += 1) {
      statuses.push((await request(server, '/test?refresh=true', '10.0.0.1')).statusCode);
    }
    assert.deepEqual(statuses, [200, 200, 200, 429]);
  });
});

test('cached requests do not consume the refresh limit', async () => {
  await withServer(dashboardRefreshLimiter, async (server) => {
    const statuses = [];
    for (let index = 0; index < 10; index += 1) {
      statuses.push((await request(server, '/test', '10.0.0.2')).statusCode);
    }
    assert.deepEqual(statuses, Array(10).fill(200));
  });
});

test('dashboard requests are blocked after thirty requests in one minute', async () => {
  await withServer(dashboardLimiter, async (server) => {
    const statuses = [];
    for (let index = 0; index < 31; index += 1) {
      statuses.push((await request(server, '/test', '10.0.0.3')).statusCode);
    }
    assert.equal(statuses.filter((status) => status === 200).length, 30);
    assert.equal(statuses[30], 429);
  });
});

test('global API requests are blocked after six hundred requests in fifteen minutes', async () => {
  await withServer(apiLimiter, async (server) => {
    let lastStatus;
    for (let index = 0; index < 601; index += 1) {
      lastStatus = (await request(server, '/test', '10.0.0.4')).statusCode;
    }
    assert.equal(lastStatus, 429);
  });
});

test('admin status classification is blocked after five requests in fifteen minutes', async () => {
  await withServer(adminStatusLimiter, async (server) => {
    const statuses = [];
    for (let index = 0; index < 6; index += 1) {
      statuses.push((await request(server, '/test', '10.0.0.5')).statusCode);
    }
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
  });
});
