import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const reply=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}});
const hash=async (input:string)=>{
  const data=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(input));
  return Array.from(new Uint8Array(data),x=>x.toString(16).padStart(2,"0")).join("");
};
Deno.serve(async(req:Request)=>{
  if(req.method!=="POST")return reply({error:"method not allowed"},405);
  const token=req.headers.get("X-Plan-Token")??"";
  if(!/^[a-f0-9]{64}$/i.test(token))return reply({error:"invalid plan write token"},401);
  const service=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    {auth:{persistSession:false,autoRefreshToken:false}});
  const {data:access,error:accessError}=await service.from("api_tokens").select("user_id,scopes")
    .eq("token_hash",await hash(token)).eq("active",true).maybeSingle();
  if(accessError)return reply({error:"authentication unavailable"},503);
  if(!access||access.scopes?.plan_write!==true)return reply({error:"invalid plan write token"},401);
  let input:any;
  try{input=await req.json();}catch{return reply({error:"invalid JSON"},400);}
  if(typeof input?.date!=="string"||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(input.date)||
     !Array.isArray(input.items)||input.items.length<1||input.items.length>40)
    return reply({error:"date (YYYY-MM-DD) and 1-40 items required"},400);
  const allowed=new Set(["food","strength","cardio","steps","sleep","recovery","other"]);
  if(!input.items.every((x:any)=>x && allowed.has(x.category) &&
    typeof x.title==="string"&&x.title.length>0&&x.title.length<=150&&
    (x.detail===undefined||(typeof x.detail==="string"&&x.detail.length<=1500))))
    return reply({error:"invalid items"},400);
  const {data:plan,error:planError}=await service.from("daily_plans").upsert({
    user_id:access.user_id,plan_date:input.date,title:String(input.title??"今日のプラン").slice(0,150),
    summary:String(input.summary??"").slice(0,1500),generated_by:"chatgpt",
    updated_at:new Date().toISOString()
  },{onConflict:"user_id,plan_date"}).select("id").single();
  if(planError)return reply({error:planError.message},400);
  const {data:existing,error:existingError}=await service.from("daily_plan_items").select("status")
    .eq("user_id",access.user_id).eq("plan_id",plan.id);
  if(existingError)return reply({error:existingError.message},400);
  if(existing?.some((x:any)=>x.status!=="pending"))
    return reply({error:"plan has progress; refusing to reset status"},409);
  const {error:deleteError}=await service.from("daily_plan_items").delete()
    .eq("user_id",access.user_id).eq("plan_id",plan.id);
  if(deleteError)return reply({error:deleteError.message},400);
  const rows=input.items.map((x:any,i:number)=>({
    plan_id:plan.id,user_id:access.user_id,category:x.category,title:x.title,
    detail:x.detail??"",status:"pending",memo:"",sort_order:i
  }));
  const {error:insertError}=await service.from("daily_plan_items").insert(rows);
  if(insertError)return reply({error:insertError.message},400);
  return reply({ok:true,plan_id:plan.id,items_saved:rows.length},201);
});