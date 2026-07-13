from datetime import datetime
from typing import Optional

from freqtrade.strategy import IStrategy
from pandas import DataFrame


class FastFlipTestSpot(IStrategy):
    """Frequent Binance Spot dry-run test strategy.

    This strategy is intentionally aggressive and is only meant to validate the
    aiquant simulation page. It should not be used as a real trading strategy.
    """

    INTERFACE_VERSION = 3

    timeframe = "1m"
    can_short = False
    process_only_new_candles = True
    startup_candle_count = 30

    minimal_roi = {
        "0": 0.002,
        "5": 0.0,
    }
    stoploss = -0.01
    trailing_stop = False
    use_exit_signal = True
    exit_profit_only = False
    ignore_roi_if_entry_signal = False

    position_adjustment_enable = False
    max_entry_position_adjustment = 0

    order_types = {
        "entry": "market",
        "exit": "market",
        "emergency_exit": "market",
        "force_entry": "market",
        "force_exit": "market",
        "stoploss": "market",
        "stoploss_on_exchange": False,
    }
    order_time_in_force = {
        "entry": "GTC",
        "exit": "GTC",
    }

    min_stake_usdt = 20.0

    @property
    def protections(self):
        return [
            {
                "method": "CooldownPeriod",
                "stop_duration_candles": 1,
            },
        ]

    def custom_stake_amount(
        self,
        pair: str,
        current_time: datetime,
        current_rate: float,
        proposed_stake: float,
        min_stake: Optional[float],
        max_stake: float,
        leverage: float,
        entry_tag: Optional[str],
        side: str,
        **kwargs,
    ) -> float:
        floor = max(self.min_stake_usdt, float(min_stake or 0))
        if max_stake and floor > max_stake:
            return 0.0
        stake = max(float(proposed_stake), floor)
        return min(stake, float(max_stake)) if max_stake else stake

    @staticmethod
    def _rsi(dataframe: DataFrame, period: int = 7):
        delta = dataframe["close"].diff()
        gain = delta.clip(lower=0)
        loss = -delta.clip(upper=0)
        avg_gain = gain.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
        avg_loss = loss.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
        rs = avg_gain / avg_loss.replace(0, 1e-10)
        return 100 - (100 / (1 + rs))

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe["ema_fast"] = dataframe["close"].ewm(span=3, adjust=False, min_periods=3).mean()
        dataframe["ema_slow"] = dataframe["close"].ewm(span=8, adjust=False, min_periods=8).mean()
        dataframe["rsi_fast"] = self._rsi(dataframe, 7)
        dataframe["green"] = dataframe["close"] > dataframe["open"]
        dataframe["red"] = dataframe["close"] < dataframe["open"]
        dataframe["volume_ok"] = dataframe["volume"] > 0
        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        condition = (
            dataframe["volume_ok"]
            & dataframe["green"]
            & (dataframe["ema_fast"] >= dataframe["ema_slow"])
            & (dataframe["rsi_fast"] < 78)
        )
        dataframe.loc[condition, "enter_long"] = 1
        dataframe.loc[condition, "enter_tag"] = "test_fast_flip_buy"
        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        condition = (
            dataframe["volume_ok"]
            & (
                dataframe["red"]
                | (dataframe["ema_fast"] < dataframe["ema_slow"])
                | (dataframe["rsi_fast"] > 82)
            )
        )
        dataframe.loc[condition, "exit_long"] = 1
        dataframe.loc[condition, "exit_tag"] = "test_fast_flip_sell"
        return dataframe
