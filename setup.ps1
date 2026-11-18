#Requires -Version 5.1
<#
Agent Bros. Pictures: first-run setup for Windows (macOS, Linux and WSL: setup.sh).

  ./setup.ps1                  plan only: what is missing and the scope of each fix; changes nothing
  ./setup.ps1 -Apply           user-scope tools (Node through fnm, nvm-windows or Volta, pnpm, uv) and the
                               repository steps (packages, Chromium, pinned Python, .env), then a report
  ./setup.ps1 -Apply -System   also system packages through winget (FFmpeg; fnm when no Node manager exists)

-Assets, -Smoke and -Goal <list> pass through to `pnpm bootstrap`.
stdout carries exactly one JSON line; progress goes to stderr. Agents: read SETUP.md first, and ask
the user before -Apply when the plan lists `user` or `system` steps.
#>
[CmdletBinding()]
param(
  [switch]$Plan,
  [switch]$Apply,
  [switch]$System,
  [switch]$Assets,
  [switch]$Smoke,
  [string]$Goal
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$started = Get-Date
$mode = if ($Apply) { 'apply' } else { 'plan' }

function Say([string]$message) { [Console]::Error.WriteLine($message) }
function Have([string]$name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }
function Emit($object) {
  $object['elapsedMs'] = [int]((Get-Date) - $started).TotalMilliseconds
  [Console]::Out.WriteLine(($object | ConvertTo-Json -Compress -Depth 6))
}
function Fail([string]$code, [string]$message) {
  Emit ([ordered]@{ ok = $false; error = $code; message = $message })
  exit 1
}
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  $local = Join-Path $HOME '.local\bin'
  if (Test-Path $local) { $env:Path = "$local;$env:Path" }
}

if (-not (Test-Path package.json) -or -not (Test-Path .nvmrc)) { Fail 'VALIDATION' 'Run setup.ps1 from an Agent Bros. Pictures checkout.' }
$nodePin = (Get-Content .nvmrc -Raw).Trim()
$pnpmPin = ((Get-Content package.json -Raw | ConvertFrom-Json).packageManager) -replace '^pnpm@', ''
Refresh-Path

function NodeOk {
  if (-not (Have node)) { return $false }
  $version = (& node -p 'process.versions.node' 2>$null)
  return [bool]($version -match '^(26|24)\.')
}
function PnpmOk { (Have pnpm) -and ((& pnpm --version 2>$null) -eq $pnpmPin) }
function UvOk { Have uv }
function FfmpegOk { (Have ffmpeg) -and (Have ffprobe) }
function ModulesOk { Test-Path 'node_modules/.modules.yaml' }

$nodeScope = 'user'; $nodeHint = ''; $activate = ''
if (Have fnm) {
  $manager = 'fnm'
  $nodeCmd = "fnm install $nodePin; fnm use $nodePin"
  $activate = "fnm env --shell powershell | Out-String | Invoke-Expression; fnm use $nodePin"
} elseif (Have nvm) {
  $manager = 'nvm-windows'
  $nodeCmd = "nvm install $nodePin; nvm use $nodePin"
} elseif (Have volta) {
  $manager = 'volta'
  $nodeCmd = "volta install node@$nodePin"
} elseif (Have winget) {
  $manager = 'fnm-winget'
  $nodeScope = 'system'
  $nodeCmd = "winget install --id Schniz.fnm -e --accept-package-agreements --accept-source-agreements"
  $activate = "fnm env --shell powershell | Out-String | Invoke-Expression; fnm use $nodePin"
} else {
  $manager = 'none'
  $nodeCmd = ''
  $nodeHint = "install nvm-windows or fnm, then rerun ./setup.ps1"
}
$ffmpegCmd = if (Have winget) { 'winget install --id Gyan.FFmpeg -e --accept-package-agreements --accept-source-agreements' } else { '' }
$uvCmd = "`$env:UV_NO_MODIFY_PATH='1'; powershell -ExecutionPolicy ByPass -c `"irm https://astral.sh/uv/install.ps1 | iex`""

function Get-Plan {
  $steps = @()
  $add = {
    param($id, $scope, $required, $ok, $command, $hint)
    $state = if ($ok) { 'done' } elseif (-not $command) { 'manual' } elseif ($scope -eq 'repo') { 'todo' } else { 'needs-consent' }
    $step = [ordered]@{ id = $id; scope = $scope; required = $required; state = $state }
    if (-not $ok -and $command) { $step['command'] = $command }
    if (-not $ok -and $hint) { $step['hint'] = $hint }
    return $step
  }
  $steps += & $add 'node' $nodeScope $true (NodeOk) $nodeCmd $nodeHint
  $steps += & $add 'pnpm' 'user' $true (PnpmOk) "npm install --global pnpm@$pnpmPin --allow-scripts=pnpm" ''
  $steps += & $add 'ffmpeg' 'system' $true (FfmpegOk) $ffmpegCmd 'install FFmpeg (winget install Gyan.FFmpeg or choco install ffmpeg)'
  $steps += & $add 'uv' 'user' $false (UvOk) $uvCmd ''
  $steps += & $add 'install' 'repo' $true (ModulesOk) 'pnpm install --frozen-lockfile' ''
  return , $steps
}

function Show-Plan($steps) {
  Say ''
  Say 'Agent Bros. Pictures setup (windows): prerequisites'
  foreach ($step in $steps) {
    if ($step.state -eq 'done') { Say "  [done] $($step.id)"; continue }
    $what = if ($step.Contains('command')) { $step.command } elseif ($step.Contains('hint')) { $step.hint } else { '' }
    Say "  [$($step.state)] $($step.id) ($($step.scope)): $what"
  }
  Say ''
}

$applied = @()
$installedNode = $false
function Invoke-Step([string]$id, [string]$command) {
  Say "-> ${id}: $command"
  $global:LASTEXITCODE = 0
  try { Invoke-Expression $command | ForEach-Object { Say $_ } } catch { Say "  $id failed: $_"; return $false }
  if ($LASTEXITCODE -ne 0) { Say "  $id failed (exit $LASTEXITCODE)"; return $false }
  $script:applied += $id
  return $true
}

function Invoke-Bootstrap {
  $env:AGENTBROS_SETUP_APPLIED = ($applied -join ',')
  if ($installedNode -and $activate) { $env:AGENTBROS_SETUP_ACTIVATE = $activate }
  $pass = @()
  if ($Apply) { $pass += '--apply' }
  if ($Assets) { $pass += '--assets' }
  if ($Smoke) { $pass += '--smoke' }
  if ($Goal) { $pass += @('--goal', $Goal) }
  & pnpm --silent bootstrap @pass
  exit $LASTEXITCODE
}

$steps = Get-Plan
Show-Plan $steps

if (-not $Apply) {
  if ((NodeOk) -and (PnpmOk) -and (ModulesOk)) { Invoke-Bootstrap }
  $consent = @($steps | Where-Object { $_.state -eq 'needs-consent' -or $_.state -eq 'manual' } | ForEach-Object { $_.id })
  Emit ([ordered]@{
      ok       = $true
      outputs  = @()
      metadata = [ordered]@{
        mode         = $mode
        stage        = 'prerequisites'
        os           = 'windows'
        nodeManager  = $manager
        steps        = $steps
        needsConsent = $consent
        activate     = $activate
        next         = 'Show the user the needsConsent steps; after a yes run ./setup.ps1 -Apply (add -System for winget packages). Then follow SETUP.md.'
      }
    })
  exit 0
}

if (-not (NodeOk)) {
  if (-not $nodeCmd) { Fail 'VALIDATION' "Node $nodePin is missing and no version manager was found: $nodeHint." }
  if ($nodeScope -eq 'system' -and -not $System) { Fail 'VALIDATION' 'Installing Node needs winget (a system change): ask the user, then rerun ./setup.ps1 -Apply -System.' }
  if (Invoke-Step 'node' $nodeCmd) { $installedNode = $true }
  Refresh-Path
  if ($manager -eq 'fnm-winget' -and (Have fnm)) {
    fnm env --shell powershell | Out-String | Invoke-Expression
    if (Invoke-Step 'node' "fnm install $nodePin; fnm use $nodePin") { $installedNode = $true }
  } elseif ($manager -eq 'fnm') {
    fnm env --shell powershell | Out-String | Invoke-Expression
    fnm use $nodePin | Out-Null
  }
  if (-not (NodeOk)) { Fail 'VALIDATION' "Node $nodePin is still not active. Install it (docs/install.md), then rerun ./setup.ps1 -Apply." }
}
if (-not (PnpmOk)) {
  Invoke-Step 'pnpm' "npm install --global pnpm@$pnpmPin --allow-scripts=pnpm" | Out-Null
  Refresh-Path
  if (-not (PnpmOk)) { Fail 'VALIDATION' "pnpm $pnpmPin is not on PATH after installing it; see docs/install.md." }
}
if (-not (UvOk)) {
  if (Invoke-Step 'uv' $uvCmd) { Refresh-Path }
}
if ($System) {
  if (-not (FfmpegOk) -and $ffmpegCmd) { if (Invoke-Step 'ffmpeg' $ffmpegCmd) { Refresh-Path } }
} elseif (-not (FfmpegOk)) {
  Say 'System packages are left alone without -System; the report lists them.'
}
if (-not (ModulesOk)) {
  if (-not (Invoke-Step 'install' 'pnpm install --frozen-lockfile')) { Fail 'VALIDATION' 'pnpm install --frozen-lockfile failed; see the output above.' }
}
Invoke-Bootstrap
