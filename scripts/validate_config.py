import json
import sys
from pathlib import Path


FUTURES_HINTS = (":USDT", "PERP", "FUTURE", "SWAP")
LIVE_NAME_HINTS = ("live", "mainnet", "real")
DEFAULT_SECRET_VALUES = {"", "CHANGE_ME", "CHANGE_ME_LOCAL_ONLY", None}


def load_config(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        raise SystemExit(f"Config not found: {path}")
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Invalid JSON in {path}: {exc}")


def is_empty_secret(value) -> bool:
    return value in DEFAULT_SECRET_VALUES


def main(argv: list[str]) -> int:
    config_path = Path(argv[1]) if len(argv) > 1 else Path(
        "freqtrade/configs/binance_spot_dryrun.json"
    )
    config = load_config(config_path)

    errors: list[str] = []
    warnings: list[str] = []

    if config.get("dry_run") is not True:
        errors.append("dry_run must be true for the default aiquant profile.")

    if config.get("trading_mode") != "spot":
        errors.append("trading_mode must be spot.")

    if config.get("margin_mode") not in ("", None):
        errors.append("margin_mode must be empty for the v1 spot profile.")

    if config.get("max_open_trades", 0) > 5:
        warnings.append("max_open_trades is above the conservative v1 range.")

    stake_currency = config.get("stake_currency")
    if stake_currency != "USDT":
        errors.append("stake_currency must be USDT in the default profile.")

    exchange = config.get("exchange", {})
    if exchange.get("name") != "binance":
        errors.append("exchange.name must be binance.")

    if exchange.get("sandbox") is not True:
        errors.append("exchange.sandbox must be true for the default testnet/dry-run profile.")

    if not is_empty_secret(exchange.get("key")):
        errors.append("exchange.key must not be committed.")

    if not is_empty_secret(exchange.get("secret")):
        errors.append("exchange.secret must not be committed.")

    for section in ("ccxt_config", "ccxt_async_config"):
        section_config = exchange.get(section, {})
        options = section_config.get("options", {})
        fetch_markets = options.get("fetchMarkets", {})
        if fetch_markets.get("types") != ["spot"]:
            errors.append(f"exchange.{section}.options.fetchMarkets.types must be ['spot'].")
        if options.get("defaultType") != "spot":
            errors.append(f"exchange.{section}.options.defaultType must be spot.")

        public_url = (
            section_config
            .get("urls", {})
            .get("api", {})
            .get("public")
        )
        if public_url != "https://data-api.binance.vision/api/v3":
            warnings.append(
                f"exchange.{section}.urls.api.public is not routed to Binance data-api."
            )

    pair_whitelist = exchange.get("pair_whitelist", [])
    if not pair_whitelist:
        errors.append("exchange.pair_whitelist must not be empty.")

    for pair in pair_whitelist:
        upper_pair = str(pair).upper()
        if not upper_pair.endswith("/USDT"):
            errors.append(f"Only USDT spot pairs are allowed in v1: {pair}")
        if any(hint in upper_pair for hint in FUTURES_HINTS):
            errors.append(f"Pair looks like futures/perpetual notation: {pair}")

    config_name = config_path.name.lower()
    bot_name = str(config.get("bot_name", "")).lower()
    if any(hint in config_name or hint in bot_name for hint in LIVE_NAME_HINTS):
        errors.append("The default validator refuses live/mainnet-looking profiles.")

    api_server = config.get("api_server", {})
    if api_server.get("enabled") is True:
        if api_server.get("username") == "freqtrade" or api_server.get("password") == "freqtrade":
            warnings.append("API server uses default local credentials; change them before sharing a machine.")
        if api_server.get("listen_ip_address") == "0.0.0.0":
            warnings.append("API server listens inside the container on 0.0.0.0; host binding must stay localhost-only.")

    if errors:
        print("UNSAFE CONFIG")
        for error in errors:
            print(f"- {error}")
        return 1

    print("SAFE CONFIG OK")
    print(f"- profile: {config_path}")
    print(f"- exchange: {exchange.get('name')}")
    print(f"- sandbox: {exchange.get('sandbox')}")
    print(f"- dry_run: {config.get('dry_run')}")
    print(f"- trading_mode: {config.get('trading_mode')}")
    print(f"- pairs: {', '.join(pair_whitelist)}")
    if warnings:
        print("WARNINGS")
        for warning in warnings:
            print(f"- {warning}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
