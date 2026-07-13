# aiquant

Binance Spot quant research platform using Freqtrade as the core engine.

## What This Project Does

- Keeps Freqtrade as the exchange, backtest, dry-run, Web UI, and API engine.
- Keeps our own strategies, research notes, reports, and safety wrappers in this
  repository.
- Starts with Binance Spot testnet/sandbox dry-run only.

## Quick Start

Run from this directory:

```powershell
.\scripts\safe_freqtrade.ps1 validate
docker compose -f .\freqtrade\docker-compose.yml config
.\scripts\safe_freqtrade.ps1 download-data
.\scripts\safe_freqtrade.ps1 backtest -Strategy SmaCrossSpot
.\scripts\safe_freqtrade.ps1 start
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

## Safety Defaults

- `dry_run=true`
- `trading_mode=spot`
- `exchange.sandbox=true`
- `stake_currency=USDT`
- no API key or secret in the committed config
- strategy classes set `can_short=False`
- first pairs: `BTC/USDT`, `ETH/USDT`, `BNB/USDT`, `SOL/USDT`

## First Strategies

- `SmaCrossSpot`: trend-following baseline.
- `RsiMeanReversionSpot`: mean-reversion baseline with a trend filter.

These are intentionally simple. Their job is to verify the complete loop:
config validation -> data download -> backtest -> dry-run -> report export.

## First Verified Run

On 2026-07-10, the first verified run downloaded BTC/USDT and ETH/USDT `5m`
and `1h` data from 2025-01-01 onward, then backtested both baseline strategies.
Human-readable summaries are under `reports/generated/`.
