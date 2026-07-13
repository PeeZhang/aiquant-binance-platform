# Reports

Store Freqtrade backtest exports and secondary summaries here.

Suggested flow:

1. Run a backtest with `scripts/safe_freqtrade.ps1 backtest`.
2. Locate the Freqtrade JSON export under `freqtrade/user_data/backtest_results`.
3. Run:

```powershell
.\scripts\safe_freqtrade.ps1 validate
& $env:AIQUANT_PYTHON .\scripts\export_backtest_summary.py <path-to-backtest-json>
```

If `AIQUANT_PYTHON` is not set, use any Python 3.10+ executable.
