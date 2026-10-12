import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL=Deno.env.get("SUPABASE_URL")!;
const ANON=Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const headers={
  "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods":"GET, POST, PATCH, OPTIONS",
  "Cache-Control":"no-store",
  "Content-Type":"application/json; charset=utf-8"
};
const json=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status,headers});

async function sha256(value:string){
  const bytes=new TextEncoder().encode(value);
  const digest=await crypto.subtle.digest("SHA-256",bytes);
  return Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,"0")).join("");
}

async function clientFor(req:Request){
  const auth=req.headers.get("Authorization");
  if(!auth?.startsWith("Bearer ")) return {error:"login required",client:null,user:null};
  const client=createClient(SUPABASE_URL,ANON,{
    global:{headers:{Authorization:auth}},
    auth:{persistSession:false,autoRefreshToken:false}
  });
  const {data,error}=await client.auth.getUser();
  if(error||!data.user)return {error:"invalid session",client:null,user:null};
  return {error:null,client,user:data.user};
}

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS") return new Response("ok",{headers});

  const url=new URL(req.url);
  const session=await clientFor(req);
  const service=createClient(SUPABASE_URL,SERVICE,{auth:{persistSession:false,autoRefreshToken:false}});

  if(req.method==="GET"){
    const date=url.searchParams.get("date");
    if(!date)return json({error:"date required"},400);

    let ownerUserId=session.user?.id??null;
    let readDb:any=session.client;
    let readOnly=false;
    let accessSource="session";
    let tokenScopes:any=null;

    const token=url.searchParams.get("token");
    if(token){
      const tokenHash=await sha256(token);
      const {data:tokenRow,error:tokenError}=await service.from("api_tokens")
        .select("user_id,active,scopes")
        .eq("token_hash",tokenHash)
        .eq("active",true)
        .maybeSingle();
      if(tokenError)return json({error:"token lookup failed"},500);
      if(tokenRow){
        ownerUserId=tokenRow.user_id;
        readDb=service;
        tokenScopes=tokenRow.scopes??{};
        readOnly=!session.user || session.user.id!==ownerUserId;
        accessSource="api_token";
      }
    }

    if(!ownerUserId||!readDb)return json({error:session.error||"login required"},401);

    const {data:plan,error}=await readDb.from("daily_plans")
      .select("id,plan_date,title,summary,generated_by,updated_at")
      .eq("user_id",ownerUserId).eq("plan_date",date).maybeSingle();
    if(error)return json({error:error.message},400);

    const {data:preferences,error:preferencesError}=await readDb.from("user_preferences")
      .select("gym_days,move_goal_kcal,updated_at")
      .eq("user_id",ownerUserId).maybeSingle();
    if(preferencesError)return json({error:preferencesError.message},400);

    const {data:metrics,error:metricsError}=await readDb.from("daily_metrics")
      .select("date,weight,sleep,steps,active_energy_kcal,exercise_minutes,dietary_energy_kcal,protein_g,carbs_g,fat_g,fiber_g,updated_at")
      .eq("user_id",ownerUserId).eq("date",date).maybeSingle();
    if(metricsError)return json({error:metricsError.message},400);

    let visibleMetrics:any=metrics??null;
    if(visibleMetrics && tokenScopes){
      visibleMetrics={date:visibleMetrics.date,updated_at:visibleMetrics.updated_at};
      if(tokenScopes.activity===true){
        visibleMetrics.sleep=metrics?.sleep??null;
        visibleMetrics.steps=metrics?.steps??null;
        visibleMetrics.active_energy_kcal=metrics?.active_energy_kcal??null;
        visibleMetrics.exercise_minutes=metrics?.exercise_minutes??null;
      }
      if(tokenScopes.food===true){
        visibleMetrics.dietary_energy_kcal=metrics?.dietary_energy_kcal??null;
        visibleMetrics.protein_g=metrics?.protein_g??null;
        visibleMetrics.carbs_g=metrics?.carbs_g??null;
        visibleMetrics.fat_g=metrics?.fat_g??null;
        visibleMetrics.fiber_g=metrics?.fiber_g??null;
      }
      if(tokenScopes.weight===true)visibleMetrics.weight=metrics?.weight??null;
    }

    if(!plan)return json({plan:null,items:[],preferences:preferences??null,metrics:visibleMetrics,read_only:readOnly,access_source:accessSource});

    const {data:items,error:itemError}=await readDb.from("daily_plan_items")
      .select("id,category,title,detail,memo,status,sort_order,completed_at")
      .eq("user_id",ownerUserId).eq("plan_id",plan.id).order("sort_order");
    if(itemError)return json({error:itemError.message},400);
    return json({plan,items:items??[],preferences:preferences??null,metrics:visibleMetrics,read_only:readOnly,access_source:accessSource});
  }

  if(session.error||!session.client||!session.user)return json({error:session.error},401);
  const db=session.client;
  const user=session.user;

  if(req.method==="POST"){
    const body=await req.json().catch(()=>null);
    if(!body?.date||!Array.isArray(body?.items))return json({error:"date and items required"},400);

    const {data:currentPlan,error:lookupError}=await db.from("daily_plans")
      .select("id").eq("user_id",user.id).eq("plan_date",body.date).maybeSingle();
    if(lookupError)return json({error:lookupError.message},400);
    if(currentPlan){
      const {data:existingItems,error:checkError}=await db.from("daily_plan_items")
        .select("status").eq("user_id",user.id).eq("plan_id",currentPlan.id);
      if(checkError)return json({error:checkError.message},400);
      if(existingItems?.some((item:any)=>item.status!=="pending"))
        return json({error:"plan has progress; refusing to reset status"},409);
    }

    const {data:plan,error}=await db.from("daily_plans").upsert({
      user_id:user.id,
      plan_date:body.date,
      title:String(body.title||"今日のプラン"),
      summary:String(body.summary||""),
      generated_by:"chatgpt",
      updated_at:new Date().toISOString()
    },{onConflict:"user_id,plan_date"}).select("id,plan_date,title,summary").single();
    if(error)return json({error:error.message},400);

    const {error:deleteError}=await db.from("daily_plan_items").delete()
      .eq("user_id",user.id).eq("plan_id",plan.id);
    if(deleteError)return json({error:deleteError.message},400);

    if(body.items.length){
      const rows=body.items.map((x:any,i:number)=>({
        plan_id:plan.id,
        user_id:user.id,
        category:String(x.category||"other"),
        title:String(x.title||""),
        detail:String(x.detail||""),
        status:"pending",
        memo:"",
        sort_order:Number.isFinite(Number(x.sort_order))?Number(x.sort_order):i
      }));
      const {error:insertError}=await db.from("daily_plan_items").insert(rows);
      if(insertError)return json({error:insertError.message},400);
    }
    return json({ok:true,plan_id:plan.id},201);
  }

  if(req.method==="PATCH"){
    const body=await req.json().catch(()=>null);
    const status=body?.status;
    if(!body?.item_id)return json({error:"item_id required"},400);
    if(status!==undefined && !["pending","done","skipped"].includes(status)){
      return json({error:"invalid status"},400);
    }
    const patch:any={updated_at:new Date().toISOString()};
    if(status!==undefined){
      patch.status=status;
      patch.completed_at=status==="done"?new Date().toISOString():null;
    }
    if(body.memo!==undefined)patch.memo=String(body.memo??"");
    const {data,error}=await db.from("daily_plan_items").update(patch)
      .eq("id",body.item_id).eq("user_id",user.id)
      .select("id,status,memo,completed_at").single();
    if(error)return json({error:error.message},400);
    return json({ok:true,item:data});
  }

  return json({error:"method not allowed"},405);
});