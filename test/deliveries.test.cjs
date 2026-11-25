const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { createHmac } = require('node:crypto');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createApplication } = require('../dist/app');
const { Database } = require('../dist/database');
const folder = mkdtempSync(join(tmpdir(), 'relay-'));
process.env.API_KEY = 'relay-api-secret-with-at-least-32-characters';
process.env.WEBHOOK_SECRET = 'relay-signing-secret-with-at-least-32-characters';
process.env.DATABASE_PATH = join(folder, 'relay.sqlite');
process.env.WORKER_ENABLED = 'false';
let app, url, receiver, destination;
const received = [];
async function request(path, body, key, authenticate = true) {
  const headers = { 'content-type': 'application/json' };
  if (authenticate) headers['x-api-key'] = process.env.API_KEY;
  if (key) headers['idempotency-key'] = key;
  const response = await fetch(url + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
before(async () => {
  receiver = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received.push({ headers: req.headers, body, path: req.url });
    res.statusCode =
      req.url === '/retry'
        ? 503
        : req.url === '/invalid'
          ? 400
          : req.url === '/redirect'
            ? 302
            : 204;
    if (req.url === '/redirect') res.setHeader('Location', '/success');
    res.end();
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  destination = `http://127.0.0.1:${receiver.address().port}`;
  process.env.ALLOWED_WEBHOOK_ORIGINS = destination;
  app = await createApplication();
  await app.listen(0, '127.0.0.1');
  url = await app.getUrl();
});
after(async () => {
  await app?.close();
  await new Promise((resolve) => receiver.close(resolve));
  rmSync(folder, { recursive: true, force: true });
});
function makeDue(id) {
  app
    .get(Database)
    .connection.prepare('UPDATE deliveries SET next_at=0 WHERE id=?')
    .run(id);
}

test('destino não permitido, payload inválido e acesso sem chave são rejeitados', async () => {
  assert.equal(
    (
      await request(
        '/deliveries',
        { url: 'http://169.254.169.254/metadata', payload: {} },
        'blocked-key',
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        '/deliveries',
        { url: destination, payload: [] },
        'invalid-key',
      )
    ).status,
    400,
  );
  assert.equal(
    (await request('/deliveries/dispatch', {}, undefined, false)).status,
    401,
  );
});
test('entrega usa corpo original, identificador e HMAC verificável', async () => {
  const payload = { event: 'order.confirmed', orderId: '123' };
  const { body: job } = await request(
    '/deliveries',
    { url: destination + '/success', payload },
    'success-key',
  );
  await request('/deliveries/dispatch', {});
  const actual = received.find((x) => x.headers['x-webhook-id'] === job.id);
  assert.ok(actual);
  const expected = createHmac('sha256', process.env.WEBHOOK_SECRET)
    .update(
      `${actual.headers['x-webhook-timestamp']}.${job.id}.${JSON.stringify(payload)}`,
    )
    .digest('hex');
  assert.equal(actual.headers['x-webhook-signature'], `v1=${expected}`);
  assert.equal(
    (await request('/deliveries/' + job.id)).body.state,
    'delivered',
  );
});
test('idempotência não enfileira duas vezes e detecta conteúdo diferente', async () => {
  const input = { url: destination + '/success', payload: { id: 2 } };
  const first = await request('/deliveries', input, 'replay-key');
  const second = await request('/deliveries', input, 'replay-key');
  assert.equal(first.body.id, second.body.id);
  assert.equal(
    (
      await request(
        '/deliveries',
        { ...input, payload: { id: 3 } },
        'replay-key',
      )
    ).status,
    409,
  );
});
test('503 agenda backoff, chega à fila de falhas e mantém histórico no reprocessamento', async () => {
  const { body: job } = await request(
    '/deliveries',
    { url: destination + '/retry', payload: {} },
    'retry-key',
  );
  await request('/deliveries/dispatch', {});
  let state = (await request('/deliveries/' + job.id)).body;
  assert.equal(state.state, 'pending');
  assert.ok(state.next_at > Date.now());
  for (let i = 0; i < 4; i++) {
    makeDue(job.id);
    await request('/deliveries/dispatch', {});
  }
  state = (await request('/deliveries/' + job.id)).body;
  assert.equal(state.state, 'dead');
  assert.equal(state.history.length, 5);
  assert.ok(state.history.every((x) => x.http_status === 503));
  assert.equal(
    (await request(`/deliveries/${job.id}/retry`, {})).body.generation,
    1,
  );
  await request('/deliveries/dispatch', {});
  assert.equal((await request('/deliveries/' + job.id)).body.history.length, 6);
});
test('erro 400 e redirect entram em dead sem seguir outra URL', async () => {
  for (const path of ['/invalid', '/redirect']) {
    const { body: job } = await request(
      '/deliveries',
      { url: destination + path, payload: {} },
      'terminal-' + path.slice(1),
    );
    await request('/deliveries/dispatch', {});
    const state = (await request('/deliveries/' + job.id)).body;
    assert.equal(state.state, 'dead');
    assert.equal(state.attempts, 1);
  }
});
test('lease vencido é recuperado e chamadas concorrentes não confirmam o mesmo lease', async () => {
  const { body: job } = await request(
    '/deliveries',
    { url: destination + '/success', payload: {} },
    'lease-key',
  );
  app
    .get(Database)
    .connection.prepare(
      "UPDATE deliveries SET state='processing',lease_until=0,lease_token='abandoned' WHERE id=?",
    )
    .run(job.id);
  await Promise.all([
    request('/deliveries/dispatch', {}),
    request('/deliveries/dispatch', {}),
  ]);
  assert.equal(
    (await request('/deliveries/' + job.id)).body.state,
    'delivered',
  );
  assert.equal(
    received.filter((x) => x.headers['x-webhook-id'] === job.id).length,
    1,
  );
});
test('a fila persiste após reiniciar a aplicação', async () => {
  const { body: job } = await request(
    '/deliveries',
    { url: destination + '/success', payload: {} },
    'restart-key',
  );
  await app.close();
  app = await createApplication();
  await app.listen(0, '127.0.0.1');
  url = await app.getUrl();
  assert.equal((await request('/deliveries/' + job.id)).body.state, 'pending');
  await request('/deliveries/dispatch', {});
  assert.equal(
    (await request('/deliveries/' + job.id)).body.state,
    'delivered',
  );
});
