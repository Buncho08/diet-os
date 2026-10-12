#!/usr/bin/env node
/**
 * Publish a ChatGPT-generated daily plan through Supabase email/password Auth.
 * Credentials must be supplied by a secret manager, never committed to Git.
 *
 * Usage: node scripts/publish-daily-plan.mjs ./plan.json
 * Env: DIET_OS_EMAIL, DIET_OS_PASSWORD, SUPABASE_PUBLISHABLE_KEY
 * Optional: SUPABASE_URL, DIET_OS_USER_ID (guards against wrong-account writes).
 */
import { readFile } from "node:fs/promises";

const base = (process.env.SUPABASE_URL || "https://dygzsficwncawfkyuvoy.supabase.co").replace(/\/$/, "");
const email = process.env.DIET_OS_EMAIL;
const password = process.env.DIET_OS_PASSWORD;
const apikey = process.env.SUPABASE_PUBLISHABLE_KEY;
if (!email || !password || !apikey) {
  console.error("Missing environment secrets: DIET_OS_EMAIL / DIET_OS_PASSWORD / SUPABASE_PUBLISHABLE_KEY");
  process.exit(2);
}
async function getJson(response, fallback) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof body.error === "string" ? body.error
      : typeof body.msg === "string" ? body.msg : fallback;
    throw new Error(`${fallback}: HTTP ${response.status} - ${message}`);
  }
  return body;
}
const input = process.argv[2]
  ? await readFile(process.argv[2], "utf8")
  : await new Promise((resolve,reject)=>{
      let contents="";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data",chunk=>{contents+=chunk;});
      process.stdin.on("end",()=>resolve(contents));
      process.stdin.on("error",reject);
    });
let plan;
try { plan = JSON.parse(input); }
catch { throw new Error("Plan must be valid JSON"); }
if(!/^\d{4}-\d{2}-\d{2}$/.test(plan?.date??"") || !Array.isArray(plan.items) || !plan.items.length)
  throw new Error("Plan requires date (YYYY-MM-DD) and non-empty items[]");

const authResponse = await fetch(base + "/auth/v1/token?grant_type=password", {
  method:"POST",
  headers:{"Content-Type":"application/json",apikey},
  body:JSON.stringify({email,password}),
  signal:AbortSignal.timeout(15000)
});
const auth = await getJson(authResponse,"Supabase login failed");
if(!auth.access_token || !auth.user?.id)throw new Error("Auth response missing access token or user ID");
if(process.env.DIET_OS_USER_ID && auth.user.id!==process.env.DIET_OS_USER_ID)
  throw new Error("Authenticated user does not match DIET_OS_USER_ID");
const response = await fetch(base + "/functions/v1/daily-plan", {
  method:"POST",
  headers:{"Content-Type":"application/json",apikey,Authorization:"Bearer "+auth.access_token},
  body:JSON.stringify(plan),
  signal:AbortSignal.timeout(15000)
});
const saved = await getJson(response,"Daily plan POST failed");
if(saved.ok!==true || !saved.plan_id)throw new Error("Unexpected publish response");
console.log(JSON.stringify({ok:true,date:plan.date,plan_id:saved.plan_id,items:plan.items.length}));
