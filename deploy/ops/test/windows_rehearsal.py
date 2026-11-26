"""Real SSH/Restic transport checks for the disposable MySQL rehearsal."""

from contextlib import contextmanager
from dataclasses import replace
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import time
from unittest.mock import patch
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import backup
from common import Failure, configuration
from windows_backup import WindowsTunnel, verified_operations
from test_windows_backup import stopped_state, systemd_output


def run(*args):
    subprocess.run(args, check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL)


def eventually(probe):
    for _ in range(150):
        value = probe()
        if value:
            return value
        time.sleep(.1)
    raise RuntimeError("SSH fixture did not become ready")


def unused_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@contextmanager
def child(args, log):
    with log.open("wb") as error:
        process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=error)
        try:
            yield process
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


def ready(port):
    with socket.socket() as sock:
        return sock.connect_ex(("127.0.0.1", port)) == 0


def key(directory, name):
    path = directory / name
    run("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(path))
    return path


def public(path):
    return " ".join(path.with_suffix(".pub").read_text().split()[:2])


def server_config(path, port, host_key, authorized, extra):
    path.write_text(f"""Port {port}
ListenAddress 127.0.0.1
AddressFamily inet
HostKey {host_key}
AuthorizedKeysFile {authorized}
StrictModes yes
PasswordAuthentication no
KbdInteractiveAuthentication no
AuthenticationMethods publickey
UsePAM yes
PermitTTY no
{extra}
""")


@contextmanager
def reverse_link(directory, gateway, receiver, identity, known_hosts):
    log = directory / ("tunnel-" + uuid4().hex + ".log")
    args = ["ssh", "-F", "/dev/null", "-v", "-N", "-T", "-o", "BatchMode=yes",
            "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes", "-o",
            f"UserKnownHostsFile={known_hosts}", "-o", "GlobalKnownHostsFile=/dev/null",
            "-i", str(identity), "-p", str(gateway), "-o", "ExitOnForwardFailure=yes",
            "-R", f"127.0.0.1:0:127.0.0.1:{receiver}", "root@127.0.0.1"]
    with child(args, log) as process:
        match = eventually(lambda: re.search(r"Allocated port (\d+) for remote forward", log.read_text()))
        port = int(match[1])
        yield process, port
    eventually(lambda: not ready(port))


def must_fail(action, code):
    try:
        action()
    except Failure as error:
        if str(error) == code:
            return
        raise
    raise AssertionError(f"Expected {code}")



def inspection_repo(path):
    # Independent read-only inventory of test snapshots, never a restore source.
    def call(*args, timeout=60):
        return backup.command([str(backup.RESTIC), "--no-cache", "--no-lock", "--repo", str(path), *args],
                              "TEST_REPOSITORY_INSPECT", timeout=timeout)

    return SimpleNamespace(call=call, snapshots=lambda: json.loads(call("--json", "snapshots", "--tag", backup.TAG)))

def exercise(fixture, operations_path, runtime_path, incoming):
    assert fixture.name.startswith("membership-t233-") and incoming == Path("/t273-sftp/incoming")
    assert incoming.parent.resolve(strict=True) == incoming.parent and incoming.is_mount()
    assert not list(incoming.iterdir())
    settings = configuration(fixture / "ops.json")
    with operations_path.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    archive = verified_operations(operations_path, digest)
    state = fixture / "state"
    os.environ.pop("RESTIC_REPOSITORY", None)
    Path("/run/sshd").mkdir(exist_ok=True)
    run("useradd", "--no-create-home", "--home-dir", "/", "--shell", "/bin/sh", "membership-sftp")
    with tempfile.TemporaryDirectory(prefix="t273-ssh-", dir="/run") as temporary:
        path = Path(temporary)
        path.chmod(0o755)
        gateway, receiver = unused_port(), unused_port()
        gateway_key, receiver_key = key(path, "gateway-host"), key(path, "receiver-host")
        gateway_identity, identity = key(path, "gateway-client"), key(path, "windows-tunnel-key")
        bad_identity = key(path, "wrong-client")
        gateway_authorized, receiver_authorized = path / "gateway-authorized", path / "receiver-authorized"
        gateway_authorized.write_text(public(gateway_identity) + "\n")
        receiver_authorized.write_text('restrict,from="127.0.0.1" ' + public(identity) + "\n")
        receiver_authorized.chmod(0o644)
        known_hosts = path / "gateway-known-hosts"
        known_hosts.write_text(f"[127.0.0.1]:{gateway} {public(gateway_key)}\n")
        gateway_config, receiver_config = path / "gateway.conf", path / "receiver.conf"
        server_config(gateway_config, gateway, gateway_key, gateway_authorized,
                      "PermitRootLogin prohibit-password\nGatewayPorts no\nAllowTcpForwarding remote")
        server_config(receiver_config, receiver, receiver_key, receiver_authorized,
                      "AllowUsers membership-sftp\nChrootDirectory /t273-sftp\n"
                      "Subsystem sftp internal-sftp\nForceCommand internal-sftp -d /incoming\nDisableForwarding yes")

        def windows_repository(port, staging):
            profile = path / "profile.json"
            profile.write_text(json.dumps(
                {"port": port, "repository": "membership-" + uuid4().hex, "hostKey": public(receiver_key)}
            ))
            tunnel = WindowsTunnel.from_profile(profile)
            return backup.Repository(None, tunnel=tunnel, staging=staging)

        runtime = Path("/opt/ai-membership-store/releases") / archive.release_sha
        runtime.mkdir(parents=True)
        with tarfile.open(runtime_path, "r:gz") as bundle:
            bundle.extractall(runtime, filter="data")
        run("chmod", "-R", "a+rX,a-w", str(runtime))
        runtime.parent.parent.joinpath("current").symlink_to("releases/" + archive.release_sha)
        stopped = stopped_state()
        service = stopped.copy()
        original = backup.command

        def systemctl(args, *rest, **options):
            if args[0] == "systemctl":
                return systemd_output(service)
            return original(args, *rest, **options)

        def run_backup(repo):
            backup.backup(repo, settings, state, fixture, archive=archive, pre_migration=True)

        def assert_incomplete(repo):
            location = incoming / Path(repo.tunnel.directory).name
            partial = inspection_repo(location)
            groups = backup.groups(partial)
            assert len(groups) == 1
            run_id, parts = next(iter(groups.items()))
            assert parts.keys() == {"database"}
            must_fail(lambda: backup.load_manifest(partial, run_id, parts), "BACKUP_INCOMPLETE")

        with (patch.object(backup, "command", side_effect=systemctl),
              child(["/usr/sbin/sshd", "-D", "-e", "-f", str(gateway_config)], path / "gateway.log"),
              child(["/usr/sbin/sshd", "-D", "-e", "-f", str(receiver_config)], path / "receiver.log")):
            eventually(lambda: ready(gateway) and ready(receiver))
            with reverse_link(path, gateway, receiver, gateway_identity, known_hosts) as (link, port):
                staging = Path(tempfile.mkdtemp(dir=path))
                repo = windows_repository(port, staging)
                must_fail(lambda: backup.Repository(None, tunnel=replace(repo.tunnel, port=gateway),
                                                    staging=staging), "WINDOWS_SFTP_AUTH")
                must_fail(lambda: backup.Repository(None, tunnel=replace(repo.tunnel, host_key=public(gateway_key)),
                                                    staging=staging), "WINDOWS_SFTP_AUTH")
                must_fail(lambda: backup.Repository(None, tunnel=replace(repo.tunnel, identity=bad_identity),
                                                    staging=staging), "WINDOWS_SFTP_AUTH")
                repo = backup.Repository(None, tunnel=repo.tunnel, staging=staging)
                service["Result"] = "exit-code"
                must_fail(lambda: run_backup(repo), "MAINTENANCE_SERVICE_NOT_STOPPED")
                service.update(stopped)
                mismatch = replace(archive, release_sha="0" * 40)
                must_fail(lambda: backup.backup(repo, settings, state, fixture, archive=mismatch,
                                                pre_migration=True), "OPERATIONS_RELEASE_MISMATCH")
                assert not (incoming / Path(repo.tunnel.directory).name).exists()

                snapshot = repo.snapshot

                def disconnect_after_database(run_id, part, *args):
                    result = snapshot(run_id, part, *args)
                    if part == "database":
                        link.terminate()
                        link.wait(timeout=8)
                        eventually(lambda: not ready(port))
                    return result

                with patch.object(repo, "snapshot", side_effect=disconnect_after_database):
                    must_fail(lambda: run_backup(repo), "WINDOWS_TUNNEL_LISTENER")
            assert_incomplete(repo)

            with reverse_link(path, gateway, receiver, gateway_identity, known_hosts) as (_, port):
                repo = windows_repository(port, Path(tempfile.mkdtemp(dir=path)))
                snapshot = repo.snapshot

                def restart_after_database(run_id, part, *args):
                    result = snapshot(run_id, part, *args)
                    if part == "database":
                        service.update(ExecMainStartTimestampMonotonic="110",
                                       ExecMainExitTimestampMonotonic="120", InactiveEnterTimestampMonotonic="121",
                                       InactiveExitTimestampMonotonic="109")
                    return result

                with patch.object(repo, "snapshot", side_effect=restart_after_database):
                    must_fail(lambda: run_backup(repo), "MAINTENANCE_STATE_CHANGED")
            assert_incomplete(repo)
            service.update(stopped)
            print("Abnormal stop and mismatched archive rejected. A restart and a dropped tunnel left no marker.")

            with reverse_link(path, gateway, receiver, gateway_identity, known_hosts) as (_, port):
                repo = windows_repository(port, Path(tempfile.mkdtemp(dir=path)))
                run_backup(repo)
                must_fail(repo.initialize_windows, "WINDOWS_REPOSITORY_NOT_NEW")
            location = incoming / Path(repo.tunnel.directory).name
            must_fail(lambda: backup.Repository(None, local_repository=location), "WINDOWS_LOCAL_REPOSITORY_READ_ONLY")
            local = inspection_repo(location)
            success = json.loads((state / "windows-backup.json").read_text())
            meta = backup.load_manifest(local, success["run"], backup.groups(local)[success["run"]])
            assert meta["releaseSha"] == archive.release_sha
            assert meta["windowsBackup"]["operationsArchiveSha256"] == digest
            assert meta["windowsBackup"]["mode"] == "pre-migration"
            assert len(meta["inventory"]["migrations"]) == len(archive.migrations)
            (fixture / "windows-restore.json").write_text(json.dumps(
                {"repository": str(location), "run": success["run"], "digest": digest}
            ))
            print("Stopped-service backup saved to Windows. Direct restore access to the writable mount was rejected.")


if __name__ == "__main__":
    fixture, operations, runtime, incoming = map(Path, sys.argv[1:])
    exercise(fixture, operations, runtime, incoming)
