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
if ((Test-Path -LiteralPath $partial) -or (Test-Path -LiteralPath $final) -or
    (Test-Path -LiteralPath $passwordFile)) { throw 'A local backup destination already exists' }
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
$meta = [Text.Encoding]::UTF8.GetString($receipt) | ConvertFrom-Json -AsHashtable
if ($meta.format -ne 1 -or $meta.run -cne $Run -or $meta.releaseSha -cne $ReleaseSha -or
    $meta.operationsArchiveSha256 -cne $OperationsArchiveSha256 -or $meta.repository -cne $repository -or
    $meta.migrationCount -ne 14 -or $meta.tableCount -ne 14 -or $meta.triggerCount -ne 10 -or
    $meta.files -isnot [System.Collections.IDictionary] -or !$meta.files.Contains('config') -or
    (@($meta.snapshotIds.Keys | Sort-Object) -join ',') -cne 'database,images,manifest') {
    throw 'Server did not supply the approved completion manifest'
}
$resticPath = '\A(?:config|(?:data/[0-9a-f]{2}|index|keys|snapshots)/[0-9a-f]{64})\z'
foreach ($item in $meta.files.GetEnumerator()) {
    if ($item.Key -cnotmatch $resticPath -or $item.Value -cnotmatch '\A[0-9a-f]{64}\z') {
        throw 'Invalid repository checksum manifest entry'
    }
}
foreach ($snapshotId in $meta.snapshotIds.Values) {
    if ($snapshotId -cnotmatch '\A[0-9a-f]{64}\z' -or !$meta.files.Contains("snapshots/$snapshotId")) {
        throw 'Expected Restic snapshot file not listed'
    }
}

$null = New-Item -Path $partial -ItemType Directory
$seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$receiptHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($receipt)).ToLowerInvariant()
Read-RemoteStream "sudo -n /usr/bin/tar --format=ustar -C '$remote' -cf - '$repository' transfer.json" {
    param([IO.Stream]$Stream)
    $reader = [System.Formats.Tar.TarReader]::new($Stream, $true)
    try {
        while ($null -ne ($entry = $reader.GetNextEntry())) {
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
                $expected = $receiptHash
            } elseif ($path.StartsWith("$repository/", [StringComparison]::Ordinal)) {
                $relative = $path.Substring($repository.Length + 1)
                if ($relative -cnotmatch $resticPath -or !$meta.files.Contains($relative)) {
                    throw 'Archive contains an unlisted repository file'
                }
                $expected = $meta.files[$relative]
            } else { throw 'Unexpected archive path' }
            $destination = Join-Path $partial $path
            $file = [IO.File]::Open($destination, 'CreateNew', 'Write', 'None')
            try { $entry.DataStream.CopyTo($file) } finally { $file.Dispose() }
            if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expected) {
                throw 'VPS and Windows SHA-256 differ'
            }
        }
        $Stream.CopyTo([IO.Stream]::Null)
    } finally { $reader.Dispose() }
}
if ($seen.Count -ne $meta.files.Count + 1 -or !$seen.Contains('transfer.json')) {
    throw 'Incomplete local repository'
}

# Transfer the key separately, using the already authenticated SSH session profile.
# DPAPI CurrentUser keeps the independently stored key usable by this Windows account.
[byte[]]$key = Read-RemoteBytes "$remote/restic-password" 128
try {
    if ($key.Length -ne 65 -or $key[64] -ne 10 -or @($key[0..63] | Where-Object {
        $_ -notin (45, 95) -and ($_ -lt 48 -or $_ -gt 57) -and
        ($_ -lt 65 -or $_ -gt 90) -and ($_ -lt 97 -or $_ -gt 122)
    }).Count -ne 0) { throw 'Unexpected recovery key format' }
    $encrypted = [Security.Cryptography.ProtectedData]::Protect(
        $key, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    $verified = [Security.Cryptography.ProtectedData]::Unprotect(
        $encrypted, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    try {
        if (!([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($key)) -ceq
            [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($verified)))) {
            throw 'Recovery key encryption round trip failed'
        }
    } finally { [Array]::Clear($verified) }
    $file = [IO.File]::Open($passwordFile, 'CreateNew', 'Write', 'None')
    try { $file.Write($encrypted, 0, $encrypted.Length) } finally { $file.Dispose() }
} finally { [Array]::Clear($key) }

[IO.Directory]::Move($partial, $final)
[ordered]@{ mode = 'execute'; run = $Run; destination = $final
    repositoryFiles = $meta.files.Count; keyFile = $passwordFile } | ConvertTo-Json -Compress
