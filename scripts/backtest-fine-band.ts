import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env','utf8').split('\n').reduce((a:any,l:string)=>{const m=l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);if(m)a[m[1]]=m[2];return a;},{});
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const KEY=env.EODHD_API_KEY;
const MARKET=process.argv.find(a=>a.startsWith('--market='))?.slice(9)??'us_equity_small_mid';
const TP=3,SL=1.5,HORIZON=60;
const cache=new Map<string,any[]>();
async function candles(sym:string,from:number,to:number){const k=sym+'::'+Math.floor(from/86400);if(cache.has(k))return cache.get(k)!;
  try{const r=await fetch(`https://eodhd.com/api/intraday/${encodeURIComponent(sym)}?api_token=${KEY}&interval=5m&from=${from}&to=${to}&fmt=json`);
  if(!r.ok){cache.set(k,[]);return [];}const a=(await r.json() as any[]).map(x=>({ts:x.timestamp*1000,high:+x.high,low:+x.low,close:+x.close})).filter(c=>c.close>0);cache.set(k,a);return a;}catch{return [];}}
function outcome(post:any[],entry:number){const tp=entry*(1+TP/100),sl=entry*(1-SL/100);for(const c of post){if(c.low<=sl)return 'LOSE';if(c.high>=tp)return 'WIN';}
  const last=post[post.length-1].close;if(last>=entry*1.002)return 'WIN';if(last<=entry*0.998)return 'LOSE';return 'NEUTRAL';}
const BANDS=[[3,4],[4,5],[5,6],[6,8],[8,10]];  // bande fine pour trancher MIN_CHG
(async()=>{
  const rows:any[]=[];
  for(let d=0;d<28;d++){const f=new Date(Date.now()-(d+1)*86400_000).toISOString(),t=new Date(Date.now()-d*86400_000).toISOString();
    const {data}=await sb.from('top_gainers_log').select('symbol,captured_at,close_price,change_pct').eq('market',MARKET).gte('captured_at',f).lt('captured_at',t).limit(900);
    if(data)rows.push(...data);}
  console.log(MARKET+' candidates 28d:',rows.length,'(bande fine 3-10%)');
  for(let i=rows.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[rows[i],rows[j]]=[rows[j],rows[i]];}
  const per:any={};const samp:any[]=[];
  for(const r of rows){if(samp.length>=5000)break;const n=per[r.symbol]??0;if(n>=30)continue;per[r.symbol]=n+1;samp.push(r);}
  const bySym:any={};for(const c of samp)(bySym[c.symbol]??=[]).push(c);
  const stats:any={};for(const b of BANDS)stats[b[0]+'-'+b[1]+'%']={WIN:0,LOSE:0,NEUTRAL:0};
  let proc=0;
  for(const[sym,list]of Object.entries(bySym) as any){
    const ts=list.map((c:any)=>new Date(c.captured_at).getTime());
    const cs=await candles(sym,Math.floor((Math.min(...ts)-86400_000)/1000),Math.floor((Math.max(...ts)+(HORIZON+60)*60_000)/1000));
    if(!cs.length)continue;
    for(const c of list){const et=new Date(c.captured_at).getTime();const post=cs.filter((x:any)=>x.ts>et&&x.ts<=et+HORIZON*60_000);if(!post.length)continue;
      let bd='';for(const[lo,hi]of BANDS)if(+c.change_pct>=lo&&+c.change_pct<hi)bd=lo+'-'+hi+'%';if(!stats[bd])continue;
      stats[bd][outcome(post,+c.close_price)]++;proc++;}
    await new Promise(r=>setTimeout(r,35));}
  console.log('processed:',proc,'\nbande_fine    n    WR      exp/trade(TP3/SL1.5)');
  for(const b of BANDS){const k=b[0]+'-'+b[1]+'%';const g=stats[k];const dec=g.WIN+g.LOSE;const wr=dec>0?g.WIN/dec:0;const tot=g.WIN+g.LOSE+g.NEUTRAL;const exp=tot>0?(g.WIN*TP-g.LOSE*SL)/tot:0;
    console.log(k.padEnd(12)+' '+String(tot).padStart(4)+'  '+(wr*100).toFixed(1).padStart(5)+'%  '+(exp>=0?'+':'')+exp.toFixed(3)+'%  ('+g.WIN+'W/'+g.LOSE+'L/'+g.NEUTRAL+'N)');}
})();
