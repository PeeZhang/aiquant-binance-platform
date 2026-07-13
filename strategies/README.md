# Strategies

This directory contains first-party Freqtrade strategies.

The Docker Compose runtime mounts this directory into
`/freqtrade/user_data/strategies`, so Freqtrade can load these classes directly.

## Baselines

- `SmaCrossSpot`: trend-following baseline.
- `RsiMeanReversionSpot`: mean-reversion baseline with a long-term trend filter.

Both strategies are Binance Spot only. They set `can_short = False`, define a
stoploss, and use conservative stake sizing.
