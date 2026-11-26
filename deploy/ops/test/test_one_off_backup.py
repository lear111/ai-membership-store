"""Exercise the one-off snapshot and cleanup path in an isolated temporary repository."""
import ipaddress
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid
from types import SimpleNamespace
import unittest
from unittest.mock import patch

OPS = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(OPS), str(OPS / "one-off")]
import backup as existing
import backup_vps_local as oneoff
import common
from common import Failure

RESTIC = os.environ.get("T275_TEST_RESTIC")
SQL = "CREATE TABLE fixture (value int); INSERT INTO fixture VALUES (17);\n"
USER = "membership_backup_012345678abc"
RUN = "012345678abc" + "0" * 20


class Fixture:
    def __init__(self, root):
        self.root = root
        self.config = SimpleNamespace(
            backup_root=root, restic_binary=Path(RESTIC or "/unused/restic"), root_mysql=["fixture-socket"],
            client=[sys.executable, "-c", "import sys; sys.stdout.write(" + repr(SQL) + ")"],
            subnet=ipaddress.IPv4Network("192.0.2.0/24"), account_host="192.0.2.0/255.255.255.0",
            release_sha="a" * 40, operations_sha256="b" * 64,
        )
        self.paths = [root / name for name in existing.IMAGE_DIRS]
        for folder in self.paths:
            folder.mkdir()
            (folder / "fixture.png").write_bytes(folder.name.encode())
        self.inventory_value = {"database": oneoff.SCHEMA, "tables": sorted(existing.TABLES),
                                "triggerCount": 10, "migrations": [["synthetic", "a" * 64]] * 14}
        self.baseline = (None, None, self.inventory_value, {"fixture": 1},
                         [oneoff.file_inventory(folder) for folder in self.paths])
        self.STATE = root / "state"
        self.STATE.mkdir(mode=0o700)
        self.destination = root / f"membership-local-{RUN}"
        self.staging = self.destination.with_suffix(".partial")
        self.cnf = root / "fixture.mysql.cnf"
        self.active = False
        self.collision = False
        self.grants = []
        self.calls = []
        self.archive = SimpleNamespace(archive_sha256=self.config.operations_sha256,
                                       release_sha=self.config.release_sha)

    def __getattr__(self, name):
        return getattr(existing, name)

    def inventory(self, *_):
        return self.inventory_value

    def table_counts(self, *_):
        return self.baseline[3]

    def check_image_references(self, *_):
        pass

    def rows(self, _, sql):
        if "SUM(DATA_LENGTH + INDEX_LENGTH)" in sql:
            return [[16384]]
        if "ssl_type" in sql:
            return [[1]]
        self.assert_user_query(sql)
        return [[int(self.active)]]

    def assert_user_query(self, sql):
        if "FROM mysql.user" not in sql:
            raise AssertionError("Unexpected fixture SQL")

    def command(self, args, error, **kwargs):
        self.calls.append(error)
        if error == "CREATE_BACKUP_ACCOUNT":
            self.active = True
            if self.collision:
                raise Failure(error)
            return f"{USER}\t{self.config.account_host}\t{'x' * 24}\t1\n".encode()
        if error == "DROP_BACKUP_ACCOUNT":
            self.active = False
            return b""
        if error == "GRANT_BACKUP_SCOPE":
            self.grants.append(args[-1].replace("'", chr(96)))
            return b""
        if error == "SHOW_BACKUP_GRANTS":
            usage = f"GRANT USAGE ON *.* TO {chr(96)}{USER}{chr(96)}@{chr(96)}{self.config.account_host}{chr(96)}"
            return "\n".join([usage, *self.grants]).encode()
        if error == "BACKUP_CLIENT_TLS":
            return (json.dumps([f"{USER}@192.0.2.7", f"{USER}@{self.config.account_host}"])
                    + "\nSsl_cipher\tTLS_AES_256_GCM_SHA384\n").encode()
        return existing.command(args, error, **kwargs)

    def perform(self, capture=None):
        with (patch.object(oneoff, "capture", side_effect=capture, return_value=self.baseline),
              patch.object(oneoff, "CNF", self.cnf),
              patch.object(oneoff, "root_owned", side_effect=lambda p, t: p.parent == self.root and t(p.stat().st_mode)),
              patch.object(common, "ensure_private_dir")):
            oneoff.perform(self, self.config, self.archive, {}, self.paths, self.baseline,
                           RUN, self.destination, USER)

    def restic(self, base, *args):
        return subprocess.check_output([
            RESTIC, "--no-cache", "--repo", str(base / f"membership-{RUN}"),
            "--password-file", str(base / "restic-password"), *args,
        ])


class BackupTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.fixture = Fixture(Path(folder.name))

    def test_create_collision_preserves_unowned_account(self):
        fixture = self.fixture
        fixture.collision = True
        with (patch.object(oneoff, "CNF", fixture.cnf), self.assertRaisesRegex(Failure, "CREATE_BACKUP_ACCOUNT")):
            with oneoff.backup_account(fixture, fixture.config, USER, {}, fixture.paths, fixture.baseline):
                self.fail("Unexpected backup")
        self.assertTrue(fixture.active)
        self.assertNotIn("DROP_BACKUP_ACCOUNT", fixture.calls)
        self.assertFalse(fixture.cnf.exists())

    def test_confirmed_create_is_revoked_on_signal(self):
        fixture = self.fixture
        with (patch.object(oneoff, "CNF", fixture.cnf), patch.object(existing, "private_file", return_value=True),
              self.assertRaisesRegex(oneoff.Rejected, "BACKUP_INTERRUPTED_BY_SIGTERM")):
            with oneoff.backup_account(fixture, fixture.config, USER, {}, fixture.paths, fixture.baseline):
                oneoff.interrupted(signal.SIGTERM, None)
        self.assertFalse(fixture.active)
        self.assertIn("DROP_BACKUP_ACCOUNT", fixture.calls)
        self.assertFalse(fixture.cnf.exists())

    def test_vps_budget(self):
        fixture = self.fixture
        estimate = 4 * 16384 + sum((p / "fixture.png").stat().st_size for p in fixture.paths)
        with patch.object(oneoff.shutil, "disk_usage", return_value=SimpleNamespace(free=oneoff.GIB + estimate - 1)):
            with self.assertRaisesRegex(oneoff.Rejected, "INSUFFICIENT_DISK_HEADROOM"):
                fixture.perform()
        self.assertFalse(fixture.staging.exists())
        self.assertNotIn("CREATE_BACKUP_ACCOUNT", fixture.calls)

    @unittest.skipUnless(RESTIC, "Set T275_TEST_RESTIC to a verified Restic 0.20.0 binary")
    def test_real_restic_backup_and_readback(self):
        self.assertIn(b"restic 0.20.0 ", subprocess.check_output([RESTIC, "version"]))
        fixture = self.fixture
        with patch.object(existing, "private_file", return_value=True):
            fixture.perform()
        receipt_path = fixture.destination / "transfer.json"
        receipt = json.loads(receipt_path.read_bytes())
        self.assertEqual(receipt["format"], 2)
        files = oneoff.file_inventory(fixture.destination / receipt["repository"])
        self.assertEqual(files, receipt["files"])
        self.assertEqual(receipt["repositoryBytes"], sum(file["bytes"] for file in files.values()))
        database, images, marker = (receipt["snapshotIds"][part] for part in ("database", "images", "manifest"))
        self.assertEqual(fixture.restic(fixture.destination, "dump", database, "/database.sql"), SQL.encode())
        for folder in fixture.paths:
            self.assertEqual(fixture.restic(fixture.destination, "dump", images, str(folder / "fixture.png")),
                             folder.name.encode())
        manifest = json.loads(fixture.restic(fixture.destination, "dump", marker, "/manifest.json"))
        self.assertEqual(manifest["databaseSnapshot"], database)
        self.assertEqual(manifest["imagesSnapshot"], images)
        self.assertIn("no errors", fixture.restic(fixture.destination, "check", "--read-data").decode())
        self.assertFalse(fixture.active)
        self.assertFalse(fixture.cnf.exists())
        self.assertEqual(list(fixture.root.rglob("*.sql")), [])
        portable = os.environ.get("T275_PORTABLE_FIXTURE")
        if portable:
            destination = Path(portable)
            shutil.copytree(fixture.destination, destination / "synthetic-run")
            passphrase = destination / "synthetic-key-passphrase"
            oneoff.private_write(passphrase, secrets.token_hex(24).encode())
            certificate = destination / "synthetic-public.pem"
            existing.command([
                "openssl", "req", "-x509", "-newkey", "rsa:3072", "-subj", "/CN=Synthetic T27.5 escrow/",
                "-days", "1", "-keyout", str(destination / "synthetic-private.pem"),
                "-out", str(certificate), "-passout", f"file:{passphrase}",
            ], "FIXTURE_ESCROW_KEY")
            existing.command(["openssl", "x509", "-in", str(certificate), "-outform", "DER",
                              "-out", str(destination / "synthetic-public.cer")], "FIXTURE_ESCROW_DER")

    @unittest.skipUnless(RESTIC, "Set T275_TEST_RESTIC to a verified Restic 0.20.0 binary")
    def test_real_restic_interrupted_dump_is_not_published(self):
        fixture = self.fixture
        fixture.config.client = [sys.executable, "-c",
                                 "import os,signal,sys; print('incomplete', flush=True); os.kill(os.getpid(),signal.SIGTERM)"]
        with patch.object(existing, "private_file", return_value=True):
            with self.assertRaises(Failure):
                fixture.perform()
        self.assertFalse(fixture.destination.exists())
        self.assertFalse((fixture.staging / "transfer.json").exists())
        self.assertEqual(json.loads(fixture.restic(fixture.staging, "--json", "snapshots")) or [], [])
        self.assertFalse(fixture.active)
        self.assertFalse(fixture.cnf.exists())

    @unittest.skipUnless(RESTIC, "Set T275_TEST_RESTIC to a verified Restic 0.20.0 binary")
    def test_state_change_after_real_manifest_tag_withdraws_marker(self):
        fixture = self.fixture

        def capture(*_):
            if "BACKUP_MANIFEST_PUBLISH" in fixture.calls:
                return None
            return fixture.baseline

        with patch.object(existing, "private_file", return_value=True):
            with self.assertRaisesRegex(oneoff.Rejected, "SOURCE_CHANGED_DURING_BACKUP"):
                fixture.perform(capture)
        self.assertFalse(fixture.destination.exists())
        self.assertFalse((fixture.staging / "transfer.json").exists())
        snapshots = json.loads(fixture.restic(fixture.staging, "--json", "snapshots"))
        self.assertEqual(len(snapshots), 2)
        self.assertFalse(any("manifest" in entry["tags"] for entry in snapshots))
        self.assertFalse(fixture.active)



@unittest.skipUnless(os.environ.get("T275_TEST_MYSQL"), "Set T275_TEST_MYSQL=1 for disposable local Docker MySQL")
class MysqlBackupTests(unittest.TestCase):
    def test_database_stream_and_account_lifecycle(self):
        self.assertTrue(RESTIC, "Set T275_TEST_RESTIC for the MySQL fixture")
        docker = shutil.which("docker")
        self.assertTrue(docker, "Local Docker CLI required")
        suffix = uuid.uuid4().hex[:12]
        network = f"membership-t275-fixture-{suffix}"
        instance = f"membership-t275-mysql-{suffix}"

        def control(*args):
            return subprocess.check_output([docker, *args], stderr=subprocess.PIPE, timeout=90)

        def cleanup(*args):
            subprocess.run([docker, *args], check=False, capture_output=True, timeout=30)

        control("network", "create", "--internal", network)
        self.addCleanup(cleanup, "network", "rm", network)
        control("run", "-d", "--rm", "--pull", "never", "--network", network, "--hostname", "mysql",
                "--tmpfs", "/var/lib/mysql:size=512m", "--name", instance,
                "-e", "MYSQL_ALLOW_EMPTY_PASSWORD=yes", "-e", f"MYSQL_DATABASE={oneoff.SCHEMA}",
                existing.IMAGE, "--skip-name-resolve", "--skip-log-bin")
        self.addCleanup(cleanup, "rm", "-f", instance)
        mysql = [docker, "exec", instance, "mysql", "--protocol=socket", "--user=root",
                 *oneoff.SQL_OPTIONS, oneoff.SCHEMA]
        for _ in range(90):
            try:
                version = existing.command([*mysql, "-e", "SELECT VERSION()"], "FIXTURE_START")
                break
            except Failure:
                time.sleep(1)
        else:
            self.fail("Disposable MySQL did not become ready")
        self.assertEqual(version.strip(), b"8.4.13")
        existing.command([*mysql, "-e",
                          "CREATE TABLE " + chr(96) + "Order" + chr(96) + " (value int);"
                          "CREATE TABLE OrderRevision (value int);"
                          "CREATE TRIGGER fixture_trigger BEFORE INSERT ON " + chr(96) + "Order" + chr(96)
                          + " FOR EACH ROW SET NEW.value = NEW.value + 1;"
                          "INSERT INTO " + chr(96) + "Order" + chr(96) + " VALUES (16);"], "FIXTURE_SCHEMA")

        class LiveMysql(Fixture):
            collision = False

            def rows(self, mysql_args, sql):
                return existing.rows(mysql_args, sql)

            def command(self, args, error, **kwargs):
                self.calls.append(error)
                if error == "BACKUP_CLIENT_TLS":
                    existing.command([docker, "exec", "-i", instance, "sh", "-c",
                                      "umask 077; mkdir -p /run/secrets; cat >/run/secrets/backup.mysql.cnf"],
                                     "FIXTURE_COPY_CNF", input=self.cnf.read_bytes())
                if error == "CREATE_BACKUP_ACCOUNT" and self.collision:
                    existing.command(args, "FIXTURE_CONCURRENT_CREATE")
                return existing.command(args, error, **kwargs)

        with tempfile.TemporaryDirectory() as work:
            fixture = LiveMysql(Path(work))
            fixture.config.root_mysql = mysql
            fixture.config.client = [docker, "exec", instance]
            options = json.loads(control("network", "inspect", network))[0]
            self.assertTrue(options["Internal"])
            self.assertFalse(json.loads(control("inspect", instance))[0]["HostConfig"]["PortBindings"])
            fixture.config.subnet = ipaddress.IPv4Network(options["IPAM"]["Config"][0]["Subnet"])
            fixture.config.account_host = fixture.config.subnet.with_netmask

            fixture.perform()
            receipt = json.loads((fixture.destination / "transfer.json").read_text())
            dump = fixture.restic(fixture.destination, "dump", receipt["snapshotIds"]["database"], "/database.sql")
            self.assertIn(b"fixture_trigger", dump)
            self.assertIn(b"VALUES (17)", dump)
            self.assertEqual(oneoff.account_count(fixture, fixture.config, USER), 0)
            self.assertFalse(fixture.cnf.exists())

            with patch.object(oneoff, "CNF", fixture.cnf):
                with self.assertRaisesRegex(oneoff.Rejected, "BACKUP_INTERRUPTED_BY_SIGTERM"):
                    with oneoff.backup_account(fixture, fixture.config, USER, {}, fixture.paths, fixture.baseline):
                        oneoff.interrupted(signal.SIGTERM, None)
                self.assertEqual(oneoff.account_count(fixture, fixture.config, USER), 0)
                self.assertFalse(fixture.cnf.exists())

                fixture.collision = True
                with self.assertRaisesRegex(Failure, "CREATE_BACKUP_ACCOUNT"):
                    with oneoff.backup_account(fixture, fixture.config, USER, {}, fixture.paths, fixture.baseline):
                        self.fail("Unexpected account creation")
                self.assertEqual(oneoff.account_count(fixture, fixture.config, USER), 1)
                self.assertFalse(fixture.cnf.exists())


if __name__ == "__main__":
    unittest.main()
