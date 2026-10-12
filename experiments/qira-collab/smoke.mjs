// Real Cloudflare smoke tests; no dependencies, no credentials in source.
// Run: set QIRA_COLLAB_ADMIN_TOKEN and QIRA_COLLAB_SMOKE_WRITE=yes, then node smoke.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
const base=(process.env.QIRA_COLLAB_URL||"https://qira-collab-dev.bryanleonard237.workers.dev").replace(/\/$/,"");
const token=process.env.QIRA_COLLAB_ADMIN_TOKEN;
const write=process.env.QIRA_COLLAB_SMOKE_WRITE==="yes";
async function request(path,method="GET",body,auth=token){const res=await fetch(base+path,{method,headers:{...(auth?{Authorization:"Bearer "+auth}:{}),...(body?{"Content-Type":"application/json"}:{})},body:body?JSON.stringify(body):undefined});const content=await res.text();let obj;try{obj=JSON.parse(content);}catch{obj=content.slice(0,300);}return {status:res.status,body:obj};}
const health=await request("/health","GET",null,null);assert.equal(health.status,200,"Public health failed: "+JSON.stringify(health));assert.equal(health.body.ok,true);console.log("PASS health");
const guest=await request("/api/projects","GET",null,null);assert.equal(guest.status,401,"Unauthenticated project read should be denied");console.log("PASS unauthenticated access denied");
if(!token){console.log("SKIP authenticated checks: set QIRA_COLLAB_ADMIN_TOKEN");process.exit(0);}
const projects=await request("/api/projects");assert.equal(projects.status,200,"Admin token rejected (BOOTSTRAP_TOKEN binding missing or token mismatch?)");console.log("PASS admin token recognized");
if(!write){console.log("SKIP write tests: set QIRA_COLLAB_SMOKE_WRITE=yes");process.exit(0);}
const pr=await request("/api/projects","POST",{name:"MCP Two-Agent Smoke "+Date.now()});assert.equal(pr.status,201);const p=pr.body.project.id;
console.log("PASS project created:",p);
const issue=async(actor,role)=>{const r=await request("/api/projects/"+p+"/tokens","POST",{actor,role});assert.equal(r.status,201,"Issuing token failed: "+JSON.stringify(r));return r.body.token;};
const alice=await issue("AgentAlice","editor"),bob=await issue("AgentBob","viewer");
console.log("PASS issued distinct scoped collaborator credentials");
const init=await request("/mcp","POST",{jsonrpc:"2.0",id:1,method:"initialize",params:{}},alice);assert.equal(init.status,200);assert.equal(init.body.result.serverInfo.name,"qira-collab");
const listed=await request("/mcp","POST",{jsonrpc:"2.0",id:2,method:"tools/list"},bob);assert.equal(listed.status,200);assert.ok(listed.body.result.tools.some(t=>t.name==="create_task"));console.log("PASS agent MCP handshake and tool listing");
const task=await request("/api/projects/"+p+"/tasks","POST",{title:"Test collaboration",description:"Verify task state"},alice);assert.equal(task.status,201);
const tid=task.body.task.id;const updated=await request("/api/projects/"+p+"/tasks/"+tid,"PATCH",{version:1,status:"doing"},alice);assert.equal(updated.status,200);
const stale=await request("/api/projects/"+p+"/tasks/"+tid,"PATCH",{version:1,status:"done"},alice);assert.equal(stale.status,409);
console.log("PASS task creation and optimistic concurrency");
const denied=await request("/api/projects/"+p+"/messages","POST",{body:"I should not be able to post"},bob);assert.equal(denied.status,403);
const posted=await request("/mcp","POST",{jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"post_message",arguments:{project_id:p,body:"Alice -> Bob test message"}}},alice);assert.equal(posted.status,200);assert.equal(posted.body.result.isError,false);
const read=await request("/api/projects/"+p+"/messages","GET",null,bob);assert.equal(read.status,200);assert.ok(read.body.messages.some(m=>m.body.includes("Alice -> Bob")));
console.log("PASS editor writes, viewer reads, viewer write blocked");
const different=await request("/api/projects","POST",{name:"MCP Isolation "+Date.now()});assert.equal(different.status,201);const foreign=await request("/api/projects/"+different.body.project.id+"/tasks","GET",null,bob);assert.equal(foreign.status,403);console.log("PASS cross-project isolation");
const hash=createHash("sha256").update(bob).digest("hex");const revoked=await request("/api/projects/"+p+"/tokens/"+hash,"DELETE");assert.equal(revoked.status,200);const after=await request("/api/projects/"+p+"/messages","GET",null,bob);assert.equal(after.status,401);
console.log("PASS token revocation");
console.log("ALL CLOUDFARE LIVE SMOKE TESTS PASSED. Test projects remain for audit.");
