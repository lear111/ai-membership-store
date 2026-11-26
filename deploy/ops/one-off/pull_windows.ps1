[CmdletBinding(DefaultParameterSetName = 'dry')]
param(
    [Parameter(Mandatory, ParameterSetName = 'dry')][switch]$DryRun,
    [Parameter(Mandatory, ParameterSetName = 'execute')][switch]$Execute,
    [Parameter(Mandatory)][ValidatePattern('\A[0-9a-f]{32}\z')][string]$Run,
    [Parameter(Mandatory)][ValidatePattern('\A[a-zA-Z0-9][a-zA-Z0-9._-]*\z')][string]$SshHost,
    [Parameter(Mandatory)][string]$ExpectedWindowsUser,
    [Parameter(Mandatory)][ValidatePattern('\A[0-9a-f]{40}\z')][string]$ReleaseSha,
    [Parameter(Mandatory)][ValidatePattern('\A[0-9a-f]{64}\z')][string]$OperationsArchiveSha256,
    [Parameter(Mandatory)][ValidatePattern('\A/(?:[A-Za-z0-9._-]+/)*[A-Za-z0-9._-]+\z')][string]$VpsBackupRoot,
    [Parameter(Mandatory)][string]$WindowsBackupRoot,
    [Parameter(Mandatory)][string]$WindowsKeyDirectory,
    [Parameter(Mandatory)][string]$EscrowCertificatePath,
    [Parameter(Mandatory)][ValidatePattern('\A[0-9a-f]{64}\z')][string]$EscrowCertificateSha256,
    [Parameter(Mandatory)][string]$WindowsEscrowDirectory,
    [Net.IPAddress]$BindAddress
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (($VpsBackupRoot.Split('/') | Where-Object { $_ -in @('.', '..') })) {
    throw 'Unexpected VPS backup path'
}
$remote = "$VpsBackupRoot/membership-local-$Run"
$repository = "membership-$Run"
$name = "membership-local-$Run"
$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if ($identity.Identity.Name -ne $ExpectedWindowsUser) { throw 'Use the approved Windows SSH user profile' }
$elevated = $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (!$elevated) { throw 'Use the approved elevated Windows account for the private destination' }
if ($null -ne $BindAddress -and $BindAddress.AddressFamily -ne 'InterNetwork') {
    throw 'SSH binding requires an IPv4 address'
}

function Read-RemoteStream([string]$Command, [scriptblock]$Read) {
    $arguments = @('-4')
    if ($null -ne $BindAddress) { $arguments += @('-b', $BindAddress.ToString()) }
    $arguments += @('-T', '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=yes', '-o', 'ClearAllForwardings=yes',
        '-o', 'ConnectTimeout=12', '-o', 'ServerAliveInterval=15',
        '-o', 'ServerAliveCountMax=2', $SshHost, $Command)
    $ssh = Join-Path $env:SystemRoot 'System32\OpenSSH\ssh.exe'
    $info = [Diagnostics.ProcessStartInfo]::new($ssh)
    foreach ($arg in $arguments) { $info.ArgumentList.Add($arg) }
    $info.UseShellExecute = $false
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($info)
    try {
        $stderr = $process.StandardError.ReadToEndAsync()
        & $Read $process.StandardOutput.BaseStream
        $process.WaitForExit()
        $null = $stderr.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw "Verified SSH read failed, exit $($process.ExitCode)" }
    } finally {
        if (!$process.HasExited) { $process.Kill() }
        $process.Dispose()
    }
}

function Read-RemoteBytes([string]$RemoteFile, [int]$Limit) {
    Read-RemoteStream "sudo -n /usr/bin/cat -- '$RemoteFile'" {
        param([IO.Stream]$Stream)
        $memory = [IO.MemoryStream]::new()
        try {
            $chunk = [byte[]]::new(4096)
            while (($count = $Stream.Read($chunk, 0, $chunk.Length)) -gt 0) {
                if ($memory.Length + $count -gt $Limit) { throw 'Unexpected control-file size' }
                $memory.Write($chunk, 0, $count)
            }
            , $memory.ToArray()
        } finally {
            [Array]::Clear($chunk)
            [Array]::Clear($memory.GetBuffer())
            $memory.Dispose()
        }
    }
}

function Get-LocalDirectory([string]$Path) {
    if ($Path -notmatch '\A[A-Za-z]:[\\/]' -or $Path.Substring(2).Contains(':') -or
        ($Path -split '[\\/]' | Where-Object { $_ -in @('.', '..') })) {
        throw 'Use an absolute local drive path without dot components'
    }
    $directory = Get-Item -LiteralPath ([IO.Path]::GetFullPath($Path)) -Force
    if (!$directory.PSIsContainer) { throw 'Unexpected local destination' }
    for ($ancestor = $directory; $null -ne $ancestor; $ancestor = $ancestor.Parent) {
        if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw 'Backup and key paths must stay on their local volume'
        }
    }
    $directory
}

function Test-RepositoryFilePath([string]$Path) {
    $Path -cmatch '\A(?:config|(?:data/[0-9a-f]{2}|index|keys|snapshots)/[0-9a-f]{64})\z'
}

function Read-TransferManifest([byte[]]$Receipt, [string]$Run, [string]$ReleaseSha,
    [string]$OperationsArchiveSha256, [string]$Repository) {
    $meta = [Text.Encoding]::UTF8.GetString($Receipt) | ConvertFrom-Json -AsHashtable
    if ($meta.format -ne 2 -or $meta.run -cne $Run -or $meta.releaseSha -cne $ReleaseSha -or
        $meta.operationsArchiveSha256 -cne $OperationsArchiveSha256 -or $meta.repository -cne $repository -or
        $meta.migrationCount -ne 14 -or $meta.tableCount -ne 14 -or $meta.triggerCount -ne 10 -or
        $meta.files -isnot [System.Collections.IDictionary] -or !$meta.files.Contains('config') -or
        (@($meta.snapshotIds.Keys | Sort-Object) -join ',') -cne 'database,images,manifest') {
        throw 'Server did not supply the approved completion manifest'
    }
    [decimal]$total = 0
    foreach ($item in $meta.files.GetEnumerator()) {
        $file = $item.Value
        if (!(Test-RepositoryFilePath $item.Key) -or $file -isnot [System.Collections.IDictionary] -or
            $file.sha256 -isnot [string] -or $file.sha256 -cnotmatch '\A[0-9a-f]{64}\z' -or
            $file.bytes -isnot [long] -or $file.bytes -le 0) {
            throw 'Invalid repository checksum manifest entry'
        }
        $total += $file.bytes
    }
    if ($meta.repositoryBytes -isnot [long] -or $meta.repositoryBytes -le 0 -or
        $meta.repositoryBytes -ne $total) { throw 'Repository byte total differs from file inventory' }
    foreach ($snapshotId in $meta.snapshotIds.Values) {
        if ($snapshotId -isnot [string] -or $snapshotId -cnotmatch '\A[0-9a-f]{64}\z' -or
            !$meta.files.Contains("snapshots/$snapshotId")) { throw 'Expected Restic snapshot file not listed' }
    }
    $meta
}

function Assert-TransferSpace([long]$Available, [long]$RepositoryBytes, [long]$ReceiptBytes, [int]$FileCount) {
    $reserve = [Math]::Max([decimal](64MB), [Math]::Ceiling([decimal]$RepositoryBytes / 10))
    $required = [decimal]$RepositoryBytes + $ReceiptBytes + (64KB * [long]($FileCount + 1)) + $reserve
    if ($Available -lt $required) { throw 'Insufficient free space on the Windows backup volume' }
}

function Receive-Repository([IO.Stream]$Stream, [string]$Partial, [string]$Repository,
    [System.Collections.IDictionary]$Meta, [byte[]]$Receipt) {
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $receiptHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Receipt)).ToLowerInvariant()
    $reader = [System.Formats.Tar.TarReader]::new($Stream, $true)
    try {
        while ($null -ne ($entry = $reader.GetNextEntry())) {
            if ($entry.Format -ne 'Ustar') { throw 'Unexpected repository archive format' }
            $path = $entry.Name.TrimEnd('/')
            if ($entry.EntryType -eq 'Directory') {
                if ($path -cnotmatch "\A$repository(?:/(?:index|keys|locks|snapshots|data(?:/[0-9a-f]{2})?))?\z") {
                    throw 'Unexpected repository directory'
                }
                $null = [IO.Directory]::CreateDirectory((Join-Path $partial $path))
                continue
            }
            if ($entry.EntryType -ne 'RegularFile' -or !$seen.Add($path)) {
                throw 'Unexpected archive entry type or duplicate'
            }
            if ($path -ceq 'transfer.json') {
                $expectedHash = $receiptHash
                $expectedLength = $Receipt.LongLength
            } elseif ($path.StartsWith("$repository/", [StringComparison]::Ordinal)) {
                $relative = $path.Substring($repository.Length + 1)
                if (!(Test-RepositoryFilePath $relative) -or !$meta.files.Contains($relative)) {
                    throw 'Archive contains an unlisted repository file'
                }
                $expectedHash = $Meta.files[$relative].sha256
                $expectedLength = $Meta.files[$relative].bytes
            } else { throw 'Unexpected archive path' }
            if ($entry.Length -ne $expectedLength) { throw 'Archive entry length differs from manifest' }
            $destination = Join-Path $Partial $path
            $file = [IO.File]::Open($destination, 'CreateNew', 'Write', 'None')
            try { $entry.DataStream.CopyTo($file) } finally { $file.Dispose() }
            if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expectedHash) {
                throw 'VPS and Windows SHA-256 differ'
            }
        }
        $Stream.CopyTo([IO.Stream]::Null)
    } finally { $reader.Dispose() }
    if ($seen.Count -ne $Meta.files.Count + 1 -or !$seen.Contains('transfer.json')) {
        throw 'Incomplete local repository'
    }
}

function Protect-LocalRecoveryKey([byte[]]$Key) {
    $encrypted = [Security.Cryptography.ProtectedData]::Protect(
        $Key, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    $verified = [Security.Cryptography.ProtectedData]::Unprotect(
        $encrypted, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    try {
        if (!([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Key)) -ceq
            [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($verified)))) {
            throw 'Recovery key encryption round trip failed'
        }
    } finally { [Array]::Clear($verified) }
    , $encrypted
}

function Read-EscrowCertificate([string]$Path, [string]$ExpectedSha256) {
    $file = Get-Item -LiteralPath $Path
    if ($file.PSIsContainer -or $file.Length -gt 64KB) { throw 'Expected a public DER certificate' }
    $bytes = [IO.File]::ReadAllBytes($file.FullName)
    if ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant() -cne $ExpectedSha256) {
        throw 'Escrow certificate SHA-256 differs from the approved fingerprint'
    }
    $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($bytes, [string]$null,
        [Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet)
    $rsa = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPublicKey($certificate)
    try {
        if ($certificate.HasPrivateKey -or !([Convert]::ToHexString($certificate.RawData) -ceq [Convert]::ToHexString($bytes)) -or
            $null -eq $rsa -or $rsa.KeySize -lt 3072) { throw 'Expected a public RSA DER certificate (3072+ bits)' }
        $certificate
    } catch {
        $certificate.Dispose()
        throw
    } finally {
        if ($null -ne $rsa) { $rsa.Dispose() }
    }
}

function Protect-EscrowRecoveryKey([byte[]]$Key, [Security.Cryptography.X509Certificates.X509Certificate2]$Certificate) {
    $content = [Security.Cryptography.Pkcs.ContentInfo]::new($Key)
    $algorithm = [Security.Cryptography.Pkcs.AlgorithmIdentifier]::new(
        [Security.Cryptography.Oid]::new('2.16.840.1.101.3.4.1.42')) # AES-256-CBC, CMS content encryption
    $recipient = [Security.Cryptography.Pkcs.CmsRecipient]::new(
        [Security.Cryptography.Pkcs.SubjectIdentifierType]::IssuerAndSerialNumber,
        $Certificate, [Security.Cryptography.RSAEncryptionPadding]::OaepSHA256)
    $message = [Security.Cryptography.Pkcs.EnvelopedCms]::new($content, $algorithm)
    $message.Encrypt($recipient)
    , $message.Encode()
}

function Write-NewPrivateArtifact([string]$Path, [byte[]]$Content) {
    $file = [IO.File]::Open($Path, 'CreateNew', 'Write', 'None')
    try { $file.Write($Content, 0, $Content.Length); $file.Flush($true) } finally { $file.Dispose() }
}

$base = (Get-LocalDirectory $WindowsBackupRoot).FullName
$rootAcl = Get-Acl -LiteralPath $base
$rootRules = $rootAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
$inheritable = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
if (!$rootAcl.AreAccessRulesProtected -or @($rootRules | Where-Object {
    $_.AccessControlType -ne 'Allow' -or
    ($_.IdentityReference.Value -notin @('S-1-5-18', 'S-1-5-32-544') -and
        ($_.InheritanceFlags -ne 'None' -or
         $_.FileSystemRights -ne 'ReadAndExecute, Synchronize'))
}).Count -ne 0 -or @($rootRules | Where-Object {
    $_.IdentityReference.Value -in @('S-1-5-18', 'S-1-5-32-544') -and
    $_.FileSystemRights -eq 'FullControl' -and $_.InheritanceFlags -eq $inheritable -and
    $_.PropagationFlags -eq 'None'
}).Count -ne 2) { throw 'Windows backup ACL differs from the verified protected root' }

$partial = Join-Path $base "$name.partial"
$final = Join-Path $base $name
$keyBase = (Get-LocalDirectory $WindowsKeyDirectory).FullName
$profileRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData).TrimEnd('\') + '\'
if (!$keyBase.StartsWith($profileRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Use a private key directory under this Windows account''s Local AppData'
}
$passwordFile = Join-Path $keyBase "$name.restic-key.dpapi"
$escrowBase = (Get-LocalDirectory $WindowsEscrowDirectory).FullName
if ([IO.Path]::GetPathRoot($base) -eq [IO.Path]::GetPathRoot($escrowBase) -or
    [IO.Path]::GetPathRoot($keyBase) -eq [IO.Path]::GetPathRoot($escrowBase)) {
    throw 'Place escrow on a volume separate from the backup and Windows profile'
}
$escrowFile = Join-Path $escrowBase "$name.restic-key.p7m"
(Read-EscrowCertificate $EscrowCertificatePath $EscrowCertificateSha256).Dispose()
if ((Test-Path -LiteralPath $partial) -or (Test-Path -LiteralPath $final) -or
    (Test-Path -LiteralPath $passwordFile) -or (Test-Path -LiteralPath $escrowFile)) { throw 'A local backup destination already exists' }
if ($DryRun) {
    Read-RemoteStream 'sudo -n /usr/bin/tar --format=ustar -C /opt/ai-membership-store/current -cf - release.json' {
        param([IO.Stream]$Stream)
        $reader = [System.Formats.Tar.TarReader]::new($Stream, $true)
        try {
            $entry = $reader.GetNextEntry()
            if ($null -eq $entry -or $entry.Name -cne 'release.json' -or $entry.Length -gt 1MB) {
                throw 'Unexpected read-only SSH probe payload'
            }
            $metadata = [Text.Json.JsonDocument]::Parse($entry.DataStream)
            try {
                if ($metadata.RootElement.GetProperty('gitSha').GetString() -cne $ReleaseSha) {
                    throw 'Remote release differs from approved source'
                }
            } finally { $metadata.Dispose() }
            if ($null -ne $reader.GetNextEntry()) { throw 'Unexpected extra SSH probe data' }
            $Stream.CopyTo([IO.Stream]::Null)
        } finally { $reader.Dispose() }
    }
    [ordered]@{ mode = 'dry-run'; alias = $SshHost
        elevated = $elevated; source = $BindAddress; release = $ReleaseSha; target = $base
        remoteRootRead = 'non-secret runtime manifest streamed and parsed'
    } | ConvertTo-Json -Compress
    return
}

[byte[]]$receipt = Read-RemoteBytes "$remote/transfer.json" 32MB
$meta = Read-TransferManifest $receipt $Run $ReleaseSha $OperationsArchiveSha256 $repository
$volume = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($base))
Assert-TransferSpace $volume.AvailableFreeSpace $meta.repositoryBytes $receipt.LongLength $meta.files.Count
$null = New-Item -Path $partial -ItemType Directory
Read-RemoteStream "sudo -n /usr/bin/tar --format=ustar -C '$remote' -cf - '$repository' transfer.json" {
    param([IO.Stream]$Stream)
    Receive-Repository $Stream $partial $repository $meta $receipt
}

# Transfer the key separately, using the already authenticated SSH session profile.
# DPAPI CurrentUser keeps the independently stored key usable by this Windows account.
[byte[]]$key = Read-RemoteBytes "$remote/restic-password" 128
try {
    if ($key.Length -ne 65 -or $key[64] -ne 10 -or @($key[0..63] | Where-Object {
        $_ -notin (45, 95) -and ($_ -lt 48 -or $_ -gt 57) -and
        ($_ -lt 65 -or $_ -gt 90) -and ($_ -lt 97 -or $_ -gt 122)
    }).Count -ne 0) { throw 'Unexpected recovery key format' }
    [byte[]]$encrypted = Protect-LocalRecoveryKey $key
    $certificate = Read-EscrowCertificate $EscrowCertificatePath $EscrowCertificateSha256
    try {
        [byte[]]$escrow = Protect-EscrowRecoveryKey $key $certificate
        Write-NewPrivateArtifact $escrowFile $escrow
        $stored = [IO.File]::ReadAllBytes($escrowFile)
        if (!([Convert]::ToHexString($escrow) -ceq [Convert]::ToHexString($stored))) {
            throw 'Escrow file readback failed'
        }
    } finally { $certificate.Dispose() }
    Write-NewPrivateArtifact $passwordFile $encrypted
} finally { [Array]::Clear($key) }

[IO.Directory]::Move($partial, $final)
[ordered]@{ mode = 'execute'; run = $Run; destination = $final
    repositoryFiles = $meta.files.Count; repositoryBytes = $meta.repositoryBytes
    keyFile = $passwordFile; escrowFile = $escrowFile } | ConvertTo-Json -Compress
