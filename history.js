(() => {
  "use strict";

  const byId = id => document.getElementById(id);
  if (!byId("history-page")) return;

  const SUPABASE_URL = "https://dygzsficwncawfkyuvoy.supabase.co";
  const PUBLISHABLE_KEY = "sb_publishable_kjjXKV3-gLiFKuLvTA9nUA_vnVAogFN";
  const client = window.supabase && window.supabase.createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  const planEndpoint = SUPABASE_URL + "/functions/v1/daily-plan";
  const dataEndpoint = SUPABASE_URL + "/functions/v1/diet-data";
  const categoryName = {
    food: "食事", strength: "筋トレ", cardio: "有酸素", steps: "歩数",
    sleep: "睡眠", recovery: "回復", other: "その他"
  };
  const order = ["strength", "cardio", "recovery", "steps", "food", "sleep", "other"];
  const escapeHtml = value => String(value == null ? "" : value).replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[char]));
  const localIso = date => date.getFullYear() + "-" +
    String(date.getMonth() + 1).padStart(2, "0") + "-" +
    String(date.getDate()).padStart(2, "0");
  const shiftDay = (date, amount) => {
    const result = new Date(date + "T12:00:00");
    result.setDate(result.getDate() + amount);
    return localIso(result);
  };
  const yesterday = shiftDay(localIso(new Date()), -1);
  const dateInput = byId("history-date");
  dateInput.max = yesterday;
  let selectedDate = yesterday;
  let loadCounter = 0;
  let hasOpened = false;

  const exists = x => x !== null && x !== undefined && x !== "" &&
    Number.isFinite(Number(x)) && Number(x) > 0;
  const number = (x, digits = 0) => exists(x) ? Number(x).toLocaleString("ja-JP", {
    maximumFractionDigits: digits, minimumFractionDigits: digits
  }) : "—";
  const joinList = (values, fallback) => values.length ? values.join("") :
    '<p class="tiny">' + escapeHtml(fallback) + "</p>";
  const emptyResult = () => ({
    metrics: null, health: null, food: [], workouts: [], plan: null, items: [], source: ""
  });

  function readToken() {
    try {
      const raw = localStorage.getItem("dietOsApiUrl");
      return raw ? new URL(raw).searchParams.get("token") || "" : "";
    } catch (_) { return ""; }
  }

  function localData(date) {
    const get = key => {
      try { return JSON.parse(localStorage.getItem(key)) || []; }
      catch (_) { return []; }
    };
    const entry = get("progressLogs").find(item => item.date === date);
    return {
      metrics: entry || null,
      health: null,
      food: get("foodLogs").filter(item => item.date === date),
      workouts: get("workoutLogs").filter(item => item.date === date),
      plan: null, items: [], source: "端末内の記録"
    };
  }

  async function getSession() {
    if (!client) return null;
    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    return data.session || null;
  }

  async function getOwnRecords(userId, date) {
    const [metrics, health, food, workouts] = await Promise.all([
      client.from("daily_metrics").select("date,weight,sleep,steps,active_energy_kcal,exercise_minutes,dietary_energy_kcal,protein_g")
        .eq("user_id", userId).eq("date", date).maybeSingle(),
      client.from("health_daily").select("date,weight_kg,steps,sleep_minutes,active_energy_kcal,exercise_minutes,dietary_energy_kcal,protein_g,workouts")
        .eq("user_id", userId).eq("date", date).maybeSingle(),
      client.from("food_entries").select("date,meal,name,kcal,protein,memo")
        .eq("user_id", userId).eq("date", date).order("created_at"),
      client.from("workout_logs").select("date,items")
        .eq("user_id", userId).eq("date", date).order("created_at")
    ]);
    if (metrics.error) throw metrics.error;
    if (food.error) throw food.error;
    if (workouts.error) throw workouts.error;
    if (health.error) console.warn("Health history query unavailable:", health.error.message);
    return {
      metrics: metrics.data || null,
      health: health.error ? null : health.data,
      food: food.data || [],
      workouts: workouts.data || [],
      plan: null, items: [], source: "Supabase"
    };
  }

  async function getPlan(date, token, accessToken) {
    if (!token && !accessToken) return null;
    const url = new URL(planEndpoint);
    url.searchParams.set("date", date);
    if (token) url.searchParams.set("token", token);
    const headers = accessToken ? { Authorization: "Bearer " + accessToken } : {};
    const response = await fetch(url.toString(), { headers, cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "過去のプランを取得できませんでした");
    return body;
  }

  async function getSharedRecords(date, token) {
    const result = emptyResult();
    const days = Math.round((new Date(yesterday + "T12:00:00") - new Date(date + "T12:00:00")) / 86400000) + 2;
    if (days > 90) throw new Error("共有URLで閲覧できるのは直近90日間です。以前の記録は元のログイン端末で確認してください。");
    const url = new URL(dataEndpoint);
    url.searchParams.set("token", token);
    url.searchParams.set("days", String(Math.max(1, Math.min(90, days))));
    const response = await fetch(url.toString(), { cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "共有された記録の取得に失敗しました");
    result.metrics = (body.daily_metrics || []).find(item => item.date === date) || null;
    result.food = (body.food || []).filter(item => item.date === date);
    result.workouts = (body.workouts || []).filter(item => item.date === date);
    result.source = "共有データ（閲覧専用）";
    return result;
  }

  function formatDay(date) {
    return new Intl.DateTimeFormat("ja-JP", { month: "long", day: "numeric", weekday: "short" })
      .format(new Date(date + "T12:00:00"));
  }

  function renderRecentDates() {
    byId("history-recent").innerHTML = "";
    for (let i = 0; i < 7; i++) {
      const day = shiftDay(yesterday, -i);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "history-chip" + (day === selectedDate ? " selected" : "");
      button.textContent = new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", weekday: "short" })
        .format(new Date(day + "T12:00:00"));
      button.addEventListener("click", () => chooseDate(day));
      byId("history-recent").appendChild(button);
    }
  }

  function chooseDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
    const parsed = new Date(value + "T12:00:00");
    if (Number.isNaN(parsed.getTime()) || localIso(parsed) !== value) return;
    selectedDate = value > yesterday ? yesterday : value;
    dateInput.value = selectedDate;
    byId("history-next").disabled = selectedDate >= yesterday;
    byId("history-current-date").textContent = formatDay(selectedDate);
    renderRecentDates();
    loadHistory();
  }

  function planItemsHtml(items) {
    if (!items.length) return '<p class="tiny">この日のプランは登録されていません。</p>';
    return order.filter(category => items.some(item => item.category === category)).map(category => {
      return '<h3 class="history-subheading">' + escapeHtml(categoryName[category]) + "</h3>" +
        items.filter(item => item.category === category).map(item => {
          const status = item.status === "done" ? "完了" :
            item.status === "skipped" ? "未実施" : "未チェック";
          const klass = item.status === "done" ? "done" :
            item.status === "skipped" ? "skipped" : "";
          return '<div class="history-entry ' + klass + '"><div class="item-row"><b>' +
            escapeHtml(item.title) + '</b><span class="plan-state">' + status + '</span></div>' +
            '<div class="tiny" style="margin-top:6px;line-height:1.6">' + escapeHtml(item.detail) + '</div>' +
            (item.memo ? '<div class="history-memo">メモ：' + escapeHtml(item.memo) + '</div>' : "") +
            "</div>";
        }).join("");
    }).join("");
  }

  function foodHtml(entries) {
    return joinList(entries.map(item => {
      const p = Number(item.protein);
      return '<div class="history-entry"><div class="item-row"><div><b>' +
        escapeHtml(item.meal || "食事") + " ・ " + escapeHtml(item.name || "名称未入力") +
        '</b><div class="tiny">' + number(item.kcal) + " kcal / P " +
        (exists(p) ? number(p, 1) + "g" : "未入力") + "</div>" +
        (item.memo ? '<div class="tiny">' + escapeHtml(item.memo) + "</div>" : "") +
        "</div></div></div>";
    }), "食事の記録はありません。");
  }

  function workoutsHtml(logs, health) {
    const exercises = logs.flatMap(log => Array.isArray(log.items) ? log.items : []);
    const entries = exercises.map(item => {
      const reps = [item.r1, item.r2].filter(exists).map(x => number(x) + "回").join(" / ");
      return '<div class="history-entry"><b>' + escapeHtml(item.name || "トレーニング") +
        '</b><div class="tiny" style="margin-top:4px">' +
        (exists(item.weight) ? number(item.weight, 1) + "kg ・ " : "") +
        (reps || "回数の記録なし") + "</div></div>";
    });
    const synced = Array.isArray(health && health.workouts) ? health.workouts : [];
    synced.forEach(item => {
      if (!item || typeof item !== "object") return;
      const label = item.name || item.type || item.workoutType || item.activity_type || "Apple Watchワークアウト";
      const duration = Number(item.duration_minutes ?? item.duration ?? item.minutes);
      entries.push('<div class="history-entry"><b>' + escapeHtml(label) +
        '</b><div class="tiny">' + (exists(duration) ? number(duration, 1) + "分" : "Apple Health同期") +
        "</div></div>");
    });
    return joinList(entries, "筋トレ・ワークアウトの実績はありません。");
  }

  function renderHistory(data) {
    const metric = data.metrics || {};
    const health = data.health || {};
    const food = Array.isArray(data.food) ? data.food : [];
    const workouts = Array.isArray(data.workouts) ? data.workouts : [];
    const items = Array.isArray(data.items) ? data.items : [];
    const totalKcal = food.length ? food.reduce((sum, x) => sum + (Number(x.kcal) || 0), 0) :
      (exists(metric.dietary_energy_kcal) ? metric.dietary_energy_kcal : health.dietary_energy_kcal);
    const proteinRecorded = food.some(x => exists(x.protein));
    const protein = proteinRecorded ? food.reduce((sum, x) => sum + (Number(x.protein) || 0), 0) :
      (exists(metric.protein_g) ? metric.protein_g : health.protein_g);
    const steps = exists(health.steps) ? health.steps : metric.steps;
    const sleep = exists(health.sleep_minutes) ? Number(health.sleep_minutes) / 60 : metric.sleep;
    const weight = exists(health.weight_kg) ? health.weight_kg : metric.weight;
    const done = items.filter(x => x.status === "done").length;
    const skipped = items.filter(x => x.status === "skipped").length;

    byId("history-source").textContent = data.source || "保存済みデータ";
    byId("history-kcal").textContent = number(totalKcal);
    byId("history-protein").textContent = number(protein, 1);
    byId("history-steps").textContent = number(steps);
    byId("history-sleep").textContent = number(sleep, 1);
    byId("history-weight").textContent = number(weight, 1);
    byId("history-plan-title").textContent = data.plan ? data.plan.title || "今日のプラン" : "プランの記録なし";
    byId("history-plan-summary").textContent = data.plan ? data.plan.summary || "" : "過去に登録したプランはありません。";
    byId("history-plan-score").textContent = data.plan ?
      "完了 " + done + " / " + items.length + " ・ 未実施 " + skipped + " ・ 未チェック " + (items.length - done - skipped) :
      "未登録";
    byId("history-plan-items").innerHTML = planItemsHtml(items);
    byId("history-food-list").innerHTML = foodHtml(food);
    byId("history-workout-list").innerHTML = workoutsHtml(workouts, health);
    const hasAnyData = Boolean(data.plan || food.length || workouts.length || exists(steps) || exists(sleep) || exists(weight));
    byId("history-status").textContent = hasAnyData ?
      "保存された実績を表示しています。過去の日付は閲覧専用です。" :
      "この日の記録はまだありません。";
  }

  async function loadHistory() {
    const requestId = ++loadCounter;
    byId("history-status").textContent = "Supabaseから取得中…";
    byId("history-source").textContent = "読み込み中";
    const date = selectedDate;
    try {
      const session = await getSession();
      const token = readToken();
      const accessToken = session && session.access_token;
      let result = emptyResult();
      let ownError = null;
      if (session && session.user) {
        try { result = await getOwnRecords(session.user.id, date); }
        catch (error) { ownError = error; }
      }
      let planResult = null;
      try { planResult = await getPlan(date, token, accessToken); }
      catch (error) {
        if (ownError || (!session && !token)) throw error;
        console.warn("Could not load historical plan:", error);
      }
      const sharedOwner = Boolean(planResult && planResult.read_only);
      if ((sharedOwner || (!session && token) || ownError) && token) {
        const shared = await getSharedRecords(date, token);
        result = shared;
      }
      if (ownError && !token) throw ownError;
      if (planResult) {
        result.plan = planResult.plan || null;
        result.items = planResult.items || [];
      }
      if (!session && !token) result = localData(date);
      if (requestId !== loadCounter) return;
      renderHistory(result);
    } catch (error) {
      if (requestId !== loadCounter) return;
      const local = localData(date);
      if (local.metrics || local.food.length || local.workouts.length) {
        renderHistory(local);
        byId("history-status").textContent = "クラウドへの接続に失敗したため、この端末の記録を表示しています。";
      } else {
        renderHistory(emptyResult());
        byId("history-status").textContent = "取得に失敗しました：" + String(error && error.message || error);
      }
    }
  }

  byId("history-previous").addEventListener("click", () => chooseDate(shiftDay(selectedDate, -1)));
  byId("history-next").addEventListener("click", () => chooseDate(shiftDay(selectedDate, 1)));
  byId("history-yesterday").addEventListener("click", () => chooseDate(yesterday));
  dateInput.addEventListener("change", () => chooseDate(dateInput.value));
  byId("history-refresh").addEventListener("click", () => loadHistory());
  const nav = document.querySelector('label[for="tab-history"]');
  if (nav) nav.addEventListener("click", () => {
    if (!hasOpened) { hasOpened = true; chooseDate(yesterday); }
    else loadHistory();
  });
  dateInput.value = yesterday;
  byId("history-current-date").textContent = formatDay(yesterday);
  byId("history-next").disabled = true;
  renderRecentDates();
})();
