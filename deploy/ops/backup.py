#!/usr/bin/env python3
import argparse
import datetime as dt
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import time
from urllib.parse import urlsplit
from uuid import uuid4

from common import (
    CONFIG, DATABASE, HERE, IMAGE, IMAGE_DIRS, IMAGE_ROOT, RESTIC, SNAPSHOT, STATE,
    Failure, command, configuration, docker, inspect, lock, log, private_file,
    read_json, utc, write_json,
)


PROJECT = "ai-membership-store-production"
TAG = "membership-store"
RUN = re.compile(r"[0-9a-f]{32}")
RESTORE_PROJECT = re.compile(r"membership-restore-[0-9a-f]{12}")
FIXTURE_PROJECT = re.compile(r"membership-backup-test-[0-9a-f]{12}")
KEY = re.compile(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.(png|webp)")
TABLES = {
    "_prisma_migrations", "AdminAuditLog", "AppSettings", "IdempotencyRecord",
    "InvitationToken", "Order", "OrderEvent", "OrderRevision", "PaymentTransaction",
    "Product", "Session", "Subscription", "SubscriptionEvent", "User",
}
CHAT_MIGRATION = "20261124010000_support_chat"
CHAT_TABLES = {"SupportSettings", "SupportThread", "SupportMessage", "SupportReminder"}


def expected_tables(migrations):
    return TABLES | CHAT_TABLES if CHAT_MIGRATION in migrations else TABLES


TRIGGERS = {
    "Order_renewal_immutable_update", "Order_paid_renewal_delete",
    "Order_new_source_insert", "Order_source_immutable_update", "Order_delete_guard",
    "Order_version_insert", "Order_version_update", "OrderRevision_current_version_insert",
    "OrderRevision_immutable_update", "OrderRevision_immutable_delete",
}
DUMP = [
    "--single-transaction", "--quick", "--skip-lock-tables", "--triggers",
    "--no-tablespaces", "--set-gtid-purged=OFF", "--hex-blob",
    "--default-character-set=utf8mb4", "--skip-add-drop-table", DATABASE,
]

# Canonical rows intentionally omit volatile counts, row contents, storage
# estimates and the target database's internal IDs.
SCHEMA = {
    "tables": ("TABLE_NAME,TABLE_TYPE,ENGINE,TABLE_COLLATION", "TABLES", "TABLE_SCHEMA", "TABLE_NAME"),
    "columns": (
        "TABLE_NAME,ORDINAL_POSITION,COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,"
        "EXTRA,COLLATION_NAME,GENERATION_EXPRESSION",
        "COLUMNS", "TABLE_SCHEMA", "TABLE_NAME,ORDINAL_POSITION",
    ),
    "indexes": (
        "TABLE_NAME,INDEX_NAME,NON_UNIQUE,SEQ_IN_INDEX,COLUMN_NAME,SUB_PART,INDEX_TYPE,EXPRESSION,IS_VISIBLE",
        "STATISTICS", "TABLE_SCHEMA", "TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX",
    ),
    "constraints": (
        "TABLE_NAME,CONSTRAINT_NAME,CONSTRAINT_TYPE,ENFORCED",
        "TABLE_CONSTRAINTS", "TABLE_SCHEMA", "TABLE_NAME,CONSTRAINT_NAME",
    ),
    "keys": (
        "TABLE_NAME,CONSTRAINT_NAME,ORDINAL_POSITION,COLUMN_NAME,REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME",
        "KEY_COLUMN_USAGE", "TABLE_SCHEMA", "TABLE_NAME,CONSTRAINT_NAME,ORDINAL_POSITION",
    ),
    "references": (
        "TABLE_NAME,CONSTRAINT_NAME,REFERENCED_TABLE_NAME,UPDATE_RULE,DELETE_RULE",
        "REFERENTIAL_CONSTRAINTS", "CONSTRAINT_SCHEMA", "TABLE_NAME,CONSTRAINT_NAME",
    ),
    "checks": ("CONSTRAINT_NAME,CHECK_CLAUSE", "CHECK_CONSTRAINTS", "CONSTRAINT_SCHEMA", "CONSTRAINT_NAME"),
    "triggers": (
        "TRIGGER_NAME,EVENT_OBJECT_TABLE,EVENT_MANIPULATION,ACTION_TIMING,ACTION_ORDER,"
        "ACTION_STATEMENT,DEFINER,SQL_MODE,CHARACTER_SET_CLIENT,COLLATION_CONNECTION,DATABASE_COLLATION",
        "TRIGGERS", "TRIGGER_SCHEMA", "EVENT_OBJECT_TABLE,EVENT_MANIPULATION,ACTION_TIMING,ACTION_ORDER",
    ),
    "routines": ("ROUTINE_NAME,ROUTINE_TYPE", "ROUTINES", "ROUTINE_SCHEMA", "ROUTINE_NAME"),
    "events": ("EVENT_NAME", "EVENTS", "EVENT_SCHEMA", "EVENT_NAME"),
}


def rows(mysql, sql):
    output = command([*mysql, "-e", sql], "MYSQL_METADATA")
    return [json.loads(line) for line in output.splitlines()]


def release_migrations(directory):
    migrations = {}
    try:
        for entry in directory.iterdir():
            if not entry.is_dir():
                continue
            sql = (entry / "migration.sql").read_bytes()
            lf = sql.replace(b"\r\n", b"\n")
            # Match T23.1 bootstrap: exact, LF and CRLF SHA-256.
            migrations[entry.name] = {
                hashlib.sha256(text).hexdigest() for text in (sql, lf, lf.replace(b"\n", b"\r\n"))
            }
    except OSError:
        raise Failure("OPERATIONS_MIGRATIONS_MISSING") from None
    # A historical restore uses the operations archive for that backup's release.
    t25 = "20261124000000_customer_invitation_registration"
    if CHAT_MIGRATION in migrations and t25 not in migrations:
        raise Failure("OPERATIONS_MIGRATIONS_MISSING")
    expected_count = 14 + int(t25 in migrations) + int(CHAT_MIGRATION in migrations)
    if len(migrations) != expected_count:
        raise Failure("OPERATIONS_MIGRATIONS_MISSING")
    return migrations


def verify_migrations(recorded, expected):
    if (len(recorded) != len(expected) or {row[0] for row in recorded} != expected.keys()
            or any(row[1] not in expected[row[0]] for row in recorded)):
        raise Failure("MIGRATIONS_NOT_REVIEWED_CHAIN")


def inventory(mysql, expected):
    sql = ";".join(
        f"SELECT JSON_ARRAY('{kind}',{columns}) FROM information_schema.{table} "
        f"WHERE {scope}=DATABASE() ORDER BY {order}"
        for kind, (columns, table, scope, order) in SCHEMA.items()
    )
    data = rows(mysql, sql)
    tables = [row[1] for row in data if row[0] == "tables"]
    if any(row[0] in {"routines", "events"} or
           (row[0] == "tables" and row[2:4] != ["BASE TABLE", "InnoDB"]) for row in data):
        raise Failure("UNSUPPORTED_DATABASE_OBJECT")
    if set(tables) != expected_tables(expected):
        raise Failure("DATABASE_SCHEMA_INCOMPLETE")
    migrations = rows(mysql, """
        SELECT JSON_ARRAY(migration_name,checksum,finished_at IS NOT NULL,rolled_back_at IS NULL)
        FROM _prisma_migrations ORDER BY migration_name
    """)
    if any(row[2:] != [1, 1] for row in migrations):
        raise Failure("MIGRATIONS_NOT_REVIEWED_CHAIN")
    verify_migrations(migrations, expected)
    version, schema = rows(mysql, "SELECT JSON_ARRAY(VERSION(),DATABASE())")[0]
    if version != "8.4.13" or schema != DATABASE:
        raise Failure("MYSQL_VERSION_OR_SCHEMA")
    triggers = [row for row in data if row[0] == "triggers"]
    if {row[1] for row in triggers} != TRIGGERS:
        raise Failure("TRIGGERS_NOT_REVIEWED_CHAIN")
    return {
        "mysqlVersion": version, "database": schema,
        "tables": tables,
        "migrations": [row[:2] for row in migrations],
        "schemaSha256": hashlib.sha256(json.dumps(data, separators=(",", ":")).encode()).hexdigest(),
        "triggerDefiners": sorted({row[7] for row in triggers}),
        "triggerDefinerTables": sorted([list(pair) for pair in {(row[7], row[2]) for row in triggers}]),
        "triggerCount": len(triggers),
    }


def assert_off_host(host):
    interfaces = json.loads(command(["ip", "-j", "address"], "OFFSITE_IDENTITY"))
    local = {entry["local"] for interface in interfaces for entry in interface.get("addr_info", [])}
    addresses = {item[4][0].split("%")[0] for item in socket.getaddrinfo(host, None)}
    if not addresses or any(
        address in local or ipaddress.ip_address(address).is_loopback
        or ipaddress.ip_address(address).is_unspecified for address in addresses
    ):
        raise Failure("REPOSITORY_NOT_OFFSITE")


class Repository:
    def __init__(self, fixture):
        location = os.environ.get("RESTIC_REPOSITORY", "")
        password = os.environ.get("RESTIC_PASSWORD_FILE", "")
        if not private_file(password):
            raise Failure("RESTIC_PASSWORD_PERMISSIONS")
        binary = RESTIC if fixture is None else fixture / "restic"
        self.env = {
            "PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
            "HOME": "/root",
            "RESTIC_REPOSITORY": location,
            "RESTIC_PASSWORD_FILE": password,
            "AWS_EC2_METADATA_DISABLED": "true",
        }
        self.args = [str(binary), "--no-cache"]
        if fixture is not None:
            if location != str(fixture / "repo"):
                raise Failure("FIXTURE_REPOSITORY_REQUIRED")
            # Fixture-only command shims are used for failure injection.
            self.env["PATH"] = os.environ["PATH"]
        elif re.fullmatch(r"sftp:membership-offsite:/[A-Za-z0-9/_.-]+", location):
            base = Path("/etc/ai-membership-store")
            for file in ("backup-ssh.conf", "backup-ssh-key", "backup-known-hosts"):
                if not private_file(base / file):
                    raise Failure("SFTP_FILE_PERMISSIONS")
            ssh = command(
                ["ssh", "-G", "-F", str(base / "backup-ssh.conf"), "membership-offsite"],
                "SFTP_IDENTITY",
            ).decode().splitlines()
            host = next(line.split()[1] for line in ssh if line.startswith("hostname "))
            assert_off_host(host)
            self.args += ["-o", "sftp.args=-F /etc/ai-membership-store/backup-ssh.conf "
                          "-oBatchMode=yes -oStrictHostKeyChecking=yes"]
        elif location.startswith("s3:https://"):
            url = urlsplit(location[3:])
            if not url.hostname or url.username or url.password or url.query or url.fragment or not url.path.strip("/"):
                raise Failure("S3_REPOSITORY_INVALID")
            assert_off_host(url.hostname)
            creds = os.environ.get("AWS_SHARED_CREDENTIALS_FILE", "")
            if not private_file(creds):
                raise Failure("S3_FILE_PERMISSIONS")
            self.env["AWS_SHARED_CREDENTIALS_FILE"] = creds
            for field in ("AWS_PROFILE", "AWS_DEFAULT_REGION"):
                if field in os.environ:
                    self.env[field] = os.environ[field]
        else:
            raise Failure("REMOTE_REPOSITORY_REQUIRED")
        if not re.match(rb"^restic 0\.20\.0(?:\s|$)", self.call("version")):
            raise Failure("RESTIC_VERSION")

    def call(self, *args, error="RESTIC_OPERATION", timeout=3600):
        return command([*self.args, *args], error, env=self.env, timeout=timeout)

    def snapshot(self, run, part, *args):
        output = self.call(
            "--json", "backup", "--tag", TAG, "--tag", "run:" + run, "--tag", part,
            *args, error="BACKUP_" + part.upper(),
        )
        ids = [item.get("snapshot_id", "") for line in output.splitlines()
               if (item := json.loads(line)).get("message_type") == "summary"]
        if len(ids) != 1 or not SNAPSHOT.fullmatch(ids[0]):
            raise Failure("SNAPSHOT_ID_MISSING")
        return ids[0]

    def snapshots(self):
        return json.loads(self.call("--json", "snapshots", "--tag", TAG, timeout=60))


def inspect_target(project, restore=False):
    expected = project + "-mysql-1"
    obj = inspect(expected)
    labels = obj["Config"]["Labels"]
    if (obj["Config"]["Image"] != IMAGE or not obj["State"]["Running"]
            or labels.get("com.docker.compose.project") != project
            or labels.get("com.docker.compose.service") != "mysql"):
        raise Failure("MYSQL_IDENTITY")
    if restore:
        net = obj["NetworkSettings"]["Networks"]
        if (labels.get("ai-membership-store.isolated-restore") != "true"
                or obj["HostConfig"]["PortBindings"] or set(net) != {project + "_restore"}):
            raise Failure("RESTORE_ISOLATION")
        network = json.loads(docker("network", "inspect", net[project + "_restore"]["NetworkID"]))[0]
        if not network["Internal"] or network["Labels"].get("com.docker.compose.project") != project:
            raise Failure("RESTORE_ISOLATION")
        data = [mount for mount in obj["Mounts"] if mount["Destination"] == "/var/lib/mysql"]
        if (len(data) != 1 or data[0]["Type"] != "volume"
                or data[0]["Name"] != project + "_restore-data"
                or any(mount["Destination"] not in {"/var/lib/mysql", "/run/secrets/restore-root",
                                                     "/run/secrets/restore-client"}
                       or (mount["Destination"].startswith("/run/secrets/") and mount["RW"])
                       for mount in obj["Mounts"])):
            raise Failure("RESTORE_ISOLATION")
        volume = json.loads(docker("volume", "inspect", data[0]["Name"]))[0]
        if volume["Labels"].get("com.docker.compose.project") != project:
            raise Failure("RESTORE_ISOLATION")
    return obj["Id"]


def image_directories(root):
    paths = [root / directory for directory in IMAGE_DIRS]
    if any(not path.is_dir() or path.resolve(strict=True) != path for path in paths):
        raise Failure("IMAGE_DIRECTORY_MISSING")
    return paths


def check_image_references(mysql, paths, error):
    for table, column, directory, suffix in (
        ("AppSettings", "wechatQrImageKey", paths[0], "png"),
        ("Product", "coverImageKey", paths[1], "webp"),
    ):
        for (key,) in rows(mysql, f"SELECT JSON_ARRAY({column}) FROM {table} WHERE {column} IS NOT NULL"):
            path = directory / key
            if not KEY.fullmatch(key) or not key.endswith("." + suffix) or path.is_symlink() or not path.is_file():
                raise Failure(error)


def release_sha(fixture):
    path = fixture / "release.json" if fixture else Path("/opt/ai-membership-store/current/release.json")
    sha = read_json(path, {}).get("gitSha", "")
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise Failure("RELEASE_ID_MISSING")
    return sha


def operations_root(fixture):
    return fixture / "app" if fixture else HERE.parents[1]


def backup(repo, settings, state, fixture):
    status_path = state / "backup.json"
    old = read_json(status_path, {})
    started = time.monotonic()
    started_at = utc()
    run = uuid4().hex
    try:
        root = fixture / "images" if fixture else IMAGE_ROOT
        # Confirm local headroom before starting remote operations. No SQL is staged.
        if min(shutil.disk_usage(path).free for path in (state, root.parent)) < settings.get("minFreeBytes", 268435456):
            raise Failure("LOCAL_SPACE_LOW")
        paths = image_directories(root)
        sha = release_sha(fixture)
        operations = operations_root(fixture)
        operations_manifest = read_json(operations / "release.json", {})
        if (operations_manifest.get("kind"), operations_manifest.get("gitSha")) != ("operations", sha):
            raise Failure("OPERATIONS_RELEASE_MISMATCH")
        expected = release_migrations(operations / "backend/prisma/migrations")
        if fixture:
            project = settings.get("fixtureProject", "")
            if not FIXTURE_PROJECT.fullmatch(project):
                raise Failure("FIXTURE_PROJECT_REQUIRED")
            compose = ["-f", str(fixture / "source.compose.yaml")]
        else:
            project = PROJECT
            if not private_file("/etc/ai-membership-store/backup.mysql.cnf"):
                raise Failure("MYSQL_BACKUP_FILE_PERMISSIONS")
            compose = ["-f", str(HERE.parent / "mysql/compose.yaml"),
                       "-f", str(HERE.parent / "mysql/backup.compose.yaml")]
        inspect_target(project)
        client = ["docker", "compose", "--env-file", "/dev/null", "-p", project, *compose,
                  "run", "--rm", "-T", "--no-deps", "backup-client"]
        options = ["--defaults-file=/run/secrets/backup.mysql.cnf", "--host=mysql", "--protocol=TCP",
                   "--user=" + ("fixture_backup" if fixture else "membership_backup"), "--ssl-mode=REQUIRED"]
        mysql = [*client, "mysql", *options, "--batch", "--raw", "--skip-column-names", DATABASE]
        before = inventory(mysql, expected)
        check_image_references(mysql, paths, "BACKUP_IMAGE_REFERENCE")
        database_started_at = utc()
        database = repo.snapshot(run, "database", "--stdin-from-command", "--stdin-filename", "database.sql",
                                 "--", *client, "mysqldump", *options, *DUMP)
        images = repo.snapshot(run, "images", "--one-file-system", "--", *map(str, paths))
        if (inventory(mysql, expected) != before or release_sha(fixture) != sha
                or read_json(operations / "release.json", {}) != operations_manifest
                or release_migrations(operations / "backend/prisma/migrations") != expected):
            raise Failure("DATABASE_OR_RELEASE_CHANGED")
        completed = utc()
        manifest = {
            "format": 1, "run": run, "startedAt": started_at, "databaseSnapshotStartedAt": database_started_at,
            "completedAt": completed, "releaseSha": sha, "inventory": before,
            "databaseSnapshot": database, "imagesSnapshot": images, "imagePaths": list(map(str, paths)),
        }
        # A private, small metadata file only. The SQL stream never lands here.
        import tempfile
        with tempfile.TemporaryDirectory(dir=state) as staging:
            file = Path(staging) / "manifest.json"
            write_json(file, manifest)
            marker = repo.snapshot(run, "manifest", "--stdin-from-command", "--stdin-filename",
                                   "manifest.json", "--", "cat", str(file))
        write_json(status_path, {"lastSuccessAt": completed, "lastAttemptAt": completed,
                                 "run": run, "manifest": marker, "result": "success"})
        log("backup_completed", run=run, tables=len(before["tables"]), migrations=len(before["migrations"]),
            triggers=before["triggerCount"], durationSeconds=round(time.monotonic() - started, 3))
    except (Failure, OSError, ValueError, TypeError, KeyError) as exc:
        reason = str(exc) if isinstance(exc, Failure) else "BACKUP_INTERNAL"
        write_json(status_path, {**old, "result": "failed", "lastAttemptAt": utc(), "errorCode": reason})
        raise Failure(reason) from None


def groups(repo):
    groups_by_run = {}
    for entry in repo.snapshots():
        tags = set(entry.get("tags", []))
        run = [tag[4:] for tag in tags if tag.startswith("run:")]
        part = tags.intersection({"database", "images", "manifest"})
        if len(run) != 1 or not RUN.fullmatch(run[0]) or len(part) != 1 or not SNAPSHOT.fullmatch(entry["id"]):
            raise Failure("REPOSITORY_TAGS_INVALID")
        slots = groups_by_run.setdefault(run[0], {})
        name = part.pop()
        if name in slots:
            raise Failure("REPOSITORY_DUPLICATE_COMPONENT")
        slots[name] = entry
    return groups_by_run


def load_manifest(repo, run, parts):
    if set(parts) != {"database", "images", "manifest"}:
        raise Failure("BACKUP_INCOMPLETE")
    meta = json.loads(repo.call("dump", parts["manifest"]["id"], "/manifest.json", timeout=60))
    if (meta.get("format") != 1 or meta.get("run") != run
            or meta.get("databaseSnapshot") != parts["database"]["id"]
            or meta.get("imagesSnapshot") != parts["images"]["id"]
            or meta["inventory"].get("database") != DATABASE
            or [Path(path).name for path in meta["imagePaths"]] != list(IMAGE_DIRS)
            or not all(Path(path).is_absolute() and ".." not in Path(path).parts for path in meta["imagePaths"])):
        raise Failure("BACKUP_MANIFEST_MISMATCH")
    return meta


def verify_definer_privileges(mysql, definer_tables):
    grants = rows(mysql, """
        SELECT JSON_ARRAY(CONCAT(User,'@',Host),'*',Select_priv='Y',Trigger_priv='Y')
        FROM mysql.db WHERE BINARY Db=BINARY DATABASE() OR
            (@@GLOBAL.partial_revokes=0 AND BINARY Db=BINARY REPLACE(DATABASE(),'_',CONCAT(CHAR(92),'_')))
        UNION ALL
        SELECT JSON_ARRAY(CONCAT(User,'@',Host),Table_name,
            FIND_IN_SET('Select',Table_priv)>0,FIND_IN_SET('Trigger',Table_priv)>0)
        FROM mysql.tables_priv WHERE BINARY Db=BINARY DATABASE()
    """)
    allowed = {(account, table, privilege)
               for account, table, select, trigger in grants
               for privilege, present in (("SELECT", select), ("TRIGGER", trigger)) if present}
    for account, table in definer_tables:
        if table not in {"Order", "OrderRevision"}:
            raise Failure("RESTORE_DEFINER_PRIVILEGES")
        required = [(table, "TRIGGER"), (table, "SELECT")]
        if table == "OrderRevision":
            required.append(("Order", "SELECT"))
        if any((account, name, privilege) not in allowed and (account, "*", privilege) not in allowed
               for name, privilege in required):
            raise Failure("RESTORE_DEFINER_PRIVILEGES")


def restore(repo, run, project, output, migrations_directory):
    if not RUN.fullmatch(run) or not RESTORE_PROJECT.fullmatch(project):
        raise Failure("RESTORE_TARGET_ARGUMENT")
    if (not output.is_absolute() or output.parent.resolve(strict=True) != output.parent
            or not output.name.startswith(project) or output.exists() or output.is_symlink()):
        raise Failure("RESTORE_OUTPUT_MUST_BE_NEW")
    target = inspect_target(project, restore=True)
    mysql = ["docker", "exec", "-i", target, "mysql", "--defaults-file=/run/secrets/restore-client",
             "--protocol=SOCKET", "--batch", "--raw", "--skip-column-names", DATABASE]
    empty = rows(mysql, """SELECT JSON_ARRAY(
      (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()),
      (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE()),
      (SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA=DATABASE()))""")
    if empty != [[0, 0, 0]]:
        raise Failure("RESTORE_TARGET_NONEMPTY")
    meta = load_manifest(repo, run, groups(repo).get(run, {}))
    recorded = meta["inventory"]
    expected = release_migrations(migrations_directory)
    verify_migrations(recorded["migrations"], expected)
    if set(recorded["tables"]) != expected_tables(expected):
        raise Failure("DATABASE_SCHEMA_INCOMPLETE")
    definers = {row[0] for row in rows(mysql, "SELECT JSON_ARRAY(CONCAT(User,'@',Host)) FROM mysql.user")}
    if not set(recorded["triggerDefiners"]).issubset(definers):
        raise Failure("RESTORE_DEFINERS_MISSING")
    if "triggerDefinerTables" in recorded:
        verify_definer_privileges(mysql, recorded["triggerDefinerTables"])
    started = time.monotonic()
    output.mkdir(mode=0o700)
    repo.call("restore", meta["imagesSnapshot"], "--target", str(output), "--verify", error="RESTORE_IMAGES")
    paths = [output / path.lstrip("/") for path in meta["imagePaths"]]
    if any(not path.is_dir() or path.resolve(strict=True) != path for path in paths):
        raise Failure("RESTORE_IMAGES_MISSING")
    with subprocess.Popen(
        [*repo.args, "dump", meta["databaseSnapshot"], "/database.sql"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=repo.env,
    ) as sql:
        assert sql.stdout is not None
        try:
            with subprocess.Popen(mysql, stdin=sql.stdout, stdout=subprocess.DEVNULL,
                                  stderr=subprocess.DEVNULL) as load:
                sql.stdout.close()
                try:
                    mysql_status = load.wait(timeout=3600)
                except subprocess.TimeoutExpired:
                    load.kill()
                    raise Failure("RESTORE_SQL_TIMEOUT") from None
            if mysql_status or sql.wait(timeout=60):
                raise Failure("RESTORE_SQL_FAILED")
        finally:
            if sql.poll() is None:
                sql.kill()
    restored = inventory(mysql, expected)
    if "triggerDefinerTables" not in recorded:
        # Older manifests name the accounts without their table assignments.
        verify_definer_privileges(mysql, restored.pop("triggerDefinerTables"))
    if restored != recorded:
        raise Failure("RESTORE_SCHEMA_MISMATCH")
    check_image_references(mysql, paths, "RESTORE_IMAGE_REFERENCE")
    log("restore_completed", run=run, tables=len(meta["inventory"]["tables"]),
        migrations=len(meta["inventory"]["migrations"]), triggers=meta["inventory"]["triggerCount"],
        durationSeconds=round(time.monotonic() - started, 3))


def run_tool():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=CONFIG)
    parser.add_argument("--fixture", type=Path, help="Disposable synthetic integration fixture only")
    parser.add_argument("operation", choices=("init", "backup", "check", "check-data", "plan-retention",
                                                "apply-retention", "plan-prune", "prune", "inspect", "restore"))
    parser.add_argument("--run", default="")
    parser.add_argument("--project", default="")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    if os.geteuid() != 0 or any(os.environ.get(name) for name in ("DOCKER_HOST", "DOCKER_CONTEXT")):
        raise Failure("LOCAL_ROOT_OPERATOR_REQUIRED")
    if docker("context", "inspect", "--format", "{{.Endpoints.docker.Host}}").strip() != b"unix:///var/run/docker.sock":
        raise Failure("LOCAL_DOCKER_SOCKET_REQUIRED")
    fixture = args.fixture
    if fixture and (not re.fullmatch(r"/tmp|/var/lib/docker/volumes/membership-t233-runner-[0-9a-f]{12}/_data",
                                     str(fixture.parent))
                    or not fixture.name.startswith("membership-t233-")
                    or fixture.resolve(strict=True) != fixture or args.config != fixture / "ops.json"):
        raise Failure("FIXTURE_PATH_REQUIRED")
    state = fixture / "state" if fixture else STATE
    settings = configuration(args.config)
    with lock(state, "repository"):
        repo = Repository(fixture)
        match args.operation:
            case "init":
                repo.call("init", error="REPOSITORY_INIT_FAILED")
                log("repository_initialized")
            case "backup":
                backup(repo, settings, state, fixture)
            case "restore":
                if args.output is None:
                    raise Failure("RESTORE_OUTPUT_REQUIRED")
                restore(repo, args.run, args.project, args.output,
                        operations_root(fixture) / "backend/prisma/migrations")
            case "inspect":
                log("backup_manifest", manifest=load_manifest(repo, args.run, groups(repo).get(args.run, {})))
            case _:
                from retention import maintain
                maintain(repo, settings, state, args.operation)


if __name__ == "__main__":
    try:
        run_tool()
    except (Failure, OSError, ValueError, KeyError, TypeError, IndexError, StopIteration, subprocess.TimeoutExpired) as exc:
        log("backup_operation_failed", errorCode=str(exc) if isinstance(exc, Failure) else "OPERATION_INTERNAL")
        sys.exit(1)
