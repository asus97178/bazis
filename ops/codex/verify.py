"""Compiled Osnova + owned disposable PostgreSQL DB + local Codex subprocess fixture."""
import hashlib, http.server, http.client, json, os, pathlib, secrets, socket, subprocess, sys, threading, time, urllib.request
ROOT=pathlib.Path(__file__).resolve().parents[2]
tools_mode='--tools' in sys.argv
BASE=ROOT/('.cache/agent-run/physical' if tools_mode else '.cache/codex-chatgpt/physical'); BASE.mkdir(parents=True,exist_ok=True)
PREVIEW=ROOT/'.cache/client-preview'; os.umask(0o077)
env={k:v for k,v in os.environ.items() if not k.startswith('OSNV_') and k not in ('BUN_OPTIONS','NODE_OPTIONS')}
env['OSNV_BUN_BIN']=str(ROOT/'.cache/jwt-stand/toolchain/bun')
env['TMPDIR']=str(BASE/'tmp'); pathlib.Path(env['TMPDIR']).mkdir(exist_ok=True)
def command(args,**kwargs):
    result=subprocess.run(args,env=env,text=True,capture_output=True,**kwargs)
    if result.returncode: raise RuntimeError(f'Check exited {result.returncode}: {result.stderr[-6000:]}')
    return result.stdout.strip()
container=json.loads((PREVIEW/'state.json').read_text())['container']
inspected=json.loads(command(['/usr/local/bin/docker','inspect',container]))[0]
assert inspected['Config']['Labels'].get('osnova.client-preview')
assert all(item['HostIp']=='127.0.0.1' for item in inspected['NetworkSettings']['Ports']['5432/tcp'])
with socket.socket() as probe:
    # Reject a live listener, but permit our previous run's TCP TIME_WAIT state.
    probe.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
    probe.bind(('127.0.0.1',3102))
database='codex_check_'+secrets.token_hex(6)
def pg(db,sql): return command(['/usr/local/bin/docker','exec','-i',container,'psql','-X','-v','ON_ERROR_STOP=1','-U','osnova','-d',db,'-tA'],input=sql)
fallback=[]; local_requests=[]
class Model(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_POST(self):
        fallback.append(True)
        if not tools_mode: self.send_response(503); self.end_headers(); return
        body=json.loads(self.rfile.read(int(self.headers['content-length'])))
        assert body['stream'] is True
        self.send_response(200); self.send_header('Content-Type','text/event-stream'); self.end_headers()
        def packet(delta,finish=None):
            self.wfile.write(('data: '+json.dumps({'choices':[{'index':0,'delta':delta,'finish_reason':finish}]})+'\n\n').encode()); self.wfile.flush()
        results=[message for message in body['messages'] if message['role']=='tool']
        local_requests.append((len(body.get('tools',[])),bool(results)))
        if results:
            result=json.loads(results[-1]['content']); assert result['status']=='success', result
            answer='Данные: '+json.dumps(result['output'],ensure_ascii=False)
            packet({'content':answer[:7]}); time.sleep(.15); packet({'content':answer[7:]},'stop')
        else:
            name=body['tools'][0]['function']['name'] if body.get('tools') else 'not_assigned'
            packet({'tool_calls':[{'index':0,'id':'read-agents','type':'function','function':{'name':name,'arguments':'{"pa'}}]})
            packet({'tool_calls':[{'index':0,'function':{'arguments':'ge":1}'}}]},'tool_calls')
        self.wfile.write(b'data: [DONE]\n\n'); self.wfile.flush()
model=http.server.ThreadingHTTPServer(('127.0.0.1',0),Model)
threading.Thread(target=model.serve_forever,daemon=True).start()
app=None; browser=None; client_browser=None
try:
    pg('control',f'CREATE DATABASE "{database}" OWNER worker;')
    pg(database,'CREATE SCHEMA app AUTHORIZATION worker; CREATE SCHEMA product AUTHORIZATION worker;')
    work=BASE/'runtime'; work.mkdir(exist_ok=True)
    state=BASE/database; home=state/'home'; home.mkdir(parents=True)
    (home/'fixture-account').write_text('fixture')
    fixture=ROOT/'src/osnova/core/infra/test/fixtures/codex-server.py'; fixture.chmod(0o700)
    settings=json.loads((PREVIEW/'private-config.json').read_text())['app_env']
    settings.update(OSNV_DB__DATABASE=database,OSNV_HTTP__PORT='3102',OSNV_ADMIN_PORT='3102',OSNV_LLM__BASE_URL=f'http://127.0.0.1:{model.server_port}/v1',
        OSNV_CODEX__ENABLED='true',OSNV_CODEX__BINARY=str(fixture),OSNV_CODEX__STATE_DIRECTORY=str(state))
    with (BASE/'app.log').open('w') as log: app=subprocess.Popen([str(ROOT/'bin/osnova-app')],cwd=work,env=dict(env,**settings),stdin=subprocess.DEVNULL,stdout=log,stderr=log)
    for _ in range(150):
        if app.poll() is not None: raise RuntimeError('Compiled app exited; see .cache/codex-chatgpt/physical/app.log')
        try:
            if urllib.request.urlopen('http://127.0.0.1:3102/api/admin/auth/bootstrap',timeout=1).status==200: break
        except Exception: pass
        time.sleep(.1)
    else: raise RuntimeError('App readiness timeout')
    check=ROOT/('ops/agent-run/check.ts' if tools_mode else 'ops/codex/check.ts')
    raw=command([str(ROOT/'scripts/osnova-bun'),'--no-env-file','run',str(check)],cwd=ROOT,timeout=120)
    receipt=json.loads(raw.splitlines()[-1])
    wire=[json.loads(line) for line in (home/'fixture-wire.jsonl').read_text().splitlines()]
    turns=[item for item in wire if item.get('method')=='turn/start']
    assert len(turns)==(2 if tools_mode else 3), f'Unexpected execution count: {len(turns)}'
    starts=[item for item in wire if item.get('method')=='thread/start']
    if tools_mode:
        # The existing reasoning profile falls back to fast after the invalid,
        # text-free response for an agent with no tools. Neither attempt runs a tool.
        assert local_requests==[(1,False),(1,True),(0,False),(0,False),(1,False),(1,True)], local_requests
        assert starts[0]['params']['dynamicTools'][0]['type']=='function'
        assert starts[0]['params']['dynamicTools'][0]['inputSchema']['properties']['page']['type']=='integer'
        responses=[item for item in wire if str(item.get('id','')).startswith('tool-request-') and item.get('result',{}).get('success')]
        assert len(responses)==1
        receipt.update(cli_sha256=hashlib.sha256((ROOT/'bin/osnova').read_bytes()).hexdigest())
    else:
        assert starts[0]['params']['model']=='fixture-fast' and turns[0]['params']['effort']=='high'
        assert all(item['params']['effort']=='medium' for item in turns[1:])
        assert not fallback, 'Unexpected model fallback'
    receipt.update(app_sha256=hashlib.sha256((ROOT/'bin/osnova-app').read_bytes()).hexdigest(),codex_turns=len(turns),scope='Compiled app, isolated PostgreSQL, real sockets and local subprocess protocol fixture')
    receipt['local_model_calls' if tools_mode else 'fallback_calls']=len(fallback)
    (BASE/'receipt.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(receipt,ensure_ascii=False),flush=True)
    if not tools_mode and os.environ.get('CODEX_BROWSER_CHECK')=='1':
        class Browser(http.server.SimpleHTTPRequestHandler):
            def __init__(self,*args,**kwargs): super().__init__(*args,directory=str(ROOT/'admin-ui/dist'),**kwargs)
            def log_message(self,*args): pass
            def do_GET(self):
                if self.path.startswith('/api/'): return self.proxy()
                if not self.path.startswith('/assets/'): self.path='/index.html'
                return super().do_GET()
            def do_POST(self): return self.proxy()
            def do_PUT(self): return self.proxy()
            def do_DELETE(self): return self.proxy()
            def proxy(self):
                if not self.path.startswith('/api/'): self.send_error(404); return
                connection=http.client.HTTPConnection('127.0.0.1',3102,timeout=35)
                try:
                    headers={k:v for k,v in self.headers.items() if k.lower() not in ('host','connection','origin')}
                    headers['Origin']='http://127.0.0.1:3102'
                    body=self.rfile.read(int(self.headers.get('content-length','0')))
                    connection.request(self.command,self.path,body,headers); response=connection.getresponse(); payload=response.read()
                    self.send_response(response.status)
                    for key,value in response.getheaders():
                        if key.lower() not in ('connection','transfer-encoding','content-length'): self.send_header(key,value)
                    self.send_header('content-length',str(len(payload))); self.end_headers(); self.wfile.write(payload)
                finally: connection.close()
        browser=http.server.ThreadingHTTPServer(('127.0.0.1',4201),Browser)
        threading.Thread(target=browser.serve_forever,daemon=True).start()
        with (BASE/'browser-client.log').open('w') as log:
            client_browser=subprocess.Popen([str(ROOT/'scripts/osnova-bun'),'--no-env-file','run',str(ROOT/'ops/codex/browser.ts')],cwd=ROOT,env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=log)
        (home/'fixture-account').touch()
        done=BASE/'browser-done'; done.unlink(missing_ok=True)
        (BASE/'browser-state.json').write_text(json.dumps({'home':str(home),'database':database,'url':'http://127.0.0.1:4201/pages/codex','client':'http://127.0.0.1:4301/'}))
        print('Browser fixture ready at http://127.0.0.1:4201/pages/codex',flush=True)
        deadline=time.time()+900
        while not done.exists() and time.time()<deadline: time.sleep(.2)
finally:
    if client_browser:
        client_browser.terminate()
        try: client_browser.wait(timeout=10)
        except subprocess.TimeoutExpired: client_browser.kill(); client_browser.wait()
    if browser: browser.shutdown(); browser.server_close()
    if app:
        app.terminate()
        try: app.wait(timeout=10)
        except subprocess.TimeoutExpired: app.kill(); app.wait()
    model.shutdown(); model.server_close()
    pg('control',f'DROP DATABASE IF EXISTS "{database}" WITH (FORCE);')
