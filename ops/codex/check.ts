import { strict as assert } from "node:assert";
const base = "http://127.0.0.1:3102", checks: Record<string, boolean> = {}, timings: Record<string, number> = {};
let token = ""; const sockets: WebSocket[] = [];
async function http(method: string, path: string, body?: unknown, expected = 200, admin = true, cookie?: string) {
  const response = await fetch(base + path, { method, headers: { origin: base, "content-type": "application/json",
    ...(admin && token ? { authorization: `Bearer ${token}` } : {}), ...(cookie ? { cookie } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  assert.equal(response.status, expected, `${method} ${path}: ${response.status}`);
  return { response, data: response.status === 204 ? null : await response.json() as any };
}
async function user(name: string) {
  const result = await http("POST", "/api/client/auth/register", { name, email: `${name}@codex.example.test`, password: "Codex-Fixture-2026!" }, 201, false);
  return result.response.headers.get("set-cookie")!.split(';')[0]!;
}
async function connect(cookie: string) {
  const socket = new WebSocket(base.replace('http','ws') + '/api/client/chat/ws', { headers: { origin: base, cookie } }); sockets.push(socket);
  const packets: any[] = []; socket.onmessage = event => packets.push(JSON.parse(String(event.data))); socket.onerror = () => {};
  async function until(fn: () => any, timeout = 12_000): Promise<any> {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const result = fn(); if (result) return result; await Bun.sleep(10); }
    throw new Error("WebSocket event timeout");
  }
  await until(() => packets.some(packet => packet.type === 'connected'));
  async function rpc(command: string, data: unknown = {}, expected = 200): Promise<any> {
    const id = crypto.randomUUID(); socket.send(JSON.stringify({v:1,type:'event',event:'chat.command',id,data:{command,data}}));
    const result = await until(() => packets.find(packet => packet.id === id));
    assert.equal(result.type, 'ack');
    if (expected !== 200) { assert.equal(result.data?.error?.status, expected); return result.data; }
    assert.equal(result.data.ok, true, JSON.stringify(result.data)); return result.data.data;
  }
  return { socket, packets, until, rpc, turn: (id: string) => until(() => packets.find(packet => packet.event==='chat.turn' && packet.data.id===id && packet.data.status!=='pending')?.data),
    text: (id: string) => until(() => packets.find(packet => packet.event==='chat.text' && packet.data.requestId===id)?.data.text) };
}
try {
  for (const [method,path] of [['GET','status'],['GET','models'],['POST','login'],['POST','login/cancel'],['POST','logout']]) await http(method!, '/api/admin/codex/'+path, method==='POST'?{}:undefined, 401, false);
  token = (await http('POST','/api/admin/auth/bootstrap',{name:'Codex checker',email:'admin@codex.example.test',password:'Codex-Fixture-Admin-2026!'})).data.accessToken;
  assert(token);
  const status = await http('GET','/api/admin/codex/status');
  assert.equal(status.data.connected,true); assert.equal(status.response.headers.get('cache-control'),'no-store');
  assert(!JSON.stringify(status.data).includes('CODEX_HOME')); assert(!JSON.stringify(status.data).includes('token'));
  assert.equal((await http('GET','/api/admin/codex/models')).data.items[0].id,'fixture-model');
  await http('POST','/api/admin/codex/login',{method:'apiKey',apiKey:'forbidden'},400);
  checks.admin_auth_no_secret_and_validation = true;
  const surface = (await http('GET','/api/ui/admin')).data;
  assert(surface.spec.resources.some((item: any) => item.id==='agents'));
  assert(surface.spec.customPages.some((item: any) => item.id==='codex'));
  assert(JSON.stringify(surface).includes('agent-model'));
  const agent = (await http('POST','/api/agents',{id:'chatgpt-check',name:'ChatGPT check',instructions:'Fixture instructions',modelProfile:'codex.fixture-model',enabled:true,toolNames:[]},201)).data;
  assert.equal((await http('GET','/api/agents/chatgpt-check')).data.modelProfile,agent.modelProfile);
  checks.agent_assignment_and_admin_surface = true;
  const cookie = await user('alice'), otherCookie = await user('bob');
  await http('GET','/api/admin/codex/status',undefined,401,false,cookie);
  const a = await connect(cookie), b = await connect(otherCookie);
  const options = await a.rpc('agents.models',{agentId:agent.id});
  assert.equal(options.provider,'codex'); assert.equal(options.defaultModel,'fixture-model');
  assert.equal(options.models[1].defaultReasoningEffort,'low');
  assert.deepEqual(options.models[1].supportedReasoningEfforts.map((item: any)=>item.reasoningEffort),['low','high']);
  assert(!JSON.stringify(options).includes('fixture@example.test'));
  assert.deepEqual((await http('GET',`/api/client/chat/agents/${agent.id}/models`,undefined,200,false,cookie)).data,options);
  await http('GET',`/api/client/chat/agents/${agent.id}/models`,undefined,401,false);
  assert.equal((await a.rpc('agents.models',{agentId:'main'})).provider,'runtime');
  const localId=(await a.rpc('conversations.create',{agentId:'main'})).id;
  await a.rpc('message.send',{conversationId:localId,requestId:crypto.randomUUID(),text:'not-sent',model:'fixture-model'},400);
  checks.model_catalog_auth_and_provider_boundary = true;
  const conversationId = (await a.rpc('conversations.create',{agentId:agent.id})).id;
  await b.rpc('conversation.get',{conversationId},404);
  for(const value of [null,123,{},'','bad value']) {
    await a.rpc('message.send',{conversationId,requestId:crypto.randomUUID(),text:'not-sent',reasoningEffort:value},400);
  }
  const id = crypto.randomUUID(), started = Date.now();
  const selected = {conversationId,requestId:id,text:'normal',model:'fixture-fast',reasoningEffort:'high'};
  assert.equal((await a.rpc('message.send',selected)).status,'pending');
  assert((await a.text(id)).length>0); timings.first_text_ms=Date.now()-started;
  const completed = await a.turn(id); timings.completed_ms=Date.now()-started;
  assert.equal(completed.status,'completed'); assert.equal(completed.assistantText,'Ответ: normal');
  assert.equal(completed.model,'fixture-fast'); assert.equal(completed.reasoningEffort,'high');
  assert(timings.completed_ms > timings.first_text_ms);
  assert.equal((await a.rpc('conversation.get',{conversationId})).turns[0].assistantText,completed.assistantText);
  assert(!b.packets.some(packet => packet.event==='chat.text'));
  checks.stream_persistence_and_owner_isolation = true;
  assert.equal((await a.rpc('message.send',selected)).status,'completed');
  await a.rpc('message.send',{...selected,model:'fixture-model'},409);
  await a.rpc('message.send',{...selected,reasoningEffort:'low'},409);
  assert.equal((await a.rpc('conversation.get',{conversationId})).turns[0].reasoningEffort,'high');
  const c = await connect(cookie);
  assert.equal((await c.rpc('message.send',selected)).status,'completed'); c.socket.close();
  for (const settings of [{model:'missing-model'}, {model:'fixture-fast',reasoningEffort:'xhigh'}]) {
    const requestId=crypto.randomUUID();
    await a.rpc('message.send',{conversationId,requestId,text:'not-sent',...settings});
    const failed=await a.turn(requestId); assert.equal(failed.status,'failed'); assert.equal(failed.assistantText,'');
    assert(failed.error.includes('недоступ'));
  }
  checks.model_choice_persistence_validation_and_retry = true;
  const cancelId = crypto.randomUUID();
  await a.rpc('message.send',{conversationId,requestId:cancelId,text:'slow-cancel'});
  const partial = await a.text(cancelId);
  await http('POST','/api/admin/codex/logout',{},409);
  const cancelled = await a.rpc('message.cancel',{conversationId,requestId:cancelId});
  assert.equal(cancelled.status,'cancelled'); assert(cancelled.assistantText.startsWith(partial));
  assert.equal((await a.rpc('message.send',{conversationId,requestId:cancelId,text:'slow-cancel'})).status,'cancelled');
  checks.cancellation_partial_and_deduplication = true;
  const failId=crypto.randomUUID(); await a.rpc('message.send',{conversationId,requestId:failId,text:'failure'});
  const failed=await a.turn(failId); assert.equal(failed.status,'failed'); assert(failed.assistantText.length>0);
  assert.equal((await a.rpc('conversation.get',{conversationId})).turns.find((turn: any)=>turn.id===failId).assistantText,failed.assistantText);
  checks.failed_generation_preserves_partial = true;
  // Wait for server-side cleanup after the independently committed cancellation.
  for(let i=0;i<100;i++) { if(!(await http('GET','/api/admin/codex/status')).data.activeRuns) break; await Bun.sleep(20); }
  assert.equal((await http('POST','/api/admin/codex/logout',{})).data.connected,false);
  const unavailable=await a.rpc('agents.models',{agentId:agent.id});
  assert.deepEqual(unavailable.models,[]); assert(unavailable.error.includes('аккаунт ChatGPT'));
  const noAuthId=crypto.randomUUID(); await a.rpc('message.send',{conversationId,requestId:noAuthId,text:'not-sent'});
  const noAuth=await a.turn(noAuthId); assert.equal(noAuth.status,'failed'); assert.equal(noAuth.assistantText,''); assert(noAuth.error.includes('аккаунт ChatGPT'));
  checks.shared_logout_blocks_generation = true;
  console.log(JSON.stringify({status:'PASS',checks,timings}));
} finally { for (const socket of sockets) socket.close(); }
