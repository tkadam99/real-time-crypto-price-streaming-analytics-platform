export const DASHBOARD_REFRESH_INTERVAL_MS = 10_000;

export function createDashboardRefresh({
  fetchCurrentPrices,
  fetchMetrics,
  fetchAlerts,
  fetchPriceHistory,
  onChange,
  initialSymbol = "BTC-USD",
  now = Date.now,
  schedule = setInterval,
  cancel = clearInterval,
}) {
  let state = {
    currentPrices: [],
    metrics: [],
    alerts: [],
    history: [],
    historySymbol: null,
    hasCurrentPrices: false,
    hasHistory: false,
    refreshing: false,
    currentError: "",
    historyError: "",
    lastCurrentRefresh: null,
    lastHistoricalRefresh: null,
    currentTime: now(),
  };
  let symbol = initialSymbol;
  let stopped = true;
  let timer;
  const lanes = {
    current: { active: false, queued: false, generation: 0, controller: null },
    history: { active: false, queued: false, generation: 0, controller: null },
  };

  function update(patch) {
    state = { ...state, ...patch };
    if (!stopped) onChange(state);
  }

  function validate(response) {
    if (!response || response.success !== true || !Array.isArray(response.data)) {
      throw new Error("Invalid dashboard API response");
    }
    return response.data;
  }

  async function run(name) {
    const lane = lanes[name];
    if (stopped || lane.active) return;
    lane.active = true;
    lane.queued = false;
    const requestId = lane.generation;
    const requestSymbol = symbol;
    const controller = new AbortController();
    lane.controller = controller;
    update({ refreshing: true, currentTime: now() });

    let firstFailure;
    let failed = false;
    const requests = name === "current"
      ? [() => fetchCurrentPrices(controller.signal)]
      : [
          () => fetchMetrics(controller.signal),
          () => fetchAlerts(10, controller.signal),
          () => fetchPriceHistory(requestSymbol, 10, controller.signal),
        ];
    const results = await Promise.allSettled(requests.map((request) =>
      Promise.resolve().then(request).then(validate).catch((error) => {
        if (!failed) {
          failed = true;
          firstFailure = error;
          controller.abort();
        }
        throw error;
      })
    ));

    lane.active = false;
    lane.controller = null;
    if (stopped) return;
    if (requestId === lane.generation) {
      const completedAt = now();
      const patch = { currentTime: completedAt };
      if (failed) {
        patch[name === "current" ? "currentError" : "historyError"] =
          firstFailure?.message || "Failed to refresh dashboard data";
      } else if (name === "current") {
        patch.currentPrices = results[0].value;
        patch.hasCurrentPrices = true;
        patch.currentError = "";
        patch.lastCurrentRefresh = completedAt;
      } else {
        patch.metrics = results[0].value;
        patch.alerts = results[1].value;
        patch.history = results[2].value;
        patch.historySymbol = requestSymbol;
        patch.hasHistory = true;
        patch.historyError = "";
        patch.lastHistoricalRefresh = completedAt;
      }
      patch.refreshing = lanes.current.active || lanes.history.active || lane.queued;
      update(patch);
    }
    if (lane.queued) void run(name);
  }

  function requestLane(name) {
    const lane = lanes[name];
    lane.generation += 1;
    lane.queued = true;
    if (!lane.active) void run(name);
  }

  function refresh() {
    if (stopped) return;
    requestLane("current");
    requestLane("history");
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    refresh();
    timer = schedule(() => {
      update({ currentTime: now() });
      for (const name of ["current", "history"]) {
        if (!lanes[name].active) requestLane(name);
      }
    }, DASHBOARD_REFRESH_INTERVAL_MS);
  }

  function stop() {
    stopped = true;
    for (const lane of Object.values(lanes)) {
      lane.generation += 1;
      lane.queued = false;
      if (lane.controller) lane.controller.abort();
    }
    if (timer !== undefined) cancel(timer);
  }

  function setSymbol(nextSymbol) {
    if (stopped || nextSymbol === symbol) return;
    symbol = nextSymbol;
    requestLane("history");
  }

  return { start, stop, refresh, setSymbol };
}
