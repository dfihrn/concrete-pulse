import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BlobPreconditionFailedError } from '@vercel/blob';
import { createBlobStore } from './blob-storage.js';
import { createFileGenerationStore } from './file-generation-store.js';
import { GenerationConflict } from './generation-store.js';
import { makeGeneration } from './generation.js';
import { createVercelHandlers } from './vercel-pulse.js';
const secret='test-secret-at-least-16-characters';
const snapshot=(tvl=100)=>({timestamp:'2026-09-11T00:00:00Z',vaults:{1:{['0x'+'a'.repeat(40)]:{name:'Vault',tvl,apy:-1,totalDepositors:10}}}});
function mockBlob(){let body=null,etag=null,version=0;const calls=[];return {calls,sdk:{async get(p,o){calls.push(['get',p,o]);return body===null?null:{statusCode:200,stream:new Response(body).body,blob:{etag}};},async put(p,b,o){calls.push(['put',p,o]);if((body!==null&&!o.allowOverwrite)||(o.ifMatch&&o.ifMatch!==etag))throw new BlobPreconditionFailedError();body=b;etag=String(++version);return {etag};}},raw:()=>body};}
function response(){return {statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.statusCode=n;return this;},json(b){this.body=b;return this;}};}
async function invoke(fn,authorization=`Bearer ${secret}`,method='GET'){const r=response();await fn({method,headers:{authorization}},r);return r;}
function fixture(options={}){const mock=mockBlob();const store=createBlobStore({token:'test',sdk:mock.sdk});let calls=0;const handlers=createVercelHandlers({storeFactory:()=>store,secret,fetchCurrentSnapshot:async()=>{calls++;return snapshot();},...options});return {mock,store,handlers,calls:()=>calls};}

test('Blob uses private origin reads and conditional full-generation writes',async()=>{const {mock,store}=fixture();assert.deepEqual(await store.load(),{generation:null,revision:null});const first=makeGeneration(null,snapshot());await store.commit(first,null);const before=await store.load();assert.equal(before.revision,'1');assert.equal(before.generation.current.vaults[1]['0x'+'a'.repeat(40)].apy,-1);await store.commit(makeGeneration(first.current,snapshot(200)),before.revision);const writes=mock.calls.filter(c=>c[0]==='put');assert.equal(writes[0][2].allowOverwrite,false);assert.equal(writes[1][2].ifMatch,'1');for(const c of mock.calls){assert.equal(c[2].access,'private');if(c[0]==='get')assert.equal(c[2].useCache,false);}});
test('collector success and repeated public reads do not fetch or write',async()=>{const f=fixture();assert.equal((await invoke(f.handlers.collect)).statusCode,200);const raw=f.mock.raw();for(let i=0;i<5;i++){const r=await invoke(f.handlers.pulse,undefined);assert.equal(r.statusCode,200);assert.equal(r.body.summary.totalVaults,1);}assert.equal(f.calls(),1);assert.equal(f.mock.raw(),raw);assert.equal((await invoke(f.handlers.health)).body.collectionMode,'external');});
test('unauthenticated, missing-secret and non-GET collection never access storage',async()=>{const f=fixture();for(const auth of ['', 'Bearer wrong'])assert.equal((await invoke(f.handlers.collect,auth)).statusCode,401);assert.equal((await invoke(f.handlers.collect,`Bearer ${secret}`,'POST')).statusCode,405);const h=createVercelHandlers({secret:'',storeFactory:()=>{throw Error('must not access');}});assert.equal((await invoke(h.collect)).statusCode,401);assert.equal(f.calls(),0);assert.equal(f.mock.calls.length,0);});
test('cold start is controlled 503 and health reports not ready',async()=>{const f=fixture();const r=await invoke(f.handlers.pulse);assert.equal(r.statusCode,503);assert.equal(r.body.freshness.ready,false);assert.equal((await invoke(f.handlers.health)).body.ready,false);assert.equal(f.calls(),0);});
test('upstream failure preserves durable last success across new function instances',async()=>{const f=fixture();await f.store.commit(makeGeneration(null,snapshot(),'2026-09-11T00:00:00Z'),null);const raw=f.mock.raw();const h=createVercelHandlers({secret,storeFactory:()=>f.store,now:()=>Date.parse('2026-09-11T00:10:00Z'),fetchCurrentSnapshot:async()=>{throw Error('private stack');}});assert.equal((await invoke(h.collect)).statusCode,503);const r=await invoke(h.pulse);assert.equal(r.statusCode,200);assert.equal(r.body.freshness.stale,true);assert.equal(r.body.timestamp,'2026-09-11T00:00:00Z');assert.equal(f.mock.raw(),raw);});
test('two cold-start invocations create only one generation',async()=>{const f=fixture();let release,entered=0;const gate=new Promise(r=>release=r);const h=createVercelHandlers({secret,storeFactory:()=>f.store,fetchCurrentSnapshot:async()=>{entered++;if(entered===2)release();await gate;return snapshot();}});const results=await Promise.all([invoke(h.collect),invoke(h.collect)]);assert.equal(results.filter(r=>r.body.status==='collected').length,1);assert.equal(results.filter(r=>r.body.reason==='concurrent-collection').length,1);assert.equal((await f.store.load()).revision,'1');});
test('two update invocations cannot overwrite each other or rebase losing data',async()=>{const f=fixture();await f.store.commit(makeGeneration(null,snapshot(),'2026-09-11T00:00:00Z'),null);let release,entered=0;const gate=new Promise(r=>release=r);const h=createVercelHandlers({secret,storeFactory:()=>f.store,fetchCurrentSnapshot:async()=>{entered++;if(entered===2)release();await gate;return snapshot(200);}});const results=await Promise.all([invoke(h.collect),invoke(h.collect)]);assert.equal(results.filter(r=>r.body.status==='collected').length,1);const saved=await f.store.load();assert.equal(saved.revision,'2');assert.equal(saved.generation.result.tvlChanges[0].change,100);});
test('duplicate delivery within cooldown does not fetch',async()=>{const f=fixture();await invoke(f.handlers.collect);const r=await invoke(f.handlers.collect);assert.equal(r.body.reason,'recent-collection');assert.equal(f.calls(),1);});
test('Blob failure and malformed state return generic errors without resetting baseline',async()=>{for(const sdk of [{get:async()=>{throw Error('token secret');}},{get:async()=>({statusCode:200,blob:{etag:'1'},stream:new Response('broken').body})}]){const store=createBlobStore({token:'test',sdk});let fetched=false;const h=createVercelHandlers({secret,storeFactory:()=>store,fetchCurrentSnapshot:async()=>{fetched=true;}});const r=await invoke(h.collect);assert.equal(r.statusCode,503);assert.equal(fetched,false);assert.ok(!JSON.stringify(r.body).includes('token'));assert.equal((await invoke(h.pulse)).statusCode,503);}});
test('failed Blob put leaves the old generation readable',async()=>{const f=fixture();await f.store.commit(makeGeneration(null,snapshot()),null);const before=await f.store.load();const broken=createBlobStore({token:'test',sdk:{get:f.mock.sdk.get,put:async()=>{throw Error('unavailable');}}});await assert.rejects(broken.commit(makeGeneration(before.generation.current,snapshot(200)),before.revision));assert.deepEqual((await f.store.load()).generation,before.generation);});
test('filesystem implements the same revisioned adapter contract',async t=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'pulse-adapter-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));const store=createFileGenerationStore(d);const first=await store.load();await store.commit(makeGeneration(null,snapshot()),first.revision);await assert.rejects(store.commit(makeGeneration(null,snapshot(200)),first.revision),GenerationConflict);assert.equal((await store.load()).generation.result.summary.totalVaults,1);});
test('frontend stays read-only and GitHub Actions schedules the protected collector',()=>{
 const app=fs.readFileSync('public/app.js','utf8');
 assert.ok(app.includes('fetch("/api/pulse"'));
 assert.ok(!app.includes('/api/collect'));

 const config=JSON.parse(fs.readFileSync('vercel.json'));
 assert.equal(config.outputDirectory,'public');
 assert.ok(!Object.hasOwn(config,'crons'));

 const workflow=fs.readFileSync('.github/workflows/pulse-collector.yml','utf8');
 assert.match(workflow,/cron: ["']2,7,12,17,22,27,32,37,42,47,52,57 \* \* \* \*["']/);
 assert.match(workflow,/workflow_dispatch:/);
 assert.match(workflow,/secrets\.PULSE_BASE_URL/);
 assert.match(workflow,/secrets\.CRON_SECRET/);
 assert.match(workflow,/Authorization: Bearer \$\{CRON_SECRET\}/);
 assert.match(workflow,/\$\{base_url\}\/api\/collect/);
 assert.match(workflow,/--fail-with-body/);
 assert.match(workflow,/--max-time 50/);
 assert.doesNotMatch(workflow,/set\s+-x/);
 assert.ok(!/https?:\/\//.test(workflow));
});

test('exclusive create handles a generic conflict without overwriting the winner',async()=>{
 const f=fixture();await f.store.commit(makeGeneration(null,snapshot()),null);
 const store=createBlobStore({token:'test',sdk:{get:f.mock.sdk.get,put:async()=>{throw Error('already exists');}}});
 await assert.rejects(store.commit(makeGeneration(null,snapshot(200)),null),GenerationConflict);
 assert.equal((await f.store.load()).generation.current.vaults[1]['0x'+'a'.repeat(40)].tvl,100);
});
