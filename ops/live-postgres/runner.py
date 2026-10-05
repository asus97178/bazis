"""Release live-PostgreSQL qualification on one disposable, owned container.

Usage (from the repository root, with OSNV_BUN_BIN pointing at the qualified Bun):
    python3 ops/live-postgres/runner.py <evidence-dir> [suite-path ...]

Starts PostgreSQL 17 (default durability settings, TLS on, loopback only),
runs the full isolated suite with OSNV_PG_URL, then every gated live suite in
its own database with exactly the gate it requires, and removes the container.
Secrets never reach the evidence: the password is generated per run and redacted.
"""
from pathlib import Path
import json, os, re, secrets, signal, subprocess, sys, tempfile, time, uuid
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[2]
if len(sys.argv) < 2: raise SystemExit(__doc__)
BASE = Path(sys.argv[1]).resolve()
BASE.mkdir(parents=True, exist_ok=False)
DOCKER = '/usr/local/bin/docker'
IMAGE = 'postgres:17-alpine'
LAUNCHER = str(ROOT / 'scripts/osnv-bun')
IGNORES = ['--path-ignore-patterns=**/*.browser.spec.ts', '--path-ignore-patterns=**/bin/**']
# Upstream driver defects documented elsewhere: reported, never counted as PASS.
KNOWN_EXTERNAL = {'orm.qualification-20260913.native-cancel.live.test.ts':
                  'Bun.SQL cancel() does not cancel the server query; see https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/orm-2026-09-14-qualification.md'}
run_id = uuid.uuid4().hex[:12]
label = 'osnv.orm-qualification-run=' + run_id
password, worker_password = secrets.token_hex(24), secrets.token_hex(24)
env = {k: v for k, v in os.environ.items() if not k.startswith('OSNV_') and k not in ('BUN_OPTIONS', 'NODE_OPTIONS')}
env['OSNV_BUN_BIN'] = os.environ['OSNV_BUN_BIN']
tls_dir = tempfile.TemporaryDirectory(prefix='osnv-live-pg-tls-')
container = address = None
receipt = {'started_at': datetime.now(timezone.utc).isoformat(), 'run_id': run_id, 'image': IMAGE, 'suites': [], 'cleanup': {}}

def redact(text): return text.replace(password, '[REDACTED]').replace(worker_password, '[REDACTED]')

def command(args, *, child_env=None, timeout=60, check=True):
    result = subprocess.run(args, cwd=ROOT, env=child_env or env, capture_output=True, text=True, timeout=timeout)
    if check and result.returncode: raise RuntimeError(redact(f'{args[0]} failed: {result.stderr}'))
    return result

def pg(database, sql):
    return command([DOCKER, 'exec', container, 'psql', '-X', '-A', '-t', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1', '-c', sql]).stdout.strip()

def url(database, user='osnv', secret=None): return f'postgres://{user}:{secret or password}@{address}/{database}'

def create_database(name, owner='osnv'):
    assert re.fullmatch('[a-z0-9_]+', name)
    pg('postgres', f'CREATE DATABASE "{name}" OWNER "{owner}"')
    return name

def gated(path):
    """Database and gate variables for one live suite; None means the full-suite phase covers it."""
    name = Path(path).name
    if 'owned-store.core' in name:
        e_run = str(uuid.uuid4()); db = create_database('oe327_' + e_run.replace('-', ''))
        return db, {'OSNV_PG_URL': url(db), 'OSNV_OWNED_STORE_E_LIVE': 'wp-orm-3-e327-integrated-v1', 'OSNV_OWNED_STORE_E_DATABASE': db,
                    'OSNV_OWNED_STORE_E_ROLE': 'owned-store-e-child-v1', 'OSNV_OWNED_STORE_E_RUN': e_run}
    if 'orm.owned-store.postgres' in name:
        db = create_database(f'c3_{run_id}')
        return db, {'OSNV_PG_URL': url(db), 'OSNV_OWNED_STORE_C3_LIVE': 'owned-disposable-v1', 'OSNV_OWNED_STORE_C3_DATABASE': db}
    if 'server-cancellation' in name:
        db = create_database('cancel_' + run_id, owner='worker')
        return db, {'OSNV_PG_URL': url(db, 'worker', worker_password), 'OSNV_ORM_SERVER_CANCELLATION_LIVE': 'owned-disposable-v1',
                    'OSNV_SERVER_CANCEL_CA': str(BASE / 'server-ca.pem')}
    if 'json-native' in name:
        db = create_database('orm_audit')
        return db, {'OSNV_PG_URL': url(db), 'OSNV_ORM_REPEAT_AUDIT_LIVE': '1'}
    if 'release-095' in name:
        db = create_database('osnv_release_095')
        return db, {'OSNV_RELEASE_095_PG': 'owned-disposable-v1', 'OSNV_RELEASE_095_PG_URL': url(db)}
    flags = {'audit-20260913': {'OSNV_ORM_AUDIT_LIVE': '1'}, 'qualification-20260913': {'OSNV_ORM_QUALIFICATION_LIVE': '1'},
             'cancellation-20260914': {'OSNV_ORM_CANCELLATION_LIVE': '1'},
             'bun-sql-hardening': {'OSNV_ORM_HARDENING_LIVE': '1', 'OSNV_ORM_HARDENING_CONTAINER': container,
                                   'OSNV_ORM_HARDENING_RUN': run_id, 'OSNV_ORM_TLS_CA_FILE': str(BASE / 'server-ca.pem')}}
    for key, extra in flags.items():
        if key in name:
            db = create_database(f'ormqa_{run_id}_{len(receipt["suites"])}')
            return db, {'OSNV_PG_URL': url(db), **extra}
    return None

def run_tests(title, args, extra_env, database, timeout):
    print('RUN', title, flush=True)
    start = time.monotonic()
    process = subprocess.Popen([LAUNCHER, '--no-env-file', 'test', '--isolate', *args], cwd=ROOT, env=dict(env, **extra_env),
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True)
    timed_out = False
    try: output, _ = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True; os.killpg(process.pid, signal.SIGTERM)
        try: output, _ = process.communicate(timeout=20)
        except subprocess.TimeoutExpired: os.killpg(process.pid, signal.SIGKILL); output, _ = process.communicate()
    output = redact(output)
    log = re.sub('[^a-z0-9.-]+', '-', title.lower()).strip('-') + '.log'
    (BASE / log).write_text(output)
    result = {'suite': title, 'database': database, 'log': log, 'exit': process.returncode, 'timeout': timed_out,
              'duration_seconds': round(time.monotonic() - start, 1), 'pass': 0, 'fail': 0, 'skip': 0,
              'failed_tests': re.findall(r'^\(fail\) (.+?) \[', output, re.M)}
    for count, key in re.findall(r'^\s*(\d+) (pass|fail|skip)\s*$', output, re.M): result[key] = int(count)
    time.sleep(1)
    result['sessions_after'] = int(pg('postgres', "SELECT count(*) FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid()"))
    receipt['suites'].append(result)
    print(json.dumps(result, ensure_ascii=False), flush=True)
    (BASE / 'progress.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n')

status = 1
try:
    receipt['toolchain'] = json.loads(command([LAUNCHER, '--no-env-file', 'run', 'scripts/bun-toolchain-check.ts', '--receipt']).stdout)
    receipt['git_head'] = command(['git', 'rev-parse', 'HEAD']).stdout.strip()
    receipt['git_dirty'] = bool(command(['git', 'status', '--porcelain']).stdout.strip())
    # A shell keeps PID 1 so the hardening suite can restart the server with pg_ctl.
    container = command([DOCKER, 'run', '-d', '--pull=never', '--name', 'osnv-live-pg-' + run_id, '--label', label, '--restart=no',
                         '--entrypoint', '/bin/sh', '--publish', '127.0.0.1::5432', '--env', 'POSTGRES_USER=postgres',
                         '--env', 'POSTGRES_DB=osnv_session_test', '--env', 'POSTGRES_PASSWORD', IMAGE,
                         '-c', '/usr/local/bin/docker-entrypoint.sh postgres -c max_connections=400 &\nwait\nwhile :; do sleep 1; done'],
                        child_env=dict(env, POSTGRES_PASSWORD=password)).stdout.strip()
    receipt['container_id'] = container
    for _ in range(60):
        if command([DOCKER, 'exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'], check=False, timeout=5).returncode == 0: break
        time.sleep(.5)
    else: raise RuntimeError('PostgreSQL did not become ready')
    address = command([DOCKER, 'port', container, '5432/tcp']).stdout.strip()
    assert re.fullmatch(r'127\.0\.0\.1:\d+', address)
    tls = Path(tls_dir.name)
    (tls / 'openssl.cnf').write_text('[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=v3\n[dn]\nCN=localhost\n[v3]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n')
    command(['/usr/bin/openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', str(tls / 'openssl.cnf'), '-keyout', str(tls / 'server.key'), '-out', str(tls / 'server.crt')])
    (BASE / 'server-ca.pem').write_bytes((tls / 'server.crt').read_bytes())
    for source, dest in [('server.key', '/tmp/osnv-server.key'), ('server.crt', '/tmp/osnv-server.crt')]:
        command([DOCKER, 'cp', str(tls / source), container + ':' + dest])
        command([DOCKER, 'exec', '--user', 'root', container, 'chown', 'postgres:postgres', dest])
        command([DOCKER, 'exec', '--user', 'root', container, 'chmod', '600', dest])
    for setting in ["ssl_cert_file = '/tmp/osnv-server.crt'", "ssl_key_file = '/tmp/osnv-server.key'", 'ssl = on']:
        pg('postgres', 'ALTER SYSTEM SET ' + setting)
    pg('postgres', 'SELECT pg_reload_conf()')
    # ORM qualifications assert that owned objects belong to `osnv`; the
    # session-hosting test requires the `postgres` superuser on osnv_session_test.
    pg('postgres', f"CREATE ROLE osnv LOGIN SUPERUSER PASSWORD '{password}'")
    pg('postgres', f"CREATE ROLE worker LOGIN NOSUPERUSER PASSWORD '{worker_password}'")
    receipt['postgres'] = {'version': pg('postgres', 'SELECT version()'), 'fsync': pg('postgres', 'SHOW fsync'),
                           'synchronous_commit': pg('postgres', 'SHOW synchronous_commit'), 'ssl': pg('postgres', 'SHOW ssl'), 'binding': address}
    print(receipt['postgres'], flush=True)

    files = sys.argv[2:] or sorted(str(p.relative_to(ROOT)) for p in (ROOT / 'src').rglob('*.live.test.ts') if 'redis' not in p.name)
    if not sys.argv[2:]:
        jwt_db = create_database('jwt_qualification')
        agents_db = create_database('agents_test_' + run_id)
        run_tests('full-suite', [*IGNORES, '--reporter=junit', f'--reporter-outfile={BASE / "full-suite.junit.xml"}'], {'OSNV_PG_URL': url('osnv_session_test', 'postgres'), 'OSNV_PG_REQUIRED': '1',
                  'OSNV_JWT_QUALIFICATION_PG_URL': url(jwt_db), 'OSNV_AGENTS_TEST_DB': 'owned-disposable-v1',
                  'OSNV_AGENTS_PG_URL': url(agents_db)}, 'osnv_session_test', 1800)
    for path in files:
        plan = gated(path)
        if plan: run_tests(Path(path).name, [path], plan[1], plan[0], 600)
    for s in receipt['suites']:
        if s['suite'] in KNOWN_EXTERNAL: s['known_external_defect'] = KNOWN_EXTERNAL[s['suite']]
    status = int(any(s['exit'] or s['timeout'] or s['fail'] or not s['pass'] or s['sessions_after']
                     for s in receipt['suites'] if s['suite'] not in KNOWN_EXTERNAL)
                 or any(s['sessions_after'] or s['timeout'] for s in receipt['suites']))
except BaseException as error:
    receipt['error'] = redact(str(error)); print('ERROR', receipt['error'], flush=True)
finally:
    if container:
        (BASE / 'postgres-server.log').write_text(redact((lambda r: r.stdout + r.stderr)(command([DOCKER, 'logs', container], check=False))))
        receipt['cleanup']['remove_exit'] = command([DOCKER, 'rm', '-f', '-v', container], check=False).returncode
        remaining = command([DOCKER, 'ps', '-aq', '--filter', 'label=' + label]).stdout.strip()
        receipt['cleanup']['containers_remaining'] = len(remaining.splitlines()) if remaining else 0
        if receipt['cleanup']['remove_exit'] or remaining: status = 1
    tls_dir.cleanup()
    receipt['overall_exit'] = status
    receipt['finished_at'] = datetime.now(timezone.utc).isoformat()
    (BASE / 'receipt.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'overall_exit': status, 'cleanup': receipt['cleanup'], 'evidence': str(BASE)}), flush=True)
raise SystemExit(status)
