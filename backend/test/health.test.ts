import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { Server } from 'node:http'
import { createApp } from '../src/app.ts'

let server: Server
let baseUrl: string
let databaseReady = true

before(async () => {
  server = createApp(async () => {
    if (!databaseReady)
      throw new Error('mysql://test:do-not-expose@localhost/private')
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address !== 'string')
  baseUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
})

test('health reports database readiness on both aliases', async () => {
  for (const path of ['/health', '/api/v1/health']) {
    const response = await fetch(baseUrl + path)
    assert.equal(response.status, 200)
    assert.match(
      response.headers.get('content-type') ?? '',
      /^application\/json/,
    )
    assert.deepEqual(await response.json(), { status: 'ok', database: 'ready' })
  }
})

test('database errors return sanitized 503 and recovery is checked again', async () => {
  databaseReady = false
  try {
    for (const path of ['/health', '/api/v1/health']) {
      const response = await fetch(baseUrl + path)
      assert.equal(response.status, 503)
      assert.deepEqual(await response.json(), {
        status: 'degraded',
        database: 'unavailable',
      })
    }
  } finally {
    databaseReady = true
  }
  assert.equal((await fetch(baseUrl + '/api/v1/health')).status, 200)
})

test('business routes are not exposed by this scaffold', async () => {
  for (const path of [
    '/admin/products',
    '/admin/users',
    '/admin/orders',
    '/auth/login',
    '/auth/activate',
  ]) {
    for (const method of ['GET', 'POST']) {
      const response = await fetch(baseUrl + '/api/v1' + path, { method })
      assert.equal(response.status, 404)
      const body = await response.json()
      assert.equal(body.error.code, 'NOT_FOUND')
      assert.equal(body.error.message, 'Route not found.')
      assert.match(body.error.requestId, /^[a-f0-9-]{36}$/)
    }
  }
})

test('JSON transport accepts exactly 128 KiB and rejects one extra UTF-8 byte', async () => {
  const value = '中🙂'.repeat(18_000)
  const initial = JSON.stringify({ payload: value })
  const padding = 131_072 - Buffer.byteLength(initial)
  for (const [extra, status, code] of [
    [0, 404, 'NOT_FOUND'],
    [1, 413, 'PAYLOAD_TOO_LARGE'],
  ] as const) {
    const body = JSON.stringify({
      payload: value + 'x'.repeat(padding + extra),
    })
    assert.equal(Buffer.byteLength(body), 131_072 + extra)
    const response = await fetch(baseUrl + '/api/v1/unused', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    assert.equal(response.status, status)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const result = await response.json()
    assert.equal(result.error.code, code)
    assert.deepEqual(Object.keys(result.error).sort(), [
      'code',
      'message',
      'requestId',
    ])
  }
  const strict = await fetch(baseUrl + '/api/v1/unused', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '"scalar"',
  })
  assert.equal(strict.status, 400)
  assert.equal((await strict.json()).error.code, 'INVALID_INPUT')
})
