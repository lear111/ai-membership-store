import contextlib
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile


HERE = Path(__file__).resolve().parent
CONFIG = Path("/etc/ai-membership-store/ops.json")
IMAGE = "docker.io/library/mysql:8.4.13@sha256:72c368d898861f3b3a07af0e6d690400f44f048799ed46822783d9224cc2c86d"
DATABASE = "membership_production"
STATE = Path("/var/lib/ai-membership-store/ops")
IMAGE_ROOT = Path("/srv/membership-data")
RESTIC = Path("/opt/restic-0.20.0/restic")
IMAGE_DIRS = {"wechat-qr": "png", "product-covers": "webp"}
SNAPSHOT = re.compile(r"[0-9a-f]{64}")


class Failure(Exception):
    pass


def utc():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def log(event, **data):
    print(json.dumps({"time": utc(), "event": event, **data}), flush=True)


def command(args, error, *, input=None, env=None, timeout=30, cwd=None):
    try:
        result = subprocess.run(
            args, input=input, stdin=subprocess.DEVNULL if input is None else None,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, timeout=timeout, check=False, cwd=cwd,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise Failure(error) from None
    if result.returncode:
        raise Failure(error)
    return result.stdout


def private_file(path):
    path = Path(path)
    try:
        mode = path.lstat()
        return (
            path.is_absolute() and path.resolve(strict=True) == path
            and stat.S_ISREG(mode.st_mode) and mode.st_uid == 0 and mode.st_gid == 0
            and stat.S_IMODE(mode.st_mode) == 0o600
        )
    except OSError:
        return False


def configuration(path):
    if not private_file(path):
        raise Failure("CONFIG_PERMISSIONS")
    try:
        settings = json.loads(Path(path).read_text())
    except (OSError, ValueError):
        raise Failure("CONFIG_INVALID") from None
    if not isinstance(settings, dict):
        raise Failure("CONFIG_INVALID")
    return settings


def read_json(path, default):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return default


def ensure_private_dir(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    mode = path.lstat()
    if (path.resolve(strict=True) != path or not stat.S_ISDIR(mode.st_mode)
            or mode.st_uid != 0 or mode.st_gid != 0 or stat.S_IMODE(mode.st_mode) != 0o700):
        raise Failure("STATE_PERMISSIONS")


def write_json(path, value):
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as stream:
        tmp = Path(stream.name)
        try:
            json.dump(value, stream, ensure_ascii=True, sort_keys=True)
            stream.flush()
            os.fsync(stream.fileno())
            os.replace(tmp, path)
        finally:
            tmp.unlink(missing_ok=True)


@contextlib.contextmanager
def lock(directory, name):
    ensure_private_dir(directory)
    with (directory / (name + ".lock")).open("a") as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Failure("OPERATION_BUSY") from None
        yield


def docker(*args, error="DOCKER_UNAVAILABLE"):
    return command(["docker", *args], error)


def inspect(container):
    rows = json.loads(docker("inspect", "--type", "container", container, error="MYSQL_IDENTITY"))
    return rows[0]
