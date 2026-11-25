const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const base = 'http://127.0.0.1:' + process.env.PORT;
async function call(path, body, headers = {}) {
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': process.env.API_KEY ?? '',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(JSON.stringify({ status: response.status, result }));
  return result;
}
const http = require('node:http');
async function main() {
  const receiver = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const expected = crypto
      .createHmac('sha256', process.env.WEBHOOK_SECRET)
      .update(
        request.headers['x-webhook-timestamp'] +
          '.' +
          request.headers['x-webhook-id'] +
          '.' +
          body,
      )
      .digest('hex');
    const supplied = String(request.headers['x-webhook-signature'] ?? '');
    const valid =
      supplied.length === expected.length + 3 &&
      crypto.timingSafeEqual(
        Buffer.from(supplied),
        Buffer.from('v1=' + expected),
      );
    response.statusCode = valid ? 204 : 401;
    response.end();
  });
  await new Promise((resolve) => receiver.listen(4399, '127.0.0.1', resolve));
  try {
    const job = await call(
      '/deliveries',
      {
        url: 'http://127.0.0.1:4399/webhook',
        payload: { event: 'order.confirmed', orderId: crypto.randomUUID() },
      },
      { 'Idempotency-Key': crypto.randomUUID() },
    );
    await call('/deliveries/dispatch', {});
    let result = await call('/deliveries/' + job.id);
    for (let i = 0; result.state === 'processing' && i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      result = await call('/deliveries/' + job.id);
    }
    assert.equal(result.state, 'delivered');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await new Promise((resolve) => receiver.close(resolve));
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
