"""One-off Windows transport and release evidence for the backup operator."""

import base64
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import re
import shlex
import stat
import tarfile

from common import Failure, command, configuration, private_file


ALIAS = "membership-windows"
HOST_KEY_ALIAS = "membership-windows-pinned"
RECEIVER = "membership-sftp"
REPOSITORY_NAME = re.compile(r"membership-[0-9a-f]{32}")
SHA256 = re.compile(r"[0-9a-f]{64}")
GIT_SHA = re.compile(r"[0-9a-f]{40}")
MIGRATION = re.compile(r"backend/prisma/migrations/(\d{14}_[a-z_0-9]+)/migration\.sql")


@dataclass(frozen=True)
class OperationsArchive:
    release_sha: str
    archive_sha256: str
    migrations: dict[str, bytes]


class ArchiveStream:
    def __init__(self, source):
        self.source = source
        self.digest = hashlib.sha256()

    def read(self, size):
        data = self.source.read(size)
        self.digest.update(data)
        return data


def verified_operations(path, expected_digest):
    """Read only the verified manifest and SQL; never extract or execute the archive."""
    if not SHA256.fullmatch(expected_digest or "") or not path.is_absolute():
        raise Failure("OPERATIONS_ARCHIVE_ARGUMENT")
    members = {}
    try:
        if path.resolve(strict=True) != path or not stat.S_ISREG(path.lstat().st_mode):
            raise Failure("OPERATIONS_ARCHIVE_PATH")
        with path.open("rb") as source:
            stream = ArchiveStream(source)
            with tarfile.open(fileobj=stream, mode="r|gz") as archive:
                for member in archive:
                    name = member.name.removeprefix("./")
                    if name not in {"release.json", "SHA256SUMS"} and not MIGRATION.fullmatch(name):
                        continue
                    limit = 16 * 1024 * 1024 if name == "SHA256SUMS" else 1024 * 1024
                    if not member.isfile() or member.size > limit or name in members or len(members) >= 17:
                        raise Failure("OPERATIONS_ARCHIVE_LAYOUT")
                    members[name] = archive.extractfile(member).read()
            while stream.read(1024 * 1024):
                pass
            if stream.digest.hexdigest() != expected_digest:
                raise Failure("OPERATIONS_ARCHIVE_SHA256")
    except (OSError, tarfile.TarError):
        raise Failure("OPERATIONS_ARCHIVE_UNREADABLE") from None

    manifest_bytes = members.pop("release.json", b"{}")
    try:
        manifest = json.loads(manifest_bytes)
    except ValueError:
        raise Failure("OPERATIONS_ARCHIVE_MANIFEST") from None
    if (not isinstance(manifest, dict) or manifest.get("kind") != "operations"
            or not isinstance(manifest.get("gitSha"), str) or not GIT_SHA.fullmatch(manifest["gitSha"])):
        raise Failure("OPERATIONS_ARCHIVE_MANIFEST")
    checksums = {}
    for line in members.pop("SHA256SUMS", b"").decode().splitlines():
        if match := re.fullmatch(r"([0-9a-f]{64}) [ *](?:\./)?(.+)", line):
            name = match[2]
            if name == "release.json" or MIGRATION.fullmatch(name):
                if name in checksums:
                    raise Failure("OPERATIONS_ARCHIVE_LAYOUT")
                checksums[name] = match[1]
    if checksums != {
        "release.json": hashlib.sha256(manifest_bytes).hexdigest(),
        **{name: hashlib.sha256(data).hexdigest() for name, data in members.items()},
    }:
        # The manifest digest covers its original bytes, including whitespace.
        raise Failure("OPERATIONS_ARCHIVE_CONTENTS")
    return OperationsArchive(manifest["gitSha"], expected_digest,
                             {MIGRATION.fullmatch(name)[1]: data for name, data in members.items()})


def windows_host_key(text):
    # Pin a single raw Ed25519 host key obtained independently on Windows.
    if not isinstance(text, str) or not re.fullmatch(r"ssh-ed25519 [A-Za-z0-9+/]+={0,2}", text):
        raise Failure("WINDOWS_HOST_KEY_INVALID")
    try:
        blob = base64.b64decode(text.split()[1], validate=True)
    except ValueError:
        raise Failure("WINDOWS_HOST_KEY_INVALID") from None
    if len(blob) != 51 or not blob.startswith(b"\0\0\0\x0bssh-ed25519\0\0\0\x20"):
        raise Failure("WINDOWS_HOST_KEY_INVALID")
    return "SHA256:" + base64.b64encode(hashlib.sha256(blob).digest()).decode().rstrip("=")


@dataclass(frozen=True)
class WindowsTunnel:
    port: int
    directory: str
    host_key: str
    fingerprint: str
    identity: Path

    @classmethod
    def from_profile(cls, path):
        profile = configuration(path)
        if set(profile) != {"port", "repository", "hostKey"}:
            raise Failure("WINDOWS_PROFILE_INVALID")
        port, name, key = profile["port"], profile["repository"], profile["hostKey"]
        if type(port) is not int or not 1024 <= port <= 65535:
            raise Failure("WINDOWS_TUNNEL_PORT")
        if not isinstance(name, str) or not REPOSITORY_NAME.fullmatch(name):
            raise Failure("WINDOWS_REPOSITORY_PATH")
        identity = path.with_name("windows-tunnel-key")
        if not private_file(identity):
            raise Failure("WINDOWS_IDENTITY_PERMISSIONS")
        parent = path.parent.stat()
        if parent.st_uid != 0 or parent.st_mode & 0o022:
            raise Failure("WINDOWS_PROFILE_DIRECTORY")
        fingerprint = windows_host_key(key)
        # The pin is provisioned out of band. Also reject this host's standard key
        # if an operator mistakenly supplies it instead of the Windows key.
        local_public_key = Path("/etc/ssh/ssh_host_ed25519_key.pub")
        if local_public_key.is_file() and " ".join(local_public_key.read_text().split()[:2]) == key:
            raise Failure("WINDOWS_HOST_KEY_LOCAL")
        return cls(port, "/incoming/" + name, key, fingerprint, identity)

    @property
    def location(self):
        return f"sftp:{ALIAS}:{self.directory}"

    def verify_listener(self):
        listeners = command(["ss", "-H", "-ltn", f"sport = :{self.port}"], "WINDOWS_TUNNEL_LISTENER")
        endpoints = [line.split()[3] for line in listeners.decode().splitlines() if line.strip()]
        if endpoints != [f"127.0.0.1:{self.port}"]:
            raise Failure("WINDOWS_TUNNEL_LISTENER")

    def configure(self, staging, env):
        self.verify_listener()
        ssh_config = staging / "ssh.conf"
        known_hosts = staging / "known_hosts"
        for path in (ssh_config, known_hosts, self.identity):
            if not re.fullmatch(r"/[A-Za-z0-9/_.-]+", str(path)):
                raise Failure("WINDOWS_SSH_PATH")
        known_hosts.write_text(f"{HOST_KEY_ALIAS} {self.host_key}\n", encoding="ascii")
        expected = {
            "hostname": "127.0.0.1", "port": str(self.port), "user": RECEIVER,
            "addressfamily": "inet", "identityfile": str(self.identity),
            "identityagent": "none", "hostkeyalias": HOST_KEY_ALIAS,
            "hostkeyalgorithms": "ssh-ed25519", "userknownhostsfile": str(known_hosts),
            "globalknownhostsfile": "/dev/null", "preferredauthentications": "publickey",
            "connecttimeout": "10", "serveraliveinterval": "10", "serveralivecountmax": "2",
            "numberofpasswordprompts": "0",
        }
        switches = {
            "stricthostkeychecking": True, "identitiesonly": True, "batchmode": True,
            "pubkeyauthentication": True, "passwordauthentication": False,
            "kbdinteractiveauthentication": False, "forwardagent": False,
            "updatehostkeys": False, "canonicalizehostname": False, "permitlocalcommand": False,
            "hostbasedauthentication": False, "gssapiauthentication": False, "clearallforwardings": True,
        }
        lines = [f"Host {ALIAS}"]
        lines.extend(f"    {key} {value}" for key, value in expected.items())
        lines.extend(f"    {key} {'yes' if value else 'no'}" for key, value in switches.items())
        lines.extend(["    ProxyCommand none", "    ProxyJump none", "    ControlPath none", "    ControlMaster no"])
        ssh_config.write_text("\n".join(lines) + "\n", encoding="ascii")
        config = command(["ssh", "-G", "-F", str(ssh_config), ALIAS], "WINDOWS_SSH_PARAMETERS", env=env)
        effective = {}
        for line in config.decode().splitlines():
            if " " in line:
                key, value = line.split(" ", 1)
                effective.setdefault(key, []).append(value)
        if (any(effective.get(key) != [value] for key, value in expected.items())
                or any(effective.get(key) not in ([["yes"], ["true"]] if value else [["no"], ["false"]])
                       for key, value in switches.items())
                or effective.get("controlmaster") not in (["no"], ["false"])
                or any(effective.get(key) not in (None, ["none"])
                       for key in ("proxycommand", "proxyjump", "controlpath"))
                or any(key in effective for key in ("localforward", "remoteforward", "dynamicforward", "remotecommand"))):
            raise Failure("WINDOWS_SSH_PARAMETERS")
        sftp = ["sftp", "-F", str(ssh_config), "-b", "-", ALIAS]
        # SFTP uses the same generated configuration and the same pinned peer as Restic.
        command(sftp, "WINDOWS_SFTP_AUTH", input=b"cd /incoming\npwd\n", env=env)
        restic = "sftp.command=" + shlex.join(["ssh", "-F", str(ssh_config), "-s", ALIAS, "sftp"])
        return sftp, restic


def local_windows_repository(path):
    if (not path.is_absolute() or not REPOSITORY_NAME.fullmatch(path.name)
            or path.resolve(strict=True) != path or not path.is_dir()
            or not (path / "config").is_file() or (path / "config").is_symlink()):
        raise Failure("WINDOWS_LOCAL_REPOSITORY_PATH")
    return str(path)
