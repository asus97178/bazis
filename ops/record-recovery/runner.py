"""Compile and qualify RecordsModule only on owned, disposable PostgreSQL databases."""
from pathlib import Path
from datetime import datetime, timezone
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
if not re.fullmatch(r'[a-z0-9-]+', name):
    raise SystemExit('Usage: runner.py unique-evidence-name')
BASE = ROOT / 'docs/audits/record-recovery-2026-09-19-evidence' / name
BASE.mkdir(parents=True, exist_ok=False)
DOCKER = '/usr/local/bin/docker'
IMAGE = 'sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73'
run = uuid.uuid4().hex[:12]
label = 'osnova.record-recovery-run=' + run
passwords = [secrets.token_hex(24), secrets.token_hex(24)]
env = {k: v for k, v in os.environ.items() if not k.startswith('OSNOVA_') and k not in ['BUN_OPTIONS', 'NODE_OPTIONS']}
env['OSNOVA_BUN_BIN'] = os.environ['OSNOVA_BUN_BIN']
receipt = {'started_at': datetime.now(timezone.utc).isoformat(), 'run': run, 'image': IMAGE,
           'authorization': 'User делай, local business recovery qualification; owned disposable resources only.', 'checks': {}}
scratch_context = tempfile.TemporaryDirectory(prefix='osnova-record-recovery-fixture-')
scratch = Path(scratch_context.name)
container = None


def redact(value):
    for password in passwords:
        value = value.replace(password, '[REDACTED]')
    return value


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def hashes():
    files = [p for folder in ['src/osnova/library/orm', 'src/osnova/core/orm', 'src/app/modules/datamanager_modules', 'src/generated/osnova', 'ops/record-recovery']
             for p in (ROOT / folder).rglob('*') if p.is_file()]
    files += [ROOT / p for p in ['package.json', 'bun.lock', 'toolchain/bun.json', 'scripts/osnova-bun', 'tsconfig.json']]
    return {str(p.relative_to(ROOT)): sha(p) for p in sorted(files)}


def command(args, child_env=None, timeout=40, check=True, cwd=None):
    result = subprocess.run(args, env=child_env or env, cwd=cwd or ROOT, capture_output=True, text=True, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError(redact(result.stderr or result.stdout or 'Command failed'))
    return result


def pg(database, sql):
    return command([DOCKER, 'exec', container, 'psql', '-X', '-A', '-t', '-U', 'osnova', '-d', database, '-v', 'ON_ERROR_STOP=1', '-c', sql]).stdout.strip()


try:
    receipt['hashes_before'] = hashes()
    for relative in receipt['hashes_before']:
        target = BASE / 'snapshot' / (relative + '.snapshot')
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((ROOT / relative).read_bytes())
    qualified = command([str(ROOT / 'scripts/osnova-bun'), '--no-env-file', 'run', 'scripts/bun-toolchain-check.ts', '--receipt'])
    (BASE / 'toolchain.json').write_text(qualified.stdout)
    for platform in ['darwin', 'linux']:
        build = [str(ROOT / 'scripts/osnova-bun'), '--no-env-file', 'build', '--compile']
        if platform == 'linux':
            build += ['--target=bun-linux-arm64-musl']
        build += [str(ROOT / 'ops/record-recovery/probe.ts'), '--outfile', str(scratch / ('probe-' + platform))]
        built = command(build, timeout=120, check=False)
        (BASE / ('build-' + platform + '.log')).write_text(built.stdout + built.stderr)
        receipt['checks']['build-' + platform] = {'exit': built.returncode}
        if built.returncode:
            raise RuntimeError('Probe compile failed: ' + platform)
        receipt['checks']['build-' + platform]['sha256'] = sha(scratch / ('probe-' + platform))
    container = command([DOCKER, 'run', '-d', '--pull=never', '--name', 'osnova-record-recovery-' + run, '--label', label,
                         '--memory', '768m', '--cpus', '2', '--pids-limit', '256', '--restart=no', '--publish', '127.0.0.1::5432',
                         '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data,tmpfs-size=536870912',
                         '--env', 'POSTGRES_USER=osnova', '--env', 'POSTGRES_DB=recovery_control', '--env', 'POSTGRES_PASSWORD', IMAGE],
                        child_env=dict(env, POSTGRES_PASSWORD=passwords[0])).stdout.strip()
    receipt['container_id'] = container
    inspection = json.loads(command([DOCKER, 'inspect', container]).stdout)[0]
    assert inspection['Config']['Labels']['osnova.record-recovery-run'] == run
    assert all(m['Type'] == 'tmpfs' for m in inspection['Mounts'])
    for _ in range(60):
        if command([DOCKER, 'exec', container, 'pg_isready', '-U', 'osnova', '-d', 'recovery_control'], check=False).returncode == 0:
            break
        time.sleep(.5)
    else:
        raise RuntimeError('PostgreSQL startup failed')
    address = command([DOCKER, 'port', container, '5432/tcp']).stdout.strip()
    assert re.fullmatch(r'127\.0\.0\.1:\d+', address)
    receipt['binding'] = address
    (scratch / 'openssl.cnf').write_text('[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=v3\n[dn]\nCN=localhost\n[v3]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n')
    command(['/usr/bin/openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', str(scratch / 'openssl.cnf'), '-keyout', str(scratch / 'server.key'), '-out', str(scratch / 'server.crt')])
    (BASE / 'server-ca.pem').write_bytes((scratch / 'server.crt').read_bytes())
    for file in ['server.key', 'server.crt']:
        command([DOCKER, 'cp', str(scratch / file), container + ':/tmp/' + file])
        command([DOCKER, 'exec', '--user', 'root', container, 'chown', 'postgres:postgres', '/tmp/' + file])
        command([DOCKER, 'exec', '--user', 'root', container, 'chmod', '600', '/tmp/' + file])
    for setting in ["ssl_cert_file='/tmp/server.crt'", "ssl_key_file='/tmp/server.key'", 'ssl=on']:
        pg('recovery_control', 'ALTER SYSTEM SET ' + setting)
    pg('recovery_control', 'SELECT pg_reload_conf()')
    pg('recovery_control', f"CREATE ROLE worker LOGIN NOSUPERUSER PASSWORD '{passwords[1]}'")
    receipt['postgres_version'] = pg('recovery_control', 'SELECT version()')
    for platform in ['darwin', 'linux']:
        database = 'recovery_' + run + '_' + platform
        pg('recovery_control', f'CREATE DATABASE "{database}" OWNER worker')
        for mode in ['exercise', 'restart']:
            child_env = dict(env, OSNOVA_RECORD_RECOVERY='owned-disposable-v1',
                             OSNOVA_PG_URL=f'postgres://worker:{passwords[1]}@{"127.0.0.1:5432" if platform == "linux" else address}/{database}',
                             OSNOVA_RECORD_CA='/qual/ca.pem' if platform == 'linux' else str(scratch / 'server.crt'))
            binary = scratch / ('probe-' + platform)
            args = [str(binary), mode]
            if platform == 'linux':
                args = [DOCKER, 'run', '--rm', '--pull=never', '--label', label, '--network', 'container:' + container,
                        '--read-only', '--cap-drop=ALL', '--security-opt', 'no-new-privileges', '--user', 'postgres',
                        '--memory', '512m', '--cpus', '1', '--pids-limit', '96', '--tmpfs', '/tmp:size=134217728',
                        '--mount', f'type=bind,src={binary},dst=/qual/probe,readonly',
                        '--mount', f'type=bind,src={scratch / "server.crt"},dst=/qual/ca.pem,readonly', '--workdir', '/tmp',
                        '--env', 'OSNOVA_RECORD_RECOVERY', '--env', 'OSNOVA_PG_URL', '--env', 'OSNOVA_RECORD_CA', '--entrypoint', '/qual/probe', IMAGE, mode]
            start = time.monotonic()
            result = command(args, child_env, timeout=120, check=False, cwd=scratch)
            (BASE / f'{platform}-{mode}.log').write_text(redact(result.stdout + result.stderr))
            events = []
            for line in result.stdout.splitlines():
                try:
                    events.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
            receipt['checks'][f'{platform}-{mode}'] = {'exit': result.returncode, 'seconds': time.monotonic() - start, 'events': events}
            print(platform, mode, result.returncode, json.dumps(events[-1] if events else {}), flush=True)
            if result.returncode:
                raise RuntimeError(f'{platform}-{mode} failed')
    receipt['status'] = 'PASS'
except Exception as error:
    receipt['status'] = 'FAIL'
    receipt['error'] = redact(str(error))
    print('FAIL', receipt['error'], flush=True)
finally:
    cleanup = command([DOCKER, 'ps', '-aq', '--filter', 'label=' + label], check=False)
    if cleanup.returncode == 0:
        for owned in cleanup.stdout.split():
            command([DOCKER, 'rm', '-f', owned])
        receipt['remaining_owned_containers'] = command([DOCKER, 'ps', '-aq', '--filter', 'label=' + label]).stdout.split()
    else:
        receipt['cleanup_error'] = redact(cleanup.stderr)
    receipt['hashes_after'] = hashes()
    receipt['source_drift'] = [p for p in set(receipt['hashes_before']) | set(receipt['hashes_after']) if receipt['hashes_before'].get(p) != receipt['hashes_after'].get(p)]
    if receipt.get('remaining_owned_containers') != [] or receipt['source_drift']:
        receipt['status'] = 'FAIL'
    receipt['finished_at'] = datetime.now(timezone.utc).isoformat()
    (BASE / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    scratch_context.cleanup()
raise SystemExit(0 if receipt['status'] == 'PASS' else 1)
