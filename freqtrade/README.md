# Freqtrade Runtime

This directory holds the Freqtrade runtime shell for aiquant.

## Layout

- `configs/`: committed dry-run configs and local-only config templates.
- `user_data/`: Freqtrade runtime data, logs, backtest results, and databases.
- `docker-compose.yml`: Docker entrypoint using the official Freqtrade image.

The compose file mounts `../strategies` into
`/freqtrade/user_data/strategies`, so strategy source is maintained only once.
The mount is writable because Freqtrade normalizes ownership under
`user_data` and may write bytecode caches.

## Default Profile

`configs/binance_spot_dryrun.json` is the only committed executable profile.
It must remain dry-run, spot-only, and keyless.

Use `scripts/safe_freqtrade.ps1` instead of calling Freqtrade directly when
possible; it validates the profile before running commands.
