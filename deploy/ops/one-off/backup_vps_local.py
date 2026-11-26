"""T27.5 one-off VPS-local backup. Read-only unless --execute is selected."""
import argparse
from contextlib import contextmanager
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import socket
import stat
import sys
from types import SimpleNamespace

DRIVER_FILES = (
    "ops/backup.py", "ops/common.py", "ops/windows_backup.py",
    "mysql/compose.yaml", "mysql/backup.compose.yaml",
)
CONFIG_FIELDS = {
    "expected_hostname", "maintenance_hostname", "release_sha", "operations_archive", "operations_sha256",
    "driver_directory", "driver_sha256", "restic_binary", "restic_sha256",
    "backup_root", "mysql_container_id", "backup_subnet",
}
CNF = Path("/etc/ai-membership-store/backup.mysql.cnf")
PROJECT = "ai-membership-store-production"
CONTAINER = PROJECT + "-mysql-1"
NETWORK = PROJECT + "_backup"
SCHEMA = "membership_production"
SQL_OPTIONS = ["--batch", "--raw", "--skip-column-names"]
GIB = 1024**3
CLIENT_FILE = "--defaults-extra-file=/run/secrets/backup.mysql.cnf"


def require(condition, code):
    if not condition:
        raise Rejected(code)


class Rejected(Exception):
    pass


def interrupted(signum, _frame):
    raise Rejected("BACKUP_INTERRUPTED_BY_" + signal.Signals(signum).name)


def file_hash(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def root_owned(path, type_check):
    mode = path.lstat()
    return (path.resolve(strict=True) == path and type_check(mode.st_mode)
            and mode.st_uid == mode.st_gid == 0 and not mode.st_mode & 0o022)


def load_configuration(path):
    require(root_owned(path, stat.S_ISREG) and stat.S_IMODE(path.stat().st_mode) == 0o600,
            "CONFIG_PERMISSIONS")
    data = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(data, dict) and data.keys() == CONFIG_FIELDS, "CONFIG_FIELDS")
    require(isinstance(data["expected_hostname"], str) and data["expected_hostname"] == socket.gethostname(),
            "HOST_IDENTITY")
    require(re.fullmatch(r"(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+"
                         r"[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?", data["maintenance_hostname"]),
            "MAINTENANCE_HOSTNAME")
    for field, size in (("release_sha", 40), ("operations_sha256", 64), ("restic_sha256", 64),
                        ("mysql_container_id", 64)):
        require(re.fullmatch(rf"[0-9a-f]{{{size}}}", data[field]), "CONFIG_DIGEST_OR_ID")
    hashes = data["driver_sha256"]
    require(isinstance(hashes, dict) and hashes.keys() == set(DRIVER_FILES)
            and all(re.fullmatch(r"[0-9a-f]{64}", value) for value in hashes.values()),
            "CONFIG_DRIVER_DIGESTS")

    for field, type_check in (("operations_archive", stat.S_ISREG), ("driver_directory", stat.S_ISDIR),
                              ("restic_binary", stat.S_ISREG), ("backup_root", stat.S_ISDIR)):
        value = Path(data[field])
        require(value.is_absolute() and root_owned(value, type_check), "CONFIG_PATH_PERMISSIONS")
        data[field] = value
    require(re.fullmatch(r"/(?:[A-Za-z0-9._-]+/)*[A-Za-z0-9._-]+", str(data["backup_root"])),
            "BACKUP_ROOT_TRANSFER_PATH")
    driver = data["driver_directory"]
    for item, checksum in [(driver / name, hashes[name]) for name in DRIVER_FILES] + [
        (data["restic_binary"], data["restic_sha256"]),
    ]:
        require(root_owned(item, stat.S_ISREG) and file_hash(item) == checksum, "VERIFIED_FILE_CHANGED")

    subnet = ipaddress.IPv4Network(data["backup_subnet"])
    require(subnet.is_private and subnet.prefixlen < 31, "BACKUP_SUBNET")
    data["subnet"] = subnet
    data["account_host"] = subnet.with_netmask
    data["root_mysql"] = [
        "docker", "exec", data["mysql_container_id"], "sh", "-c",
        'MYSQL_PWD="$(cat /run/secrets/mysql_root_password)" exec mysql --user=root --protocol=socket "$@"',
        "mysql", *SQL_OPTIONS, SCHEMA,
    ]
    data["client"] = [
        "docker", "compose", "--env-file", "/dev/null", "-p", PROJECT,
        "-f", str(driver / "mysql/compose.yaml"), "-f", str(driver / "mysql/backup.compose.yaml"),
        "--profile", "backup", "run", "--rm", "-T", "--no-deps", "--pull", "never", "backup-client",
    ]
    return SimpleNamespace(**data)


def file_inventory(directory):
    result = {}
    for folder, dirs, files in os.walk(directory, followlinks=False):
        for name in sorted(dirs + files):
            path = Path(folder) / name
            entry = path.lstat()
            require(stat.S_ISDIR(entry.st_mode) or stat.S_ISREG(entry.st_mode), "UNEXPECTED_FILE_TYPE")
            if stat.S_ISREG(entry.st_mode):
                result[path.relative_to(directory).as_posix()] = {"sha256": file_hash(path), "bytes": entry.st_size}
    return dict(sorted(result.items()))


def require_backup_space(ops, config, image_inventory):
    table_bytes, = ops.rows(config.root_mysql, """
        SELECT JSON_ARRAY(CAST(COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) AS UNSIGNED))
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
    """)[0]
    require(type(table_bytes) is int and table_bytes > 0, "MYSQL_SIZE_UNAVAILABLE")
    image_bytes = sum(file["bytes"] for directory in image_inventory for file in directory.values())
    # Allow for the SQL representation (including hex BLOBs) and pack overhead without assuming compression.
    estimate = 4 * table_bytes + image_bytes
    available = shutil.disk_usage(config.backup_root).free
    require(available >= estimate + GIB, "INSUFFICIENT_DISK_HEADROOM")
    return available, estimate


def check_mysql(ops, config):
    info = ops.inspect(CONTAINER)
    state = info["State"]
    require(ops.inspect_target(PROJECT) == info["Id"] == config.mysql_container_id
            and state["Health"]["Status"] == "healthy"
            and info["HostConfig"]["PortBindings"] == {
                "3306/tcp": [{"HostIp": "127.0.0.1", "HostPort": "3310"}]
            }
            and any(mount.get("Name") == PROJECT + "_mysql-data"
                    and mount["Destination"] == "/var/lib/mysql" for mount in info["Mounts"]),
            "PRODUCTION_MYSQL_IDENTITY")
    endpoints = info["NetworkSettings"]["Networks"]
    network = json.loads(ops.docker("network", "inspect", endpoints[NETWORK]["NetworkID"]))[0]
    require(network["Name"] == NETWORK and network["Driver"] == "bridge" and network["Internal"]
            and network["Labels"].get("com.docker.compose.project") == PROJECT
            and set(network["Containers"]) == {config.mysql_container_id}
            and {item["Subnet"] for item in network["IPAM"]["Config"]} == {str(config.subnet)},
            "BACKUP_NETWORK_IDENTITY")
    return state["StartedAt"], network["Id"]


def account_count(ops, config, user, *, legacy=False):
    names = f"'{user}','membership_backup'" if legacy else f"'{user}'"
    return ops.rows(config.root_mysql, f"SELECT JSON_ARRAY(COUNT(*)) FROM mysql.user WHERE User IN ({names})")[0][0]


def capture(ops, config, archive, expected, paths):
    runtime = ops.maintenance_runtime(archive)
    mysql = check_mysql(ops, config)
    memory = re.search(r"^MemAvailable:\s+(\d+) kB$", Path("/proc/meminfo").read_text(), re.MULTILINE)
    require(memory is not None and int(memory[1]) >= 400 * 1024, "HOST_MEMORY_HEADROOM")
    state = ops.rows(config.root_mysql, """
        SELECT JSON_ARRAY(
          @@partial_revokes, @@log_bin_trust_function_creators,
          (SELECT COUNT(*) FROM information_schema.innodb_trx WHERE trx_mysql_thread_id <> CONNECTION_ID()),
          (SELECT COUNT(*) FROM performance_schema.processlist WHERE ID <> CONNECTION_ID()
             AND USER NOT IN ('event_scheduler','system user')))
    """)
    require(state == [[0, 0, 0, 0]], "MYSQL_SETTINGS_OR_OTHER_SESSIONS")
    require(ops.command(["curl", "--silent", "--show-error", "--output", "/dev/null",
                          "--write-out", "%{http_code}", "--max-time", "12",
                          "--resolve", f"{config.maintenance_hostname}:443:127.0.0.1",
                          f"https://{config.maintenance_hostname}/api/v1/health"], "MAINTENANCE_HTTPS") == b"503",
            "MAINTENANCE_HTTPS")
    inventory = ops.inventory(config.root_mysql, expected)
    ops.check_image_references(config.root_mysql, paths, "IMAGE_REFERENCE_MISSING")
    counts = ops.table_counts(config.root_mysql)
    images = [file_inventory(path) for path in paths]
    require(ops.maintenance_runtime(archive) == runtime, "MAINTENANCE_STATE_CHANGED")
    return (runtime, mysql, inventory, counts, images)


def private_write(path, content):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(content)


@contextmanager
def backup_account(ops, config, user, expected, paths, baseline):
    quoted = chr(96)
    database_grant = quoted + SCHEMA.replace("_", r"\_") + quoted
    subject = f"'{user}'@'{config.account_host}'"
    created = False
    file_identity = None
    require(account_count(ops, config, user, legacy=True) == 0 and not os.path.lexists(CNF),
            "BACKUP_ACCOUNT_OR_FILE_EXISTS")
    try:
        # Capture the server-generated password in memory. SQL and child stderr stay out of logs.
        response = ops.command([*config.root_mysql, "-e",
                                f"CREATE USER {subject} IDENTIFIED BY RANDOM PASSWORD REQUIRE SSL"],
                               "CREATE_BACKUP_ACCOUNT")
        created = True
        result = response.decode().strip().split("\t")
        del response
        require(len(result) == 4 and result[:2] == [user, config.account_host]
                and re.fullmatch(r"[\x21-\x7e]{16,128}", result[2]), "GENERATED_PASSWORD_OUTPUT")
        escaped = result[2].replace("\\", "\\\\").replace('"', '\\"')
        descriptor = os.open(CNF, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "w") as stream:
            mode = os.fstat(stream.fileno())
            file_identity = (mode.st_dev, mode.st_ino)
            stream.write(f'[client]\nhost=mysql\nuser={user}\npassword="{escaped}"\nssl-mode=REQUIRED\n')
        require(ops.private_file(CNF), "BACKUP_CNF_PERMISSIONS")
        del result, escaped
        grants = {f"GRANT USAGE ON *.* TO {subject}",
                  f"GRANT SELECT ON {database_grant}.* TO {subject}"}
        grants.update(f"GRANT TRIGGER ON {quoted}{SCHEMA}{quoted}.{quoted}{table}{quoted} TO {subject}"
                      for table in ("Order", "OrderRevision"))
        for grant in sorted(grants):
            if " USAGE " not in grant:
                ops.command([*config.root_mysql, "-e", grant], "GRANT_BACKUP_SCOPE")
        actual = ops.command([*config.root_mysql, "-e", f"SHOW GRANTS FOR {subject}"], "SHOW_BACKUP_GRANTS")
        expected_grants = {grant.replace(subject, subject.replace("'", quoted)) for grant in grants}
        require(set(actual.decode().splitlines()) == expected_grants
                and ops.rows(config.root_mysql, "SELECT JSON_ARRAY(ssl_type = 'ANY') "
                             f"FROM mysql.user WHERE User='{user}' AND Host='{config.account_host}'") == [[1]],
                "BACKUP_ACCOUNT_NOT_LEAST_PRIVILEGE")
        mysql = [*config.client, "mysql", CLIENT_FILE, *SQL_OPTIONS, SCHEMA]
        identity = ops.command([*mysql, "-e", "SELECT JSON_ARRAY(USER(),CURRENT_USER());"
                                "SHOW SESSION STATUS LIKE 'Ssl_cipher'"], "BACKUP_CLIENT_TLS")
        who, status = identity.decode().splitlines()
        origin, principal = json.loads(who)
        variable, cipher = status.split("\t")
        name, address = origin.split("@")
        require(name == user and ipaddress.IPv4Address(address) in config.subnet
                and principal == f"{user}@{config.account_host}" and variable == "Ssl_cipher" and bool(cipher),
                "BACKUP_CLIENT_IDENTITY_OR_TLS")
        require(ops.inventory(mysql, expected) == baseline[2] and ops.table_counts(mysql) == baseline[3],
                "BACKUP_CLIENT_VISIBILITY")
        ops.check_image_references(mysql, paths, "IMAGE_REFERENCE_MISSING")
        yield
    finally:
        try:
            if created:
                ops.command([*config.root_mysql, "-e", f"DROP USER IF EXISTS {subject}"], "DROP_BACKUP_ACCOUNT")
                require(account_count(ops, config, user) == 0, "BACKUP_ACCOUNT_REMAINS")
        finally:
            if file_identity is not None:
                mode = CNF.lstat()
                require((mode.st_dev, mode.st_ino) == file_identity, "BACKUP_CNF_CHANGED")
                CNF.unlink()
                require(not os.path.lexists(CNF), "BACKUP_CNF_REMAINS")


def perform(ops, config, archive, expected, paths, baseline, run, destination, user):
    class LocalRepository:
        # Only the mechanics of snapshots are shared. Off-host transport validation is untouched.
        snapshot = ops.Repository.snapshot
        snapshots = ops.Repository.snapshots
        publish_manifest = ops.Repository.publish_manifest

        def call(self, *args, error="LOCAL_RESTIC", timeout=3600):
            return ops.command([
                "nice", "-n", "10", str(config.restic_binary), "--no-cache",
                "--repo", str(repository), "--password-file", str(password), *args,
            ], error, timeout=timeout, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"})

    def fence():
        require(capture(ops, config, archive, expected, paths) == baseline, "SOURCE_CHANGED_DURING_BACKUP")

    with ops.lock(ops.STATE, "repository"):
        fence()
        require_backup_space(ops, config, baseline[4])
        staging = destination.with_suffix(".partial")
        staging.mkdir(mode=0o700)
        require(root_owned(staging, stat.S_ISDIR), "VPS_DESTINATION_PERMISSIONS")
        repository = staging / f"membership-{run}"
        repository.mkdir(mode=0o700)
        password = staging / "restic-password"
        private_write(password, (secrets.token_urlsafe(48) + "\n").encode())
        repo = LocalRepository()
        repo.call("init")
        started = ops.utc()
        with backup_account(ops, config, user, expected, paths, baseline):
            fence()
            database_started = ops.utc()
            database = repo.snapshot(run, "database", "--stdin-from-command", "--stdin-filename", "database.sql",
                                     "--", *config.client, "mysqldump", CLIENT_FILE, *ops.DUMP)
        fence()
        images = repo.snapshot(run, "images", "--one-file-system", "--", *map(str, paths))
        fence()
        manifest = {
            "format": 1, "run": run, "startedAt": started, "databaseSnapshotStartedAt": database_started,
            "completedAt": ops.utc(), "releaseSha": config.release_sha, "inventory": baseline[2],
            "databaseSnapshot": database, "imagesSnapshot": images, "imagePaths": list(map(str, paths)),
            "localBackup": {**ops.windows_release_evidence(archive), "tableCounts": baseline[3],
                            "imageSha256": [{name: file["sha256"] for name, file in directory.items()}
                                            for directory in baseline[4]],
                            "transport": "vps-local-ssh-pull"},
        }
        payload = staging / "manifest-staging.json"
        ops.write_json(payload, manifest)
        try:
            staged = repo.snapshot(run, "manifest", "--stdin-from-command", "--stdin-filename",
                                   "manifest.json", "--", "cat", str(payload), staged=True)
        finally:
            payload.unlink()
        fence()
        marker = repo.publish_manifest(staged)
        try:
            fence()
            repo.call("check", "--read-data", error="RESTIC_FULL_DATA_CHECK")
            require(ops.load_manifest(repo, run, ops.groups(repo)[run]) == manifest,
                    "MANIFEST_REOPEN_MISMATCH")
            files = file_inventory(repository)
            require(files and "config" in files and not any(path.startswith("locks/") for path in files),
                    "REPOSITORY_NOT_READY_TO_TRANSFER")
            repository_bytes = sum(file["bytes"] for file in files.values())
            require(shutil.disk_usage(config.backup_root).free >= GIB, "INSUFFICIENT_DISK_HEADROOM")
            fence()
            ops.write_json(staging / "transfer.json", {
                "format": 2, "run": run, "releaseSha": config.release_sha, "repository": repository.name,
                "repositoryBytes": repository_bytes,
                "files": files, "snapshotIds": {"database": database, "images": images, "manifest": marker},
                "tableCount": len(baseline[2]["tables"]), "migrationCount": len(baseline[2]["migrations"]),
                "triggerCount": baseline[2]["triggerCount"], "operationsArchiveSha256": config.operations_sha256,
            })
            fence()
            require(not os.path.lexists(destination), "DESTINATION_ALREADY_EXISTS")
            staging.rename(destination)
        except Exception:
            # This directory is uniquely owned by this run. Withdraw only its newly published marker.
            repo.call("forget", marker, error="WITHDRAW_NEW_MANIFEST")
            raise
        print(json.dumps({"mode": "execute", "destination": str(destination), "run": run,
                          "snapshots": [database, images, marker], "repositoryFiles": len(files)}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--dry-run", action="store_true")
    modes.add_argument("--execute", action="store_true")
    parser.add_argument("--run", required=True)
    parser.add_argument("--config", type=Path, required=True)
    options = parser.parse_args()
    require(os.getuid() == os.getgid() == 0 and re.fullmatch(r"[0-9a-f]{32}", options.run),
            "ROOT_OR_RUN_ID")
    config = load_configuration(options.config)
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(config.driver_directory / "ops"))
    import backup as ops
    from windows_backup import verified_operations

    restic_version = ops.command([str(config.restic_binary), "version"], "RESTIC_VERSION")
    require(restic_version.startswith(b"restic 0.20.0 ") and b"linux/amd64" in restic_version, "RESTIC_VERSION")
    archive = verified_operations(config.operations_archive, config.operations_sha256)
    require(archive.release_sha == config.release_sha and len(archive.migrations) == 14,
            "ARCHIVE_RELEASE_OR_CHAIN")
    os.umask(0o077)
    destination = config.backup_root / f"membership-local-{options.run}"
    user = f"membership_backup_{options.run[:12]}"
    require(not os.path.lexists(destination)
            and not os.path.lexists(destination.with_suffix(".partial"))
            and not os.path.lexists(CNF) and account_count(ops, config, user, legacy=True) == 0,
            "DESTINATION_OR_ACCOUNT_NOT_FRESH")
    expected = ops.migration_checksums(archive.migrations)
    paths = ops.image_directories(ops.IMAGE_ROOT)
    require(not any(destination.is_relative_to(path) for path in [ops.RELEASE_ROOT, *paths, Path("/var/lib/docker")]),
            "BACKUP_ROOT_OVERLAPS_SOURCE")
    baseline = capture(ops, config, archive, expected, paths)
    available, estimate = require_backup_space(ops, config, baseline[4])
    if options.execute:
        for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            signal.signal(signum, interrupted)
        perform(ops, config, archive, expected, paths, baseline, options.run, destination, user)
        return
    require(not os.path.lexists(destination) and not os.path.lexists(destination.with_suffix(".partial"))
            and not os.path.lexists(CNF)
            and account_count(ops, config, user, legacy=True) == 0, "DRY_RUN_STATE_CHANGED")
    print(json.dumps({"mode": "dry-run", "releaseSha": config.release_sha, "operationsArchiveSha256": config.operations_sha256,
                      "destinationAbsent": True, "accountAndClientFileAbsent": True,
                      "freeBytes": available, "estimatedRepositoryBytes": estimate, "source": baseline[2], "imageFileCounts": list(map(len, baseline[4])),
                      "state": "api-inactive-https-503-mysql-healthy-no-other-sessions"}, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # Known guard failures contain fixed codes. Unexpected errors print only the type.
        code = str(exc) if type(exc).__name__ in ("Failure", "Rejected") else "UNEXPECTED_" + type(exc).__name__
        print("T27.5 stopped: " + code, file=sys.stderr)
        sys.exit(1)
