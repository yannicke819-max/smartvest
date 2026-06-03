/**
 * Backtest crypto par bande change_pct (1min) via EODHD .CC (Binance géo-bloqué
 * en sandbox HTTP 451). Valide le seuil overextended crypto. TP+3/SL-1.5, 60min.
 * Conversion NEARUSDT → NEAR-USD.CC. Usage : npx tsx scripts/backtest-crypto-overextended.ts
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env','utf8').split('\n').reduce((a:any,l:string)=>{const m=l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);if(m)a[m[1]]=m[2];return a;},{});
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const KEY=env.EODHD_API_KEY, TP=3,SL=1.5,HORIZON=60;
const cache=new Map<string,any[]>();
function toCC(sym:string):string|null{
  const m=sym.toUpperCase().match(/^([A-Z0-9]+?)(USDT|USDC|USD|BUSD)$/);
  if(m)return m[1]+'-USD.CC';
  const m2=sym.match(/^([A-Z0-9]+)/);return m2?m2[1]+'-USD.CC':null;
}
async function candles(sym:string,from:number,to:number){
  const cc=toCC(sym);if(!cc)return [];
  const k=cc+'::'+Math.floor(from/86400);
  if(cache.has(k))return cache.get(k)!;
  try{const r=await fetch(`https://eodhd.com/api/intraday/${cc}?api_token=${KEY}&interval=5m&from=${from}&to=${to}&fmt=json`);
  if(!r.ok){cache.set(k,[]);return [];}
  const a=(await r.json() as any[]).map(x=>({ts:x.timestamp*1000,high:+x.high,low:+x.low,close:+x.close})).filter(c=>c.close>0);
  cache.set(k,a);return a;}catch{return [];}
}
function outcome(post:any[],entry:number){const tp=entry*(1+TP/100),sl=entry*(1-SL/100);
  for(const c of post){if(c.low<=sl)return 'LOSE';if(c.high>=tp)return 'WIN';}
  const last=post[post.length-1].close;if(last>=entry*1.002)return 'WIN';if(last<=entry*0.998)return 'LOSE';return 'NEUTRAL';}
const BANDS=[[3,8],[8,10],[10,15],[15,25],[25,100]];
(async()=>{
  const rows:any[]=[];
  for(let d=0;d<21;d++){const f=new Date(Date.now()-(d+1)*86400_000).toISOString(),t=new Date(Date.now()-d*86400_000).toISOString();
    const {data}=await sb.from('top_gainers_log').select('symbol,captured_at,close_price,change_pct').in('market',['crypto_major','crypto_alt']).gte('captured_at',f).lt('captured_at',t).limit(500);
    if(data)rows.push(...data);}
  console.log('crypto candidates 21d:',rows.length);
  for(let i=rows.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[rows[i],rows[j]]=[rows[j],rows[i]];}
  const per:any={};const samp:any[]=[];
  for(const r of rows){if(samp.length>=3000)break;const n=per[r.symbol]??0;if(n>=40)continue;per[r.symbol]=n+1;samp.push(r);}
  const bySym:any={};for(const c of samp)(bySym[c.symbol]??=[]).push(c);
  console.log('unique crypto:',Object.keys(bySym).length);
  const stats:any={};for(const b of BANDS)stats[b[0]+'-'+b[1]+'%']={WIN:0,LOSE:0,NEUTRAL:0};
  let proc=0,nodata=0;
  for(const[sym,list]of Object.entries(bySym) as any){
    const ts=list.map((c:any)=>new Date(c.captured_at).getTime());
    const cs=await candles(sym,Math.floor((Math.min(...ts)-86400_000)/1000),Math.floor((Math.max(...ts)+(HORIZON+60)*60_000)/1000));
    if(!cs.length){nodata+=list.length;continue;}
    for(const c of list){const et=new Date(c.captured_at).getTime();const post=cs.filter((x:any)=>x.ts>et&&x.ts<=et+HORIZON*60_000);if(!post.length){nodata++;continue;}
      let bd='';for(const[lo,hi]of BANDS)if(+c.change_pct>=lo&&+c.change_pct<hi)bd=lo+'-'+hi+'%';if(!stats[bd])continue;
      stats[bd][outcome(post,+c.close_price)]++;proc++;}
    await new Promise(r=>setTimeout(r,40));
  }
  console.log('processed:',proc,'nodata:',nodata,'\nbande_1min    n    WR      exp/trade');
  for(const b of BANDS){const k=b[0]+'-'+b[1]+'%';const g=stats[k];const dec=g.WIN+g.LOSE;const wr=dec>0?g.WIN/dec:0;const tot=g.WIN+g.LOSE+g.NEUTRAL;const exp=tot>0?(g.WIN*TP-g.LOSE*SL)/tot:0;
    console.log(k.padEnd(12)+' '+String(tot).padStart(4)+'  '+(wr*100).toFixed(1).padStart(5)+'%  '+(exp>=0?'+':'')+exp.toFixed(3)+'%  ('+g.WIN+'W/'+g.LOSE+'L/'+g.NEUTRAL+'N)');}
})();
