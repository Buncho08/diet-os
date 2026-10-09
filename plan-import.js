/*
 * Diet OS plan transport. ChatGPT supplies all decisions.
 * The app only sends a validated plan through the authenticated POST API.
 */
(() => {
  "use strict";
  function openImport() {
    const raw = new URLSearchParams(location.hash.replace(/^#/, "")).get("dietPlan");
    if (!raw) return;
    let plan;
    try {
      plan = JSON.parse(raw);
      if (!plan || !/^\d{4}-\d{2}-\d{2}$/.test(plan.date) ||
          !Array.isArray(plan.items) || plan.items.length < 1 || plan.items.length > 40) {
        throw Error("日付または登録項目が不正です。");
      }
      const categories = new Set(["food", "strength", "cardio", "steps", "sleep", "recovery", "other"]);
      if (plan.items.some(x => !x || !categories.has(x.category) || typeof x.title !== "string" ||
          !x.title.trim() || typeof x.detail !== "string")) throw Error("項目の形式が不正です。");
    } catch (error) {
      alert("プランの読み込みに失敗しました: " + error.message);
      return;
    }
    const style = document.createElement("style");
    style.textContent = [
      "#chatgpt-plan-import{position:fixed;inset:0;z-index:100002;display:grid;place-items:center;background:rgba(0,0,0,.84);padding:16px;overflow:auto}",
      "#chatgpt-plan-import .import-panel{width:min(430px,100%);padding:22px;background:#151c22;border:1px solid #41515c;border-radius:20px;color:#f7f9fa;line-height:1.6}",
      "#chatgpt-plan-import button{width:100%;min-height:48px;border:0;border-radius:12px;margin-top:11px;padding:10px 14px;font:inherit;font-weight:800}",
      "#chatgpt-plan-import .confirm{background:#b5f47d;color:#0b1407;font-weight:900}",
      "#chatgpt-plan-import .cancel{background:#263039;color:#f7f9fa}",
      "#chatgpt-plan-import button:disabled{opacity:.55}",
      "#chatgpt-plan-import .desc{font-size:.84rem;color:#aeb8c1;overflow-wrap:anywhere}"
    ].join("\n");
    document.head.appendChild(style);
    const cover = document.createElement("div");
    cover.id = "chatgpt-plan-import";
    cover.setAttribute("role", "dialog");
    cover.setAttribute("aria-modal", "true");
    cover.setAttribute("aria-label", "ChatGPTプランを登録");
    const panel = document.createElement("div");
    panel.className = "import-panel";
    const title = document.createElement("h2");
    title.textContent = "ChatGPTのプランを登録";
    const detail = document.createElement("p");
    detail.className = "desc";
    detail.textContent = plan.date + " / " + (plan.title || "今日のプラン") +
      " / " + plan.items.length + "項目。Diet OSのログイン認証でSupabaseのPOST APIへ送信します。";
    const warning = document.createElement("p");
    warning.className = "desc";
    warning.textContent = "登録すると、この日付の既存プランとチェック状態は置き換わり、全項目が未実施になります。";
    const preview = document.createElement("div");
    preview.className = "desc";
    preview.style.cssText = "max-height:180px;overflow-y:auto;padding:10px;border:1px solid #34414b;border-radius:10px;margin:10px 0";
    preview.textContent = plan.items.map((x,i) => (i+1) + ". " + x.title + " — " + x.detail).join("\n");
    preview.style.whiteSpace = "pre-wrap";
    const localDate = new Date();
    const today = [localDate.getFullYear(),String(localDate.getMonth()+1).padStart(2,"0"),String(localDate.getDate()).padStart(2,"0")].join("-");
    if (plan.date !== today) warning.textContent = "注意：これは今日以外のプランです。登録すると過去または未来の既存項目が置き換わります。";
    const status = document.createElement("p");
    status.className = "desc";
    status.setAttribute("role", "status");
    status.textContent = "内容を確認して登録してください。";
    const confirm = document.createElement("button");
    confirm.className = "confirm";
    confirm.textContent = "POST APIで登録";
    const cancel = document.createElement("button");
    cancel.className = "cancel";
    cancel.textContent = "キャンセル";
    cancel.addEventListener("click", () => {
      history.replaceState(null, "", location.pathname + location.search);
      cover.remove();
    });
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      status.textContent = "認証と登録を確認中…";
      status.style.color = "";
      try {
        if (!window.supabase?.createClient) throw Error("Supabaseライブラリが読み込めません。");
        const sdk = window.supabase.createClient(
          "https://dygzsficwncawfkyuvoy.supabase.co",
          "sb_publishable_kjjXKV3-gLiFKuLvTA9nUA_vnVAogFN",
          { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }
        );
        const session = (await sdk.auth.getSession()).data.session;
        if (!session?.access_token) throw Error("認証情報がありません。Diet OSの元の端末から開いてください。");
        const { data: user, error: userError } = await sdk.auth.getUser();
        if (userError || !user?.user) throw Error("ログインが無効です。");
        const endpoint = "https://dygzsficwncawfkyuvoy.supabase.co/functions/v1/daily-plan";
        const tokenUrl = localStorage.getItem("dietOsApiUrl");
        if (tokenUrl) {
          const token = new URL(tokenUrl).searchParams.get("token");
          if (token) {
            const check = new URL(endpoint);
            check.searchParams.set("date", plan.date);
            check.searchParams.set("token", token);
            const owner = await fetch(check, { headers: { Authorization: "Bearer " + session.access_token } });
            if (!owner.ok) throw Error("共有プランの所有者を確認できません。");
            const owned = await owner.json();
            if (owned.read_only) throw Error("この端末は別の匿名セッションです。プラン所有者の端末で登録してください。");
          }
        }
        const body = {
          date: plan.date,
          title: String(plan.title || "今日のプラン").slice(0, 100),
          summary: String(plan.summary || "").slice(0, 600),
          items: plan.items.map((x,i) => ({
            category: x.category,
            title: x.title.slice(0, 80),
            detail: x.detail.slice(0, 600),
            sort_order: i+1
          }))
        };
        status.textContent = "SupabaseへPOST送信中…";
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + session.access_token },
          body: JSON.stringify(body)
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.ok) throw Error(result.error || "POSTに失敗しました（HTTP " + response.status + "）。");
        const url = new URL(endpoint);
        url.searchParams.set("date", plan.date);
        const read = await fetch(url, { headers: { Authorization: "Bearer " + session.access_token } });
        const verified = await read.json().catch(() => ({}));
        if (!read.ok || !verified.plan || verified.items?.length !== body.items.length ||
            verified.items.some(x => x.status !== "pending")) {
          throw Error("POSTは受理されましたが、登録結果の検証に失敗しました。");
        }
        status.textContent = body.items.length + "項目を登録・検証しました。画面を更新します。";
        history.replaceState(null, "", location.pathname + location.search);
        location.reload();
      } catch (error) {
        status.textContent = "登録できませんでした: " + String(error.message || error);
        status.style.color = "#ffd166";
        confirm.disabled = false;
      }
    });
    panel.append(title, detail, warning, preview, status, confirm, cancel);
    cover.append(panel);
    document.body.appendChild(cover);
    confirm.focus();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", openImport, { once: true });
  } else openImport();
})();
