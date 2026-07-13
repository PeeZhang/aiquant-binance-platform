param(
    [Parameter(Position = 0)]
    [ValidateSet("validate", "download-data", "backtest", "trade", "start", "stop", "status", "logs", "show-config")]
    [string]$Command = "validate",

    [string]$Strategy = "FastFlipTestSpot",
    [string]$Config = "freqtrade/configs/binance_spot_dryrun.json",
    [string]$Timerange = "20240101-",
    [string[]]$Timeframes = @("5m", "1h"),
    [string[]]$Pairs = @("BTC/USDT", "ETH/USDT")
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $ProjectRoot

function Get-AiquantPython {
    $candidates = @()
    if ($env:AIQUANT_PYTHON) {
        $candidates += $env:AIQUANT_PYTHON
    }
    $candidates += @(
        (Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"),
        "python",
        "py"
    )

    foreach ($candidate in $candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) {
            continue
        }
        if (Test-Path $candidate) {
            return $candidate
        }
        $command = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($command) {
            return $command.Source
        }
    }

    throw "Python was not found. Set AIQUANT_PYTHON to a Python executable."
}

function Convert-ToContainerConfig {
    param([string]$LocalConfig)

    $resolvedConfig = (Resolve-Path $LocalConfig).Path
    $configRoot = (Resolve-Path "freqtrade/configs").Path
    if (-not $resolvedConfig.StartsWith($configRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Config must live under freqtrade/configs so Docker can mount it safely."
    }

    $relative = $resolvedConfig.Substring($configRoot.Length).TrimStart("\", "/")
    return "/freqtrade/configs/" + ($relative -replace "\\", "/")
}

function Invoke-ProjectValidation {
    $python = Get-AiquantPython
    & $python "scripts/validate_config.py" $Config
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }

    $strategyFiles = Get-ChildItem "strategies" -Filter "*.py" -File
    if ($strategyFiles.Count -gt 0) {
        & $python -m py_compile @($strategyFiles.FullName)
        if ($LASTEXITCODE -ne 0) {
            exit $LASTEXITCODE
        }
    }
}

function Invoke-DockerCompose {
    param([string[]]$ComposeArgs)

    & docker compose -f ".\freqtrade\docker-compose.yml" @ComposeArgs
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

$commandsRequiringValidation = @("validate", "download-data", "backtest", "trade", "start", "show-config")
if ($commandsRequiringValidation -contains $Command) {
    Invoke-ProjectValidation
    $containerConfig = Convert-ToContainerConfig $Config
}

switch ($Command) {
    "validate" {
        Write-Host "aiquant validation complete."
    }
    "start" {
        $composeArgs = @("up", "-d")
        Invoke-DockerCompose -ComposeArgs $composeArgs
    }
    "stop" {
        $composeArgs = @("down")
        Invoke-DockerCompose -ComposeArgs $composeArgs
    }
    "status" {
        $composeArgs = @("ps")
        Invoke-DockerCompose -ComposeArgs $composeArgs
    }
    "logs" {
        $composeArgs = @("logs", "--tail", "200", "freqtrade")
        Invoke-DockerCompose -ComposeArgs $composeArgs
    }
    "show-config" {
        $composeArgs = @("run", "--rm", "freqtrade", "show-config", "--config", $containerConfig)
        Invoke-DockerCompose -ComposeArgs $composeArgs
    }
    "download-data" {
        $composeArgs = @(
            "run", "--rm", "freqtrade",
            "download-data",
            "--config", $containerConfig,
            "--timerange", $Timerange,
            "--timeframes"
        ) + $Timeframes + @("--pairs") + $Pairs
        Invoke-DockerCompose -ComposeArgs $composeArgs
    }
    "backtest" {
        $composeArgs = @(
            "run", "--rm", "freqtrade",
            "backtesting",
            "--config", $containerConfig,
            "--strategy", $Strategy,
            "--timerange", $Timerange,
            "--export", "trades",
            "--pairs"
        ) + $Pairs
        Invoke-DockerCompose -ComposeArgs $composeArgs
    }
    "trade" {
        $composeArgs = @(
            "run", "--rm", "--service-ports", "freqtrade",
            "trade",
            "--config", $containerConfig,
            "--strategy", $Strategy,
            "--logfile", "/freqtrade/user_data/logs/freqtrade.log"
        )
        Invoke-DockerCompose -ComposeArgs $composeArgs
    }
}
