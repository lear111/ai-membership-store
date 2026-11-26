#!/usr/bin/env bash
# Disposable Linux fixture. Uses the prior Linux release's unmodified lockfile
# dependencies and the current checkout's freshly compiled TypeScript output.
set -euo pipefail
umask 077
[[ $# == 3 && $EUID == 0 ]] || { echo 'Usage: rehearse.sh VERIFIED_RESTIC OPS_ARCHIVE CHECKOUT' >&2; exit 2; }
restic=$(realpath -e "$1")
archive=$(realpath -e "$2")
checkout=$(realpath -e "$3")
driver=$(realpath -e "$(dirname -- "$0")/..")
[[ -f $checkout/backend/dist/server.js && -z ${DOCKER_CONTEXT:-} && -z ${DOCKER_HOST:-} ]]
endpoint=$(docker context inspect --format '{{.Endpoints.docker.Host}}')
[[ $endpoint == unix:///var/run/docker.sock ]]
parent=${T233_FIXTURE_PARENT:-/tmp}
root=$(mktemp -d "$parent/membership-t233-XXXXXXXX")
key=$(openssl rand -hex 6)
source=membership-backup-test-$key
target=membership-restore-$key
release=${T233_CHECKOUT_SHA:-}
if [[ -z $release ]]; then
  release=$(git -c safe.directory="$checkout" -C "$checkout" rev-parse HEAD)
fi
[[ $release =~ ^[0-9a-f]{40}$ ]]
image=docker.io/library/mysql:8.4.13@sha256:72c368d898861f3b3a07af0e6d690400f44f048799ed46822783d9224cc2c86d
source_compose=(docker compose --env-file /dev/null -p "$source" -f "$root/source.compose.yaml")
target_compose=(docker compose --env-file /dev/null -p "$target" -f "$checkout/deploy/mysql/restore.compose.yaml")
cleanup() {
  local status=$?
  if [[ $status == 0 && ${KEEP_T233_FIXTURE:-0} != 1 ]]; then
    "${target_compose[@]}" down --volumes >/dev/null
    "${source_compose[@]}" down --volumes >/dev/null
    rm -rf -- "$root"
  else
    printf 'Synthetic fixture kept at %s (%s, %s)\n' "$root" "$source" "$target"
  fi
}
trap cleanup EXIT
printf 'Testing local isolated projects %s and %s\n' "$source" "$target"
install -m 0500 "$restic" "$root/restic"
mkdir -p "$root/app" "$root/images/wechat-qr" "$root/images/product-covers" "$root/shims"
tar -xzf "$archive" -C "$root/app"
cmp <(tr -d '\r' <"$root/app/package-lock.json") <(tr -d '\r' <"$checkout/package-lock.json")
diff -qr --strip-trailing-cr "$root/app/backend/prisma/migrations" "$checkout/backend/prisma/migrations"
cp -a "$checkout/backend/dist" "$root/app/backend/"
cp "$driver/test/fixture.mjs" "$root/app/backend/fixture.mjs"
root_password=$(openssl rand -hex 28)
migrate_password=$(openssl rand -hex 28)
app_password=$(openssl rand -hex 28)
backup_password=$(openssl rand -hex 28)
printf '%s\n' "$root_password" >"$root/restore-root"
printf '[client]\nuser=root\npassword=%s\n' "$root_password" >"$root/restore-client"
printf '[client]\nhost=mysql\nuser=fixture_backup\npassword=%s\nssl-mode=REQUIRED\n' \
  "$backup_password" >"$root/backup.mysql.cnf"
export RESTORE_ROOT_FILE=$root/restore-root RESTORE_CLIENT_FILE=$root/restore-client
export RESTIC_PASSWORD_FILE=$root/repo-password RESTIC_REPOSITORY=$root/repo
openssl rand -hex 32 >"$RESTIC_PASSWORD_FILE"
printf '{"gitSha":"%s"}\n' "$release" >"$root/release.json"
printf '{"fixtureProject":"%s","keepHourly":0,"keepDaily":0,"keepWeekly":0,"keepMonthly":0}\n' \
  "$source" >"$root/ops.json"
cp "$root/ops.json" "$root/ops-valid"
if [[ -z ${T273_WINDOWS_INCOMING:-} ]]; then
  printf '{"kind":"operations","gitSha":"%s"}\n' "$release" >"$root/app/release.json"
fi
cat >"$root/source.compose.yaml" <<YAML
services:
  mysql:
    image: $image
    platform: linux/amd64
    environment:
      MYSQL_DATABASE: membership_production
      MYSQL_ROOT_HOST: localhost
      MYSQL_ROOT_PASSWORD_FILE: /run/secrets/restore-root
    command: [--default-time-zone=+00:00, --character-set-server=utf8mb4, --collation-server=utf8mb4_0900_ai_ci]
    secrets: [restore-root, restore-client]
    volumes: [source-data:/var/lib/mysql]
    networks: [backup]
  backup-client:
    image: $image
    profiles: [backup]
    entrypoint: []
    read_only: true
    networks: [backup]
    volumes:
      - $root/backup.mysql.cnf:/run/secrets/backup.mysql.cnf:ro
networks:
  backup:
    internal: true
volumes:
  source-data:
secrets:
  restore-root:
    file: $root/restore-root
  restore-client:
    file: $root/restore-client
YAML
source_id=$source-mysql-1
target_id=$target-mysql-1
sql() {
  local instance=$1
  shift
  docker exec -i "$instance" mysql --defaults-file=/run/secrets/restore-client \
    --protocol=SOCKET --batch --raw --skip-column-names membership_production "$@"
}
wait_db() {
  for _ in {1..90}; do
    if sql "$1" -e "SELECT 1 WHERE @@GLOBAL.skip_networking=0" 2>/dev/null | grep -qx 1; then return; fi
    sleep 1
  done
  echo 'Synthetic MySQL did not become ready.' >&2
  return 1
}
create_accounts() {
  sql "$1" <<SQL
CREATE USER 'fixture_migrate'@'127.0.0.1' IDENTIFIED BY '$migrate_password';
GRANT SELECT,INSERT,UPDATE,DELETE,CREATE,CREATE TEMPORARY TABLES,ALTER,DROP,INDEX,REFERENCES,TRIGGER
  ON \`membership\\_production\`.* TO 'fixture_migrate'@'127.0.0.1';
CREATE USER 'fixture_api'@'127.0.0.1' IDENTIFIED BY '$app_password';
GRANT SELECT,INSERT,UPDATE ON \`membership\\_production\`.* TO 'fixture_api'@'127.0.0.1';
SQL
}
fixture_api() {
  local instance=$1 key_file=$2 images=$3 mode=$4
  shift 4
  docker run --rm --network "container:$instance" --platform linux/amd64 \
    --mount "type=bind,source=$root/app,target=/work,readonly" \
    --mount "type=bind,source=$key_file,target=/public.pem,readonly" \
    --mount "type=bind,source=$images,target=/images" \
    --mount "type=bind,source=$root/$mode.env,target=/fixture.env,readonly" \
    -w /work/backend ai-membership-store-t232-builder:local node --env-file=/fixture.env "$@"
}
operate() {
  python3 -B "$driver/backup.py" --config "$root/ops.json" --fixture "$root" "$@"
}
expected_failure() {
  local error=$1
  shift
  if "$@" >"$root/failure.log" 2>&1 || ! grep -q "$error" "$root/failure.log"; then
    cat "$root/failure.log" >&2
    return 1
  fi
  if grep -q T233_FIXTURE_PRIVATE_MARKER "$root/failure.log"; then return 1; fi
}

"${source_compose[@]}" up -d mysql
wait_db "$source_id"
create_accounts "$source_id"
sql "$source_id" -e 'SET GLOBAL log_bin_trust_function_creators=ON'
docker cp "$source_id:/var/lib/mysql/public_key.pem" "$root/source.pem"
cat >"$root/migration.env" <<ENV
NODE_ENV=production
PRODUCTION_DATABASE_NAME=membership_production
MIGRATION_DATABASE_URL=mysql://fixture_migrate:$migrate_password@127.0.0.1:3306/membership_production
MYSQL_AUTH_PUBLIC_KEY_FILE=/public.pem
ENV
cat >"$root/api.env" <<ENV
NODE_ENV=production
PRODUCTION_DATABASE_NAME=membership_production
DATABASE_URL=mysql://fixture_api:$app_password@127.0.0.1:3306/membership_production
MYSQL_AUTH_PUBLIC_KEY_FILE=/public.pem
APP_BASE_URL=https://shop.synthetic-test.org
TRUSTED_PROXY_IP=127.0.0.1
API_PORT=3101
PRODUCT_COVER_STORAGE_DIR=/images/product-covers
WECHAT_QR_STORAGE_DIR=/images/wechat-qr
ENV
fixture_api "$source_id" "$root/source.pem" "$root/images" migration scripts/prisma.ts --production migrate deploy
sql "$source_id" -e 'SET GLOBAL log_bin_trust_function_creators=OFF'
fixture_api "$source_id" "$root/source.pem" "$root/images" api fixture.mjs seed
sql "$source_id" <<SQL
CREATE USER 'fixture_backup'@'%' IDENTIFIED BY '$backup_password' REQUIRE SSL;
GRANT SELECT ON \`membership\\_production\`.* TO 'fixture_backup'@'%';
GRANT TRIGGER ON membership_production.\`Order\` TO 'fixture_backup'@'%';
GRANT TRIGGER ON membership_production.OrderRevision TO 'fixture_backup'@'%';
SQL
client=("${source_compose[@]}" run --rm -T --no-deps backup-client mysql --defaults-file=/run/secrets/backup.mysql.cnf)
expected_failure 'ERROR 1142' "${client[@]}" -e 'UPDATE Product SET sortOrder=sortOrder' membership_production
(
  # Allow trigger setup globally on this disposable server so binlog trust cannot mask a missing table grant.
  trap 'sql "$source_id" -e "DROP TRIGGER IF EXISTS FixtureProductTrigger; SET GLOBAL log_bin_trust_function_creators=OFF"' EXIT
  sql "$source_id" -e 'SET GLOBAL log_bin_trust_function_creators=ON;
    CREATE TRIGGER FixtureProductTrigger BEFORE UPDATE ON Product FOR EACH ROW SET @fixture_trigger = 1'
  expected_failure 'ERROR 1142.*TRIGGER command denied' "${client[@]}" -e \
    'CREATE TRIGGER FixtureDeniedTrigger BEFORE UPDATE ON Product FOR EACH ROW SET @fixture_trigger = 1' membership_production
  expected_failure 'ERROR 1142.*TRIGGER command denied' "${client[@]}" -e \
    'DROP TRIGGER FixtureProductTrigger' membership_production
  [[ $(sql "$source_id" -e "SELECT COUNT(*) FROM information_schema.TRIGGERS
    WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME='FixtureProductTrigger'") == 1 ]]
)
echo 'Scoped backup account denied UPDATE, CREATE TRIGGER and DROP TRIGGER on Product.'
operate init

history=20261122000000_product_cover_image
original_checksum=$(sql "$source_id" -e "SELECT checksum FROM _prisma_migrations WHERE migration_name='$history'")
[[ $original_checksum =~ ^[0-9a-f]{64}$ ]]
sql "$source_id" -e "UPDATE _prisma_migrations SET migration_name='fixture_unknown_migration' WHERE migration_name='$history'"
expected_failure MIGRATIONS_NOT_REVIEWED_CHAIN operate backup
sql "$source_id" -e "UPDATE _prisma_migrations SET migration_name='$history', checksum=REPEAT('0',64)
  WHERE migration_name='fixture_unknown_migration'"
expected_failure MIGRATIONS_NOT_REVIEWED_CHAIN operate backup
sql "$source_id" -e "UPDATE _prisma_migrations SET checksum='$original_checksum' WHERE migration_name='$history'"
# Save a single synthetic migration row solely to undo the isolated test mutation.
docker exec "$source_id" mysqldump --defaults-file=/run/secrets/restore-client --protocol=SOCKET \
  --no-create-info --skip-triggers --skip-lock-tables --skip-add-locks --no-tablespaces --set-gtid-purged=OFF \
  --where="migration_name='$history'" membership_production _prisma_migrations >"$root/fixture-migration-row.sql"
sql "$source_id" -e "DELETE FROM _prisma_migrations WHERE migration_name='$history'"
expected_failure MIGRATIONS_NOT_REVIEWED_CHAIN operate backup
sql "$source_id" <"$root/fixture-migration-row.sql"
sql "$source_id" -e 'RENAME TABLE OrderEvent TO FixtureRenamedOrderEvent'
expected_failure DATABASE_SCHEMA_INCOMPLETE operate backup
sql "$source_id" -e 'RENAME TABLE FixtureRenamedOrderEvent TO OrderEvent'
"$root/restic" --json snapshots | python3 -c 'import json,sys; assert json.load(sys.stdin) == []'
echo 'Unknown, tampered and missing migration records and a missing business table each blocked backup before snapshot creation.'

# Compare against the alternate T23.1 line-ending checksum in an actual successful backup and restore.
alternate_checksum=$(python3 -c '
import hashlib,sys
from pathlib import Path
sql = Path(sys.argv[1]).read_bytes().replace(b"\r\n", b"\n")
variants = (sql, sql.replace(b"\n", b"\r\n"))
print(next(checksum for data in variants if (checksum := hashlib.sha256(data).hexdigest()) != sys.argv[2]))
' "$root/app/backend/prisma/migrations/$history/migration.sql" "$original_checksum")
sql "$source_id" -e "UPDATE _prisma_migrations SET checksum='$alternate_checksum' WHERE migration_name='$history'"
operate backup
run1=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["run"])' "$root/state/backup.json")
if [[ -n ${T273_WINDOWS_INCOMING:-} ]]; then
  python3 -B "$driver/test/windows_rehearsal.py" "$root" "$archive" \
    "$T273_RUNTIME_ARCHIVE" "$T273_WINDOWS_INCOMING"
  mapfile -t windows < <(python3 -c '
import json, sys
data = json.load(open(sys.argv[1]))
for field in ("repository", "run", "digest"):
    print(data[field])
' "$root/windows-restore.json")
  [[ ${#windows[@]} == 3 ]]
  if grep -aR -q T233_FIXTURE_PRIVATE_MARKER "${windows[0]}"; then
    echo 'Synthetic plaintext unexpectedly found in Windows repository.' >&2
    exit 1
  fi
fi
restore_images=$root/$target-images
"${target_compose[@]}" up -d mysql
wait_db "$target_id"
expected_failure RESTORE_DEFINERS_MISSING operate restore --run "$run1" --project "$target" --output "$restore_images"
[[ ! -e $restore_images ]]
create_accounts "$target_id"
sql "$target_id" <<'SQL'
REVOKE TRIGGER,INSERT,UPDATE,DELETE,CREATE,CREATE TEMPORARY TABLES,ALTER,DROP,INDEX,REFERENCES
  ON `membership\_production`.* FROM 'fixture_migrate'@'127.0.0.1';
SQL
expected_failure RESTORE_DEFINER_PRIVILEGES operate restore --run "$run1" --project "$target" --output "$restore_images"
[[ ! -e $restore_images ]]
sql "$target_id" <<'SQL'
GRANT TRIGGER ON `membership\_production`.* TO 'fixture_migrate'@'127.0.0.1';
REVOKE SELECT ON `membership\_production`.* FROM 'fixture_migrate'@'127.0.0.1';
SQL
expected_failure RESTORE_DEFINER_PRIVILEGES operate restore --run "$run1" --project "$target" --output "$restore_images"
[[ ! -e $restore_images ]]
sql "$target_id" <<'SQL'
GRANT SELECT ON `membership\_production`.* TO 'fixture_migrate'@'127.0.0.1';
SQL
if [[ -n ${T273_WINDOWS_INCOMING:-} ]]; then
  directory=$(basename -- "${windows[0]}")
  [[ $directory =~ ^membership-[0-9a-f]{32}$ && ${windows[0]} == "$T273_WINDOWS_INCOMING/$directory" ]]
  incoming_mount=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/t273-sftp/incoming"}}{{.Source}}{{end}}{{end}}' \
    "$T273_WINDOWS_RUNNER")
  [[ $incoming_mount == /* ]]
  mkdir "$root/windows-driver"
  cp -- "$driver/"{backup,common,windows_backup}.py "$root/windows-driver/"
  install -m 0400 "$archive" "$root/windows-operations.tar.gz"
  # A separate runner sees only the encrypted repository, mounted read-only.
  # Its outputs and the disposable MySQL volume are separate from that mount.
  windows_restore=(docker run --rm --pull never --network none
    --mount "type=bind,source=$incoming_mount/$directory,target=/saved/$directory,readonly"
    --mount "type=bind,source=$root,target=$root"
    --mount "type=bind,source=$root/restic,target=/opt/restic-0.20.0/restic,readonly"
    --mount 'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock'
    --env "RESTIC_PASSWORD_FILE=$RESTIC_PASSWORD_FILE"
    "$T273_WINDOWS_TEST_IMAGE" python3 -B "$root/windows-driver/backup.py" restore
    --windows-local-repository "/saved/$directory" --operations-archive "$root/windows-operations.tar.gz"
    --operations-sha256 "${windows[2]}" --run "${windows[1]}" --project "$target")
  repository_sums() {
    (cd "${windows[0]}" && find . -type f -print0 | sort -z | xargs -0 sha256sum)
  }
  repository_sums >"$root/repository-before"
  expected_failure RESTORE_OUTPUT_INSIDE_REPOSITORY "${windows_restore[@]}" \
    --output "/saved/$directory/$target-images"
  "${windows_restore[@]}" --output "$restore_images"
  repository_sums >"$root/repository-after"
  cmp "$root/repository-before" "$root/repository-after"
  echo 'Read-only Windows repository mount restored successfully and all repository file digests were preserved.'
else
  operate restore --run "$run1" --project "$target" --output "$restore_images"
fi
expected_failure RESTORE_TARGET_NONEMPTY operate restore --run "$run1" --project "$target" --output "$root/$target-second"
[[ ! -e $root/$target-second ]]
counts() {
  local instance=$1 table
  while IFS= read -r table; do
    [[ $table =~ ^[A-Za-z0-9_]+$ ]]
    printf '%s\t' "$table"
    sql "$instance" -e "SELECT COUNT(*) FROM \`$table\`" </dev/null
  done < <(sql "$instance" -e 'SHOW TABLES')
}
counts "$source_id" >"$root/source-counts"
counts "$target_id" >"$root/restored-counts"
diff -u "$root/source-counts" "$root/restored-counts"
[[ $(wc -l <"$root/source-counts") == 14 ]]
diff -r "$root/images" "$restore_images/${root#/}/images"
printf 'Exact table counts matched across %s tables. Both restored images are byte-identical.\n' "$(wc -l <"$root/source-counts")"
docker cp "$target_id:/var/lib/mysql/public_key.pem" "$root/target.pem"
fixture_api "$target_id" "$root/target.pem" "$restore_images/${root#/}/images" api fixture.mjs restore
expected_failure ORDER_REVISION_IMMUTABLE sql "$target_id" -e \
  'DELETE FROM OrderRevision WHERE version=1'
expected_failure ORDER_DELETE_FORBIDDEN sql "$target_id" -e \
  'DELETE FROM `Order` WHERE orderNo="583024917"'
operate check-data
openssl rand -hex 32 >"$root/wrong-repo-password"
RESTIC_PASSWORD_FILE="$root/wrong-repo-password" expected_failure REPOSITORY_CHECK_FAILED operate check
if grep -aR -q T233_FIXTURE_PRIVATE_MARKER "$root/repo"; then
  echo 'Synthetic private marker was present in raw repository data.' >&2
  exit 1
fi

# Make the database stream fail after output and the second component fail after
# a real database snapshot, respectively. Both must leave the success marker.
real_docker=$(command -v docker)
cat >"$root/shims/docker" <<'SH'
#!/usr/bin/env bash
if [[ " $* " == *" mysqldump "* ]]; then
  echo T233_FIXTURE_PRIVATE_MARKER
  exit 2
fi
SH
# Restic intentionally receives only its allow-listed environment. Embed the
# verified local CLI path in this disposable shim instead of passing credentials.
printf 'exec %q "$@"\n' "$real_docker" >>"$root/shims/docker"
chmod 0700 "$root/shims/docker"
PATH="$root/shims:$PATH" expected_failure BACKUP_DATABASE operate backup
install -m 0500 "$root/restic" "$root/restic-real"
cat >"$root/restic" <<'SH'
#!/usr/bin/env bash
if [[ " $* " == *" --tag images "* ]]; then
  echo T233_FIXTURE_PRIVATE_MARKER >&2
  exit 3
fi
exec "$(dirname -- "$0")/restic-real" "$@"
SH
chmod 0500 "$root/restic"
expected_failure BACKUP_IMAGES operate backup
install -m 0500 "$root/restic-real" "$root/restic"
mv "$root/repo" "$root/repo-unavailable"
expected_failure BACKUP_DATABASE operate backup
mv "$root/repo-unavailable" "$root/repo"
mv "$root/images/product-covers" "$root/absent-covers"
expected_failure IMAGE_DIRECTORY_MISSING operate backup
mv "$root/absent-covers" "$root/images/product-covers"
printf '{"minFreeBytes":9223372036854775807}\n' >"$root/ops.json"
expected_failure LOCAL_SPACE_LOW operate backup
cp "$root/ops-valid" "$root/ops.json"
(
  flock -x 9
  expected_failure OPERATION_BUSY operate backup
) 9>"$root/state/repository.lock"
python3 - "$root/state/backup.json" "$run1" <<'PY'
import json
import sys

with open(sys.argv[1]) as stream:
    status = json.load(stream)
assert status["run"] == sys.argv[2] and status["lastSuccessAt"] and status["result"] == "failed"
PY
operate check
sleep 1
operate backup
operate plan-retention
operate apply-retention
operate plan-prune
operate prune
operate check-data
"${source_compose[@]}" stop mysql
expected_failure MYSQL_IDENTITY operate backup
printf 'Failure, lock, retention, prune and encrypted repository integrity passed. Test repository bytes: '
du -sb "$root/repo" | cut -f1
