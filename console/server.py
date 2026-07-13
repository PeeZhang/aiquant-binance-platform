import argparse
import ast
import base64
import json
import mimetypes
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
import zipfile
from datetime import datetime
from math import floor
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse


PROJECT_ROOT = Path(__file__).resolve().parents[1]
STATIC_ROOT = Path(__file__).resolve().parent / "static"
CONFIG_PATH = PROJECT_ROOT / "freqtrade" / "configs" / "binance_spot_dryrun.json"
REPORTS_ROOT = PROJECT_ROOT / "reports" / "generated"
STRATEGIES_ROOT = PROJECT_ROOT / "strategies"
DATA_ROOT = PROJECT_ROOT / "freqtrade" / "user_data" / "data"
STATE_ROOT = PROJECT_ROOT / "console" / "state"
WATCHLIST_PATH = STATE_ROOT / "watchlist.json"
STRATEGY_STATE_PATH = STATE_ROOT / "strategy_state.json"
STRATEGY_VERSIONS_PATH = STATE_ROOT / "strategy_versions.json"
BACKTEST_HISTORY_PATH = STATE_ROOT / "backtests_history.json"
BACKTEST_RESULTS_ROOT = PROJECT_ROOT / "freqtrade" / "user_data" / "backtest_results"
HYPEROPT_HISTORY_PATH = STATE_ROOT / "hyperopt_history.json"
HYPEROPT_RESULTS_ROOT = PROJECT_ROOT / "freqtrade" / "user_data" / "hyperopt_results"
SIMULATION_STATE_PATH = STATE_ROOT / "simulation_state.json"
SIMULATION_HISTORY_PATH = STATE_ROOT / "simulation_history.json"
DATA_NAMES_PATH = STATE_ROOT / "data_names.json"
USER_DATA_ROOT = PROJECT_ROOT / "freqtrade" / "user_data"
RUNTIME_CONFIG_ROOT = STATE_ROOT / "runtime_configs"
ALLOWED_DATA_SUFFIXES = {".feather", ".json", ".gz"}
ALLOWED_TIMEFRAMES = {"1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d"}
STRATEGY_PARAM_KEYS = {
    "minimal_roi",
    "stoploss",
    "trailing_stop",
    "trailing_stop_positive",
    "trailing_stop_positive_offset",
    "trailing_only_offset_is_reached",
}


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def load_runtime_config() -> dict[str, Any]:
    config = read_json(CONFIG_PATH)
    api_server = config.get("api_server", {})
    return {
        "config": config,
        "freqtrade_url": os.environ.get("FREQTRADE_API_URL", "http://127.0.0.1:8081"),
        "username": api_server.get("username", "aiquant"),
        "password": api_server.get("password", ""),
    }


def read_request_json(handler: SimpleHTTPRequestHandler) -> dict[str, Any]:
    length = int(handler.headers.get("Content-Length", "0") or 0)
    if length <= 0:
        return {}
    raw = handler.rfile.read(length)
    return json.loads(raw.decode("utf-8"))


class FreqtradeClient:
    def __init__(self, base_url: str, username: str, password: str) -> None:
        self.base_url = base_url.rstrip("/")
        token = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
        self.auth_header = f"Basic {token}"

    def request(self, method: str, path: str, payload: dict[str, Any] | None = None) -> Any:
        url = f"{self.base_url}{path}"
        body = None
        headers = {
            "Authorization": self.auth_header,
            "Accept": "application/json",
        }
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"

        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=12) as response:
                raw = response.read()
                if not raw:
                    return {"ok": True}
                return json.loads(raw.decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")
            raise RuntimeError(f"Freqtrade {method} {path} HTTP {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"无法连接 Freqtrade: {exc.reason}") from exc

    def get(self, path: str) -> Any:
        return self.request("GET", path)

    def post(self, path: str, payload: dict[str, Any] | None = None) -> Any:
        return self.request("POST", path, payload)

    def delete(self, path: str) -> Any:
        return self.request("DELETE", path)


def safe_get(client: FreqtradeClient, path: str, errors: list[str]) -> Any:
    try:
        return client.get(path)
    except RuntimeError as exc:
        errors.append(str(exc))
        return None


def safe_optional_get(client: FreqtradeClient, path: str) -> Any:
    try:
        return client.get(path)
    except RuntimeError:
        return None


def retry_freqtrade(call, attempts: int = 8, delay: float = 1.0) -> Any:
    last_error: RuntimeError | None = None
    for _ in range(attempts):
        try:
            return call()
        except RuntimeError as exc:
            last_error = exc
            if "无法连接 Freqtrade" not in str(exc):
                raise
            time.sleep(delay)
    if last_error:
        raise last_error
    raise RuntimeError("Freqtrade 调用失败")


def local_safety(config: dict[str, Any], remote_config: dict[str, Any] | None = None) -> dict[str, Any]:
    exchange = config.get("exchange", {})
    checks = [
        {
            "key": "dry_run",
            "label": "模拟交易",
            "ok": bool(config.get("dry_run")),
            "value": config.get("dry_run"),
        },
        {
            "key": "spot",
            "label": "现货模式",
            "ok": config.get("trading_mode") == "spot",
            "value": config.get("trading_mode"),
        },
        {
            "key": "sandbox",
            "label": "沙盒/测试环境",
            "ok": exchange.get("sandbox") is True,
            "value": exchange.get("sandbox"),
        },
        {
            "key": "no_keys",
            "label": "未提交 API Key",
            "ok": not exchange.get("key") and not exchange.get("secret"),
            "value": "empty" if not exchange.get("key") and not exchange.get("secret") else "present",
        },
    ]

    if remote_config:
        checks.extend(
            [
                {
                    "key": "remote_dry_run",
                    "label": "运行时 dry-run",
                    "ok": remote_config.get("dry_run") is True,
                    "value": remote_config.get("dry_run"),
                },
                {
                    "key": "remote_short",
                    "label": "禁止做空",
                    "ok": remote_config.get("short_allowed") is False,
                    "value": remote_config.get("short_allowed"),
                },
            ]
        )

    return {
        "ok": all(item["ok"] for item in checks),
        "checks": checks,
    }


def build_snapshot() -> dict[str, Any]:
    runtime = load_runtime_config()
    config = runtime["config"]
    client = FreqtradeClient(runtime["freqtrade_url"], runtime["username"], runtime["password"])
    errors: list[str] = []

    version = safe_get(client, "/api/v1/version", errors)
    show_config = safe_get(client, "/api/v1/show_config", errors)
    profit = safe_get(client, "/api/v1/profit", errors)
    balance = safe_get(client, "/api/v1/balance", errors)
    status = safe_get(client, "/api/v1/status", errors)
    performance = safe_get(client, "/api/v1/performance", errors)
    whitelist = safe_get(client, "/api/v1/whitelist", errors)
    logs = safe_get(client, "/api/v1/logs", errors)
    health = safe_get(client, "/api/v1/health", errors)
    trades_history = safe_optional_get(client, "/api/v1/trades")

    return {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "freqtrade_url": runtime["freqtrade_url"],
        "version": version,
        "show_config": show_config,
        "profit": profit,
        "balance": balance,
        "status": status if isinstance(status, list) else [],
        "performance": performance if isinstance(performance, list) else [],
        "whitelist": whitelist,
        "logs": logs,
        "health": health,
        "trades_history": trades_history,
        "local_config": summarize_local_config(config),
        "safety": local_safety(config, show_config if isinstance(show_config, dict) else None),
        "errors": errors,
    }


def summarize_local_config(config: dict[str, Any]) -> dict[str, Any]:
    exchange = config.get("exchange", {})
    return {
        "bot_name": config.get("bot_name"),
        "strategy": config.get("strategy"),
        "timeframe": config.get("timeframe"),
        "stake_currency": config.get("stake_currency"),
        "stake_amount": config.get("stake_amount"),
        "max_open_trades": config.get("max_open_trades"),
        "dry_run_wallet": config.get("dry_run_wallet"),
        "tradable_balance_ratio": config.get("tradable_balance_ratio"),
        "dry_run": config.get("dry_run"),
        "trading_mode": config.get("trading_mode"),
        "sandbox": exchange.get("sandbox"),
        "pairs": exchange.get("pair_whitelist", []),
        "public_data_url": (
            exchange.get("ccxt_config", {})
            .get("urls", {})
            .get("api", {})
            .get("public")
        ),
    }


def normalize_pair(value: str) -> str:
    raw = value.strip().upper().replace("-", "/").replace("_", "/")
    if "/" in raw:
        base, quote = raw.split("/", 1)
        return f"{base}/{quote}"
    for quote in ("USDT", "FDUSD", "USDC", "BTC", "ETH", "BNB", "EUR", "TRY", "BRL"):
        if raw.endswith(quote) and len(raw) > len(quote):
            return f"{raw[:-len(quote)]}/{quote}"
    raise ValueError("交易对格式应类似 BTC/USDT 或 BTCUSDT")


def pair_to_symbol(pair: str) -> str:
    return normalize_pair(pair).replace("/", "")


def default_watchlist() -> list[str]:
    config = load_runtime_config()["config"]
    pairs = config.get("exchange", {}).get("pair_whitelist", [])
    return [normalize_pair(pair) for pair in pairs]


def load_watchlist() -> list[str]:
    if not WATCHLIST_PATH.exists():
        return default_watchlist()
    payload = read_json(WATCHLIST_PATH)
    pairs = payload.get("pairs", [])
    if not isinstance(pairs, list):
        return default_watchlist()
    seen: set[str] = set()
    results: list[str] = []
    for pair in pairs:
        try:
            normalized = normalize_pair(str(pair))
        except ValueError:
            continue
        if normalized not in seen:
            seen.add(normalized)
            results.append(normalized)
    return results or default_watchlist()


def save_watchlist(pairs: list[str]) -> None:
    STATE_ROOT.mkdir(parents=True, exist_ok=True)
    WATCHLIST_PATH.write_text(
        json.dumps({"pairs": pairs, "updated_at": datetime.now().isoformat(timespec="seconds")}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def load_strategy_state() -> dict[str, Any]:
    config_strategy = load_runtime_config()["config"].get("strategy")
    default = {
        "applied_strategy": config_strategy,
        "disabled": [],
        "updated_at": None,
    }
    if not STRATEGY_STATE_PATH.exists():
        return default
    payload = read_json(STRATEGY_STATE_PATH)
    disabled = payload.get("disabled", [])
    if not isinstance(disabled, list):
        disabled = []
    return {
        "applied_strategy": payload.get("applied_strategy") or config_strategy,
        "disabled": sorted({str(item) for item in disabled}),
        "updated_at": payload.get("updated_at"),
    }


def save_strategy_state(state: dict[str, Any]) -> None:
    STATE_ROOT.mkdir(parents=True, exist_ok=True)
    payload = {
        "applied_strategy": state.get("applied_strategy"),
        "disabled": sorted({str(item) for item in state.get("disabled", [])}),
        "updated_at": datetime.now().isoformat(timespec="seconds"),
    }
    STRATEGY_STATE_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def sanitize_strategy_params(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("策略参数格式不正确")
    params: dict[str, Any] = {}
    if isinstance(raw.get("minimal_roi"), dict):
        roi: dict[str, float] = {}
        for key, value in raw["minimal_roi"].items():
            minute = int(str(key))
            roi[str(minute)] = float(value)
        params["minimal_roi"] = dict(sorted(roi.items(), key=lambda item: int(item[0])))
    if raw.get("stoploss") is not None:
        params["stoploss"] = float(raw["stoploss"])
    for key in (
        "trailing_stop",
        "trailing_only_offset_is_reached",
    ):
        if raw.get(key) is not None:
            params[key] = bool(raw[key])
    for key in (
        "trailing_stop_positive",
        "trailing_stop_positive_offset",
    ):
        if raw.get(key) is not None:
            params[key] = float(raw[key])
    if not params:
        raise ValueError("没有可保存的策略参数")
    return params


def load_strategy_versions() -> list[dict[str, Any]]:
    if not STRATEGY_VERSIONS_PATH.exists():
        return []
    payload = read_json(STRATEGY_VERSIONS_PATH)
    items = payload.get("items", [])
    if not isinstance(items, list):
        return []
    normalized: list[dict[str, Any]] = []
    known = known_strategy_names()
    for item in items:
        if not isinstance(item, dict):
            continue
        strategy = str(item.get("strategy") or "").strip()
        if strategy not in known:
            continue
        try:
            params = sanitize_strategy_params(item.get("params") or {})
        except Exception:
            continue
        normalized.append(
            {
                "id": str(item.get("id") or ""),
                "name": str(item.get("name") or "未命名版本"),
                "strategy": strategy,
                "params": params,
                "source_type": item.get("source_type") or "manual",
                "source_id": item.get("source_id"),
                "source_summary": item.get("source_summary") or {},
                "metrics": item.get("metrics") or {},
                "enabled": item.get("enabled", True) is not False,
                "notes": str(item.get("notes") or ""),
                "created_at": item.get("created_at"),
                "updated_at": item.get("updated_at"),
            }
        )
    return normalized


def save_strategy_versions(items: list[dict[str, Any]]) -> None:
    STATE_ROOT.mkdir(parents=True, exist_ok=True)
    STRATEGY_VERSIONS_PATH.write_text(
        json.dumps({"items": items[:200]}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def strategy_version_by_id(version_id: Any, strategy: str | None = None) -> dict[str, Any] | None:
    version_key = str(version_id or "").strip()
    if not version_key:
        return None
    for item in load_strategy_versions():
        if item.get("id") != version_key:
            continue
        if strategy and item.get("strategy") != strategy:
            raise ValueError("策略版本与当前策略不匹配")
        if item.get("enabled") is False:
            raise ValueError("策略版本已禁用")
        return item
    raise ValueError("没有找到指定策略版本")


def apply_strategy_param_overrides(config: dict[str, Any], version: dict[str, Any] | None) -> None:
    for key in STRATEGY_PARAM_KEYS:
        config.pop(key, None)
    if not version:
        return
    for key, value in (version.get("params") or {}).items():
        if key in STRATEGY_PARAM_KEYS:
            config[key] = value


def strategy_version_payload(version: dict[str, Any] | None) -> dict[str, Any] | None:
    if not version:
        return None
    return {
        "id": version.get("id"),
        "name": version.get("name"),
        "strategy": version.get("strategy"),
        "params": version.get("params") or {},
    }


def create_strategy_version(payload: dict[str, Any]) -> dict[str, Any]:
    source_type = str(payload.get("source_type") or "manual").strip()
    source_id = str(payload.get("source_id") or payload.get("hyperopt_id") or "").strip()
    now = datetime.now().isoformat(timespec="seconds")
    source_summary: dict[str, Any] = {}
    metrics: dict[str, Any] = {}
    if source_type == "hyperopt":
        record = next((item for item in load_hyperopt_history() if str(item.get("id")) == source_id), None)
        if not record:
            raise ValueError("没有找到指定参数优化记录")
        if record.get("ok") is False:
            raise ValueError("失败的参数优化记录不能保存为版本")
        requested = record.get("requested") or {}
        strategy = str(requested.get("strategy") or "").strip()
        params = sanitize_strategy_params(record.get("params") or {})
        metrics = record.get("metrics") or {}
        source_summary = {
            "pair": requested.get("pair"),
            "timeframe": requested.get("timeframe"),
            "start": requested.get("start"),
            "end": requested.get("end"),
            "epochs": requested.get("epochs"),
            "loss": requested.get("loss"),
            "spaces": requested.get("spaces") or [],
        }
        default_name = f"{strategy} 优化版 {now.replace('T', ' ')}"
    else:
        strategy = str(payload.get("strategy") or "").strip()
        params = sanitize_strategy_params(payload.get("params") or {})
        default_name = f"{strategy} 手动版 {now.replace('T', ' ')}"
    if strategy not in known_strategy_names():
        raise ValueError(f"策略不存在: {strategy}")
    name = str(payload.get("name") or default_name).strip()
    item = {
        "id": datetime.now().strftime("%Y%m%d-%H%M%S"),
        "name": name[:80],
        "strategy": strategy,
        "params": params,
        "source_type": source_type,
        "source_id": source_id or None,
        "source_summary": source_summary,
        "metrics": metrics,
        "enabled": True,
        "notes": str(payload.get("notes") or ""),
        "created_at": now,
        "updated_at": now,
    }
    history = [item] + load_strategy_versions()
    save_strategy_versions(history)
    return {"ok": True, "item": item, "items": history}


def update_strategy_version(payload: dict[str, Any]) -> dict[str, Any]:
    version_id = str(payload.get("id") or "").strip()
    action = str(payload.get("action") or "").strip()
    items = load_strategy_versions()
    target = next((item for item in items if item.get("id") == version_id), None)
    if not target:
        raise ValueError("没有找到指定策略版本")
    if action == "delete":
        kept = [item for item in items if item.get("id") != version_id]
        save_strategy_versions(kept)
        return {"ok": True, "items": kept}
    if action == "enable":
        target["enabled"] = True
    elif action == "disable":
        target["enabled"] = False
    elif action == "rename":
        name = str(payload.get("name") or "").strip()
        if not name:
            raise ValueError("版本名称不能为空")
        target["name"] = name[:80]
    else:
        raise ValueError("未知策略版本操作")
    target["updated_at"] = datetime.now().isoformat(timespec="seconds")
    save_strategy_versions(items)
    return {"ok": True, "item": target, "items": items}


def strategy_file_for_class(class_name: str) -> Path:
    for item in list_strategies():
        if item.get("class_name") == class_name:
            return PROJECT_ROOT / str(item.get("file", ""))
    raise ValueError(f"没有找到策略文件: {class_name}")


def optimized_strategy_class_name(base: str, preferred: str | None = None) -> str:
    if preferred:
        return strategy_class_name(preferred)
    stem = re.sub(r"[^A-Za-z0-9_]", "", base)
    if not stem or not stem[0].isalpha():
        stem = "OptimizedStrategy"
    candidate = f"{stem}Opt{datetime.now().strftime('%Y%m%d%H%M%S')}"
    return strategy_class_name(candidate[:60])


def render_strategy_value(value: Any, indent: int = 4) -> str:
    return json.dumps(value, ensure_ascii=False, indent=indent).replace("true", "True").replace("false", "False").replace("null", "None")


def export_strategy_version_to_strategy(payload: dict[str, Any]) -> dict[str, Any]:
    version_id = str(payload.get("id") or "").strip()
    version = next((item for item in load_strategy_versions() if item.get("id") == version_id), None)
    if not version:
        raise ValueError("没有找到指定策略版本")
    if version.get("enabled") is False:
        raise ValueError("策略版本已禁用，不能添加到策略库")
    base_strategy = str(version.get("strategy") or "").strip()
    base_file = strategy_file_for_class(base_strategy)
    class_name = optimized_strategy_class_name(base_strategy, str(payload.get("class_name") or "").strip() or None)
    target = STRATEGIES_ROOT / f"{class_name}.py"
    if target.exists():
        raise ValueError(f"策略文件已存在: {target.name}")
    params = sanitize_strategy_params(version.get("params") or {})
    source = version.get("source_summary") or {}
    description = (
        f"Optimized strategy generated by aiquant from {base_strategy}.\n\n"
        f"Source version: {version.get('name')}\n"
        f"Source range: {source.get('pair') or '--'} {source.get('timeframe') or '--'} "
        f"{source.get('start') or '--'} to {source.get('end') or '--'}\n"
        "The buy/sell logic is inherited from the base strategy; only risk parameters are overridden."
    )
    lines = [
        f"from {base_file.stem} import {base_strategy}",
        "",
        "",
        f"class {class_name}({base_strategy}):",
        f'    """{description}"""',
        "",
    ]
    for key in (
        "minimal_roi",
        "stoploss",
        "trailing_stop",
        "trailing_stop_positive",
        "trailing_stop_positive_offset",
        "trailing_only_offset_is_reached",
    ):
        if key in params:
            rendered = render_strategy_value(params[key])
            rendered = rendered.replace("\n", "\n    ")
            lines.append(f"    {key} = {rendered}")
    lines.append("")
    target.write_text("\n".join(lines), encoding="utf-8")
    state = load_strategy_state()
    disabled = set(state.get("disabled", []))
    disabled.discard(class_name)
    state["disabled"] = sorted(disabled)
    save_strategy_state(state)
    return {
        "ok": True,
        "strategy": class_name,
        "file": str(target.relative_to(PROJECT_ROOT)).replace("\\", "/"),
        "items": list_strategies(),
    }


def write_effective_config(
    strategy: str,
    pair: str,
    timeframe: str,
    version: dict[str, Any] | None,
    prefix: str,
) -> Path:
    config = json.loads(json.dumps(load_runtime_config()["config"]))
    config["strategy"] = strategy
    if timeframe:
        config["timeframe"] = timeframe
    exchange = config.setdefault("exchange", {})
    exchange["pair_whitelist"] = [pair]
    apply_strategy_param_overrides(config, version)
    RUNTIME_CONFIG_ROOT.mkdir(parents=True, exist_ok=True)
    path = RUNTIME_CONFIG_ROOT / f"{prefix}-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
    write_json(path, config)
    return path


def save_runtime_config(config: dict[str, Any]) -> None:
    write_json(CONFIG_PATH, config)


def known_strategy_names() -> set[str]:
    return {
        str(item.get("class_name") or item.get("name"))
        for item in list_strategies()
        if item.get("class_name") or item.get("name")
    }


def strategy_info_by_name(name: str) -> dict[str, Any]:
    for item in list_strategies():
        if item.get("class_name") == name or item.get("name") == name:
            return item
    raise ValueError(f"策略不存在: {name}")


def update_strategy_state(action: str, strategy: str) -> dict[str, Any]:
    name = strategy.strip()
    if name not in known_strategy_names():
        raise ValueError(f"策略不存在: {name}")
    state = load_strategy_state()
    disabled = set(state.get("disabled", []))
    if action == "apply":
        disabled.discard(name)
        state["applied_strategy"] = name
    elif action == "disable":
        disabled.add(name)
        if state.get("applied_strategy") == name:
            state["applied_strategy"] = load_runtime_config()["config"].get("strategy")
    elif action == "enable":
        disabled.discard(name)
    else:
        raise ValueError("未知策略操作")
    state["disabled"] = sorted(disabled)
    save_strategy_state(state)
    return {"ok": True, "state": load_strategy_state()}


def remote_strategy_name(remote_config: dict[str, Any] | None) -> str | None:
    if not isinstance(remote_config, dict):
        return None
    for key in ("strategy", "strategy_name", "strategy_name_actual"):
        value = remote_config.get(key)
        if value:
            return str(value)
    return None


def remote_whitelist_pairs(payload: Any) -> list[str]:
    if isinstance(payload, dict):
        pairs = payload.get("whitelist") or payload.get("pairs") or payload.get("pair_whitelist") or []
    elif isinstance(payload, list):
        pairs = payload
    else:
        pairs = []
    result: list[str] = []
    for pair in pairs:
        try:
            result.append(normalize_pair(str(pair)))
        except ValueError:
            continue
    return result


def update_watchlist(action: str, pair: str) -> dict[str, Any]:
    normalized = normalize_pair(pair)
    pairs = load_watchlist()
    if action == "add" and normalized not in pairs:
        pairs.append(normalized)
    elif action == "remove":
        pairs = [item for item in pairs if item != normalized]
    elif action not in {"add", "remove"}:
        raise ValueError("未知自选操作")
    save_watchlist(pairs)
    selected = normalized if action == "add" else (pairs[0] if pairs else None)
    return {"ok": True, "pairs": pairs, "selected": selected}


def market_base_url() -> str:
    config = load_runtime_config()["config"]
    public_url = (
        config.get("exchange", {})
        .get("ccxt_config", {})
        .get("urls", {})
        .get("api", {})
        .get("public")
    )
    return str(public_url or "https://data-api.binance.vision/api/v3").rstrip("/")


def market_get(endpoint: str, params: dict[str, Any]) -> Any:
    query = urlencode({k: v for k, v in params.items() if v not in (None, "")})
    url = f"{market_base_url()}/{endpoint.lstrip('/')}"
    if query:
        url = f"{url}?{query}"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=12) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        raise RuntimeError(f"Binance market {endpoint} HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"无法连接 Binance market API: {exc.reason}") from exc


def get_market_klines(symbol: str, interval: str, limit: int) -> dict[str, Any]:
    safe_limit = max(2, min(int(limit or 160), 500))
    safe_interval = interval or "1h"
    safe_symbol = pair_to_symbol(symbol)
    rows = market_get(
        "klines",
        {
            "symbol": safe_symbol,
            "interval": safe_interval,
            "limit": safe_limit,
        },
    )
    candles = [
        {
            "open_time": row[0],
            "open": float(row[1]),
            "high": float(row[2]),
            "low": float(row[3]),
            "close": float(row[4]),
            "volume": float(row[5]),
            "close_time": row[6],
        }
        for row in rows
    ]
    return {
        "pair": normalize_pair(symbol),
        "symbol": safe_symbol,
        "interval": safe_interval,
        "limit": safe_limit,
        "candles": candles,
    }


def get_market_ticker(symbol: str) -> dict[str, Any]:
    safe_symbol = pair_to_symbol(symbol)
    ticker = market_get("ticker/24hr", {"symbol": safe_symbol})
    return {
        "pair": normalize_pair(symbol),
        "symbol": safe_symbol,
        "last": float(ticker.get("lastPrice", 0)),
        "change_pct": float(ticker.get("priceChangePercent", 0)),
        "high": float(ticker.get("highPrice", 0)),
        "low": float(ticker.get("lowPrice", 0)),
        "volume": float(ticker.get("volume", 0)),
        "quote_volume": float(ticker.get("quoteVolume", 0)),
    }


def parse_backtest_table(markdown: str) -> dict[str, Any] | None:
    rows = [line.strip() for line in markdown.splitlines() if line.strip().startswith("|")]
    for row in rows:
        if "---" in row or "Strategy" in row:
            continue
        cells = [cell.strip() for cell in row.strip("|").split("|")]
        if len(cells) >= 7:
            return {
                "strategy": cells[0],
                "trades": cells[1],
                "profit": cells[2],
                "profit_abs": cells[3],
                "drawdown": cells[4],
                "win_rate": cells[5],
                "profit_factor": cells[6],
            }
    return None


def pct_value(value: Any) -> str:
    if value is None:
        return "--"
    try:
        return f"{float(value) * 100:.2f}%"
    except (TypeError, ValueError):
        return str(value)


def number_value(value: Any, digits: int = 4) -> str:
    if value is None:
        return "--"
    try:
        return f"{float(value):.{digits}f}"
    except (TypeError, ValueError):
        return str(value)


def metric_value(result: dict[str, Any], *names: str) -> Any:
    for name in names:
        if name in result:
            return result[name]
    return None


def float_or_none(value: Any) -> float | None:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def downsample_points(items: list[dict[str, Any]], limit: int = 260) -> list[dict[str, Any]]:
    if len(items) <= limit:
        return items
    step = max(1, len(items) // limit)
    sampled = items[::step]
    if sampled[-1] != items[-1]:
        sampled.append(items[-1])
    return sampled


def load_backtest_payload(path: Path) -> dict[str, Any]:
    if path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path) as archive:
            candidates = [
                name
                for name in archive.namelist()
                if name.endswith(".json") and not name.endswith("_config.json")
            ]
            if not candidates:
                raise RuntimeError(f"回测结果中没有 JSON: {path}")
            return json.loads(archive.read(candidates[0]).decode("utf-8-sig"))
    return read_json(path)


def summarize_backtest_result(path: Path, requested: dict[str, Any]) -> dict[str, Any]:
    payload = load_backtest_payload(path)
    strategies = payload.get("strategy", {})
    if isinstance(strategies, dict) and strategies:
        strategy_name = requested.get("strategy") or next(iter(strategies))
        result = strategies.get(strategy_name) or next(iter(strategies.values()))
    else:
        strategy_name = requested.get("strategy") or "backtest"
        result = payload
    if not isinstance(result, dict):
        result = {}

    winrate = metric_value(result, "winrate", "win_rate")
    metrics = {
        "strategy": strategy_name,
        "trades": metric_value(result, "total_trades", "trades") or 0,
        "profit": pct_value(metric_value(result, "profit_total", "profit_total_pct")),
        "profit_abs": number_value(metric_value(result, "profit_total_abs", "profit_abs")),
        "drawdown": pct_value(metric_value(result, "max_relative_drawdown", "max_drawdown")),
        "win_rate": pct_value(winrate),
        "profit_factor": number_value(metric_value(result, "profit_factor")),
        "start_balance": number_value(metric_value(result, "starting_balance", "dry_run_wallet"), 2),
        "final_balance": number_value(metric_value(result, "final_balance"), 2),
        "market_change": pct_value(metric_value(result, "market_change")),
    }
    return {
        "id": datetime.now().strftime("%Y%m%d-%H%M%S"),
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "file": str(path.relative_to(PROJECT_ROOT)).replace("\\", "/"),
        "name": path.stem,
        "source": str(path.relative_to(PROJECT_ROOT)).replace("\\", "/"),
        "requested": requested,
        "metrics": metrics,
    }


def strategy_result_from_payload(payload: dict[str, Any], strategy_name: str | None = None) -> tuple[str, dict[str, Any]]:
    strategies = payload.get("strategy", {})
    if isinstance(strategies, dict) and strategies:
        if strategy_name and strategy_name in strategies and isinstance(strategies[strategy_name], dict):
            return strategy_name, strategies[strategy_name]
        first_name, first_result = next(iter(strategies.items()))
        return str(first_name), first_result if isinstance(first_result, dict) else {}
    return strategy_name or "backtest", payload


def resolve_backtest_source(source: str) -> Path:
    raw = str(source or "").replace("\\", "/").strip()
    if not raw:
        raise ValueError("该回测记录没有可读取的结果文件")
    target = (PROJECT_ROOT / raw).resolve()
    if not str(target).startswith(str(PROJECT_ROOT.resolve())):
        raise ValueError("回测结果文件路径不安全")
    if not target.exists() or not target.is_file():
        raise ValueError("回测结果文件不存在")
    if target.suffix.lower() not in {".zip", ".json"}:
        raise ValueError("该记录不是 Freqtrade 原始回测结果，暂不能展示详情")
    return target


def build_equity_curve(result: dict[str, Any], trades: list[dict[str, Any]]) -> list[dict[str, Any]]:
    start_balance = float_or_none(metric_value(result, "starting_balance", "dry_run_wallet")) or 0
    daily_profit = result.get("daily_profit")
    if isinstance(daily_profit, list) and daily_profit:
        balance = start_balance
        points: list[dict[str, Any]] = []
        for row in daily_profit:
            if not isinstance(row, list) or len(row) < 2:
                continue
            profit = float_or_none(row[1]) or 0
            balance += profit
            points.append({"time": str(row[0]), "equity": round(balance, 8), "profit": round(balance - start_balance, 8)})
        return downsample_points(points)

    balance = start_balance
    points = []
    closed = sorted(
        [trade for trade in trades if trade.get("close_timestamp") or trade.get("close_date")],
        key=lambda trade: trade.get("close_timestamp") or trade.get("close_date") or "",
    )
    for trade in closed:
        balance += float_or_none(trade.get("profit_abs")) or 0
        points.append(
            {
                "time": trade.get("close_date") or trade.get("close_timestamp") or trade.get("open_date") or "",
                "equity": round(balance, 8),
                "profit": round(balance - start_balance, 8),
            }
        )
    return downsample_points(points)


def compact_stat_rows(rows: Any, limit: int = 12) -> list[dict[str, Any]]:
    if not isinstance(rows, list):
        return []
    compact: list[dict[str, Any]] = []
    for row in rows[:limit]:
        if not isinstance(row, dict):
            continue
        compact.append(
            {
                "key": row.get("key", "--"),
                "trades": row.get("trades", 0),
                "profit_total": row.get("profit_total"),
                "profit_total_abs": row.get("profit_total_abs"),
                "winrate": row.get("winrate"),
                "profit_factor": row.get("profit_factor"),
                "duration_avg": row.get("duration_avg"),
            }
        )
    return compact


def compact_trades(trades: list[dict[str, Any]], limit: int = 240) -> list[dict[str, Any]]:
    sorted_trades = sorted(
        trades,
        key=lambda trade: trade.get("close_timestamp") or trade.get("open_timestamp") or 0,
        reverse=True,
    )
    return [
        {
            "pair": trade.get("pair"),
            "open_date": trade.get("open_date"),
            "close_date": trade.get("close_date"),
            "open_rate": trade.get("open_rate"),
            "close_rate": trade.get("close_rate"),
            "stake_amount": trade.get("stake_amount"),
            "profit_ratio": trade.get("profit_ratio"),
            "profit_abs": trade.get("profit_abs"),
            "duration": trade.get("trade_duration"),
            "exit_reason": trade.get("exit_reason"),
            "enter_tag": trade.get("enter_tag"),
            "is_open": trade.get("is_open"),
        }
        for trade in sorted_trades[:limit]
        if isinstance(trade, dict)
    ]


def backtest_detail(record_id: str) -> dict[str, Any]:
    record = next((item for item in load_backtest_history() if str(item.get("id")) == str(record_id)), None)
    if not record:
        raise ValueError("没有找到这条回测记录")
    source = record.get("source") or record.get("file")
    path = resolve_backtest_source(str(source or ""))
    requested = record.get("requested", {}) if isinstance(record.get("requested"), dict) else {}
    preferred_strategy = str(requested.get("strategy") or record.get("metrics", {}).get("strategy") or "")
    payload = load_backtest_payload(path)
    strategy_name, result = strategy_result_from_payload(payload, preferred_strategy)
    trades = result.get("trades", [])
    if not isinstance(trades, list):
        trades = []

    summary = {
        "strategy": strategy_name,
        "strategy_version": requested.get("strategy_version"),
        "pair": requested.get("pair") or ", ".join(result.get("pairlist", []) if isinstance(result.get("pairlist"), list) else []),
        "timeframe": requested.get("timeframe") or result.get("timeframe"),
        "timerange": result.get("timerange"),
        "start": requested.get("start") or result.get("backtest_start"),
        "end": requested.get("end") or result.get("backtest_end"),
        "total_trades": metric_value(result, "total_trades"),
        "profit_total": metric_value(result, "profit_total"),
        "profit_total_abs": metric_value(result, "profit_total_abs"),
        "max_drawdown": metric_value(result, "max_relative_drawdown", "max_drawdown_account"),
        "max_drawdown_abs": metric_value(result, "max_drawdown_abs"),
        "winrate": metric_value(result, "winrate"),
        "profit_factor": metric_value(result, "profit_factor"),
        "sharpe": metric_value(result, "sharpe"),
        "sortino": metric_value(result, "sortino"),
        "expectancy": metric_value(result, "expectancy"),
        "trades_per_day": metric_value(result, "trades_per_day"),
        "starting_balance": metric_value(result, "starting_balance", "dry_run_wallet"),
        "final_balance": metric_value(result, "final_balance"),
        "market_change": metric_value(result, "market_change"),
        "best_pair": result.get("best_pair"),
        "worst_pair": result.get("worst_pair"),
    }
    return {
        "ok": True,
        "id": record_id,
        "record": record,
        "source": str(path.relative_to(PROJECT_ROOT)).replace("\\", "/"),
        "summary": summary,
        "equity_curve": build_equity_curve(result, trades),
        "pair_stats": compact_stat_rows(result.get("results_per_pair")),
        "exit_reasons": compact_stat_rows(result.get("exit_reason_summary")),
        "trades": compact_trades(trades),
        "trade_count": len(trades),
    }


def load_backtest_history() -> list[dict[str, Any]]:
    if not BACKTEST_HISTORY_PATH.exists():
        return []
    payload = read_json(BACKTEST_HISTORY_PATH)
    items = payload.get("items", [])
    return items if isinstance(items, list) else []


def save_backtest_history(items: list[dict[str, Any]]) -> None:
    STATE_ROOT.mkdir(parents=True, exist_ok=True)
    BACKTEST_HISTORY_PATH.write_text(
        json.dumps({"items": items[:100]}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def load_hyperopt_history() -> list[dict[str, Any]]:
    if not HYPEROPT_HISTORY_PATH.exists():
        return []
    payload = read_json(HYPEROPT_HISTORY_PATH)
    items = payload.get("items", [])
    if not isinstance(items, list):
        return []
    for item in items:
        if not isinstance(item, dict) or item.get("result_path"):
            continue
        saved = re.search(r"epochs? saved to '(.+?\.fthypt)'", item.get("stdout_tail") or "")
        if saved:
            item["result_path"] = saved.group(1).replace("/workspace/", "").replace("\\", "/")
    return items


def save_hyperopt_history(items: list[dict[str, Any]]) -> None:
    STATE_ROOT.mkdir(parents=True, exist_ok=True)
    HYPEROPT_HISTORY_PATH.write_text(
        json.dumps({"items": items[:100]}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def load_simulation_state() -> dict[str, Any] | None:
    if not SIMULATION_STATE_PATH.exists():
        return None
    payload = read_json(SIMULATION_STATE_PATH)
    return payload if payload.get("active") else None


def save_simulation_state(state: dict[str, Any] | None) -> None:
    STATE_ROOT.mkdir(parents=True, exist_ok=True)
    if state is None:
        SIMULATION_STATE_PATH.write_text(json.dumps({"active": False}, ensure_ascii=False, indent=2), encoding="utf-8")
        return
    SIMULATION_STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def load_simulation_history() -> list[dict[str, Any]]:
    if not SIMULATION_HISTORY_PATH.exists():
        return []
    payload = read_json(SIMULATION_HISTORY_PATH)
    items = payload.get("items", [])
    return items if isinstance(items, list) else []


def save_simulation_history(items: list[dict[str, Any]]) -> None:
    STATE_ROOT.mkdir(parents=True, exist_ok=True)
    SIMULATION_HISTORY_PATH.write_text(
        json.dumps({"items": items[:100]}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def simulation_detail(record_id: str) -> dict[str, Any]:
    record_id = str(record_id).strip()
    if not record_id:
        raise ValueError("缺少模拟交易记录 ID")
    record = next((item for item in load_simulation_history() if str(item.get("id")) == record_id), None)
    if not record:
        raise ValueError("未找到这条模拟交易记录")
    return {"record": record}


def collect_simulation_detail_snapshot(client: FreqtradeClient) -> dict[str, Any]:
    logs = safe_optional_get(client, "/api/v1/logs")
    if isinstance(logs, dict) and isinstance(logs.get("logs"), list):
        logs = {**logs, "logs": logs["logs"][-500:]}
    return {
        "collected_at": datetime.now().isoformat(timespec="seconds"),
        "status": safe_optional_get(client, "/api/v1/status"),
        "trades_history": safe_optional_get(client, "/api/v1/trades"),
        "performance": safe_optional_get(client, "/api/v1/performance"),
        "logs": logs,
    }


def delete_history_record(kind: str, record_id: str) -> dict[str, Any]:
    record_id = record_id.strip()
    if not record_id:
        raise ValueError("缺少记录 ID")

    if kind == "backtest":
        items = load_backtest_history()
        kept = [item for item in items if str(item.get("id", "")) != record_id]
        if len(kept) == len(items):
            raise ValueError("未找到这条回测记录，可能它已经被删除。")
        save_backtest_history(kept)
        return {"ok": True, "type": kind, "id": record_id, "deleted": len(items) - len(kept), "items": kept}

    if kind == "simulation":
        items = load_simulation_history()
        kept = [item for item in items if str(item.get("id", "")) != record_id]
        if len(kept) == len(items):
            raise ValueError("未找到这条模拟交易记录，可能它已经被删除。")
        save_simulation_history(kept)
        return {"ok": True, "type": kind, "id": record_id, "deleted": len(items) - len(kept), "items": kept}

    if kind == "hyperopt":
        items = load_hyperopt_history()
        kept = [item for item in items if str(item.get("id", "")) != record_id]
        if len(kept) == len(items):
            raise ValueError("未找到这条参数优化记录，可能它已经被删除。")
        save_hyperopt_history(kept)
        return {"ok": True, "type": kind, "id": record_id, "deleted": len(items) - len(kept), "items": kept}

    raise ValueError("未知历史记录类型")


def runtime_profit_baseline(client: FreqtradeClient) -> dict[str, Any]:
    profit = client.get("/api/v1/profit")
    balance = client.get("/api/v1/balance")
    currencies = balance.get("currencies", []) if isinstance(balance, dict) else []
    usdt = next((item for item in currencies if item.get("currency") == "USDT"), {}) if isinstance(currencies, list) else {}
    return {
        "profit_abs": profit.get("profit_all_coin", profit.get("profit_closed_coin", 0)) if isinstance(profit, dict) else 0,
        "profit_ratio": profit.get("profit_all_ratio", profit.get("profit_closed_ratio", 0)) if isinstance(profit, dict) else 0,
        "trade_count": profit.get("trade_count", profit.get("closed_trade_count", 0)) if isinstance(profit, dict) else 0,
        "balance": usdt.get("balance"),
    }


def simulation_metrics(active: dict[str, Any] | None) -> dict[str, Any]:
    if not active:
        return {}
    runtime = load_runtime_config()
    client = FreqtradeClient(runtime["freqtrade_url"], runtime["username"], runtime["password"])
    baseline = runtime_profit_baseline(client)
    started_at = datetime.fromisoformat(active["started_at"])
    duration = max(0, int((datetime.now() - started_at).total_seconds()))
    start_profit = float(active.get("start_profit_abs") or 0)
    start_trades = int(active.get("start_trade_count") or 0)
    return {
        "duration_seconds": duration,
        "profit_abs": float(baseline.get("profit_abs") or 0) - start_profit,
        "profit_ratio": float(baseline.get("profit_ratio") or 0) - float(active.get("start_profit_ratio") or 0),
        "trade_count": int(baseline.get("trade_count") or 0) - start_trades,
        "balance": baseline.get("balance"),
    }


def simulation_status() -> dict[str, Any]:
    active = load_simulation_state()
    metrics: dict[str, Any] = {}
    error = None
    if active:
        try:
            metrics = simulation_metrics(active)
        except RuntimeError as exc:
            error = str(exc)
    return {
        "active": active,
        "metrics": metrics,
        "history": load_simulation_history(),
        "error": error,
    }


def open_trades(client: FreqtradeClient) -> list[dict[str, Any]]:
    status = client.get("/api/v1/status")
    return status if isinstance(status, list) else []


def cleanup_unfilled_dryrun_orders(client: FreqtradeClient) -> list[dict[str, Any]]:
    cleaned: list[dict[str, Any]] = []
    for trade in open_trades(client):
        trade_id = trade.get("trade_id")
        amount = float(trade.get("amount") or 0)
        has_open_orders = bool(trade.get("has_open_orders"))
        if not trade_id or amount != 0 or not has_open_orders:
            continue
        cancel_result = None
        try:
            cancel_result = client.delete(f"/api/v1/trades/{trade_id}/open-order")
        except RuntimeError as exc:
            if "trader is not running" not in str(exc):
                raise
        delete_result = client.delete(f"/api/v1/trades/{trade_id}")
        cleaned.append(
            {
                "trade_id": trade_id,
                "pair": trade.get("pair"),
                "cancel_result": cancel_result,
                "delete_result": delete_result,
            }
        )
    return cleaned


def force_exit_open_positions(client: FreqtradeClient) -> dict[str, Any]:
    cleaned_orders = cleanup_unfilled_dryrun_orders(client)
    exited: list[dict[str, Any]] = []
    errors: list[str] = []
    for trade in open_trades(client):
        trade_id = trade.get("trade_id")
        amount = float(trade.get("amount") or 0)
        if not trade_id or amount <= 0:
            continue
        try:
            result = client.post(
                "/api/v1/forceexit",
                {
                    "tradeid": trade_id,
                    "ordertype": "market",
                },
            )
            exited.append({"trade_id": trade_id, "pair": trade.get("pair"), "result": result})
        except RuntimeError as exc:
            errors.append(f"Trade {trade_id} {trade.get('pair')}: {exc}")
    return {
        "cleaned_orders": cleaned_orders,
        "exited": exited,
        "errors": errors,
    }


def numeric_equal(left: Any, right: Any) -> bool:
    try:
        return abs(float(left) - float(right)) < 0.0000001
    except (TypeError, ValueError):
        return left == right


def positive_float(value: Any, label: str) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{label} 必须是数字") from exc
    if result <= 0:
        raise ValueError(f"{label} 必须大于 0")
    return result


def positive_int(value: Any, label: str) -> int:
    result = int(positive_float(value, label))
    if result < 1:
        raise ValueError(f"{label} 至少为 1")
    return result


def simulation_capital_settings(payload: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    dry_run_wallet = positive_float(payload.get("dry_run_wallet", config.get("dry_run_wallet", 10000)), "模拟钱包")
    stake_amount = positive_float(payload.get("stake_amount", config.get("stake_amount", 100)), "单笔投入")
    max_open_trades = positive_int(payload.get("max_open_trades", config.get("max_open_trades", 1)), "最大同时持仓")
    tradable_balance_ratio = positive_float(
        payload.get("tradable_balance_ratio", config.get("tradable_balance_ratio", 0.99)),
        "可交易资金比例",
    )
    if tradable_balance_ratio > 1:
        raise ValueError("可交易资金比例不能超过 1")
    usable_balance = dry_run_wallet * tradable_balance_ratio
    max_exposure = stake_amount * max_open_trades
    if max_exposure > usable_balance:
        raise ValueError(
            f"最大可能占用 {max_exposure:.2f} 超过可交易模拟资金 {usable_balance:.2f}，请调低单笔投入或最大持仓数。"
        )
    return {
        "dry_run_wallet": round(dry_run_wallet, 8),
        "stake_amount": round(stake_amount, 8),
        "max_open_trades": max_open_trades,
        "tradable_balance_ratio": round(tradable_balance_ratio, 8),
        "usable_balance": round(usable_balance, 8),
        "max_exposure": round(max_exposure, 8),
    }


def configure_runtime_session(
    client: FreqtradeClient,
    strategy: str,
    pair: str,
    capital_settings: dict[str, Any] | None = None,
    strategy_version_id: Any = None,
) -> dict[str, Any]:
    info = strategy_info_by_name(strategy)
    if info.get("disabled"):
        raise ValueError(f"策略已被禁用: {strategy}")
    version = strategy_version_by_id(strategy_version_id, strategy)

    cleaned_orders = cleanup_unfilled_dryrun_orders(client)
    opened = open_trades(client)
    if opened:
        raise ValueError("当前 dry-run 存在打开持仓，请先关闭持仓或结束当前测试后再切换策略。")

    runtime = load_runtime_config()
    config = runtime["config"]
    current_strategy = config.get("strategy")
    current_timeframe = config.get("timeframe")
    current_pairs = list(config.get("exchange", {}).get("pair_whitelist", []))
    target_timeframe = info.get("timeframe") or current_timeframe
    capital_settings = capital_settings or {}
    target_capital = {
        "dry_run_wallet": capital_settings.get("dry_run_wallet", config.get("dry_run_wallet")),
        "stake_amount": capital_settings.get("stake_amount", config.get("stake_amount")),
        "max_open_trades": capital_settings.get("max_open_trades", config.get("max_open_trades")),
        "tradable_balance_ratio": capital_settings.get("tradable_balance_ratio", config.get("tradable_balance_ratio")),
    }
    capital_matches = all(numeric_equal(config.get(key), value) for key, value in target_capital.items())
    target_params = (version or {}).get("params") or {}
    current_params = {key: config.get(key) for key in STRATEGY_PARAM_KEYS if key in config}
    param_matches = current_params == target_params

    remote_before = client.get("/api/v1/show_config")
    whitelist_before = client.get("/api/v1/whitelist")
    safety = local_safety(config, remote_before if isinstance(remote_before, dict) else None)
    if not safety["ok"]:
        return {
            "ok": False,
            "blocked": True,
            "message": "安全检查未通过，已拒绝切换运行策略。",
            "safety": safety,
        }

    actual_strategy_before = remote_strategy_name(remote_before)
    actual_timeframe_before = remote_before.get("timeframe") if isinstance(remote_before, dict) else None
    actual_pairs_before = remote_whitelist_pairs(whitelist_before)
    already_configured = (
        current_strategy == strategy
        and current_timeframe == target_timeframe
        and current_pairs == [pair]
        and capital_matches
        and actual_strategy_before == strategy
        and actual_timeframe_before == target_timeframe
        and actual_pairs_before == [pair]
        and param_matches
    )
    if already_configured:
        state = load_strategy_state()
        state["applied_strategy"] = strategy
        save_strategy_state(state)
        return {
            "ok": True,
            "changed": False,
            "strategy": strategy,
            "timeframe": target_timeframe,
            "pairs": [pair],
            "capital": target_capital,
            "strategy_version": strategy_version_payload(version),
            "cleaned_orders": cleaned_orders,
            "reload_result": None,
            "remote_config": remote_before,
            "remote_whitelist": whitelist_before,
        }

    config["strategy"] = strategy
    if target_timeframe:
        config["timeframe"] = target_timeframe
    for key, value in target_capital.items():
        config[key] = value
    apply_strategy_param_overrides(config, version)
    exchange = config.setdefault("exchange", {})
    exchange["pair_whitelist"] = [pair]
    save_runtime_config(config)

    reload_result = client.post("/api/v1/reload_config")
    time.sleep(1.5)
    remote_after = retry_freqtrade(lambda: client.get("/api/v1/show_config"), attempts=12, delay=1.0)
    whitelist_after = retry_freqtrade(lambda: client.get("/api/v1/whitelist"), attempts=12, delay=1.0)
    actual_strategy = remote_strategy_name(remote_after)
    actual_timeframe = remote_after.get("timeframe") if isinstance(remote_after, dict) else None
    actual_pairs = remote_whitelist_pairs(whitelist_after)

    strategy_ok = actual_strategy == strategy
    timeframe_ok = not target_timeframe or actual_timeframe == target_timeframe
    pair_ok = actual_pairs == [pair]
    if not strategy_ok or not timeframe_ok or not pair_ok:
        return {
            "ok": False,
            "blocked": True,
            "message": "运行配置已写入，但 Freqtrade 运行时未确认策略/交易对切换成功。请重启 Freqtrade 容器后再启动模拟交易。",
            "requested": {
                "strategy": strategy,
                "timeframe": target_timeframe,
                "pairs": [pair],
            },
            "actual": {
                "strategy": actual_strategy,
                "timeframe": actual_timeframe,
                "pairs": actual_pairs,
            },
            "reload_result": reload_result,
        }

    state = load_strategy_state()
    state["applied_strategy"] = strategy
    save_strategy_state(state)

    return {
        "ok": True,
        "changed": current_strategy != strategy or current_timeframe != target_timeframe or current_pairs != [pair] or not capital_matches or not param_matches,
        "strategy": strategy,
        "strategy_version": strategy_version_payload(version),
        "timeframe": target_timeframe,
        "pairs": [pair],
        "capital": target_capital,
        "cleaned_orders": cleaned_orders,
        "reload_result": reload_result,
        "remote_config": remote_after,
        "remote_whitelist": whitelist_after,
    }


def start_simulation(payload: dict[str, Any]) -> dict[str, Any]:
    strategy = str(payload.get("strategy", "")).strip()
    strategy_version_id = str(payload.get("strategy_version_id") or "").strip()
    pair = normalize_pair(str(payload.get("pair", "")))
    if load_simulation_state():
        raise ValueError("已有模拟交易会话正在运行，请先关闭当前会话。")
    if strategy not in known_strategy_names():
        raise ValueError(f"策略不存在: {strategy}")
    if pair not in load_watchlist():
        raise ValueError("交易对不在自选池中")
    runtime = load_runtime_config()
    config = runtime["config"]
    capital_settings = simulation_capital_settings(payload, config)
    client = FreqtradeClient(runtime["freqtrade_url"], runtime["username"], runtime["password"])
    switch_result = configure_runtime_session(client, strategy, pair, capital_settings, strategy_version_id)
    if not switch_result.get("ok"):
        return switch_result
    runtime = load_runtime_config()
    config = runtime["config"]
    remote_config = switch_result.get("remote_config") or client.get("/api/v1/show_config")
    safety = local_safety(config, remote_config)
    if not safety["ok"]:
        return {"ok": False, "blocked": True, "message": "安全检查未通过，已拒绝启动模拟交易。", "safety": safety}
    baseline = retry_freqtrade(lambda: runtime_profit_baseline(client), attempts=12, delay=1.0)
    result = retry_freqtrade(lambda: client.post("/api/v1/start"), attempts=12, delay=1.0)
    state = {
        "active": True,
        "id": datetime.now().strftime("%Y%m%d-%H%M%S"),
        "started_at": datetime.now().isoformat(timespec="seconds"),
        "strategy": strategy,
        "strategy_version": switch_result.get("strategy_version"),
        "runtime_strategy": remote_strategy_name(remote_config) or config.get("strategy"),
        "timeframe": config.get("timeframe"),
        "pair": pair,
        "runtime_pairs": switch_result.get("pairs") or [pair],
        "capital": {
            **capital_settings,
            "stake_currency": config.get("stake_currency", "USDT"),
        },
        "start_profit_abs": baseline.get("profit_abs"),
        "start_profit_ratio": baseline.get("profit_ratio"),
        "start_trade_count": baseline.get("trade_count"),
        "start_balance": baseline.get("balance"),
        "warning": None,
        "switch_result": {
            "changed": switch_result.get("changed"),
            "strategy": switch_result.get("strategy"),
            "strategy_version": switch_result.get("strategy_version"),
            "timeframe": switch_result.get("timeframe"),
            "pairs": switch_result.get("pairs"),
            "capital": switch_result.get("capital"),
        },
    }
    save_simulation_state(state)
    return {"ok": True, "result": result, "active": state}


def stop_simulation() -> dict[str, Any]:
    active = load_simulation_state()
    runtime = load_runtime_config()
    client = FreqtradeClient(runtime["freqtrade_url"], runtime["username"], runtime["password"])
    exit_result = force_exit_open_positions(client)
    if exit_result["errors"]:
        raise RuntimeError("部分持仓平仓失败:\n" + "\n".join(exit_result["errors"]))
    if exit_result["exited"]:
        time.sleep(2)
    metrics = simulation_metrics(active) if active else {}
    detail_snapshot = collect_simulation_detail_snapshot(client) if active else {}
    result = client.post("/api/v1/stop")
    record = None
    if active:
        record = {
            **active,
            "active": False,
            "ended_at": datetime.now().isoformat(timespec="seconds"),
            "metrics": metrics,
            "force_exit": exit_result,
            "detail_snapshot": detail_snapshot,
        }
        save_simulation_history([record] + load_simulation_history())
    save_simulation_state(None)
    return {"ok": True, "result": result, "record": record, "force_exit": exit_result}


def list_backtests() -> list[dict[str, Any]]:
    history = load_backtest_history()
    if not REPORTS_ROOT.exists():
        return history
    results: list[dict[str, Any]] = []
    for path in sorted(REPORTS_ROOT.glob("*.md"), key=lambda p: p.stat().st_mtime, reverse=True):
        text = path.read_text(encoding="utf-8-sig")
        table = parse_backtest_table(text)
        source_match = re.search(r"^- Source: `(.+?)`", text, re.MULTILINE)
        results.append(
            {
                "file": str(path.relative_to(PROJECT_ROOT)).replace("\\", "/"),
                "name": path.stem,
                "modified": datetime.fromtimestamp(path.stat().st_mtime).isoformat(timespec="seconds"),
                "source": source_match.group(1) if source_match else None,
                "metrics": table,
            }
        )
    return history + results


def parse_strategy_file(path: Path) -> dict[str, Any]:
    source = path.read_text(encoding="utf-8-sig")
    tree = ast.parse(source)
    info: dict[str, Any] = {
        "file": str(path.relative_to(PROJECT_ROOT)).replace("\\", "/"),
        "name": path.stem,
        "class_name": None,
        "timeframe": None,
        "can_short": None,
        "stoploss": None,
        "minimal_roi": None,
        "description": None,
        "modified": datetime.fromtimestamp(path.stat().st_mtime).isoformat(timespec="seconds"),
    }

    for node in tree.body:
        if not isinstance(node, ast.ClassDef):
            continue
        base_names = {
            base.id for base in node.bases if isinstance(base, ast.Name)
        }
        if "IStrategy" not in base_names:
            continue
        info["class_name"] = node.name
        info["description"] = ast.get_docstring(node)
        for stmt in node.body:
            if not isinstance(stmt, ast.Assign) or not stmt.targets:
                continue
            target = stmt.targets[0]
            if not isinstance(target, ast.Name):
                continue
            if target.id in {"timeframe", "can_short", "stoploss", "minimal_roi"}:
                try:
                    info[target.id] = ast.literal_eval(stmt.value)
                except Exception:  # noqa: BLE001
                    info[target.id] = None
        break
    return info


def list_strategies() -> list[dict[str, Any]]:
    if not STRATEGIES_ROOT.exists():
        return []
    strategies: list[dict[str, Any]] = []
    runtime_strategy = load_runtime_config()["config"].get("strategy")
    strategy_state = load_strategy_state()
    disabled = set(strategy_state.get("disabled", []))
    for path in sorted(STRATEGIES_ROOT.glob("*.py")):
        try:
            item = parse_strategy_file(path)
        except Exception as exc:  # noqa: BLE001
            item = {
                "file": str(path.relative_to(PROJECT_ROOT)).replace("\\", "/"),
                "name": path.stem,
                "error": str(exc),
                "modified": datetime.fromtimestamp(path.stat().st_mtime).isoformat(timespec="seconds"),
            }
        name = str(item.get("class_name") or item.get("name"))
        item["is_runtime"] = name == runtime_strategy
        item["is_applied"] = name == strategy_state.get("applied_strategy")
        item["disabled"] = name in disabled
        strategies.append(item)
    return strategies


def strategy_class_name(raw: str) -> str:
    name = raw.strip()
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{2,60}", name):
        raise ValueError("策略类名只能使用英文、数字、下划线，且必须以英文字母开头")
    return name


def float_from_payload(payload: dict[str, Any], key: str, default: float) -> float:
    try:
        return float(payload.get(key, default))
    except (TypeError, ValueError):
        return default


def int_from_payload(payload: dict[str, Any], key: str, default: int) -> int:
    try:
        return int(payload.get(key, default))
    except (TypeError, ValueError):
        return default


def generate_strategy_code(payload: dict[str, Any]) -> str:
    name = strategy_class_name(str(payload.get("class_name", "NewSpotStrategy")))
    template = str(payload.get("template", "sma_cross"))
    timeframe = str(payload.get("timeframe", "1h"))
    if timeframe not in {"5m", "15m", "1h", "4h", "1d"}:
        timeframe = "1h"
    stake_floor = max(5.0, float_from_payload(payload, "min_stake_usdt", 20.0))
    stoploss = -abs(float_from_payload(payload, "stoploss", 0.08))
    roi_0 = max(0.0, float_from_payload(payload, "roi_0", 0.04))
    roi_1 = max(0.0, float_from_payload(payload, "roi_1", 0.02))
    roi_2 = max(0.0, float_from_payload(payload, "roi_2", 0.0))
    fast = max(2, int_from_payload(payload, "fast_period", 50))
    slow = max(fast + 1, int_from_payload(payload, "slow_period", 200))
    rsi_buy = max(1, min(99, int_from_payload(payload, "rsi_buy", 30)))
    rsi_sell = max(1, min(99, int_from_payload(payload, "rsi_sell", 60)))

    if template == "rsi_mean":
        indicator_block = f'''        delta = dataframe["close"].diff()
        gain = delta.clip(lower=0).rolling(14, min_periods=14).mean()
        loss = -delta.clip(upper=0).rolling(14, min_periods=14).mean()
        rs = gain / loss.replace(0, float("nan"))
        dataframe["rsi"] = 100 - (100 / (1 + rs))
        dataframe["volume_mean"] = dataframe["volume"].rolling(20, min_periods=20).mean()
        return dataframe'''
        entry_block = f'''        condition = (
            (dataframe["rsi"] < {rsi_buy})
            & (dataframe["volume"] > dataframe["volume_mean"] * 0.5)
            & (dataframe["volume"] > 0)
        )
        dataframe.loc[condition, "enter_long"] = 1
        dataframe.loc[condition, "enter_tag"] = "rsi_mean_reversion"
        return dataframe'''
        exit_block = f'''        condition = (dataframe["rsi"] > {rsi_sell}) & (dataframe["volume"] > 0)
        dataframe.loc[condition, "exit_long"] = 1
        dataframe.loc[condition, "exit_tag"] = "rsi_recovered"
        return dataframe'''
        startup = 40
    else:
        indicator_block = f'''        dataframe["sma_fast"] = dataframe["close"].rolling({fast}, min_periods={fast}).mean()
        dataframe["sma_slow"] = dataframe["close"].rolling({slow}, min_periods={slow}).mean()
        dataframe["volume_mean"] = dataframe["volume"].rolling(20, min_periods=20).mean()
        return dataframe'''
        entry_block = '''        crossed_up = (
            (dataframe["sma_fast"] > dataframe["sma_slow"])
            & (dataframe["sma_fast"].shift(1) <= dataframe["sma_slow"].shift(1))
        )
        condition = crossed_up & (dataframe["volume"] > dataframe["volume_mean"] * 0.5)
        dataframe.loc[condition, "enter_long"] = 1
        dataframe.loc[condition, "enter_tag"] = "sma_cross_up"
        return dataframe'''
        exit_block = '''        crossed_down = (
            (dataframe["sma_fast"] < dataframe["sma_slow"])
            & (dataframe["sma_fast"].shift(1) >= dataframe["sma_slow"].shift(1))
        )
        condition = crossed_down & (dataframe["volume"] > 0)
        dataframe.loc[condition, "exit_long"] = 1
        dataframe.loc[condition, "exit_tag"] = "sma_cross_down"
        return dataframe'''
        startup = slow + 20

    return f'''from datetime import datetime
from typing import Optional

from freqtrade.strategy import IStrategy
from pandas import DataFrame


class {name}(IStrategy):
    """Generated Binance Spot strategy.

    Created from the aiquant strategy wizard. Review and backtest before dry-run.
    """

    INTERFACE_VERSION = 3

    timeframe = "{timeframe}"
    can_short = False
    process_only_new_candles = True
    startup_candle_count = {startup}

    minimal_roi = {{
        "0": {roi_0},
        "240": {roi_1},
        "720": {roi_2},
    }}
    stoploss = {stoploss}
    trailing_stop = False
    use_exit_signal = True
    exit_profit_only = False
    ignore_roi_if_entry_signal = False

    position_adjustment_enable = False
    max_entry_position_adjustment = 0

    order_types = {{
        "entry": "limit",
        "exit": "limit",
        "emergency_exit": "market",
        "force_entry": "market",
        "force_exit": "market",
        "stoploss": "market",
        "stoploss_on_exchange": False,
    }}
    order_time_in_force = {{
        "entry": "GTC",
        "exit": "GTC",
    }}

    min_stake_usdt = {stake_floor}

    @property
    def protections(self):
        return [
            {{
                "method": "CooldownPeriod",
                "stop_duration_candles": 6,
            }},
            {{
                "method": "StoplossGuard",
                "lookback_period_candles": 48,
                "trade_limit": 2,
                "stop_duration_candles": 24,
                "only_per_pair": False,
            }},
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

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
{indicator_block}

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
{entry_block}

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
{exit_block}
'''


def create_strategy(payload: dict[str, Any]) -> dict[str, Any]:
    name = strategy_class_name(str(payload.get("class_name", "")))
    target = STRATEGIES_ROOT / f"{name}.py"
    if target.exists():
        raise ValueError(f"策略文件已存在: {target.name}")
    STRATEGIES_ROOT.mkdir(parents=True, exist_ok=True)
    code = generate_strategy_code(payload)
    target.write_text(code, encoding="utf-8")
    return {
        "ok": True,
        "strategy": name,
        "file": str(target.relative_to(PROJECT_ROOT)).replace("\\", "/"),
    }


def timeframe_to_seconds(timeframe: str | None) -> int | None:
    if not timeframe:
        return None
    match = re.fullmatch(r"(\d+)([mhd])", timeframe)
    if not match:
        return None
    value = int(match.group(1))
    unit = match.group(2)
    factor = {"m": 60, "h": 3600, "d": 86400}[unit]
    return value * factor


def load_data_names() -> dict[str, str]:
    if not DATA_NAMES_PATH.exists():
        return {}
    payload = read_json(DATA_NAMES_PATH)
    names = payload.get("names", {})
    if not isinstance(names, dict):
        return {}
    return {str(key): str(value) for key, value in names.items() if str(value).strip()}


def save_data_names(names: dict[str, str]) -> None:
    STATE_ROOT.mkdir(parents=True, exist_ok=True)
    DATA_NAMES_PATH.write_text(
        json.dumps({"names": names, "updated_at": datetime.now().isoformat(timespec="seconds")}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def resolve_dataset_path(dataset_id: str) -> Path:
    raw = str(dataset_id or "").replace("\\", "/").strip()
    if not raw:
        raise ValueError("缺少数据集 ID")
    target = (PROJECT_ROOT / raw).resolve()
    data_root = DATA_ROOT.resolve()
    if not str(target).startswith(str(data_root)):
        raise ValueError("数据文件必须位于 freqtrade/user_data/data 目录内")
    if not target.exists() or not target.is_file():
        raise ValueError("没有找到指定数据文件")
    if target.suffix.lower() not in ALLOWED_DATA_SUFFIXES:
        raise ValueError("不支持的数据文件类型")
    return target


def parse_pair_list(value: Any) -> list[str]:
    raw_items: list[Any]
    if isinstance(value, list):
        raw_items = value
    else:
        raw_items = re.split(r"[\s,;，；]+", str(value or ""))
    pairs: list[str] = []
    seen: set[str] = set()
    for item in raw_items:
        text = str(item).strip()
        if not text:
            continue
        pair = normalize_pair(text)
        if pair not in seen:
            seen.add(pair)
            pairs.append(pair)
    if not pairs:
        raise ValueError("至少需要一个交易对")
    return pairs


def parse_timeframe_list(value: Any) -> list[str]:
    raw_items = value if isinstance(value, list) else re.split(r"[\s,;，；]+", str(value or ""))
    timeframes: list[str] = []
    seen: set[str] = set()
    for item in raw_items:
        timeframe = str(item).strip()
        if not timeframe:
            continue
        if timeframe not in ALLOWED_TIMEFRAMES:
            raise ValueError(f"不支持的周期: {timeframe}")
        if timeframe not in seen:
            seen.add(timeframe)
            timeframes.append(timeframe)
    if not timeframes:
        raise ValueError("至少需要一个 K 线周期")
    return timeframes


def inspect_ohlcv_file(path: Path, timeframe: str | None) -> dict[str, Any]:
    info: dict[str, Any] = {
        "start": None,
        "end": None,
        "candles": None,
        "expected_candles": None,
        "completeness": None,
        "gap_count": None,
        "missing_candles": None,
        "status": "未解析",
    }
    if path.suffix.lower() != ".feather":
        return info
    try:
        import pandas as pd  # type: ignore

        dataframe = pd.read_feather(path, columns=["date"])
        if dataframe.empty or "date" not in dataframe:
            info["status"] = "空数据"
            return info
        dates = pd.to_datetime(dataframe["date"], utc=True).sort_values()
        start = dates.iloc[0]
        end = dates.iloc[-1]
        candles = int(len(dates))
        interval_seconds = timeframe_to_seconds(timeframe)
        expected = None
        completeness = None
        gap_count = None
        missing_candles = None
        if interval_seconds:
            span_seconds = max(0, int((end - start).total_seconds()))
            expected = floor(span_seconds / interval_seconds) + 1
            if expected > 0:
                completeness = min(1.0, candles / expected)
            deltas = dates.diff().dropna().dt.total_seconds()
            gap_deltas = deltas[deltas > interval_seconds * 1.5]
            gap_count = int(len(gap_deltas))
            missing_candles = int(sum(max(0, round(delta / interval_seconds) - 1) for delta in gap_deltas))
        info.update(
            {
                "start": start.date().isoformat(),
                "end": end.date().isoformat(),
                "candles": candles,
                "expected_candles": expected,
                "completeness": completeness,
                "gap_count": gap_count,
                "missing_candles": missing_candles,
                "status": "可用" if (completeness is None or completeness >= 0.98) and not gap_count else "可能缺失",
            }
        )
    except Exception as exc:  # noqa: BLE001
        info["status"] = f"解析失败: {exc}"
    return info


def list_data_inventory() -> list[dict[str, Any]]:
    if not DATA_ROOT.exists():
        return []
    custom_names = load_data_names()
    items: list[dict[str, Any]] = []
    for path in sorted(DATA_ROOT.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in {".feather", ".json", ".json.gz"}:
            continue
        exchange = path.parent.name
        pair = path.stem
        timeframe = None
        if "-" in pair:
            pair, timeframe = pair.rsplit("-", 1)
        pair_label = pair.replace("_", "/")
        meta = inspect_ohlcv_file(path, timeframe)
        auto_name = f"{exchange}_{pair_label.replace('/', '-')}_{timeframe or 'unknown'}"
        if meta.get("start") and meta.get("end"):
            auto_name = f"{auto_name}_{meta['start']}_{meta['end']}"
        dataset_id = str(path.relative_to(PROJECT_ROOT)).replace("\\", "/")
        items.append(
            {
                "dataset_id": dataset_id,
                "name": custom_names.get(dataset_id, auto_name),
                "auto_name": auto_name,
                "exchange": exchange,
                "pair": pair_label,
                "timeframe": timeframe,
                "file": dataset_id,
                "size": path.stat().st_size,
                "modified": datetime.fromtimestamp(path.stat().st_mtime).isoformat(timespec="seconds"),
                **meta,
            }
        )
    return items


def date_to_timerange_part(value: str) -> str:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value or ""):
        raise ValueError("日期格式必须为 YYYY-MM-DD")
    return value.replace("-", "")


def build_timerange(start: str, end: str) -> str:
    start = str(start or "").strip()
    end = str(end or "").strip()
    if not start and not end:
        raise ValueError("请至少填写起始时间或结束时间")
    start_part = date_to_timerange_part(start) if start else ""
    end_part = date_to_timerange_part(end) if end else ""
    if start_part and end_part and start_part >= end_part:
        raise ValueError("起始时间必须早于结束时间")
    return f"{start_part}-{end_part}"


def compact_command_output(value: str, limit: int = 5000) -> str:
    text = (value or "").strip()
    if len(text) <= limit:
        return text
    return text[-limit:]


def run_freqtrade_download_data(pairs: list[str], timeframes: list[str], timerange: str) -> dict[str, Any]:
    command = [
        "freqtrade",
        "download-data",
        "--config",
        str(CONFIG_PATH),
        "--userdir",
        str(USER_DATA_ROOT),
        "--timerange",
        timerange,
        "--timeframes",
        *timeframes,
        "--pairs",
        *pairs,
    ]
    started = datetime.now()
    try:
        result = subprocess.run(
            command,
            cwd=PROJECT_ROOT,
            text=True,
            capture_output=True,
            timeout=900,
            check=False,
        )
    except FileNotFoundError as exc:
        raise RuntimeError("当前运行环境找不到 freqtrade 命令，请确认控制台容器正在使用 freqtrade 镜像。") from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("下载历史数据超时，请缩短时间范围或减少交易对/周期后重试。") from exc
    output = compact_command_output((result.stdout or "") + "\n" + (result.stderr or ""))
    if result.returncode != 0:
        raise RuntimeError(f"Freqtrade 下载失败，退出码 {result.returncode}:\n{output}")
    return {
        "command": command,
        "pairs": pairs,
        "timeframes": timeframes,
        "timerange": timerange,
        "started_at": started.isoformat(timespec="seconds"),
        "ended_at": datetime.now().isoformat(timespec="seconds"),
        "output": output,
    }


def download_data(payload: dict[str, Any]) -> dict[str, Any]:
    pairs = parse_pair_list(payload.get("pairs"))
    timeframes = parse_timeframe_list(payload.get("timeframes"))
    timerange = build_timerange(str(payload.get("start", "")), str(payload.get("end", "")))
    result = run_freqtrade_download_data(pairs, timeframes, timerange)
    if payload.get("add_to_watchlist", True):
        current = load_watchlist()
        merged = current[:]
        for pair in pairs:
            if pair not in merged:
                merged.append(pair)
        save_watchlist(merged)
    return {"ok": True, "download": result, "items": list_data_inventory(), "watchlist": load_watchlist()}


def repair_data_gaps(payload: dict[str, Any]) -> dict[str, Any]:
    dataset = find_dataset(str(payload.get("dataset_id", "")))
    pair = str(dataset.get("pair") or "")
    timeframe = str(dataset.get("timeframe") or "")
    if not pair or not timeframe:
        raise ValueError("该数据集无法识别交易对或周期，不能自动修复。")
    start = str(payload.get("start") or dataset.get("start") or "")
    end = str(payload.get("end") or dataset.get("end") or datetime.now().date().isoformat())
    timerange = build_timerange(start, end)
    result = run_freqtrade_download_data([pair], [timeframe], timerange)
    return {"ok": True, "download": result, "items": list_data_inventory()}


def rename_dataset(payload: dict[str, Any]) -> dict[str, Any]:
    dataset_id = str(payload.get("dataset_id", "")).strip()
    resolve_dataset_path(dataset_id)
    name = str(payload.get("name", "")).strip()
    if not name:
        raise ValueError("数据名称不能为空")
    if len(name) > 80:
        raise ValueError("数据名称不能超过 80 个字符")
    names = load_data_names()
    names[dataset_id] = name
    save_data_names(names)
    return {"ok": True, "dataset_id": dataset_id, "name": name, "items": list_data_inventory()}


def delete_dataset(payload: dict[str, Any]) -> dict[str, Any]:
    dataset_id = str(payload.get("dataset_id", "")).strip()
    target = resolve_dataset_path(dataset_id)
    target.unlink()
    names = load_data_names()
    if dataset_id in names:
        del names[dataset_id]
        save_data_names(names)
    return {"ok": True, "dataset_id": dataset_id, "deleted": str(target.relative_to(PROJECT_ROOT)).replace("\\", "/"), "items": list_data_inventory()}


def find_dataset(dataset_id: str) -> dict[str, Any]:
    for item in list_data_inventory():
        if item.get("dataset_id") == dataset_id:
            return item
    raise ValueError("没有找到指定本地数据集")


def run_backtest(payload: dict[str, Any]) -> dict[str, Any]:
    strategy = str(payload.get("strategy", "")).strip()
    if strategy not in known_strategy_names():
        raise ValueError(f"策略不存在: {strategy}")
    version = strategy_version_by_id(payload.get("strategy_version_id"), strategy)
    dataset = find_dataset(str(payload.get("dataset_id", "")))
    start = str(payload.get("start", dataset.get("start") or "")).strip()
    end = str(payload.get("end", dataset.get("end") or "")).strip()
    if dataset.get("start") and start < str(dataset["start"]):
        raise ValueError("回测起始时间早于本地数据起始时间")
    if dataset.get("end") and end > str(dataset["end"]):
        raise ValueError("回测结束时间晚于本地数据结束时间")
    if start >= end:
        raise ValueError("回测起始时间必须早于结束时间")

    timerange = f"{date_to_timerange_part(start)}-{date_to_timerange_part(end)}"
    pair = str(dataset.get("pair"))
    timeframe = str(dataset.get("timeframe"))
    requested = {
        "strategy": strategy,
        "dataset_id": dataset.get("dataset_id"),
        "dataset_name": dataset.get("name"),
        "pair": pair,
        "timeframe": timeframe,
        "start": start,
        "end": end,
        "timerange": timerange,
        "strategy_version": strategy_version_payload(version),
    }

    BACKTEST_RESULTS_ROOT.mkdir(parents=True, exist_ok=True)
    before = {path.name for path in BACKTEST_RESULTS_ROOT.glob("*.zip")}
    config_path = write_effective_config(strategy, pair, timeframe, version, "backtest")
    command = [
        "freqtrade",
        "backtesting",
        "--config",
        str(config_path),
        "--userdir",
        str(PROJECT_ROOT / "freqtrade" / "user_data"),
        "--strategy-path",
        str(STRATEGIES_ROOT),
        "--strategy",
        strategy,
        "--timeframe",
        timeframe,
        "--timerange",
        timerange,
        "--pairs",
        pair,
        "--export",
        "trades",
        "--backtest-directory",
        str(BACKTEST_RESULTS_ROOT),
        "--cache",
        "none",
    ]
    completed = subprocess.run(
        command,
        cwd=str(PROJECT_ROOT),
        capture_output=True,
        text=True,
        timeout=420,
        check=False,
    )
    if completed.returncode != 0:
        tail = "\n".join((completed.stdout + "\n" + completed.stderr).splitlines()[-80:])
        raise RuntimeError(f"回测失败:\n{tail}")

    new_results = [
        path
        for path in BACKTEST_RESULTS_ROOT.glob("*.zip")
        if path.name not in before
    ]
    if not new_results:
        new_results = sorted(BACKTEST_RESULTS_ROOT.glob("*.zip"), key=lambda p: p.stat().st_mtime, reverse=True)[:1]
    if not new_results:
        raise RuntimeError("回测完成但没有找到结果文件")
    result_path = max(new_results, key=lambda path: path.stat().st_mtime)
    record = summarize_backtest_result(result_path, requested)
    record["stdout_tail"] = "\n".join(completed.stdout.splitlines()[-40:])
    history = [record] + load_backtest_history()
    save_backtest_history(history)
    return {"ok": True, "record": record}


ALLOWED_HYPEROPT_SPACES = {
    "default",
    "all",
    "buy",
    "sell",
    "enter",
    "exit",
    "roi",
    "stoploss",
    "trailing",
    "protection",
    "trades",
}
ALLOWED_HYPEROPT_LOSSES = {
    "ShortTradeDurHyperOptLoss",
    "OnlyProfitHyperOptLoss",
    "SharpeHyperOptLoss",
    "SharpeHyperOptLossDaily",
    "SortinoHyperOptLoss",
    "SortinoHyperOptLossDaily",
    "CalmarHyperOptLoss",
    "MaxDrawDownHyperOptLoss",
    "MaxDrawDownRelativeHyperOptLoss",
    "MaxDrawDownPerPairHyperOptLoss",
    "ProfitDrawDownHyperOptLoss",
    "MultiMetricHyperOptLoss",
}


def parse_hyperopt_spaces(value: Any) -> list[str]:
    if isinstance(value, list):
        raw = [str(item).strip() for item in value]
    else:
        raw = re.split(r"[\s,]+", str(value or ""))
    spaces = [item for item in raw if item]
    if not spaces:
        spaces = ["roi", "stoploss"]
    unknown = [item for item in spaces if item not in ALLOWED_HYPEROPT_SPACES]
    if unknown:
        raise ValueError(f"不支持的优化空间: {', '.join(unknown)}")
    return spaces


def parse_hyperopt_stdout(output: str) -> dict[str, Any]:
    params = None
    for line in reversed((output or "").splitlines()):
        text = line.strip()
        if not (text.startswith("{") and text.endswith("}")):
            continue
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            params = parsed
            break

    metrics: dict[str, Any] = {}
    best = re.search(
        r"(?P<trades>\d+)\s+trades\..*?Total profit\s+(?P<profit_abs>-?[\d.]+)\s+(?P<currency>[A-Z]+)\s+\(\s*(?P<profit_pct>-?[\d.]+)%\).*?Objective:\s*(?P<objective>-?[\d.]+)",
        output or "",
        re.DOTALL,
    )
    if best:
        metrics = {
            "trades": int(best.group("trades")),
            "profit_abs": float(best.group("profit_abs")),
            "profit_pct": float(best.group("profit_pct")),
            "currency": best.group("currency"),
            "objective": float(best.group("objective")),
        }

    result_path = None
    saved = re.search(r"epochs? saved to '(.+?\.fthypt)'", output or "")
    if saved:
        raw_path = saved.group(1)
        result_path = raw_path.replace("/workspace/", "").replace("\\", "/")

    return {"params": params, "metrics": metrics, "result_path": result_path}


def run_hyperopt(payload: dict[str, Any]) -> dict[str, Any]:
    strategy = str(payload.get("strategy", "")).strip()
    if strategy not in known_strategy_names():
        raise ValueError(f"策略不存在: {strategy}")
    dataset = find_dataset(str(payload.get("dataset_id", "")))
    start = str(payload.get("start", dataset.get("start") or "")).strip()
    end = str(payload.get("end", dataset.get("end") or "")).strip()
    if dataset.get("start") and start < str(dataset["start"]):
        raise ValueError("优化起始时间早于本地数据起始时间")
    if dataset.get("end") and end > str(dataset["end"]):
        raise ValueError("优化结束时间晚于本地数据结束时间")
    if start >= end:
        raise ValueError("优化起始时间必须早于结束时间")

    epochs = int(payload.get("epochs") or 25)
    if epochs < 1 or epochs > 500:
        raise ValueError("优化轮数必须在 1 到 500 之间")
    min_trades = int(payload.get("min_trades") or 1)
    if min_trades < 1:
        raise ValueError("最少交易数至少为 1")
    loss = str(payload.get("loss") or "SharpeHyperOptLossDaily").strip()
    if loss not in ALLOWED_HYPEROPT_LOSSES:
        raise ValueError(f"不支持的优化目标: {loss}")
    spaces = parse_hyperopt_spaces(payload.get("spaces"))
    random_state = str(payload.get("random_state") or "").strip()
    if random_state and not random_state.isdigit():
        raise ValueError("随机种子必须是正整数")

    timerange = f"{date_to_timerange_part(start)}-{date_to_timerange_part(end)}"
    pair = str(dataset.get("pair"))
    timeframe = str(dataset.get("timeframe"))
    requested = {
        "strategy": strategy,
        "dataset_id": dataset.get("dataset_id"),
        "dataset_name": dataset.get("name"),
        "pair": pair,
        "timeframe": timeframe,
        "start": start,
        "end": end,
        "timerange": timerange,
        "epochs": epochs,
        "spaces": spaces,
        "loss": loss,
        "min_trades": min_trades,
        "random_state": random_state or None,
        "auto_export": False,
    }

    HYPEROPT_RESULTS_ROOT.mkdir(parents=True, exist_ok=True)
    command = [
        "freqtrade",
        "hyperopt",
        "--config",
        str(CONFIG_PATH),
        "--userdir",
        str(USER_DATA_ROOT),
        "--strategy-path",
        str(STRATEGIES_ROOT),
        "--strategy",
        strategy,
        "--timeframe",
        timeframe,
        "--timerange",
        timerange,
        "--pairs",
        pair,
        "--epochs",
        str(epochs),
        "--spaces",
        *spaces,
        "--hyperopt-loss",
        loss,
        "--min-trades",
        str(min_trades),
        "--job-workers",
        "1",
        "--ignore-missing-spaces",
        "--disable-param-export",
        "--print-json",
        "--no-color",
    ]
    if random_state:
        command.extend(["--random-state", random_state])

    completed = subprocess.run(
        command,
        cwd=str(PROJECT_ROOT),
        capture_output=True,
        text=True,
        timeout=min(7200, max(900, epochs * 90)),
        check=False,
    )
    output = (completed.stdout or "") + "\n" + (completed.stderr or "")
    parsed = parse_hyperopt_stdout(output)
    record = {
        "id": datetime.now().strftime("%Y%m%d-%H%M%S"),
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "requested": requested,
        "metrics": parsed.get("metrics") or {},
        "params": parsed.get("params"),
        "result_path": parsed.get("result_path"),
        "stdout_tail": compact_command_output(output, 7000),
        "command": command,
        "ok": completed.returncode == 0,
    }
    if completed.returncode != 0:
        record["error"] = "\n".join(output.splitlines()[-100:])
        save_hyperopt_history([record] + load_hyperopt_history())
        raise RuntimeError(f"参数优化失败:\n{record['error']}")

    history = [record] + load_hyperopt_history()
    save_hyperopt_history(history)
    return {"ok": True, "record": record, "items": history}


def control(action: str) -> dict[str, Any]:
    runtime = load_runtime_config()
    config = runtime["config"]
    client = FreqtradeClient(runtime["freqtrade_url"], runtime["username"], runtime["password"])
    remote_config = client.get("/api/v1/show_config")
    safety = local_safety(config, remote_config)

    allowed = {
        "start": "/api/v1/start",
        "stop": "/api/v1/stop",
        "stopentry": "/api/v1/stopentry",
        "reload": "/api/v1/reload_config",
    }
    if action == "globalstop":
        exit_result = force_exit_open_positions(client)
        if exit_result["errors"]:
            raise RuntimeError("部分持仓平仓失败:\n" + "\n".join(exit_result["errors"]))
        result = client.post("/api/v1/stop")
        save_simulation_state(None)
        return {
            "ok": True,
            "action": action,
            "result": result,
            "force_exit": exit_result,
            "safety": safety,
        }

    if action not in allowed:
        raise RuntimeError(f"未知控制动作: {action}")

    if action in {"start", "reload"} and not safety["ok"]:
        return {
            "ok": False,
            "blocked": True,
            "message": "安全检查未通过，已拒绝执行。",
            "safety": safety,
        }

    result = client.post(allowed[action])
    return {
        "ok": True,
        "action": action,
        "result": result,
        "safety": safety,
    }


class ConsoleHandler(SimpleHTTPRequestHandler):
    server_version = "aiquant-console/0.1"

    def translate_path(self, path: str) -> str:
        parsed = urlparse(path)
        clean = parsed.path.lstrip("/")
        if not clean:
            clean = "index.html"
        target = (STATIC_ROOT / clean).resolve()
        if not str(target).startswith(str(STATIC_ROOT.resolve())):
            return str(STATIC_ROOT / "index.html")
        if target.is_dir():
            target = target / "index.html"
        return str(target)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/snapshot":
                self.send_json(build_snapshot())
                return
            if parsed.path == "/api/backtests":
                self.send_json({"items": list_backtests()})
                return
            if parsed.path == "/api/hyperopts":
                self.send_json({"items": load_hyperopt_history()})
                return
            if parsed.path == "/api/backtests/detail":
                query = parse_qs(parsed.query)
                self.send_json(backtest_detail(query.get("id", [""])[0]))
                return
            if parsed.path == "/api/strategies":
                self.send_json({"items": list_strategies(), "state": load_strategy_state()})
                return
            if parsed.path == "/api/strategy-state":
                self.send_json(load_strategy_state())
                return
            if parsed.path == "/api/strategy-versions":
                self.send_json({"items": load_strategy_versions()})
                return
            if parsed.path == "/api/data-inventory":
                self.send_json({"items": list_data_inventory()})
                return
            if parsed.path == "/api/watchlist":
                self.send_json({"pairs": load_watchlist()})
                return
            if parsed.path == "/api/simulation":
                self.send_json(simulation_status())
                return
            if parsed.path == "/api/simulation/detail":
                query = parse_qs(parsed.query)
                self.send_json(simulation_detail(query.get("id", [""])[0]))
                return
            if parsed.path == "/api/market/klines":
                query = parse_qs(parsed.query)
                symbol = query.get("symbol", ["BTC/USDT"])[0]
                interval = query.get("interval", ["1h"])[0]
                limit = int(query.get("limit", ["160"])[0])
                self.send_json(get_market_klines(symbol, interval, limit))
                return
            if parsed.path == "/api/market/ticker":
                query = parse_qs(parsed.query)
                symbol = query.get("symbol", ["BTC/USDT"])[0]
                self.send_json(get_market_ticker(symbol))
                return
            if parsed.path == "/api/local-config":
                self.send_json(summarize_local_config(load_runtime_config()["config"]))
                return
            return super().do_GET()
        except Exception as exc:  # noqa: BLE001
            self.send_json({"ok": False, "error": str(exc)}, status=500)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/watchlist":
                payload = read_request_json(self)
                self.send_json(update_watchlist(str(payload.get("action", "add")), str(payload.get("pair", ""))))
                return
            if parsed.path == "/api/backtests/run":
                payload = read_request_json(self)
                self.send_json(run_backtest(payload))
                return
            if parsed.path == "/api/hyperopt/run":
                payload = read_request_json(self)
                self.send_json(run_hyperopt(payload))
                return
            if parsed.path == "/api/data/download":
                payload = read_request_json(self)
                self.send_json(download_data(payload))
                return
            if parsed.path == "/api/data/repair":
                payload = read_request_json(self)
                self.send_json(repair_data_gaps(payload))
                return
            if parsed.path == "/api/data/rename":
                payload = read_request_json(self)
                self.send_json(rename_dataset(payload))
                return
            if parsed.path == "/api/data/delete":
                payload = read_request_json(self)
                self.send_json(delete_dataset(payload))
                return
            if parsed.path == "/api/simulation/start":
                payload = read_request_json(self)
                self.send_json(start_simulation(payload))
                return
            if parsed.path == "/api/simulation/stop":
                self.send_json(stop_simulation())
                return
            if parsed.path == "/api/history/delete":
                payload = read_request_json(self)
                self.send_json(delete_history_record(str(payload.get("type", "")), str(payload.get("id", ""))))
                return
            if parsed.path == "/api/strategies/action":
                payload = read_request_json(self)
                self.send_json(update_strategy_state(str(payload.get("action", "")), str(payload.get("strategy", ""))))
                return
            if parsed.path == "/api/strategies/preview":
                payload = read_request_json(self)
                self.send_json({"code": generate_strategy_code(payload)})
                return
            if parsed.path == "/api/strategies/create":
                payload = read_request_json(self)
                self.send_json(create_strategy(payload))
                return
            if parsed.path == "/api/strategy-versions/create":
                payload = read_request_json(self)
                self.send_json(create_strategy_version(payload))
                return
            if parsed.path == "/api/strategy-versions/action":
                payload = read_request_json(self)
                self.send_json(update_strategy_version(payload))
                return
            if parsed.path == "/api/strategy-versions/export":
                payload = read_request_json(self)
                self.send_json(export_strategy_version_to_strategy(payload))
                return
            match = re.fullmatch(r"/api/control/(start|stop|stopentry|reload|globalstop)", parsed.path)
            if not match:
                self.send_json({"ok": False, "error": "Unknown endpoint"}, status=404)
                return
            self.send_json(control(match.group(1)))
        except Exception as exc:  # noqa: BLE001
            self.send_json({"ok": False, "error": str(exc)}, status=500)

    def send_json(self, payload: Any, status: int = 200) -> None:
        raw = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def guess_type(self, path: str) -> str:
        guessed, _ = mimetypes.guess_type(path)
        return guessed or "application/octet-stream"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8090, type=int)
    args = parser.parse_args(argv)

    if not CONFIG_PATH.exists():
        raise SystemExit(f"Config not found: {CONFIG_PATH}")

    server = ThreadingHTTPServer((args.host, args.port), ConsoleHandler)
    print(f"aiquant console: http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("stopping aiquant console")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
