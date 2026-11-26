export function isPurchasePath(path: string) {
  return /^\/purchase\/[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(path)
}

export function customerRedirect(path: unknown): string | undefined {
  if (typeof path !== 'string') return
  if (
    [
      '/profile',
      '/orders',
      '/account/orders',
      '/subscriptions',
      '/messages',
      '/support/inbox',
    ].includes(path) ||
    isPurchasePath(path)
  )
    return path
}
