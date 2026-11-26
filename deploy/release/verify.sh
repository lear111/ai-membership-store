#!/usr/bin/env bash
set -euo pipefail

[[ $# == 3 && -f /.dockerenv && $EUID == 0 ]] || {
  printf '%s\n' 'Use a disposable verifier container: verify.sh ARTIFACT_DIR GIT_SHA COMPOSE_JSON' >&2
  exit 1
}
artifacts=$(realpath -e -- "$1")
sha=$2
[[ $sha =~ ^[0-9a-f]{40}$ ]]
deploy=$(cd -- "$(dirname -- "$0")/.." && pwd)
test_root=$(mktemp -d)
api_pid=
caddy_pid=
cleanup() {
  for pid in "$caddy_pid" "$api_pid"; do
    if [[ -n $pid ]]; then
      kill -TERM "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  rm -rf -- "$test_root"
}
trap cleanup EXIT
for directory in /opt/ai-membership-store /etc/ai-membership-store /srv/membership-data; do
  [[ ! -e $directory && ! -L $directory ]]
done
useradd --system --user-group --no-create-home --shell /usr/sbin/nologin membership-store
install -d -m 0755 /opt/ai-membership-store/releases
install -d -m 0750 -o root -g membership-store /etc/ai-membership-store /srv/membership-data
install -d -m 0700 -o membership-store -g membership-store \
  /srv/membership-data/wechat-qr /srv/membership-data/product-covers
install -m 0600 /dev/null /etc/ai-membership-store/runtime.env

(
  cd "$artifacts"
  sha256sum --check --strict SHA256SUMS
)
runtime=$artifacts/runtime-$sha.tar.gz
operations=$artifacts/operations-$sha.tar.gz
archive_sha() { sha256sum -- "$1" | cut -d ' ' -f 1; }
reject() {
  if "$@" >"$test_root/rejected.log" 2>&1; then
    printf '%s\n' 'Expected the operation to fail.' >&2
    exit 1
  fi
}
release() { bash "$deploy/release/release.sh" "$@"; }
reject release install "$sha" "$runtime" "$(printf '0%.0s' {1..64})"
[[ ! -e /opt/ai-membership-store/releases/$sha ]]
release install "$sha" "$runtime" "$(archive_sha "$runtime")"
reject release install "$sha" "$runtime" "$(archive_sha "$runtime")"
release switch "$sha"
root=/opt/ai-membership-store/current

mkdir "$test_root/ops"
tar -xzf "$operations" -C "$test_root/ops"
node - "$sha" "$root/release.json" "$test_root/ops/release.json" "$3" <<'NODE'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const [sha, runtime, ops, compose] = process.argv.slice(2)
const read = (path) => JSON.parse(fs.readFileSync(path))
const a = read(runtime)
assert.equal(a.gitSha, sha)
assert.equal(a.kind, 'runtime')
assert.equal(a.node, 'v24.13.0')
assert.equal(a.prisma, '7.10.1')
assert.deepEqual(read(ops), { ...a, kind: 'operations' })
const mysql = read(compose).services.mysql
assert.equal(mysql.image, a.mysqlImage)
assert.equal(mysql.stop_grace_period, '1m30s')
assert.equal(mysql.ports.length, 1)
assert.equal(mysql.ports[0].host_ip, '127.0.0.1')
assert.equal(String(mysql.ports[0].published), '3310')
assert.equal(mysql.ports[0].target, 3306)
console.log('Rendered Compose model: pinned image, loopback mapping and 90-second stop grace period.')
NODE
for bundle in "$root" "$test_root/ops"; do
  if [[ -n $(find "$bundle/" \( -name '.env' -o -name '.env.*' -o -name '.local-data' \) -print -quit) ]]; then
    printf '%s\n' 'Found environment or local data in a release bundle.' >&2
    exit 1
  fi
done
for tool in prisma @prisma/engines; do
  [[ ! -e $root/node_modules/$tool && ! -e $root/backend/node_modules/$tool ]] ||
    { printf 'Unexpected operations dependency in runtime: %s\n' "$tool" >&2; exit 1; }
done
(
  cd "$test_root/ops"
  sha256sum --check --strict --quiet SHA256SUMS
  [[ -s backend/prisma/migrations/20261124010000_support_chat/migration.sql ]]
  [[ $(find backend/prisma/migrations -name migration.sql -type f | wc -l) == 16 ]]
  cd backend
  NODE_ENV=production node scripts/prisma.ts --production validate
  reject env -i PATH="$PATH" NODE_ENV=production node scripts/prisma.ts --production migrate status
  grep -q 'MIGRATION_DATABASE_URL' "$test_root/rejected.log"
  reject env -i PATH="$PATH" NODE_ENV=production node prisma/bootstrap-admin.ts
  grep -q 'BOOTSTRAP_DATABASE_URL' "$test_root/rejected.log"
)
printf '%s\n' 'Operations archive verified. Migration and bootstrap entry points load and reject missing credentials.'

(
  cd "$root/backend"
  node --input-type=module <<'NODE'
import assert from 'node:assert/strict'
import argon2 from 'argon2'
import sharp from 'sharp'
import { PrismaMariaDb } from '@prisma/adapter-mariadb'
import { PrismaClient } from './dist/generated/prisma/client.js'

const password = 'synthetic test value'
assert.equal(await argon2.verify(await argon2.hash(password), password), true)
const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#246' } }).webp().toBuffer()
assert.equal((await sharp(image).metadata()).format, 'webp')
const db = new PrismaClient({ adapter: new PrismaMariaDb({ host: '127.0.0.1' }) })
await db.$disconnect()
NODE
)
systemd-analyze verify "$deploy/systemd/ai-membership-store.service"
runuser -u membership-store -- test ! -w "$root/backend/dist/server.js"
runuser -u membership-store -- test ! -r /etc/ai-membership-store/runtime.env
for directory in /srv/membership-data/wechat-qr /srv/membership-data/product-covers; do
  runuser -u membership-store -- test -w "$directory"
done
openssl genpkey -quiet -algorithm RSA -out "$test_root/private.pem"
config=/etc/ai-membership-store
key=$config/mysql-auth-public.pem
printf 'MYSQL_AUTH_PUBLIC_KEY_FILE=%s\n' "$key" >"$config/runtime.env"
check_key() { bash "$deploy/release/check-runtime-key.sh"; }
reject check_key
grep -q 'mode 0644 MySQL authentication public key' "$test_root/rejected.log"
openssl pkey -in "$test_root/private.pem" -pubout -out "$test_root/rsa.pem"
install -m 0600 "$test_root/rsa.pem" "$key"
reject check_key
grep -q 'mode 0644 MySQL authentication public key' "$test_root/rejected.log"
chmod 0644 "$key"
chmod 0700 "$config"
reject check_key
grep -q 'mode 0750 configuration directory' "$test_root/rejected.log"
chmod 0750 "$config"
printf 'MYSQL_AUTH_PUBLIC_KEY_FILE=%s\n' "$test_root/rsa.pem" >"$config/runtime.env"
reject check_key
grep -q 'MYSQL_AUTH_PUBLIC_KEY_FILE' "$test_root/rejected.log"
printf 'MYSQL_AUTH_PUBLIC_KEY_FILE=%s\n' "$key" >"$config/runtime.env"
mv "$key" "$config/fixture.pem"
ln -s "$config/fixture.pem" "$key"
reject check_key
grep -q 'mode 0644 MySQL authentication public key' "$test_root/rejected.log"
unlink "$key"
mv "$config/fixture.pem" "$key"
printf '%s\n' 'malformed PEM' >"$key"
reject check_key
grep -q 'valid RSA public key PEM' "$test_root/rejected.log"
openssl genpkey -quiet -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$test_root/ec.pem"
openssl pkey -in "$test_root/ec.pem" -pubout -out "$key"
reject check_key
grep -q 'valid RSA public key PEM' "$test_root/rejected.log"
install -m 0644 "$test_root/rsa.pem" "$key"
check_key
printf '%s\n' 'Runtime key preflight: missing, permission, different path, symlink and malformed/non-RSA cases rejected.'

(
  cd "$root/backend"
  exec setpriv --reuid=membership-store --regid=membership-store --init-groups \
    env -i PATH="$PATH" NODE_ENV=production API_PORT=3101 TRUSTED_PROXY_IP=127.0.0.1 \
    APP_BASE_URL=https://shop.synthetic-test.org PRODUCTION_DATABASE_NAME=t232_artifact_test \
    DATABASE_URL=mysql://fixture:synthetic-test-value@127.0.0.1:3310/t232_artifact_test \
    MYSQL_AUTH_PUBLIC_KEY_FILE=/etc/ai-membership-store/mysql-auth-public.pem \
    WECHAT_QR_STORAGE_DIR=/srv/membership-data/wechat-qr \
    PRODUCT_COVER_STORAGE_DIR=/srv/membership-data/product-covers \
    node dist/server.js --production
) >"$test_root/runtime.log" 2>&1 &
api_pid=$!
for _ in {1..100}; do
  if grep -q '"event":"startup","result":"listening"' "$test_root/runtime.log"; then break; fi
  kill -0 "$api_pid" || { cat "$test_root/runtime.log" >&2; exit 1; }
  sleep 0.1
done
grep -q '"event":"startup","result":"listening"' "$test_root/runtime.log"
status=$(curl -sS -o "$test_root/health.json" -w '%{http_code}' --max-time 8 http://127.0.0.1:3101/api/v1/health)
[[ $status == 503 ]]
reject bash "$deploy/release/health.sh"
kill -TERM "$api_pid"
wait "$api_pid"
api_pid=
printf '%s\n' 'Runtime archive starts as the non-root user and drains on SIGTERM; isolated DB is deliberately absent.'

[[ $(caddy version) == v2.6.2* ]]
caddy validate --adapter caddyfile --config "$deploy/caddy/ai-membership-store.caddy"
openssl req -x509 -newkey rsa:2048 -noenc -days 1 -subj /CN=127.0.0.1 \
  -addext subjectAltName=IP:127.0.0.1 -keyout "$test_root/caddy.key" \
  -out "$test_root/caddy.pem" >"$test_root/openssl.log" 2>&1
{
  printf '{\n admin off\n}\n'
  sed "s@^shop\.example\.com {@https://127.0.0.1:18443 {\n tls $test_root/caddy.pem $test_root/caddy.key@" \
    "$deploy/caddy/ai-membership-store.caddy"
} >"$test_root/Caddyfile"
caddy run --adapter caddyfile --config "$test_root/Caddyfile" >"$test_root/caddy.log" 2>&1 &
caddy_pid=$!

# Build two later releases and a conflicting reuse of an existing asset name.
fixture_archive() (
  id=$1
  asset=$2
  fixture=$test_root/fixture-$id
  mkdir -p "$fixture/backend/dist" "$fixture/frontend/dist/assets" "$fixture/node_modules"
  printf '%s\n' 'synthetic compiled API' >"$fixture/backend/dist/server.js"
  printf 'synthetic SPA %s\n' "$id" >"$fixture/frontend/dist/index.html"
  printf 'release %s\n' "$id" >"$fixture/frontend/dist/assets/$asset"
  printf '{"kind":"runtime","gitSha":"%s","checksums":"SHA256SUMS"}\n' "$id" >"$fixture/release.json"
  cd "$fixture"
  sha256sum release.json backend/dist/server.js frontend/dist/index.html "frontend/dist/assets/$asset" >SHA256SUMS
  tar -czf "$test_root/$id.tar.gz" .
)
second=$(printf 'f%.0s' {1..40})
third=$(printf 'e%.0s' {1..40})
conflict=$(printf 'd%.0s' {1..40})
[[ $sha != "$second" && $sha != "$third" && $sha != "$conflict" ]]
second_asset=release-B709ax43.js
third_asset=release-C709ax43.js
fixture_archive "$second" "$second_asset"
fixture_archive "$third" "$third_asset"
fixture_archive "$conflict" "$second_asset"
for id in "$second" "$third"; do
  release install "$id" "$test_root/$id.tar.gz" "$(archive_sha "$test_root/$id.tar.gz")"
done
reject release install "$conflict" "$test_root/$conflict.tar.gz" "$(archive_sha "$test_root/$conflict.tar.gz")"
grep -q 'Immutable asset name already has different content' "$test_root/rejected.log"
[[ ! -e /opt/ai-membership-store/releases/$conflict ]]

NODE_EXTRA_CA_CERTS="$test_root/caddy.pem" node --input-type=module - \
  "$deploy/release/release.sh" "$sha" "$second" "$third" "$second_asset" "$third_asset" <<'NODE'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { readFile, readdir, readlink } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

const [release, first, second, third, secondAsset, thirdAsset] = process.argv.slice(2)
const select = (...args) => execFileSync('bash', [release, ...args], { stdio: 'inherit' })
const base = 'https://127.0.0.1:18443'
function assertSecurity(response) {
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff')
  assert.equal(response.headers.get('X-Frame-Options'), 'DENY')
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer')
  assert.equal(response.headers.get('Strict-Transport-Security'), 'max-age=31536000')
}
async function assertAsset(name, expected) {
  const response = await fetch(base + '/assets/' + name)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Cache-Control'), 'public, max-age=31536000, immutable')
  assertSecurity(response)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected)
}

const server = createServer((req, res) => {
  if (req.url === '/api/missing') {
    res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"upstream"}')
  } else {
    res.end(JSON.stringify({ path: req.url, forwardedFor: req.headers['x-forwarded-for'], origin: req.headers.origin }))
  }
}).listen(3101, '127.0.0.1')
try {
  let ready = false
  for (let i = 0; i < 100; i++) {
    try { ready = (await fetch(base)).ok } catch {}
    if (ready) break
    await delay(100)
  }
  assert.ok(ready)
  for (const path of ['/api', '/api/v1/health?probe=1']) {
    const origin = 'https://shop.example.com'
    const response = await fetch(base + path, {
      headers: { Origin: origin, 'X-Forwarded-For': '192.0.2.1, 192.0.2.2' },
    })
    assert.deepEqual(await response.json(), { path, origin, forwardedFor: '127.0.0.1' })
  }
  const missing = await fetch(base + '/api/missing')
  assert.equal(missing.status, 404)
  assert.deepEqual(await missing.json(), { error: 'upstream' })
  const internal = await fetch(base + '/internal/ops/metrics')
  assert.equal(internal.status, 404)
  for (const path of ['/missing.png', '/assets/missing-i8bDQvnC.js']) {
    const asset = await fetch(base + path)
    assert.equal(asset.status, 404)
    assert.ok(!asset.headers.get('Cache-Control')?.includes('immutable'))
  }
  const dist = '/opt/ai-membership-store/current/frontend/dist'
  const history = await fetch(base + '/account/orders')
  assert.equal(history.status, 200)
  assert.equal(history.headers.get('Cache-Control'), 'no-cache')
  assertSecurity(history)
  assert.equal(await history.text(), await readFile(dist + '/index.html', 'utf8'))
  const firstAsset = (await readdir(dist + '/assets')).find((file) => file.endsWith('.js'))
  assert.ok(firstAsset)
  const firstBytes = await readFile(dist + '/assets/' + firstAsset)
  await assertAsset(firstAsset, firstBytes)
  select('switch', second)
  assert.equal(await readlink('/opt/ai-membership-store/previous'), 'releases/' + first)
  assert.equal(await (await fetch(base + '/account/orders')).text(), 'synthetic SPA ' + second + '\n')
  await assertAsset(firstAsset, firstBytes)
  await assertAsset(secondAsset, Buffer.from('release ' + second + '\n'))
  select('switch', third)
  assert.equal(await readlink('/opt/ai-membership-store/previous'), 'releases/' + second)
  await assertAsset(firstAsset, firstBytes)
  await assertAsset(secondAsset, Buffer.from('release ' + second + '\n'))
  await assertAsset(thirdAsset, Buffer.from('release ' + third + '\n'))
  select('rollback')
  assert.equal(await readlink('/opt/ai-membership-store/current'), 'releases/' + second)
  await assertAsset(thirdAsset, Buffer.from('release ' + third + '\n'))
  select('switch', first)
  assert.equal(await readlink('/opt/ai-membership-store/current'), 'releases/' + first)
} finally {
  server.close()
}
NODE
printf '%s\n' \
  'Caddy 2.6.2 HTTPS, response headers, routing, and cache checks passed.' \
  'Checksum, duplicate and asset collision refusal, three-release retention and rollback passed.'
