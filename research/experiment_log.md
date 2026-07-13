# Experiment Log

Append new experiments below. Keep the record concise and auditable.

## Template

```text
Date:
Command:
Config:
Strategy:
Pairs:
Timerange:
Result file:
Key metrics:
Decision:
```

## 2026-07-10 Bootstrap

Date: 2026-07-10
Command: `.\scripts\safe_freqtrade.ps1 download-data -Timerange 20250101- -Timeframes 5m,1h -Pairs BTC/USDT,ETH/USDT`
Config: `freqtrade/configs/binance_spot_dryrun.json`
Strategy: n/a
Pairs: BTC/USDT, ETH/USDT
Timerange: 20250101-
Result file: `freqtrade/user_data/data/binance/*`
Key metrics: Freqtrade image pulled and config validated. Binance main API and testnet API returned HTTP 451 from the current network location. `data-api.binance.vision` returned HTTP 200, so the config now routes public market data there. Downloaded BTC/USDT and ETH/USDT 5m + 1h data from 2025-01-01 to 2026-07-10.
Decision: Keep default profile dry-run/sandbox and use the public data-api endpoint for historical OHLCV where possible.

Date: 2026-07-10
Command: `.\scripts\safe_freqtrade.ps1 backtest -Strategy SmaCrossSpot -Timerange 20250101- -Pairs BTC/USDT,ETH/USDT`
Config: `freqtrade/configs/binance_spot_dryrun.json`
Strategy: `SmaCrossSpot`
Pairs: BTC/USDT, ETH/USDT
Timerange: 20250101-
Result file: `freqtrade/user_data/backtest_results/backtest-result-2026-07-10_15-04-25.zip`; summary `reports/generated/SmaCrossSpot_2026-07-10.md`
Key metrics: 67 trades, -31.794 USDT, -0.32%, win rate 56.7%, max drawdown 0.38%, profit factor 0.60.
Decision: Useful plumbing baseline, not a profitable strategy candidate yet.

Date: 2026-07-10
Command: `.\scripts\safe_freqtrade.ps1 backtest -Strategy RsiMeanReversionSpot -Timerange 20250101- -Pairs BTC/USDT,ETH/USDT`
Config: `freqtrade/configs/binance_spot_dryrun.json`
Strategy: `RsiMeanReversionSpot`
Pairs: BTC/USDT, ETH/USDT
Timerange: 20250101-
Result file: `freqtrade/user_data/backtest_results/backtest-result-2026-07-10_15-04-48.zip`; summary `reports/generated/RsiMeanReversionSpot_2026-07-10.md`
Key metrics: 25 trades, -4.766 USDT, -0.05%, win rate 32.0%, max drawdown 0.10%, profit factor 0.68.
Decision: Useful low-turnover mean-reversion baseline, but still not a live candidate.
