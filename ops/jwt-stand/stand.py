#!/usr/bin/env python3
"""Create and operate only the workspace's private JWT Docker stand."""
import argparse
import datetime
import hashlib
import http.client
import json
import math
import os
from pathlib import Path
import posixpath
import re
import secrets
import shutil
import socket
import ssl
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / ".cache/jwt-stand"
IMAGE = "postgres@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685"
LABEL = "osnova.jwt-stand"
DOCKER = "/Applications/Docker.app/Contents/Resources/bin/docker"
BINARIES = ("app", "client", "peer", "probe", "proxy")
BINARY_SERVICES = ("app-a", "app-b", "load", "peer", "proxy")
ARTIFACT_LABEL = "osnova.jwt-artifact"


def covers_binaries(destination):
    path = posixpath.normpath("/" + str(destination).lstrip("/"))
    return path in ("/", "/stand", "/stand/bin") or path.startswith("/stand/bin/")


def native_compose(compose, image_id):
    """Keep the deployment policy; remove only the old executable bind mount."""
    result = json.loads(json.dumps(compose))
    old_mount = f"{RUNTIME / 'bin'}:/stand/bin:ro"
    for name in BINARY_SERVICES:
        service = result["services"][name]
        service["image"] = image_id
        service["volumes"] = [mount for mount in service.get("volumes", []) if mount != old_mount]
        for mount in service["volumes"]:
            target = mount.get("target", "") if isinstance(mount, dict) else mount.split(":")[1]
            require(not covers_binaries(target), "Mount would hide packaged stand binaries")
    return result


def require(value, message):
    if not value:
        raise RuntimeError(message)


class Stand:
    def __init__(self, args):
        self.args = args
        self.state_path = RUNTIME / "state.json"
        self.state = json.loads(self.state_path.read_text()) if self.state_path.exists() else None
        if self.state:
            require(self.state.get("schema") == "osnova.jwt-stand/v1" and re.fullmatch(r"[a-f0-9]{12}", self.state.get("id", "")), "Invalid stand state")
            require(self.state.get("project") == "osnova-jwt-stand-" + self.state["id"], "Invalid project identity")
        self.environment = {"PATH": "/usr/bin:/bin", "HOME": os.environ["HOME"]}

    def save(self):
        temp = self.state_path.with_suffix(".new")
        temp.write_text(json.dumps(self.state, indent=2) + "\n")
        temp.chmod(0o600)
        temp.replace(self.state_path)

    def run(self, arguments, *, name=None, timeout=90, accept_failure=False, build=False):
        environment = dict(self.environment)
        if build:
            environment["OSNV_BUN_BIN"] = str(Path(self.args.bun).resolve())
        process = subprocess.run([str(arg) for arg in arguments], cwd=ROOT, env=environment,
                                 stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout)
        output = process.stdout.decode(errors="replace")
        if name:
            (RUNTIME / "evidence" / (name + ".stdout")).write_text(output)
            (RUNTIME / "evidence" / (name + ".stderr")).write_text(process.stderr.decode(errors="replace"))
        require(accept_failure or process.returncode == 0,
                f"Command failed ({process.returncode}): {name or ' '.join(str(arg) for arg in arguments[:4])}; see stand evidence")
        return process.returncode, output

    def compose(self, *arguments, **options):
        require(self.state is not None, "Create the stand first")
        return self.run([DOCKER, "compose", "--project-name", self.state["project"], "--file", RUNTIME / "compose.json", *arguments], **options)

    def owned(self):
        require(self.state is not None, "Create the stand first")
        selector = "label=com.docker.compose.project=" + self.state["project"]
        for kind, listing in [("container", ["ps", "-aq"]), ("volume", ["volume", "ls", "-q"]), ("network", ["network", "ls", "-q"])]:
            _, text = self.run([DOCKER, *listing, "--filter", selector])
            for resource in text.splitlines():
                command = [DOCKER, "inspect"] if kind == "container" else [DOCKER, kind, "inspect"]
                _, raw = self.run([*command, resource])
                value = json.loads(raw)[0]
                labels = value["Config"].get("Labels", {}) if kind == "container" else value.get("Labels", {})
                require(labels.get(LABEL) == self.state["id"], "Resource owner mismatch; operation blocked")

    def binary_digests(self):
        expected = self.state.get("binaries", {})
        require(set(expected) == set(BINARIES), "Expected exactly five qualified stand binaries")
        actual = {name: hashlib.sha256((RUNTIME / "bin" / name).read_bytes()).hexdigest() for name in BINARIES}
        require(actual == expected, "Stand binary changed")
        return actual

    def check_binary_image(self):
        record = self.state.get("binaryImage")
        require(record and re.fullmatch(r"sha256:[a-f0-9]{64}", record.get("id", "")), "Package the stand binaries first: stand.py package")
        require(record.get("binaries") == self.binary_digests(), "Image binary manifest differs from stand")
        require(record.get("manifestSha256") == hashlib.sha256(json.dumps(record["binaries"], sort_keys=True).encode()).hexdigest(),
                "Binary image manifest digest mismatch")
        _, raw = self.run([DOCKER, "image", "inspect", record["id"]])
        value = json.loads(raw)[0]
        labels = value["Config"].get("Labels", {})
        require(value["Id"] == record["id"] and labels.get(LABEL) == self.state["id"] and
                labels.get(ARTIFACT_LABEL) == "runtime" and labels.get("osnova.jwt-manifest") == record["manifestSha256"],
                "Binary image owner or manifest mismatch")
        return record

    def build_binary_image(self):
        digests = self.binary_digests()
        require(self.state["image"] == IMAGE, "Unexpected stand base image")
        manifest = hashlib.sha256(json.dumps(digests, sort_keys=True).encode()).hexdigest()
        tag = self.state["project"] + ":bin-" + manifest[:16]
        # The context contains only qualified executables, never config, TLS keys or credentials.
        with tempfile.TemporaryDirectory(prefix="image-", dir=RUNTIME) as directory:
            context = Path(directory)
            (context / "bin").mkdir()
            for name in BINARIES:
                shutil.copyfile(RUNTIME / "bin" / name, context / "bin" / name)
                require(hashlib.sha256((context / "bin" / name).read_bytes()).hexdigest() == digests[name], "Binary changed while packaging")
            (context / "Dockerfile").write_text(f'FROM {IMAGE}\nLABEL {LABEL}="{self.state["id"]}" {ARTIFACT_LABEL}="runtime" osnova.jwt-manifest="{manifest}"\nCOPY --chmod=0555 bin/ /stand/bin/\n')
            self.run([DOCKER, "build", "--network=none", "--pull=false", "--tag", tag, context], name="package-build", timeout=240)
        _, raw = self.run([DOCKER, "image", "inspect", tag])
        image_id = json.loads(raw)[0]["Id"]
        command = [DOCKER, "run", "--rm", "--network", "none", "--read-only", "--cpus", "1", "--memory", "256m",
                   "--label", LABEL + "=" + self.state["id"], "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                   "--user", f"{os.getuid()}:{os.getgid()}"]
        _, hashes = self.run([*command, "--entrypoint", "sha256sum", image_id, *["/stand/bin/" + name for name in BINARIES]], name="package-digests")
        packaged = {Path(path).name: digest for digest, path in (line.split() for line in hashes.splitlines())}
        require(packaged == digests, "Packaged binary digest mismatch")
        self.run([*command, "--entrypoint", "/stand/bin/probe", image_id], name="package-linux-qualification")
        return {"id": image_id, "tag": tag, "manifestSha256": manifest, "binaries": digests}

    def package(self):
        self.owned()
        compose_path = RUNTIME / "compose.json"
        original = compose_path.read_text()
        original_state = self.state_path.read_text()
        record = self.build_binary_image()
        candidate = native_compose(json.loads(original), record["id"])
        with tempfile.TemporaryDirectory(prefix="compose-", dir=RUNTIME) as directory:
            path = Path(directory) / "compose.json"
            path.write_text(json.dumps(candidate, indent=2) + "\n")
            self.run([DOCKER, "compose", "--project-name", self.state["project"], "--file", path, "config", "--quiet"])
            require(compose_path.read_text() == original and self.state_path.read_text() == original_state, "Stand changed during packaging; retry after the other operator completes")
            backup = RUNTIME / "evidence" / ("package-before-" + str(time.time_ns()))
            backup.mkdir(mode=0o700)
            (backup / "compose.json").write_text(original)
            (backup / "state.json").write_text(original_state)
            old_state = self.state
            try:
                path.replace(compose_path)
                self.state = {**old_state, "binaryImage": record}
                self.save()
            except Exception:
                compose_path.write_text(original)
                self.state = old_state
                self.save()
                raise
        print(json.dumps({"status": "PACKAGED", "image": record["id"], "backup": str(backup), "next": "start, then verify and test"}, indent=2))

    def create(self):
        require(self.state is None and not RUNTIME.exists(), "Stand files already exist; use status/start, do not overwrite credentials")
        require(self.args.bun and Path(self.args.bun).is_absolute(), "create requires --bun with the qualified absolute path")
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", self.args.port))
        RUNTIME.mkdir(parents=True, mode=0o700)
        for directory in ["bin", "certs", "secrets", "evidence"]:
            (RUNTIME / directory).mkdir(mode=0o700)
        identity = secrets.token_hex(6)
        self.state = {"schema": "osnova.jwt-stand/v1", "id": identity, "project": "osnova-jwt-stand-" + identity,
                      "url": f"https://localhost:{self.args.port}", "port": self.args.port, "phase": "preparing", "image": IMAGE,
                      "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}
        self.save()
        wrapper = ROOT / "scripts/osnova-bun"
        self.run([wrapper, "run", "scripts/bun-toolchain-check.ts", "--receipt"], name="build-toolchain", build=True)
        self.run([wrapper, "run", "di:generate", "--target", "production"], name="codegen", timeout=120, build=True)
        source_paths = list((ROOT / "src").rglob("*.ts")) + list((ROOT / "ops/jwt-stand").glob("*.ts"))
        source_paths += [ROOT / name for name in ["package.json", "bun.lock", "tsconfig.json", "toolchain/bun.json", "scripts/osnova-bun", "scripts/bun-toolchain-check.ts"]]
        sources = {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(source_paths)}
        (RUNTIME / "evidence/sources.json").write_text(json.dumps(sources, indent=2))
        for name, source in [("probe", "probe.ts"), ("client", "client.ts"), ("proxy", "proxy.ts"), ("peer", "peer.ts"), ("app", None)]:
            entry = ROOT / "src/index.ts" if source is None else ROOT / "ops/jwt-stand" / source
            self.run([wrapper, "build", "--compile", "--target=bun-linux-arm64-musl", entry, "--outfile", RUNTIME / "bin" / name],
                     name="build-" + name, timeout=120, build=True)
        changed = [path for path, digest in sources.items() if hashlib.sha256((ROOT / path).read_bytes()).hexdigest() != digest]
        require(not changed, "Sources changed during compilation; stand not started")
        self.state["binaries"] = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (RUNTIME / "bin").iterdir()}
        _, info = self.run([DOCKER, "info", "--format", '{"cpus":{{.NCPU}},"memory":{{.MemTotal}},"kernel":{{json .KernelVersion}},"arch":{{json .Architecture}}}'])
        self.state["docker"] = json.loads(info)
        require(self.state["docker"]["cpus"] >= 10, "Stand CPU layout requires 10 Docker logical CPUs")
        self.run([DOCKER, "image", "inspect", IMAGE], name="image")
        self.run([DOCKER, "run", "--rm", "--network", "none", "--read-only", "--cpus", "1", "--memory", "256m",
                  "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", f"{os.getuid()}:{os.getgid()}",
                  "--mount", f"type=bind,source={RUNTIME / 'bin/probe'},target=/probe,readonly", "--entrypoint", "/probe", IMAGE], name="linux-qualification")
        self.state["binaryImage"] = self.build_binary_image()
        self.save()
        self.configure()
        self.state["phase"] = "created"
        self.save()
        self.start()
        self.verify()

    def secret(self, name, content):
        path = RUNTIME / "secrets" / name
        path.write_text(content)
        path.chmod(0o600)
        return path

    def configure(self):
        certificates = RUNTIME / "certs"
        config = certificates / "openssl.cnf"
        config.write_text("[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=IP:127.0.0.1,DNS:localhost,DNS:proxy,DNS:postgres\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n")
        self.run(["/usr/bin/openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "30", "-config", config,
                  "-keyout", certificates / "server.key", "-out", certificates / "server.crt"], name="certificate")
        (certificates / "server.key").chmod(0o600)
        (certificates / "server.crt").chmod(0o644)
        password = secrets.token_urlsafe(32)
        self.secret("postgres-password", password)
        self.secret("admin.json", json.dumps({"name": "JWT Stand", "email": "jwt-stand@example.test", "password": secrets.token_urlsafe(32)}))
        jwt = {"issuer": "osnova-jwt-stand", "clockSkewSeconds": 0}
        for kind in ["admin", "client", "partner", "employee", "system"]:
            jwt[kind] = {"secret": secrets.token_urlsafe(48)}
        jwt["admin"] = {"keyMode": "ring", "secret": json.dumps({"version": 1, "activeKeyId": "stand-active",
                        "keys": [{"keyId": "stand-active", "alg": "HS256", "secret": secrets.token_urlsafe(48)}], "revokedKeyIds": []})}
        application = {"http": {"hostname": "0.0.0.0", "port": 3000, "corsOrigins": ""}, "jwt": jwt,
                       "db": {"host": "postgres", "port": 5432, "database": "jwtstand", "username": "jwtstand", "password": password,
                              "tls": "verify-full", "max": 8, "connectionTimeout": 3},
                       "llm": {"baseUrl": "http://peer:3100/v1", "model": "synthetic-model", "apiKey": secrets.token_urlsafe(24)},
                       "sms_ru": {"base_url": "http://peer:3100", "api_id": secrets.token_urlsafe(24)}}
        self.secret("app.json", json.dumps(application))
        labels = {LABEL: self.state["id"]}
        def common(cpu, quota, memory):
            return {"image": IMAGE, "labels": labels, "cpuset": cpu, "cpus": quota, "mem_limit": memory,
                    "memswap_limit": memory, "pids_limit": 128, "networks": ["stand"], "restart": "unless-stopped",
                    "logging": {"driver": "json-file", "options": {"max-size": "10m", "max-file": "3"}}}
        def binary(name, cpu, quota, memory):
            return {**common(cpu, quota, memory), "image": self.state["binaryImage"]["id"], "user": f"{os.getuid()}:{os.getgid()}", "read_only": True,
                    "cap_drop": ["ALL"], "security_opt": ["no-new-privileges:true"], "tmpfs": ["/tmp:rw,size=64m"],
                    "working_dir": "/stand", "entrypoint": ["/stand/bin/" + name],
                    "environment": {"OSNV_ENV": "production", "NODE_EXTRA_CA_CERTS": "/stand/certs/server.crt"},
                    "volumes": [f"{certificates / 'server.crt'}:/stand/certs/server.crt:ro"]}
        healthy = lambda names: {name: {"condition": "service_healthy"} for name in names}
        check = lambda url: {"test": ["CMD", "/stand/bin/client", "health", "--url=" + url], "interval": "5s", "timeout": "6s", "retries": 6, "start_period": "20s"}
        services = {}
        services["postgres"] = {**common("4-5", 1.5, "768m"),
            "environment": {"POSTGRES_USER": "jwtstand", "POSTGRES_DB": "jwtstand", "POSTGRES_PASSWORD_FILE": "/run/secrets/postgres-password"},
            "volumes": ["postgres_data:/var/lib/postgresql/data", f"{RUNTIME / 'secrets/postgres-password'}:/run/secrets/postgres-password:ro", f"{certificates}:/certs:ro"],
            "entrypoint": ["/bin/sh", "-ec"],
            "command": ["cp /certs/server.key /tmp/jwt.key && cp /certs/server.crt /tmp/jwt.crt && chown postgres:postgres /tmp/jwt.* && chmod 600 /tmp/jwt.key && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/jwt.crt -c ssl_key_file=/tmp/jwt.key"],
            "healthcheck": {"test": ["CMD", "pg_isready", "-U", "jwtstand", "-d", "jwtstand"], "interval": "3s", "timeout": "3s", "retries": 15}}
        services["peer"] = {**binary("peer", "9", .25, "128m"),
                            "healthcheck": {"test": ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:3100/v1/models"], "interval": "5s", "timeout": "3s", "retries": 5}}
        for name, cpu in [("app-a", "0-1"), ("app-b", "2-3")]:
            services[name] = {**binary("app", cpu, 1.5, "512m"), "command": ["--environment=production", "--config-file=/stand/config.json"],
                              "depends_on": healthy(["postgres", "peer"] + (["app-a"] if name == "app-b" else [])), "healthcheck": check("http://127.0.0.1:3000")}
            services[name]["volumes"].append(f"{RUNTIME / 'secrets/app.json'}:/stand/config.json:ro")
        services["proxy"] = {**binary("proxy", "6", .8, "256m"), "depends_on": healthy(["app-a", "app-b"]),
                             "ports": [f"127.0.0.1:{self.args.port}:8443"], "healthcheck": check("https://127.0.0.1:8443")}
        services["proxy"]["volumes"].append(f"{certificates / 'server.key'}:/stand/certs/server.key:ro")
        services["proxy"]["networks"] = ["stand", "edge"]
        services["load"] = {**binary("client", "7-8", 1.5, "512m"), "entrypoint": ["/bin/sleep", "infinity"],
                            "depends_on": healthy(["proxy"]), "healthcheck": check("https://proxy:8443")}
        services["load"]["volumes"].append(f"{RUNTIME / 'secrets/admin.json'}:/stand/secrets/admin.json:ro")
        compose = {"services": services, "networks": {"stand": {"internal": True, "labels": labels},
                   "edge": {"labels": labels, "driver_opts": {"com.docker.network.bridge.host_binding_ipv4": "127.0.0.1"}}},
                   "volumes": {"postgres_data": {"labels": labels}}}
        (RUNTIME / "compose.json").write_text(json.dumps(compose, indent=2) + "\n")
        self.compose("config", "--quiet", name="compose-validation")

    def start(self):
        self.owned()
        record = self.check_binary_image()
        configured = json.loads((RUNTIME / "compose.json").read_text())
        require(configured == native_compose(configured, record["id"]), "Compose differs from packaged binary image")
        self.compose("up", "--detach", "--wait", "--wait-timeout", "90", name="start", timeout=120)
        self.state["phase"] = "running"
        self.save()
        self.tls_status()

    def tls_status(self):
        context = ssl.create_default_context(cafile=str(RUNTIME / "certs/server.crt"))
        client = http.client.HTTPSConnection("127.0.0.1", self.state["port"], context=context, timeout=8)
        try:
            client.request("GET", "/__stand/status")
            response = client.getresponse()
            data = json.loads(response.read())
            require(response.status == 200 and data["ready"], "TLS proxy or replicas not ready")
            self.state["replicas"] = data["replicas"]
        finally:
            client.close()
        self.save()

    def status(self):
        self.owned()
        _, ids = self.compose("ps", "--all", "--quiet")
        containers = []
        if ids.strip():
            _, raw = self.run([DOCKER, "inspect", *ids.splitlines()])
            for value in json.loads(raw):
                config, host, state = value["Config"], value["HostConfig"], value["State"]
                containers.append({"service": config["Labels"]["com.docker.compose.service"], "state": state["Status"],
                    "health": state.get("Health", {}).get("Status"), "cpuset": host["CpusetCpus"],
                    "cpuLimit": host["NanoCpus"] / 1e9, "memoryBytes": host["Memory"], "restartCount": value["RestartCount"],
                    "publishedPorts": value["NetworkSettings"].get("Ports", {}),
                    "nativeBinaryImage": value["Image"] == self.state.get("binaryImage", {}).get("id") and
                        not any(covers_binaries(mount["Destination"]) for mount in value.get("Mounts", []))})
        binary_services = [item for item in containers if item["service"] in BINARY_SERVICES]
        native_ready = (len(binary_services) == len(BINARY_SERVICES) and
                        {item["service"] for item in binary_services} == set(BINARY_SERVICES) and
                        all(item["nativeBinaryImage"] for item in binary_services))
        mappings = [(item["service"], port, binding["HostIp"], binding["HostPort"]) for item in containers
                    for port, bindings in item["publishedPorts"].items() for binding in (bindings or [])]
        mapping_ok = mappings == [("proxy", "8443/tcp", "127.0.0.1", str(self.state["port"]))]
        tls_ready = False
        if mapping_ok:
            try:
                self.tls_status()
                tls_ready = True
            except (OSError, RuntimeError, ValueError):
                pass
        result = {"project": self.state["project"], "url": self.state["url"], "phase": self.state["phase"], "services": containers,
                  "loopbackPublication": mapping_ok, "hostTlsReady": tls_ready, "nativeBinariesReady": native_ready,
                  "lastLoad": self.state.get("lastLoad"), "lastFullLoad": self.state.get("lastFullLoad"),
                  "lastFullLoadMatchesImage": bool(self.state.get("binaryImage")) and self.state.get("lastFullLoad", {}).get("binaryImageId") == self.state["binaryImage"]["id"],
                  "ready": mapping_ok and tls_ready and native_ready and len(containers) == 6 and all(item["state"] == "running" and item["health"] == "healthy" for item in containers)}
        (RUNTIME / "evidence/status.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result, indent=2))
        return result

    def verify(self):
        self.check_binary_image()
        status = self.status()
        require(status["ready"], "Stand is not ready")
        expected = {"app-a": ("0-1", 1.5, 512), "app-b": ("2-3", 1.5, 512), "postgres": ("4-5", 1.5, 768),
                    "proxy": ("6", .8, 256), "load": ("7-8", 1.5, 512), "peer": ("9", .25, 128)}
        for item in status["services"]:
            cpu, limit, memory = expected[item["service"]]
            require((item["cpuset"], item["cpuLimit"], item["memoryBytes"]) == (cpu, limit, memory * 1024 * 1024), "CPU/RAM policy differs from expected")
        self.compose("exec", "-T", "load", "/stand/bin/client", "smoke", name="smoke", timeout=45)
        for replica in ["app-a", "app-b"]:
            self.compose("exec", "-T", "load", "/stand/bin/client", "smoke", "--url=http://" + replica + ":3000", name="smoke-" + replica, timeout=45)
        _, raw = self.compose("exec", "-T", "postgres", "psql", "-X", "-U", "jwtstand", "-d", "jwtstand", "-Atc",
                "SELECT json_build_object('connections',count(*),'tls',count(*) FILTER(WHERE ssl)) FROM pg_stat_ssl s JOIN pg_stat_activity a USING(pid) WHERE a.datname='jwtstand' AND a.client_addr IS NOT NULL", name="postgres-tls")
        pg_tls = json.loads(raw)
        require(pg_tls["connections"] >= 2 and pg_tls["connections"] == pg_tls["tls"], "PostgreSQL TLS not confirmed")
        untrusted = http.client.HTTPSConnection("127.0.0.1", self.state["port"], timeout=5)
        try:
            untrusted.request("GET", "/health")
            raise RuntimeError("Untrusted stand certificate accepted")
        except ssl.SSLCertVerificationError:
            pass
        finally:
            untrusted.close()
        result = {"status": "PASS", "checks": ["both replicas", "loopback-only publication", "CPU/RAM layout",
                  "trusted TLS", "untrusted TLS rejection", "bootstrap/login", "protected access", "bad JWT 401", "refresh", "active kid", "PostgreSQL TLS"], "postgres": pg_tls,
                  "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}
        (RUNTIME / "evidence/verification.json").write_text(json.dumps(result, indent=2) + "\n")
        self.state["lastVerify"] = result
        self.save()
        print(json.dumps(result, indent=2))

    def stop(self):
        self.owned()
        self.compose("stop", "--timeout", "15", name="stop", timeout=120)
        self.state["phase"] = "stopped"
        self.save()

    def resource_snapshot(self):
        _, ids = self.compose("ps", "--all", "--quiet")
        _, raw = self.run([DOCKER, "inspect", *ids.splitlines()])
        containers = []
        for value in json.loads(raw):
            _, counters = self.run([DOCKER, "exec", value["Id"], "cat", "/sys/fs/cgroup/cpu.stat",
                                   "/sys/fs/cgroup/cpu.pressure", "/sys/fs/cgroup/memory.events"])
            containers.append({"service": value["Config"]["Labels"]["com.docker.compose.service"],
                               "containerId": value["Id"], "restarts": value["RestartCount"],
                               "oomKilled": value["State"]["OOMKilled"], "cgroup": counters})
        _, raw = self.compose("exec", "-T", "postgres", "psql", "-X", "-U", "jwtstand", "-d", "jwtstand", "-Atc",
                             "SELECT row_to_json(t) FROM (SELECT xact_commit,xact_rollback,blks_read,blks_hit,temp_files,temp_bytes,deadlocks,stats_reset FROM pg_stat_database WHERE datname='jwtstand') t")
        return {"checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "hostLoadAverage": list(os.getloadavg()), "containers": containers, "postgres": json.loads(raw)}

    def application_timings(self, started, finished):
        # Client Date timestamps truncate to milliseconds; Docker log timestamps have nanoseconds.
        # Include the whole final millisecond, not only its first instant.
        end = datetime.datetime.fromisoformat(finished.replace("Z", "+00:00")) + datetime.timedelta(milliseconds=1)
        log_until = end.isoformat(timespec="milliseconds").replace("+00:00", "Z")
        _, raw = self.compose("logs", "--no-color", "--since", started, "--until", log_until,
                              "--tail", "50000", "app-a", "app-b")
        groups = {}
        for line in raw.splitlines():
            _, marker, tail = line.rpartition(" {")
            if not marker:
                continue
            try:
                entry = json.loads("{" + tail)
            except ValueError:
                continue
            path, duration = entry.get("path"), entry.get("durationMs")
            if path not in ["/api/admin/settings", "/api/admin/auth/refresh"] or not isinstance(duration, (float, int)):
                continue
            require(math.isfinite(duration) and duration >= 0, "Invalid application timing")
            key = entry["method"] + " " + path
            group = groups.setdefault(key, {"durations": [], "statuses": {}})
            group["durations"].append(duration)
            status = str(entry["status"])
            group["statuses"][status] = group["statuses"].get(status, 0) + 1
        for group in groups.values():
            samples = sorted(group.pop("durations"))
            group.update({"count": len(samples), "p95Ms": samples[math.ceil(len(samples) * .95) - 1],
                          "p99Ms": samples[math.ceil(len(samples) * .99) - 1], "maxMs": samples[-1]})
        return {"from": started, "until": finished, "logUntilExclusive": log_until, "groups": groups,
                "scope": "application middleware timings during the client interval, including its final wall-clock millisecond; logs are bounded to 50000 lines per replica"}

    def test(self):
        require(self.status()["ready"], "Stand is not ready")
        self.compose("exec", "-T", "load", "/stand/bin/client", "smoke", name="pre-load-smoke", timeout=45)
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        name = "load-" + stamp
        route = self.args.route
        url = "https://proxy:8443" if route in ["proxy", "proxy-status"] else "http://" + route + ":3000"
        before = self.resource_snapshot()
        cpu_profile = getattr(self.args, "cpu_profile", False)
        profile_dir = "/tmp/jwt-stand-cpu-" + secrets.token_hex(8) if cpu_profile else None
        profile_files = {}
        # An ordinary run must not inherit profiling flags from the container.
        command = ["exec", "-T", "-e", "BUN_OPTIONS="]
        if profile_dir:
            self.compose("exec", "-T", "load", "mkdir", "-m", "700", profile_dir)
            command[-1] += "--cpu-prof --cpu-prof-md --cpu-prof-interval=1000 --cpu-prof-name=client --cpu-prof-dir=" + profile_dir
        try:
            code, output = self.compose(*command, "load", "timeout", "-k", "5", str(self.args.seconds + 45),
                                       "/stand/bin/client", "load", f"--seconds={self.args.seconds}",
                                       f"--rps={self.args.rps}", f"--concurrency={self.args.concurrency}",
                                       "--url=" + url, "--workload=" + ("proxy-status" if route == "proxy-status" else "auth"),
                                       name=name, timeout=self.args.seconds + 60, accept_failure=True)
            if profile_dir:
                for extension in ["cpuprofile", "md"]:
                    # Read inside the mount namespace: Docker cp may not see tmpfs files.
                    _, content = self.compose("exec", "-T", "load", "cat", profile_dir + "/client." + extension)
                    if extension == "cpuprofile":
                        profile = json.loads(content)
                        require(profile.get("nodes") and profile.get("samples") and
                                len(profile["samples"]) == len(profile.get("timeDeltas", [])), "CPU profile is incomplete")
                    filename = name + ".cpu." + extension
                    (RUNTIME / "evidence" / filename).write_text(content)
                    profile_files[extension] = filename
        finally:
            if profile_dir:
                self.compose("exec", "-T", "load", "rm", "-f", profile_dir + "/client.cpuprofile", profile_dir + "/client.md")
                self.compose("exec", "-T", "load", "rmdir", profile_dir)
        data = json.loads(output)
        data["profile"]["cpuProfiler"] = cpu_profile
        data["binaryImage"] = self.state.get("binaryImage")
        if cpu_profile:
            data["cpuProfile"] = {"scope": "generator only; diagnostic run", "intervalUs": 1000, "files": profile_files}
        (RUNTIME / "evidence" / (name + ".json")).write_text(json.dumps(data, indent=2) + "\n")
        resources = {"before": before, "after": self.resource_snapshot(),
                     "scope": "resource snapshots bracket login, warmup and measured requests; client cgroup counters cover its measured interval"}
        (RUNTIME / "evidence" / (name + ".resources.json")).write_text(json.dumps(resources, indent=2) + "\n")
        timings = self.application_timings(data["startedAt"], data["finishedAt"])
        (RUNTIME / "evidence" / (name + ".application.json")).write_text(json.dumps(timings, indent=2) + "\n")
        diagnostic = cpu_profile or data["profile"].get("schedulerDiagnostics") is not False
        full_profile = (not diagnostic and route == "proxy" and
                        data["profile"].get("workload") == "auth" and data["profile"].get("target") == "https://proxy:8443" and
                        tuple(data["profile"].get(key) for key in ["seconds", "rps", "concurrency"]) == (300, 100, 16))
        self.state["lastLoad"] = {"status": data["status"], "report": name + ".json", "exitCode": code,
                                  "binaryImageId": self.state.get("binaryImage", {}).get("id"),
                                  "route": route, "profile": data["profile"], "diagnostic": diagnostic, "fullProfile": full_profile}
        if full_profile:
            self.state["lastFullLoad"] = dict(self.state["lastLoad"])
        self.save()
        print(json.dumps({"status": data["status"], "route": route, "fullProfile": full_profile, "completed": data["completed"],
                          "p99Ms": data["latency"]["p99MsUpper"], "lagP99Ms": data["lag"]["p99MsUpper"],
                          "report": str(RUNTIME / "evidence" / (name + ".json"))}, indent=2))
        return code

    def destroy(self):
        self.owned()
        _, raw = self.run([DOCKER, "image", "ls", "--quiet", "--filter", "label=" + LABEL + "=" + self.state["id"], "--filter", "label=" + ARTIFACT_LABEL + "=runtime"])
        images = sorted(set(raw.splitlines()))
        for image_id in images:
            _, inspected = self.run([DOCKER, "image", "inspect", image_id])
            require(json.loads(inspected)[0]["Config"]["Labels"].get(LABEL) == self.state["id"], "Image owner mismatch")
        self.compose("down", "--volumes", "--remove-orphans", name="destroy", timeout=120)
        self.owned()
        for image_id in images:
            self.run([DOCKER, "image", "rm", image_id])
        shutil.rmtree(RUNTIME)
        print("Owned JWT stand and its synthetic data removed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["create", "package", "status", "start", "stop", "verify", "test", "destroy"])
    parser.add_argument("--bun")
    parser.add_argument("--port", type=int, default=18443)
    parser.add_argument("--seconds", type=int, default=300)
    parser.add_argument("--rps", type=int, default=100)
    parser.add_argument("--concurrency", type=int, default=16)
    parser.add_argument("--route", choices=["proxy", "app-a", "app-b", "proxy-status"], default="proxy")
    parser.add_argument("--cpu-profile", action="store_true", help="Profile the load generator; diagnostic results never replace lastFullLoad")
    args = parser.parse_args()
    require(not args.cpu_profile or args.action == "test", "--cpu-profile requires test")
    require(1024 <= args.port <= 65535 and 10 <= args.seconds <= 900 and 1 <= args.rps <= 1000 and 1 <= args.concurrency <= 64, "Invalid bounded configuration")
    stand = Stand(args)
    require(args.action == "create" or stand.state is not None, "Create the stand first")
    if args.action == "test":
        return stand.test()
    getattr(stand, args.action)()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as failure:
        print("FAIL: " + str(failure))
        raise SystemExit(1)
