# aiquant

Binance Spot quant research platform using Freqtrade as the core engine.

## What This Project Does

- Keeps Freqtrade as the exchange, backtest, dry-run, Web UI, and API engine.
- Keeps our own strategies, research notes, reports, and safety wrappers in this
  repository.
- Starts with Binance Spot testnet/sandbox dry-run only.

## Quick Start

Prerequisites:

- Git
- Docker Desktop
- PowerShell

Clone and enter the project:

```powershell
git clone https://github.com/PeeZhang/aiquant-binance-platform.git
cd aiquant-binance-platform
```

Start the local Freqtrade engine and Chinese console:

```powershell
.\scripts\safe_freqtrade.ps1 validate
docker compose -f .\freqtrade\docker-compose.yml config
.\scripts\console.ps1 start
```

The default config is `freqtrade/configs/binance_spot_dryrun.json`.
If the standard Binance API is unavailable from the current network location,
the config routes public market data to `data-api.binance.vision`.

When the bot is running, the Web UI/API is exposed on
`http://127.0.0.1:8081`.

The Chinese aiquant console is exposed separately on:

```text
http://127.0.0.1:8090
```

The first user workflow is:

1. Open the Chinese console.
2. Go to `数据` and download Binance Spot history data.
3. Go to `回测` and run the default strategy.
4. Run parameter optimization if desired.
5. Save an optimized version, then test it in `模拟交易`.

Useful runtime commands:

```powershell
.\scripts\safe_freqtrade.ps1 start
.\scripts\safe_freqtrade.ps1 status
.\scripts\safe_freqtrade.ps1 logs
.\scripts\safe_freqtrade.ps1 stop
.\scripts\console.ps1 start
.\scripts\console.ps1 status
.\scripts\console.ps1 stop
```

Optional CLI backtest after downloading data:

```powershell
.\scripts\safe_freqtrade.ps1 download-data -Timeframes 1m -Pairs BTC/USDT
.\scripts\safe_freqtrade.ps1 backtest -Strategy FastFlipTestSpot -Timeframes 1m -Pairs BTC/USDT
```

## Safety Defaults

- `dry_run=true`
- `trading_mode=spot`
- `exchange.sandbox=true`
- `stake_currency=USDT`
- no API key or secret in the committed config
- strategy classes set `can_short=False`
- first pairs: `BTC/USDT`, `ETH/USDT`, `BNB/USDT`, `SOL/USDT`

## Shared Strategy

The public repository intentionally includes only one runnable default strategy:

- `FastFlipTestSpot`: an aggressive Binance Spot dry-run test strategy.

It is intentionally simple. Its job is to verify the complete loop:
config validation -> data download -> backtest -> dry-run -> report export.
It should not be treated as a real trading strategy.

## First Verified Run

Local data, backtest results, hyperopt results, generated reports, private
strategies, and console state are intentionally ignored by Git. A fresh clone
starts empty and should use the console or `scripts/safe_freqtrade.ps1` to
download its own market data.
