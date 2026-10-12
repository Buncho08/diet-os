import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8"
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: cors });

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function clampDays(raw: string | null) {
  const n = Number(raw ?? 14);
  if (!Number.isFinite(n)) return 14;
  return Math.min(90, Math.max(1, Math.floor(n)));
}

function daysAgo(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return d.toISOString().slice(0, 10);
}

function avg(values: unknown[]) {
  const nums = values.map(Number).filter((v) => Number.isFinite(v) && v > 0);
  if (!nums.length) return null;
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  if (req.method === "POST" || req.method === "DELETE") {
    const auth = req.headers.get("Authorization");
    if (!auth?.startsWith("Bearer ")) return json({ error: "login required" }, 401);

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: auth } },
      auth: { persistSession: false, autoRefreshToken: false }
    });

    const { data: userData, error: userError } = await userClient.auth.getUser();
    const user = userData.user;
    if (userError || !user) return json({ error: "invalid session" }, 401);

    if (req.method === "DELETE") {
      const { error } = await userClient
        .from("api_tokens")
        .update({ active: false })
        .eq("user_id", user.id)
        .eq("active", true)
        .not("scopes", "cs", JSON.stringify({plan_write:true}));

      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    const body = await req.json().catch(() => ({}));
    const incoming = body?.scopes ?? {};
    const scopes = {
      food: incoming.food !== false,
      workouts: incoming.workouts !== false,
      activity: incoming.activity !== false,
      weight: incoming.weight === true,
      measurements: incoming.measurements === true
    };

    await userClient
      .from("api_tokens")
      .update({ active: false })
      .eq("user_id", user.id)
      .eq("active", true)
        .not("scopes", "cs", JSON.stringify({plan_write:true}));

    const token = randomToken();
    const tokenHash = await sha256(token);

    const { error } = await userClient.from("api_tokens").insert({
      user_id: user.id,
      token_hash: tokenHash,
      scopes,
      active: true
    });

    if (error) return json({ error: error.message }, 400);

    const apiUrl = new URL(req.url);
    apiUrl.search = "";
    apiUrl.searchParams.set("token", token);
    apiUrl.searchParams.set("days", "14");

    return json({
      api_url: apiUrl.toString(),
      scopes,
      max_days: 90,
      note: "This URL is secret. Revoke or regenerate it from Diet OS if exposed."
    }, 201);
  }

  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);

  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";
  if (!token) return json({ error: "token required" }, 401);

  const tokenHash = await sha256(token);
  const { data: tokenRow, error: tokenError } = await service
    .from("api_tokens")
    .select("id,user_id,scopes,active")
    .eq("token_hash", tokenHash)
    .eq("active", true)
    .maybeSingle();

  if (tokenError) return json({ error: "token lookup failed" }, 500);
  if (!tokenRow) return json({ error: "invalid or revoked token" }, 401);

  const days = clampDays(url.searchParams.get("days"));
  const from = daysAgo(days);
  const to = new Date().toISOString().slice(0, 10);
  const scopes = tokenRow.scopes ?? {};

  const result: Record<string, unknown> = {
    period: { days, from, to },
    generated_at: new Date().toISOString(),
    privacy: {
      goal_weight_included: false,
      weight_included: scopes.weight === true,
      measurements_included: scopes.measurements === true
    }
  };
  const summary: Record<string, unknown> = {};

  const { data: preferences, error: preferencesError } = await service
    .from("user_preferences")
    .select("gym_days,move_goal_kcal,updated_at")
    .eq("user_id", tokenRow.user_id)
    .maybeSingle();

  if (preferencesError) return json({ error: preferencesError.message }, 500);
  result.preferences = preferences ?? {
    gym_days: ["tue", "wed", "fri"],
    move_goal_kcal: 500,
    updated_at: null
  };

  if (scopes.activity || scopes.weight || scopes.measurements || scopes.food) {
    const { data, error } = await service
      .from("daily_metrics")
      .select("date,weight,waist,thigh,calf,sleep,steps,active_energy_kcal,exercise_minutes,dietary_energy_kcal,protein_g,carbs_g,fat_g,fiber_g")
      .eq("user_id", tokenRow.user_id)
      .gte("date", from)
      .lte("date", to)
      .order("date");

    if (error) return json({ error: error.message }, 500);

    const rows = (data ?? []).map((x: any) => {
      const out: Record<string, unknown> = { date: x.date };
      if (scopes.activity) {
        out.sleep = x.sleep;
        out.steps = x.steps;
        out.active_energy_kcal = x.active_energy_kcal;
        out.exercise_minutes = x.exercise_minutes;
      }
      if (scopes.food) {
        out.dietary_energy_kcal = x.dietary_energy_kcal;
        out.protein_g = x.protein_g;
        out.carbs_g = x.carbs_g;
        out.fat_g = x.fat_g;
        out.fiber_g = x.fiber_g;
      }
      if (scopes.weight) out.weight = x.weight;
      if (scopes.measurements) {
        out.waist = x.waist;
        out.thigh = x.thigh;
        out.calf = x.calf;
      }
      return out;
    });

    result.daily_metrics = rows;

    if (scopes.activity) {
      summary.avg_steps = avg((data ?? []).map((x: any) => x.steps));
      summary.avg_sleep = avg((data ?? []).map((x: any) => x.sleep));
    }

    if (scopes.weight) {
      const weights = (data ?? [])
        .map((x: any) => Number(x.weight))
        .filter((v: number) => Number.isFinite(v) && v > 0);
      summary.current_weight = weights.length ? weights[weights.length - 1] : null;
      summary.avg_weight = weights.length
        ? Math.round((weights.reduce((a: number, b: number) => a + b, 0) / weights.length) * 10) / 10
        : null;
      summary.weight_change = weights.length >= 2
        ? Math.round((weights[weights.length - 1] - weights[0]) * 10) / 10
        : null;
    }
  }

  if (scopes.food) {
    const { data, error } = await service
      .from("food_entries")
      .select("date,meal,name,kcal,protein,memo")
      .eq("user_id", tokenRow.user_id)
      .gte("date", from)
      .lte("date", to)
      .order("date");

    if (error) return json({ error: error.message }, 500);

    result.food = data ?? [];
    const perDay = new Map<string, { kcal: number; protein: number }>();

    for (const x of data ?? []) {
      const cur = perDay.get(x.date) ?? { kcal: 0, protein: 0 };
      cur.kcal += Number(x.kcal ?? 0);
      cur.protein += Number(x.protein ?? 0);
      perDay.set(x.date, cur);
    }

    const daily = Array.from(perDay.values());
    summary.food_logged_days = daily.length;
    summary.avg_calories_per_logged_day = daily.length
      ? Math.round((daily.reduce((s, x) => s + x.kcal, 0) / daily.length) * 10) / 10
      : null;
    summary.avg_protein_per_logged_day = daily.length
      ? Math.round((daily.reduce((s, x) => s + x.protein, 0) / daily.length) * 10) / 10
      : null;
    summary.external_meals = (data ?? []).filter((x: any) => x.meal === "外食").length;
  }

  if (scopes.workouts) {
    const { data, error } = await service
      .from("workout_logs")
      .select("date,items")
      .eq("user_id", tokenRow.user_id)
      .gte("date", from)
      .lte("date", to)
      .order("date");

    if (error) return json({ error: error.message }, 500);

    result.workouts = data ?? [];
    summary.workout_count = (data ?? []).length;
  }

  result.summary = summary;

  service
    .from("api_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", tokenRow.id)
    .then(() => {});

  return json(result);
});
