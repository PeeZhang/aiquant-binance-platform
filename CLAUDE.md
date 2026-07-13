# CLAUDE.md

This file is the project constitution for `E:\AI-trading\aiquant`.

## Project Overview

`aiquant` is a Binance-focused crypto quant research platform built around
Freqtrade as the core execution/backtesting engine.

The project is intentionally conservative:

- MVP market: Binance Spot only.
- Default mode: Binance Spot sandbox/testnet dry-run only.
- No default mainnet live trading.
- No futures, margin, leverage, short selling, or market making in v1.
- No copied GPL source from Freqtrade, OctoBot, or other platforms.

Freqtrade owns exchange integration, strategy runtime, backtesting, dry-run,
Web UI, and API. This repository owns project organization, strategy source,
research logs, result archiving, safety checks, and secondary reports.

## Directory Roles

| Path | Purpose |
| --- | --- |
| `freqtrade/` | Freqtrade Docker, config, and local user data layout. |
| `strategies/` | First-party Freqtrade strategy source maintained by us. |
| `research/` | Platform research, strategy assumptions, and experiment logs. |
| `reports/` | Backtest exports and generated Markdown/HTML summaries. |
| `scripts/` | Safety wrappers, config validators, and report helpers. |
| `console/` | Chinese local dashboard and Freqtrade API proxy. |

## Domain Glossary

| Term | Definition |
| --- | --- |
| **Pair** | Binance spot trading pair, e.g. `BTC/USDT`, `ETH/USDT`. |
| **MarketData** | OHLCV candles downloaded or consumed by Freqtrade. |
| **Strategy** | A Freqtrade `IStrategy` class under `strategies/`. |
| **Signal** | Freqtrade entry/exit columns such as `enter_long` and `exit_long`. |
| **Profile** | A config profile, defaulting to `binance_spot_dryrun`. |
| **Dry-run** | Freqtrade simulated trading mode with no real orders. |
| **Report** | Exported Freqtrade results plus any secondary Markdown/HTML summary. |

## Architecture

The original A-share platform had Data / Strategy / Backtest / Report layers.
That separation remains, but Freqtrade now owns the core engine layer.

```
┌────────────────────────────────────────────┐
│  First-party strategies                    │
│  strategies/*.py                           │
├────────────────────────────────────────────┤
│  Freqtrade core                            │
│  Binance adapter, backtest, dry-run, UI    │
├────────────────────────────────────────────┤
│  aiquant safety/report shell               │
│  config checks, wrappers, report exports   │
├────────────────────────────────────────────┤
│  Research and archived outputs             │
│  research/, reports/, freqtrade/user_data  │
└────────────────────────────────────────────┘
```

## Safety Rules

1. `binance_spot_dryrun` is the default and only v1 profile.
2. `dry_run` must remain `true` unless the user explicitly asks for a separate
   live profile and accepts the risk.
3. `exchange.sandbox` must remain `true` for the default profile.
4. `trading_mode` must be `spot`.
5. `can_short` must be `False` in all v1 strategies.
6. API keys must never be committed. Keep them in local-only files or
   environment variables.
7. Strategies must include stoploss, position sizing constraints, and fees-aware
   backtest assumptions.
8. Scripts must fail closed when a config looks like live/mainnet trading.
9. Do not copy source code from GPL projects into this repository. Use their
   documented interfaces and write original code.

## Commands

All commands below are intended to run from `E:\AI-trading\aiquant`.

```powershell
# Validate the default dry-run config locally.
.\scripts\safe_freqtrade.ps1 validate

# Validate Docker Compose wiring.
docker compose -f .\freqtrade\docker-compose.yml config

# Download sample Binance spot candles through Freqtrade.
.\scripts\safe_freqtrade.ps1 download-data

# Run a baseline backtest.
.\scripts\safe_freqtrade.ps1 backtest -Strategy SmaCrossSpot

# Start the dry-run bot and local Web UI/API in the background.
.\scripts\safe_freqtrade.ps1 start
# Web UI/API: http://127.0.0.1:8081

# Inspect or stop the running container.
.\scripts\safe_freqtrade.ps1 status
.\scripts\safe_freqtrade.ps1 logs
.\scripts\safe_freqtrade.ps1 stop

# Start the Chinese aiquant console.
.\scripts\console.ps1 start
# Console: http://127.0.0.1:8090
```

If Docker is unavailable, install Freqtrade in a dedicated virtual environment
and keep the same config and strategy paths.

## References

- Freqtrade: https://github.com/freqtrade/freqtrade
- Freqtrade exchange docs: https://www.freqtrade.io/en/stable/exchanges/
- Hummingbot: https://github.com/hummingbot/hummingbot
- Jesse: https://github.com/jesse-ai/jesse
- NautilusTrader: https://github.com/nautechsystems/nautilus_trader
- OctoBot: https://github.com/Drakkar-Software/OctoBot
- Binance Spot Testnet API: https://developers.binance.com/docs/binance-spot-api-docs/testnet/rest-api/trading-endpoints
