import assert from 'node:assert/strict'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import express from 'express'
import type { PrismaClient } from '../src/generated/prisma/client.ts'
import { supportRoutes } from '../src/modules/chat/routes.ts'
import { errors } from '../src/http/errors.ts'

test('only the assigned account can publish presence; closing one tab preserves the second lease', async () => {
  const agent = randomUUID(),
    customer = randomUUID()
  const db = {
    supportSettings: {
      findUniqueOrThrow: async () => ({
        agentId: agent,
        agent: { status: 'ACTIVE' },
      }),
    },
    supportThread: {
      findUnique: async () => ({ customerId: customer, agentId: agent }),
    },
  }
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => {
    res.locals.principal = {
      user: { id: req.get('test-account'), role: 'CUSTOMER' },
    }
    next()
  })
  app.use(supportRoutes(db as unknown as PrismaClient))
  app.use(errors)
  const server = app.listen(0, '127.0.0.1')
  try {
    await once(server, 'listening')
    const addr = server.address()
    assert.ok(addr && typeof addr !== 'string')
    const url = 'http://127.0.0.1:' + addr.port
    const status = async () =>
      (await (await fetch(url + '/status')).json()).online
    const tabA = randomUUID(),
      tabB = randomUUID()
    const presence = (user: string, tab: string, visible: boolean) =>
      fetch(url + '/presence', {
        method: 'POST',
        headers: { 'test-account': user, 'content-type': 'application/json' },
        body: JSON.stringify({ tab, visible }),
      })
    assert.equal((await presence(customer, tabA, true)).status, 403)
    assert.equal(
      (
        await fetch(url + '/settings', {
          headers: { 'test-account': customer },
        })
      ).status,
      403,
    )
    assert.equal(
      (
        await fetch(url + '/thread/' + customer + '/messages', {
          headers: { 'test-account': randomUUID() },
        })
      ).status,
      404,
    )
    assert.equal(await status(), false)
    assert.equal((await presence(agent, tabA, true)).status, 204)
    await presence(agent, tabB, true)
    await presence(agent, tabA, false)
    assert.equal(await status(), true)
    await presence(agent, tabB, false)
    assert.equal(await status(), false)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    )
  }
})
