"""Own a local browser/PostgreSQL fixture until /fixture/finish is called."""
from pathlib import Path
import hashlib
import json
import os
import re
import secrets
import subprocess
import sys
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
name = sys.argv[1] if len(sys.argv) == 2 else ''
if not re.fullmatch('[a-z0-9-]+', name):
    raise SystemExit('Usage: runner.py unique-evidence-name')
BASE = ROOT / 'docs/audits/record-recovery-client-2026-09-20-evidence' / name
BASE.mkdir(parents=True, exist_ok=False)
env = {k:v for k,v in os.environ.items() if not k.startswith('OSNOVA_') and k not in ('BUN_OPTIONS', 'NODE_OPTIONS')}
env['OSNOVA_BUN_BIN'] = os.environ['OSNOVA_BUN_BIN']
DOCKER = '/usr/local/bin/docker'
IMAGE = 'sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73'
run = uuid.uuid4().hex[:12]
label = 'osnova.record-client-run=' + run
passwords = [secrets.token_hex(24), secrets.token_hex(24)]
scratch_owner = tempfile.TemporaryDirectory(prefix='osnova-record-browser-')
scratch = Path(scratch_owner.name)
container = None
child = None
receipt = {'image': IMAGE, 'run': run, 'checks': {}, 'scope': 'Disposable database; real controllers/ORM; synthetic authentication; controlled HTTP response faults.'}


def safe(text):
    for secret in passwords:
        text = text.replace(secret, '[REDACTED]')
    return text


def command(args, custom_env=None, timeout=120):
    r = subprocess.run(args, cwd=ROOT, env=custom_env or env, capture_output=True, text=True, timeout=timeout)
    if r.returncode:
        raise RuntimeError(safe(r.stderr + r.stdout))
    return r.stdout


def pg(database, sql):
    return command([DOCKER, 'exec', container, 'psql', '-XAt', '-U', 'osnova', '-d', database, '-v', 'ON_ERROR_STOP=1', '-c', sql]).strip()


def hashes():
    dirs = ['admin-ui/src/app/features/datamanager', 'admin-ui/src/app/core', 'admin-ui/test/record-recovery',
            'src/app/modules/datamanager_modules', 'src/osnova/library/orm', 'src/osnova/library/http-client', 'src/generated/osnova', 'ops/record-client-recovery']
    return {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for folder in dirs for p in sorted((ROOT / folder).rglob('*')) if p.is_file()}


try:
    receipt['hashes_before'] = hashes()
    bun = [str(ROOT/'scripts/osnova-bun'), '--no-env-file']
    (BASE/'toolchain.log').write_text(command([*bun, 'run', 'scripts/bun-toolchain-check.ts', '--receipt']))
    (BASE/'fixture-build.log').write_text(command([*bun, 'ops/record-client-recovery/build-fixture.ts', str(scratch/'dist')]))
    (BASE/'server-build.log').write_text(command([*bun, 'build', '--compile', 'ops/record-client-recovery/server.ts', '--outfile', str(scratch/'server')]))
    receipt['checks']['build'] = 'PASS'
    receipt['server_sha256'] = hashlib.sha256((scratch/'server').read_bytes()).hexdigest()
    container = command([DOCKER,'run','-d','--pull=never','--name','osnova-record-client-'+run,'--label',label,
                         '--memory','768m','--cpus','2','--pids-limit','256','--restart=no','--publish','127.0.0.1::5432',
                         '--mount','type=tmpfs,destination=/var/lib/postgresql/data,tmpfs-size=536870912',
                         '--env','POSTGRES_USER=osnova','--env','POSTGRES_DB=control','--env','POSTGRES_PASSWORD',IMAGE],dict(env,POSTGRES_PASSWORD=passwords[0])).strip()
    receipt['container_id'] = container
    inspect = json.loads(command([DOCKER,'inspect',container]))[0]
    assert inspect['Config']['Labels']['osnova.record-client-run'] == run
    assert all(x['Type']=='tmpfs' for x in inspect['Mounts'])
    for _ in range(90):
        logs = subprocess.run([DOCKER,'logs',container],capture_output=True,text=True)
        if 'init process complete' in logs.stdout+logs.stderr:
            try:
                if pg('control','SELECT 1') == '1': break
            except RuntimeError: pass
        time.sleep(.25)
    else: raise RuntimeError('Fixture did not become ready')
    address = command([DOCKER,'port',container,'5432/tcp']).strip()
    assert re.fullmatch(r'127\.0\.0\.1:\d+',address)
    pg('control',f"CREATE ROLE worker LOGIN NOSUPERUSER PASSWORD '{passwords[1]}'")
    database='recordclient_'+run
    pg('control',f'CREATE DATABASE "{database}" OWNER worker')
    receipt['postgres_version'] = pg(database,'SELECT version()')
    receipt['worker_superuser'] = pg(database,"SELECT rolsuper FROM pg_roles WHERE rolname='worker'")
    child_env=dict(env,OSNOVA_CLIENT_RECOVERY='owned-disposable-v1',OSNOVA_CLIENT_DIST=str(scratch/'dist'),
                   OSNOVA_CLIENT_RESULT=str(BASE/'database-result.json'),OSNOVA_PG_URL=f'postgres://worker:{passwords[1]}@{address}/{database}')
    with (BASE/'server.log').open('w') as log:
        child=subprocess.Popen([str(scratch/'server')],cwd=scratch,env=child_env,stdout=subprocess.PIPE,stderr=log,text=True)
        while True:
            line=child.stdout.readline()
            if not line: raise RuntimeError('Fixture server exited before readiness')
            log.write(safe(line)); log.flush()
            try: row=json.loads(line)
            except json.JSONDecodeError: continue
            if row.get('event')=='ready':
                receipt['ready']=row
                print(json.dumps(row),flush=True)
                (BASE/'ready.json').write_text(json.dumps(row))
                break
        code=child.wait(timeout=1200)
        receipt['checks']['server_exit']=code
        if code or not (BASE/'database-result.json').exists(): raise RuntimeError('Browser fixture did not finish successfully')
    receipt['status']='PASS'
except Exception as error:
    receipt['status']='FAIL'; receipt['error']=safe(str(error)); print(receipt['error'],flush=True)
finally:
    if child and child.poll() is None: child.terminate(); child.wait(timeout=15)
    owned=command([DOCKER,'ps','-aq','--filter','label='+label]).split()
    for item in owned: command([DOCKER,'rm','-f',item])
    receipt['remaining_owned_containers']=command([DOCKER,'ps','-aq','--filter','label='+label]).split()
    receipt['hashes_after']=hashes()
    receipt['source_drift']=[p for p in set(receipt.get('hashes_before',{}))|set(receipt['hashes_after']) if receipt.get('hashes_before',{}).get(p)!=receipt['hashes_after'].get(p)]
    if receipt['source_drift'] or receipt['remaining_owned_containers']: receipt['status']='FAIL'
    (BASE/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
    scratch_owner.cleanup()
raise SystemExit(0 if receipt['status']=='PASS' else 1)
