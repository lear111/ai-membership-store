# T27.5 一次性 VPS 本地加密备份

在经批准的维护窗口内，从生产 MySQL 和两类图片建立一个新的加密恢复点。VPS 先完成校验，Windows 再通过现有 SSH 管理连接主动拉取。两端各保留一份完整仓库，各自保管恢复密码。周期备份和监控仍按 [T23.3](33-production-backup-and-monitoring.md) 管理。数据库恢复和发布放行遵循 [T27](36-t27-batch-release.md)。

## 前置条件

- 操作员已获得本次生产停写、发放短时数据库权限和真实备份的单独授权。维护入口应返回 HTTPS 503，API 和 worker 应正常停止，其他写入方及发布切换应在维护窗口内冻结。
- 使用经过独立核验的**原始** operations 归档、已审查的备份驱动和 Restic 0.20.0 Linux amd64 二进制。配置必须与已批准的生产主机、历史运行版本、14 条迁移和当前 Docker 容器匹配。原始归档缺失时应暂停并报告。
- 生产 MySQL 已加入专用内部备份网络，Compose 中已有短时 client。脚本核验镜像、容器、卷、回环发布、内网网段及其他连接，使用仓库现有的生产 Compose 布局。
- Windows 使用提升权限的指定用户、PowerShell 7.4 或以上及系统 OpenSSH。SSH 别名应指定审核过的远程用户，并使用已验明的主机密钥和已授权的 sudo 读取权限。SSH 转发显式关闭，传输由 Windows 主动发起。
- 备份前确认 VPS 的源数据和完整仓库副本所需空间，以及 Windows 的独立副本空间。预先准备 Windows 备份目录、当前用户的密码目录及独立托管卷。备份根目录的 ACL 应关闭继承，并仅向 SYSTEM 和 Administrators 授予可继承完全控制权限。其他身份至多拥有作用于根目录自身的读取和遍历权限。密码目录应在当前用户的私有 Local AppData 子目录下。

## 配置

在 VPS 上使用绝对路径指向独立的 root:root、0600 JSON 配置。示例中尖括号内的值均由操作者从独立审核的记录中填入。配置与真实 dry-run 输出存放在私有运维目录，保留在 Git 之外。

~~~json
{
  "expected_hostname": "<VPS hostname>",
  "maintenance_hostname": "<maintenance HTTPS DNS name>",
  "release_sha": "<approved 40-character release SHA>",
  "operations_archive": "/opt/example/archives/operations.tar.gz",
  "operations_sha256": "<independently verified operations archive SHA-256>",
  "driver_directory": "/opt/example/verified-driver/deploy",
  "driver_sha256": {
    "ops/backup.py": "<verified SHA-256>",
    "ops/common.py": "<verified SHA-256>",
    "ops/windows_backup.py": "<verified SHA-256>",
    "mysql/compose.yaml": "<verified SHA-256>",
    "mysql/backup.compose.yaml": "<verified SHA-256>"
  },
  "restic_binary": "/opt/example/restic",
  "restic_sha256": "<verified SHA-256>",
  "backup_root": "/var/backups",
  "mysql_container_id": "<approved full Docker container ID>",
  "backup_subnet": "<approved private IPv4 CIDR>"
}
~~~

配置路径、归档、驱动、Restic 和备份根目录均经过属主、可写权限和真实路径检查。请为仓库选择独立于数据库持久卷、应用发布目录和图片源目录的根目录。Windows 的参数需要提供相同的 VPS 仓库根目录、发布 SHA 和 operations 摘要。需要固定出口时，指定已验明的本机 IPv4 地址。

## 执行顺序

从仓库根目录运行。下面的地址和目录为示例，按已审核现场替换。两个脚本共用同一个运行 ID。保留 VPS 和 Windows dry-run 结果以供核对。

~~~powershell
$ssh = Join-Path $env:SystemRoot 'System32\OpenSSH\ssh.exe'
$sshHost = 'approved-vps'
$run = [guid]::NewGuid().ToString('N')
$source = Get-Content -Raw -LiteralPath deploy/ops/one-off/backup_vps_local.py
$sshArgs = @('-4', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ClearAllForwardings=yes', '-o', 'ConnectTimeout=12')
$pull = @{
    Run = $run
    SshHost = $sshHost
    ExpectedWindowsUser = '<approved Windows identity>'
    ReleaseSha = '<approved release SHA>'
    OperationsArchiveSha256 = '<independently verified operations archive SHA-256>'
    VpsBackupRoot = '/var/backups'
    WindowsBackupRoot = 'D:\PrivateBackups'
    WindowsKeyDirectory = Join-Path $env:LOCALAPPDATA 'PrivateBackupKeys'
    WindowsEscrowDirectory = 'E:\OfflineEscrow'
    EscrowCertificatePath = 'D:\ApprovedPublicCertificates\escrow-public.cer'
    EscrowCertificateSha256 = '<independently verified public DER SHA-256>'
}
# If the connection requires a local IPv4 bind, add -b to $sshArgs and BindAddress to $pull.
$sshArgs += $sshHost
$vpsConfig = '/etc/ai-membership-store/t27-5-local.json'

$source | & $ssh @sshArgs "sudo -n python3 -I -B - --config '$vpsConfig' --dry-run --run $run"
if ($LASTEXITCODE -ne 0) { throw 'VPS dry-run failed' }
& ./deploy/ops/one-off/pull_windows.ps1 -DryRun @pull

# Run these commands only after the operator authorizes the real production backup.
$source | & $ssh @sshArgs "sudo -n python3 -I -B - --config '$vpsConfig' --execute --run $run"
if ($LASTEXITCODE -ne 0) { throw 'VPS backup failed. Preserve evidence and stop.' }
& ./deploy/ops/one-off/pull_windows.ps1 -Execute @pull
~~~

## 数据流与验收

1. VPS 在仓库操作锁内复核运行版本、归档、迁移校验和、表数量、触发器、业务行数和图片引用。创建暂存目录前，按 MySQL 表和索引分配字节的四倍，加图片实际字节与 1 GiB 安全余量校验空间。最终核对仓库的实际字节数和剩余余量。它为本次运行创建独立的 0700 暂存目录和加密仓库。
2. 临时 MySQL 账号限定在已核验的内部网段，要求 TLS。授权范围为目标 schema 的 SELECT 和 Order、OrderRevision 的 TRIGGER。两张表的 TRIGGER 权限允许操作这两张表的触发器，应纳入本次审批。脚本核对实际权限、连接身份和 TLS，将临时凭据保存在 0600 文件中，在数据库快照完成或失败后撤销账号、验证其消失并移除本次创建的凭据文件。
3. 现有 Compose backup-client 使用 --no-deps、--pull never 和正式驱动定义的 DUMP 参数。mysqldump 的标准输出通过 Restic 的 --stdin-from-command 进入加密快照，database.sql 是快照内的逻辑文件名。扫码图片和商品封面写入配对的图片快照。
4. 私有清单记录同一运行的发布版本、归档 SHA-256、迁移、表、触发器和各快照 ID。VPS 重读清单，运行 restic check --read-data，计算每个仓库文件的 SHA-256。通过所有复核后才将 .partial 改名为可拉取的完成目录。
5. Windows 读取清单，核对仓库总字节数与逐文件长度之和。创建 .partial 前确认目标卷有足够空间容纳仓库、清单、每文件 64 KiB 开销及至少 64 MiB 或仓库大小 10% 的余量，取较大者。随后通过 SSH 和 tar 完整复制加密仓库，核对快照 ID、归档路径、文件集合、每个文件的长度和 SHA-256。逐文件校验和独立密码保管均成功后才将本地 .partial 改名为完成目录。
6. VPS 恢复密码单独保存在仓库外的 0600 文件。Windows 通过同一 SSH 连接单独读取密码，以当前用户的 DPAPI 加密并验证可解密后保存到指定密码目录。同一密码同时使用已核验的公开证书加密为 CMS 密文，写入独立托管卷。私钥只由离线保管方持有。

## 恢复密码独立托管与取回

1. 在独立离线设备上使用 OpenSSL 生成托管密钥和公开证书。OpenSSL 交互提示密钥保护口令。通过获批的密码管理器或另一份离线记录保存该口令。

~~~bash
umask 077
openssl req -x509 -newkey rsa:3072 -sha256 -days 3650 \
  -subj '/CN=T27.5 recovery escrow/' -keyout escrow-private.pem -out escrow-public.pem
openssl x509 -in escrow-public.pem -outform DER -out escrow-public.cer
sha256sum escrow-public.cer
~~~

2. 私钥和证书 PEM 保留在离线保管介质。向 Windows 提供公开 DER 证书及通过独立渠道核验的 SHA-256。将独立托管卷挂载为本地卷，在执行参数中提供托管目录。完成后按运行 ID 取得 .restic-key.p7m 文件，并卸载托管卷。记录运行 ID、公开证书摘要及密文文件摘要。
3. 在独立恢复设备上使用离线保管的私钥和证书。只读挂载验证用仓库，清除常规 Restic 密码环境变量。将 CMS 解密输出直接连接到 Restic 的密码文件接口。该命令须在关闭 shell 跟踪的 Bash 中运行，私钥口令从终端交互输入。

~~~bash
set +x
set -o pipefail
openssl cms -decrypt -binary -inform DER -in '/media/escrow/membership-local-RUN.restic-key.p7m' \
  -recip '/media/keys/escrow-public.pem' -inkey '/media/keys/escrow-private.pem' |
  env -u RESTIC_PASSWORD -u RESTIC_PASSWORD_FILE -u RESTIC_PASSWORD_COMMAND \
    restic --repo '/mnt/repository/membership-RUN' --password-file /dev/stdin \
    --no-lock --no-cache check --read-data
~~~

4. 记录两端退出状态、运行 ID 和仓库检查结果。解密输出只在管道中交给 Restic。随后按配对恢复流程进行隔离恢复，复核迁移、触发器、业务行数及图片引用。

## 失败与恢复

失败时保留 VPS 数据、Windows 暂存目录和脱敏证据。VPS 只可能撤回本次新发布的 manifest 标签所对应的快照。发生宿主机中断或数据库权限回收失败时，由操作员根据运行 ID 确认本次临时账号和凭据的状态，保持维护并处理残留物。旧仓库、先前失败的传输现场及数据库卷继续保留。

迁移放行前，应按 [配对备份恢复流程](33-production-backup-and-monitoring.md) 从独立副本以只读方式操作仓库，恢复到隔离数据库和图片目录，并核对迁移、触发器、业务行数及图片引用。完成 T27 指定的隔离升级演练后，等待生产迁移与发布的单独批准。

本 PR 交付一次性工具和运行说明。合成数据覆盖本地 Restic、流式备份与中断处理、Windows USTAR、DPAPI 和独立托管。真实生产备份与恢复由获批的维护操作记录。
