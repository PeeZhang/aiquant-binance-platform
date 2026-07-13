# Strategies

This directory contains first-party Freqtrade strategies.

The Docker Compose runtime mounts this directory into
`/freqtrade/user_data/strategies`, so Freqtrade can load these classes directly.

## Shared Baseline

- `FastFlipTestSpot`: aggressive dry-run test strategy for validating the full
  platform loop.

The public repository intentionally includes only this default strategy. Private
research strategies and generated optimization exports are ignored by Git by
default.

Shared strategies should be Binance Spot only. They must set
`can_short = False`, define a stoploss, and avoid futures, leverage, or short
selling.
