import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import {
  mkdtempSync,
  writeFileSync,
  unlinkSync,
  rmdirSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const cwd = fileURLToPath(new URL('..', import.meta.url))
const container = 'membership-production-' + randomBytes(6).toString('hex')
const rootPassword = randomBytes(24).toString('hex')
const accounts = Object.fromEntries(
  ['migrator', 'bootstrap', 'api', 'no_audit'].map((name) => [
    name,
    randomBytes(24).toString('hex'),
  ]),
)
const databases = [
  't231_clean_test',
  't231_registered_test',
  't231_pending_test',
]
// Drop inherited application credentials. All child processes receive only
// the profile they need for the disposable target.
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !/^(NODE_ENV|DATABASE_URL|.*_DATABASE_URL|PRODUCTION_DATABASE_NAME|APP_BASE_URL|ADMIN_.*|MYSQL_.*|API_PORT|TRUSTED_PROXY_IP|WECHAT_QR_STORAGE_DIR|PRODUCT_COVER_STORAGE_DIR)$/i.test(
        key,
      ),
  ),
)
const secrets = [rootPassword, ...Object.values(accounts)]
const redact = (value: string) =>
  secrets.reduce(
    (output, secret) => output.replaceAll(secret, '[redacted]'),
    value,
  )

function run(binary: string, args: string[], env = cleanEnv, input?: string) {
  try {
    return execFileSync(binary, args, {
      cwd,
      input,
      env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 180_000,
    }).trim()
  } catch (error) {
    const { stdout, stderr, code } = error as {
      stdout?: string
      stderr?: string
      code?: string
    }
    // eslint-disable-next-line preserve-caught-error -- Child process errors may contain environment credentials.
    throw new Error(
      redact([stdout, stderr, code].filter(Boolean).join('\n')) ||
        'Isolated production test command failed.',
    )
  }
}

function mysql(sql: string) {
  return run(
    'docker',
    [
      'exec',
      '-i',
      container,
      'sh',
      '-c',
      'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -h 127.0.0.1 -u root -N -B',
    ],
    cleanEnv,
    sql,
  )
}

const businessPrivileges: Record<string, string> = {
  User: 'INSERT, UPDATE',
  Session: 'INSERT, UPDATE',
  InvitationToken: 'INSERT, UPDATE',
  Product: 'INSERT, UPDATE',
  Order: 'INSERT, UPDATE',
  PaymentTransaction: 'INSERT, UPDATE',
  OrderEvent: 'INSERT',
  OrderRevision: 'INSERT',
  Subscription: 'INSERT, UPDATE',
  SubscriptionEvent: 'INSERT',
  AdminAuditLog: 'INSERT',
  AppSettings: 'UPDATE',
  SupportSettings: 'UPDATE',
  SupportThread: 'INSERT, UPDATE',
  SupportMessage: 'INSERT',
  SupportReminder: 'INSERT, UPDATE, DELETE',
  IdempotencyRecord: 'INSERT',
}
const backtick = String.fromCharCode(96)
const quote = (id: string) => backtick + id + backtick

const directory = mkdtempSync(join(tmpdir(), 'membership-production-'))
const keyFile = join(directory, 'mysql-public-key.pem')
let created = false
try {
  run(
    'docker',
    [
      'run',
      '--rm',
      '-d',
      '--name',
      container,
      '--tmpfs',
      '/var/lib/mysql:rw',
      '--publish',
      '127.0.0.1::3306',
      '--env',
      'MYSQL_ROOT_PASSWORD',
      'mysql:8.4',
      '--default-time-zone=+00:00',
    ],
    { ...cleanEnv, MYSQL_ROOT_PASSWORD: rootPassword },
  )
  created = true
  const mounts = JSON.parse(
    run('docker', ['inspect', '--format', '{{json .Mounts}}', container]),
  ) as { Type: string }[]
  assert.ok(
    mounts.every((mount) => mount.Type !== 'volume'),
    'Isolated test instance must not use a Docker Volume.',
  )
  const address = run('docker', ['port', container, '3306/tcp'])
  const port = /^127\.0\.0\.1:(\d+)$/.exec(address)?.[1]
  assert.ok(port, 'Expected a randomly assigned loopback port.')
  const deadline = Date.now() + 120_000
  let ready = false
  while (Date.now() < deadline) {
    try {
      if (/^8\.4\./.test(mysql('SELECT VERSION()'))) {
        ready = true
        break
      }
    } catch {
      // Initialization may still be running inside the disposable container.
    }
    await delay(750)
  }
  assert.ok(ready, 'Isolated MySQL 8.4 did not become ready.')
  console.info(
    'Isolated MySQL 8.4 ready on a random loopback port with tmpfs storage.',
  )
  writeFileSync(
    keyFile,
    run('docker', ['exec', container, 'cat', '/var/lib/mysql/public_key.pem']),
    { mode: 0o600 },
  )

  mysql(
    [
      'SET GLOBAL log_bin_trust_function_creators = ON;',
      ...Object.entries(accounts).map(
        ([name, password]) =>
          "CREATE USER '" + name + "'@'%' IDENTIFIED BY '" + password + "';",
      ),
      ...databases.flatMap((name) => [
        'CREATE DATABASE ' +
          quote(name) +
          ' CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;',
        'GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, CREATE TEMPORARY TABLES, ALTER, DROP, INDEX, REFERENCES, TRIGGER ON ' +
          quote(name) +
          ".* TO 'migrator'@'%';",
      ]),
      "GRANT SELECT ON t231_pending_test.* TO 'bootstrap'@'%';",
    ].join('\n'),
  )
  const url = (role: string, database: string) =>
    'mysql://' +
    role +
    ':' +
    accounts[role] +
    '@127.0.0.1:' +
    port +
    '/' +
    database
  for (const name of databases.slice(0, 2)) {
    const migrationEnv = {
      ...cleanEnv,
      NODE_ENV: 'production',
      PRODUCTION_DATABASE_NAME: name,
      MIGRATION_DATABASE_URL: url('migrator', name),
      MYSQL_AUTH_PUBLIC_KEY_FILE: keyFile,
    }
    run(
      process.execPath,
      ['scripts/prisma.ts', '--production', 'migrate', 'deploy'],
      migrationEnv,
    )
    run(
      process.execPath,
      ['scripts/prisma.ts', '--production', 'migrate', 'status'],
      migrationEnv,
    )

    mysql(
      [
        ...Object.entries(businessPrivileges).map(
          ([table, writes]) =>
            'GRANT SELECT, ' +
            writes +
            ' ON ' +
            quote(name) +
            '.' +
            quote(table) +
            " TO 'api'@'%';",
        ),
        ...[
          '_prisma_migrations',
          'User',
          'AppSettings',
          'AdminAuditLog',
        ].flatMap((table) =>
          ['bootstrap', 'no_audit'].map((role) => {
            const insert =
              table !== '_prisma_migrations' &&
              !(table === 'AdminAuditLog' && role === 'no_audit')
            return (
              'GRANT SELECT' +
              (insert ? ', INSERT' : '') +
              ' ON ' +
              quote(name) +
              '.' +
              quote(table) +
              " TO '" +
              role +
              "'@'%';"
            )
          }),
        ),
      ].join('\n'),
    )
  }
  mysql('SET GLOBAL log_bin_trust_function_creators = OFF;')
  run(
    process.execPath,
    [
      'scripts/prisma.ts',
      '--production',
      'migrate',
      'diff',
      '--from-config-datasource',
      '--to-schema',
      'prisma/schema.prisma',
      '--exit-code',
    ],
    {
      ...cleanEnv,
      NODE_ENV: 'production',
      PRODUCTION_DATABASE_NAME: databases[0],
      MIGRATION_DATABASE_URL: url('migrator', databases[0]),
      MYSQL_AUTH_PUBLIC_KEY_FILE: keyFile,
    },
  )
  console.info(
    'Both isolated schemas received the full release migrations with the separate migrator account.',
  )
  console.info(
    run(process.execPath, ['--test', 'test/integration/production.test.ts'], {
      ...cleanEnv,
      PRODUCTION_TEST_CONTAINER: container,
      PRODUCTION_TEST_PORT: port,
      MYSQL_AUTH_PUBLIC_KEY_FILE: keyFile,
      WECHAT_QR_STORAGE_DIR: join(directory, 'wechat-qr'),
      PRODUCT_COVER_STORAGE_DIR: join(directory, 'product-covers'),
      PRODUCTION_TEST_MIGRATOR_URL: url('migrator', databases[0]),
      PRODUCTION_TEST_API_URL: url('api', databases[0]),
      PRODUCTION_TEST_BOOTSTRAP_URL: url('bootstrap', databases[0]),
      PRODUCTION_TEST_NO_AUDIT_URL: url('no_audit', databases[0]),
    }),
  )
} catch (error) {
  console.error(
    redact(
      error instanceof Error
        ? error.message
        : 'Isolated production validation failed.',
    ),
  )
  process.exitCode = 1
} finally {
  if (created) {
    try {
      run('docker', ['stop', container])
      console.info('Stopped the isolated tmpfs container.')
    } catch {
      console.error('Could not stop isolated test container ' + container + '.')
      process.exitCode = 1
    }
  }
  if (existsSync(keyFile)) unlinkSync(keyFile)
  rmdirSync(directory)
}
