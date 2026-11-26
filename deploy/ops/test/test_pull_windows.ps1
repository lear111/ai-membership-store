param([string]$PortableFixture)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$script = Join-Path $PSScriptRoot '../one-off/pull_windows.ps1'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($script, [ref]$null, [ref]($parseErrors = @()))
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
# Load the same transfer functions without running the SSH entry point.
foreach ($definition in $ast.EndBlock.Statements.Where({
    $_ -is [System.Management.Automation.Language.FunctionDefinitionAst]
})) {
    . ([scriptblock]::Create($definition.Extent.Text))
}

function Test-Rejection([scriptblock]$Action, [string]$Message) {
    try { & $Action } catch {
        if ($_.Exception.Message -ne $Message) { throw }
        return
    }
    throw "Expected rejection: $Message"
}

function Get-Digest([byte[]]$Bytes) {
    [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()
}

function Get-ReceiptBytes($Manifest) {
    , [Text.Encoding]::UTF8.GetBytes(($Manifest | ConvertTo-Json -Depth 8 -Compress))
}

function New-Ustar($Members) {
    $stream = [IO.MemoryStream]::new()
    $writer = [System.Formats.Tar.TarWriter]::new($stream, [System.Formats.Tar.TarEntryFormat]::Ustar, $true)
    try {
        foreach ($member in $Members.GetEnumerator()) {
            $type = if ($null -eq $member.Value) { 'Directory' } else { 'RegularFile' }
            $entry = [System.Formats.Tar.UstarTarEntry]::new($type, $member.Key)
            if ($null -eq $member.Value) { $writer.WriteEntry($entry); continue }
            $entry.DataStream = [IO.MemoryStream]::new($member.Value, $false)
            try { $writer.WriteEntry($entry) } finally { $entry.DataStream.Dispose() }
        }
    } finally { $writer.Dispose() }
    $stream.Position = 0
    , $stream
}

$root = Join-Path ([IO.Path]::GetTempPath()) "membership-transfer-test-$([guid]::NewGuid().ToString('N'))"
$null = [IO.Directory]::CreateDirectory($root)
try {
    $runId = 'a' * 32
    $release = 'b' * 40
    $archiveHash = 'c' * 64
    $repo = "membership-$runId"
    $config = [Text.Encoding]::UTF8.GetBytes('synthetic restic config')
    $file = [ordered]@{ sha256 = Get-Digest $config; bytes = $config.LongLength }
    $snapshots = [ordered]@{ database = 'a' * 64; images = 'b' * 64; manifest = 'c' * 64 }
    $manifest = [ordered]@{ format = 2; run = $runId; releaseSha = $release
        operationsArchiveSha256 = $archiveHash; repository = $repo; migrationCount = 14; tableCount = 14
        triggerCount = 10; snapshotIds = $snapshots; files = [ordered]@{ config = $file }
        repositoryBytes = $config.LongLength * 4 }
    foreach ($id in $snapshots.Values) { $manifest.files["snapshots/$id"] = $file }
    $receipt = Get-ReceiptBytes $manifest
    $metadata = Read-TransferManifest $receipt $runId $release $archiveHash $repo
    Assert-TransferSpace 100MB $metadata.repositoryBytes $receipt.LongLength $metadata.files.Count
    Test-Rejection { Assert-TransferSpace 64MB $metadata.repositoryBytes $receipt.LongLength $metadata.files.Count } 'Insufficient free space on the Windows backup volume'

    $manifest.repositoryBytes--
    Test-Rejection { Read-TransferManifest (Get-ReceiptBytes $manifest) $runId $release $archiveHash $repo } 'Repository byte total differs from file inventory'
    $manifest.repositoryBytes++

    $members = [ordered]@{}
    $members[$repo] = $null
    $members["$repo/snapshots"] = $null
    $members["$repo/config"] = $config
    foreach ($id in $snapshots.Values) { $members["$repo/snapshots/$id"] = $config }
    $members['transfer.json'] = $receipt

    function Test-Archive($Members, [string]$Name, [string]$Failure) {
        $destination = Join-Path $root $Name
        $null = [IO.Directory]::CreateDirectory($destination)
        $stream = New-Ustar $Members
        try {
            if ($Failure) {
                Test-Rejection { Receive-Repository $stream $destination $repo $metadata $receipt } $Failure
                if (!(Test-Path -LiteralPath $destination)) { throw 'Partial evidence was lost' }
            } else {
                Receive-Repository $stream $destination $repo $metadata $receipt
                if ((Get-FileHash -LiteralPath (Join-Path $destination "$repo/config")).Hash.ToLowerInvariant() -cne $file.sha256) {
                    throw 'Verified fixture file was not copied'
                }
            }
        } finally { $stream.Dispose() }
    }

    Test-Archive $members 'intact'
    $members["$repo/config"] = [byte[]]::new($config.Length)
    Test-Archive $members 'wrong-hash' 'VPS and Windows SHA-256 differ'
    $members["$repo/config"] = [byte[]]::new($config.Length + 1)
    Test-Archive $members 'oversized' 'Archive entry length differs from manifest'
    $members["$repo/config"] = $config
    $members["$repo/unlisted"] = $config
    Test-Archive $members 'unknown-file' 'Archive contains an unlisted repository file'
    $members.Remove("$repo/unlisted")
    $members['../escaped'] = $config
    Test-Archive $members 'unsafe-path' 'Unexpected archive path'
    $members.Remove('../escaped')
    $members.Remove("$repo/snapshots/$($snapshots.manifest)")
    Test-Archive $members 'missing' 'Incomplete local repository'
    'USTAR transfer, hash, file set, length, traversal, and capacity checks passed'

    $key = [Security.Cryptography.RandomNumberGenerator]::GetBytes(48)
    $dpapi = Protect-LocalRecoveryKey $key
    $roundTrip = [Security.Cryptography.ProtectedData]::Unprotect(
        $dpapi, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    try {
        if ((Get-Digest $key) -cne (Get-Digest $roundTrip)) { throw 'DPAPI key mismatch' }
    } finally { [Array]::Clear($roundTrip); [Array]::Clear($key) }
    'Windows DPAPI CurrentUser round trip passed'

    if ($PortableFixture) {
        $vault = (Get-Item -LiteralPath $PortableFixture).FullName
        $syntheticRun = Join-Path $vault 'synthetic-run'
        $transferReceipt = [IO.File]::ReadAllBytes((Join-Path $syntheticRun 'transfer.json'))
        $receiptMeta = [Text.Encoding]::UTF8.GetString($transferReceipt) | ConvertFrom-Json -AsHashtable
        $verifiedMeta = Read-TransferManifest $transferReceipt $receiptMeta.run $receiptMeta.releaseSha $receiptMeta.operationsArchiveSha256 $receiptMeta.repository
        $archive = Join-Path $root 'repository.ustar'
        $tar = Join-Path $env:SystemRoot 'System32/tar.exe'
        & $tar --format ustar -C $syntheticRun -cf $archive $verifiedMeta.repository transfer.json
        if ($LASTEXITCODE -ne 0) { throw 'Synthetic repository archive creation failed' }
        $copy = Join-Path $vault 'verified-copy'
        $null = [IO.Directory]::CreateDirectory($copy)
        $stream = [IO.File]::OpenRead($archive)
        try { Receive-Repository $stream $copy $verifiedMeta.repository $verifiedMeta $transferReceipt }
        finally { $stream.Dispose() }
        'Verified real synthetic Restic repository transfer through USTAR'

        $der = Join-Path $vault 'synthetic-public.cer'
        Test-Rejection { Read-EscrowCertificate $der ('0' * 64) } 'Escrow certificate SHA-256 differs from the approved fingerprint'
        $certificate = Read-EscrowCertificate $der (Get-Digest ([IO.File]::ReadAllBytes($der)))
        $fixtureKey = [IO.File]::ReadAllBytes((Join-Path $vault 'synthetic-run/restic-password'))
        try {
            Write-NewPrivateArtifact (Join-Path $vault 'synthetic-escrow.p7m') (Protect-EscrowRecoveryKey $fixtureKey $certificate)
        } finally { [Array]::Clear($fixtureKey); $certificate.Dispose() }
        'CMS escrow and certificate fingerprint checks passed; use OpenSSL and Restic to verify independent unlock'
    }
} finally {
    $resolved = (Get-Item -LiteralPath $root).FullName
    if ($resolved -cne [IO.Path]::GetFullPath($root) -or
        ![IO.Path]::GetFileName($resolved).StartsWith('membership-transfer-test-')) { throw 'Unexpected fixture directory' }
    [IO.Directory]::Delete($resolved, $true)
}
