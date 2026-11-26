# T23.1 production clean installation

The support-chat release has **16 migrations and 18 tables**, including Prisma migration history. Apply the complete chain from this checkout. After migration grant the runtime account SELECT and UPDATE on SupportSettings, SELECT/INSERT/UPDATE on SupportThread, SELECT/INSERT on SupportMessage, and SELECT/INSERT/UPDATE/DELETE on SupportReminder. The reminder worker deletes superseded notifications after replies or reassignment.

> **Current migration-chain override:** This historical T23.1 guide was written for the original 14-migration release. T25 PR #54 adds migration 15 (`20261124000000_customer_invitation_registration`). A fresh install using a T25 release must package and verify all 15 migrations and the matching operations bundle. Do not edit or recalculate historical migration SQL/checksums. The T23.1 count below is historical.

This procedure prepares a new MySQL 8.4 schema for the reviewed application release. Use a fresh database and private storage directories. Package the compiled API, Vue build, Linux-compatible runtime dependencies, and the exact release Prisma schema and migration directories. Keep a migration and bootstrap artifact with the release scripts, their source imports, the Prisma CLI and the generated client.

Keep the new site behind the maintenance gate through migration and first login verification. The commands below apply only to a separately approved installation target.

The [T23.2 infrastructure guide](32-production-infrastructure.md) supplies the Linux artifact, Compose, systemd and Caddy configuration templates. It uses candidate loopback ports 3101 for the API and 3310 for MySQL. Reconfirm both before approving deployment. Run the commands from the matching private operations bundle and load only the named credential context.

## Database identities and contexts

Use a fresh schema on the dedicated MySQL 8.4 instance. Pin the database name in each process with PRODUCTION_DATABASE_NAME and use the same name in its connection URL. All database connections originate on the server via loopback. Start independent shells or services with private, owner-readable-only environment files for the following contexts. Keep actual values out of command lines, shell history, releases, build inputs and access logs.

| Context | Environment | Database privileges |
| --- | --- | --- |
| API runtime | NODE_ENV=production, PRODUCTION_DATABASE_NAME, DATABASE_URL, APP_BASE_URL, TRUSTED_PROXY_IP=127.0.0.1, API_PORT and the private image storage paths. See the production runtime example. | SELECT on business tables. INSERT and UPDATE on User, Session, InvitationToken, Product, Order, PaymentTransaction and Subscription. INSERT on OrderEvent, OrderRevision, SubscriptionEvent, AdminAuditLog and IdempotencyRecord. UPDATE on AppSettings. |
| Migration | NODE_ENV=production, PRODUCTION_DATABASE_NAME, MIGRATION_DATABASE_URL | Schema-scoped SELECT, INSERT, UPDATE, DELETE, CREATE, CREATE TEMPORARY TABLES, ALTER, DROP, INDEX, REFERENCES and TRIGGER for the committed chain and migration history. The MySQL operator must handle binary-log trigger creation prerequisites in the approved migration window. Retain the trigger definer and its required privileges after migration. |
| First ADMIN | NODE_ENV=production, PRODUCTION_DATABASE_NAME, BOOTSTRAP_DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD | SELECT on _prisma_migrations. SELECT and INSERT on User, AppSettings and AdminAuditLog. |
| Backups | Separate protected MySQL client options and Restic credential files described in the [T23.3 runbook](33-production-backup-and-monitoring.md) | Schema-scoped SELECT and TRIGGER for the reviewed InnoDB and trigger dump. Confirm supported object types and exact privileges in the DBA window. |

The API rejects a runtime context containing ADMIN_EMAIL, ADMIN_PASSWORD, MIGRATION_DATABASE_URL, BOOTSTRAP_DATABASE_URL, BACKUP_DATABASE_URL or MYSQL_ROOT_PASSWORD. The application uses a non-root SQL username in each production context. Use separate accounts with distinct credentials and do not copy the .env used for local development. Passwords in connection URLs need percent-encoding.

Each production database context also needs MYSQL_AUTH_PUBLIC_KEY_FILE. Have the DBA provide the public PEM for the dedicated MySQL instance's caching_sha2_password authentication. Install a read-only copy at that absolute path and verify its fingerprint through the approved channel. The client pins this key for cold connections. Keep the private key inside MySQL. Repeat fingerprint verification after an authorized key rotation. This secures the password exchange on the loopback database connection. [MySQL caching SHA-2 authentication](https://dev.mysql.com/doc/refman/8.4/en/caching-sha2-pluggable-authentication.html)

## 1. Migrate the empty target

Verify that the expected schema is empty and belongs to the separate production MySQL instance. Confirm the approved release SHA, MySQL identity, grants and recovery path with the operator before writes. In the migration context, use the release repository root.

~~~sh
npm run db:migrate:production -w backend
npm run db:status:production -w backend
~~~

Confirm that every migration shipped with the release succeeded. Verify the schema, CHECKs, foreign keys, indexes and trigger definers. Keep production launch gated on any failure or partial DDL. Preserve the database and review the migration record and grants before taking separately approved corrective action.

## 2. Initialize the first administrator once

With the migration process stopped, load the distinct first-ADMIN context. Use the actual administrator email and a 12–128 character password from the approved secret store.

~~~sh
npm run db:bootstrap:production -w backend
~~~

The command verifies the connected schema and compares the applied status, names and checksums with the release migration SQL. It requires an empty User table. It then creates the stable ADMIN identity in ACTIVE state with an Argon2id password hash, the AppSettings singleton and an initialization audit entry in one transaction. A second invocation exits with a conflict, even when the supplied email matches. Existing users and settings are preserved on any conflict or failed transaction.

On failure, keep registration and other writers gated. Check the selected database, successful migration history, bootstrap privileges and existing state through the approved operator channel. A registered CUSTOMER or prior administrator requires review by the authorized operator. Follow the account and recovery decision before taking further action.

Remove the bootstrap configuration and ADMIN password from the invocation environment after success. Retain the administrator password only in the approved password store. Remove bootstrap database access after verification under the approved account lifecycle. Keep the migration, bootstrap and backup credentials out of the API unit.

## 3. Start and verify

Load the runtime context and run from the release root. The compiled entry validates the production profile and listens only on 127.0.0.1.

~~~sh
npm run start:production -w backend
~~~

For the later systemd unit, use the equivalent direct Node entry from the backend working directory so the supervisor signals the API process. Production startup performs neither migration nor bootstrap. On SIGINT/SIGTERM, the API stops accepting connections, stops both schedulers, waits for in-flight HTTP requests and task batches, then disconnects Prisma. The unit stop timeout must allow this drain.

APP_BASE_URL must be the canonical HTTPS origin with a real hostname. Omit the port or specify 443. Do not include user info, a non-root path, a query or a fragment. Development remains on loopback. The production app trusts only the direct configured 127.0.0.1 Caddy peer at hop zero. In the later dedicated Caddy site, set upstream X-Forwarded-For to the immediate browser peer address using Caddy's remote host value and discard any incoming forwarded chain. Use no upstream trusted proxies unless reviewed separately. External clients cannot connect directly to the Node listener. Other local processes share this trust boundary. Keep incoming browser Origin intact for CSRF checks.

Set WECHAT_QR_STORAGE_DIR and PRODUCT_COVER_STORAGE_DIR to separate absolute paths in private, persistent storage outside the release trees and the Caddy static web root. Use the real directories on disk, without symbolic links or junctions. Keep the paths stable across release switches and give the API service user read and write access. Serve the Vue build from the selected release's frontend/dist. Startup rejects missing or overlapping image storage paths, including paths in the running release and its static web root. The .local-data defaults apply only to local development and tests.

Check loopback API health. Through the separately approved HTTPS gateway, sign in via /admin/login, verify the account is ACTIVE ADMIN, and confirm the administrator can read the initial settings. Check cookie Secure, HttpOnly and SameSite=Strict flags. Log out and confirm that the session is revoked. After the go/no-go, public registration at /register creates ACTIVE CUSTOMER accounts. Verify customer/admin separation and own-record access in the next authorized rehearsal using synthetic inputs. Any actual service, DNS, Caddy, database or account operation belongs to a later approved deployment window.

## Local validation

Run the isolated T23.1 suite from the repository root.

~~~sh
npm run test:production -w backend
~~~

The test creates a random loopback-only MySQL 8.4 container with tmpfs data storage and synthetic, separate accounts. It migrates two fresh test schemas. One exercises first-ADMIN success and secure production HTTP behavior. The other proves an initial public registration is still CUSTOMER and blocks bootstrap. A third empty schema exercises the missing-migration guard. Test credentials and data remain confined to this container. The test stops its disposable container without using a Docker Volume.

T23.1 verification on Node 24.13.0 passed 51 frontend tests, 86 backend unit tests and 5 real MySQL integration tests. Both migrated schemas received all 14 unchanged migrations. The suite verified schema parity and the presence of indexes, foreign keys, CHECKs and 10 triggers. It also tested audit failure rollback, concurrent initialization, secure cookie attributes, CSRF, origin and proxy rate limiting, role and record isolation, and a CUSTOMER-first target. Caddy and systemd acceptance belongs to the subsequent deployment stages.
