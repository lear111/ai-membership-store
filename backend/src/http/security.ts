import type { RequestHandler } from 'express'
import { ApiError } from './errors.ts'

export function csrf(appBaseUrl: string): RequestHandler {
  const origin = new URL(appBaseUrl).origin
  return (request, _response, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return next()
    const upload =
      (request.method === 'POST' &&
        !!request.is('application/octet-stream') &&
        /^\/chat\/thread\/(me|[0-9a-f-]{36})\/messages$/.test(request.path)) ||
      (request.method === 'PUT' &&
        (request.path === '/admin/settings/wechat-qr' ||
          /^\/admin\/products\/[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}\/cover-image$/.test(
            request.path,
          )))
    if (
      request.get('origin') !== origin ||
      request.get('x-requested-with') !== 'MembershipStore' ||
      !request.is(upload ? 'application/octet-stream' : 'application/json')
    )
      return next(
        new ApiError(
          403,
          'CSRF_REJECTED',
          '请求来源无效，请在当前站点刷新后重试',
        ),
      )
    next()
  }
}

export function rateLimit(
  limit: number,
  windowMs = 15 * 60 * 1000,
  now = Date.now,
): RequestHandler {
  const entries = new Map<string, { count: number; expires: number }>()
  return (request, response, next) => {
    const time = now()
    for (const [key, value] of entries)
      if (value.expires <= time) entries.delete(key)
    const key = request.ip ?? request.socket.remoteAddress ?? 'unknown'
    let entry = entries.get(key)
    if (!entry) {
      if (entries.size >= 10000)
        return next(
          new ApiError(429, 'RATE_LIMITED', '操作过于频繁，请稍后重试'),
        )
      entry = { count: 0, expires: time + windowMs }
      entries.set(key, entry)
    }
    if (++entry.count > limit) {
      response.setHeader(
        'Retry-After',
        Math.ceil((entry.expires - time) / 1000),
      )
      return next(new ApiError(429, 'RATE_LIMITED', '操作过于频繁，请稍后重试'))
    }
    next()
  }
}
