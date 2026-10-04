"""Exercise Agents against an owned, disposable PostgreSQL and the real app binary.

Usage: OSNOVA_BUN_BIN=/qualified/bun python3 ops/agents-module/verify.py RUN [--browser]
The optional browser phase waits for an evidence-directory browser-result.json
containing {"status":"PASS", "checks":[...]} before cleaning up all owned processes.
Never connects to an existing database or downloads a container image.
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

ROOT = Path(__file__).resolve().parents[2]
name = sys.argv[1] if len(sys.argv) > 1 else ""
if not re.fullmatch(r"[a-z0-9-]+", name):
    raise SystemExit("Expected a unique evidence run name")
BASE = ROOT / "docs/audits/agents-module-2026-09-20-evidence" / name
BASE.mkdir(parents=True, exist_ok=False)
env = {k: v for k, v in os.environ.items() if not k.startswith("OSNOVA_") and k not in ("BUN_OPTIONS", "NODE_OPTIONS")}
env["OSNOVA_BUN_BIN"] = os.environ["OSNOVA_BUN_BIN"]
DOCKER = "/usr/local/bin/docker"
IMAGE = "sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73"
run = uuid.uuid4().hex[:12]
label = "osnova.agents-test-run=" + run
passwords = [secrets.token_hex(24), secrets.token_hex(24)]
scratch_owner = tempfile.TemporaryDirectory(prefix="osnova-agents-test-")
scratch = Path(scratch_owner.name)
container = None
children = []
logs = []
receipt = {"run": run, "image": IMAGE, "checks": {}, "scope": "Owned disposable PostgreSQL; real compiled application, ORM, HTTP and Admin UI."}


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


def http(method, path, body=None, token=None, status=200):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request("http://127.0.0.1:3000" + path, data=None if body is None else json.dumps(body).encode(), headers=headers, method=method)
    try:
        response = urllib.request.urlopen(request, timeout=15)
    except urllib.error.HTTPError as error:
        response = error
    raw = response.read().decode()
    assert response.status == status, f"{method} {path}: expected {status}, got {response.status}: {safe(raw)[:1500]}"
    return json.loads(raw) if raw else None


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


try:
    for port in (3000, 4200):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", port))
    bun = [str(ROOT / "scripts/osnova-bun"), "--no-env-file"]
    (BASE / "toolchain.log").write_text(command([*bun, "run", "scripts/bun-toolchain-check.ts", "--receipt"]))
    receipt["app_sha256"] = hashlib.sha256((ROOT / "bin/osnova-app").read_bytes()).hexdigest()
    container = command([DOCKER, "run", "-d", "--pull=never", "--name", "osnova-agents-" + run, "--label", label,
                         "--memory", "768m", "--cpus", "2", "--pids-limit", "256", "--restart=no", "--publish", "127.0.0.1::5432",
                         "--mount", "type=tmpfs,destination=/var/lib/postgresql/data,tmpfs-size=536870912",
                         "--env", "POSTGRES_USER=osnova", "--env", "POSTGRES_DB=control", "--env", "POSTGRES_PASSWORD", IMAGE],
                        dict(env, POSTGRES_PASSWORD=passwords[0])).strip()
    inspect = json.loads(command([DOCKER, "inspect", container]))[0]
    assert inspect["Config"]["Labels"]["osnova.agents-test-run"] == run
    assert all(mount["Type"] == "tmpfs" for mount in inspect["Mounts"])
    for _ in range(120):
        output = command([DOCKER, "logs", container])
        if "init process complete" in output:
            try:
                if pg("control", "SELECT 1") == "1":
                    break
            except RuntimeError:
                pass
        time.sleep(.25)
    else:
        raise RuntimeError("PostgreSQL readiness timed out")
    address = command([DOCKER, "port", container, "5432/tcp"]).strip()
    assert re.fullmatch(r"127\.0\.0\.1:\d+", address)
    pg("control", f"CREATE ROLE worker LOGIN NOSUPERUSER PASSWORD '{passwords[1]}'")
    test_db, preview_db = "agents_test_" + run, "agents_preview_" + run
    for database in (test_db, preview_db):
        pg("control", f'CREATE DATABASE "{database}" OWNER worker')
    pg(preview_db, "CREATE SCHEMA app AUTHORIZATION worker; CREATE SCHEMA product AUTHORIZATION worker")
    receipt["postgres_version"] = pg(test_db, "SELECT version()")
    assert pg(test_db, "SELECT rolsuper FROM pg_roles WHERE rolname='worker'") == "f"
    test_env = dict(env, OSNOVA_AGENTS_TEST_DB="owned-disposable-v1", OSNOVA_AGENTS_PG_URL=f"postgres://worker:{passwords[1]}@{address}/{test_db}")
    (BASE / "postgres-tests.log").write_text(safe(command([*bun, "test", "--timeout", "30000", "--isolate", "./src/app/modules/agents/test/Agents.postgres.live.test.ts"], test_env)))
    receipt["checks"]["postgres_contracts"] = "PASS"
    print("PostgreSQL contracts PASS", flush=True)
    app_env = dict(env, OSNOVA_ENV="development", OSNOVA_HTTP__HOSTNAME="127.0.0.1", OSNOVA_HTTP__PORT="3000",
                   OSNOVA_DB__HOST="127.0.0.1", OSNOVA_DB__PORT=address.split(":")[1], OSNOVA_DB__DATABASE=preview_db,
                   OSNOVA_DB__USERNAME="worker", OSNOVA_DB__PASSWORD=passwords[1], OSNOVA_DB__TLS="disable")
    app = start([str(ROOT / "bin/osnova-app")], app_env, scratch, "app.log")
    ready(app, "http://127.0.0.1:3000/api/admin/auth/bootstrap")
    http("GET", "/api/agents", status=401)
    login = {"email": "agents@example.test", "password": "Local-Agents-Demo-2026!"}
    token = http("POST", "/api/admin/auth/bootstrap", dict(login, name="Agents Demo"))["accessToken"]
    passwords.append(token)
    surface = http("GET", "/api/ui/admin", token=token)
    assert '"agents"' in json.dumps(surface)
    main = http("GET", "/api/agents/main", token=token)
    assert main["id"] == "main" and main["revision"] == 1
    payload = {"id": "http-analyst", "name": "HTTP аналитик", "instructions": "Проверить сохранение", "toolNames": ["agents.getAll"]}
    created = http("POST", "/api/agents", payload, token, 201)
    http("POST", "/api/agents", payload, token, 409)
    updated = http("PUT", "/api/agents/http-analyst", dict(created, name="Изменён", enabled=False), token)
    assert updated["revision"] == 2 and updated["enabled"] is False
    http("PUT", "/api/agents/http-analyst", created, token, 409)
    cleared = http("PUT", "/api/agents/http-analyst", dict(updated, instructions="", toolNames=[], modelProfile=""), token)
    assert cleared["instructions"] == "" and cleared["toolNames"] == []
    http("POST", "/api/agents", {"id": "invalid", "name": ""}, token, 400)
    http("DELETE", "/api/agents/main", token=token, status=409)
    http("DELETE", "/api/agents/http-analyst", token=token, status=204)
    http("GET", "/api/agents/http-analyst", token=token, status=404)
    http("PUT", "/api/agents/main", dict(main, instructions="Инструкции сохраняются после перезапуска."), token)
    stop(app)
    app = start([str(ROOT / "bin/osnova-app")], app_env, scratch, "app.log")
    ready(app, "http://127.0.0.1:3000/api/admin/auth/bootstrap")
    token = http("POST", "/api/admin/auth/login", login)["accessToken"]
    passwords.append(token)
    restored = http("GET", "/api/agents/main", token=token)
    assert restored["revision"] == 2 and restored["instructions"] == "Инструкции сохраняются после перезапуска."
    http("PUT", "/api/agents/main", dict(restored, instructions=main["instructions"]), token)
    receipt["checks"]["binary_http_crud_auth_restart"] = "PASS"
    print("Compiled application HTTP/auth/CRUD/restart PASS", flush=True)
    if "--browser" in sys.argv:
        ui = start([*bun, "run", "admin:ui"], env, ROOT, "admin-ui.log")
        ready(ui, "http://127.0.0.1:4200")
        (BASE / "ready.json").write_text(json.dumps({"url": "http://127.0.0.1:4200", "email": login["email"], "scope": "Disposable preview"}) + "\n")
        print(json.dumps({"event": "ready", "url": "http://127.0.0.1:4200", "evidence": str(BASE)}), flush=True)
        for _ in range(1200):
            result_file = BASE / "browser-result.json"
            if result_file.exists():
                browser = json.loads(result_file.read_text())
                assert browser["status"] == "PASS", "Browser verification failed"
                receipt["checks"]["browser"] = browser
                break
            if app.poll() is not None or ui.poll() is not None:
                raise RuntimeError("Preview process exited during browser verification")
            time.sleep(1)
        else:
            raise RuntimeError("Browser verification timed out")
    receipt["status"] = "PASS"
except Exception as error:
    receipt["status"] = "FAIL"
    receipt["error"] = safe(str(error))
    print(receipt["error"], flush=True)
finally:
    for child in reversed(children):
        stop(child)
    for log in logs:
        log.close()
    owned = command([DOCKER, "ps", "-aq", "--filter", "label=" + label]).split()
    for item in owned:
        command([DOCKER, "rm", "-f", item])
    receipt["remaining_owned_containers"] = command([DOCKER, "ps", "-aq", "--filter", "label=" + label]).split()
    if receipt["remaining_owned_containers"]:
        receipt["status"] = "FAIL"
    for path in BASE.glob("*.log"):
        path.write_text(safe(path.read_text()))
    (BASE / "receipt.json").write_text(json.dumps(receipt, indent=2, ensure_ascii=False) + "\n")
    scratch_owner.cleanup()
raise SystemExit(0 if receipt["status"] == "PASS" else 1)
