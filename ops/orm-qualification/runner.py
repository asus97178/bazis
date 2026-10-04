"""Owned, disposable ORM qualification. Never opens existing application databases."""
from pathlib import Path
from datetime import datetime, timezone
import argparse
import hashlib
import json
import os
import re
import secrets
import subprocess
import tempfile
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('name')
parser.add_argument('--seconds', type=int, default=900)
parser.add_argument('--rate', type=int, default=50)
parser.add_argument('--quick', action='store_true')
parser.add_argument('--autocommit-only', action='store_true')
args = parser.parse_args()
if not re.fullmatch(r'[a-z0-9-]+', args.name) or not 30 <= args.seconds <= 3600 or not 1 <= args.rate <= 500:
    parser.error('Invalid name, duration or rate')
BASE = ROOT / 'docs/audits/orm-enterprise-qualification-2026-09-14-evidence' / args.name
BASE.mkdir(exist_ok=False)
for name in ['PLAN.md', 'probe.ts', 'runner.py']:
    (BASE / name).write_bytes((ROOT / 'ops/orm-qualification' / name).read_bytes())
DOCKER = '/usr/local/bin/docker'
IMAGE = 'sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73'
run = uuid.uuid4().hex[:12]
label = 'osnova.orm-enterprise-run=' + run
passwords = [secrets.token_hex(24) for _ in range(3)]
env = {k: v for k, v in os.environ.items() if not k.startswith('OSNOVA_') and k not in ['BUN_OPTIONS', 'NODE_OPTIONS']}
env['OSNOVA_BUN_BIN'] = os.environ.get('OSNOVA_BUN_BIN', '/private/tmp/osnova-bun-1.4.0-osn018/bun-darwin-aarch64/bun')
receipt = {'started_at': datetime.now(timezone.utc).isoformat(), 'run': run, 'image': IMAGE,
           'authorization': 'User делай after enterprise qualification conditions; disposable resources only.',
           'profile': {'seconds': args.seconds, 'rate': args.rate, 'production_profile_confirmed': False}, 'checks': {}}
commands = []
scratch_context = tempfile.TemporaryDirectory(prefix='osnova-orm-enterprise-')
scratch = Path(scratch_context.name)
container = None


def redact(value):
    for password in passwords:
        value = value.replace(password, '[REDACTED]')
    return value


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def hashes():
    files = [p for folder in ['src/osnova/library/orm', 'src/osnova/core/orm', 'src/app/config', 'src/app/modules/actor_modules/users', 'ops/orm-qualification']
             for p in (ROOT / folder).rglob('*') if p.is_file()]
    files += [ROOT / p for p in ['package.json', 'bun.lock', 'toolchain/bun.json', 'scripts/osnova-bun', 'tsconfig.json']]
    return {str(p.relative_to(ROOT)): sha(p) for p in sorted(files)}


def command(command_args, child_env=None, timeout=30, check=True, cwd=None):
    commands.append(command_args)
    result = subprocess.run(command_args, env=child_env or env, cwd=cwd or ROOT, capture_output=True, text=True, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError(redact(result.stderr or result.stdout or 'Command failed'))
    return result


def pg(database, sql):
    return command([DOCKER, 'exec', container, 'psql', '-X', '-A', '-t', '-U', 'osnova', '-d', database, '-v', 'ON_ERROR_STOP=1', '-c', sql]).stdout.strip()


def client(mode, platform, database, address):
    binary = scratch / ('probe-linux' if platform == 'linux' else 'probe-darwin')
    client_env = dict(env, OSNOVA_ORM_ENTERPRISE_LIVE='owned-disposable-v1', OSNOVA_ORM_SERVER_CANCELLATION_LIVE='owned-disposable-v1',
                      OSNOVA_PG_URL=f'postgres://worker:{passwords[1]}@{address}/{database}',
                      OSNOVA_SERVER_CANCEL_OTHER_URL=f'postgres://other_worker:{passwords[2]}@{address}/{database}',
                      OSNOVA_SERVER_CANCEL_CA=str(scratch / 'server.crt'), OSNOVA_ORM_SOAK_SECONDS=str(args.seconds), OSNOVA_ORM_SOAK_RATE=str(args.rate))
    if platform == 'linux':
        client_env['OSNOVA_SERVER_CANCEL_CA'] = '/qual/ca.pem'
        command_args = [DOCKER, 'run', '--rm', '--pull=never', '--name', f'osnova-orm-ent-{run}-{mode}', '--label', label,
                        '--network', 'container:' + container, '--read-only', '--cap-drop=ALL', '--security-opt', 'no-new-privileges',
                        '--user', 'postgres', '--memory', '512m', '--cpus', '1', '--pids-limit', '96', '--tmpfs', '/tmp:size=134217728',
                        '--mount', f'type=bind,src={binary},dst=/qual/probe,readonly',
                        '--mount', f'type=bind,src={scratch / "server.crt"},dst=/qual/ca.pem,readonly', '--workdir', '/tmp']
        for key in client_env:
            if key.startswith('OSNOVA_') and key != 'OSNOVA_BUN_BIN':
                command_args += ['--env', key]
        command_args += ['--entrypoint', '/qual/probe', IMAGE, mode]
    else:
        command_args = [str(binary), mode]
    start = time.monotonic()
    name = platform + '-' + mode
    if mode == 'soak':
        commands.append(command_args)
        process = subprocess.Popen(command_args, env=client_env, cwd=scratch, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        watchdog = threading.Timer(args.seconds + 120, process.kill)
        watchdog.start()
        lines = []
        try:
            with (BASE / (name + '.log')).open('w') as output_file:
                for line in process.stdout:
                    safe = redact(line); lines.append(safe); output_file.write(safe); output_file.flush()
            result = subprocess.CompletedProcess(command_args, process.wait(timeout=10), ''.join(lines), '')
        finally:
            watchdog.cancel()
            if process.poll() is None:
                process.kill(); process.wait(timeout=10)
        output = result.stdout
    else:
        result = command(command_args, child_env=client_env, timeout=240, check=False, cwd=scratch)
        output = redact(result.stdout + result.stderr)
        (BASE / (name + '.log')).write_text(output)
    rows = []
    for line in result.stdout.splitlines():
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    receipt['checks'][name] = {'exit': result.returncode, 'seconds': time.monotonic() - start, 'rows': rows, 'executable_sha256': sha(binary)}
    print(name, result.returncode, json.dumps(rows[-1] if rows else {'output': output[-1000:]}), flush=True)
    if mode == 'fingerprint':
        fp = rows[-1]
        assert result.returncode == 0 and fp == {'event': 'fingerprint', 'version': '1.4.0', 'revision': '34cbb9a40b4bd1bd767d134a7065e66c2432a676', 'platform': platform, 'arch': 'arm64'}
    return result.returncode


try:
    receipt['hashes_before'] = hashes()
    for relative in receipt['hashes_before']:
        target = BASE / 'snapshot' / (relative + '.snapshot')
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((ROOT / relative).read_bytes())
    qualified = command([str(ROOT / 'scripts/osnova-bun'), '--no-env-file', 'run', 'scripts/bun-toolchain-check.ts', '--receipt'])
    (BASE / 'toolchain.json').write_text(qualified.stdout)
    for platform in ['linux', 'darwin']:
        build_args = [str(ROOT / 'scripts/osnova-bun'), '--no-env-file', 'build', '--compile']
        if platform == 'linux':
            build_args += ['--target=bun-linux-arm64-musl']
        build_args += [str(ROOT / 'ops/orm-qualification/probe.ts'), '--outfile', str(scratch / ('probe-' + platform))]
        result = command(build_args, timeout=120)
        (BASE / ('build-' + platform + '.log')).write_text(result.stdout + result.stderr)
        receipt['checks']['build-' + platform] = {'exit': result.returncode, 'sha256': sha(scratch / ('probe-' + platform))}
    container = command([DOCKER, 'run', '-d', '--pull=never', '--name', 'osnova-orm-ent-' + run, '--label', label,
                         '--memory', '768m', '--cpus', '2', '--pids-limit', '256', '--restart=no', '--publish', '127.0.0.1::5432',
                         '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data,tmpfs-size=536870912',
                         '--env', 'POSTGRES_USER=osnova', '--env', 'POSTGRES_DB=orm_audit', '--env', 'POSTGRES_PASSWORD', IMAGE], child_env=dict(env, POSTGRES_PASSWORD=passwords[0])).stdout.strip()
    receipt['container_id'] = container
    inspection = json.loads(command([DOCKER, 'inspect', container]).stdout)[0]
    assert inspection['Config']['Labels']['osnova.orm-enterprise-run'] == run
    assert all(m['Type'] == 'tmpfs' for m in inspection['Mounts'])
    receipt['server_resources'] = {key: inspection['HostConfig'][key] for key in ['Memory', 'NanoCpus', 'PidsLimit']}
    for _ in range(60):
        if command([DOCKER, 'exec', container, 'pg_isready', '-U', 'osnova', '-d', 'orm_audit'], check=False).returncode == 0:
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
        pg('orm_audit', 'ALTER SYSTEM SET ' + setting)
    pg('orm_audit', 'SELECT pg_reload_conf()')
    pg('orm_audit', f"CREATE ROLE worker LOGIN NOSUPERUSER PASSWORD '{passwords[1]}'")
    pg('orm_audit', f"CREATE ROLE other_worker LOGIN NOSUPERUSER PASSWORD '{passwords[2]}'")
    database = 'cancel_' + run
    pg('orm_audit', f'CREATE DATABASE "{database}" OWNER worker')
    receipt['postgres_version'] = pg(database, 'SELECT version()')
    print(receipt['postgres_version'], flush=True)
    client('fingerprint', 'linux', database, '127.0.0.1:5432')
    client('fingerprint', 'darwin', database, address)
    modes = [('linux', 'autocommit'), ('darwin', 'autocommit')] if args.autocommit_only else ([('linux', 'business'), ('linux', 'soak')] if args.quick else [('linux', 'matrix'), ('linux', 'business'), ('darwin', 'business'), ('darwin', 'matrix'), ('linux', 'autocommit'), ('darwin', 'autocommit'), ('linux', 'soak')])
    for platform, mode in modes:
        print('starting', platform, mode, flush=True)
        mode_exit = client(mode, platform, database, '127.0.0.1:5432' if platform == 'linux' else address)
        for _ in range(60):
            remaining = int(pg(database, "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()"))
            if remaining == 0:
                break
            time.sleep(.2)
        receipt['checks'][platform + '-' + mode]['sessions_after_cleanup'] = remaining
        receipt['checks'][platform + '-' + mode]['fresh_select'] = pg(database, 'SELECT 1')
        if mode_exit and not args.quick:
            break
    receipt['overall_exit'] = 0 if all(row['exit'] == 0 and row.get('sessions_after_cleanup', 0) == 0 for row in receipt['checks'].values()) else 1
except Exception as error:
    receipt['overall_exit'] = 1
    receipt['error'] = redact(str(error))
    print('ERROR', receipt['error'], flush=True)
finally:
    cleanup_errors = []
    own = command([DOCKER, 'ps', '-aq', '--filter', 'label=' + label], check=False).stdout.split()
    for ident in own:
        info = json.loads(command([DOCKER, 'inspect', ident]).stdout)[0]
        if info['Config']['Labels'].get('osnova.orm-enterprise-run') == run:
            removed = command([DOCKER, 'rm', '-f', ident], check=False)
            if removed.returncode:
                cleanup_errors.append(ident)
    remaining = command([DOCKER, 'ps', '-aq', '--filter', 'label=' + label], check=False).stdout.split()
    scratch_context.cleanup()
    receipt['cleanup'] = {'containers_remaining': len(remaining), 'errors': cleanup_errors, 'persistent_volumes_created': 0, 'temporary_keys_and_binaries_removed': True}
    receipt['hashes_after'] = hashes()
    receipt['source_drift'] = [p for p, digest in receipt.get('hashes_before', {}).items() if receipt['hashes_after'].get(p) != digest]
    if remaining or cleanup_errors or receipt['source_drift']:
        receipt['overall_exit'] = 1
    receipt['finished_at'] = datetime.now(timezone.utc).isoformat()
    (BASE / 'commands.json').write_text(redact(json.dumps(commands, indent=2)) + '\n')
    receipt['log_sha256'] = {p.name: sha(p) for p in BASE.glob('*.log')}
    (BASE / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'exit': receipt['overall_exit'], 'cleanup': receipt['cleanup'], 'source_drift': receipt['source_drift'], 'evidence': str(BASE)}), flush=True)
raise SystemExit(receipt['overall_exit'])
