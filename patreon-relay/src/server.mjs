import {createRelay} from './relay.mjs';
import {DailyBudget} from './budget.mjs';

const origin=new URL(process.env.PUBLIC_ORIGIN || 'https://not-configured.invalid');
const sitekey=process.env.TURNSTILE_SITE_KEY || '';
const secret=process.env.TURNSTILE_SECRET_KEY || '';
const accessSecret=process.env.PATREON_RELAY_ACCESS_SECRET || '';
if(origin.protocol!=='https:' || origin.hostname.endsWith('.invalid') || origin.port || origin.pathname!=='/' || origin.username || origin.password || origin.search || origin.hash)
  throw Error('A public HTTPS origin is required');
if(!/^[0-9a-zA-Z_-]{20,100}$/.test(sitekey) || !/^[0-9a-zA-Z_-]{20,100}$/.test(secret) || /^[123]x0{10}/.test(sitekey) || accessSecret.length<32)
  throw Error('Real human verification and access keys are required');
const relay=createRelay({origin:origin.origin,sitekey,secret,accessSecret,trustProxy:true,
  checkout:process.env.ENABLE_CHECKOUT==='true',
  limits:{sessions:20},budget:new DailyBudget('/data/budget.json',512*1024*1024)});
relay.server.listen(8788,'127.0.0.1',()=>console.log('MHTalk Patreon connection ready'));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await relay.close();process.exit(0);});
