param([switch]$EnableHypervisor)
$ErrorActionPreference = 'Stop'
if ($EnableHypervisor) {
  Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All -NoRestart
  Write-Host 'Restart Windows before using the debugger.'
}
if (-not (Get-Command qemu-system-x86_64 -ErrorAction SilentlyContinue) -and -not $env:WRET_QEMU) {
  Write-Host 'Install QEMU for Windows, then put its directory on PATH or set WRET_QEMU and WRET_QEMU_IMG.'
}
New-Item -ItemType Directory -Force -Path '.wret-vm' | Out-Null
if (-not (Test-Path -LiteralPath '.wret-vm/guest.qcow2') -or -not (Test-Path -LiteralPath '.wret-vm/guest.sha256')) {
  Write-Host 'Prepare a guest using guest/build-image.sh on a Linux builder, or follow docs/COMPANION.md for manual preparation.'
}
npm.cmd run companion:build
if ($LASTEXITCODE -ne 0) { throw 'Companion build failed' }
node dist-companion/server.mjs --check
exit $LASTEXITCODE
