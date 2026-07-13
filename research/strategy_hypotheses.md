# Strategy Hypotheses

## SmaCrossSpot

Hypothesis: large USDT spot pairs trend enough on 1h candles that a slow/fast
SMA cross can provide a simple benchmark for testing the full workflow.

Expected strengths:

- Easy to understand.
- Low turnover compared with short-timeframe scalping.
- Good first test for backtest and dry-run plumbing.

Expected weaknesses:

- Whipsaws in sideways markets.
- Late entries and late exits.
- Needs fees and slippage included before any interpretation.

## RsiMeanReversionSpot

Hypothesis: large USDT spot pairs often mean-revert after short-term weakness,
but entries should be filtered by a long-term trend indicator.

Expected strengths:

- Different behavior from trend following.
- Useful baseline for comparing market regime sensitivity.

Expected weaknesses:

- Can catch falling prices in strong downtrends.
- Needs strict stoploss and cooldown.
- May overtrade if RSI thresholds are too loose.

## Initial Acceptance Criteria

- Backtest finishes for `BTC/USDT` and `ETH/USDT`.
- Strategy produces at least a few trades in a multi-month timerange.
- Drawdown, trade count, win rate, and fees are reviewed before any dry-run use.
