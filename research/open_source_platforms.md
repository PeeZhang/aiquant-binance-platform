# Open-Source Binance Quant Platform Review

Date: 2026-07-10

## Decision

Use Freqtrade as the v1 core engine for Binance Spot research, backtesting,
dry-run trading, Web UI, and API.

`aiquant` should not reimplement exchange connectors, the bot loop, or basic
backtesting in v1. It should wrap Freqtrade with project-specific safety checks,
strategy organization, research notes, and report exports.

## Platform Notes

| Platform | Role for aiquant | Why |
| --- | --- | --- |
| [Freqtrade](https://github.com/freqtrade/freqtrade) | Core engine | Mature Binance support, dry-run, backtesting, strategy interface, Web UI/API. |
| [Hummingbot](https://github.com/hummingbot/hummingbot) | Later reference | Strong connector and market-making ideas, but heavier than needed for v1. |
| [Jesse](https://github.com/jesse-ai/jesse) | UX/reference | Good strategy/backtest/live workflow ideas; not selected to avoid parallel engines. |
| [NautilusTrader](https://github.com/nautechsystems/nautilus_trader) | Architecture reference | Professional event-driven design; too complex for the first learning platform. |
| [OctoBot](https://github.com/Drakkar-Software/OctoBot) | Product reference | Useful UI/template ideas such as DCA/Grid/TradingView workflows. |
| Local `Vibe-Trading` | Safety reference | Useful profile separation, host guards, redaction, live mandate gate, audit log. |

## Borrowed Ideas

- From Freqtrade: strategy lifecycle, config profiles, dry-run workflow, pair
  whitelists, backtest export, Web UI/API.
- From Hummingbot: keep future connector/order-book abstractions in mind for
  market-making or grid strategies.
- From Jesse: keep strategy files readable and make backtest/live behavior
  comparable.
- From NautilusTrader: use event-driven concepts later if multi-venue or
  higher-frequency work becomes necessary.
- From OctoBot: keep a simple path for user-facing strategy templates.
- From Vibe-Trading: fail closed before live trading, separate paper/live
  profiles, redact secrets, and log any risky operation.

## License Boundary

Do not copy GPL project source into this repository. Use documented interfaces,
write original strategies/scripts, and keep third-party platforms as external
tools or references.
