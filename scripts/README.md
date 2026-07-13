# Scripts

Use these wrappers before running Freqtrade directly.

## Commands

```powershell
.\scripts\safe_freqtrade.ps1 validate
.\scripts\safe_freqtrade.ps1 start
.\scripts\safe_freqtrade.ps1 status
.\scripts\safe_freqtrade.ps1 logs
.\scripts\safe_freqtrade.ps1 stop
.\scripts\safe_freqtrade.ps1 download-data
.\scripts\safe_freqtrade.ps1 backtest -Strategy FastFlipTestSpot
.\scripts\safe_freqtrade.ps1 trade -Strategy FastFlipTestSpot
.\scripts\console.ps1 start
```

`validate_config.py` fails closed if a config is not dry-run Binance Spot.

`export_backtest_summary.py` converts a Freqtrade backtest JSON export into a
small Markdown summary. Generated reports are local runtime artifacts and are
ignored by Git.
