#!/usr/bin/env python3
import argparse
from contextlib import nullcontext
import datetime as dt
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit
from uuid import uuid4

from common import (
    CONFIG, DATABASE, HERE, IMAGE, IMAGE_DIRS, IMAGE_ROOT, RESTIC, SNAPSHOT, STATE,
    Failure, command, configuration, docker, inspect, lock, log, private_file,
    read_json, utc, write_json,
)
from windows_backup import WindowsTunnel, local_windows_repository, verified_operations


PROJECT = "ai-membership-store-production"
RELEASE_ROOT = Path("/opt/ai-membership-store")
API_UNIT = "ai-membership-store.service"
API_PORT = 3101
CGROUP_ROOT = Path("/sys/fs/cgroup")
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
    try:
        return migration_checksums({
            entry.name: (entry / "migration.sql").read_bytes()
            for entry in directory.iterdir() if entry.is_dir()
        })
    except OSError:
        raise Failure("OPERATIONS_MIGRATIONS_MISSING") from None


def migration_checksums(scripts):
    # A historical restore uses the operations archive for that backup's release.
    t25 = "20261124000000_customer_invitation_registration"
    if len(scripts) != (15 if t25 in scripts else 14):
        raise Failure("OPERATIONS_MIGRATIONS_MISSING")
    migrations = {}
    for name, sql in scripts.items():
        lf = sql.replace(b"\r\n", b"\n")
        # Match T23.1 bootstrap: exact, LF and CRLF SHA-256.
        migrations[name] = {
            hashlib.sha256(text).hexdigest() for text in (sql, lf, lf.replace(b"\n", b"\r\n"))
        }
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
    if set(tables) != TABLES:
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
    def __init__(self, fixture, *, tunnel=None, staging=None, local_repository=None):
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
        self.tunnel = tunnel
        self.local_repository = local_repository
        if tunnel is not None:
            self.set_explicit_location(location, tunnel.location)
            self.sftp, transport = tunnel.configure(staging, self.env)
            self.args += ["-o", transport]
        elif local_repository is not None:
            self.set_explicit_location(location, local_windows_repository(local_repository))
            # Reading a saved repository must not leave lock files on Windows.
            self.args += ["--no-lock"]
        elif fixture is not None:
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

    def set_explicit_location(self, inherited, selected):
        if inherited and inherited != selected:
            raise Failure("WINDOWS_REPOSITORY_ENV_MISMATCH")
        self.env["RESTIC_REPOSITORY"] = selected

    def initialize_windows(self):
        self.tunnel.verify_listener()
        # mkdir fails if the dedicated directory already exists; never reuse an old run.
        command(self.sftp, "WINDOWS_REPOSITORY_NOT_NEW",
                input=f"mkdir {self.tunnel.directory}\n".encode("ascii"), env=self.env)
        self.call("init", error="REPOSITORY_INIT_FAILED")

    def call(self, *args, error="RESTIC_OPERATION", timeout=3600):
        if self.tunnel is not None and args != ("version",):
            self.tunnel.verify_listener()
        return command([*self.args, *args], error, env=self.env, timeout=timeout)

    def snapshot(self, run, part, *args, staged=False):
        tags = [] if staged else ["--tag", TAG]
        output = self.call(
            "--json", "backup", *tags, "--tag", "run:" + run, "--tag", part,
            *args, error="BACKUP_" + part.upper(),
        )
        ids = [item.get("snapshot_id", "") for line in output.splitlines()
               if (item := json.loads(line)).get("message_type") == "summary"]
        if len(ids) != 1 or not SNAPSHOT.fullmatch(ids[0]):
            raise Failure("SNAPSHOT_ID_MISSING")
        return ids[0]

    def publish_manifest(self, snapshot_id):
        if not SNAPSHOT.fullmatch(snapshot_id):
            raise Failure("SNAPSHOT_ID_MISSING")
        output = self.call("--json", "tag", "--add", TAG, snapshot_id, error="BACKUP_MANIFEST_PUBLISH")
        changes = [item for line in output.splitlines()
                   if (item := json.loads(line)).get("message_type") == "changed"]
        if (len(changes) != 1 or changes[0].get("old_snapshot_id") != snapshot_id
                or not SNAPSHOT.fullmatch(changes[0].get("new_snapshot_id", ""))):
            raise Failure("BACKUP_MANIFEST_PUBLISH")
        return changes[0]["new_snapshot_id"]

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


def matching_runtime(archive):
    current = RELEASE_ROOT / "current"
    runtime = read_json(current / "release.json", {})
    if (runtime.get("kind"), runtime.get("gitSha")) != ("runtime", archive.release_sha):
        raise Failure("OPERATIONS_RELEASE_MISMATCH")
    pid = command(["systemctl", "show", API_UNIT, "--property=MainPID", "--value"],
                  "RUNNING_RELEASE_IDENTITY").decode().strip()
    if (not re.fullmatch(r"[1-9][0-9]*", pid)
            or Path("/proc", pid, "cwd").resolve() != current.resolve(strict=True) / "backend"):
        raise Failure("RUNNING_RELEASE_IDENTITY")
    return runtime


def stopped_service():
    required = {
        "Id": API_UNIT, "LoadState": "loaded", "ActiveState": "inactive", "SubState": "dead",
        "Result": "success", "MainPID": "0", "ControlPID": "0", "ExecMainCode": "1",
        "ExecMainStatus": "0", "Slice": "system.slice",
        "WorkingDirectory": str(RELEASE_ROOT / "current/backend"),
    }
    timestamps = ("ExecMainStartTimestampMonotonic", "ExecMainExitTimestampMonotonic",
                  "InactiveEnterTimestampMonotonic", "InactiveExitTimestampMonotonic")
    properties = (*required, *timestamps, "ControlGroup", "InvocationID", "NRestarts")
    output = command(["systemctl", "show", API_UNIT, "--all",
                      "--property=" + ",".join(properties)], "MAINTENANCE_SERVICE_STATE")
    state = dict(line.split("=", 1) for line in output.decode().splitlines() if "=" in line)
    if (not set(properties).issubset(state)
            or any(state[key] != value for key, value in required.items())
            or any(not re.fullmatch(r"[1-9][0-9]*", state[key]) for key in timestamps)
            or not int(state[timestamps[0]]) <= int(state[timestamps[1]]) <= int(state[timestamps[2]])):
        raise Failure("MAINTENANCE_SERVICE_NOT_STOPPED")
    return state


def sealed_runtime(target, sha):
    # The release installer seals the tree and verifies this same checksum list.
    manifest, checksums = target / "release.json", target / "SHA256SUMS"
    for path in (target, manifest, checksums):
        attributes = path.lstat()
        if (attributes.st_uid != 0 or attributes.st_gid != 0
                or attributes.st_mode & 0o222 or path.is_symlink()
                or (path != target and not stat.S_ISREG(attributes.st_mode))):
            raise Failure("MAINTENANCE_RUNTIME_NOT_IMMUTABLE")
    runtime = read_json(manifest, {})
    if (runtime.get("kind"), runtime.get("gitSha"), runtime.get("checksums")) != (
        "runtime", sha, "SHA256SUMS"
    ):
        raise Failure("OPERATIONS_RELEASE_MISMATCH")
    contents = checksums.read_bytes()
    checked = {}
    for line in contents.decode().splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})  \./([^\r\n\\]+)", line)
        if not match or any(part in ("", ".", "..") for part in match[2].split("/")):
            raise Failure("MAINTENANCE_RUNTIME_CHECKSUM")
        checked[match[2]] = match[1]
    actual = set()
    for path in target.rglob("*"):
        attributes = path.lstat()
        if (attributes.st_uid != 0 or attributes.st_gid != 0
                or (not path.is_symlink() and attributes.st_mode & 0o222)):
            raise Failure("MAINTENANCE_RUNTIME_NOT_IMMUTABLE")
        if stat.S_ISREG(attributes.st_mode) and path != checksums:
            actual.add(path.relative_to(target).as_posix())
    if (set(checked) != actual
            or not {"release.json", "backend/dist/server.js", "frontend/dist/index.html"}.issubset(actual)):
        raise Failure("MAINTENANCE_RUNTIME_CHECKSUM")
    command(["sha256sum", "--check", "--strict", "--status", str(checksums)],
            "MAINTENANCE_RUNTIME_CHECKSUM", cwd=target, timeout=120)
    return hashlib.sha256(contents).hexdigest()


def link_identity(path):
    info = path.lstat()
    return info.st_dev, info.st_ino, info.st_ctime_ns


def maintenance_runtime(archive):
    before = stopped_service()
    current = RELEASE_ROOT / "current"
    target = RELEASE_ROOT / "releases" / archive.release_sha
    link = link_identity(current)
    if (not current.is_symlink() or os.readlink(current) != f"releases/{archive.release_sha}"
            or target.resolve(strict=True) != target or not target.is_dir()):
        raise Failure("OPERATIONS_RELEASE_MISMATCH")
    digest = sealed_runtime(target, archive.release_sha)
    group = "/system.slice/" + API_UNIT
    if before["ControlGroup"] not in ("", group) or not (CGROUP_ROOT / "cgroup.controllers").is_file():
        raise Failure("MAINTENANCE_SERVICE_CGROUP")
    directory = CGROUP_ROOT / group.lstrip("/")
    try:
        events = (directory / "cgroup.events").read_text().splitlines()
    except FileNotFoundError:
        if directory.exists():
            raise Failure("MAINTENANCE_SERVICE_CGROUP") from None
    else:
        if [line for line in events if line.startswith("populated ")] != ["populated 0"]:
            raise Failure("MAINTENANCE_SERVICE_CGROUP")
    if command(["ss", "-H", "-ltn", f"sport = :{API_PORT}"], "MAINTENANCE_API_LISTENER").strip():
        raise Failure("MAINTENANCE_API_LISTENER")
    if stopped_service() != before or link_identity(current) != link:
        raise Failure("MAINTENANCE_STATE_CHANGED")
    # Include lifecycle timestamps and the link inode so a restart or a switch
    # away and back is detectable even if the next sample is again inactive.
    return before, link, digest


def windows_release_evidence(archive):
    driver = {}
    for name in ("backup.py", "common.py", "windows_backup.py"):
        with (HERE / name).open("rb") as source:
            driver[name] = hashlib.file_digest(source, "sha256").hexdigest()
    return {"operationsArchiveSha256": archive.archive_sha256,
            "operationsReleaseSha": archive.release_sha, "driverFileSha256": driver}


def table_counts(mysql):
    statements = [f"SELECT JSON_ARRAY('{table}',(SELECT COUNT(*) FROM `{table}`))" for table in sorted(TABLES)]
    return dict(rows(mysql, " UNION ALL ".join(statements)))


def backup(repo, settings, state, fixture, *, archive=None, pre_migration=False):
    status_path = state / ("windows-backup.json" if archive is not None else "backup.json")
    old = read_json(status_path, {})
    started = time.monotonic()
    started_at = utc()
    run = uuid4().hex
    runtime_check = maintenance_runtime if pre_migration else matching_runtime
    try:
        root = fixture / "images" if fixture else IMAGE_ROOT
        # Confirm local headroom before starting remote operations. No SQL is staged.
        if min(shutil.disk_usage(path).free for path in (state, root.parent)) < settings.get("minFreeBytes", 268435456):
            raise Failure("LOCAL_SPACE_LOW")
        paths = image_directories(root)
        if archive is not None:
            runtime = runtime_check(archive)
            sha = archive.release_sha
            expected = migration_checksums(archive.migrations)
            evidence = windows_release_evidence(archive)
        else:
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
        if archive is not None:
            counts = table_counts(mysql)
            repo.initialize_windows()
            if pre_migration and runtime_check(archive) != runtime:
                raise Failure("MAINTENANCE_STATE_CHANGED")
        database_started_at = utc()
        database = repo.snapshot(run, "database", "--stdin-from-command", "--stdin-filename", "database.sql",
                                 "--", *client, "mysqldump", *options, *DUMP)
        if pre_migration and runtime_check(archive) != runtime:
            raise Failure("MAINTENANCE_STATE_CHANGED")
        images = repo.snapshot(run, "images", "--one-file-system", "--", *map(str, paths))
        if inventory(mysql, expected) != before:
            raise Failure("DATABASE_OR_RELEASE_CHANGED")
        if archive is not None:
            if (not pre_migration and runtime_check(archive) != runtime) or table_counts(mysql) != counts:
                raise Failure("DATABASE_OR_RELEASE_CHANGED")
        elif (release_sha(fixture) != sha or read_json(operations / "release.json", {}) != operations_manifest
              or release_migrations(operations / "backend/prisma/migrations") != expected):
            raise Failure("DATABASE_OR_RELEASE_CHANGED")
        completed = utc()
        manifest = {
            "format": 1, "run": run, "startedAt": started_at, "databaseSnapshotStartedAt": database_started_at,
            "completedAt": completed, "releaseSha": sha, "inventory": before,
            "databaseSnapshot": database, "imagesSnapshot": images, "imagePaths": list(map(str, paths)),
        }
        if archive is not None:
            manifest["windowsBackup"] = {**evidence, "tableCounts": counts,
                                         "mode": "pre-migration" if pre_migration else "running",
                                         "hostKeyFingerprint": repo.tunnel.fingerprint}
        # A private, small metadata file only. The SQL stream never lands here.
        with tempfile.TemporaryDirectory(dir=state) as staging:
            file = Path(staging) / "manifest.json"
            write_json(file, manifest)
            if pre_migration and runtime_check(archive) != runtime:
                raise Failure("MAINTENANCE_STATE_CHANGED")
            marker = repo.snapshot(run, "manifest", "--stdin-from-command", "--stdin-filename",
                                   "manifest.json", "--", "cat", str(file), staged=pre_migration)
            if pre_migration:
                # An uploaded manifest stays outside the application tag until
                # its upload is known to have spanned the same stopped runtime.
                if runtime_check(archive) != runtime:
                    raise Failure("MAINTENANCE_STATE_CHANGED")
                marker = repo.publish_manifest(marker)
        write_json(status_path, {"lastSuccessAt": completed, "lastAttemptAt": completed,
                                 "run": run, "manifest": marker, "result": "success"})
        log("backup_completed", run=run, tables=len(before["tables"]), migrations=len(before["migrations"]),
            triggers=before["triggerCount"], durationSeconds=round(time.monotonic() - started, 3),
            **(evidence if archive is not None else {}))
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
    if set(parts) != {"database", "images", "manifest"} or TAG not in parts["manifest"].get("tags", []):
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


def restore(repo, run, project, output, migrations_directory=None, *, archive=None):
    if not RUN.fullmatch(run) or not RESTORE_PROJECT.fullmatch(project):
        raise Failure("RESTORE_TARGET_ARGUMENT")
    if (not output.is_absolute() or output.parent.resolve(strict=True) != output.parent
            or not output.name.startswith(project) or output.exists() or output.is_symlink()):
        raise Failure("RESTORE_OUTPUT_MUST_BE_NEW")
    if repo.local_repository is not None:
        if any(parent.samefile(repo.local_repository) for parent in output.parents):
            raise Failure("RESTORE_OUTPUT_INSIDE_REPOSITORY")
        parent = output.parent.stat()
        if parent.st_uid != 0 or parent.st_gid != 0 or stat.S_IMODE(parent.st_mode) != 0o700:
            raise Failure("RESTORE_OUTPUT_PARENT_NOT_PRIVATE")
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
    if archive is None:
        expected = release_migrations(migrations_directory)
    else:
        details = meta.get("windowsBackup", {})
        counts = details.get("tableCounts", {})
        if ((meta.get("releaseSha"), details.get("operationsReleaseSha"), details.get("operationsArchiveSha256"))
                != (archive.release_sha, archive.release_sha, archive.archive_sha256)
                or set(counts) != TABLES or any(type(value) is not int or value < 0 for value in counts.values())):
            raise Failure("WINDOWS_RESTORE_MANIFEST")
        expected = migration_checksums(archive.migrations)
    verify_migrations(recorded["migrations"], expected)
    if set(recorded["tables"]) != TABLES:
        raise Failure("DATABASE_SCHEMA_INCOMPLETE")
    definers = {row[0] for row in rows(mysql, "SELECT JSON_ARRAY(CONCAT(User,'@',Host)) FROM mysql.user")}
    if not set(recorded["triggerDefiners"]).issubset(definers):
        raise Failure("RESTORE_DEFINERS_MISSING")
    if "triggerDefinerTables" in recorded:
        verify_definer_privileges(mysql, recorded["triggerDefinerTables"])
    if archive is not None:
        repo.call("check", "--read-data", error="WINDOWS_REPOSITORY_VERIFY")
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
    if archive is not None and table_counts(mysql) != counts:
        raise Failure("RESTORE_TABLE_COUNTS")
    check_image_references(mysql, paths, "RESTORE_IMAGE_REFERENCE")
    log("restore_completed", run=run, tables=len(meta["inventory"]["tables"]),
        migrations=len(meta["inventory"]["migrations"]), triggers=meta["inventory"]["triggerCount"],
        durationSeconds=round(time.monotonic() - started, 3))


def run_tool():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=CONFIG)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--fixture", type=Path, help="Disposable synthetic integration fixture only")
    mode.add_argument("--windows-tunnel-profile", type=Path,
                      help="One-off backup only. Root:root 0600 JSON with port, repository and independently pinned hostKey;"
                           " repository is a new membership-<32 hex> directory, and the sibling windows-tunnel-key"
                           " file is the dedicated client identity.")
    mode.add_argument("--windows-local-repository", type=Path,
                      help="Isolated restore only (Linux/WSL). Absolute path of the saved Windows encrypted repository.")
    parser.add_argument("--operations-archive", type=Path,
                        help="Original operations .tar.gz for the runtime being backed up or restored")
    parser.add_argument("--operations-sha256", help="Independently verified SHA-256 of the original operations archive")
    parser.add_argument("--pre-migration", action="store_true",
                        help="Require a cleanly stopped API and workers for a one-off Windows backup")
    parser.add_argument("operation", choices=("init", "backup", "check", "check-data", "plan-retention",
                                                "apply-retention", "plan-prune", "prune", "inspect", "restore"))
    parser.add_argument("--run", default="")
    parser.add_argument("--project", default="")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    windows = args.windows_tunnel_profile or args.windows_local_repository
    if args.pre_migration and not args.windows_tunnel_profile:
        raise Failure("MAINTENANCE_WINDOWS_BACKUP_REQUIRED")
    if ((args.windows_tunnel_profile and args.operation != "backup")
            or (args.windows_local_repository and args.operation != "restore")):
        raise Failure("WINDOWS_OPERATION_FORBIDDEN")
    if bool(windows) != bool(args.operations_archive and args.operations_sha256) or (
            not windows and (args.operations_archive or args.operations_sha256)):
        raise Failure("OPERATIONS_ARCHIVE_ARGUMENT")
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
    settings = {} if args.windows_local_repository else configuration(args.config)
    archive = verified_operations(args.operations_archive, args.operations_sha256) if windows else None
    tunnel = WindowsTunnel.from_profile(args.windows_tunnel_profile) if args.windows_tunnel_profile else None
    with lock(state, "repository"), (tempfile.TemporaryDirectory(dir=state) if tunnel else nullcontext()) as staging:
        repo = Repository(fixture, tunnel=tunnel, staging=Path(staging) if staging else None,
                          local_repository=args.windows_local_repository)
        match args.operation:
            case "init":
                repo.call("init", error="REPOSITORY_INIT_FAILED")
                log("repository_initialized")
            case "backup":
                backup(repo, settings, state, fixture, archive=archive, pre_migration=args.pre_migration)
            case "restore":
                if args.output is None:
                    raise Failure("RESTORE_OUTPUT_REQUIRED")
                restore(repo, args.run, args.project, args.output,
                        operations_root(fixture) / "backend/prisma/migrations", archive=archive)
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
