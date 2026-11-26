import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import socket
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import backup
from common import Failure
from windows_backup import WindowsTunnel, local_windows_repository, verified_operations


MIGRATIONS = Path(__file__).resolve().parents[3] / "backend/prisma/migrations"
T25 = "20261124000000_customer_invitation_registration"


def stopped_state():
    return {
        "Id": backup.API_UNIT, "LoadState": "loaded", "ActiveState": "inactive", "SubState": "dead",
        "Result": "success", "MainPID": "0", "ControlPID": "0", "ExecMainCode": "1",
        "ExecMainStatus": "0", "Slice": "system.slice",
        "WorkingDirectory": str(backup.RELEASE_ROOT / "current/backend"),
        "ExecMainStartTimestampMonotonic": "10", "ExecMainExitTimestampMonotonic": "20",
        "InactiveEnterTimestampMonotonic": "21", "InactiveExitTimestampMonotonic": "9",
        "ControlGroup": "", "InvocationID": "", "NRestarts": "0",
    }


def systemd_output(values):
    return "".join(f"{key}={value}\n" for key, value in values.items()).encode()


def make_archive(path, count, sha, *, corrupt=False):
    entries = {"./release.json": json.dumps({"kind": "operations", "gitSha": sha}, indent=2).encode()}
    for script in MIGRATIONS.glob("*/migration.sql"):
        if count == 15 or script.parent.name != T25:
            entries[f"./backend/prisma/migrations/{script.parent.name}/migration.sql"] = script.read_bytes()
    entries["./SHA256SUMS"] = "".join(
        f"{hashlib.sha256(data).hexdigest()}  {name}\n" for name, data in entries.items()
    ).encode()
    if corrupt:
        entries["./release.json"] += b"\n"
    with tarfile.open(path, "w:gz") as tar:
        for name, data in entries.items():
            member = tarfile.TarInfo(name)
            member.size = len(data)
            tar.addfile(member, io.BytesIO(data))
    return hashlib.sha256(path.read_bytes()).hexdigest()


class WindowsBackupTests(unittest.TestCase):
    def test_original_archive_digests_and_migration_chains(self):
        with tempfile.TemporaryDirectory() as tmp:
            restored = {}
            for count in (14, 15):
                with self.subTest(count=count):
                    path = Path(tmp) / f"operations-{count}.tar.gz"
                    sha = f"{count:040x}"
                    digest = make_archive(path, count, sha)
                    archive = verified_operations(path, digest)
                    self.assertEqual((archive.release_sha, archive.archive_sha256), (sha, digest))
                    expected = backup.migration_checksums(archive.migrations)
                    self.assertEqual(len(expected), count)
                    restored[count] = (archive, expected)
                    with self.assertRaisesRegex(Failure, "OPERATIONS_ARCHIVE_SHA256"):
                        verified_operations(path, "0" * 64)
            historical, expected = restored[14]
            recorded = [[key, hashlib.sha256(value).hexdigest()] for key, value in historical.migrations.items()]
            backup.verify_migrations(recorded, expected)
            with self.assertRaisesRegex(Failure, "MIGRATIONS_NOT_REVIEWED_CHAIN"):
                backup.verify_migrations(recorded, restored[15][1])

            path = Path(tmp) / "corrupt.tar.gz"
            digest = make_archive(path, 14, "a" * 40, corrupt=True)
            with self.assertRaisesRegex(Failure, "OPERATIONS_ARCHIVE_CONTENTS"):
                verified_operations(path, digest)

    def test_current_runtime_sha_must_match_the_historical_archive(self):
        archive = Mock(release_sha="a" * 40)
        with patch.object(backup, "read_json", return_value={"kind": "runtime", "gitSha": "b" * 40}):
            with self.assertRaisesRegex(Failure, "OPERATIONS_RELEASE_MISMATCH"):
                backup.matching_runtime(archive)

    def test_existing_offsite_guard_rejects_local_and_unspecified(self):
        entries = json.dumps([{"addr_info": [{"local": "192.0.2.11"}]}]).encode()
        for host in ("127.0.0.1", "::1", "0.0.0.0", "::", "192.0.2.11"):
            addresses = [(socket.AF_INET, None, None, "", (host, 0))]
            with (self.subTest(host=host), patch.object(backup, "command", return_value=entries),
                  patch.object(socket, "getaddrinfo", return_value=addresses)):
                with self.assertRaisesRegex(Failure, "REPOSITORY_NOT_OFFSITE"):
                    backup.assert_off_host(host)

    def test_ordinary_sftp_and_s3_modes_still_reject_loopback(self):
        locations = ("sftp:membership-offsite:/incoming/repo", "s3:https://127.0.0.1/bucket/repo")
        for location in locations:
            def configuration_command(args, *_args, **_options):
                return b"hostname 127.0.0.1\n" if args[0] == "ssh" else b"[]"

            with (self.subTest(location=location),
                  patch.dict(os.environ, {"RESTIC_REPOSITORY": location, "RESTIC_PASSWORD_FILE": "/synthetic"}),
                  patch.object(backup, "private_file", return_value=True),
                  patch.object(backup, "command", side_effect=configuration_command)):
                with self.assertRaisesRegex(Failure, "REPOSITORY_NOT_OFFSITE"):
                    backup.Repository(None)

    def test_explicit_modes_cannot_run_timers_retention_or_write_local_repo(self):
        combinations = (
            (["--windows-tunnel-profile", "/profile", "check-data"], "WINDOWS_OPERATION_FORBIDDEN"),
            (["--windows-tunnel-profile", "/profile", "prune"], "WINDOWS_OPERATION_FORBIDDEN"),
            (["--windows-local-repository", "/repo", "backup"], "WINDOWS_OPERATION_FORBIDDEN"),
            (["--windows-local-repository", "/repo", "restore"], "OPERATIONS_ARCHIVE_ARGUMENT"),
            (["--operations-archive", "/archive", "backup"], "OPERATIONS_ARCHIVE_ARGUMENT"),
            (["--pre-migration", "backup"], "MAINTENANCE_WINDOWS_BACKUP_REQUIRED"),
        )
        for args, error in combinations:
            with (self.subTest(args=args), patch.object(sys, "argv", ["backup.py", *args]),
                  patch.object(backup, "docker") as docker):
                with self.assertRaisesRegex(Failure, error):
                    backup.run_tool()
                docker.assert_not_called()
        with patch.object(sys, "argv", ["backup.py", "--fixture", "/fixture", "--windows-tunnel-profile",
                                        "/profile", "backup"]), patch.object(argparse.ArgumentParser, "error") as error:
            error.side_effect = SystemExit(2)
            with self.assertRaises(SystemExit):
                backup.run_tool()

    def test_local_windows_repository_rejects_symlinks_and_other_directories(self):
        with tempfile.TemporaryDirectory() as tmp:
            repository = Path(tmp) / ("membership-" + "1" * 32)
            repository.mkdir()
            with self.assertRaisesRegex(Failure, "WINDOWS_LOCAL_REPOSITORY_PATH"):
                local_windows_repository(repository)
            (repository / "config").touch()
            with self.assertRaisesRegex(Failure, "WINDOWS_LOCAL_REPOSITORY_READ_ONLY"):
                local_windows_repository(repository)
            with patch("windows_backup.os.statvfs", return_value=SimpleNamespace(f_flag=os.ST_RDONLY)):
                self.assertEqual(local_windows_repository(repository), str(repository))
            symlink = Path(tmp) / ("membership-" + "2" * 32)
            symlink.symlink_to(repository, target_is_directory=True)
            with self.assertRaisesRegex(Failure, "WINDOWS_LOCAL_REPOSITORY_PATH"):
                local_windows_repository(symlink)

    def test_restore_rejects_output_under_repository_before_docker_access(self):
        with tempfile.TemporaryDirectory() as tmp:
            repository = Path(tmp) / "repository"
            directory = repository / "subdir"
            directory.mkdir(parents=True)
            repo = SimpleNamespace(local_repository=repository)
            project = "membership-restore-" + "1" * 12
            with patch.object(backup, "inspect_target") as inspect:
                with self.assertRaisesRegex(Failure, "RESTORE_OUTPUT_INSIDE_REPOSITORY"):
                    backup.restore(repo, "2" * 32, project, directory / (project + "-images"))
                inspect.assert_not_called()

    def test_maintenance_rejects_unclean_or_unknown_systemd_state(self):
        for update in ({"ActiveState": "active"}, {"ActiveState": "failed"}, {"SubState": "stop-sigterm"},
                       {"Result": "timeout"}, {"MainPID": "99"}, {"ControlPID": "99"},
                       {"ExecMainCode": "2"}, {"ExecMainStatus": "1"},
                       {"ExecMainStartTimestampMonotonic": "0"}):
            with self.subTest(update=update), patch.object(
                backup, "command", return_value=systemd_output({**stopped_state(), **update})
            ):
                with self.assertRaisesRegex(Failure, "MAINTENANCE_SERVICE_NOT_STOPPED"):
                    backup.stopped_service()
        with patch.object(backup, "command", return_value=systemd_output(stopped_state())):
            self.assertEqual(backup.stopped_service(), stopped_state())

    def test_maintenance_checks_residual_cgroup_and_api_listener(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            release = root / "releases" / ("a" * 40)
            release.mkdir(parents=True)
            (root / "current").symlink_to("releases/" + release.name)
            (root / "cgroup.controllers").touch()
            group = root / "system.slice" / backup.API_UNIT
            group.mkdir(parents=True)
            events = group / "cgroup.events"
            archive = SimpleNamespace(release_sha=release.name)
            with (patch.object(backup, "RELEASE_ROOT", root), patch.object(backup, "CGROUP_ROOT", root),
                  patch.object(backup, "sealed_runtime", return_value="test-seal"),
                  patch.object(backup, "stopped_service", side_effect=stopped_state),
                  patch.object(backup, "command", return_value=b"LISTEN 0 128 127.0.0.1:3101 *:*")):
                events.write_text("populated 1\nfrozen 0\n")
                with self.assertRaisesRegex(Failure, "MAINTENANCE_SERVICE_CGROUP"):
                    backup.maintenance_runtime(archive)
                events.write_text("populated 0\nfrozen 0\n")
                with self.assertRaisesRegex(Failure, "MAINTENANCE_API_LISTENER"):
                    backup.maintenance_runtime(archive)
                (root / "current").unlink()
                (root / "current").symlink_to("releases/" + "b" * 40)
                with self.assertRaisesRegex(Failure, "OPERATIONS_RELEASE_MISMATCH"):
                    backup.maintenance_runtime(archive)

    def test_new_service_lifecycle_after_images_prevents_completion_marker(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp)
            archive = Mock(release_sha="a" * 40, archive_sha256="c" * 64)
            repo = Mock()
            repo.snapshot.return_value = "d" * 64
            repo.tunnel.fingerprint = "test-pin"
            inventory = {"tables": list(backup.TABLES), "triggerCount": 10, "migrations": []}
            after_restart = {**stopped_state(), "ExecMainStartTimestampMonotonic": "100",
                             "ExecMainExitTimestampMonotonic": "102", "InactiveEnterTimestampMonotonic": "103"}
            with (patch.object(backup, "maintenance_runtime", side_effect=[stopped_state()] * 3 + [after_restart]),
                  patch.object(backup, "migration_checksums"),
                  patch.object(backup, "image_directories", return_value=[state, state]),
                  patch.object(backup, "private_file", return_value=True), patch.object(backup, "inspect_target"),
                  patch.object(backup, "inventory", return_value=inventory),
                  patch.object(backup, "check_image_references"), patch.object(backup, "table_counts", return_value={})):
                with self.assertRaisesRegex(Failure, "MAINTENANCE_STATE_CHANGED"):
                    backup.backup(repo, {}, state, None, archive=archive, pre_migration=True)
            self.assertEqual([args.args[1] for args in repo.snapshot.call_args_list], ["database", "images"])
            self.assertNotIn("lastSuccessAt", json.loads((state / "windows-backup.json").read_text()))

    def test_listener_must_be_one_exact_ipv4_loopback_socket(self):
        tunnel = WindowsTunnel(32100, "/incoming/membership-" + "1" * 32, "", "", Path("/fake-key"))
        for output in (b"", b"LISTEN 0 128 0.0.0.0:32100 *:*", b"LISTEN 0 128 [::1]:32100 *:*",
                       b"LISTEN 0 128 127.0.0.1:32101 *:*",
                       b"LISTEN 0 128 127.0.0.1:32100 *:*\nLISTEN 0 128 [::1]:32100 *:*"):
            with self.subTest(output=output), patch("windows_backup.command", return_value=output):
                with self.assertRaisesRegex(Failure, "WINDOWS_TUNNEL_LISTENER"):
                    tunnel.verify_listener()

    def test_disconnected_or_partial_windows_run_does_not_record_completion(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp)
            archive = Mock(release_sha="a" * 40, archive_sha256="c" * 64)
            repo = Mock()
            repo.snapshot.side_effect = ["d" * 64, Failure("WINDOWS_TUNNEL_LISTENER")]
            inventory = {"tables": list(backup.TABLES), "triggerCount": 10, "migrations": []}
            with (patch.object(backup, "matching_runtime"), patch.object(backup, "migration_checksums"),
                  patch.object(backup, "image_directories", return_value=[state, state]),
                  patch.object(backup, "private_file", return_value=True), patch.object(backup, "inspect_target"),
                  patch.object(backup, "inventory", return_value=inventory),
                  patch.object(backup, "check_image_references"), patch.object(backup, "table_counts")):
                with self.assertRaisesRegex(Failure, "WINDOWS_TUNNEL_LISTENER"):
                    backup.backup(repo, {}, state, None, archive=archive)
            self.assertEqual([args.args[1] for args in repo.snapshot.call_args_list], ["database", "images"])
            self.assertFalse((state / "backup.json").exists())
            status = json.loads((state / "windows-backup.json").read_text())
            self.assertEqual(status["result"], "failed")
            self.assertNotIn("lastSuccessAt", status)
