# Launched by the NSSM-managed "AdminReminder" service (see AdminReminder.iss).
# Reads .env from ProgramData at every start rather than baking values into the
# service config, so editing the file and restarting the service is the whole
# reconfiguration workflow - the same thing the Docker .env already trains an
# operator to do.
#
# Runs node.exe as a direct child (not via Start-Process) so this script's own
# process stays alive for exactly as long as the server does; NSSM tracks and
# terminates the process tree it launched, and an extra detached hop here would
# let node.exe outlive a service stop/restart as an orphan.
$ErrorActionPreference = "Stop"

$AppDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$DataDir = Join-Path $env:ProgramData "AdminReminder"
$EnvFile = Join-Path $DataDir ".env"

if (-not (Test-Path $EnvFile)) {
    Write-Error "Brak pliku konfiguracyjnego: $EnvFile. Uruchom ponownie instalator albo utworz go recznie (patrz generate-env.js)."
    exit 1
}

Get-Content $EnvFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -eq "" -or $line.StartsWith("#")) { return }
    # Split on the FIRST "=" only - secrets are base64 and often contain "="
    # padding or embedded characters that must survive intact in the value.
    $parts = $line -split "=", 2
    if ($parts.Length -eq 2) {
        [Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim(), "Process")
    }
}

New-Item -ItemType Directory -Force -Path (Join-Path $DataDir "data") | Out-Null

Set-Location $AppDir
$node = Join-Path $AppDir "node.exe"

& $node "scripts\init-db.js"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& $node "server.js"
exit $LASTEXITCODE
