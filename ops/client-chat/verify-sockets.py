"""Owned local PostgreSQL database + compiled app; no changes to the user's preview data."""
import hashlib, http.server, json, os, pathlib, secrets, socket, subprocess, threading, time, urllib.request
ROOT = pathlib.Path(__file__).resolve().parents[2]
BASE = ROOT / '.cache/client-chat-sockets'
PREVIEW = ROOT / '.cache/client-preview'
DOCKER = '/usr/local/bin/docker'
os.umask(0o077)
state = json.loads((PREVIEW / 'state.json').read_text())
container = state['container']
env = {k: v for k, v in os.environ.items() if not k.startswith('OSNOVA_') and k not in ('BUN_OPTIONS','NODE_OPTIONS')}
env['OSNOVA_BUN_BIN'] = str(ROOT / '.cache/jwt-stand/toolchain/bun')
env['TMPDIR'] = str(BASE / 'physical-tmp')
pathlib.Path(env['TMPDIR']).mkdir(exist_ok=True)
work = BASE / 'runtime'; work.mkdir(exist_ok=True)
def command(args, **kwargs):
    result = subprocess.run(args, env=env, text=True, capture_output=True, **kwargs)
    if result.returncode:
        raise RuntimeError(f'Local check exited {result.returncode}: {result.stderr[-6000:]}')
    return result.stdout.strip()
inspect = json.loads(command([DOCKER, 'inspect', container]))[0]
assert inspect['Config']['Labels'].get('osnova.client-preview')
assert all(item['HostIp'] == '127.0.0.1' for item in inspect['NetworkSettings']['Ports']['5432/tcp'])
with socket.socket() as probe: probe.bind(('127.0.0.1', 3101))
database = 'socket_check_' + secrets.token_hex(6)
def pg(db, sql):
    return command([DOCKER,'exec','-i',container,'psql','-X','-v','ON_ERROR_STOP=1','-U','osnova','-d',db,'-tA'], input=sql)
requests = []
class Model(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['content-length'])))
        text = next(m['content'] for m in reversed(body['messages']) if m['role']=='user')
        requests.append(text)
        content = '\u0001' * 16000 if text == 'large' else 'Контрольный ответ: ' + text
        if body.get('stream'):
            try:
                self.send_response(200); self.send_header('content-type','text/event-stream'); self.end_headers()
                def send(delta, finish=None):
                    packet = {'choices':[{'index':0,'delta':{'content':delta},'finish_reason':finish}]}
                    self.wfile.write(('data: '+json.dumps(packet,ensure_ascii=False)+'\n\n').encode()); self.wfile.flush()
                send(content[:8])
                time.sleep(6 if text.startswith('slow-') else .4)
                if text == 'stream-failure': return
                send(content[8:16]); time.sleep(.4)
                send(content[16:]); time.sleep(.4)
                send('', 'stop'); self.wfile.write(b'data: [DONE]\n\n'); self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError): pass
            return
        time.sleep(6 if text.startswith('slow-') else .2)
        raw = json.dumps({'id':'chat-check','object':'chat.completion','created':int(time.time()),'model':'fixture',
            'choices':[{'index':0,'message':{'role':'assistant','content':content},'finish_reason':'stop'}],
            'usage':{'prompt_tokens':10,'completion_tokens':10,'total_tokens':20}}).encode()
        try:
            self.send_response(200); self.send_header('content-type','application/json'); self.send_header('content-length',str(len(raw))); self.end_headers(); self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError): pass
model = http.server.ThreadingHTTPServer(('127.0.0.1',0),Model)
threading.Thread(target=model.serve_forever,daemon=True).start()
app = None
try:
    pg('control', f'CREATE DATABASE "{database}" OWNER worker;')
    pg(database, 'CREATE SCHEMA app AUTHORIZATION worker; CREATE SCHEMA product AUTHORIZATION worker;')
    settings = json.loads((PREVIEW/'private-config.json').read_text())['app_env']
    settings.update(OSNOVA_DB__DATABASE=database, OSNOVA_HTTP__PORT='3101', OSNOVA_ADMIN_PORT='3101', OSNOVA_LLM__BASE_URL=f'http://127.0.0.1:{model.server_port}/v1')
    with (BASE/'physical-app.log').open('w') as log:
        app = subprocess.Popen([str(ROOT/'bin/osnova-app')],cwd=work,env=dict(env,**settings),stdin=subprocess.DEVNULL,stdout=log,stderr=log)
    for _ in range(100):
        if app.poll() is not None: raise RuntimeError('Compiled app exited; see physical-app.log')
        try:
            if urllib.request.urlopen('http://127.0.0.1:3101/api/admin/auth/bootstrap',timeout=1).status==200: break
        except Exception: pass
        time.sleep(.1)
    else: raise RuntimeError('App readiness timeout')
    result = command([str(ROOT/'scripts/osnova-bun'),'--no-env-file','run',str(ROOT/'ops/client-chat/socket-check.ts')], cwd=ROOT)
    receipt = json.loads(result.splitlines()[-1])
    assert all(requests.count(value)==1 for value in requests), 'Duplicate model invocation'
    receipt.update(app_sha256=hashlib.sha256((ROOT/'bin/osnova-app').read_bytes()).hexdigest(),model_calls=len(requests),scope='Compiled app, real isolated PostgreSQL database, real WebSocket listener, controlled model')
    (BASE/'physical-receipt.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(receipt,ensure_ascii=False),flush=True)
finally:
    if app:
        app.terminate()
        try: app.wait(timeout=10)
        except subprocess.TimeoutExpired: app.kill(); app.wait()
    model.shutdown(); model.server_close()
    pg('control',f'DROP DATABASE IF EXISTS "{database}" WITH (FORCE);')
