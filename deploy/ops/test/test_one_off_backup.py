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
from unittest.mock import Mock, patch

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

# A private DNS responder for the two forward/reverse records used by the MySQL fixture.
DNS_FIXTURE = r"""
import ipaddress
import socket
import struct
import sys

def wire(name):
    return b"".join(bytes([len(label)]) + label.encode() for label in name.split(".")) + b"\0"

address = ipaddress.IPv4Address(sys.argv[1])
hostname = wire(sys.argv[2])
records = {
    hostname + struct.pack("!HH", 1, 1): (1, address.packed),
    wire(address.reverse_pointer) + struct.pack("!HH", 12, 1): (12, hostname),
}
with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as server:
    server.bind(("0.0.0.0", 53))
    while True:
        query, peer = server.recvfrom(512)
        end = query.find(b"\0", 12)
        if end < 0 or len(query) < end + 5:
            continue
        question = query[12:end + 5]
        answer = records.get(question.lower())
        header = query[:2] + struct.pack("!HHHHH", 0x8180, 1, int(answer is not None), 0, 0)
        response = header + question
        if answer:
            kind, data = answer
            response += b"\xc0\x0c" + struct.pack("!HHIH", kind, 1, 0, len(data)) + data
        server.sendto(response, peer)
"""


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
        self.principal = f"{USER}@{self.config.account_host}"
        self.cipher = "TLS_AES_256_GCM_SHA384"
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
            return (json.dumps(self.principal) + f"\nSsl_cipher\t{self.cipher}\n").encode()
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


class DockerEndpointTests(unittest.TestCase):
    def assert_startup_rejected(self, mode, environment, endpoint, error):
        config = SimpleNamespace(driver_directory=OPS.parent)
        with (patch.dict(os.environ, environment, clear=True),
              patch.object(sys, "argv", ["backup_vps_local.py", mode, "--run", RUN, "--config", "/fixture.json"]),
              patch.object(sys, "path", sys.path.copy()),
              patch.object(sys, "dont_write_bytecode", True),
              patch.object(os, "getuid", return_value=0),
              patch.object(os, "getgid", return_value=0),
              patch.object(oneoff, "load_configuration", return_value=config),
              patch.object(existing, "docker", return_value=endpoint) as docker,
              patch.object(existing, "command") as command,
              patch.object(oneoff, "account_count") as account_count,
              patch.object(oneoff, "capture") as capture,
              patch.object(oneoff, "perform") as perform):
            with self.assertRaisesRegex(oneoff.Rejected, error):
                oneoff.main()
        command.assert_not_called()
        account_count.assert_not_called()
        capture.assert_not_called()
        perform.assert_not_called()
        return docker

    def test_docker_host_is_rejected_before_any_docker_command(self):
        for value in ("tcp://192.0.2.42:2375", ""):
            with self.subTest(value=value):
                docker = self.assert_startup_rejected("--execute", {"DOCKER_HOST": value}, None,
                                                      "LOCAL_DOCKER_ENVIRONMENT_REQUIRED")
                docker.assert_not_called()

    def test_docker_context_is_rejected_before_any_docker_command(self):
        for value in ("alternate", ""):
            with self.subTest(value=value):
                docker = self.assert_startup_rejected("--dry-run", {"DOCKER_CONTEXT": value}, None,
                                                      "LOCAL_DOCKER_ENVIRONMENT_REQUIRED")
                docker.assert_not_called()

    def test_nondefault_context_endpoints_are_rejected_before_database_access(self):
        for endpoint in (b"tcp://192.0.2.42:2375\n", b"ssh://fixture.invalid\n", b"unix:///tmp/docker.sock\n", b""):
            for mode in ("--dry-run", "--execute"):
                with self.subTest(endpoint=endpoint, mode=mode):
                    docker = self.assert_startup_rejected(mode, {}, endpoint, "LOCAL_DOCKER_SOCKET_REQUIRED")
                    docker.assert_called_once_with("context", "inspect", "--format", "{{.Endpoints.docker.Host}}")

    def test_default_local_socket_is_accepted(self):
        ops = Mock()
        ops.docker.return_value = b"unix:///var/run/docker.sock\n"
        with patch.dict(os.environ, clear=True):
            oneoff.require_local_docker(ops)
        ops.docker.assert_called_once_with("context", "inspect", "--format", "{{.Endpoints.docker.Host}}")


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

    def test_unscoped_principal_and_empty_tls_cipher_are_rejected(self):
        fixture = self.fixture
        for principal, cipher in ((f"{USER}@%", fixture.cipher), (fixture.principal, "")):
            with (self.subTest(principal=principal, cipher=cipher),
                  patch.object(fixture, "principal", principal), patch.object(fixture, "cipher", cipher),
                  patch.object(oneoff, "CNF", fixture.cnf), patch.object(existing, "private_file", return_value=True),
                  self.assertRaisesRegex(oneoff.Rejected, "BACKUP_CLIENT_IDENTITY_OR_TLS")):
                with oneoff.backup_account(fixture, fixture.config, USER, {}, fixture.paths, fixture.baseline):
                    self.fail("Unexpected backup")
            self.assertFalse(fixture.active)
            self.assertFalse(fixture.cnf.exists())

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
        oneoff.require_local_docker(existing)
        suffix = uuid.uuid4().hex[:12]
        network = f"membership-t275-fixture-{suffix}"
        app_network = f"membership-t275-app-{suffix}"
        instance = f"membership-t275-mysql-{suffix}"
        client = f"membership-t275-client-{suffix}"
        dns = f"membership-t275-dns-{suffix}"
        client_hostname = "backup-client.fixture.test"

        def control(*args):
            return subprocess.check_output([docker, *args], stderr=subprocess.PIPE, timeout=90)

        def cleanup(*args):
            subprocess.run([docker, *args], check=False, capture_output=True, timeout=30)

        # Render the production service options without starting its project, publishing ports, or mounting secrets.
        services = json.loads(control(
            "compose", "--env-file", "/dev/null", "-p", f"membership-t275-fixture-{suffix}",
            "-f", str(OPS.parent / "mysql/compose.yaml"), "-f", str(OPS.parent / "mysql/backup.compose.yaml"),
            "--profile", "backup", "config", "--format", "json",
        ))["services"]
        server, backup_client = services["mysql"], services["backup-client"]
        self.assertEqual(server["image"], existing.IMAGE)
        for bridge in (network, app_network):
            control("network", "create", "--internal", bridge)
            self.addCleanup(cleanup, "network", "rm", bridge)
        control("run", "-d", "--rm", "--pull", "never", "--platform", server["platform"],
                "--network", network, "--network-alias", "mysql", "--hostname", "mysql",
                "--tmpfs", "/var/lib/mysql:size=512m", "--name", instance,
                "-e", "MYSQL_ALLOW_EMPTY_PASSWORD=yes", "-e", "MYSQL_ROOT_HOST=localhost",
                "-e", f"MYSQL_DATABASE={oneoff.SCHEMA}", "--entrypoint", "sh", server["image"], "-ec",
                # A trailing OFF option does not clear the resolver-disable flag set by the image's my.cnf.
                "sed -i '/^[[:space:]]*skip-name-resolve[[:space:]]*$/d' /etc/my.cnf; "
                'exec docker-entrypoint.sh mysqld "$@"', "fixture-mysql", *server["command"],
                "--skip-name-resolve=OFF")
        self.addCleanup(cleanup, "rm", "-f", instance)
        control("network", "connect", app_network, instance)
        control("run", "-d", "--rm", "--pull", "never", "--platform", backup_client["platform"],
                "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                "--tmpfs", "/run/secrets:size=1m", "--network", network, "--name", client,
                "--entrypoint", "sleep", backup_client["image"], "infinity")
        self.addCleanup(cleanup, "rm", "-f", client)
        mysql = [docker, "exec", instance, "mysql", "--protocol=socket", "--user=root",
                 *oneoff.SQL_OPTIONS, oneoff.SCHEMA]
        for _ in range(90):
            try:
                existing.command([docker, "exec", client, "mysqladmin", "--protocol=TCP", "--host=mysql",
                                  "--silent", "ping"], "FIXTURE_START")
                version, skip_name_resolve = existing.rows(mysql, "SELECT JSON_ARRAY(VERSION(), @@skip_name_resolve)")[0]
                break
            except Failure:
                time.sleep(1)
        else:
            self.fail("Disposable MySQL did not become ready")
        self.assertEqual(version, "8.4.13")
        self.assertEqual(skip_name_resolve, 0)
        client_networks = json.loads(control("inspect", client))[0]["NetworkSettings"]["Networks"]
        self.assertEqual(set(client_networks), {network})
        client_ip = client_networks[network]["IPAddress"]
        control("run", "-d", "--rm", "--pull", "never", "--network", app_network, "--name", dns,
                "--entrypoint", "python3", "ai-membership-store-t233-fixture-runner:local",
                "-B", "-c", DNS_FIXTURE, client_ip, client_hostname)
        self.addCleanup(cleanup, "rm", "-f", dns)
        dns_ip = json.loads(control("inspect", dns))[0]["NetworkSettings"]["Networks"][app_network]["IPAddress"]

        def use_resolver(address):
            control("exec", "--user", "0", instance, "sh", "-c",
                    "printf 'nameserver %s\\noptions timeout:1 attempts:1\\n' \"$1\" >/etc/resolv.conf",
                    "fixture-resolver", address)
            existing.command([*mysql, "-e", "TRUNCATE TABLE performance_schema.host_cache"], "FIXTURE_CLEAR_HOST_CACHE")

        use_resolver(dns_ip)
        for _ in range(10):
            try:
                reverse = control("exec", instance, "getent", "hosts", client_ip).decode().split()
                break
            except subprocess.CalledProcessError:
                time.sleep(1)
        else:
            self.fail("Disposable DNS did not return the fixture PTR record")
        self.assertEqual(reverse[:2], [client_ip, client_hostname])
        forward = control("exec", instance, "getent", "ahostsv4", client_hostname).decode().split()
        self.assertEqual(forward[0], client_ip)
        existing.command([*mysql, "-e",
                          "CREATE TABLE " + chr(96) + "Order" + chr(96) + " (value int);"
                          "CREATE TABLE OrderRevision (value int);"
                          "CREATE TRIGGER fixture_trigger BEFORE INSERT ON " + chr(96) + "Order" + chr(96)
                          + " FOR EACH ROW SET NEW.value = NEW.value + 1;"
                          "INSERT INTO " + chr(96) + "Order" + chr(96) + " VALUES (16);"], "FIXTURE_SCHEMA")

        identities = []

        class LiveMysql(Fixture):
            collision = False

            def rows(self, mysql_args, sql):
                return existing.rows(mysql_args, sql)

            def command(self, args, error, **kwargs):
                self.calls.append(error)
                if error == "BACKUP_CLIENT_TLS":
                    existing.command([docker, "exec", "-i", client, "sh", "-c",
                                      "umask 077; cat >/run/secrets/backup.mysql.cnf"],
                                     "FIXTURE_COPY_CNF", input=self.cnf.read_bytes())
                    result = existing.command([
                        *args[:-1], args[-1] + "; SELECT JSON_ARRAY(USER(), CURRENT_USER(), @@skip_name_resolve)",
                    ], error, **kwargs)
                    proof, details = result.rstrip(b"\n").rsplit(b"\n", 1)
                    identities.append(json.loads(details))
                    return proof
                if error == "CREATE_BACKUP_ACCOUNT" and self.collision:
                    existing.command(args, "FIXTURE_CONCURRENT_CREATE")
                return existing.command(args, error, **kwargs)

        with tempfile.TemporaryDirectory() as work:
            fixture = LiveMysql(Path(work))
            fixture.config.root_mysql = mysql
            fixture.config.client = [docker, "exec", client]
            options = json.loads(control("network", "inspect", network))[0]
            self.assertTrue(options["Internal"])
            self.assertFalse(json.loads(control("inspect", instance))[0]["HostConfig"]["PortBindings"])
            fixture.config.subnet = ipaddress.IPv4Network(options["IPAM"]["Config"][0]["Subnet"])
            fixture.config.account_host = fixture.config.subnet.with_netmask

            fixture.perform()
            origin, principal, skip_name_resolve = identities[-1]
            self.assertEqual(origin, f"{USER}@{client_hostname}")
            self.assertEqual(principal, f"{USER}@{fixture.config.account_host}")
            self.assertEqual(skip_name_resolve, 0)
            print(f"Fixture DNS USER()={origin} CURRENT_USER()={principal} skip_name_resolve={skip_name_resolve}")
            receipt = json.loads((fixture.destination / "transfer.json").read_text())
            dump = fixture.restic(fixture.destination, "dump", receipt["snapshotIds"]["database"], "/database.sql")
            self.assertIn(b"fixture_trigger", dump)
            self.assertIn(b"VALUES (17)", dump)
            self.assertEqual(oneoff.account_count(fixture, fixture.config, USER), 0)
            self.assertFalse(fixture.cnf.exists())

            # Simulate a failed PTR lookup for the same client. MySQL name resolution stays enabled.
            use_resolver("127.0.0.1")
            with patch.object(oneoff, "CNF", fixture.cnf):
                with self.assertRaisesRegex(oneoff.Rejected, "BACKUP_INTERRUPTED_BY_SIGTERM"):
                    with oneoff.backup_account(fixture, fixture.config, USER, {}, fixture.paths, fixture.baseline):
                        oneoff.interrupted(signal.SIGTERM, None)
                origin, principal, skip_name_resolve = identities[-1]
                self.assertEqual(origin, f"{USER}@{client_ip}")
                self.assertEqual(principal, f"{USER}@{fixture.config.account_host}")
                self.assertEqual(skip_name_resolve, 0)
                print(f"Fixture IP USER()={origin} CURRENT_USER()={principal} skip_name_resolve={skip_name_resolve}")
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
