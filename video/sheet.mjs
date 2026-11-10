// Contact sheet: the scene at a list of sim times, for eyeballing the art.
import { chromium } from 'playwright-core';
import { serve, CHROME } from './serve.mjs';
const times = (process.argv[2] || '0.5,3,6,9,12,14.5,17,20,22.5,24,25.5,27,29').split(',').map(Number);
const { server, url } = await serve(new URL('..', import.meta.url).pathname);
const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1040, height: 20 + times.length * 270 } });
page.on('console', (m) => console.log('[page]', m.text()));
page.on('pageerror', (e) => console.log('[error]', e.message));
await page.goto(url + '/video/none');
await page.setContent(`<body style="margin:0;background:#0c0e16;color:#fff;font:14px monospace"><div id=o></div>
<script type=module>
import {LoadBearing} from '${url}/loadbearing.js';
const times=${JSON.stringify(times)};
const c=document.createElement('canvas');const L=new LoadBearing(c,{demo:true,loop:false,autoplay:false});
let t=0;const log=[];
for(const T of times){while(t<T){L.step(1/60);t+=1/60; if(Math.abs(t-4)<.009)L.tap(L.crew[0].x,36); if(Math.abs(t-5.8)<.009)L.tap(150,58); if(Math.abs(t-8.8)<.009)L.tap(L.bal.x,12);}
 L.draw();const k=document.createElement('canvas');k.width=1024;k.height=256;const g=k.getContext('2d');g.imageSmoothingEnabled=false;g.drawImage(c,0,0,1024,256);
 const d=document.createElement('div');d.textContent='t='+T+' '+L.percent+'% stalled='+L.stalled+' mult='+L.mult.toFixed(2)+' finale='+JSON.stringify(L.finale&&L.finale.phase);o.append(d,k);}
const ev={};for(const e of L.events)ev[e.type]=(ev[e.type]||0)+1;console.log(JSON.stringify(ev));
const first=(n)=>L.events.find(e=>e.type===n)?.t.toFixed(2);console.log('stall',first('stall'),'resume',first('resume'),'done',first('done'),'whistle',first('whistle'),'arrived',first('arrived'));
window.ok=1;
</script>`);
await page.waitForFunction('window.ok', null, { timeout: 20000 });
await page.screenshot({ path: process.argv[3] || '/tmp/lb-sheet.png' });
await browser.close(); server.close();
