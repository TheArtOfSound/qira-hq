
/* Phase 2: durable, project-scoped collaboration API. Authentication derives actor from bearer credential. */
const C_P={project_id:field("Project ID from list_projects")};
const C_S=(v)=>({type:"string",description:v});
const C_TOOLS=[
{name:"get_project_context",description:"Obtain a concise shared project context: active tasks, planning notes, threads, recent messages and this agent's inbox. Use when starting a work session.",inputSchema:schema(C_P,["project_id"])},
{name:"list_collab_threads",description:"List ongoing human/AI collaboration threads",inputSchema:schema(C_P,["project_id"])},
{name:"create_collab_thread",description:"Start a persisted multi-agent discussion, planning, review or decision thread",inputSchema:schema({...C_P,title:C_S("Title"),kind:{type:"string",enum:["discussion","planning","review","decision"]}},["project_id","title"])},
{name:"read_collab_thread",description:"Read recent posts from a thread; use after_seq to incrementally synchronize",inputSchema:schema({...C_P,thread_id:C_S("Thread UUID"),after_seq:{type:"integer",minimum:0}},["project_id","thread_id"])},
{name:"post_collab_reply",description:"Send a real persistent reply visible to other agents; optionally address an agent (to_actor), creating its inbox notification",inputSchema:schema({...C_P,thread_id:C_S("Thread UUID"),body:C_S("Reply content"),to_actor:C_S("Recipient actor handle"),client_id:C_S("Unique idempotency key")},["project_id","thread_id","body"])},
{name:"get_agent_inbox",description:"Read messages addressed to the current authenticated agent. Inbox is not pushed into a dormant ChatGPT session.",inputSchema:schema(C_P,["project_id"])},
{name:"send_agent_message",description:"Send asynchronous addressed work request to another agent handle. Recipient processes it on its next run/poll.",inputSchema:schema({...C_P,recipient:C_S("Exact collaborator handle"),subject:C_S("Subject"),body:C_S("Message or request"),thread_id:C_S("Related discussion thread UUID"),client_id:C_S("Unique idempotency key")},["project_id","recipient","subject","body"])},
{name:"ack_agent_message",description:"Mark an addressed agent message as acknowledged after processing",inputSchema:schema({...C_P,message_id:C_S("Inbox message UUID")},["project_id","message_id"])},
{name:"list_shared_notes",description:"List shared notes, plans, decisions and handoffs with versions",inputSchema:schema(C_P,["project_id"])},
{name:"create_shared_note",description:"Add a durable shared note, work plan, decision or handoff",inputSchema:schema({...C_P,title:C_S("Title"),body:C_S("Content"),kind:{type:"string",enum:["note","plan","decision","handoff"]}},["project_id","title","body"])},
{name:"update_shared_note",description:"Edit note with expected version to detect concurrent agent changes",inputSchema:schema({...C_P,note_id:C_S("Note UUID"),version:{type:"integer",minimum:1},title:C_S("Updated title"),body:C_S("Updated content"),state:{type:"string",enum:["draft","proposed","accepted","superseded"]}},["project_id","note_id","version"])},
{name:"list_collaborators",description:"List distinct project-scoped actor names and roles; no private credentials are returned",inputSchema:schema(C_P,["project_id"])},
{name:"list_project_integrations",description:"List explicitly linked external sources with setup status",inputSchema:schema(C_P,["project_id"])},
{name:"link_github_repository",description:"Register a GitHub repository as shared project context; registry alone does not grant GitHub access or webhooks",inputSchema:schema({...C_P,repository:C_S("GitHub owner/repo")},["project_id","repository"])}
];
async function collabAPI(req,env,a,u){
 const ps=u.pathname.split("/").filter(Boolean);
 if(ps[0]!=="api"||ps[1]!=="projects"||ps[3]!=="collab")return null;
 if(!a)return bad("Bearer token required",401);
 const p=ps[2],section=ps[4],item=ps[5],tail=ps[6],m=req.method,write=m!=="GET";
 if(!p||!permitted(a,p,write))return bad("Not authorized for this project",403);
 const proj=await env.DB.prepare("SELECT id,name,description FROM projects WHERE id=?").bind(p).first();
 if(!proj)return bad("Project not found",404);
 const db=env.DB;
 const q=async(sql,...bind)=>await db.prepare(sql).bind(...bind).all();
 const one=async(sql,...bind)=>await db.prepare(sql).bind(...bind).first();
 const run=async(sql,...bind)=>await db.prepare(sql).bind(...bind).run();
 const list=(r)=>r.results||[];
 const record=(name,id)=>event(env,p,a.actor,name,id);
 const parsed=async()=>{const b=await parse(req);if(!b||typeof b!=="object"||Array.isArray(b))throw Error("Invalid JSON");return b;};
 const pick=(v,allowed,defaultValue)=>v===undefined?defaultValue:allowed.includes(v)?v:null;
 const validId=(v)=>typeof v==="string"&&/^[0-9a-fA-F-]{36}$/.test(v);
 if(section==="context"&&m==="GET"){
  const [threads,notes,tasks,msgs,inbox]=await Promise.all([
    q("SELECT id,title,kind,state,updated_at FROM collab_threads WHERE project_id=? AND state='open' ORDER BY updated_at DESC LIMIT 15",p),
    q("SELECT id,title,kind,state,version,body,updated_at FROM collab_notes WHERE project_id=? ORDER BY updated_at DESC LIMIT 12",p),
    q("SELECT id,title,status,assignee,version,updated_at FROM tasks WHERE project_id=? AND status!='done' ORDER BY updated_at DESC LIMIT 30",p),
    q("SELECT id,thread_id,actor,body,to_actor,created_at FROM collab_posts WHERE project_id=? ORDER BY rowid DESC LIMIT 25",p),
    q("SELECT id,sender,subject,body,thread_id,created_at FROM collab_inbox WHERE project_id=? AND recipient=? AND status='unread' ORDER BY created_at ASC LIMIT 50",p,a.actor)
  ]);
  return json({project:proj,identity:{actor:a.actor,role:a.role},threads:list(threads),notes:list(notes),tasks:list(tasks),recent_posts:list(msgs).reverse(),my_unread_inbox:list(inbox)});
 }
 if(section==="members"&&m==="GET"){
  const r=await q("SELECT actor,role,created_at FROM tokens WHERE project_id=? AND revoked_at IS NULL ORDER BY created_at ASC LIMIT 100",p);
  return json({members:[{actor:"owner",role:"admin"},...list(r)]});
 }
 if(section==="threads"){
  if(!item){
   if(m==="GET"){const r=await q("SELECT * FROM collab_threads WHERE project_id=? ORDER BY updated_at DESC LIMIT 100",p);return json({threads:list(r)});}
   if(m==="POST"){const b=await parsed(),title=clean(b.title,180),kind=pick(b.kind,["discussion","planning","review","decision"],"discussion");if(!kind)return bad("Invalid kind");const uid=id(),t=now();
    await run("INSERT INTO collab_threads(id,project_id,title,kind,state,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",uid,p,title,kind,"open",a.actor,t,t);await record("thread.created",uid);return json({thread:{id:uid,title,kind,state:"open",created_by:a.actor,created_at:t}},201);}
  }
  if(validId(item)){
   const thread=await one("SELECT id,title,kind,state FROM collab_threads WHERE id=? AND project_id=?",item,p);
   if(!thread)return bad("Thread not found",404);
   if(tail==="posts"){
    if(m==="GET"){const seq=Number(u.searchParams.get("after_seq")||"0");if(!Number.isSafeInteger(seq)||seq<0)return bad("Invalid after_seq");const r=await q("SELECT rowid AS seq,* FROM collab_posts WHERE project_id=? AND thread_id=? AND rowid>? ORDER BY rowid ASC LIMIT 100",p,item,seq);return json({thread,posts:list(r),next_seq:list(r).at(-1)?.seq??seq});}
    if(m==="POST"){const b=await parsed(),body=clean(b.body,8000),to=b.to_actor?clean(b.to_actor,64):null,client=b.client_id?clean(b.client_id,100):null;if(client){const prior=await one("SELECT * FROM collab_posts WHERE project_id=? AND actor=? AND client_id=?",p,a.actor,client);if(prior)return json({post:prior,duplicate:true});}
    const uid=id(),t=now();
    await run("INSERT INTO collab_posts(id,project_id,thread_id,actor,body,to_actor,reply_to,client_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)",uid,p,item,a.actor,body,to,null,client,t);
    if(to&&to!==a.actor){await run("INSERT INTO collab_inbox(id,project_id,recipient,sender,subject,body,thread_id,status,created_at) VALUES(?,?,?,?,?,?,?,'unread',?)",id(),p,to,a.actor,"Reply in "+thread.title,body,item,t);}
    await run("UPDATE collab_threads SET updated_at=? WHERE id=? AND project_id=?",t,item,p);await record("thread.replied",uid);
    return json({post:{id:uid,thread_id:item,actor:a.actor,body,to_actor:to,created_at:t}},201);}
   }
   if(m==="PATCH"&&!tail){const b=await parsed();if(!["open","resolved"].includes(b.state))return bad("Invalid state");await run("UPDATE collab_threads SET state=?,updated_at=? WHERE id=? AND project_id=?",b.state,now(),item,p);await record("thread.state",item);return json({thread_id:item,state:b.state});}
  }
 }
 if(section==="notes"){
  if(!item){
   if(m==="GET"){const r=await q("SELECT * FROM collab_notes WHERE project_id=? ORDER BY updated_at DESC LIMIT 100",p);return json({notes:list(r)});}
   if(m==="POST"){const b=await parsed(),title=clean(b.title,200),body=clean(b.body,30000),kind=pick(b.kind,["note","plan","decision","handoff"],"note"),state=pick(b.state,["draft","proposed","accepted","superseded"],"draft");if(!kind||!state)return bad("Invalid kind/state");const uid=id(),t=now();
    await run("INSERT INTO collab_notes(id,project_id,title,body,kind,state,version,author,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?,?)",uid,p,title,body,kind,state,a.actor,t,t);await record("note.created",uid);return json({note:{id:uid,title,body,kind,state,version:1,author:a.actor}},201);}
  }
  if(validId(item)&&m==="PATCH"){const b=await parsed(),old=await one("SELECT * FROM collab_notes WHERE id=? AND project_id=?",item,p);if(!old)return bad("Note not found",404);if(!Number.isInteger(b.version)||b.version!==old.version)return bad("Version conflict: fetch latest note and retry",409);
   const title=b.title===undefined?old.title:clean(b.title,200),body=b.body===undefined?old.body:clean(b.body,30000),state=pick(b.state,["draft","proposed","accepted","superseded"],old.state);
   if(!state)return bad("Invalid state");const r=await run("UPDATE collab_notes SET title=?,body=?,state=?,version=version+1,updated_at=? WHERE id=? AND project_id=? AND version=?",title,body,state,now(),item,p,b.version);if(!r.meta.changes)return bad("Concurrent modification",409);await record("note.updated",item);return json({note:{id:item,title,body,kind:old.kind,state,version:b.version+1,author:old.author}});}
 }
 if(section==="inbox"){
  if(!item){
   if(m==="GET"){
    const recipient=a.owner&&u.searchParams.has("recipient")?clean(u.searchParams.get("recipient"),64):a.actor;
    const r=await q("SELECT id,sender,recipient,subject,body,thread_id,status,created_at,acknowledged_at FROM collab_inbox WHERE project_id=? AND recipient=? ORDER BY created_at DESC LIMIT 100",p,recipient);
    return json({actor:recipient,messages:list(r)});
   }
   if(m==="POST"){const b=await parsed(),recipient=clean(b.recipient,64),subject=clean(b.subject,160),body=clean(b.body,8000),thread=b.thread_id||null,client=b.client_id?clean(b.client_id,100):null;
    if(client){const prior=await one("SELECT id FROM collab_inbox WHERE project_id=? AND sender=? AND client_id=?",p,a.actor,client);if(prior)return json({message_id:prior.id,duplicate:true});}
    if(thread&&!validId(thread))return bad("Invalid thread_id");
    const member=recipient==="owner"?true:await one("SELECT 1 FROM tokens WHERE project_id=? AND actor=? AND revoked_at IS NULL",p,recipient);
    if(!member)return bad("Recipient has no active project token",404);
    const uid=id(),t=now();await run("INSERT INTO collab_inbox(id,project_id,recipient,sender,subject,body,thread_id,client_id,status,created_at) VALUES(?,?,?,?,?,?,?,?,'unread',?)",uid,p,recipient,a.actor,subject,body,thread,client,t);await record("inbox.sent",uid);return json({message:{id:uid,recipient,sender:a.actor,subject,body,status:"unread"}},201);}
  }
  if(validId(item)&&tail==="ack"&&m==="POST"){const msg=await one("SELECT id,recipient,status FROM collab_inbox WHERE project_id=? AND id=?",p,item);if(!msg)return bad("Message not found",404);
   if(!a.owner&&msg.recipient!==a.actor)return bad("Not your inbox",403);
   await run("UPDATE collab_inbox SET status='acknowledged',acknowledged_at=? WHERE id=? AND project_id=?",now(),item,p);await record("inbox.ack",item);return json({message_id:item,status:"acknowledged"});}
 }
 if(section==="integrations"){
  if(m==="GET"){const r=await q("SELECT * FROM collab_integrations WHERE project_id=? ORDER BY created_at DESC",p);return json({integrations:list(r)});}
  if(m==="POST"){const b=await parsed();if(b.kind!=="github")return bad("Only GitHub repository registry supported",400);const repo=clean(b.repository,140);if(!/^[A-Za-z0-9_.-]{1,80}\/[A-Za-z0-9_.-]{1,80}$/.test(repo))return bad("Expected GitHub owner/repo");const existing=await one("SELECT id,kind,label,reference FROM collab_integrations WHERE project_id=? AND kind='github' AND reference=?",p,repo);if(existing)return json({integration:existing,duplicate:true});
   const uid=id();await run("INSERT INTO collab_integrations(id,project_id,kind,label,reference,created_by,created_at) VALUES(?,?,?,?,?,?,?)",uid,p,"github","GitHub repository",repo,a.actor,now());await record("integration.linked",uid);
   return json({integration:{id:uid,kind:"github",reference:repo,connection:"metadata_only",note:"Link does not grant GitHub API access or automatically register webhooks."}},201);}
 }
 return bad("Unknown collaboration action",404);
}
async function collabMcp(req,env,a,name,args){
 const p=encodeURIComponent(args.project_id||""),base="/api/projects/"+p+"/collab";let url=base,method="GET",body=null;
 const suffix={get_project_context:"context",list_collab_threads:"threads",create_collab_thread:"threads",read_collab_thread:"threads/"+encodeURIComponent(args.thread_id||"")+"/posts",post_collab_reply:"threads/"+encodeURIComponent(args.thread_id||"")+"/posts",get_agent_inbox:"inbox",send_agent_message:"inbox",ack_agent_message:"inbox/"+encodeURIComponent(args.message_id||"")+"/ack",list_shared_notes:"notes",create_shared_note:"notes",update_shared_note:"notes/"+encodeURIComponent(args.note_id||""),list_collaborators:"members",list_project_integrations:"integrations",link_github_repository:"integrations"};
 url+="/"+suffix[name];
 if(["create_collab_thread","post_collab_reply","send_agent_message","ack_agent_message","create_shared_note","link_github_repository"].includes(name)){method="POST";body=args;}
 if(name==="update_shared_note"){method="PATCH";body=args;}
 if(name==="read_collab_thread"&&Number.isSafeInteger(args.after_seq))url+="?after_seq="+args.after_seq;
 const target=new URL(url,req.url);
 try{const fake=new Request(target,{method,headers:{"Authorization":req.headers.get("Authorization")||"","Content-Type":"application/json"},body:body?JSON.stringify(body):undefined});const response=await collabAPI(fake,env,a,target);const data=await response.json();return {content:[{type:"text",text:JSON.stringify(data)}],isError:!response.ok};}
 catch(e){return {content:[{type:"text",text:"Collaboration tool error: "+e.message}],isError:true};}
}
