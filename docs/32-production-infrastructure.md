# T23.2 production infrastructure

For the support-chat release, package all 16 migrations. Add the four chat-table runtime grants in [the clean installation guide](31-production-clean-install.md). The production database name is `membership_production`; Docker initializes it on the first start with an empty data volume. With an existing volume, check the target instance and database name before migration. Changing `MYSQL_DATABASE` on an initialized volume does not create a database.

> **Current release-chain override:** T25 PR #54 adds the 15th Prisma migration. The historical 14-migration count below describes the original T23.2 artifact. Current T25 runtime/operations artifacts must be built from the same reviewed SHA and include all 15 migrations; run the release verifier and matching migration preflight. Legacy 14-migration backups must continue to use their matching historical operations archive.

**Merged baseline** — T23.2 merged in [PR #51](https://github.com/lear111/ai-membership-store/pull/51), following T23.1 in PR #50. These templates and release tools are for the Ubuntu 24.04 x86_64 hybrid design. The Seoul host inventory is the 2026-11-21 audit in the [deployment design](28-production-deployment-design.md). Reconfirm its capacity, existing sites and listener inventory in a separately approved window.

## Topology and paths

Existing Caddy terminates HTTPS for the approved host and serves the Vue build. Its site forwards /api and /api/* with the prefix intact to one systemd-managed API. That process runs both minute workers and connects to a dedicated Docker MySQL instance. Use the existing automatic TLS and HTTP redirect behavior. Keep the public entry on Caddy's 80/443 and retain the existing SSH and firewall policies.

The **candidate** loopback endpoints are API 127.0.0.1:3101 and MySQL 127.0.0.1:3310. Recheck both on the shared host. If either is occupied, coordinate a new endpoint across the Caddy upstream, Compose publication, runtime/migration/bootstrap URLs, health check and preflight before deployment. Keep the existing listener on 3000. The MySQL container's internal port is 3306.

| Path | Ownership and mode |
| --- | --- |
| /opt/ai-membership-store, its releases directory and current / previous symlinks | root:root, directory mode 0755. Each release is identified by its full Git SHA. The installer removes all write bits from release files and directories and leaves them readable to the API and Caddy. |
| /opt/ai-membership-store/immutable/assets | root:root 0755 parent directories, with read-only files linked from verified releases. Keep the store and releases on the same filesystem. Caddy may read the store. |
| /opt/node-v24.13.0-linux-x64 | root:root, traverse/read/execute for the service accounts, writable only by the authorized installer. |
| /srv/membership-data | root:membership-store 0750. QR and cover subdirectories each membership-store:membership-store 0700, physically separate, outside the release tree and Caddy root. Include both in coordinated backups. |
| /etc/ai-membership-store | root:membership-store 0750. The runtime.env, migration.env, bootstrap.env, backup.env and mysql-root-password files are individually root:root 0600. Systemd reads runtime.env before dropping privileges. |
| /etc/ai-membership-store/mysql-auth-public.pem | root:root 0644, accessible to the API through the private parent. This is the verified public key. |
| MySQL data | Compose project ai-membership-store-production, named volume ai-membership-store-production_mysql-data at /var/lib/mysql inside the container. Docker manages the volume. Reserve host disk space for it and never reuse another instance's volume. |
| Operations bundle and its working directory | Keep in a separate root-owned 0700 location outside both the release and web roots. Extraction and execution require separate approval. |

Create a dedicated system user and group named membership-store with no login shell. The [unit](../deploy/systemd/ai-membership-store.service) directly launches the compiled API with --production. ProtectSystem=strict and the two ReadWritePaths keep the release read-only and allow only the two application data directories to be written by the service. The unit sends SIGTERM and allows 90 seconds for HTTP and both worker batches to drain before systemd escalates. Check the observed worst-case drain in T23.4. Standard output and errors go to journald. Retention, alerting, backup automation and monitoring belong to T23.3.

## Host prerequisites

Provision the service runtime separately from the build container in an approved host change window. Use the official Linux x64 Node.js 24.13.0 archive. Compare the archive with both the official release checksum list and the digest pinned in the build Dockerfile before extraction. If the target already exists, verify its version, contents and ownership before reuse. Preserve the Node binaries used by other services. [Official Node.js 24.13.0 checksums](https://nodejs.org/download/release/v24.13.0/SHASUMS256.txt)

~~~sh
(
  set -euo pipefail
  work=$(mktemp -d)
  trap 'rm -rf -- "$work"' EXIT
  cd "$work"
  base=https://nodejs.org/download/release/v24.13.0
  archive=node-v24.13.0-linux-x64.tar.xz
  curl --fail --silent --show-error --location --proto '=https' --output "$archive" "$base/$archive"
  curl --fail --silent --show-error --location --proto '=https' --output SHASUMS256.txt "$base/SHASUMS256.txt"
  awk -v file="$archive" '$2 == file { print }' SHASUMS256.txt | sha256sum --check --strict
  printf '%s  %s\n' e798599612f4bb71333a3397ab0d095fd62214e115aea45aa858a145fc72d67e "$archive" |
    sha256sum --check --strict
  target=/opt/node-v24.13.0-linux-x64
  test ! -e "$target" && test ! -L "$target" || { echo 'Node runtime path already exists' >&2; exit 1; }
  stage=$(sudo mktemp -d /opt/.membership-node.XXXXXXXX)
  sudo tar --no-same-owner --strip-components=1 -xJf "$archive" -C "$stage"
  sudo chown -hR root:root "$stage"
  sudo chmod -R a+rX,a-w "$stage"
  sudo mv --no-clobber -T "$stage" "$target"
  test ! -e "$stage"
  test "$("$target/bin/node" --version)" = v24.13.0
  test "$(PATH="$target/bin:$PATH" "$target/bin/npm" --version)" = 11.6.2
)
~~~

On Ubuntu 24.04 amd64, use Docker's signed APT repository and its Docker Engine, CLI, containerd and Compose v2 plugin packages. Review existing packages and conflicts on the shared host before any changes. Record the approved package versions with `apt-cache policy docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin`. Simulate the installation of the selected versions before applying it in the approved window. Installation may start the daemon. Use a supported patched Engine and verify the actual installed client and server with `sudo docker version`, the plugin with `sudo docker compose version`, and daemon state with `systemctl is-active docker`. Reconfirm the isolation of published loopback ports with the installed Engine in T23.4. No Docker socket access is required by the API user. [Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/)

## MySQL configuration and accounts

On an initialized volume, confirm whether the application database exists. If it is missing, run [create-database.sql](../deploy/mysql/create-database.sql) in the DBA session on the dedicated instance. This creates the named database with the same character set and collation as the production Compose configuration and reports the result. Use the same volume for the next start.

The [production Compose template](../deploy/mysql/compose.yaml) uses the official MySQL 8.4.13 linux/amd64 manifest at sha256:72c368d898861f3b3a07af0e6d690400f44f048799ed46822783d9224cc2c86d. This is the architecture-specific manifest verified against the registry. Compose uses UTC and utf8mb4_0900_ai_ci and publishes only on loopback. The health check tests TCP server availability, while the API health endpoint tests an authenticated database query. The 768 MiB container limit, 256 MiB InnoDB buffer pool and 40 connections are starting values pending the capacity rehearsal. Compose allows 90 seconds for MySQL to stop before escalation. Measure shutdown under representative write and backup load in T23.4. Change only the nonsecret knobs MYSQL_MEMORY_LIMIT, MYSQL_INNODB_BUFFER_POOL_SIZE and MYSQL_MAX_CONNECTIONS in an explicit Compose environment file. Use an empty file or --env-file /dev/null to use the reviewed defaults. [Official MySQL image](https://hub.docker.com/_/mysql)

Only during an approved change window, place the root credential from the approved secret store into the private mysql-root-password file before the first Compose start. Use a high-entropy hexadecimal bootstrap password since the image's entry point puts that value in a SQL string literal. The image reads the file and initializes the dedicated schema on an empty volume. It keeps root local to the container. Never place a password in the Compose file, command arguments or shell history. Treat access to the Docker daemon as administrative access. Use a socket DBA login inside the container with interactive -p and MYSQL_HISTFILE=/dev/null. Disable terminal capture for the credential-installation steps. Save generated passwords directly in the approved store.

Confirm the actual MySQL client peer for local Node connections during the rehearsal. Container port forwarding can make the peer the production bridge gateway. Substitute that exact peer for HOST_FROM_REHEARSAL in each account name and verify USER(), CURRENT_USER() and SHOW GRANTS in each connection context. Keep the bridge peer stable or review the change and update the scoped account. Avoid wildcard host grants. Example account creation in the private DBA session:

~~~sql
CREATE USER 'membership_api'@'HOST_FROM_REHEARSAL'
  IDENTIFIED WITH caching_sha2_password BY RANDOM PASSWORD;
CREATE USER 'membership_migrator'@'HOST_FROM_REHEARSAL'
  IDENTIFIED WITH caching_sha2_password BY RANDOM PASSWORD;
CREATE USER 'membership_bootstrap'@'HOST_FROM_REHEARSAL'
  IDENTIFIED WITH caching_sha2_password BY RANDOM PASSWORD;
CREATE USER 'membership_backup'@'HOST_FROM_REHEARSAL'
  IDENTIFIED WITH caching_sha2_password BY RANDOM PASSWORD;
~~~

- **Before migration** grant the migrator SELECT, INSERT, UPDATE, DELETE, CREATE, CREATE TEMPORARY TABLES, ALTER, DROP, INDEX, REFERENCES and TRIGGER on the single production schema. The database-level schema pattern in GRANT must escape the underscore as membership\_production with partial_revokes=OFF. Check the server setting first. With partial_revokes=ON, use the literal schema name. Confirm exact scope with SHOW GRANTS. Keep the migration trigger definer account and required privileges available after migration.
- **After migration** grant the API SELECT, INSERT, UPDATE on User, Session, InvitationToken, Product, Order, PaymentTransaction and Subscription. Grant SELECT and INSERT on OrderEvent, OrderRevision, SubscriptionEvent, AdminAuditLog and IdempotencyRecord. Grant SELECT and UPDATE on AppSettings. Use individual table grants on the literal schema name. The API has no schema modification, DELETE, TRIGGER or administrative grants.
- **First ADMIN** grant SELECT on _prisma_migrations, and SELECT and INSERT on User, AppSettings and AdminAuditLog. Follow the [Clean Install guide](31-production-clean-install.md) and retire access to the bootstrap credential after verification.
- **Backup** provision a separate login for the internal backup network with schema-scoped SELECT and TRIGGER per the [T23.3 runbook](33-production-backup-and-monitoring.md). The backup client is short-lived. MySQL rotation, the API's journal namespace and maintenance units are described in the same runbook.

The DBA handles the binary logging/trigger prerequisite in the approved migration window. If temporary log_bin_trust_function_creators is required, record and restore the original value once all reviewed migrations and trigger checks finish. Do not put the setting in permanent startup flags or give the API DBA privileges. A migration failure pauses the rollout for object and history inspection. [MySQL binary logging and triggers](https://dev.mysql.com/doc/refman/8.4/en/stored-programs-logging.html)

In the approved DBA window, inspect caching_sha2_password_public_key_path on the dedicated instance. For the default instance key at /var/lib/mysql/public_key.pem, obtain its SHA-256 inside the container, export only that public PEM to a private temporary file and compare the file hash with the DBA's independently verified source fingerprint. Install the matched file as /etc/ai-membership-store/mysql-auth-public.pem and set MYSQL_AUTH_PUBLIC_KEY_FILE to it in API, migration and bootstrap contexts. Verify cold connections after approved key rotation. Leave the private key in the container.

Use plain, single-line KEY=VALUE assignments for runtime.env as in the [runtime example](../.env.production.example), with percent-encoded database credentials. Set MYSQL_AUTH_PUBLIC_KEY_FILE exactly once to the documented path. The API preflight inspects the configuration without sourcing it. It rejects symlinks and checks ownership, modes, readability as membership-store and RSA public-key format. Compare the fingerprint separately against the DBA's verified value.

Use separate private environment files for each operation and clear the ambient environment before loading one. In the operations bundle, run the named scripts using absolute Node paths. For example, from the bundle's backend directory the authorized operator can use the following commands after grants and target verification. These are future operations, separate from template validation.

~~~sh
env -i PATH=/opt/node-v24.13.0-linux-x64/bin:/usr/bin:/bin \
  node --env-file=/etc/ai-membership-store/migration.env \
  scripts/prisma.ts --production migrate deploy
env -i PATH=/opt/node-v24.13.0-linux-x64/bin:/usr/bin:/bin \
  node --env-file=/etc/ai-membership-store/migration.env \
  scripts/prisma.ts --production migrate status
env -i PATH=/opt/node-v24.13.0-linux-x64/bin:/usr/bin:/bin \
  node --env-file=/etc/ai-membership-store/bootstrap.env prisma/bootstrap-admin.ts
~~~

## Build, install and recover a release

Run [the build script](../scripts/build-production-release.sh) on an independent Ubuntu 24.04 x86_64 build host with Node 24.13.0. The optional [build image](../deploy/release/build.Dockerfile) verifies the Linux Node archive against the published checksum. Use a clean committed checkout and an output directory outside it with an existing parent.

~~~sh
bash scripts/build-production-release.sh /path/to/artifacts/new-directory
cd /path/to/artifacts/new-directory
sha256sum --check --strict SHA256SUMS
~~~

The script starts from git archive HEAD and a fresh process environment. npm ci uses the committed lockfile and generates Prisma Client before building both workspaces. The runtime bundle contains Vue and Express build output, package metadata and the API's required dependencies, including installed platform-specific optional packages. The Prisma CLI and its optional peer dependency chain stay in the separate operations bundle with generated client, schema, the complete migration chain, config, source and the migration/bootstrap entry points. Both manifests identify one Git SHA, Node/npm/Prisma versions, the MySQL image, build time and SHA256SUMS. Verify the archive SHA independently before extraction. The archive hash also covers paths, modes and npm workspace symlinks. Transfer the approved checksums through a trusted channel. The bundles contain no workstation environment, images, credentials, or database data. [Node.js 24.13.0 checksums](https://nodejs.org/download/release/v24.13.0/SHASUMS256.txt)

1. Gate traffic. Approve the release, target, maintenance and recovery points under the [controlled launch plan](28-production-deployment-design.md#7-t235-controlled-production-launch). Reconfirm the host version, listeners, resource and disk budgets, existing-site health, grants, trigger requirements, backup integrity, Caddy import and TLS. After preparing the host prerequisites and private layout, run `bash deploy/release/preflight.sh --before-mysql` before the first MySQL start. This checks the candidate ports, binaries, configuration modes and template syntax before the database has supplied its RSA key.
2. Use [release.sh](../deploy/release/release.sh) as the authorized operator with the full Git SHA, runtime archive and independently verified archive SHA-256. install verifies the bundle before extracting in a private staging directory, checks the manifest and per-file checksums, and installs a new immutable release directory. An existing ID is rejected. Extract the separately verified operations bundle in its private area. Keep the prior runtime and ops artifacts for recovery.
3. Stop the previous API before switching so only one worker instance exists. Perform any separately approved migrations and bootstrap using the matching operations bundle. Confirm database compatibility before proceeding. Invoke switch with the new Git SHA to atomically replace current and remember the previous release. The link operation starts or stops no services.
4. With the API stopped and dedicated MySQL running, install the independently verified RSA key and run `bash deploy/release/preflight.sh --before-api` (the default). It checks the available API port, the dedicated MySQL port mapping and the runtime key. Start the unit in the approved window and run [health.sh](../deploy/release/health.sh). Set the exact approved host in a copy of [the site template](../deploy/caddy/ai-membership-store.caddy) and the same HTTPS origin in runtime.env. Place the site under a dedicated file and add a single import to the approved existing Caddyfile only if there is no existing matching include. For example, import /etc/caddy/sites/ai-membership-store.caddy. Validate the complete candidate configuration with the installed binary before an authorized reload. Existing virtual hosts and global settings stay in their own files. Verify HTTPS redirect, certificate, API and Vue routes, authenticated flows and each existing site's health before opening traffic.
5. Upon failure, gate traffic and stop the new API. If the previous application can safely use the current database, use rollback to atomically select the previous runtime and verify health before reopening. If migration status or schema compatibility is uncertain, retain the source data and escalate to the DBA. Release switching changes neither schema nor data. Both link replacements are atomic individually; interruption between previous and current updates can leave both pointing at the old release. Confirm the links and repeat the reviewed switch if necessary. On the first release there is no previous target.

Example release operations after approval:

~~~sh
bash deploy/release/release.sh install "$release_sha" "$runtime_archive" "$verified_sha256"
bash deploy/release/release.sh switch "$release_sha"
# With traffic gated, the API stopped, and database compatibility confirmed:
bash deploy/release/release.sh rollback
~~~

Caddy matches /api and /api/* before SPA fallback, preserves the API path and the browser Origin, and sets X-Forwarded-For to the socket peer using http.request.remote.host. The API trusts only the configured loopback proxy. Vue history paths and ordinary static files use current/frontend/dist. Missing assets and file-like paths return 404. HTML revalidates. The site sets nosniff, frame denial and no-referrer on its responses, with a one-year HSTS policy scoped to its HTTPS hostname. Review CSP after testing the production build. The template assumes direct clients to Caddy. Adding an upstream CDN or proxy changes the IP trust boundary and needs review. [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)

Verified fingerprinted files under /assets accumulate in the shared immutable store before their release is selected. Caddy serves those files for a year with immutable caching, including chunks requested by tabs still running any earlier installed release. Identical names deduplicate only when bytes agree. A content collision stops the install before the existing asset is changed. The current/previous links select HTML and the API independently of asset availability. Retain assets from all installed releases and budget their cumulative unique bytes. There is no automatic pruning in T23.2. Any future cleanup needs a reviewed retention window for open tabs and rollback, plus an inventory and disk-space check.

## Isolated verification

Render the Compose model with `docker compose --env-file /dev/null -f deploy/mysql/compose.yaml config --format json > compose-model.json`. Compare the exact image reference with the registry's linux/amd64 manifest and check the port, volume, secret source, health probe, initial limits and stop grace period. Keep the JSON outside the source checkout.

For Linux artifact validation, build `deploy/release/build.Dockerfile` with the tag `ai-membership-store-t232-builder:local` and build `deploy/release/verify.Dockerfile` with the same local builder as its base. Both Dockerfiles use the context `deploy/release` and platform `linux/amd64`. Build the release in the builder from a clean checkout. Run `bash deploy/release/verify.sh ARTIFACT_DIR GIT_SHA COMPOSE_JSON` inside a new verifier container with no published ports, `--network none` and read-only mounts for the templates, artifacts and rendered Compose model. The verifier needs its own temporary filesystem for the synthetic installation. It checks the modeled MySQL stop grace period, native processing, artifact integrity, Prisma tooling, non-root startup without SQL and SIGTERM drain. A synthetic certificate enables real loopback HTTPS tests for security headers, routing, caching and retained assets across three releases, with collision, switch and rollback checks. Synthetic RSA fixtures cover missing, unsafe and invalid runtime keys. This verification uses no running MySQL server, systemd PID 1, public DNS or public certificate.

Actual MySQL startup/grant verification, a systemd-managed start through the hardened unit, shared Caddy import, public TLS and live-site health require the separately authorized T23.4 rehearsal and T23.5 launch checks.

## Capacity and next gates

These are planning estimates, not benchmark results. Allow roughly 450–750 MiB for MySQL under a small working set, 180–400 MiB for the Node API across online operation and image/Argon2 bursts, and 25–75 MiB incremental for the existing Caddy. The combined estimate is roughly 655–1,225 MiB before disk cache, concurrent backup work and changes in the existing services' resource use. MySQL per-connection buffers, native image decoding and password hashing can drive transient peaks. The historical 1,138 MiB available and 605 MiB used swap after three services stopped provide a point-in-time comparison. A 2 GB startup fits the low end on paper. Minimum startup on that host and steady coexistence remain unmeasured. Capacity approval remains pending.

Plan the T23.4 rehearsal on a separate 4 GiB/2 vCPU Ubuntu 24.04 environment with the intended MySQL disk and comparable existing-site load. Record idle and active host, process and cgroup memory, swap, CPU, IO, disk/inode and listener baselines. Run clean installation and restart with isolated synthetic data. Exercise concurrent registration/login, catalog reads, cover/QR uploads, order writes, both workers and backup/restore contention. Include a sustained run and repeated health, TLS and latency probes of the colocated sites. Compare OOM/restarts, swap growth, DB pool use, API p95 and worker lag with the agreed thresholds. Verify drain timing and spare host/volume space for recovery before accepting limits. T23.3 must deliver backup/restore, logging and monitoring; T23.4 must deliver deployment and capacity rehearsal; T23.5 is the separately approved launch.
