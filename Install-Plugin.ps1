# Install-Plugin.ps1 -- install dsh-appearance into a dsh profile (hand-installed bundle)
#
# NOTE: this file is ASCII-only ON PURPOSE. The write tool cannot add a UTF-8 BOM and
#       PowerShell 5.1 reads BOM-less files as ANSI -> Chinese text would break the parse.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File Install-Plugin.ps1                 # profile=desktop
#   powershell -ExecutionPolicy Bypass -File Install-Plugin.ps1 -Profile web
#   powershell -ExecutionPolicy Bypass -File Install-Plugin.ps1 -Verify
#   powershell -ExecutionPolicy Bypass -File Install-Plugin.ps1 -Revert
param(
    [string]$Profile    = 'desktop',
    [string]$ProfileDir = '',
    [switch]$Revert,
    [switch]$Verify
)

$ErrorActionPreference = 'Stop'
$src      = $PSScriptRoot
$pkgName  = 'dsh-appearance'
$dshHome  = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
if (-not $ProfileDir) { $ProfileDir = Join-Path (Join-Path $dshHome 'profiles') $Profile }
$dest     = Join-Path $ProfileDir "node_modules\$pkgName"
$pkgJson  = Join-Path $ProfileDir 'package.json'

function Say($t, $c = 'Gray') { Write-Host $t -ForegroundColor $c }

# ---- node for syntax self-check -------------------------------------------------
$node = 'node'
$cand = 'D:\dsh\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
if (Test-Path -LiteralPath $cand) { $node = $cand }

function Read-ProfilePkg {
    if (-not (Test-Path -LiteralPath $pkgJson)) { throw "profile package.json not found: $pkgJson" }
    $raw = [System.IO.File]::ReadAllText($pkgJson, (New-Object System.Text.UTF8Encoding($false)))
    return ($raw -replace '^\uFEFF', '') | ConvertFrom-Json
}
function Save-ProfilePkg($obj) {
    $json = $obj | ConvertTo-Json -Depth 10
    # no BOM: node reads this file (AGENTS.md JSON red line)
    [System.IO.File]::WriteAllText($pkgJson, $json, (New-Object System.Text.UTF8Encoding($false)))
}
function Get-Bundles($cfg) {
    if ($cfg.dsh -and $cfg.dsh.profile -and $cfg.dsh.profile.bundles) { return @($cfg.dsh.profile.bundles) }
    return @()
}

Say ''
Say "== dsh-appearance ==" 'Cyan'
Say "   source : $src"
Say "   target : $dest"
Say "   profile: $Profile"

# ---- verify / revert -----------------------------------------------------------
$cfg = Read-ProfilePkg
$bundles = Get-Bundles $cfg
$registered = $bundles -contains $pkgName
$installed = Test-Path -LiteralPath $dest

if ($Verify) {
    Say ''
    Say "   installed   : $installed"
    Say "   bundles has : $registered"
    Say "   bundles now : $($bundles -join ', ')"
    if ($installed) {
        foreach ($f in @('lib\index.js', 'lib\appearance-core.js', 'client\client.js')) {
            $p = Join-Path $dest $f
            if (-not (Test-Path -LiteralPath $p)) { Say "   MISSING $f" 'Red'; continue }
            & $node --check $p 2>&1 | Out-Null
            if ($LASTEXITCODE -eq 0) { Say "   syntax ok   : $f" 'Green' } else { Say "   SYNTAX FAIL : $f" 'Red' }
        }
    }
    if ($installed -and $registered) { Say '   => OK' 'Green'; exit 0 }
    Say '   => not fully installed' 'Yellow'
    exit 1
}

if ($Revert) {
    if ($installed) { Remove-Item -LiteralPath $dest -Recurse -Force; Say "   removed $dest" 'Yellow' }
    if ($registered) {
        $cfg.dsh.profile.bundles = @($bundles | Where-Object { $_ -ne $pkgName })
        Save-ProfilePkg $cfg
        Say "   unregistered from bundles (now $(@($cfg.dsh.profile.bundles).Count) items)" 'Yellow'
    }
    Say '   reverted. Restart DSH to unload it.' 'Green'
    exit 0
}

# ---- install -------------------------------------------------------------------
Say ''
Say '1) copy files ...' 'Cyan'
if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$copied = 0
foreach ($item in @('lib', 'client')) {
    $from = Join-Path $src $item
    if (-not (Test-Path -LiteralPath $from)) { throw "missing source dir: $from" }
    Copy-Item -LiteralPath $from -Destination $dest -Recurse -Force
    $copied += @(Get-ChildItem -LiteralPath (Join-Path $dest $item) -Recurse -File).Count
}
foreach ($f in @('package.json', 'cordis.patch.yml', 'README.md')) {
    $from = Join-Path $src $f
    if (Test-Path -LiteralPath $from) { Copy-Item -LiteralPath $from -Destination $dest -Force; $copied++ }
}
Say "   copied $copied file(s)" 'Green'

Say '2) register in profile bundles ...' 'Cyan'
if (-not $registered) {
    $list = @($bundles) + $pkgName
    $cfg.dsh.profile.bundles = $list
    Save-ProfilePkg $cfg
    Say "   registered (now $($list.Count) items): $($list -join ', ')" 'Green'
} else {
    Say '   already registered' 'DarkGray'
}

Say '3) self-check ...' 'Cyan'
$bad = 0
foreach ($f in @('lib\index.js', 'lib\appearance-core.js', 'client\client.js')) {
    $p = Join-Path $dest $f
    & $node --check $p 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { Say "   syntax ok : $f" 'Green' } else { Say "   SYNTAX FAIL: $f" 'Red'; $bad++ }
}
$rawBytes = [System.IO.File]::ReadAllBytes($pkgJson)
if ($rawBytes[0] -eq 239 -and $rawBytes[1] -eq 187 -and $rawBytes[2] -eq 191) {
    Say '   profile package.json HAS A BOM (node will fail to parse it)' 'Red'; $bad++
} else { Say '   profile package.json has no BOM' 'Green' }
if (Test-Path -LiteralPath (Join-Path $dest 'cordis.patch.yml')) { Say '   cordis.patch.yml present' 'Green' } else { Say '   cordis.patch.yml MISSING' 'Red'; $bad++ }

if ($bad -gt 0) { Say "   => $bad check(s) FAILED - fix before restarting DSH" 'Red'; exit 3 }
Say ''
Say 'Installed. A NEW bundle hot-loads; after changing this plugin''s own code you MUST restart DSH.' 'Green'
Say 'Client half (panel/styles): refresh the window (Ctrl+R). Then: Settings > Plugins > Appearance.' 'Green'
Say "Revert: powershell -File Install-Plugin.ps1 -Revert -Profile $Profile" 'DarkGray'
exit 0
