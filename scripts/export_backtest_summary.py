import argparse
import json
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_RESULT_DIRS = [
    PROJECT_ROOT / "freqtrade" / "user_data" / "backtest_results",
    PROJECT_ROOT / "reports",
]


def newest_result() -> Path:
    candidates: list[Path] = []
    for directory in DEFAULT_RESULT_DIRS:
        if directory.exists():
            candidates.extend(directory.rglob("*.zip"))
            candidates.extend(
                path
                for path in directory.rglob("*.json")
                if not path.name.endswith(".meta.json")
            )
    if not candidates:
        raise SystemExit("No backtest result ZIP or JSON files found.")
    return max(candidates, key=lambda path: path.stat().st_mtime)


def load_json_from_zip(path: Path) -> Any:
    with zipfile.ZipFile(path) as archive:
        candidates = [
            name
            for name in archive.namelist()
            if name.endswith(".json") and not name.endswith("_config.json")
        ]
        if not candidates:
            raise SystemExit(f"No backtest JSON payload found in {path}.")
        with archive.open(candidates[0]) as handle:
            return json.loads(handle.read().decode("utf-8-sig"))


def load_payload(path: Path) -> Any:
    if path.suffix.lower() == ".zip":
        return load_json_from_zip(path)

    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Invalid JSON in {path}: {exc}")


def pct(value: Any) -> str:
    if value is None:
        return "n/a"
    try:
        return f"{float(value) * 100:.2f}%"
    except (TypeError, ValueError):
        return str(value)


def number(value: Any) -> str:
    if value is None:
        return "n/a"
    try:
        return f"{float(value):.4f}"
    except (TypeError, ValueError):
        return str(value)


def as_strategy_results(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    strategy = payload.get("strategy")
    if isinstance(strategy, dict):
        return {
            name: result
            for name, result in strategy.items()
            if isinstance(result, dict)
        }

    comparison = payload.get("strategy_comparison")
    if isinstance(comparison, list):
        return {
            str(item.get("key", item.get("strategy", f"strategy_{idx}"))): item
            for idx, item in enumerate(comparison)
            if isinstance(item, dict)
        }

    return {"backtest": payload}


def metric(result: dict[str, Any], *names: str) -> Any:
    for name in names:
        if name in result:
            return result[name]
    return None


def render_summary(source: Path, payload: dict[str, Any]) -> str:
    results = as_strategy_results(payload)
    lines = [
        "# Freqtrade Backtest Summary",
        "",
        f"- Source: `{source}`",
        f"- Generated: {datetime.now().isoformat(timespec='seconds')}",
        "",
        "| Strategy | Trades | Profit | Profit Abs | Max Drawdown | Win Rate | Profit Factor |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]

    for name, result in results.items():
        trades = metric(result, "total_trades", "trades")
        profit = metric(result, "profit_total", "profit_total_pct", "profit_mean")
        profit_abs = metric(result, "profit_total_abs", "profit_abs")
        drawdown = metric(result, "max_drawdown", "max_relative_drawdown")
        winrate = metric(result, "winrate", "win_rate")
        profit_factor = metric(result, "profit_factor")
        lines.append(
            "| "
            + " | ".join(
                [
                    str(name),
                    str(trades if trades is not None else "n/a"),
                    pct(profit),
                    number(profit_abs),
                    pct(drawdown),
                    pct(winrate / 100 if isinstance(winrate, (int, float)) and winrate > 1 else winrate),
                    number(profit_factor),
                ]
            )
            + " |"
        )

    lines.extend(
        [
            "",
            "## Notes",
            "",
            "- Treat this as a quick human-readable index, not a replacement for the full Freqtrade report.",
            "- Check fees, slippage, trade count, and drawdown before trusting a strategy.",
        ]
    )
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", nargs="?", help="Freqtrade backtest ZIP or JSON export.")
    parser.add_argument("-o", "--output", help="Markdown output path.")
    args = parser.parse_args()

    source = Path(args.input).resolve() if args.input else newest_result()
    payload = load_payload(source)
    if not isinstance(payload, dict):
        raise SystemExit("Expected a JSON object at the backtest root.")

    output = (
        Path(args.output).resolve()
        if args.output
        else PROJECT_ROOT / "reports" / "generated" / f"{source.stem}_summary.md"
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(render_summary(source, payload), encoding="utf-8")
    print(f"Wrote {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
