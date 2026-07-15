const state = {
  loading: false,
  snapshot: null,
  strategies: [],
  strategyVersions: [],
  strategyState: {},
  selectedStrategy: null,
  dataInventory: [],
  watchlist: [],
  selectedPair: null,
  candles: [],
  backtests: [],
  hyperopts: [],
  simulation: { active: null, metrics: {}, history: [] },
  simulationCandles: [],
  selectedSimulationPair: null,
  liveCandles: [],
  selectedLivePair: null,
  selectedSimulationHistoryId: null,
  simulationDetail: null,
  selectedBacktestDataset: null,
  selectedBacktestVersion: "",
  selectedHyperoptDataset: null,
  selectedSimulationVersion: "",
  selectedBacktestId: null,
  backtestDetail: null,
  backtestRunning: false,
  hyperoptRunning: false,
  view: "dashboard",
  experiments: [],
  editingExperimentId: null,
  batchRanges: [],
  selectedQualityDatasetId: null,
  qualityDetail: null,
  reportTab: "backtest",
};

const viewMeta = {
  dashboard: {
    eyebrow: "交易工作流",
    title: "总览",
    subtitle: "先看关键状态，再进入数据、策略、回测、模拟和实盘环节。",
  },
  data: {
    eyebrow: "行情与交易池",
    title: "数据",
    subtitle: "查看本地 K 线、交易对白名单和默认数据边界。",
  },
  strategies: {
    eyebrow: "策略工程",
    title: "策略",
    subtitle: "管理策略库，理解每个 Python 策略文件的接口和风险参数。",
  },
  backtest: {
    eyebrow: "历史验证",
    title: "回测",
    subtitle: "选择策略和数据范围，用历史行情检验策略是否值得进入模拟交易。",
  },
  simulation: {
    eyebrow: "实时演练",
    title: "模拟交易",
    subtitle: "用实时行情跑 dry-run，观察虚拟持仓、执行结果和错误日志。",
  },
  live: {
    eyebrow: "真钱执行区",
    title: "实盘交易",
    subtitle: "实盘需要独立 profile、权限隔离、资金上限和人工确认；当前默认锁定。",
  },
  account: {
    eyebrow: "资金与安全",
    title: "账户与风控",
    subtitle: "集中查看资产、仓位边界、dry-run 安全锁和交易约束。",
  },
  reports: {
    eyebrow: "复盘归档",
    title: "报告",
    subtitle: "沉淀回测、模拟交易、实盘复盘和运行日志。",
  },
};

const $ = (id) => document.getElementById(id);

function fmtNumber(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "--";
  return n.toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtBytes(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "--";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "--";
  return `${(n * 100).toFixed(2)}%`;
}

function readPositiveNumber(id, label) {
  const value = Number($(id)?.value);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} 必须是大于 0 的数字`);
  }
  return value;
}

function readSimulationCapitalPayload() {
  const maxOpenTrades = Math.floor(readPositiveNumber("simulationMaxOpenInput", "最大同时持仓"));
  if (maxOpenTrades < 1) throw new Error("最大同时持仓至少为 1");
  const tradableBalanceRatio = readPositiveNumber("simulationBalanceRatioInput", "可交易资金比例");
  if (tradableBalanceRatio > 1) throw new Error("可交易资金比例不能超过 1");
  return {
    dry_run_wallet: readPositiveNumber("simulationWalletInput", "模拟钱包"),
    stake_amount: readPositiveNumber("simulationStakeInput", "单笔投入"),
    max_open_trades: maxOpenTrades,
    tradable_balance_ratio: tradableBalanceRatio,
  };
}

function simulationCapitalSource(active, config) {
  return active?.capital || config || {};
}

function setCapitalInput(id, value, active) {
  const input = $(id);
  if (!input) return;
  if (active || !input.dataset.dirty) {
    input.value = value ?? "";
  }
  input.disabled = Boolean(active);
}

function syncSimulationCapitalPreview() {
  const preview = $("simulationExposurePreview");
  if (!preview) return;
  const currency = state.snapshot?.local_config?.stake_currency || "USDT";
  const wallet = Number($("simulationWalletInput")?.value);
  const stake = Number($("simulationStakeInput")?.value);
  const maxOpen = Number($("simulationMaxOpenInput")?.value);
  const ratio = Number($("simulationBalanceRatioInput")?.value);
  if (![wallet, stake, maxOpen, ratio].every((value) => Number.isFinite(value) && value > 0)) {
    preview.textContent = "等待资金参数";
    preview.classList.remove("danger");
    return;
  }
  const usable = wallet * ratio;
  const maxExposure = stake * Math.floor(maxOpen);
  const danger = maxExposure > usable;
  preview.textContent = danger
    ? `最大占用 ${fmtNumber(maxExposure, 2)} ${currency}，超过可用 ${fmtNumber(usable, 2)} ${currency}`
    : `最大占用约 ${fmtNumber(maxExposure, 2)} ${currency} / 可用 ${fmtNumber(usable, 2)} ${currency}`;
  preview.classList.toggle("danger", danger);
}

function fmtDuration(seconds) {
  const n = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(n / 3600);
  const minutes = Math.floor((n % 3600) / 60);
  const secs = Math.floor(n % 60);
  if (hours > 0) return `${hours}小时 ${minutes}分`;
  if (minutes > 0) return `${minutes}分 ${secs}秒`;
  return `${secs}秒`;
}

function durationToSeconds(value) {
  const match = String(value || "").match(/^(\d+)([mhd])$/);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2];
  const factor = { m: 60, h: 3600, d: 86400 }[unit];
  return amount * factor;
}

function candleLimitForWindow(interval, windowValue) {
  const intervalSeconds = durationToSeconds(interval) || 3600;
  const windowSeconds = durationToSeconds(windowValue) || 86400;
  return Math.max(2, Math.min(500, Math.ceil(windowSeconds / intervalSeconds) + 1));
}

function fmtRatioPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "--";
  return `${(n * 100).toFixed(1)}%`;
}

function classifyNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return "";
  return n > 0 ? "positive" : "negative";
}

function setText(id, value) {
  const node = $(id);
  if (node) node.textContent = value ?? "--";
}

function toast(message) {
  const box = $("toast");
  box.textContent = message;
  box.classList.remove("hidden");
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => box.classList.add("hidden"), 2800);
}

function setLoading(loading) {
  state.loading = loading;
  for (const id of ["refreshBtn", "globalStopBtn", "riskStopEntryBtn", "riskGlobalStopBtn"]) {
    const button = $(id);
    if (button) button.disabled = loading;
  }
}

async function getJSON(url, options = {}) {
  const response = await fetch(url, {
    cache: "no-store",
    ...options,
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || data.message || `请求失败 ${response.status}`);
  }
  return data;
}

async function postJSON(url, payload) {
  return getJSON(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

function switchView(view) {
  if (!viewMeta[view]) view = "dashboard";
  state.view = view;

  document.querySelectorAll(".view").forEach((node) => {
    node.classList.toggle("active", node.id === `view-${view}`);
  });
  document.querySelectorAll(".nav-item").forEach((node) => {
    node.classList.toggle("active", node.dataset.view === view);
  });

  const meta = viewMeta[view];
  setText("viewEyebrow", meta.eyebrow);
  setText("viewTitle", meta.title);
  setText("viewSubtitle", meta.subtitle);
  window.location.hash = view;
  if (view === "backtest" && state.selectedBacktestId && state.backtestDetail?.id !== state.selectedBacktestId) {
    loadBacktestDetail(state.selectedBacktestId, true);
  }
  if (view === "live" && state.snapshot) {
    loadLiveMarketData();
  }
}

function initNavigation() {
  document.querySelectorAll(".nav-item").forEach((node) => {
    node.addEventListener("click", () => switchView(node.dataset.view));
  });

  const hash = window.location.hash.replace("#", "");
  switchView(viewMeta[hash] ? hash : "dashboard");
}

async function refresh() {
  setLoading(true);
  try {
    const [snapshot, backtests, hyperopts, strategyVersions, strategies, dataInventory, watchlist, simulation, experiments] = await Promise.all([
      getJSON("/api/snapshot"),
      getJSON("/api/backtests"),
      getJSON("/api/hyperopts"),
      getJSON("/api/strategy-versions"),
      getJSON("/api/strategies"),
      getJSON("/api/data-inventory"),
      getJSON("/api/watchlist"),
      getJSON("/api/simulation"),
      getJSON("/api/experiments"),
    ]);
    state.snapshot = snapshot;
    state.backtests = backtests.items || [];
    state.hyperopts = hyperopts.items || [];
    state.strategyVersions = strategyVersions.items || [];
    state.simulation = simulation || { active: null, metrics: {}, history: [] };
    state.strategies = strategies.items || [];
    state.strategyState = strategies.state || {};
    state.experiments = experiments.items || [];
    if (!state.selectedStrategy || !strategyByName(state.selectedStrategy)) {
      state.selectedStrategy =
        state.strategyState.applied_strategy ||
        snapshot.local_config?.strategy ||
        state.strategies[0]?.class_name ||
        null;
    }
    state.dataInventory = dataInventory.items || [];
    state.watchlist = watchlist.pairs || [];
    if (!state.selectedPair || !state.watchlist.includes(state.selectedPair)) {
      state.selectedPair = state.watchlist[0] || null;
    }
    const detailCandidate = state.backtests.find((item) => item.id && (item.source || item.file));
    if (!state.selectedBacktestId || !state.backtests.some((item) => item.id === state.selectedBacktestId)) {
      state.selectedBacktestId = detailCandidate?.id || null;
      state.backtestDetail = null;
    }

    renderSnapshot(snapshot);
    renderBacktests(state.backtests);
    renderStrategies(state.strategies, snapshot.local_config || {});
    renderStrategyVersions(state.strategyVersions);
    renderDataInventory(state.dataInventory, snapshot.local_config || {});
    fillBacktestDatasetSelect(state.dataInventory);
    fillHyperoptDatasetSelect(state.dataInventory);
    fillBatchBacktestControls();
    fillExperimentFormSelects();
    fillSimulationControls();
    fillLiveControls();
    renderWatchlist(state.watchlist);
    fillDataDownloadDefaults(false);
    renderSimulation(state.simulation, snapshot);
    renderLive(snapshot);
    renderHyperopts(state.hyperopts);
    renderExperiments(state.experiments);
    renderReportTabs();
    await loadMarketData();
    if (state.view === "simulation" || state.simulation.active) {
      await loadSimulationMarketData();
    }
    if (state.view === "live") {
      await loadLiveMarketData();
    }
    if (state.view === "backtest" && state.selectedBacktestId && state.backtestDetail?.id !== state.selectedBacktestId) {
      await loadBacktestDetail(state.selectedBacktestId, true);
    }

    $("apiState").className = "dot ok";
    setText("apiText", "已连接");
  } catch (error) {
    $("apiState").className = "dot bad";
    setText("apiText", "连接失败");
    renderErrors([error.message]);
    toast(error.message);
  } finally {
    setLoading(false);
    if (state.snapshot) {
      renderSimulation(state.simulation, state.snapshot);
      renderLive(state.snapshot);
    }
  }
}

function renderSnapshot(data) {
  const config = data.local_config || {};
  const remote = data.show_config || {};
  const profit = data.profit || {};
  const balance = data.balance || {};
  const openTrades = Array.isArray(data.status) ? data.status : [];
  const currencies = Array.isArray(balance.currencies) ? balance.currencies : [];

  setText("botName", config.bot_name || "aiquant-binance");
  setText("updatedAt", data.generated_at ? `更新 ${data.generated_at}` : "等待数据");
  renderState(remote, data.health);

  const usdt = currencies.find((item) => item.currency === "USDT") || currencies[0] || {};
  setText("balanceTotal", `${fmtNumber(usdt.balance)} ${usdt.stake || usdt.currency || "USDT"}`);
  setText("balanceFree", `可用 ${fmtNumber(usdt.free)} / 占用 ${fmtNumber(usdt.used)}`);

  const profitRatio = profit.profit_all_ratio ?? profit.profit_closed_ratio ?? 0;
  const profitAbs = profit.profit_all_coin ?? profit.profit_closed_coin ?? 0;
  setText("profitTotal", fmtPercent(profitRatio));
  setText("profitAbs", `${fmtNumber(profitAbs, 4)} ${config.stake_currency || "USDT"}`);
  $("profitTotal").className = classifyNumber(profitRatio);

  const strategy = config.strategy || remote.strategy || "--";
  setText("openTrades", String(openTrades.length));
  setText("tradeCount", `累计 ${profit.trade_count ?? profit.closed_trade_count ?? 0}`);
  setText("strategyName", strategy);
  setText("strategyChip", `策略: ${strategy}`);
  setText("simulationStrategy", strategy);
  setText("timeframe", `${config.timeframe || remote.timeframe || "--"} / ${config.max_open_trades || "--"} 仓`);

  setText("versionBadge", data.version?.version || remote.version || "--");
  setText("exchangeName", "Binance");
  setText("pairs", (config.pairs || []).join(", "));
  setText("stake", `${config.stake_amount ?? "--"} ${config.stake_currency || "USDT"}`);
  setText("dataUrl", config.public_data_url || "--");
  setText("dataPairs", (config.pairs || []).join(", ") || "--");
  setText("dataTimeframe", config.timeframe || remote.timeframe || "--");
  setText("modeSummary", `${config.trading_mode || "--"} / dry-run=${String(config.dry_run)} / sandbox=${String(config.sandbox)}`);
  setText("maxOpenTrades", config.max_open_trades ?? "--");
  setText("stakeCurrency", config.stake_currency || "--");

  const simulationBadge = $("simulationBadge");
  if (simulationBadge) {
    simulationBadge.textContent = config.dry_run ? "dry-run 已启用" : "非 dry-run";
    simulationBadge.className = `badge ${config.dry_run ? "safe" : "danger"}`;
  }

  renderSafety(data.safety);
  renderTrades(openTrades);
  renderBalances(currencies);
  renderPerformance(data.performance || []);
  renderLogs(data.logs);
  renderErrors(data.errors || []);
}

function renderState(remote, health) {
  const stateText = (health && health.bot_state) || remote.state || "unknown";
  const chip = $("stateChip");
  chip.textContent = `状态: ${translateState(stateText)}`;
  chip.className = "status-chip";
  if (stateText === "running") chip.classList.add("safe");
  if (stateText === "stopped") chip.classList.add("warn");
}

function translateState(value) {
  const map = {
    running: "运行中",
    stopped: "已停止",
    paused: "暂停",
    unknown: "未知",
  };
  return map[value] || value || "未知";
}

function renderSafety(safety) {
  const ok = safety?.ok;
  for (const id of ["safetyBadge", "safetyBadgeMini", "liveLockBadge"]) {
    const badge = $(id);
    if (!badge) continue;
    if (id === "liveLockBadge") {
      badge.textContent = ok ? "实盘锁定" : "配置异常";
      badge.className = `badge ${ok ? "danger" : "danger"}`;
      continue;
    }
    badge.textContent = ok ? "通过" : "阻断";
    badge.className = `badge ${ok ? "safe" : "danger"}`;
  }

  const rows = (safety?.checks || []).map((check) => {
    const row = document.createElement("div");
    row.className = `check ${check.ok ? "ok" : "bad"}`;
    row.innerHTML = `<strong>${check.ok ? "通过" : "失败"} · ${escapeHTML(check.label)}</strong><span>${escapeHTML(String(check.value))}</span>`;
    return row;
  });

  renderNodeList("safetyList", rows);
  renderNodeList("dashboardSafetyList", rows.slice(0, 4).map((row) => row.cloneNode(true)));
}

function renderNodeList(id, nodes) {
  const list = $(id);
  if (!list) return;
  list.innerHTML = "";
  if (!nodes.length) {
    list.innerHTML = `<div class="check"><strong>等待数据</strong><span>--</span></div>`;
    return;
  }
  nodes.forEach((node) => list.appendChild(node));
}

function renderTrades(trades) {
  setText("openTradeBadge", `${trades.length} 笔`);
  const body = $("tradeRows");
  if (!body) return;
  body.innerHTML = "";
  if (!trades.length) {
    body.innerHTML = `<tr class="empty-trades-row"><td colspan="6">当前没有打开交易</td></tr>`;
    return;
  }
  for (const trade of trades) {
    const profit = trade.profit_ratio ?? trade.profit_pct ?? 0;
    const stake = Number(trade.stake_amount ?? trade.open_trade_value);
    const amount = Number(trade.amount || trade.amount_requested || 0);
    const rate = Number(trade.current_rate || trade.open_rate || 0);
    const positionValue = Number.isFinite(stake) && stake > 0 ? stake : amount * rate;
    body.insertAdjacentHTML(
      "beforeend",
      `<tr>
        <td>${escapeHTML(trade.pair || "--")}</td>
        <td>${escapeHTML(trade.trade_direction || trade.enter_tag || "long")}</td>
        <td>${fmtNumber(trade.open_rate, 4)}</td>
        <td>${fmtNumber(positionValue, 2)} ${escapeHTML(trade.quote_currency || state.snapshot?.local_config?.stake_currency || "USDT")}</td>
        <td class="${classifyNumber(profit)}">${fmtPercent(profit)}</td>
        <td>${escapeHTML(trade.open_date_hum || trade.open_date || "--")}</td>
      </tr>`,
    );
  }
}

function compactDateTime(value) {
  const time = typeof value === "number" ? (value < 1000000000000 ? value * 1000 : value) : Date.parse(value);
  if (!Number.isFinite(time)) return "--";
  return new Date(time).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function orderTime(order, trade) {
  const keys = [
    "order_filled_timestamp",
    "order_timestamp",
    "order_date_timestamp",
    "order_filled_date",
    "order_date",
    "filled_date",
    "created_at",
  ];
  for (const key of keys) {
    const value = order?.[key];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "number") return value < 1000000000000 ? value * 1000 : value;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return tradeTimestamp(trade || {}, ["close_timestamp", "open_timestamp", "close_date", "open_date"]);
}

function orderSideLabel(side) {
  const text = String(side || "").toLowerCase();
  if (["buy", "entry", "enter_long"].includes(text)) return "买入";
  if (["sell", "exit", "exit_long"].includes(text)) return "卖出";
  return side || "--";
}

function orderStatusClass(status) {
  const text = String(status || "").toLowerCase();
  if (["closed", "filled", "done"].includes(text)) return "closed";
  if (["open", "new", "partial", "partially_filled", "partially filled", "pending"].includes(text)) return "open";
  if (["canceled", "cancelled", "expired", "rejected", "failed"].includes(text)) return "canceled";
  return "neutral";
}

function orderStatusLabel(status) {
  const text = String(status || "").toLowerCase();
  const labels = {
    open: "挂单中",
    new: "新建",
    pending: "待提交",
    partial: "部分成交",
    partially_filled: "部分成交",
    "partially filled": "部分成交",
    closed: "已成交",
    filled: "已成交",
    done: "已完成",
    canceled: "已取消",
    cancelled: "已取消",
    expired: "已过期",
    rejected: "已拒绝",
    failed: "失败",
  };
  return labels[text] || status || "--";
}

function normalizeOrderRows(snapshot, pair) {
  const rows = [];
  const trades = [
    ...(Array.isArray(snapshot?.status) ? snapshot.status : []),
    ...normalizeTradeHistory(snapshot?.trades_history),
  ];
  const addOrder = (trade, order, fallback = {}) => {
    const rowPair = order?.pair || trade?.pair || fallback.pair;
    if (pair && rowPair !== pair) return;
    const timestamp = orderTime(order || {}, trade || {});
    const price = Number(
      order?.average ?? order?.safe_price ?? order?.price ?? order?.ft_price ?? fallback.price ?? trade?.open_rate ?? trade?.close_rate,
    );
    const amount = Number(order?.filled ?? order?.amount ?? order?.amount_requested ?? fallback.amount ?? trade?.amount ?? 0);
    const cost = Number(order?.cost ?? order?.stake_amount ?? fallback.cost ?? (Number.isFinite(price) ? price * amount : NaN));
    rows.push({
      id: order?.order_id || fallback.id || trade?.trade_id || `${rowPair}-${timestamp || rows.length}`,
      pair: rowPair,
      time: timestamp,
      side: order?.ft_order_side || order?.side || fallback.side,
      status: order?.status || fallback.status,
      price,
      amount,
      cost,
      type: order?.order_type || order?.ft_order_type || fallback.type || "--",
      tag: order?.ft_order_tag || trade?.enter_tag || trade?.exit_reason || "",
    });
  };

  for (const trade of trades) {
    const orders = Array.isArray(trade?.orders) ? trade.orders : [];
    if (orders.length) {
      for (const order of orders) addOrder(trade, order);
      continue;
    }
    addOrder(trade, null, {
      id: `${trade?.trade_id || trade?.pair}-open`,
      side: "buy",
      status: trade?.is_open ? "open" : "closed",
      price: trade?.open_rate,
      amount: trade?.amount,
      cost: trade?.stake_amount || trade?.open_trade_value,
    });
    if (!trade?.is_open && (trade?.close_rate || trade?.close_timestamp || trade?.close_date)) {
      addOrder(
        {
          ...trade,
          open_timestamp: trade?.close_timestamp,
          open_date: trade?.close_date,
        },
        null,
        {
          id: `${trade?.trade_id || trade?.pair}-close`,
          side: "sell",
          status: "closed",
          price: trade?.close_rate,
          amount: trade?.amount,
          cost: trade?.close_profit_abs,
        },
      );
    }
  }
  return rows.sort((a, b) => (b.time || 0) - (a.time || 0));
}

function currentSimulationOrderRows(snapshot, active, pair) {
  if (!active?.started_at) return [];
  const bounds = simulationSessionBounds(active, { startGraceMs: 0, endGraceMs: 0 });
  return normalizeOrderRows(snapshot || {}, pair).filter((row) => isWithinSimulationSession(row.time, bounds));
}

function renderSimulationOrders(snapshot, active) {
  const pair = active?.pair || $("simulationPairSelect")?.value || state.selectedSimulationPair;
  const rows = currentSimulationOrderRows(snapshot || {}, active, pair).slice(0, 80);
  setText("simulationOrderBadge", `${rows.length} 条`);
  const body = $("simulationOrderRows");
  if (!body) return;
  body.innerHTML = "";
  if (!rows.length) {
    const message = active
      ? "本次模拟交易暂无订单。若策略正在运行但没有订单，通常是入场条件未触发、保护规则生效、资金上限不足，或机器人不是 running 状态。"
      : "当前没有模拟交易会话。启动新的模拟交易后，这里只显示本次会话产生的订单。";
    body.innerHTML = `<tr><td colspan="6" class="diagnostic-empty">${escapeHTML(message)}</td></tr>`;
    return;
  }
  for (const row of rows) {
    const statusClass = orderStatusClass(row.status);
    const statusText = orderStatusLabel(row.status);
    const sideText = orderSideLabel(row.side);
    const sideClass = String(row.side || "").toLowerCase().includes("sell") || sideText === "卖出" ? "sell" : "buy";
    body.insertAdjacentHTML(
      "beforeend",
      `<tr>
        <td><span class="muted">${escapeHTML(compactDateTime(row.time))}</span></td>
        <td><span class="order-side ${sideClass}">${escapeHTML(sideText)}</span></td>
        <td><span class="order-status ${statusClass}" title="${escapeHTML(row.status || "")}">${escapeHTML(statusText)}</span></td>
        <td>${fmtNumber(row.price, 4)}</td>
        <td>${fmtNumber(row.amount, 6)}</td>
        <td>${fmtNumber(row.cost, 2)}</td>
      </tr>`,
    );
  }
}

function clearSimulationOrders(message = "新的模拟交易会话启动中，订单列表已清空。") {
  setText("simulationOrderBadge", "0 条");
  const body = $("simulationOrderRows");
  if (!body) return;
  body.innerHTML = `<tr><td colspan="6" class="diagnostic-empty">${escapeHTML(message)}</td></tr>`;
}

function parseLogRows(logs) {
  const rows = Array.isArray(logs?.logs) ? logs.logs : [];
  return rows.map((row) => {
    const [time, timestamp, source, level, message] = Array.isArray(row) ? row : [];
    return {
      time: time || compactDateTime(timestamp),
      source: source || "--",
      level: level || "--",
      message: message || String(row || ""),
    };
  });
}

function logMatchesFilter(row, filter) {
  const text = `${row.level} ${row.source} ${row.message}`.toLowerCase();
  if (filter === "all") return true;
  if (filter === "warn") return /(warning|error|critical|failed|reject|timeout|refused|exception)/i.test(text);
  if (filter === "strategy") return /(strategy|signal|enter|entry|exit|protection|cooldown|pairlist|whitelist|populate)/i.test(text);
  return /(trade|order|buy|sell|entry|exit|force|stoploss|roi|profit|filled|cancel)/i.test(text);
}

function renderSimulationReasonHint(snapshot, active, orderCount) {
  const rows = Array.isArray(snapshot?.status) ? snapshot.status : [];
  const runtimeState = (snapshot?.health && snapshot.health.bot_state) || snapshot?.show_config?.state || "unknown";
  let text = "等待模拟交易运行状态。";
  if (!active) {
    text = "当前没有模拟交易会话。先启动 dry-run，再观察订单和日志。";
  } else if (!String(runtimeState).toLowerCase().includes("run")) {
    text = `机器人状态是 ${translateState(runtimeState)}，不在 running 时通常不会产生新订单。`;
  } else if (!orderCount && !rows.length) {
    text = "已进入模拟会话但暂无订单：优先检查策略入场条件、startup_candle_count、冷却/保护规则、资金设置和交易对白名单。";
  } else if (rows.length) {
    text = "当前有打开交易；若没有卖出，重点看退出信号、ROI、止损、trailing stop 和保护规则。";
  } else {
    text = "已有订单或历史交易；如果结果不符合预期，查看订单状态、成交价格和退出原因。";
  }
  setText("simulationReasonHint", text);
}

function renderSimulationLogs(snapshot, simulation) {
  const active = simulation?.active || null;
  const rows = parseLogRows(snapshot?.logs);
  const filter = $("simulationLogFilter")?.value || "trade";
  const filtered = rows.filter((row) => logMatchesFilter(row, filter));
  const pair = active?.pair || $("simulationPairSelect")?.value || state.selectedSimulationPair;
  const orderCount = currentSimulationOrderRows(snapshot || {}, active, pair).length;
  renderSimulationReasonHint(snapshot || {}, active, orderCount);
  setText("simulationLogBadge", `${filtered.length}/${rows.length} 条`);
  if (!filtered.length) {
    setText("simulationLogText", rows.length ? "当前筛选条件下暂无日志，可以切换为“全部日志”。" : "暂无日志");
    return;
  }
  const tail = filtered.slice(-120).map((row) => `[${row.time}] ${row.level} ${row.source}: ${row.message}`);
  setText("simulationLogText", tail.join("\n"));
}

function renderSimulation(simulation, snapshot) {
  const active = simulation?.active || null;
  const metrics = simulation?.metrics || {};
  const config = snapshot?.local_config || {};
  const remote = snapshot?.show_config || {};
  const runtimeState = (snapshot?.health && snapshot.health.bot_state) || remote.state || "unknown";
  const pair = active?.pair || $("simulationPairSelect")?.value || state.selectedSimulationPair || "--";
  const strategy = active?.strategy || $("simulationStrategySelect")?.value || config.strategy || "--";
  const runtimeStrategy = active?.runtime_strategy || config.strategy || remote.strategy || "--";
  const runtimeVersion = active?.strategy_version || $("simulationVersionSelect")?.value || "";
  const runtimePairs = active?.runtime_pairs || config.pairs || [];
  const capital = simulationCapitalSource(active, config);
  const currency = config.stake_currency || "USDT";

  const badge = $("simulationRunBadge");
  if (badge) {
    badge.textContent = active ? "模拟运行中" : "未运行";
    badge.className = `badge ${active ? "safe" : "warn"}`;
  }

  setText("simPairMetric", pair);
  setText("simStrategyMetric", strategy);
  setText("simTradesMetric", String(metrics.trade_count ?? 0));
  setText("simDurationMetric", active ? fmtDuration(metrics.duration_seconds) : "--");
  setText("simRuntimeMetric", translateState(runtimeState));
  setText("simRuntimeStrategy", runtimeStrategy);
  setText("simRuntimeVersion", strategyVersionName(runtimeVersion));
  setText("simRuntimePairs", runtimePairs.length ? runtimePairs.join(", ") : "--");
  setText("simStartedAt", active?.started_at || "--");
  setText("simModeLine", `${config.trading_mode || "--"} / dry-run=${String(config.dry_run)} / sandbox=${String(config.sandbox)}`);
  setText(
    "simCapitalLine",
    `${fmtNumber(capital.stake_amount, 2)} ${currency} / 笔 · ${capital.max_open_trades ?? "--"} 仓 · 钱包 ${fmtNumber(capital.dry_run_wallet, 2)}`,
  );

  const profitNode = $("simProfitMetric");
  if (profitNode) {
    profitNode.textContent = `${fmtNumber(metrics.profit_abs, 4)} ${config.stake_currency || "USDT"}`;
    profitNode.className = classifyNumber(metrics.profit_abs);
  }

  const ratioNode = $("simProfitRatioMetric");
  if (ratioNode) {
    ratioNode.textContent = fmtPercent(metrics.profit_ratio || 0);
    ratioNode.className = classifyNumber(metrics.profit_ratio);
  }

  const warning = $("simulationWarning");
  if (warning) {
    const text =
      simulation?.error ||
      active?.warning ||
      (!config.dry_run ? "当前配置不是 dry-run，模拟交易页已进入危险状态。" : "");
    warning.textContent = text;
    warning.classList.toggle("hidden", !text);
  }

  const startBtn = $("startSimulationBtn");
  const stopBtn = $("stopSimulationBtn");
  if (startBtn) startBtn.disabled = state.loading || Boolean(active) || !config.dry_run;
  if (stopBtn) stopBtn.disabled = state.loading || !active;
  renderSimulationOrders(snapshot || {}, active);
  renderSimulationLogs(snapshot || {}, simulation || {});
  const history = simulation?.history || [];
  renderSimulationHistory(history);
  if (state.selectedSimulationHistoryId && !history.some((item) => item.id === state.selectedSimulationHistoryId)) {
    state.selectedSimulationHistoryId = null;
    state.simulationDetail = null;
    renderSimulationDetail(null);
  } else if (!state.selectedSimulationHistoryId && !state.simulationDetail) {
    renderSimulationDetail(null);
  }
}

function renderLive(snapshot) {
  const config = snapshot?.local_config || {};
  const remote = snapshot?.show_config || {};
  const profit = snapshot?.profit || {};
  const liveEnabled = config.dry_run === false;
  const runtimeState = (snapshot?.health && snapshot.health.bot_state) || remote.state || "unknown";
  const pair = state.selectedLivePair || $("livePairSelect")?.value || config.pairs?.[0] || state.watchlist[0] || "--";
  const strategy = config.strategy || remote.strategy || state.strategyState.applied_strategy || "--";
  const runtimeVersion = state.simulation?.active?.strategy_version || $("liveVersionSelect")?.value || "";
  const pairs = config.pairs || [];
  const openTrades = liveEnabled ? (Array.isArray(snapshot?.status) ? snapshot.status : []) : [];
  const profitRatio = liveEnabled ? (profit.profit_all_ratio ?? profit.profit_closed_ratio ?? 0) : 0;
  const profitAbs = liveEnabled ? (profit.profit_all_coin ?? profit.profit_closed_coin ?? 0) : 0;
  const tradeCount = liveEnabled ? (profit.trade_count ?? profit.closed_trade_count ?? 0) : 0;

  const badge = $("liveRunBadge");
  if (badge) {
    badge.textContent = liveEnabled ? translateState(runtimeState) : "安全锁定";
    badge.className = `badge ${liveEnabled ? (runtimeState === "running" ? "safe" : "warn") : "danger"}`;
  }

  setText("livePairMetric", pair);
  setText("liveStrategyMetric", strategy);
  setText("liveTradesMetric", String(tradeCount));
  setText("liveRuntimeMetric", liveEnabled ? translateState(runtimeState) : "实盘未启用");
  setText("liveDurationMetric", liveEnabled && runtimeState === "running" ? "运行中" : "--");
  setText("liveStartedAt", liveEnabled ? "由 Freqtrade 接管" : "未启用");
  setText("liveModeLine", `${config.trading_mode || "--"} / dry-run=${String(config.dry_run)} / sandbox=${String(config.sandbox)}`);
  setText("liveRuntimeStrategy", strategy);
  setText("liveRuntimeVersion", strategyVersionName(runtimeVersion));
  setText("liveRuntimePairs", pairs.length ? pairs.join(", ") : "--");
  setText("liveCapitalLine", liveEnabled ? `${config.stake_amount ?? "--"} ${config.stake_currency || "USDT"} / 笔 · ${config.max_open_trades ?? "--"} 仓` : "实盘未启用");

  const profitNode = $("liveProfitMetric");
  if (profitNode) {
    profitNode.textContent = liveEnabled ? `${fmtNumber(profitAbs, 4)} ${config.stake_currency || "USDT"}` : "--";
    profitNode.className = liveEnabled ? classifyNumber(profitAbs) : "";
  }
  const ratioNode = $("liveProfitRatioMetric");
  if (ratioNode) {
    ratioNode.textContent = liveEnabled ? fmtPercent(profitRatio) : "--";
    ratioNode.className = liveEnabled ? classifyNumber(profitRatio) : "";
  }

  setText("liveOpenTradeBadge", `${openTrades.length} 笔`);
  renderLiveTradeRows(openTrades, config);
  renderLiveOrders(snapshot || {}, liveEnabled, pair);
  renderLiveLogs(snapshot || {}, liveEnabled);
  renderLivePerformance(snapshot?.performance || [], liveEnabled);

  const warning = $("liveWarning");
  if (warning) {
    warning.textContent = liveEnabled
      ? "当前 profile 已不是 dry-run。实盘执行必须经过独立 API 权限、资金上限和人工确认。"
      : "当前项目仍处于 dry-run / sandbox 阶段。实盘按钮仅作为页面结构预留。";
    warning.classList.toggle("hidden", false);
  }
}

function renderLiveTradeRows(trades, config) {
  const body = $("liveTradeRows");
  if (!body) return;
  body.innerHTML = "";
  if (!trades.length) {
    body.innerHTML = `<tr class="empty-trades-row"><td colspan="6">当前没有实盘持仓</td></tr>`;
    return;
  }
  for (const trade of trades) {
    const profit = trade.profit_ratio ?? trade.profit_pct ?? 0;
    const stake = Number(trade.stake_amount ?? trade.open_trade_value);
    const amount = Number(trade.amount || trade.amount_requested || 0);
    const rate = Number(trade.current_rate || trade.open_rate || 0);
    const positionValue = Number.isFinite(stake) && stake > 0 ? stake : amount * rate;
    body.insertAdjacentHTML(
      "beforeend",
      `<tr>
        <td>${escapeHTML(trade.pair || "--")}</td>
        <td>${escapeHTML(trade.trade_direction || trade.enter_tag || "long")}</td>
        <td>${fmtNumber(trade.open_rate, 4)}</td>
        <td>${fmtNumber(positionValue, 2)} ${escapeHTML(trade.quote_currency || config.stake_currency || "USDT")}</td>
        <td class="${classifyNumber(profit)}">${fmtPercent(profit)}</td>
        <td>${escapeHTML(trade.open_date_hum || trade.open_date || "--")}</td>
      </tr>`,
    );
  }
}

function renderLiveOrders(snapshot, liveEnabled, pair) {
  const rows = liveEnabled ? normalizeOrderRows(snapshot || {}, pair).slice(0, 80) : [];
  setText("liveOrderBadge", `${rows.length} 条`);
  const body = $("liveOrderRows");
  if (!body) return;
  body.innerHTML = "";
  if (!rows.length) {
    const message = liveEnabled ? "暂无实盘订单。" : "实盘未启用。未来切换 live profile 后，这里只显示真实订单。";
    body.innerHTML = `<tr><td colspan="6" class="diagnostic-empty">${escapeHTML(message)}</td></tr>`;
    return;
  }
  for (const row of rows) {
    const statusClass = orderStatusClass(row.status);
    const statusText = orderStatusLabel(row.status);
    const sideText = orderSideLabel(row.side);
    const sideClass = String(row.side || "").toLowerCase().includes("sell") || sideText === "卖出" ? "sell" : "buy";
    body.insertAdjacentHTML(
      "beforeend",
      `<tr>
        <td><span class="muted">${escapeHTML(compactDateTime(row.time))}</span></td>
        <td><span class="order-side ${sideClass}">${escapeHTML(sideText)}</span></td>
        <td><span class="order-status ${statusClass}" title="${escapeHTML(row.status || "")}">${escapeHTML(statusText)}</span></td>
        <td>${fmtNumber(row.price, 4)}</td>
        <td>${fmtNumber(row.amount, 6)}</td>
        <td>${fmtNumber(row.cost, 2)}</td>
      </tr>`,
    );
  }
}

function renderLiveLogs(snapshot, liveEnabled) {
  const rows = parseLogRows(snapshot?.logs);
  const filter = $("liveLogFilter")?.value || "trade";
  const filtered = liveEnabled ? rows.filter((row) => logMatchesFilter(row, filter)) : [];
  setText("liveLogBadge", liveEnabled ? `${filtered.length}/${rows.length} 条` : "锁定");
  setText(
    "liveReasonHint",
    liveEnabled
      ? "实盘 profile 已启用；请重点关注下单失败、余额不足、拒单、API timeout 和风控触发。"
      : "实盘未启用；当前只展示与模拟交易一致的页面结构。",
  );
  if (!liveEnabled) {
    setText("liveLogText", "暂无实盘日志。");
    return;
  }
  if (!filtered.length) {
    setText("liveLogText", rows.length ? "当前筛选条件下暂无实盘日志，可以切换为“全部日志”。" : "暂无实盘日志");
    return;
  }
  const tail = filtered.slice(-120).map((row) => `[${row.time}] ${row.level} ${row.source}: ${row.message}`);
  setText("liveLogText", tail.join("\n"));
}

function renderLivePerformance(items, liveEnabled) {
  const box = $("livePerformanceList");
  if (!box) return;
  box.innerHTML = "";
  if (!liveEnabled) {
    box.innerHTML = `<div class="perf-card"><h4>实盘未启用</h4><p class="panel-note">未来这里显示真实交易对表现。</p></div>`;
    return;
  }
  if (!items.length) {
    box.innerHTML = `<div class="perf-card"><h4>暂无实盘交易表现</h4></div>`;
    return;
  }
  for (const item of items.slice(0, 8)) {
    const profit = item.profit_ratio ?? item.profit ?? 0;
    box.insertAdjacentHTML(
      "beforeend",
      `<div class="perf-card">
        <h4>${escapeHTML(item.pair || "--")}</h4>
        <div class="report-metrics">
          <div><span>交易数</span><strong>${item.count ?? "--"}</strong></div>
          <div><span>收益</span><strong class="${classifyNumber(profit)}">${fmtPercent(profit)}</strong></div>
          <div><span>平均收益</span><strong>${fmtPercent(item.profit_mean ?? 0)}</strong></div>
        </div>
      </div>`,
    );
  }
}

function renderSimulationHistory(items) {
  const box = $("simulationHistoryList");
  if (!box) return;
  box.innerHTML = "";
  if (!items.length) {
    box.innerHTML = `<div class="report-card">暂无模拟交易记录</div>`;
    return;
  }
  for (const item of items) {
    const metrics = item.metrics || {};
    const version = item.strategy_version;
    const subtitle = `${item.pair || "--"} · ${item.started_at || "--"} 至 ${item.ended_at || "--"}`;
    const detailButton = item.id
      ? `<button class="record-detail-button" type="button" data-simulation-id="${escapeHTML(item.id)}">详情</button>`
      : "";
    const deleteButton = item.id
      ? `<button class="record-delete-button" type="button" data-history-type="simulation" data-record-id="${escapeHTML(item.id)}" title="删除这条模拟交易记录">删除</button>`
      : "";
    const activeClass = item.id && item.id === state.selectedSimulationHistoryId ? " active" : "";
    box.insertAdjacentHTML(
      "beforeend",
      `<div class="report-card${activeClass}">
        <div class="report-card-head">
          <h4>${escapeHTML(item.strategy || "--")}</h4>
          <div class="report-card-actions">${detailButton}${deleteButton}</div>
        </div>
        <p class="report-subtitle">${escapeHTML(subtitle)}</p>
        <p class="report-subtitle">策略版本：${escapeHTML(strategyVersionName(version))}</p>
        <div class="report-metrics two">
          <div><span>交易数</span><strong>${escapeHTML(metrics.trade_count ?? 0)}</strong></div>
          <div><span>收益</span><strong class="${classifyNumber(metrics.profit_abs)}">${fmtNumber(metrics.profit_abs, 4)} USDT</strong></div>
          <div><span>收益率</span><strong class="${classifyNumber(metrics.profit_ratio)}">${fmtPercent(metrics.profit_ratio || 0)}</strong></div>
          <div><span>运行时长</span><strong>${escapeHTML(fmtDuration(metrics.duration_seconds || 0))}</strong></div>
        </div>
      </div>`,
    );
  }
}

function simulationSessionBounds(record, options = {}) {
  const start = Date.parse(record?.started_at);
  const end = Date.parse(record?.ended_at);
  const startGraceMs = Number(options.startGraceMs ?? 60_000);
  const endGraceMs = Number(options.endGraceMs ?? 5 * 60_000);
  return {
    start: Number.isFinite(start) ? start - startGraceMs : null,
    end: Number.isFinite(end) ? end + endGraceMs : null,
  };
}

function isWithinSimulationSession(time, bounds) {
  if (!Number.isFinite(time)) return false;
  if (bounds.start && time < bounds.start) return false;
  if (bounds.end && time > bounds.end) return false;
  return true;
}

function simulationDetailSnapshot(record) {
  return record?.detail_snapshot || record?.snapshot || {};
}

function simulationDetailOrders(record) {
  const snapshot = simulationDetailSnapshot(record);
  const bounds = simulationSessionBounds(record);
  return normalizeOrderRows(snapshot, record?.pair)
    .filter((row) => isWithinSimulationSession(row.time, bounds))
    .slice(0, 120);
}

function simulationDetailTrades(record) {
  const snapshot = simulationDetailSnapshot(record);
  const bounds = simulationSessionBounds(record);
  return normalizeTradeHistory(snapshot?.trades_history)
    .filter((trade) => {
      if (record?.pair && trade.pair !== record.pair) return false;
      const openTime = tradeTimestamp(trade, ["open_timestamp", "open_date", "open_date_utc"]);
      const closeTime = tradeTimestamp(trade, ["close_timestamp", "close_date", "close_date_utc"]);
      return isWithinSimulationSession(openTime, bounds) || isWithinSimulationSession(closeTime, bounds);
    })
    .slice(0, 120);
}

async function loadSimulationDetail(id, silent = false) {
  if (!id) return;
  state.selectedSimulationHistoryId = id;
  if (!silent) {
    renderSimulationHistory(state.simulation?.history || []);
    renderSimulationDetail({ loading: true, id });
  }
  try {
    const detail = await getJSON(`/api/simulation/detail?id=${encodeURIComponent(id)}`);
    state.simulationDetail = detail;
    renderSimulationDetail(detail);
    renderSimulationHistory(state.simulation?.history || []);
  } catch (error) {
    renderSimulationDetail({ error: error.message });
    toast(error.message);
  }
}

function renderSimulationDetail(detail) {
  const box = $("simulationDetail");
  const badge = $("simulationDetailBadge");
  if (!box) return;
  if (!detail) {
    if (badge) {
      badge.textContent = "未选择";
      badge.className = "badge neutral";
    }
    box.className = "backtest-detail-empty";
    box.innerHTML = "请选择一条模拟交易历史记录";
    return;
  }
  if (detail.loading) {
    if (badge) {
      badge.textContent = "加载中";
      badge.className = "badge warn";
    }
    box.className = "backtest-detail-empty";
    box.innerHTML = "正在读取模拟交易详情...";
    return;
  }
  if (detail.error) {
    if (badge) {
      badge.textContent = "读取失败";
      badge.className = "badge danger";
    }
    box.className = "backtest-detail-empty";
    box.innerHTML = escapeHTML(detail.error);
    return;
  }

  const record = detail.record || detail;
  const metrics = record.metrics || {};
  const capital = record.capital || {};
  const forceExit = record.force_exit || {};
  const snapshot = simulationDetailSnapshot(record);
  const hasSnapshot = Boolean(snapshot?.collected_at || snapshot?.trades_history || snapshot?.logs);
  const orders = simulationDetailOrders(record);
  const trades = simulationDetailTrades(record);
  const currency = capital.stake_currency || state.snapshot?.local_config?.stake_currency || "USDT";
  const versionName = strategyVersionName(record.strategy_version);
  if (badge) {
    badge.textContent = record.strategy || "详情";
    badge.className = "badge safe";
  }
  box.className = "backtest-detail simulation-detail";
  box.innerHTML = `
    <section class="backtest-detail-hero">
      <div>
        <p class="eyebrow">模拟会话</p>
        <h4>${escapeHTML(record.strategy || "--")}</h4>
        <span>${escapeHTML(record.pair || "--")} · ${escapeHTML(record.timeframe || "--")} · ${escapeHTML(versionName)} · ${escapeHTML(record.started_at || "--")} 至 ${escapeHTML(record.ended_at || "--")}</span>
      </div>
      <div class="detail-source">${escapeHTML(record.id || "--")}</div>
    </section>
    <section class="detail-metrics">
      ${backtestMetricCard("会话收益", `${detailNumber(metrics.profit_abs, 4)} ${currency}`, classifyNumber(metrics.profit_abs))}
      ${backtestMetricCard("收益率", detailPercent(metrics.profit_ratio), classifyNumber(metrics.profit_ratio))}
      ${backtestMetricCard("交易次数", detailNumber(metrics.trade_count, 0))}
      ${backtestMetricCard("运行时长", fmtDuration(metrics.duration_seconds || 0))}
      ${backtestMetricCard("策略版本", versionName)}
      ${backtestMetricCard("单笔投入", `${detailNumber(capital.stake_amount, 2)} ${currency}`)}
      ${backtestMetricCard("资金边界", `${detailNumber(capital.dry_run_wallet, 2)} / ${detailNumber(capital.max_exposure, 2)}`)}
      ${backtestMetricCard("平仓/清理", `${(forceExit.exited || []).length} / ${(forceExit.cleaned_orders || []).length}`)}
      ${backtestMetricCard("详情快照", hasSnapshot ? "已归档" : "仅摘要", hasSnapshot ? "positive" : "")}
    </section>
    ${hasSnapshot ? "" : `<section class="simulation-detail-note">这条记录创建于详情归档功能之前，所以只能显示摘要指标。从下一次关闭模拟交易开始，会自动保存订单、交易和日志快照。</section>`}
    <section class="detail-grid-two">
      ${renderSimulationDetailOrdersTable(orders, currency)}
      ${renderSimulationDetailTradesTable(trades, currency)}
    </section>
    <section class="detail-trades">
      <div class="panel-head compact-head">
        <h4>运行日志</h4>
        <span>${escapeHTML(snapshot?.collected_at || "未归档")}</span>
      </div>
      ${renderSimulationDetailLogs(record)}
    </section>
  `;
}

function renderSimulationDetailOrdersTable(rows, currency) {
  const body = rows.length
    ? rows.map((row) => {
      const sideText = orderSideLabel(row.side);
      const sideClass = String(row.side || "").toLowerCase().includes("sell") || sideText === "卖出" ? "sell" : "buy";
      return `
        <tr>
          <td>${escapeHTML(compactDateTime(row.time))}</td>
          <td><span class="order-side ${sideClass}">${escapeHTML(sideText)}</span></td>
          <td><span class="order-status ${orderStatusClass(row.status)}" title="${escapeHTML(row.status || "")}">${escapeHTML(orderStatusLabel(row.status))}</span></td>
          <td>${detailNumber(row.price, 4)}</td>
          <td>${detailNumber(row.amount, 6)}</td>
          <td>${detailNumber(row.cost, 2)} ${escapeHTML(currency)}</td>
        </tr>`;
    }).join("")
    : `<tr><td colspan="6">暂无本次会话订单快照</td></tr>`;
  return `
    <div class="detail-table-card">
      <h4>会话订单</h4>
      <div class="table-wrap simulation-detail-table">
        <table>
          <thead><tr><th>时间</th><th>方向</th><th>状态</th><th>价格</th><th>数量</th><th>金额</th></tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </div>`;
}

function renderSimulationDetailTradesTable(trades, currency) {
  const body = trades.length
    ? trades.map((trade) => `
      <tr>
        <td>${escapeHTML(trade.open_date || "--")}</td>
        <td>${escapeHTML(trade.close_date || (trade.is_open ? "持仓中" : "--"))}</td>
        <td>${detailNumber(trade.open_rate, 4)}</td>
        <td>${detailNumber(trade.close_rate || trade.current_rate, 4)}</td>
        <td class="${classifyNumber(trade.profit_ratio)}">${detailPercent(trade.profit_ratio)}</td>
        <td class="${classifyNumber(trade.profit_abs)}">${detailNumber(trade.profit_abs, 4)} ${escapeHTML(currency)}</td>
        <td>${escapeHTML(trade.exit_reason || trade.enter_tag || "--")}</td>
      </tr>`).join("")
    : `<tr><td colspan="7">暂无本次会话成交明细</td></tr>`;
  return `
    <div class="detail-table-card">
      <h4>成交明细</h4>
      <div class="table-wrap simulation-detail-table">
        <table>
          <thead><tr><th>开仓</th><th>平仓</th><th>开仓价</th><th>平仓价</th><th>收益率</th><th>收益</th><th>原因</th></tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </div>`;
}

function renderSimulationDetailLogs(record) {
  const snapshot = simulationDetailSnapshot(record);
  const rows = parseLogRows(snapshot?.logs);
  if (!rows.length) return `<pre class="simulation-detail-log">暂无本次会话日志快照</pre>`;
  const strategy = String(record?.strategy || "").toLowerCase();
  const pair = String(record?.pair || "").toLowerCase();
  const relevant = rows.filter((row) => {
    const text = `${row.source} ${row.level} ${row.message}`.toLowerCase();
    return logMatchesFilter(row, "trade") || logMatchesFilter(row, "strategy") || (strategy && text.includes(strategy)) || (pair && text.includes(pair));
  });
  const shown = (relevant.length ? relevant : rows).slice(-160);
  const text = shown.map((row) => `[${row.time}] ${row.level} ${row.source}: ${row.message}`).join("\n");
  return `<pre class="simulation-detail-log">${escapeHTML(text)}</pre>`;
}

function renderBalances(currencies) {
  const body = $("balanceRows");
  body.innerHTML = "";
  if (!currencies.length) {
    body.innerHTML = `<tr><td colspan="4">暂无资产数据</td></tr>`;
    return;
  }
  for (const item of currencies.slice(0, 12)) {
    body.insertAdjacentHTML(
      "beforeend",
      `<tr>
        <td>${escapeHTML(item.currency || "--")}</td>
        <td>${fmtNumber(item.balance, 6)}</td>
        <td>${fmtNumber(item.free, 6)}</td>
        <td>${fmtNumber(item.used, 6)}</td>
      </tr>`,
    );
  }
}

function renderStrategies(items, config) {
  setText("strategyCountBadge", `${items.length} 个`);
  const list = $("strategyList");
  list.innerHTML = "";
  fillStrategySelect(items, config.strategy);
  if (!items.length) {
    list.innerHTML = `<div class="empty-card">暂无策略文件</div>`;
    renderStrategyDetail(null);
    return;
  }
  for (const item of items) {
    const name = item.class_name || item.name;
    const active = name === state.selectedStrategy;
    const card = document.createElement("article");
    card.className = `library-card clickable ${active ? "active" : ""} ${item.disabled ? "disabled" : ""}`;
    card.innerHTML = `
        <div>
          <div class="card-title-row">
            <h4>${escapeHTML(name)}</h4>
            <span>${strategyStatusLabel(item)}</span>
          </div>
          <p>${escapeHTML(item.description || item.file || "--")}</p>
        </div>
      `;
    card.addEventListener("click", () => {
      state.selectedStrategy = name;
      renderStrategies(state.strategies, state.snapshot?.local_config || {});
    });
    list.appendChild(card);
  }
  renderStrategyDetail(strategyByName(state.selectedStrategy) || items[0]);
}

function fillStrategySelect(items, activeStrategy) {
  const selects = [$("backtestStrategySelect"), $("hyperoptStrategySelect")].filter(Boolean);
  const usable = items.filter((entry) => !entry.disabled);
  for (const select of selects) {
    select.innerHTML = "";
    if (!usable.length) {
      select.innerHTML = `<option value="">暂无策略</option>`;
      continue;
    }
    for (const item of usable) {
      const name = item.class_name || item.name;
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      option.selected = name === activeStrategy;
      select.appendChild(option);
    }
  }
  fillStrategyVersionSelect("backtestVersionSelect", $("backtestStrategySelect")?.value || activeStrategy, state.selectedBacktestVersion);
}

function strategyVersionsFor(strategy, enabledOnly = true) {
  return state.strategyVersions.filter((item) => item.strategy === strategy && (!enabledOnly || item.enabled !== false));
}

function strategyVersionLabel(item) {
  if (!item) return "使用策略文件默认参数";
  const metric = item.metrics?.profit_pct !== undefined ? ` / ${fmtNumber(Number(item.metrics.profit_pct), 2)}%` : "";
  return `${item.name}${metric}`;
}

function fillStrategyVersionSelect(selectId, strategy, selectedId, disabled = false) {
  const select = $(selectId);
  if (!select) return;
  const versions = strategyVersionsFor(strategy, true);
  select.innerHTML = "";
  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = "使用策略文件默认参数";
  select.appendChild(defaultOption);
  for (const item of versions) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = strategyVersionLabel(item);
    option.selected = item.id === selectedId;
    select.appendChild(option);
  }
  if (selectedId && !versions.some((item) => item.id === selectedId)) {
    select.value = "";
  }
  select.disabled = disabled;
}

function renderStrategyVersions(items) {
  setText("strategyVersionCountBadge", `${items.length} 个`);
  const box = $("strategyVersionList");
  if (!box) return;
  box.innerHTML = "";
  if (!items.length) {
    box.innerHTML = `<div class="empty-card">暂无策略版本。可以先在回测页运行参数优化，再从历史优化记录保存为版本。</div>`;
    return;
  }
  for (const item of items) {
    const paramsText = hyperoptParamSummary(item.params);
    const source = item.source_type === "hyperopt" ? "来自参数优化" : "手动版本";
    const sourceSummary = item.source_summary || {};
    const sourceText = [sourceSummary.pair, sourceSummary.timeframe, sourceSummary.epochs ? `${sourceSummary.epochs}轮` : ""].filter(Boolean).join(" · ");
    const profit = item.metrics?.profit_pct;
    const profitText = Number.isFinite(Number(profit)) ? `${fmtNumber(Number(profit), 2)}%` : "--";
    box.insertAdjacentHTML(
      "beforeend",
      `<article class="version-card ${item.enabled === false ? "disabled" : ""}">
        <div class="version-card-main">
          <div class="card-title-row">
            <h4>${escapeHTML(item.name)}</h4>
            <span>${escapeHTML(item.enabled === false ? "已禁用" : "可用")}</span>
          </div>
          <p>${escapeHTML(item.strategy)} · ${escapeHTML(source)}${sourceText ? ` · ${escapeHTML(sourceText)}` : ""}</p>
          <div class="version-params">${escapeHTML(paramsText)}</div>
        </div>
        <div class="version-card-side">
          <span>优化收益</span>
          <strong class="${classifyNumber(Number(profit))}">${escapeHTML(profitText)}</strong>
          <div class="version-actions">
            <button class="button success tiny" type="button" data-version-export-id="${escapeHTML(item.id)}">添加到策略库</button>
            <button class="button secondary tiny" type="button" data-version-action="rename" data-version-id="${escapeHTML(item.id)}">重命名</button>
            <button class="button warn tiny" type="button" data-version-action="${item.enabled === false ? "enable" : "disable"}" data-version-id="${escapeHTML(item.id)}">${item.enabled === false ? "启用" : "禁用"}</button>
            <button class="button danger tiny" type="button" data-version-action="delete" data-version-id="${escapeHTML(item.id)}">删除</button>
          </div>
        </div>
      </article>`,
    );
  }
}

function fillExperimentFormSelects() {
  const strategySelect = $("experimentStrategySelect");
  if (strategySelect) {
    const previous = strategySelect.value;
    strategySelect.innerHTML = "";
    const usable = state.strategies.filter((entry) => !entry.disabled);
    for (const item of usable) {
      const name = item.class_name || item.name;
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      option.selected = name === (previous || state.selectedStrategy);
      strategySelect.appendChild(option);
    }
  }
  const datasetSelect = $("experimentDatasetSelect");
  if (datasetSelect) {
    const previous = datasetSelect.value;
    datasetSelect.innerHTML = "";
    for (const item of state.dataInventory) {
      const option = document.createElement("option");
      option.value = item.dataset_id;
      option.textContent = item.name || `${item.pair} ${item.timeframe}`;
      option.selected = item.dataset_id === previous;
      datasetSelect.appendChild(option);
    }
  }
}

function openExperimentForm(experimentId = null) {
  const form = $("experimentForm");
  if (!form) return;
  form.classList.remove("hidden");
  fillExperimentFormSelects();
  state.editingExperimentId = experimentId || null;
  const record = experimentId ? state.experiments.find((item) => item.id === experimentId) : null;
  $("experimentName").value = record?.name || "";
  $("experimentPurpose").value = record?.purpose || "";
  if (record?.strategy) $("experimentStrategySelect").value = record.strategy;
  if (record?.dataset_id) $("experimentDatasetSelect").value = record.dataset_id;
  $("experimentStart").value = record?.start || "";
  $("experimentEnd").value = record?.end || "";
  $("experimentParams").value = record?.params_summary || "";
  $("experimentResult").value = record?.result_summary || "";
  $("experimentConclusion").value = record?.conclusion || "";
  $("experimentPromoted").checked = Boolean(record?.promoted_to_simulation);
}

function closeExperimentForm() {
  const form = $("experimentForm");
  if (form) form.classList.add("hidden");
  state.editingExperimentId = null;
}

async function saveExperimentForm() {
  const name = $("experimentName").value.trim();
  if (!name) {
    toast("实验名称不能为空");
    return;
  }
  const datasetSelect = $("experimentDatasetSelect");
  const dataset = state.dataInventory.find((item) => item.dataset_id === datasetSelect?.value);
  const payload = {
    name,
    purpose: $("experimentPurpose").value.trim(),
    strategy: $("experimentStrategySelect")?.value || "",
    dataset_id: datasetSelect?.value || "",
    dataset_name: dataset?.name || "",
    pair: dataset?.pair || "",
    start: $("experimentStart").value,
    end: $("experimentEnd").value,
    params_summary: $("experimentParams").value.trim(),
    result_summary: $("experimentResult").value.trim(),
    conclusion: $("experimentConclusion").value.trim(),
    promoted_to_simulation: $("experimentPromoted").checked,
  };
  try {
    if (state.editingExperimentId) {
      await postJSON("/api/experiments/update", { id: state.editingExperimentId, ...payload });
      toast("实验记录已更新");
    } else {
      await postJSON("/api/experiments/create", payload);
      toast("实验记录已保存");
    }
    closeExperimentForm();
    const experiments = await getJSON("/api/experiments");
    state.experiments = experiments.items || [];
    renderExperiments(state.experiments);
    renderReportExperimentList(state.experiments);
  } catch (error) {
    toast(error.message);
  }
}

async function deleteExperimentRecord(id) {
  if (!id) return;
  if (!window.confirm("确定删除这条实验记录吗？")) return;
  try {
    await postJSON("/api/experiments/delete", { id });
    const experiments = await getJSON("/api/experiments");
    state.experiments = experiments.items || [];
    renderExperiments(state.experiments);
    renderReportExperimentList(state.experiments);
    toast("实验记录已删除");
  } catch (error) {
    toast(error.message);
  }
}

async function togglePromoteExperiment(id, currentValue) {
  if (!id) return;
  try {
    await postJSON("/api/experiments/update", { id, promoted_to_simulation: !currentValue });
    const experiments = await getJSON("/api/experiments");
    state.experiments = experiments.items || [];
    renderExperiments(state.experiments);
    renderReportExperimentList(state.experiments);
  } catch (error) {
    toast(error.message);
  }
}

function renderExperiments(items) {
  setText("experimentCountBadge", `${items.length} 条`);
  const box = $("experimentList");
  if (!box) return;
  box.innerHTML = "";
  if (!items.length) {
    box.innerHTML = `<div class="empty-card">暂无实验记录。运行回测或参数优化后，可以新建一条实验记录保存目的、结果和结论。</div>`;
    return;
  }
  for (const item of items) {
    const subtitle = `${item.strategy || "--"} · ${item.dataset_name || item.dataset_id || "--"} · ${item.start || "--"} 至 ${item.end || "--"}`;
    const card = document.createElement("article");
    card.className = "library-card experiment-card";
    card.innerHTML = `
      <div>
        <div class="card-title-row">
          <h4>${escapeHTML(item.name)}</h4>
          <span>${item.promoted_to_simulation ? "已进入模拟交易" : "未进入模拟交易"}</span>
        </div>
        <p>${escapeHTML(subtitle)}</p>
        <p class="panel-note">目的：${escapeHTML(item.purpose || "暂无数据")}</p>
        <p class="panel-note">结论：${escapeHTML(item.conclusion || "暂无数据")}</p>
      </div>
      <div class="detail-actions">
        <button class="button secondary tiny" type="button" data-experiment-edit="${escapeHTML(item.id)}">查看/编辑</button>
        <button class="button warn tiny" type="button" data-experiment-promote="${escapeHTML(item.id)}" data-promote-value="${item.promoted_to_simulation ? "true" : "false"}">${item.promoted_to_simulation ? "取消模拟标记" : "标记为已模拟"}</button>
        <button class="button danger tiny" type="button" data-experiment-delete="${escapeHTML(item.id)}">删除</button>
      </div>
    `;
    box.appendChild(card);
  }
}

function fillSimulationControls() {
  const active = state.simulation?.active;
  const config = state.snapshot?.local_config || {};
  const strategySelect = $("simulationStrategySelect");
  const selectedStrategy = active?.strategy || strategySelect?.value || state.strategyState.applied_strategy || config.strategy || state.strategies.find((entry) => !entry.disabled)?.class_name;
  const pairSelect = $("simulationPairSelect");
  const capital = simulationCapitalSource(active, config);

  if (strategySelect) {
    strategySelect.innerHTML = "";
    const usableStrategies = state.strategies.filter((entry) => !entry.disabled);
    if (!usableStrategies.length) {
      strategySelect.innerHTML = `<option value="">暂无策略</option>`;
    } else {
      const selected = selectedStrategy || usableStrategies[0].class_name;
      for (const item of usableStrategies) {
        const name = item.class_name || item.name;
        const option = document.createElement("option");
        option.value = name;
        option.textContent = name;
        option.selected = name === selected;
        strategySelect.appendChild(option);
      }
    }
    strategySelect.disabled = Boolean(active);
  }
  fillStrategyVersionSelect(
    "simulationVersionSelect",
    selectedStrategy,
    active?.strategy_version?.id || state.selectedSimulationVersion,
    Boolean(active),
  );

  if (pairSelect) {
    pairSelect.innerHTML = "";
    if (!state.watchlist.length) {
      pairSelect.innerHTML = `<option value="">暂无自选交易对</option>`;
    } else {
      const selected = active?.pair || state.selectedSimulationPair || state.selectedPair || state.watchlist[0];
      state.selectedSimulationPair = selected;
      for (const pair of state.watchlist) {
        const option = document.createElement("option");
        option.value = pair;
        option.textContent = pair;
        option.selected = pair === selected;
        pairSelect.appendChild(option);
      }
    }
    pairSelect.disabled = Boolean(active);
  }

  setCapitalInput("simulationWalletInput", capital.dry_run_wallet ?? 10000, active);
  setCapitalInput("simulationStakeInput", capital.stake_amount ?? 100, active);
  setCapitalInput("simulationMaxOpenInput", capital.max_open_trades ?? 1, active);
  setCapitalInput("simulationBalanceRatioInput", capital.tradable_balance_ratio ?? 0.99, active);
  syncSimulationCapitalPreview();
}

function fillLiveControls() {
  const strategySelect = $("liveStrategySelect");
  const pairSelect = $("livePairSelect");
  const config = state.snapshot?.local_config || {};
  let selectedStrategy = state.simulation?.active?.strategy || config.strategy || state.strategies.find((entry) => !entry.disabled)?.class_name;
  if (strategySelect) {
    strategySelect.innerHTML = "";
    const usableStrategies = state.strategies.filter((entry) => !entry.disabled);
    if (!usableStrategies.length) {
      strategySelect.innerHTML = `<option value="">暂无策略</option>`;
    } else {
      const selected = selectedStrategy || usableStrategies[0].class_name;
      selectedStrategy = selected;
      for (const item of usableStrategies) {
        const name = item.class_name || item.name;
        const option = document.createElement("option");
        option.value = name;
        option.textContent = name;
        option.selected = name === selected;
        strategySelect.appendChild(option);
      }
    }
  }
  fillStrategyVersionSelect("liveVersionSelect", selectedStrategy, state.simulation?.active?.strategy_version?.id || "", true);
  if (pairSelect) {
    pairSelect.innerHTML = "";
    if (!state.watchlist.length) {
      pairSelect.innerHTML = `<option value="">暂无自选交易对</option>`;
    } else {
      const preferred = state.selectedLivePair || state.simulation?.active?.pair || state.selectedSimulationPair || config.pairs?.[0] || state.watchlist[0];
      const selected = state.watchlist.includes(preferred) ? preferred : state.watchlist[0];
      state.selectedLivePair = selected;
      for (const pair of state.watchlist) {
        const option = document.createElement("option");
        option.value = pair;
        option.textContent = pair;
        option.selected = pair === selected;
        pairSelect.appendChild(option);
      }
    }
  }
}

function fillBacktestDatasetSelect(items) {
  const select = $("backtestDatasetSelect");
  if (!select) return;
  select.innerHTML = "";
  const usable = items.filter((item) => item.status === "可用");
  if (!usable.length) {
    select.innerHTML = `<option value="">暂无可用数据集</option>`;
    syncBacktestDatasetFields(null);
    return;
  }
  if (!state.selectedBacktestDataset || !usable.some((item) => item.dataset_id === state.selectedBacktestDataset)) {
    state.selectedBacktestDataset = usable[0].dataset_id;
  }
  for (const item of usable) {
    const option = document.createElement("option");
    option.value = item.dataset_id;
    option.textContent = item.name || `${item.pair} ${item.timeframe}`;
    option.selected = item.dataset_id === state.selectedBacktestDataset;
    select.appendChild(option);
  }
  syncBacktestDatasetFields(selectedBacktestDataset());
}

function selectedBacktestDataset() {
  return state.dataInventory.find((item) => item.dataset_id === state.selectedBacktestDataset) || null;
}

function syncBacktestDatasetFields(dataset) {
  setText("backtestPair", dataset?.pair || "--");
  setText("backtestTimeframe", dataset?.timeframe || "--");
  const start = $("backtestStart");
  const end = $("backtestEnd");
  if (!dataset) {
    if (start) start.value = "";
    if (end) end.value = "";
    return;
  }
  if (start && (!start.value || start.value < dataset.start || start.value > dataset.end)) {
    start.value = dataset.start || "";
  }
  if (end && (!end.value || end.value < dataset.start || end.value > dataset.end)) {
    end.value = dataset.end || "";
  }
  if (start) {
    start.min = dataset.start || "";
    start.max = dataset.end || "";
  }
  if (end) {
    end.min = dataset.start || "";
    end.max = dataset.end || "";
  }
}

function fillHyperoptDatasetSelect(items) {
  const select = $("hyperoptDatasetSelect");
  if (!select) return;
  select.innerHTML = "";
  const usable = items.filter((item) => item.status === "可用");
  if (!usable.length) {
    select.innerHTML = `<option value="">暂无可用数据集</option>`;
    syncHyperoptDatasetFields(null);
    return;
  }
  if (!state.selectedHyperoptDataset || !usable.some((item) => item.dataset_id === state.selectedHyperoptDataset)) {
    state.selectedHyperoptDataset = state.selectedBacktestDataset && usable.some((item) => item.dataset_id === state.selectedBacktestDataset)
      ? state.selectedBacktestDataset
      : usable[0].dataset_id;
  }
  for (const item of usable) {
    const option = document.createElement("option");
    option.value = item.dataset_id;
    option.textContent = item.name || `${item.pair} ${item.timeframe}`;
    option.selected = item.dataset_id === state.selectedHyperoptDataset;
    select.appendChild(option);
  }
  syncHyperoptDatasetFields(selectedHyperoptDataset());
}

function selectedHyperoptDataset() {
  return state.dataInventory.find((item) => item.dataset_id === state.selectedHyperoptDataset) || null;
}

function syncHyperoptDatasetFields(dataset) {
  setText("hyperoptPair", dataset?.pair || "--");
  setText("hyperoptTimeframe", dataset?.timeframe || "--");
  const start = $("hyperoptStart");
  const end = $("hyperoptEnd");
  if (!dataset) {
    if (start) start.value = "";
    if (end) end.value = "";
    return;
  }
  if (start && (!start.value || start.value < dataset.start || start.value > dataset.end)) {
    start.value = dataset.start || "";
  }
  if (end && (!end.value || end.value < dataset.start || end.value > dataset.end)) {
    end.value = dataset.end || "";
  }
  if (start) {
    start.min = dataset.start || "";
    start.max = dataset.end || "";
  }
  if (end) {
    end.min = dataset.start || "";
    end.max = dataset.end || "";
  }
}

function fillBatchBacktestControls() {
  const strategySelect = $("batchStrategySelect");
  if (strategySelect) {
    const previouslySelected = new Set(Array.from(strategySelect.selectedOptions || []).map((opt) => opt.value));
    strategySelect.innerHTML = "";
    const usable = state.strategies.filter((entry) => !entry.disabled);
    for (const item of usable) {
      const name = item.class_name || item.name;
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      option.selected = previouslySelected.size ? previouslySelected.has(name) : name === state.selectedStrategy;
      strategySelect.appendChild(option);
    }
  }
  const datasetSelect = $("batchDatasetSelect");
  if (datasetSelect) {
    const previouslySelected = new Set(Array.from(datasetSelect.selectedOptions || []).map((opt) => opt.value));
    datasetSelect.innerHTML = "";
    const usable = state.dataInventory.filter((item) => item.status === "可用");
    for (const item of usable) {
      const option = document.createElement("option");
      option.value = item.dataset_id;
      option.textContent = item.name || `${item.pair} ${item.timeframe}`;
      option.selected = previouslySelected.has(item.dataset_id);
      datasetSelect.appendChild(option);
    }
  }
  fillStrategyVersionSelect("batchVersionSelect", $("batchStrategySelect")?.value || state.selectedStrategy, "");
  if (!state.batchRanges.length) {
    const firstDataset = state.dataInventory.find((item) => item.status === "可用");
    state.batchRanges = [{ start: firstDataset?.start || "", end: firstDataset?.end || "" }];
  }
  renderBatchRanges();
}

function renderBatchRanges() {
  const box = $("batchRanges");
  if (!box) return;
  box.innerHTML = "";
  state.batchRanges.forEach((range, index) => {
    const row = document.createElement("div");
    row.className = "batch-range-row";
    row.innerHTML = `
      <input type="date" class="batch-range-start" value="${escapeHTML(range.start || "")}">
      <span>至</span>
      <input type="date" class="batch-range-end" value="${escapeHTML(range.end || "")}">
      <button class="button secondary tiny" type="button" data-remove-range="${index}">移除</button>
    `;
    row.querySelector(".batch-range-start").addEventListener("change", (event) => {
      state.batchRanges[index].start = event.target.value;
    });
    row.querySelector(".batch-range-end").addEventListener("change", (event) => {
      state.batchRanges[index].end = event.target.value;
    });
    box.appendChild(row);
  });
}

function addBatchRange() {
  state.batchRanges.push({ start: "", end: "" });
  renderBatchRanges();
}

function selectedMultiValues(id) {
  const select = $(id);
  if (!select) return [];
  return Array.from(select.selectedOptions || []).map((opt) => opt.value).filter(Boolean);
}

function renderBatchCompareRows(records, errors) {
  const body = $("batchCompareRows");
  if (!body) return;
  body.innerHTML = "";
  if (!records.length && !errors.length) {
    body.innerHTML = `<tr><td colspan="9">暂无批量回测结果</td></tr>`;
    return;
  }
  for (const record of records) {
    const m = record.metrics || {};
    const req = record.requested || {};
    body.insertAdjacentHTML(
      "beforeend",
      `<tr>
        <td>${escapeHTML(m.strategy || req.strategy || "--")}</td>
        <td>${escapeHTML(req.pair || "--")}</td>
        <td>${escapeHTML(req.timeframe || "--")}</td>
        <td>${escapeHTML(req.start || "--")} ~ ${escapeHTML(req.end || "--")}</td>
        <td>${escapeHTML(m.trades ?? "--")}</td>
        <td>${escapeHTML(m.profit ?? "--")}</td>
        <td>${escapeHTML(m.drawdown ?? "--")}</td>
        <td>${escapeHTML(m.win_rate ?? "--")}</td>
        <td>${escapeHTML(m.profit_factor ?? "--")}</td>
      </tr>`,
    );
  }
  for (const err of errors) {
    body.insertAdjacentHTML(
      "beforeend",
      `<tr class="danger-row">
        <td>${escapeHTML(err.strategy || "--")}</td>
        <td colspan="7">失败：${escapeHTML(err.error || "未知错误")}（数据集 ${escapeHTML(err.dataset_name || err.dataset_id || "--")} · ${escapeHTML(err.start || "--")}~${escapeHTML(err.end || "--")}）</td>
        <td></td>
      </tr>`,
    );
  }
}

async function runBatchBacktest() {
  const strategies = selectedMultiValues("batchStrategySelect");
  const datasetIds = selectedMultiValues("batchDatasetSelect");
  const strategyVersionId = $("batchVersionSelect")?.value || "";
  const ranges = state.batchRanges.filter((range) => range.start && range.end);
  if (!strategies.length || !datasetIds.length || !ranges.length) {
    toast("请至少选择一个策略、一个数据集，并填写至少一个时间段");
    return;
  }
  const total = strategies.length * datasetIds.length * ranges.length;
  if (total > 20) {
    toast(`组合数 ${total} 超过上限 20，请减少选择数量`);
    return;
  }
  const button = $("runBatchBacktestBtn");
  if (button) button.disabled = true;
  setText("batchBacktestStatus", `正在运行 ${total} 组批量回测，请稍等...`);
  try {
    const result = await postJSON("/api/backtests/batch-run", {
      strategies,
      dataset_ids: datasetIds,
      strategy_version_id: strategyVersionId,
      ranges,
    });
    setText("batchBacktestStatus", `批量回测完成：成功 ${result.succeeded}/${result.total}，失败 ${result.failed}`);
    renderBatchCompareRows(result.records || [], result.errors || []);
    toast("批量回测完成");
    await refresh();
  } catch (error) {
    setText("batchBacktestStatus", error.message);
    toast(error.message);
  } finally {
    if (button) button.disabled = false;
  }
}

function strategyByName(name) {
  return state.strategies.find((item) => (item.class_name || item.name) === name);
}

function strategyStatusLabel(item) {
  if (item.disabled) return "已禁用";
  if (item.is_runtime && item.is_applied) return "运行中 / 已应用";
  if (item.is_runtime) return "运行中";
  if (item.is_applied) return "已应用";
  return "可用";
}

function renderStrategyDetail(item) {
  const box = $("strategyDetail");
  const badge = $("strategyDetailBadge");
  const applyBtn = $("applyStrategyBtn");
  const disableBtn = $("disableStrategyBtn");
  if (!item) {
    box.innerHTML = `<div class="empty-card">点击左侧策略卡片查看详情</div>`;
    badge.textContent = "请选择";
    badge.className = "badge neutral";
    applyBtn.disabled = true;
    disableBtn.disabled = true;
    return;
  }
  const name = item.class_name || item.name;
  const roi = item.minimal_roi ? Object.entries(item.minimal_roi).map(([k, v]) => `${k}分钟: ${v}`).join(" / ") : "--";
  badge.textContent = strategyStatusLabel(item);
  badge.className = `badge ${item.disabled ? "warn" : item.is_applied ? "safe" : "neutral"}`;
  applyBtn.disabled = item.disabled || item.is_applied;
  disableBtn.disabled = false;
  disableBtn.textContent = item.disabled ? "启用" : "禁用";
  applyBtn.dataset.strategy = name;
  disableBtn.dataset.strategy = name;
  disableBtn.dataset.action = item.disabled ? "enable" : "disable";
  box.innerHTML = `
    <div class="strategy-hero">
      <h4>${escapeHTML(name)}</h4>
      <p>${escapeHTML(item.description || "暂无策略说明")}</p>
    </div>
    <dl class="kv strategy-kv">
      <div><dt>文件</dt><dd>${escapeHTML(item.file || "--")}</dd></div>
      <div><dt>周期</dt><dd>${escapeHTML(item.timeframe || "--")}</dd></div>
      <div><dt>是否做空</dt><dd>${item.can_short ? "允许" : "禁止"}</dd></div>
      <div><dt>止损</dt><dd>${escapeHTML(String(item.stoploss ?? "--"))}</dd></div>
      <div><dt>ROI</dt><dd>${escapeHTML(roi)}</dd></div>
      <div><dt>更新时间</dt><dd>${escapeHTML(item.modified || "--")}</dd></div>
    </dl>
  `;
}

function renderDataInventory(items, config) {
  setText("dataCountBadge", `${items.length} 个文件`);
  const body = $("dataRows");
  body.innerHTML = "";
  if (!items.length) {
    body.innerHTML = `<tr><td colspan="13">暂无本地行情数据</td></tr>`;
    return;
  }
  for (const item of items) {
    const completeness = Number(item.completeness);
    const statusClass = item.status === "可用" ? "positive" : "negative";
    const datasetId = escapeHTML(item.dataset_id || "");
    body.insertAdjacentHTML(
      "beforeend",
      `<tr>
        <td><strong>${escapeHTML(item.name || item.file || "--")}</strong></td>
        <td>${escapeHTML(item.exchange || "--")}</td>
        <td>${escapeHTML(item.pair || "--")}</td>
        <td>${escapeHTML(item.timeframe || config.timeframe || "--")}</td>
        <td>${escapeHTML(item.start || "--")}</td>
        <td>${escapeHTML(item.end || "--")}</td>
        <td>${fmtNumber(item.candles, 0)}</td>
        <td class="${Number.isFinite(completeness) && completeness >= 0.98 ? "positive" : "negative"}">${fmtRatioPercent(item.completeness)}</td>
        <td>${escapeHTML(item.gap_count ?? "--")} / ${escapeHTML(item.missing_candles ?? "--")}</td>
        <td class="${statusClass}">${escapeHTML(item.status || "--")}</td>
        <td>${fmtBytes(item.size)}</td>
        <td>${escapeHTML(item.modified || "--")}</td>
        <td>
          <div class="data-row-actions">
            <button class="mini-button" type="button" data-data-action="detail" data-dataset-id="${datasetId}">详情</button>
            <button class="mini-button" type="button" data-data-action="repair" data-dataset-id="${datasetId}">修复</button>
            <button class="mini-button" type="button" data-data-action="rename" data-dataset-id="${datasetId}" data-current-name="${escapeHTML(item.name || "")}">重命名</button>
            <button class="mini-button danger" type="button" data-data-action="delete" data-dataset-id="${datasetId}">删除</button>
          </div>
        </td>
      </tr>`,
    );
  }
}

async function loadDatasetQualityDetail(datasetId) {
  state.selectedQualityDatasetId = datasetId;
  const panel = $("dataQualityPanel");
  const box = $("dataQualityDetail");
  const badge = $("dataQualityBadge");
  if (panel) panel.classList.remove("hidden");
  if (box) box.innerHTML = "正在读取数据质量详情...";
  if (badge) {
    badge.textContent = "加载中";
    badge.className = "badge warn";
  }
  try {
    const detail = await getJSON(`/api/data/quality-detail?dataset_id=${encodeURIComponent(datasetId)}`);
    state.qualityDetail = detail;
    renderDatasetQualityDetail(detail);
  } catch (error) {
    if (box) box.innerHTML = escapeHTML(error.message);
    if (badge) {
      badge.textContent = "读取失败";
      badge.className = "badge danger";
    }
  }
}

function renderCandleRows(candles) {
  if (!candles || !candles.length) return `<tr><td colspan="6">暂无数据</td></tr>`;
  return candles
    .map(
      (c) => `<tr>
        <td>${escapeHTML(c.date || "--")}</td>
        <td>${detailNumber(c.open)}</td>
        <td>${detailNumber(c.high)}</td>
        <td>${detailNumber(c.low)}</td>
        <td>${detailNumber(c.close)}</td>
        <td>${detailNumber(c.volume, 2)}</td>
      </tr>`,
    )
    .join("");
}

function renderDatasetQualityDetail(detail) {
  const box = $("dataQualityDetail");
  const badge = $("dataQualityBadge");
  if (!box) return;
  const dataset = detail.dataset || {};
  if (badge) {
    badge.textContent = dataset.name || "详情";
    badge.className = "badge safe";
  }
  if (detail.parse_error) {
    box.innerHTML = `<div class="backtest-detail-empty">${escapeHTML(detail.parse_error)}</div>`;
    return;
  }
  const suitable = detail.suitable_for_backtest;
  const suitableBadge = suitable === true
    ? `<span class="badge safe">适合回测</span>`
    : suitable === false
      ? `<span class="badge warn">需注意</span>`
      : `<span class="badge neutral">暂无数据</span>`;
  const reasons = (detail.suitability_reasons || []).length
    ? `<ul class="quality-reason-list">${detail.suitability_reasons.map((r) => `<li>${escapeHTML(r)}</li>`).join("")}</ul>`
    : `<p class="panel-note">暂无数据</p>`;
  const gapRows = (detail.gaps || []).length
    ? detail.gaps.map((g) => `<tr><td>${escapeHTML(g.from || "--")}</td><td>${escapeHTML(g.to || "--")}</td><td>${escapeHTML(g.missing_candles ?? "--")}</td></tr>`).join("")
    : `<tr><td colspan="3">暂无数据</td></tr>`;
  const priceAnomalyRows = (detail.price_anomalies || []).length
    ? detail.price_anomalies.map((a) => `<tr><td>${escapeHTML(a.date || "--")}</td><td>${detailNumber(a.open)}</td><td>${detailNumber(a.high)}</td><td>${detailNumber(a.low)}</td><td>${detailNumber(a.close)}</td><td>${escapeHTML(a.reason || "--")}</td></tr>`).join("")
    : `<tr><td colspan="6">暂无数据</td></tr>`;
  const volumeAnomalyRows = (detail.volume_anomalies || []).length
    ? detail.volume_anomalies.map((a) => `<tr><td>${escapeHTML(a.date || "--")}</td><td>${detailNumber(a.volume, 2)}</td><td>${escapeHTML(a.reason || "--")}</td></tr>`).join("")
    : `<tr><td colspan="3">暂无数据</td></tr>`;

  box.className = "backtest-detail";
  box.innerHTML = `
    <section class="backtest-detail-hero">
      <div>
        <p class="eyebrow">数据集</p>
        <h4>${escapeHTML(dataset.name || "--")}</h4>
        <span>${escapeHTML(dataset.pair || "--")} · ${escapeHTML(dataset.timeframe || "--")} · ${escapeHTML(dataset.start || "--")} 至 ${escapeHTML(dataset.end || "--")}</span>
      </div>
      <div class="detail-source">${suitableBadge}</div>
    </section>
    <section class="detail-metrics">
      ${backtestMetricCard("K线数", dataset.candles ?? "暂无数据")}
      ${backtestMetricCard("完整度", dataset.completeness != null ? fmtRatioPercent(dataset.completeness) : "暂无数据")}
      ${backtestMetricCard("缺口数", detail.gap_total ?? "暂无数据")}
      ${backtestMetricCard("价格异常", detail.price_anomaly_total ?? "暂无数据")}
      ${backtestMetricCard("成交量异常", detail.volume_anomaly_total ?? "暂无数据")}
    </section>
    <section class="detail-table-card">
      <h4>是否适合回测</h4>
      ${reasons}
    </section>
    <section class="detail-grid-two">
      <div class="detail-table-card">
        <h4>首部K线</h4>
        <div class="table-wrap"><table><thead><tr><th>时间</th><th>开</th><th>高</th><th>低</th><th>收</th><th>量</th></tr></thead><tbody>${renderCandleRows(detail.first_candles)}</tbody></table></div>
      </div>
      <div class="detail-table-card">
        <h4>尾部K线</h4>
        <div class="table-wrap"><table><thead><tr><th>时间</th><th>开</th><th>高</th><th>低</th><th>收</th><th>量</th></tr></thead><tbody>${renderCandleRows(detail.last_candles)}</tbody></table></div>
      </div>
    </section>
    <section class="detail-table-card">
      <h4>缺口列表${detail.gap_total > (detail.gaps || []).length ? `（仅显示前 ${(detail.gaps || []).length} 条，共 ${detail.gap_total} 条）` : ""}</h4>
      <div class="table-wrap"><table><thead><tr><th>缺口起点</th><th>缺口终点</th><th>缺失K线数</th></tr></thead><tbody>${gapRows}</tbody></table></div>
    </section>
    <section class="detail-grid-two">
      <div class="detail-table-card">
        <h4>异常价格${detail.price_anomaly_total > (detail.price_anomalies || []).length ? `（仅显示前 ${(detail.price_anomalies || []).length} 条）` : ""}</h4>
        <div class="table-wrap"><table><thead><tr><th>时间</th><th>开</th><th>高</th><th>低</th><th>收</th><th>原因</th></tr></thead><tbody>${priceAnomalyRows}</tbody></table></div>
      </div>
      <div class="detail-table-card">
        <h4>异常成交量${detail.volume_anomaly_total > (detail.volume_anomalies || []).length ? `（仅显示前 ${(detail.volume_anomalies || []).length} 条）` : ""}</h4>
        <div class="table-wrap"><table><thead><tr><th>时间</th><th>量</th><th>原因</th></tr></thead><tbody>${volumeAnomalyRows}</tbody></table></div>
      </div>
    </section>
  `;
}

function closeDatasetQualityDetail() {
  state.selectedQualityDatasetId = null;
  state.qualityDetail = null;
  const panel = $("dataQualityPanel");
  if (panel) panel.classList.add("hidden");
}

function setDataActionLog(message, visible = true) {
  const node = $("dataActionLog");
  if (!node) return;
  node.textContent = message || "";
  node.classList.toggle("hidden", !visible);
}

function selectedDataTimeframes() {
  return Array.from(document.querySelectorAll('input[name="dataTimeframe"]:checked')).map((node) => node.value);
}

function fillDataDownloadDefaults(force = false) {
  const pairsInput = $("dataDownloadPairs");
  if (pairsInput && (force || !pairsInput.value.trim())) {
    pairsInput.value = (state.watchlist.length ? state.watchlist : ["BTC/USDT", "ETH/USDT"]).join(", ");
  }
  const startInput = $("dataDownloadStart");
  const endInput = $("dataDownloadEnd");
  if (startInput && (force || !startInput.value)) startInput.value = "2025-01-01";
  if (endInput && (force || !endInput.value)) endInput.value = new Date().toISOString().slice(0, 10);
}

async function downloadDataFromForm(event) {
  event.preventDefault();
  const pairs = $("dataDownloadPairs")?.value || "";
  const timeframes = selectedDataTimeframes();
  const start = $("dataDownloadStart")?.value || "";
  const end = $("dataDownloadEnd")?.value || "";
  if (!pairs.trim() || !timeframes.length || !start || !end) {
    toast("请填写交易对、周期和起止时间");
    return;
  }
  const button = $("downloadDataBtn");
  if (button) button.disabled = true;
  setDataActionLog("正在调用 Freqtrade 下载/更新历史数据，请稍等...");
  try {
    const result = await postJSON("/api/data/download", {
      pairs,
      timeframes,
      start,
      end,
      add_to_watchlist: true,
    });
    state.dataInventory = result.items || [];
    state.watchlist = result.watchlist || state.watchlist;
    renderDataInventory(state.dataInventory, state.snapshot?.local_config || {});
    fillBacktestDatasetSelect(state.dataInventory);
    renderWatchlist(state.watchlist);
    setDataActionLog(result.download?.output || "历史数据下载/更新完成。");
    toast("历史数据已下载/更新");
  } catch (error) {
    setDataActionLog(error.message);
    toast(error.message);
  } finally {
    if (button) button.disabled = false;
  }
}

async function repairDataset(datasetId) {
  setDataActionLog("正在修复该数据集的缺口/缺失区间...");
  try {
    const result = await postJSON("/api/data/repair", { dataset_id: datasetId });
    state.dataInventory = result.items || [];
    renderDataInventory(state.dataInventory, state.snapshot?.local_config || {});
    fillBacktestDatasetSelect(state.dataInventory);
    setDataActionLog(result.download?.output || "数据缺口修复完成。");
    toast("数据修复完成");
  } catch (error) {
    setDataActionLog(error.message);
    toast(error.message);
  }
}

async function renameDataset(datasetId, currentName) {
  const name = window.prompt("请输入新的数据名称", currentName || "");
  if (name === null) return;
  if (!name.trim()) {
    toast("数据名称不能为空");
    return;
  }
  try {
    const result = await postJSON("/api/data/rename", { dataset_id: datasetId, name: name.trim() });
    state.dataInventory = result.items || [];
    renderDataInventory(state.dataInventory, state.snapshot?.local_config || {});
    fillBacktestDatasetSelect(state.dataInventory);
    toast("数据名称已更新");
  } catch (error) {
    toast(error.message);
  }
}

async function deleteDataset(datasetId) {
  if (!window.confirm("确定删除这个本地数据文件吗？删除后需要重新下载才能用于回测。")) return;
  try {
    const result = await postJSON("/api/data/delete", { dataset_id: datasetId });
    state.dataInventory = result.items || [];
    renderDataInventory(state.dataInventory, state.snapshot?.local_config || {});
    fillBacktestDatasetSelect(state.dataInventory);
    toast("本地数据已删除");
  } catch (error) {
    toast(error.message);
  }
}

function renderWatchlist(pairs) {
  setText("watchlistBadge", `${pairs.length} 个自选`);
  setText("selectedPair", state.selectedPair || "--");
  const box = $("watchlistPills");
  if (!box) return;
  box.innerHTML = "";
  if (!pairs.length) {
    box.innerHTML = `<div class="empty-card">暂无自选交易对</div>`;
    return;
  }
  for (const pair of pairs) {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = `pair-pill ${pair === state.selectedPair ? "active" : ""}`;
    pill.innerHTML = `<span>${escapeHTML(pair)}</span><small>×</small>`;
    pill.addEventListener("click", (event) => {
      if (event.target.tagName === "SMALL") {
        removeWatchPair(pair);
        return;
      }
      selectWatchPair(pair);
    });
    box.appendChild(pill);
  }
}

async function selectWatchPair(pair) {
  state.selectedPair = pair;
  renderWatchlist(state.watchlist);
  await loadMarketData();
}

async function addWatchPair(pair) {
  const result = await postJSON("/api/watchlist", { action: "add", pair });
  state.watchlist = result.pairs || [];
  state.selectedPair = result.selected || state.watchlist[0] || null;
  renderWatchlist(state.watchlist);
  await loadMarketData();
  toast("已加入自选");
}

async function removeWatchPair(pair) {
  const result = await postJSON("/api/watchlist", { action: "remove", pair });
  state.watchlist = result.pairs || [];
  if (state.selectedPair === pair) {
    state.selectedPair = state.watchlist[0] || null;
  }
  renderWatchlist(state.watchlist);
  await loadMarketData();
  toast("已移出自选");
}

async function loadMarketData() {
  const pair = state.selectedPair;
  setText("selectedPair", pair || "--");
  if (!pair) {
    clearTicker();
    drawKline([]);
    return;
  }
  const interval = $("marketInterval")?.value || "1h";
  const windowValue = $("marketWindow")?.value || "1d";
  const limit = candleLimitForWindow(interval, windowValue);
  try {
    const symbol = encodeURIComponent(pair);
    const [ticker, klines] = await Promise.all([
      getJSON(`/api/market/ticker?symbol=${symbol}`),
      getJSON(`/api/market/klines?symbol=${symbol}&interval=${encodeURIComponent(interval)}&limit=${limit}`),
    ]);
    renderTicker(ticker);
    state.candles = klines.candles || [];
    drawKline(state.candles);
  } catch (error) {
    state.candles = [];
    clearTicker();
    drawKline([]);
    toast(error.message);
  }
}

async function loadSimulationMarketData() {
  const active = state.simulation?.active;
  const pair = active?.pair || $("simulationPairSelect")?.value || state.selectedSimulationPair;
  state.selectedSimulationPair = pair;
  setText("simulationChartPair", pair || "--");
  if (!pair) {
    clearSimulationTicker();
    drawKlineOnCanvas("simulationKlineCanvas", "simulationChartEmpty", [], []);
    return;
  }
  const interval = $("simulationInterval")?.value || state.snapshot?.local_config?.timeframe || "1h";
  const windowValue = $("simulationWindow")?.value || "1d";
  const limit = candleLimitForWindow(interval, windowValue);
  try {
    const symbol = encodeURIComponent(pair);
    const [ticker, klines] = await Promise.all([
      getJSON(`/api/market/ticker?symbol=${symbol}`),
      getJSON(`/api/market/klines?symbol=${symbol}&interval=${encodeURIComponent(interval)}&limit=${limit}`),
    ]);
    renderSimulationTicker(ticker);
    state.simulationCandles = klines.candles || [];
    const markers = buildTradeMarkers(pair, state.snapshot || {});
    drawKlineOnCanvas("simulationKlineCanvas", "simulationChartEmpty", state.simulationCandles, markers);
  } catch (error) {
    state.simulationCandles = [];
    clearSimulationTicker();
    drawKlineOnCanvas("simulationKlineCanvas", "simulationChartEmpty", [], []);
    toast(error.message);
  }
}

async function loadLiveMarketData() {
  const config = state.snapshot?.local_config || {};
  const liveEnabled = config.dry_run === false;
  const pair = $("livePairSelect")?.value || state.selectedLivePair || config.pairs?.[0] || state.watchlist[0];
  state.selectedLivePair = pair;
  setText("liveChartPair", pair || "--");
  if (!pair) {
    clearLiveTicker();
    drawKlineOnCanvas("liveKlineCanvas", "liveChartEmpty", [], []);
    return;
  }
  const interval = $("liveInterval")?.value || config.timeframe || "1h";
  const windowValue = $("liveWindow")?.value || "1d";
  const limit = candleLimitForWindow(interval, windowValue);
  try {
    const symbol = encodeURIComponent(pair);
    const [ticker, klines] = await Promise.all([
      getJSON(`/api/market/ticker?symbol=${symbol}`),
      getJSON(`/api/market/klines?symbol=${symbol}&interval=${encodeURIComponent(interval)}&limit=${limit}`),
    ]);
    renderLiveTicker(ticker);
    state.liveCandles = klines.candles || [];
    const markers = liveEnabled ? buildTradeMarkers(pair, state.snapshot || {}) : [];
    drawKlineOnCanvas("liveKlineCanvas", "liveChartEmpty", state.liveCandles, markers);
  } catch (error) {
    state.liveCandles = [];
    clearLiveTicker();
    drawKlineOnCanvas("liveKlineCanvas", "liveChartEmpty", [], []);
    toast(error.message);
  }
}

function normalizeTradeHistory(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  for (const key of ["trades", "data", "items"]) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function tradeTimestamp(trade, keys) {
  for (const key of keys) {
    const value = trade[key];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "number") return value < 1000000000000 ? value * 1000 : value;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function buildTradeMarkers(pair, snapshot, session = null) {
  const markers = [];
  const bounds = session?.started_at ? simulationSessionBounds(session, { startGraceMs: 0, endGraceMs: 0 }) : null;
  const inSession = (time) => !bounds || isWithinSimulationSession(time, bounds);
  const openTrades = Array.isArray(snapshot.status) ? snapshot.status : [];
  for (const trade of openTrades.filter((item) => item.pair === pair)) {
    const time = tradeTimestamp(trade, ["open_timestamp", "open_date", "open_date_utc"]);
    const price = Number(trade.open_rate);
    if (time && inSession(time) && Number.isFinite(price)) {
      markers.push({ side: "B", time, price, label: "B" });
    }
  }

  for (const trade of normalizeTradeHistory(snapshot.trades_history).filter((item) => item.pair === pair).slice(0, 80)) {
    const openTime = tradeTimestamp(trade, ["open_timestamp", "open_date", "open_date_utc"]);
    const openPrice = Number(trade.open_rate);
    if (openTime && inSession(openTime) && Number.isFinite(openPrice)) {
      markers.push({ side: "B", time: openTime, price: openPrice, label: "B" });
    }
    const closeTime = tradeTimestamp(trade, ["close_timestamp", "close_date", "close_date_utc"]);
    const closePrice = Number(trade.close_rate);
    if (closeTime && inSession(closeTime) && Number.isFinite(closePrice)) {
      markers.push({ side: "S", time: closeTime, price: closePrice, label: "S" });
    }
  }
  return markers;
}

function clearTicker() {
  setText("tickerLast", "--");
  setText("tickerChange", "--");
  setText("tickerHigh", "--");
  setText("tickerLow", "--");
}

function clearSimulationTicker() {
  setText("simulationTickerLast", "--");
  const change = $("simulationTickerChange");
  if (change) {
    change.textContent = "--";
    change.className = "";
  }
}

function clearLiveTicker() {
  setText("liveTickerLast", "--");
  const change = $("liveTickerChange");
  if (change) {
    change.textContent = "--";
    change.className = "";
  }
}

function renderTicker(ticker) {
  setText("tickerLast", fmtNumber(ticker.last, 4));
  setText("tickerHigh", fmtNumber(ticker.high, 4));
  setText("tickerLow", fmtNumber(ticker.low, 4));
  const change = $("tickerChange");
  change.textContent = `${fmtNumber(ticker.change_pct, 2)}%`;
  change.className = classifyNumber(ticker.change_pct);
}

function renderSimulationTicker(ticker) {
  setText("simulationTickerLast", fmtNumber(ticker.last, 4));
  const change = $("simulationTickerChange");
  if (change) {
    change.textContent = `24h ${fmtNumber(ticker.change_pct, 2)}%`;
    change.className = classifyNumber(ticker.change_pct);
  }
}

function renderLiveTicker(ticker) {
  setText("liveTickerLast", fmtNumber(ticker.last, 4));
  const change = $("liveTickerChange");
  if (change) {
    change.textContent = `24h ${fmtNumber(ticker.change_pct, 2)}%`;
    change.className = classifyNumber(ticker.change_pct);
  }
}

function drawKline(candles) {
  drawKlineOnCanvas("klineCanvas", "chartEmpty", candles, []);
}

function drawKlineOnCanvas(canvasId, emptyId, candles, markers = []) {
  const canvas = $(canvasId);
  const empty = $(emptyId);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(320, Math.floor(rect.width || canvas.width));
  const height = Math.max(240, Math.floor(rect.height || canvas.height));
  canvas.width = Math.floor(width * ratio);
  canvas.height = Math.floor(height * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#f8faf7";
  ctx.fillRect(0, 0, width, height);

  if (!candles.length) {
    if (empty) empty.classList.remove("hidden");
    return;
  }
  if (empty) empty.classList.add("hidden");

  const pad = { left: 58, right: 18, top: 18, bottom: 34 };
  const chartW = width - pad.left - pad.right;
  const chartH = height - pad.top - pad.bottom;
  const candleTimes = candles.map((item) => new Date(item.open_time).getTime()).filter(Number.isFinite);
  const firstCandleTime = candleTimes[0];
  const lastCandleTime = candleTimes[candleTimes.length - 1];
  const estimatedInterval =
    candleTimes.length > 1 ? Math.max(1, Math.round((lastCandleTime - firstCandleTime) / (candleTimes.length - 1))) : 0;
  const visibleMarkerEnd = lastCandleTime + estimatedInterval;
  const visibleMarkers = markers.filter((marker) => {
    const markerTime = Number(marker.time);
    return Number.isFinite(markerTime) && markerTime >= firstCandleTime && markerTime <= visibleMarkerEnd;
  });
  const highs = candles.map((item) => item.high);
  const lows = candles.map((item) => item.low);
  for (const marker of visibleMarkers) {
    const price = Number(marker.price);
    if (Number.isFinite(price)) {
      highs.push(price);
      lows.push(price);
    }
  }
  const max = Math.max(...highs);
  const min = Math.min(...lows);
  const range = max - min || 1;
  const y = (price) => pad.top + ((max - price) / range) * chartH;
  const step = chartW / candles.length;
  const candleW = Math.max(2, Math.min(10, step * 0.62));

  ctx.strokeStyle = "#d9ded8";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#667085";
  ctx.font = "11px Microsoft YaHei, sans-serif";
  for (let i = 0; i <= 4; i += 1) {
    const yy = pad.top + (chartH / 4) * i;
    const price = max - (range / 4) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, yy);
    ctx.lineTo(width - pad.right, yy);
    ctx.stroke();
    ctx.fillText(fmtNumber(price, 2), 8, yy + 4);
  }

  candles.forEach((item, index) => {
    const x = pad.left + index * step + step / 2;
    const openY = y(item.open);
    const closeY = y(item.close);
    const highY = y(item.high);
    const lowY = y(item.low);
    const up = item.close >= item.open;
    ctx.strokeStyle = up ? "#248255" : "#b42318";
    ctx.fillStyle = up ? "#248255" : "#b42318";
    ctx.beginPath();
    ctx.moveTo(x, highY);
    ctx.lineTo(x, lowY);
    ctx.stroke();
    const top = Math.min(openY, closeY);
    const bodyH = Math.max(1, Math.abs(openY - closeY));
    ctx.fillRect(x - candleW / 2, top, candleW, bodyH);
  });

  if (visibleMarkers.length) {
    ctx.font = "bold 11px Microsoft YaHei, sans-serif";
    for (const marker of visibleMarkers) {
      const markerTime = Number(marker.time);
      const price = Number(marker.price);
      if (!Number.isFinite(markerTime) || !Number.isFinite(price)) continue;
      let index = 0;
      let distance = Number.POSITIVE_INFINITY;
      candleTimes.forEach((time, idx) => {
        const nextDistance = Math.abs(time - markerTime);
        if (nextDistance < distance) {
          distance = nextDistance;
          index = idx;
        }
      });
      const x = pad.left + index * step + step / 2;
      const yy = y(price);
      const isBuy = marker.side === "B";
      ctx.fillStyle = isBuy ? "#0f7b4a" : "#b42318";
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, yy, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(marker.label || marker.side, x, yy + 0.5);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
    }
  }

  const first = new Date(candles[0].open_time).toLocaleDateString("zh-CN");
  const last = new Date(candles[candles.length - 1].open_time).toLocaleDateString("zh-CN");
  ctx.fillStyle = "#667085";
  ctx.fillText(first, pad.left, height - 12);
  ctx.fillText(last, width - pad.right - 78, height - 12);
}

function renderBacktests(items) {
  renderBacktestCards("backtestList", items, true, true);
  renderReportBacktestList(items);
  if (!state.backtestDetail) {
    renderBacktestDetail(null);
  }
}

function renderReportBacktestList(items) {
  const box = $("reportArchiveList");
  if (!box) return;
  box.innerHTML = "";
  const exportable = items.filter((item) => item.id && (item.source || item.file));
  if (!exportable.length) {
    box.innerHTML = `<div class="report-card">暂无回测报告</div>`;
    return;
  }
  for (const item of exportable) {
    const m = item.metrics || {};
    const req = item.requested || {};
    const subtitle = req.pair ? `${req.pair} · ${req.timeframe || "--"} · ${req.start || "--"} 至 ${req.end || "--"}` : (item.modified || item.created_at || "");
    box.insertAdjacentHTML(
      "beforeend",
      `<div class="report-card">
        <div class="report-card-head">
          <h4>${escapeHTML(m.strategy || item.name)}</h4>
          <div class="report-card-actions">
            <button class="button secondary tiny" type="button" data-export-kind="backtest" data-export-id="${escapeHTML(item.id)}">导出 Markdown</button>
          </div>
        </div>
        <p class="report-subtitle">${escapeHTML(subtitle)}</p>
        <div class="report-metrics two">
          <div><span>交易数</span><strong>${escapeHTML(m.trades ?? "--")}</strong></div>
          <div><span>收益</span><strong>${escapeHTML(m.profit ?? "--")}</strong></div>
          <div><span>回撤</span><strong>${escapeHTML(m.drawdown ?? "--")}</strong></div>
          <div><span>胜率</span><strong>${escapeHTML(m.win_rate ?? "--")}</strong></div>
        </div>
      </div>`,
    );
  }
}

function renderReportSimulationList(items) {
  const box = $("reportSimulationList");
  if (!box) return;
  box.innerHTML = "";
  if (!items.length) {
    box.innerHTML = `<div class="report-card">暂无模拟交易报告</div>`;
    return;
  }
  for (const item of items) {
    const metrics = item.metrics || {};
    const subtitle = `${item.pair || "--"} · ${item.started_at || "--"} 至 ${item.ended_at || "--"}`;
    box.insertAdjacentHTML(
      "beforeend",
      `<div class="report-card">
        <div class="report-card-head">
          <h4>${escapeHTML(item.strategy || "--")}</h4>
          <div class="report-card-actions">
            <button class="button secondary tiny" type="button" data-export-kind="simulation" data-export-id="${escapeHTML(item.id)}">导出 Markdown</button>
          </div>
        </div>
        <p class="report-subtitle">${escapeHTML(subtitle)}</p>
        <div class="report-metrics two">
          <div><span>交易数</span><strong>${escapeHTML(metrics.trade_count ?? 0)}</strong></div>
          <div><span>收益</span><strong>${fmtNumber(metrics.profit_abs, 4)} USDT</strong></div>
        </div>
      </div>`,
    );
  }
}

function renderReportExperimentList(items) {
  const box = $("reportExperimentList");
  if (!box) return;
  box.innerHTML = "";
  if (!items.length) {
    box.innerHTML = `<div class="report-card">暂无实验记录</div>`;
    return;
  }
  for (const item of items) {
    const subtitle = `${item.strategy || "--"} · ${item.pair || "--"} · ${item.start || "--"} 至 ${item.end || "--"}`;
    box.insertAdjacentHTML(
      "beforeend",
      `<div class="report-card">
        <div class="report-card-head">
          <h4>${escapeHTML(item.name || "--")}</h4>
          <div class="report-card-actions">
            <button class="button secondary tiny" type="button" data-export-kind="experiment" data-export-id="${escapeHTML(item.id)}">导出 Markdown</button>
          </div>
        </div>
        <p class="report-subtitle">${escapeHTML(subtitle)}</p>
        <p class="report-subtitle">${escapeHTML(item.conclusion || "暂无结论")}</p>
      </div>`,
    );
  }
}

function renderReportTabs() {
  renderReportBacktestList(state.backtests);
  renderReportSimulationList(state.simulation?.history || []);
  renderReportExperimentList(state.experiments);
}

function switchReportTab(tab) {
  state.reportTab = tab;
  document.querySelectorAll(".report-tab").forEach((node) => {
    node.classList.toggle("active", node.dataset.reportTab === tab);
  });
  document.querySelectorAll(".report-tab-panel").forEach((node) => {
    node.classList.toggle("active", node.id === `reportTab-${tab}`);
  });
}

async function exportReport(kind, id) {
  if (!id) return;
  const endpoints = {
    backtest: "/api/reports/export/backtest",
    simulation: "/api/reports/export/simulation",
    experiment: "/api/reports/export/experiment",
  };
  const endpoint = endpoints[kind];
  if (!endpoint) return;
  try {
    const result = await postJSON(endpoint, { id });
    const hint = $("reportExportHint");
    if (hint) {
      hint.textContent = `已导出：${result.file}`;
      hint.classList.remove("hidden");
    }
    toast(`已导出 ${result.file}`);
  } catch (error) {
    toast(error.message);
  }
}

function hyperoptParamSummary(params) {
  if (!params || typeof params !== "object") return "--";
  const chunks = [];
  if (params.stoploss !== undefined) chunks.push(`止损 ${params.stoploss}`);
  if (params.minimal_roi) {
    const roi = Object.entries(params.minimal_roi)
      .slice(0, 4)
      .map(([key, value]) => `${key}:${value}`)
      .join(" / ");
    chunks.push(`ROI ${roi}`);
  }
  if (params.trailing_stop !== undefined) chunks.push(`移动止盈 ${params.trailing_stop ? "开" : "关"}`);
  return chunks.join(" · ") || "--";
}

function strategyVersionName(value) {
  if (!value) return "默认参数";
  if (typeof value === "string") {
    const found = state.strategyVersions.find((item) => item.id === value);
    return found?.name || value || "默认参数";
  }
  return value.name || value.id || "默认参数";
}

function strategyVersionId(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value.id || "";
}

function strategyVersionBadge(value) {
  const name = strategyVersionName(value);
  return name === "默认参数" ? name : `版本：${name}`;
}

function renderHyperopts(items) {
  setText("hyperoptCountBadge", `${items.length} 条`);
  const box = $("hyperoptList");
  if (!box) return;
  box.innerHTML = "";
  if (!items.length) {
    box.innerHTML = `<div class="report-card">暂无参数优化记录</div>`;
    return;
  }
  for (const item of items) {
    const req = item.requested || {};
    const metrics = item.metrics || {};
    const profitPct = Number(metrics.profit_pct);
    const subtitle = `${req.pair || "--"} · ${req.timeframe || "--"} · ${req.start || "--"} 至 ${req.end || "--"} · ${req.epochs || "--"} 轮`;
    const saveButton = item.ok !== false && item.params && item.id
      ? `<button class="button secondary tiny" type="button" data-hyperopt-version-id="${escapeHTML(item.id)}">保存为版本</button>`
      : "";
    const deleteButton = item.id
      ? `<button class="record-delete-button" type="button" data-history-type="hyperopt" data-record-id="${escapeHTML(item.id)}" title="删除这条参数优化记录">删除</button>`
      : "";
    box.insertAdjacentHTML(
      "beforeend",
      `<div class="report-card ${item.ok === false ? "danger-card" : ""}">
        <div class="report-card-head">
          <h4>${escapeHTML(req.strategy || "--")}</h4>
          <div class="report-card-actions">${saveButton}${deleteButton}</div>
        </div>
        <p class="report-subtitle">${escapeHTML(subtitle)}</p>
        <div class="report-metrics two">
          <div><span>交易数</span><strong>${escapeHTML(metrics.trades ?? "--")}</strong></div>
          <div><span>收益</span><strong class="${classifyNumber(profitPct)}">${Number.isFinite(profitPct) ? `${fmtNumber(profitPct, 2)}%` : "--"}</strong></div>
          <div><span>目标函数</span><strong>${escapeHTML(metrics.objective ?? "--")}</strong></div>
          <div><span>空间</span><strong>${escapeHTML((req.spaces || []).join(", ") || "--")}</strong></div>
          <div class="wide"><span>最优参数</span><strong>${escapeHTML(hyperoptParamSummary(item.params))}</strong></div>
          <div class="wide"><span>结果文件</span><strong>${escapeHTML(item.result_path || "--")}</strong></div>
        </div>
      </div>`,
    );
  }
}

function renderBacktestCards(id, items, compact, allowDelete = false) {
  const box = $(id);
  if (!box) return;
  box.innerHTML = "";
  if (!items.length) {
    box.innerHTML = `<div class="report-card">暂无回测摘要</div>`;
    return;
  }
  for (const item of items) {
    const m = item.metrics || {};
    const req = item.requested || {};
    const version = req.strategy_version;
    const subtitle = req.pair ? `${req.pair} · ${req.timeframe || "--"} · ${req.start || "--"} 至 ${req.end || "--"}` : (item.modified || item.created_at || "");
    const detailButton = allowDelete && item.id && (item.source || item.file)
      ? `<button class="record-detail-button" type="button" data-backtest-id="${escapeHTML(item.id)}">详情</button>`
      : "";
    const deleteButton = allowDelete && item.id
      ? `<button class="record-delete-button" type="button" data-history-type="backtest" data-record-id="${escapeHTML(item.id)}" title="删除这条回测记录">删除</button>`
      : "";
    const activeClass = item.id && item.id === state.selectedBacktestId ? " active" : "";
    box.insertAdjacentHTML(
      "beforeend",
      `<div class="report-card${activeClass}">
        <div class="report-card-head">
          <h4>${escapeHTML(m.strategy || item.name)}</h4>
          <div class="report-card-actions">${detailButton}${deleteButton}</div>
        </div>
        <p class="report-subtitle">${escapeHTML(subtitle)}</p>
        <p class="report-subtitle">策略版本：${escapeHTML(strategyVersionName(version))}</p>
        <div class="report-metrics ${compact ? "two" : ""}">
          <div><span>交易数</span><strong>${escapeHTML(m.trades ?? "--")}</strong></div>
          <div><span>收益</span><strong>${escapeHTML(m.profit ?? "--")}</strong></div>
          <div><span>回撤</span><strong>${escapeHTML(m.drawdown ?? "--")}</strong></div>
          <div><span>胜率</span><strong>${escapeHTML(m.win_rate ?? "--")}</strong></div>
          <div><span>Profit Factor</span><strong>${escapeHTML(m.profit_factor ?? "--")}</strong></div>
          <div><span>文件</span><strong>${escapeHTML(item.file)}</strong></div>
        </div>
      </div>`,
    );
  }
}

function detailPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "--";
  return `${(n * 100).toFixed(2)}%`;
}

function detailNumber(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "--";
  return fmtNumber(n, digits);
}

function backtestMetricCard(label, value, className = "") {
  return `<div><span>${escapeHTML(label)}</span><strong class="${className}">${escapeHTML(value)}</strong></div>`;
}

async function loadBacktestDetail(id, silent = false) {
  if (!id) return;
  state.selectedBacktestId = id;
  if (!silent) {
    renderBacktests(state.backtests);
    renderBacktestDetail({ loading: true, id });
  }
  try {
    const detail = await getJSON(`/api/backtests/detail?id=${encodeURIComponent(id)}`);
    state.backtestDetail = detail;
    renderBacktestDetail(detail);
    renderBacktests(state.backtests);
  } catch (error) {
    renderBacktestDetail({ error: error.message });
    toast(error.message);
  }
}

function renderBacktestDetail(detail) {
  const box = $("backtestDetail");
  if (!box) return;
  const badge = $("backtestDetailBadge");
  if (!detail) {
    if (badge) {
      badge.textContent = "未选择";
      badge.className = "badge neutral";
    }
    box.className = "backtest-detail-empty";
    box.innerHTML = "请选择一条历史回测记录";
    return;
  }
  if (detail.loading) {
    if (badge) {
      badge.textContent = "加载中";
      badge.className = "badge warn";
    }
    box.className = "backtest-detail-empty";
    box.innerHTML = "正在读取回测结果...";
    return;
  }
  if (detail.error) {
    if (badge) {
      badge.textContent = "读取失败";
      badge.className = "badge danger";
    }
    box.className = "backtest-detail-empty";
    box.innerHTML = escapeHTML(detail.error);
    return;
  }

  const s = detail.summary || {};
  const currency = "USDT";
  const versionName = strategyVersionName(s.strategy_version);
  if (badge) {
    badge.textContent = s.strategy || "详情";
    badge.className = "badge safe";
  }
  box.className = "backtest-detail";
  const profit = Number(s.profit_total);
  const drawdown = Number(s.max_drawdown);
  const winrate = Number(s.winrate);
  box.innerHTML = `
    <section class="backtest-detail-hero">
      <div>
        <p class="eyebrow">策略</p>
        <h4>${escapeHTML(s.strategy || "--")}</h4>
        <span>${escapeHTML(s.pair || "--")} · ${escapeHTML(s.timeframe || "--")} · ${escapeHTML(versionName)} · ${escapeHTML(s.start || "--")} 至 ${escapeHTML(s.end || "--")}</span>
      </div>
      <div class="detail-source">${escapeHTML(detail.source || "--")}</div>
    </section>
    <section class="detail-metrics">
      ${backtestMetricCard("总收益", detailPercent(s.profit_total), classifyNumber(profit))}
      ${backtestMetricCard("收益金额", `${detailNumber(s.profit_total_abs, 4)} ${currency}`, classifyNumber(s.profit_total_abs))}
      ${backtestMetricCard("最大回撤", detailPercent(s.max_drawdown), classifyNumber(-Math.abs(drawdown || 0)))}
      ${backtestMetricCard("胜率", detailPercent(s.winrate), classifyNumber(winrate - 0.5))}
      ${backtestMetricCard("策略版本", versionName)}
      ${backtestMetricCard("交易数", detailNumber(s.total_trades, 0))}
      ${backtestMetricCard("Profit Factor", detailNumber(s.profit_factor, 4), classifyNumber((Number(s.profit_factor) || 0) - 1))}
      ${backtestMetricCard("Sharpe", detailNumber(s.sharpe, 4), classifyNumber(s.sharpe))}
      ${backtestMetricCard("期初/期末资金", `${detailNumber(s.starting_balance, 2)} → ${detailNumber(s.final_balance, 2)}`)}
    </section>
    <section class="detail-chart-block">
      <div class="panel-head compact-head">
        <h4>累计权益曲线</h4>
        <span>${escapeHTML((detail.equity_curve || []).length)} 点</span>
      </div>
      <canvas id="backtestEquityCanvas" height="260"></canvas>
    </section>
    <section class="detail-grid-two">
      ${renderBacktestStatTable("交易对表现", detail.pair_stats || [])}
      ${renderBacktestStatTable("退出原因", detail.exit_reasons || [])}
    </section>
    ${renderAdvancedMetrics(detail.advanced_metrics || {})}
    <section class="detail-trades">
      <div class="panel-head compact-head">
        <h4>交易明细</h4>
        <span>显示最近 ${escapeHTML((detail.trades || []).length)} / ${escapeHTML(detail.trade_count || 0)} 笔</span>
      </div>
      ${renderBacktestTradesTable(detail.trades || [])}
    </section>
  `;
  drawBacktestEquityCurve(detail.equity_curve || []);
}

function renderAdvancedMetrics(advanced) {
  const drawdown = advanced.max_drawdown_period;
  const monthly = advanced.monthly_returns;
  const distribution = advanced.profit_distribution;
  const bestWorst = advanced.best_worst_trade;
  const monthlyRows = (monthly || [])
    .map((row) => `
      <tr>
        <td>${escapeHTML(row.month)}</td>
        <td>${detailNumber(row.start_equity, 2)}</td>
        <td>${detailNumber(row.end_equity, 2)}</td>
        <td class="${classifyNumber(row.profit_abs)}">${detailNumber(row.profit_abs, 4)}</td>
      </tr>`)
    .join("");
  const distributionRows = (distribution || [])
    .map((row) => `<tr><td>${escapeHTML(row.bucket)}</td><td>${escapeHTML(row.count)}</td></tr>`)
    .join("");
  const bestWorstBlock = bestWorst
    ? `<table>
        <thead><tr><th>类型</th><th>交易对</th><th>开仓</th><th>平仓</th><th>收益率</th><th>收益</th></tr></thead>
        <tbody>
          <tr>
            <td>最好</td><td>${escapeHTML(bestWorst.best.pair || "--")}</td><td>${escapeHTML(bestWorst.best.open_date || "--")}</td>
            <td>${escapeHTML(bestWorst.best.close_date || "--")}</td>
            <td class="${classifyNumber(bestWorst.best.profit_ratio)}">${detailPercent(bestWorst.best.profit_ratio)}</td>
            <td class="${classifyNumber(bestWorst.best.profit_abs)}">${detailNumber(bestWorst.best.profit_abs, 4)}</td>
          </tr>
          <tr>
            <td>最差</td><td>${escapeHTML(bestWorst.worst.pair || "--")}</td><td>${escapeHTML(bestWorst.worst.open_date || "--")}</td>
            <td>${escapeHTML(bestWorst.worst.close_date || "--")}</td>
            <td class="${classifyNumber(bestWorst.worst.profit_ratio)}">${detailPercent(bestWorst.worst.profit_ratio)}</td>
            <td class="${classifyNumber(bestWorst.worst.profit_abs)}">${detailNumber(bestWorst.worst.profit_abs, 4)}</td>
          </tr>
        </tbody>
      </table>`
    : `<p class="panel-note">暂无数据</p>`;
  return `
    <section class="detail-table-card advanced-metrics-block">
      <h4>复盘增强指标</h4>
      <div class="detail-metrics compact-metrics">
        ${backtestMetricCard(
          "最大回撤区间",
          drawdown ? `${drawdown.peak_time} → ${drawdown.trough_time}（${detailPercent(drawdown.depth_pct)}）` : "暂无数据",
        )}
        ${backtestMetricCard("最长连续亏损笔数", advanced.max_consecutive_losses ?? "暂无数据")}
        ${backtestMetricCard("平均持仓时长(分钟)", advanced.avg_holding_minutes ?? "暂无数据")}
      </div>
      <div class="detail-grid-two">
        <div class="detail-table-card">
          <h4>月度收益</h4>
          <div class="table-wrap">
            <table>
              <thead><tr><th>月份</th><th>月初权益</th><th>月末权益</th><th>月收益</th></tr></thead>
              <tbody>${monthlyRows || `<tr><td colspan="4">暂无数据</td></tr>`}</tbody>
            </table>
          </div>
        </div>
        <div class="detail-table-card">
          <h4>收益分布</h4>
          <div class="table-wrap">
            <table>
              <thead><tr><th>收益率区间</th><th>笔数</th></tr></thead>
              <tbody>${distributionRows || `<tr><td colspan="2">暂无数据</td></tr>`}</tbody>
            </table>
          </div>
        </div>
      </div>
      <div class="detail-table-card">
        <h4>最好/最差交易</h4>
        <div class="table-wrap">${bestWorstBlock}</div>
      </div>
    </section>`;
}

function renderBacktestStatTable(title, rows) {
  const body = rows.length
    ? rows.map((row) => `
      <tr>
        <td>${escapeHTML(row.key || "--")}</td>
        <td>${escapeHTML(row.trades ?? "--")}</td>
        <td class="${classifyNumber(row.profit_total)}">${detailPercent(row.profit_total)}</td>
        <td class="${classifyNumber(row.profit_total_abs)}">${detailNumber(row.profit_total_abs, 4)}</td>
        <td>${detailPercent(row.winrate)}</td>
      </tr>`).join("")
    : `<tr><td colspan="5">暂无数据</td></tr>`;
  return `
    <div class="detail-table-card">
      <h4>${escapeHTML(title)}</h4>
      <div class="table-wrap">
        <table>
          <thead><tr><th>项目</th><th>交易数</th><th>收益率</th><th>收益</th><th>胜率</th></tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </div>`;
}

function renderBacktestTradesTable(trades) {
  const rows = trades.length
    ? trades.map((trade) => `
      <tr>
        <td>${escapeHTML(trade.pair || "--")}</td>
        <td>${escapeHTML(trade.open_date || "--")}</td>
        <td>${escapeHTML(trade.close_date || "--")}</td>
        <td>${detailNumber(trade.open_rate, 4)}</td>
        <td>${detailNumber(trade.close_rate, 4)}</td>
        <td class="${classifyNumber(trade.profit_ratio)}">${detailPercent(trade.profit_ratio)}</td>
        <td class="${classifyNumber(trade.profit_abs)}">${detailNumber(trade.profit_abs, 4)}</td>
        <td>${escapeHTML(trade.exit_reason || "--")}</td>
      </tr>`).join("")
    : `<tr><td colspan="8">暂无交易明细</td></tr>`;
  return `
    <div class="table-wrap detail-trade-table">
      <table>
        <thead>
          <tr><th>交易对</th><th>开仓</th><th>平仓</th><th>开仓价</th><th>平仓价</th><th>收益率</th><th>收益</th><th>退出原因</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function drawBacktestEquityCurve(points) {
  const canvas = $("backtestEquityCanvas");
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(520, Math.floor(rect.width || canvas.clientWidth || 800));
  const height = 260;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#f8faf7";
  ctx.fillRect(0, 0, width, height);
  if (!points.length) {
    ctx.fillStyle = "#667085";
    ctx.fillText("暂无曲线数据", 20, 32);
    return;
  }
  const values = points.map((point) => Number(point.equity)).filter(Number.isFinite);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(1e-9, max - min);
  const pad = { left: 54, right: 20, top: 24, bottom: 32 };
  const x = (idx) => pad.left + (idx / Math.max(1, points.length - 1)) * (width - pad.left - pad.right);
  const y = (value) => pad.top + (1 - (value - min) / range) * (height - pad.top - pad.bottom);
  ctx.strokeStyle = "#dde5df";
  ctx.lineWidth = 1;
  ctx.font = "12px ui-monospace, SFMono-Regular, Consolas, monospace";
  ctx.fillStyle = "#667085";
  for (let i = 0; i < 4; i += 1) {
    const yy = pad.top + (i / 3) * (height - pad.top - pad.bottom);
    ctx.beginPath();
    ctx.moveTo(pad.left, yy);
    ctx.lineTo(width - pad.right, yy);
    ctx.stroke();
    const label = min + (1 - i / 3) * range;
    ctx.fillText(label.toFixed(2), 8, yy + 4);
  }
  const positive = Number(points[points.length - 1].equity) >= Number(points[0].equity);
  ctx.strokeStyle = positive ? "#168657" : "#b42318";
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  points.forEach((point, idx) => {
    const xx = x(idx);
    const yy = y(Number(point.equity));
    if (idx === 0) ctx.moveTo(xx, yy);
    else ctx.lineTo(xx, yy);
  });
  ctx.stroke();
  ctx.fillStyle = "#667085";
  ctx.fillText(String(points[0].time || ""), pad.left, height - 10);
  ctx.textAlign = "right";
  ctx.fillText(String(points[points.length - 1].time || ""), width - pad.right, height - 10);
  ctx.textAlign = "left";
}

function renderPerformance(items) {
  const box = $("performanceList");
  box.innerHTML = "";
  if (!items.length) {
    box.innerHTML = `<div class="perf-card"><h4>暂无已完成交易表现</h4></div>`;
    return;
  }
  for (const item of items.slice(0, 8)) {
    const profit = item.profit_ratio ?? item.profit ?? 0;
    box.insertAdjacentHTML(
      "beforeend",
      `<div class="perf-card">
        <h4>${escapeHTML(item.pair || "--")}</h4>
        <div class="report-metrics">
          <div><span>交易数</span><strong>${item.count ?? "--"}</strong></div>
          <div><span>收益</span><strong class="${classifyNumber(profit)}">${fmtPercent(profit)}</strong></div>
          <div><span>平均收益</span><strong>${fmtPercent(item.profit_mean ?? 0)}</strong></div>
        </div>
      </div>`,
    );
  }
}

function renderLogs(logs) {
  const rows = Array.isArray(logs?.logs) ? logs.logs : [];
  setText("logCount", `${logs?.log_count ?? rows.length} 条`);
  if (!rows.length) {
    setText("logsText", "暂无日志");
    return;
  }
  const tail = rows.slice(-120).map((row) => {
    const [time, , source, level, message] = row;
    return `[${time}] ${level} ${source}: ${message}`;
  });
  setText("logsText", tail.join("\n"));
}

function renderErrors(errors) {
  const box = $("errorBox");
  if (!box) return;
  if (!errors.length) {
    box.classList.add("hidden");
    box.textContent = "";
    return;
  }
  box.classList.remove("hidden");
  box.textContent = errors.join("\n");
}

async function control(action) {
  setLoading(true);
  try {
    const result = await getJSON(`/api/control/${action}`, { method: "POST" });
    if (result.blocked) {
      toast(result.message || "安全检查未通过");
    } else {
      const exitCount = result.force_exit?.exited?.length || 0;
      const cleanCount = result.force_exit?.cleaned_orders?.length || 0;
      if (action === "globalstop") {
        toast(`已全局停止，平仓 ${exitCount} 笔，清理 ${cleanCount} 笔未成交订单`);
      } else {
        toast("命令已发送");
      }
    }
    await refresh();
  } catch (error) {
    toast(error.message);
  } finally {
    setLoading(false);
  }
}

async function strategyAction(action, strategy) {
  if (!strategy) return;
  try {
    const result = await postJSON("/api/strategies/action", { action, strategy });
    state.strategyState = result.state || {};
    const strategies = await getJSON("/api/strategies");
    state.strategies = strategies.items || [];
    state.strategyState = strategies.state || state.strategyState;
    if (action === "apply") state.selectedStrategy = strategy;
    renderStrategies(state.strategies, state.snapshot?.local_config || {});
    toast(action === "apply" ? "策略已应用到控制台" : "策略状态已更新");
  } catch (error) {
    toast(error.message);
  }
}

function builderPayload() {
  return {
    class_name: $("builderClassName").value.trim(),
    template: $("builderTemplate").value,
    timeframe: $("builderTimeframe").value,
    min_stake_usdt: Number($("builderMinStake").value),
    stoploss: Number($("builderStoploss").value),
    roi_0: Number($("builderRoi0").value),
    roi_1: Number($("builderRoi1").value),
    roi_2: Number($("builderRoi2").value),
    fast_period: Number($("builderFast").value),
    slow_period: Number($("builderSlow").value),
    rsi_buy: Number($("builderRsiBuy").value),
    rsi_sell: Number($("builderRsiSell").value),
  };
}

async function previewStrategyCode() {
  try {
    const result = await postJSON("/api/strategies/preview", builderPayload());
    setText("strategyCodePreview", result.code || "");
  } catch (error) {
    toast(error.message);
  }
}

async function saveGeneratedStrategy() {
  try {
    const result = await postJSON("/api/strategies/create", builderPayload());
    toast(`已保存 ${result.file}`);
    await refresh();
    state.selectedStrategy = result.strategy;
    renderStrategies(state.strategies, state.snapshot?.local_config || {});
  } catch (error) {
    toast(error.message);
  }
}

async function runBacktest() {
  const dataset = selectedBacktestDataset();
  const strategy = $("backtestStrategySelect")?.value;
  const strategyVersionId = $("backtestVersionSelect")?.value || "";
  const start = $("backtestStart")?.value;
  const end = $("backtestEnd")?.value;
  if (!dataset || !strategy || !start || !end) {
    toast("请先选择策略、数据集和时间范围");
    return;
  }
  const button = $("runBacktestBtn");
  state.backtestRunning = true;
  button.disabled = true;
  setText("backtestStatus", "正在运行 Freqtrade 回测，请稍等...");
  try {
    const result = await postJSON("/api/backtests/run", {
      strategy,
      strategy_version_id: strategyVersionId,
      dataset_id: dataset.dataset_id,
      start,
      end,
    });
    setText("backtestStatus", `回测完成：${result.record?.metrics?.strategy || strategy} / ${result.record?.metrics?.profit || "--"}`);
    toast("回测完成，已保存历史记录");
    await refresh();
  } catch (error) {
    setText("backtestStatus", error.message);
    toast(error.message);
  } finally {
    state.backtestRunning = false;
    button.disabled = false;
  }
}

function selectedHyperoptSpaces() {
  return Array.from(document.querySelectorAll('input[name="hyperoptSpace"]:checked')).map((node) => node.value);
}

async function runHyperopt() {
  const dataset = selectedHyperoptDataset();
  const strategy = $("hyperoptStrategySelect")?.value;
  const start = $("hyperoptStart")?.value;
  const end = $("hyperoptEnd")?.value;
  const epochs = Number($("hyperoptEpochs")?.value || 25);
  const minTrades = Number($("hyperoptMinTrades")?.value || 1);
  const spaces = selectedHyperoptSpaces();
  const loss = $("hyperoptLoss")?.value || "SharpeHyperOptLossDaily";
  if (!dataset || !strategy || !start || !end) {
    toast("请先选择策略、数据集和时间范围");
    return;
  }
  if (!spaces.length) {
    toast("请至少选择一个优化空间");
    return;
  }
  if (!Number.isFinite(epochs) || epochs < 1 || epochs > 500) {
    toast("优化轮数必须在 1 到 500 之间");
    return;
  }
  if (!Number.isFinite(minTrades) || minTrades < 1) {
    toast("最少交易数至少为 1");
    return;
  }
  const button = $("runHyperoptBtn");
  state.hyperoptRunning = true;
  if (button) button.disabled = true;
  setText("hyperoptStatus", `正在运行参数优化：${strategy} / ${dataset.pair} / ${epochs} 轮。小轮数通常几秒到几分钟，大轮数会更久。`);
  try {
    const result = await postJSON("/api/hyperopt/run", {
      strategy,
      dataset_id: dataset.dataset_id,
      start,
      end,
      epochs,
      min_trades: minTrades,
      spaces,
      loss,
    });
    const metrics = result.record?.metrics || {};
    const params = result.record?.params || {};
    setText(
      "hyperoptStatus",
      `优化完成：交易 ${metrics.trades ?? "--"} 笔 / 收益 ${metrics.profit_pct ?? "--"}% / 目标函数 ${metrics.objective ?? "--"}\n${hyperoptParamSummary(params)}`,
    );
    toast("参数优化完成，已保存历史记录");
    await refresh();
  } catch (error) {
    setText("hyperoptStatus", error.message);
    toast(error.message);
  } finally {
    state.hyperoptRunning = false;
    if (button) button.disabled = false;
  }
}

async function startSimulation() {
  const strategy = $("simulationStrategySelect")?.value;
  const strategyVersionId = $("simulationVersionSelect")?.value || "";
  const pair = $("simulationPairSelect")?.value;
  if (!strategy || !pair) {
    toast("请先选择策略和交易对");
    return;
  }
  let capital;
  try {
    capital = readSimulationCapitalPayload();
    if (capital.stake_amount * capital.max_open_trades > capital.dry_run_wallet * capital.tradable_balance_ratio) {
      toast("最大可能占用超过可交易模拟资金，请调低单笔投入或最大持仓数");
      syncSimulationCapitalPreview();
      return;
    }
  } catch (error) {
    toast(error.message);
    syncSimulationCapitalPreview();
    return;
  }
  const startBtn = $("startSimulationBtn");
  const stopBtn = $("stopSimulationBtn");
  if (startBtn) startBtn.disabled = true;
  if (stopBtn) stopBtn.disabled = true;
  const warning = $("simulationWarning");
  if (warning) {
    warning.textContent = `正在切换运行策略到 ${strategy}，并启动 dry-run...`;
    warning.classList.remove("hidden");
  }
  clearSimulationOrders();
  try {
    const result = await postJSON("/api/simulation/start", { strategy, strategy_version_id: strategyVersionId, pair, ...capital });
    if (result.blocked) {
      toast(result.message || "安全检查未通过");
      if (warning) {
        warning.textContent = result.message || "安全检查未通过";
        warning.classList.remove("hidden");
      }
      return;
    }
    toast(`模拟交易已启动：${result.active?.runtime_strategy || strategy}`);
    await refresh();
  } catch (error) {
    if (warning) {
      warning.textContent = error.message;
      warning.classList.remove("hidden");
    }
    toast(error.message);
  }
}

async function stopSimulation() {
  const startBtn = $("startSimulationBtn");
  const stopBtn = $("stopSimulationBtn");
  if (startBtn) startBtn.disabled = true;
  if (stopBtn) stopBtn.disabled = true;
  try {
    const result = await postJSON("/api/simulation/stop", {});
    const exitCount = result.force_exit?.exited?.length || 0;
    const cleanCount = result.force_exit?.cleaned_orders?.length || 0;
    toast(`模拟交易已关闭，平仓 ${exitCount} 笔，清理 ${cleanCount} 笔未成交订单`);
    await refresh();
    if (result.record?.id) {
      await loadSimulationDetail(result.record.id, true);
    }
  } catch (error) {
    toast(error.message);
  }
}

async function saveHyperoptAsVersion(hyperoptId) {
  const record = state.hyperopts.find((item) => item.id === hyperoptId);
  if (!record) return;
  const req = record.requested || {};
  const defaultName = `${req.strategy || "策略"} ${req.pair || ""} ${req.timeframe || ""} 优化版`.trim();
  const name = window.prompt("给这个策略版本命名", defaultName);
  if (name === null) return;
  try {
    await postJSON("/api/strategy-versions/create", {
      source_type: "hyperopt",
      source_id: hyperoptId,
      name: name.trim() || defaultName,
    });
    toast("已保存为策略版本");
    await refresh();
  } catch (error) {
    toast(error.message);
  }
}

async function strategyVersionAction(action, id) {
  if (!id) return;
  const payload = { action, id };
  if (action === "delete" && !window.confirm("确定删除这个策略版本吗？已保存的历史记录不会删除。")) return;
  if (action === "rename") {
    const current = state.strategyVersions.find((item) => item.id === id);
    const name = window.prompt("新的版本名称", current?.name || "");
    if (name === null) return;
    payload.name = name.trim();
    if (!payload.name) {
      toast("版本名称不能为空");
      return;
    }
  }
  try {
    await postJSON("/api/strategy-versions/action", payload);
    toast("策略版本已更新");
    await refresh();
  } catch (error) {
    toast(error.message);
  }
}

async function exportVersionToStrategy(id) {
  const version = state.strategyVersions.find((item) => item.id === id);
  if (!version) return;
  const suffix = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const defaultName = `${version.strategy}Opt${suffix}`;
  const className = window.prompt("新策略类名。留空则自动命名。", defaultName);
  if (className === null) return;
  try {
    const result = await postJSON("/api/strategy-versions/export", {
      id,
      class_name: className.trim(),
    });
    state.selectedStrategy = result.strategy;
    toast(`已添加到策略库：${result.strategy}`);
    await refresh();
  } catch (error) {
    toast(error.message);
  }
}

async function deleteHistoryRecord(type, id) {
  const labelMap = {
    backtest: "回测记录",
    simulation: "模拟交易记录",
    hyperopt: "参数优化记录",
  };
  const label = labelMap[type] || "历史记录";
  if (!id) return;
  if (!window.confirm(`确定删除这条${label}吗？`)) return;
  try {
    await postJSON("/api/history/delete", { type, id });
    if (type === "simulation" && state.selectedSimulationHistoryId === id) {
      state.selectedSimulationHistoryId = null;
      state.simulationDetail = null;
      renderSimulationDetail(null);
    }
    if (type === "backtest" && state.selectedBacktestId === id) {
      state.selectedBacktestId = null;
      state.backtestDetail = null;
      renderBacktestDetail(null);
    }
    toast(`已删除${label}`);
    await refresh();
  } catch (error) {
    toast(error.message);
  }
}

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

$("refreshBtn").addEventListener("click", refresh);
$("globalStopBtn").addEventListener("click", () => control("globalstop"));
$("riskStopEntryBtn").addEventListener("click", () => control("stopentry"));
$("riskGlobalStopBtn").addEventListener("click", () => control("globalstop"));
$("applyStrategyBtn").addEventListener("click", () => {
  strategyAction("apply", $("applyStrategyBtn").dataset.strategy);
});
$("disableStrategyBtn").addEventListener("click", () => {
  strategyAction($("disableStrategyBtn").dataset.action, $("disableStrategyBtn").dataset.strategy);
});
$("toggleStrategyBuilderBtn").addEventListener("click", () => {
  $("strategyBuilder").classList.toggle("hidden");
});
$("previewStrategyBtn").addEventListener("click", previewStrategyCode);
$("saveStrategyBtn").addEventListener("click", saveGeneratedStrategy);
$("backtestDatasetSelect").addEventListener("change", () => {
  state.selectedBacktestDataset = $("backtestDatasetSelect").value;
  syncBacktestDatasetFields(selectedBacktestDataset());
});
$("backtestStrategySelect").addEventListener("change", () => {
  state.selectedBacktestVersion = "";
  fillStrategyVersionSelect("backtestVersionSelect", $("backtestStrategySelect").value, "");
});
$("backtestVersionSelect").addEventListener("change", () => {
  state.selectedBacktestVersion = $("backtestVersionSelect").value;
});
$("runBacktestBtn").addEventListener("click", runBacktest);
$("hyperoptDatasetSelect").addEventListener("change", () => {
  state.selectedHyperoptDataset = $("hyperoptDatasetSelect").value;
  syncHyperoptDatasetFields(selectedHyperoptDataset());
});
$("runHyperoptBtn").addEventListener("click", runHyperopt);
$("startSimulationBtn").addEventListener("click", startSimulation);
$("stopSimulationBtn").addEventListener("click", stopSimulation);
$("simulationStrategySelect").addEventListener("change", () => {
  state.selectedSimulationVersion = "";
  fillStrategyVersionSelect("simulationVersionSelect", $("simulationStrategySelect").value, "");
});
$("simulationVersionSelect").addEventListener("change", () => {
  state.selectedSimulationVersion = $("simulationVersionSelect").value;
});
$("dataDownloadForm").addEventListener("submit", downloadDataFromForm);
$("fillWatchlistPairsBtn").addEventListener("click", () => fillDataDownloadDefaults(true));
$("simulationPairSelect").addEventListener("change", () => {
  state.selectedSimulationPair = $("simulationPairSelect").value;
  loadSimulationMarketData();
});
$("livePairSelect").addEventListener("change", () => {
  state.selectedLivePair = $("livePairSelect").value;
  loadLiveMarketData();
});
$("simulationWalletInput").addEventListener("input", () => {
  $("simulationWalletInput").dataset.dirty = "true";
  syncSimulationCapitalPreview();
});
$("simulationStakeInput").addEventListener("input", () => {
  $("simulationStakeInput").dataset.dirty = "true";
  syncSimulationCapitalPreview();
});
$("simulationMaxOpenInput").addEventListener("input", () => {
  $("simulationMaxOpenInput").dataset.dirty = "true";
  syncSimulationCapitalPreview();
});
$("simulationBalanceRatioInput").addEventListener("input", () => {
  $("simulationBalanceRatioInput").dataset.dirty = "true";
  syncSimulationCapitalPreview();
});
document.addEventListener("click", (event) => {
  const button = event.target.closest(".record-delete-button");
  if (!button) return;
  deleteHistoryRecord(button.dataset.historyType, button.dataset.recordId);
});
document.addEventListener("click", (event) => {
  const button = event.target.closest(".record-detail-button");
  if (!button) return;
  if (button.dataset.backtestId) loadBacktestDetail(button.dataset.backtestId);
  if (button.dataset.simulationId) loadSimulationDetail(button.dataset.simulationId);
});
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-hyperopt-version-id]");
  if (!button) return;
  saveHyperoptAsVersion(button.dataset.hyperoptVersionId);
});
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-version-action]");
  if (!button) return;
  strategyVersionAction(button.dataset.versionAction, button.dataset.versionId);
});
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-version-export-id]");
  if (!button) return;
  exportVersionToStrategy(button.dataset.versionExportId);
});
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-data-action]");
  if (!button) return;
  const datasetId = button.dataset.datasetId;
  if (button.dataset.dataAction === "detail") loadDatasetQualityDetail(datasetId);
  if (button.dataset.dataAction === "repair") repairDataset(datasetId);
  if (button.dataset.dataAction === "rename") renameDataset(datasetId, button.dataset.currentName);
  if (button.dataset.dataAction === "delete") deleteDataset(datasetId);
});
$("closeDataQualityBtn")?.addEventListener("click", closeDatasetQualityDetail);
$("addBatchRangeBtn")?.addEventListener("click", addBatchRange);
$("runBatchBacktestBtn")?.addEventListener("click", runBatchBacktest);
$("batchStrategySelect")?.addEventListener("change", () => {
  fillStrategyVersionSelect("batchVersionSelect", $("batchStrategySelect").value, "");
});
document.querySelectorAll("[data-report-tab]").forEach((node) => {
  node.addEventListener("click", () => switchReportTab(node.dataset.reportTab));
});
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-export-kind]");
  if (!button) return;
  exportReport(button.dataset.exportKind, button.dataset.exportId);
});
$("addExperimentBtn")?.addEventListener("click", () => openExperimentForm());
$("cancelExperimentBtn")?.addEventListener("click", () => closeExperimentForm());
$("saveExperimentBtn")?.addEventListener("click", saveExperimentForm);
document.addEventListener("click", (event) => {
  const editButton = event.target.closest("[data-experiment-edit]");
  if (editButton) {
    openExperimentForm(editButton.dataset.experimentEdit);
    return;
  }
  const deleteButton = event.target.closest("[data-experiment-delete]");
  if (deleteButton) {
    deleteExperimentRecord(deleteButton.dataset.experimentDelete);
    return;
  }
  const promoteButton = event.target.closest("[data-experiment-promote]");
  if (promoteButton) {
    togglePromoteExperiment(promoteButton.dataset.experimentPromote, promoteButton.dataset.promoteValue === "true");
  }
});
$("simulationInterval").addEventListener("change", loadSimulationMarketData);
$("simulationWindow").addEventListener("change", loadSimulationMarketData);
$("simulationLogFilter").addEventListener("change", () => {
  renderSimulationLogs(state.snapshot || {}, state.simulation || {});
});
$("liveInterval").addEventListener("change", loadLiveMarketData);
$("liveWindow").addEventListener("change", loadLiveMarketData);
$("liveLogFilter").addEventListener("change", () => {
  renderLiveLogs(state.snapshot || {}, state.snapshot?.local_config?.dry_run === false);
});
$("watchlistForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("watchPairInput");
  const pair = input.value.trim();
  if (!pair) return;
  try {
    await addWatchPair(pair);
    input.value = "";
  } catch (error) {
    toast(error.message);
  }
});
$("marketInterval").addEventListener("change", loadMarketData);
$("marketWindow").addEventListener("change", loadMarketData);
window.addEventListener("resize", () => {
  drawKline(state.candles || []);
  if (state.backtestDetail?.equity_curve) {
    drawBacktestEquityCurve(state.backtestDetail.equity_curve);
  }
  const pair = state.simulation?.active?.pair || state.selectedSimulationPair;
  drawKlineOnCanvas(
    "simulationKlineCanvas",
    "simulationChartEmpty",
    state.simulationCandles || [],
    buildTradeMarkers(pair, state.snapshot || {}),
  );
  const livePair = state.selectedLivePair || state.snapshot?.local_config?.pairs?.[0];
  const liveMarkers = state.snapshot?.local_config?.dry_run === false ? buildTradeMarkers(livePair, state.snapshot || {}) : [];
  drawKlineOnCanvas("liveKlineCanvas", "liveChartEmpty", state.liveCandles || [], liveMarkers);
});

initNavigation();
refresh();
window.setInterval(refresh, 10000);
