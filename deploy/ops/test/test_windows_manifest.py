from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

from test_windows_backup import make_archive, stopped_state
import backup
from common import Failure
from windows_backup import verified_operations


RESTIC_BINARY = os.environ.get("T273_TEST_RESTIC")
PAUSE_UPLOAD = """
from pathlib import Path
import sys, time

source, started, release = map(Path, sys.argv[1:])
sys.stdout.buffer.write(source.read_bytes())
sys.stdout.buffer.flush()
started.touch()
for _ in range(200):
    if release.exists():
        break
    time.sleep(0.05)
else:
    raise SystemExit("manifest upload was not released")
"""


@unittest.skipUnless(RESTIC_BINARY, "Set T273_TEST_RESTIC to a verified Linux Restic 0.20.0 binary")
class WindowsManifestTests(unittest.TestCase):
    def test_runtime_change_during_manifest_upload_leaves_prior_backup_intact(self):
        for count, change in ((14, "restart"), (15, "release")):
            with self.subTest(migrations=count, change=change), tempfile.TemporaryDirectory() as temporary:
                self.exercise(Path(temporary), count, change)

    def exercise(self, fixture, count, change):
        password = fixture / "password"
        password.write_text(os.urandom(32).hex())
        password.chmod(0o600)
        (fixture / "restic").symlink_to(Path(RESTIC_BINARY).resolve(strict=True))
        for name in backup.IMAGE_DIRS:
            directory = fixture / "images" / name
            directory.mkdir(parents=True)
            (directory / "synthetic-image").write_bytes(b"fixture")
        archive_path = fixture / "operations.tar.gz"
        archive = verified_operations(archive_path, make_archive(archive_path, count, "a" * 40))
        inventory = {"database": backup.DATABASE, "tables": sorted(backup.TABLES), "triggerCount": 10,
                     "migrations": [[name, hashlib.sha256(sql).hexdigest()]
                                    for name, sql in archive.migrations.items()]}
        state = fixture / "state"
        state.mkdir(mode=0o700)
        status = state / "windows-backup.json"
        settings = {"fixtureProject": "membership-backup-test-" + "1" * 12}
        service = stopped_state()
        current = fixture / "current"
        current.symlink_to(f"releases/{archive.release_sha}")
        fault = False
        started, resume = fixture / "upload-started", fixture / "upload-resume"

        with patch.dict(os.environ, {"RESTIC_REPOSITORY": str(fixture / "repo"),
                                     "RESTIC_PASSWORD_FILE": str(password)}):
            repo = backup.Repository(fixture)
        repo.call("init")
        repo.tunnel = Mock(fingerprint="synthetic-pin")
        original_snapshot = repo.snapshot

        def snapshot(run, part, *args, **options):
            if part == "database":
                args = (*args[:4], "printf", "synthetic data without SQL execution")
            if part != "manifest" or not fault:
                return original_snapshot(run, part, *args, **options)

            with ThreadPoolExecutor(max_workers=1) as executor:
                upload = executor.submit(original_snapshot, run, part, *args[:-2],
                                         sys.executable, "-c", PAUSE_UPLOAD, args[-1],
                                         str(started), str(resume), **options)
                try:
                    deadline = time.monotonic() + 10
                    while not started.exists() and not upload.done() and time.monotonic() < deadline:
                        time.sleep(0.02)
                    self.assertTrue(started.exists(), "Restic did not start streaming the manifest")
                    self.assertFalse(upload.done(), "Restic returned before the state change")
                    if change == "restart":
                        service.update(ExecMainStartTimestampMonotonic="40",
                                       ExecMainExitTimestampMonotonic="50", InactiveEnterTimestampMonotonic="51",
                                       InactiveExitTimestampMonotonic="39")
                    else:
                        original = current.rename(fixture / "original")
                        current.symlink_to("releases/" + "b" * 40)
                        current.unlink()
                        current.symlink_to(os.readlink(original))
                finally:
                    resume.touch()
                return upload.result(timeout=20)

        def run_backup():
            backup.backup(repo, settings, state, fixture, archive=archive, pre_migration=True)

        with (patch.object(repo, "initialize_windows"),
              patch.object(repo, "call", wraps=repo.call) as restic,
              patch.object(repo, "snapshot", side_effect=snapshot),
              patch.object(backup, "maintenance_runtime",
                           side_effect=lambda _: (service.copy(), backup.link_identity(current))),
              patch.object(backup, "inspect_target"),
              patch.object(backup, "inventory", return_value=inventory),
              patch.object(backup, "table_counts", return_value=dict.fromkeys(backup.TABLES, 0)),
              patch.object(backup, "check_image_references")):
            run_backup()
            previous = json.loads(status.read_text())
            original_parts = backup.groups(repo)[previous["run"]]
            original_manifest = backup.load_manifest(repo, previous["run"], original_parts)
            self.assertEqual(previous["manifest"], original_parts["manifest"]["id"])

            fault = True
            with self.assertRaisesRegex(Failure, "MAINTENANCE_STATE_CHANGED"):
                run_backup()
            groups = backup.groups(repo)
            rejected, = groups.keys() - {previous["run"]}
            self.assertEqual(set(groups[rejected]), {"database", "images"})
            entries = json.loads(repo.call("--json", "snapshots", "--tag", f"run:{rejected},manifest"))
            staged, = entries
            self.assertNotIn(backup.TAG, staged["tags"])
            for parts in (groups[rejected], {**groups[rejected], "manifest": staged}):
                with self.assertRaisesRegex(Failure, "BACKUP_INCOMPLETE"):
                    backup.load_manifest(repo, rejected, parts)
            project = "membership-restore-" + "2" * 12
            output = fixture / (project + "-images")
            with patch.object(backup, "rows", return_value=[[0, 0, 0]]):
                with self.assertRaisesRegex(Failure, "BACKUP_INCOMPLETE"):
                    backup.restore(repo, rejected, project, output, archive=archive)
            self.assertFalse(output.exists())

            self.assertEqual(groups[previous["run"]], original_parts)
            self.assertEqual(backup.load_manifest(repo, previous["run"], original_parts), original_manifest)
            failed = json.loads(status.read_text())
            self.assertEqual((failed["run"], failed["lastSuccessAt"], failed["result"]),
                             (previous["run"], previous["lastSuccessAt"], "failed"))
            self.assertEqual(sum("tag" in call.args for call in restic.call_args_list), 1)
            self.assertFalse(any({"prune", "forget"}.intersection(call.args) for call in restic.call_args_list))
            repo.call("check", "--read-data")
