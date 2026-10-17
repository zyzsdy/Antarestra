# 启动服务并采集内存；使用 -Mode start 启动已构建版本，-Mode check 仅验证监测。
[CmdletBinding()]
param(
  [ValidateSet('dev', 'start', 'check')]
  [string]$Mode = 'dev',
  [ValidateRange(1, 3600)]
  [int]$IntervalSeconds = 30
)

$ErrorActionPreference = 'Stop'
$repoPath = Split-Path -Parent $PSScriptRoot
$preloadPath = Join-Path $PSScriptRoot 'memory-monitor.cjs'
$runPath = Join-Path $repoPath ('.tmp/memory-debug/' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$savedOptions = $env:NODE_OPTIONS
$savedDirectory = $env:ANTARESTRA_MEMORY_LOG_DIR
$savedInterval = $env:ANTARESTRA_MEMORY_INTERVAL_MS
$resultCode = 1

Push-Location -LiteralPath $repoPath
try {
  $null = Get-Command node -ErrorAction Stop
  if ($Mode -ne 'check') { $null = Get-Command pnpm -ErrorAction Stop }
  $null = New-Item -ItemType Directory -Path $runPath -Force
  # NODE_OPTIONS 中的路径使用正斜杠及双引号，兼容带空格的目录。
  $nodePreload = $preloadPath.Replace('\', '/')
  $nodeDiagnostics = $runPath.Replace('\', '/')
  $env:NODE_OPTIONS = ($savedOptions + ' --require="' + $nodePreload + '" --heapsnapshot-near-heap-limit=1 --diagnostic-dir="' + $nodeDiagnostics + '"').Trim()
  $env:ANTARESTRA_MEMORY_LOG_DIR = $runPath
  $env:ANTARESTRA_MEMORY_INTERVAL_MS = [string]($IntervalSeconds * 1000)

  Write-Host "监测输出：$runPath"
  Write-Host "采样间隔：$IntervalSeconds 秒；每个 Node 进程单独保存 JSONL。"
  Write-Host '临界堆快照可能暂停服务并包含敏感数据，请勿上传或提交。按 Ctrl+C 停止。'
  if ($Mode -eq 'check') {
    & node -e 'const { spawnSync } = require("node:child_process"); const child = spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 1200)"], { stdio: "inherit" }); process.exitCode = child.status ?? 1;'
  } else {
    & pnpm $Mode
  }
  $resultCode = $LASTEXITCODE
} finally {
  $env:NODE_OPTIONS = $savedOptions
  $env:ANTARESTRA_MEMORY_LOG_DIR = $savedDirectory
  $env:ANTARESTRA_MEMORY_INTERVAL_MS = $savedInterval
  Pop-Location
}
if ($resultCode -ne 0) { throw "启动进程退出，退出码：$resultCode；请检查终端与 $runPath" }
