import datetime as dt
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import ssl
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import monitor
from backup import CHAT_MIGRATION, expected_tables, release_migrations, verify_migrations
from common import Failure
from retention import retention_plan


class OperationalTests(unittest.TestCase):
    def test_migration_checksums_match_the_reviewed_sql_in_both_line_endings(self):
        directory = Path(__file__).resolve().parents[3] / "backend/prisma/migrations"
        expected = release_migrations(directory)
        for eol in (b"\n", b"\r\n"):
            recorded = []
            for name in expected:
                sql = (directory / name / "migration.sql").read_bytes().replace(b"\r\n", b"\n")
                recorded.append([name, hashlib.sha256(sql.replace(b"\n", eol)).hexdigest(), 1, 1])
            verify_migrations(recorded, expected)
        for invalid in (recorded[1:], [["unknown", *recorded[0][1:]], *recorded[1:]],
                        [[recorded[0][0], "0" * 64, 1, 1], *recorded[1:]]):
            with self.assertRaisesRegex(Failure, "MIGRATIONS_NOT_REVIEWED_CHAIN"):
                verify_migrations(invalid, expected)

    def test_release_history_accepts_previous_archive_and_rejects_mixed_chain(self):
        directory = Path(__file__).resolve().parents[3] / "backend/prisma/migrations"
        current = release_migrations(directory)
        self.assertEqual(len(current), 16)
        self.assertEqual(len(expected_tables(current)), 18)
        t25 = "20261124000000_customer_invitation_registration"
        with tempfile.TemporaryDirectory() as root:
            prior = Path(root)
            for name in current.keys() - {t25, CHAT_MIGRATION}:
                target = prior / name / "migration.sql"
                target.parent.mkdir()
                target.write_bytes((directory / name / "migration.sql").read_bytes())
            historical = release_migrations(prior)
            self.assertEqual(len(expected_tables(historical)), 14)
            invitation = prior / t25 / "migration.sql"
            invitation.parent.mkdir()
            invitation.write_bytes((directory / t25 / "migration.sql").read_bytes())
            self.assertEqual(len(release_migrations(prior)), 15)
        recorded = [[name, next(iter(checksums))] for name, checksums in historical.items()]
        verify_migrations(recorded, historical)
        with self.assertRaisesRegex(Failure, "MIGRATIONS_NOT_REVIEWED_CHAIN"):
            verify_migrations(recorded, current)
        with self.assertRaisesRegex(Failure, "MIGRATIONS_NOT_REVIEWED_CHAIN"):
            verify_migrations([*recorded, [t25, next(iter(current[t25]))]], historical)

    def test_journal_alert_boundary_is_below_namespace_cap(self):
        deploy = Path(__file__).resolve().parents[2]
        conf = deploy / "journald/journald@ai-membership-store.conf.d/retention.conf"
        cap = int(next(line for line in conf.read_text().splitlines()
                       if line.startswith("SystemMaxUse=")).removeprefix("SystemMaxUse=").removesuffix("M"))
        limit = monitor.LIMITS["journalMaxMiB"]
        self.assertLess(limit, cap)
        config = json.loads((deploy / "ops/ops.json.example").read_text())
        self.assertEqual(config["thresholds"]["journalMaxMiB"], limit)
        directory = Mock()
        directory.is_dir.return_value = True
        archive, current = Mock(), Mock()
        archive.stat.return_value = SimpleNamespace(st_blocks=40 * 2048)
        directory.glob.return_value = [archive, current]
        blocks_at_limit = (limit - 40) * 2048
        for blocks, healthy in ((blocks_at_limit - 1, True), (blocks_at_limit, False),
                                (blocks_at_limit + 1, False)):
            with self.subTest(blocks=blocks):
                current.stat.return_value = SimpleNamespace(st_blocks=blocks)
                self.assertEqual(monitor.journal_below_limit(directory, limit), healthy)
        directory.is_dir.return_value = False
        self.assertFalse(monitor.journal_below_limit(directory, limit))

    def test_failed_repository_units_alert_even_when_saved_checks_are_fresh(self):
        units = (
            ("ai-membership-store-repository.service", "REPOSITORY_CHECK"),
            ("ai-membership-store-repository-data.service", "REPOSITORY_DATA_CHECK"),
        )
        now = time.time()
        with tempfile.TemporaryDirectory() as path:
            state = Path(path)
            recent = dt.datetime.fromtimestamp(now - 5, tz=dt.timezone.utc).isoformat()
            for filename in ("repository.json", "repository-data.json"):
                (state / filename).write_text(json.dumps({"checkedAt": recent, "result": "success"}))
            (state / "backup.json").write_text(json.dumps({"lastSuccessAt": recent, "result": "success"}))
            for failed_unit, alert in units:
                for active_state, result in (("failed", "oom-kill"), ("inactive", "timeout"),
                                             ("failed", "signal"), ("failed", "success"),
                                             ("inactive", "success")):
                    with self.subTest(unit=failed_unit, state=active_state, result=result):
                        def proc(args, *_other, **_kwargs):
                            if args[0] != "systemctl":
                                return b"/"
                            if args[2] == failed_unit:
                                return f"ActiveState={active_state}\nResult={result}\n".encode()
                            return b"ActiveState=inactive\nResult=success\nNRestarts=0\n"

                        with patch.object(monitor, "command", side_effect=proc) as commands, \
                                patch.object(monitor, "fetch_json", side_effect=OSError), \
                                patch.object(monitor, "inspect", side_effect=Failure("no database")):
                            active, _, _ = monitor.probes({}, state, {}, now)
                        repository_alerts = {code for _, code in units}
                        wanted = {alert} if active_state == "failed" or result != "success" else set()
                        self.assertEqual(active & repository_alerts, wanted)
                        self.assertTrue(all(
                            any(call.args[0] == ["systemctl", "show", unit, "--property=ActiveState,Result"]
                                for call in commands.call_args_list) for unit, _ in units
                        ))

    def test_retention_keeps_complete_groups_and_quarantines_partial_runs(self):
        now = dt.datetime(2026, 11, 23, tzinfo=dt.timezone.utc)
        completed = {"old": now - dt.timedelta(days=31), "new": now, "middle": now - dt.timedelta(hours=1)}
        partial = {"partial": now, "expired": now - dt.timedelta(days=10)}
        keep, expire, aged = retention_plan(completed, partial, {
            "keepHourly": 1, "keepDaily": 0, "keepWeekly": 0, "keepMonthly": 0,
        }, now)
        self.assertEqual(keep, {"new"})
        self.assertEqual(expire, {"old", "middle"})
        self.assertEqual(aged, {"expired"})

    def test_probes_worker_failure_thresholds_backup_and_site_outage(self):
        def proc(args, *_other, **_kwargs):
            if args[0] == "systemctl":
                return b"ActiveState=active\nNRestarts=2\nResult=success\n"
            if args[0] == "docker":
                return b"/\n"
            return b"Out of memory: fixture\n"

        def get(_http, path, _timeout):
            if path == "/api/v1/health":
                return {"database": "unavailable", "status": "degraded"}
            return {
                "startedAt": 1,
                "requests": {"count": 12, "errors": 10, "p95Ms": 5000},
                "workers": {
                    "subscriptionExpiry": {"secondsSinceLastSuccess": None, "consecutiveFailures": 0, "backlog": False},
                    "orderTimeout": {"secondsSinceLastSuccess": 5, "consecutiveFailures": 3, "backlog": True},
                },
            }

        class FailedHTTP:
            def open(self, *_args, **_kwargs):
                raise OSError("T233_FIXTURE_PRIVATE_MARKER")

        with tempfile.TemporaryDirectory() as path, patch.object(monitor, "fetch_json", get), \
                patch.object(monitor, "opener", return_value=FailedHTTP()), \
                patch.object(monitor, "inspect", side_effect=Failure("no database")), \
                patch.object(monitor, "command", proc):
            active, _, _ = monitor.probes({
                "thresholds": {"memoryAvailableMiB": 2**50, "diskFreePercent": 101},
                "publicOrigin": "http://nonhttps.invalid",
                "existingSites": ["https://fixture.invalid"],
            }, Path(path), {"restarts": 1}, time.time())
        self.assertTrue({
            "API_HEALTH", "MYSQL_QUERY", "MYSQL_CONTAINER", "HTTP_5XX", "HTTP_LATENCY",
            "WORKER_SUBSCRIPTIONS", "WORKER_ORDERS", "BACKLOG_ORDERS", "BACKUP_STALE",
            "MEMORY", "DISK_ROOT", "OOM", "API_RESTART", "TLS", "EXISTING_SITE_1",
        }.issubset(active))

    def test_https_webhook_timeout_status_retry_cooldown_recovery(self):
        deliveries = []
        response_status = [503]

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                deliveries.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                self.send_response(response_status[0])
                self.end_headers()

            def log_message(self, *_args):
                pass

        with tempfile.TemporaryDirectory() as path:
            cert, key = str(Path(path) / "cert"), str(Path(path) / "key")
            subprocess.run([
                "openssl", "req", "-x509", "-newkey", "rsa:2048", "-noenc", "-days", "1", "-subj", "/CN=127.0.0.1",
                "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert,
            ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
            with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
                context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
                context.load_cert_chain(cert, key)
                server.socket = context.wrap_socket(server.socket, server_side=True)
                background = threading.Thread(target=server.serve_forever, daemon=True)
                background.start()
                code = {"API_HEALTH"}
                try:
                    with patch.dict(os.environ, {"SSL_CERT_FILE": cert}), patch.object(monitor, "log") as journal:
                        send = monitor.webhook(f"https://127.0.0.1:{server.server_port}/?T233_FIXTURE_PRIVATE_MARKER", 2)
                        status = monitor.notifications(code, {}, 1000, 1800, send)
                        self.assertFalse(status["API_HEALTH"]["delivered"])
                        response_status[0] = 204
                        status = monitor.notifications(code, status, 1060, 1800, send)
                        self.assertEqual(len(deliveries), 1)
                        status = monitor.notifications(code, status, 1300, 1800, send)
                        self.assertTrue(status["API_HEALTH"]["delivered"])
                        status = monitor.notifications(code, status, 1360, 1800, send)
                        self.assertEqual(len(deliveries), 2)
                        self.assertEqual(monitor.notifications(set(), status, 1361, 1800, send), {})
                        self.assertEqual([item["status"] for item in deliveries], ["firing", "firing", "recovered"])
                        self.assertNotIn("T233_FIXTURE_PRIVATE_MARKER", str(journal.call_args_list))
                finally:
                    server.shutdown()
                    background.join()


if __name__ == "__main__":
    unittest.main()
