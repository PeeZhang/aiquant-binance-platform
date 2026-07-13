# Config Profiles

## `binance_spot_dryrun.json`

The committed default profile. It is intentionally:

- Binance only
- Spot only
- dry-run only
- keyless
- limited to a small USDT pair whitelist
- public market data routed to `data-api.binance.vision` when the default
  Binance API is unavailable from the current network location

Run `..\..\scripts\safe_freqtrade.ps1 validate` before using any config.

## Local Configs

Use `*.local.json` for private experiments. These files are ignored by git.
Do not commit API keys or live trading profiles.
