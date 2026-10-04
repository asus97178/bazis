"""Verify the real compiled app against an owned disposable PostgreSQL.
Uses a controlled model only for fault/idempotency tests, then real local Ollama.
No production database, model download or external paid API. Optional --browser
waits for browser-result.json before cleanup. Requires an existing Ollama at 11435.
"""
from pathlib import Path
import hashlib
import json
import os
import re
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
import threading
import http.server as http_server
import concurrent.futures

ROOT = Path(__file__).resolve().parents[2]
name = sys.argv[1] if len(sys.argv) > 1 else ""
if not re.fullmatch(r"[a-z0-9-]+", name):
    raise SystemExit("Expected a unique evidence run name")
BASE = ROOT / "docs/audits/client-chat-2026-09-20-evidence" / name
BASE.mkdir(parents=True, exist_ok=False)
env = {k: v for k, v in os.environ.items() if not k.startswith("OSNOVA_") and k not in ("BUN_OPTIONS", "NODE_OPTIONS")}
env["OSNOVA_BUN_BIN"] = os.environ["OSNOVA_BUN_BIN"]
DOCKER = "/usr/local/bin/docker"
IMAGE = "sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73"
run = uuid.uuid4().hex[:12]
label = "osnova.client-chat-test-run=" + run
passwords = [secrets.token_hex(24), secrets.token_hex(24)]
scratch_owner = tempfile.TemporaryDirectory(prefix="osnova-chat-test-")
scratch = Path(scratch_owner.name)
container = None
children = []
logs = []
receipt = {"run": run, "image": IMAGE, "checks": {}, "scope": "Owned disposable PostgreSQL; real compiled application, ORM, HTTP and Vue client."}


def safe(value):
    for secret in passwords:
        value = value.replace(secret, "[REDACTED]")
    return value


def command(args, custom_env=None, cwd=ROOT, timeout=180):
    result = subprocess.run(args, cwd=cwd, env=custom_env or env, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(safe(result.stdout + result.stderr))
    return result.stdout + result.stderr


def pg(database, sql):
    return command([DOCKER, "exec", container, "psql", "-XAt", "-U", "osnova", "-d", database, "-v", "ON_ERROR_STOP=1", "-c", sql]).strip()


def start(args, child_env, cwd, filename):
    log = (BASE / filename).open("a")
    logs.append(log)
    child = subprocess.Popen(args, cwd=cwd, env=child_env, stdout=log, stderr=log, start_new_session=True)
    children.append(child)
    return child


def stop(child):
    if child.poll() is None:
        import signal
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=15)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=5)


def ready(child, url):
    for _ in range(120):
        if child.poll() is not None:
            raise RuntimeError("Preview process exited; inspect its evidence log")
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                if response.status == 200:
                    return
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(.25)
    raise RuntimeError("Preview readiness timed out")



class ModelHandler(http_server.BaseHTTPRequestHandler):
    requests = []
    unblock = threading.Event()
    def log_message(self, *args): pass
    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.requests.append(payload)
        last = next((m['content'] for m in reversed(payload['messages']) if m['role'] == 'user'), '')
        if isinstance(last, list): last = ''.join(x.get('text', '') for x in last)
        if 'SLOW' in last: self.unblock.wait(timeout=30)
        if 'FAIL' in last:
            raw = json.dumps({'error': {'message':'controlled unavailable', 'type':'server_error'}}).encode()
            self.send_response(503)
        else:
            raw = json.dumps({'id':'controlled', 'object':'chat.completion', 'model':'controlled', 'created':1,
                'choices':[{'index':0, 'message':{'role':'assistant','content':'Контрольный ответ: '+last}, 'finish_reason':'stop'}],
                'usage':{'prompt_tokens':10,'completion_tokens':10,'total_tokens':20}}).encode()
            self.send_response(200)
        self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(raw))); self.end_headers()
        try: self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError): pass


def http(method, path, body=None, cookie=None, token=None, status=200, origin=None, timeout=180):
    headers = {'Content-Type':'application/json'}
    if cookie: headers['Cookie'] = cookie
    if token: headers['Authorization'] = 'Bearer '+token
    if origin: headers['Origin'] = origin
    request = urllib.request.Request('http://127.0.0.1:3000'+path, data=None if body is None else json.dumps(body).encode(), headers=headers, method=method)
    try: response = urllib.request.urlopen(request, timeout=timeout)
    except urllib.error.HTTPError as e: response = e
    raw = response.read().decode()
    assert response.status == status, f'{method} {path}: expected {status}, got {response.status}: {safe(raw)[:800]}'
    return (json.loads(raw) if raw else None), response.headers


def call(method, path, body=None, cookie=None, token=None, status=200, origin=None):
    return http(method, path, body, cookie, token, status, origin)[0]


def register(email, name):
    data, headers = http('POST','/api/client/auth/register',{'email':email,'name':name,'password':client_password},status=201)
    raw = headers['Set-Cookie']; cookie = raw.split(';')[0]; passwords.append(cookie)
    assert 'HttpOnly' in raw and 'SameSite=Strict' in raw and 'Path=/api/client' in raw
    assert set(data) == {'id','name','email'}
    return data,cookie


def chat_create(cookie, agent='main'):
    return call('POST','/api/client/chat/conversations',{'agentId':agent},cookie,status=201)


def send(cookie, conversation, text, request_id=None):
    return call('POST',f'/api/client/chat/conversations/{conversation}/messages',{'requestId':request_id or str(uuid.uuid4()),'text':text},cookie)

model_server = None
client_password = 'Local-Client-2026-Password!'
passwords.append(client_password)
try:
    for port in (3000, 4300):
        with socket.socket() as probe: probe.bind(('127.0.0.1',port))
    bun = [str(ROOT/'scripts/osnova-bun'),'--no-env-file']
    (BASE/'toolchain.log').write_text(command([*bun,'run','scripts/bun-toolchain-check.ts','--receipt']))
    receipt['app_sha256']=hashlib.sha256((ROOT/'bin/osnova-app').read_bytes()).hexdigest()
    container = command([DOCKER,'run','-d','--pull=never','--name','osnova-client-chat-'+run,'--label',label,
        '--memory','768m','--cpus','2','--pids-limit','256','--restart=no','--publish','127.0.0.1::5432',
        '--mount','type=tmpfs,destination=/var/lib/postgresql/data,tmpfs-size=536870912',
        '--env','POSTGRES_USER=osnova','--env','POSTGRES_DB=control','--env','POSTGRES_PASSWORD',IMAGE],dict(env,POSTGRES_PASSWORD=passwords[0])).strip()
    inspect=json.loads(command([DOCKER,'inspect',container]))[0]
    assert inspect['Config']['Labels']['osnova.client-chat-test-run']==run
    assert all(mount['Type']=='tmpfs' for mount in inspect['Mounts'])
    for _ in range(120):
        if 'init process complete' in command([DOCKER,'logs',container]):
            try:
                if pg('control','SELECT 1')=='1': break
            except RuntimeError: pass
        time.sleep(.25)
    else: raise RuntimeError('PostgreSQL readiness timed out')
    address=command([DOCKER,'port',container,'5432/tcp']).strip()
    assert re.fullmatch(r'127\.0\.0\.1:\d+',address)
    pg('control',f"CREATE ROLE worker LOGIN NOSUPERUSER PASSWORD '{passwords[1]}'")
    database='client_chat_'+run
    pg('control',f'CREATE DATABASE "{database}" OWNER worker')
    pg(database,'CREATE SCHEMA app AUTHORIZATION worker; CREATE SCHEMA product AUTHORIZATION worker')
    assert pg(database,"SELECT rolsuper FROM pg_roles WHERE rolname='worker'")=='f'
    receipt['postgres_version']=pg(database,'SELECT version()')
    model_server=http_server.ThreadingHTTPServer(('127.0.0.1',0),ModelHandler)
    threading.Thread(target=model_server.serve_forever,daemon=True).start()
    app_env=dict(env,OSNOVA_ENV='development',OSNOVA_HTTP__HOSTNAME='127.0.0.1',OSNOVA_HTTP__PORT='3000',
        OSNOVA_DB__HOST='127.0.0.1',OSNOVA_DB__PORT=address.split(':')[1],OSNOVA_DB__DATABASE=database,
        OSNOVA_DB__USERNAME='worker',OSNOVA_DB__PASSWORD=passwords[1],OSNOVA_DB__TLS='disable',
        OSNOVA_LLM__BASE_URL=f'http://127.0.0.1:{model_server.server_port}/v1')
    app=start([str(ROOT/'bin/osnova-app')],app_env,scratch,'app.log')
    ready(app,'http://127.0.0.1:3000/api/admin/auth/bootstrap')
    admin_login={'email':'admin@chat.example.test','password':client_password}
    token=call('POST','/api/admin/auth/bootstrap',dict(admin_login,name='Chat Admin'))['accessToken'];passwords.append(token)
    call('GET','/api/client/chat/agents',status=401)
    call('POST','/api/client/auth/register',{'name':'Origin','email':'origin@example.test','password':client_password},status=403,origin='https://untrusted.example')
    call('POST','/api/client/auth/register',{'name':'A','email':'invalid','password':'123'},status=400)
    alice, cookie=register('alice@chat.example.test','Александра')
    bob, bob_cookie=register('bob@chat.example.test','Борис')
    assert alice['id']!=bob['id']
    assert call('GET','/api/client/auth/me',cookie=cookie)==alice
    call('POST','/api/client/auth/register',{'name':'Duplicate','email':'ALICE@CHAT.EXAMPLE.TEST','password':client_password},status=409)
    for email in ('alice@chat.example.test','unknown@chat.example.test'):
        call('POST','/api/client/auth/login',{'email':email,'password':'a-wrong-password'},status=401)
    call('GET','/api/agents',cookie=cookie,status=401)
    call('GET','/api/users',cookie=cookie,status=401)
    existing=call('POST','/api/users',{'name':'Existing','email':'existing@chat.example.test'},token=token,status=201)
    call('POST','/api/client/auth/register',{'name':'Existing','email':existing['email'],'password':client_password},status=409)
    assert pg(database,"SELECT count(*) FROM client_credentials WHERE email='existing@chat.example.test'")=='0'
    assert pg(database,"SELECT count(*) FROM client_credentials WHERE email='alice@chat.example.test'")=='1'
    assert pg(database,"SELECT bool_and(\"passwordHash\" LIKE '$argon2id$%') FROM client_credentials")=='t'
    assert pg(database,"SELECT bool_and(length(id)=64) FROM client_sessions")=='t'
    catalog=call('GET','/api/client/chat/agents',cookie=cookie)
    assert any(a['id']=='main' for a in catalog)
    assert all(set(a)=={'id','name','description'} for a in catalog)
    conv=chat_create(cookie)
    conv_id=conv['id']; path=f'/api/client/chat/conversations/{conv_id}'
    call('GET',path,cookie=bob_cookie,status=404)
    call('POST',path+'/messages',{'requestId':str(uuid.uuid4()),'text':'forbidden'},cookie=bob_cookie,status=404)
    call('POST',path+'/messages',{'requestId':'bad','text':''},cookie=cookie,status=400)
    before=len(ModelHandler.requests); request_id=str(uuid.uuid4())
    first=send(cookie,conv_id,'Первое личное сообщение',request_id)
    assert first['status']=='completed', first
    repeat=send(cookie,conv_id,'Первое личное сообщение',request_id)
    assert repeat==first and len(ModelHandler.requests)==before+1
    call('POST',path+'/messages',{'requestId':request_id,'text':'changed'},cookie=cookie,status=409)
    second=send(cookie,conv_id,'Продолжи разговор')
    assert second['status']=='completed'
    context=json.dumps(ModelHandler.requests[-1]['messages'],ensure_ascii=False)
    assert 'Первое личное сообщение' in context and 'Контрольный ответ' in context
    assert call('GET','/api/client/chat/conversations',cookie=bob_cookie)['items']==[]
    failure=send(cookie,conv_id,'FAIL controlled model failure')
    assert failure['status']=='failed' and failure['assistantText']==''
    assert 'controlled unavailable' not in failure['error']
    slow_id=str(uuid.uuid4()); before=len(ModelHandler.requests)
    with concurrent.futures.ThreadPoolExecutor() as pool:
        work=pool.submit(send,cookie,conv_id,'SLOW cancel test',slow_id)
        for _ in range(80):
            if len(ModelHandler.requests)>before: break
            time.sleep(.1)
        else: raise RuntimeError('Controlled model did not receive pending turn')
        again=send(cookie,conv_id,'SLOW cancel test',slow_id)
        assert again['status']=='pending' and len(ModelHandler.requests)==before+1
        call('POST',path+f'/messages/{slow_id}/cancel',cookie=bob_cookie,status=404)
        cancel=call('POST',path+f'/messages/{slow_id}/cancel',{},cookie=cookie)
        assert cancel['status']=='cancelled'
        ModelHandler.unblock.set()
        assert work.result(timeout=15)['status']=='cancelled'
    assert call('GET',path,cookie=cookie)['turns'][-1]['status']=='cancelled'
    definition=call('POST','/api/agents',{'id':'data-agent','name':'Data agent','instructions':'INSTRUCTION_123','modelProfile':'fast'},token=token,status=201)
    data_conv=chat_create(cookie,'data-agent')
    defined=send(cookie,data_conv['id'],'Use saved definition')
    assert defined['status']=='completed' and defined['agentRevision']==1
    assert 'INSTRUCTION_123' in json.dumps(ModelHandler.requests[-1]['messages'])
    call('PUT','/api/agents/data-agent',dict(definition,instructions='UPDATED_456'),token=token)
    revised=send(cookie,data_conv['id'],'Use new revision')
    assert revised['status']=='completed' and revised['agentRevision']==2
    assert 'UPDATED_456' in json.dumps(ModelHandler.requests[-1]['messages'])
    assert 'INSTRUCTION_123' not in json.dumps(ModelHandler.requests[-1]['messages'])
    tool_agent=call('POST','/api/agents',{'id':'tool-agent','name':'Tools','toolNames':['files.read']},token=token,status=201)
    tool_conv=chat_create(cookie,'tool-agent')
    call('POST',f"/api/client/chat/conversations/{tool_conv['id']}/messages",{'requestId':str(uuid.uuid4()),'text':'Do not dispatch'},cookie=cookie,status=409)
    call('PUT','/api/agents/tool-agent',dict(tool_agent,enabled=False),token=token)
    assert 'tool-agent' not in [a['id'] for a in call('GET','/api/client/chat/agents',cookie=cookie)]
    # Expired lease simulates a process dying between durable admission and completion.
    stale=str(uuid.uuid4())
    pg(database,f"INSERT INTO agent_chat_turns (id,\"conversationId\",sequence,\"agentRevision\",\"userText\",\"assistantText\",status,error,\"createdAt\",\"finishedAt\") VALUES ('{stale}','{conv_id}',5,1,'interrupted','','pending','',now(),now())")
    pg(database,f"UPDATE agent_conversations SET \"activeRequestId\"='{stale}',\"activeUntil\"=now()-interval '1 second',\"turnCount\"=5 WHERE id='{conv_id}'")
    assert call('GET',path,cookie=cookie)['turns'][-1]['status']=='failed'
    receipt['checks']['controlled_binary_auth_privacy_idempotency_cancel_recovery']='PASS'
    print('Controlled model: binary/auth/privacy/idempotency/cancel/recovery PASS',flush=True)
    stop(app)
    app_env['OSNOVA_LLM__BASE_URL']='http://127.0.0.1:11435/v1'
    app=start([str(ROOT/'bin/osnova-app')],app_env,scratch,'app-real-model.log')
    ready(app,'http://127.0.0.1:3000/api/admin/auth/bootstrap')
    assert call('GET','/api/client/auth/me',cookie=cookie)==alice
    assert len(call('GET',path,cookie=cookie)['turns'])==5
    live=chat_create(cookie)
    live_first=send(cookie,live['id'],'Запомни кодовое слово КЕДР-731. Ответь кратко, что запомнил.')
    assert live_first['status']=='completed', live_first
    live_second=send(cookie,live['id'],'Какое кодовое слово я попросила запомнить? Ответь только им.')
    assert live_second['status']=='completed' and 'КЕДР-731' in live_second['assistantText'].upper(), live_second
    (BASE/'real-model.json').write_text(json.dumps({'provider':'Local Ollama','model':'qwen2.5:7b','first':live_first,'second':live_second},ensure_ascii=False,indent=2)+'\n')
    receipt['checks']['real_ollama_conversation_and_restart']='PASS'
    call('POST','/api/client/auth/logout',{},cookie=bob_cookie,status=204)
    call('GET','/api/client/auth/me',cookie=bob_cookie,status=401)
    print('Real Ollama: persisted conversation, context and restart PASS',flush=True)
    if '--browser' in sys.argv:
        ui=start([*bun,'run','client:ui'],env,ROOT,'client-ui.log')
        ready(ui,'http://127.0.0.1:4300')
        (BASE/'ready.json').write_text(json.dumps({'url':'http://127.0.0.1:4300','email':alice['email'],'scope':'Disposable preview'})+'\n')
        print(json.dumps({'event':'ready','url':'http://127.0.0.1:4300','evidence':str(BASE)}),flush=True)
        for _ in range(1200):
            result_file=BASE/'browser-result.json'
            if result_file.exists():
                browser=json.loads(result_file.read_text());assert browser['status']=='PASS'
                receipt['checks']['browser']=browser;break
            if app.poll() is not None or ui.poll() is not None: raise RuntimeError('Preview exited')
            time.sleep(1)
        else: raise RuntimeError('Browser verification timed out')
    receipt['status']='PASS'
except Exception as error:
    receipt['status']='FAIL';receipt['error']=safe(str(error));print(receipt['error'],flush=True)
finally:
    if model_server:
        ModelHandler.unblock.set();model_server.shutdown();model_server.server_close()
    for child in reversed(children): stop(child)
    for log in logs: log.close()
    owned=command([DOCKER,'ps','-aq','--filter','label='+label]).split()
    for item in owned: command([DOCKER,'rm','-f',item])
    receipt['remaining_owned_containers']=command([DOCKER,'ps','-aq','--filter','label='+label]).split()
    if receipt['remaining_owned_containers']: receipt['status']='FAIL'
    for path in BASE.glob('*.log'): path.write_text(safe(path.read_text()))
    (BASE/'receipt.json').write_text(json.dumps(receipt,indent=2,ensure_ascii=False)+'\n')
    scratch_owner.cleanup()
raise SystemExit(0 if receipt['status']=='PASS' else 1)
