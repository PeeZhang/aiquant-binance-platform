param(
    [Parameter(Position = 0)]
    [ValidateSet("start", "stop", "status", "logs")]
    [string]$Command = "start"
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $ProjectRoot

function Invoke-Compose {
    param([string[]]$ComposeArgs)
    & docker compose -f ".\freqtrade\docker-compose.yml" @ComposeArgs
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

switch ($Command) {
    "start" {
        & ".\scripts\safe_freqtrade.ps1" validate
        if ($LASTEXITCODE -ne 0) {
            exit $LASTEXITCODE
        }
        Invoke-Compose -ComposeArgs @("up", "-d", "freqtrade", "console")
        Write-Host "aiquant console: http://127.0.0.1:8090"
    }
    "stop" {
        Invoke-Compose -ComposeArgs @("stop", "console")
    }
    "status" {
        Invoke-Compose -ComposeArgs @("ps")
    }
    "logs" {
        Invoke-Compose -ComposeArgs @("logs", "--tail", "200", "console")
    }
}
