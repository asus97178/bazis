"""Operator result boundaries; no Docker, credentials or application involved."""
import argparse
import contextlib
import importlib.util
import io
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("jwt_stand", Path(__file__).with_name("stand.py"))
stand = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stand)


class RecordedStand(stand.Stand):
    def __init__(self, *, cpu=False, scheduler=False, seconds=300, incomplete=False):
        self.args = argparse.Namespace(route="proxy", seconds=300, rps=100, concurrency=16, cpu_profile=cpu)
        self.state = {"lastFullLoad": {"status": "FAIL", "report": "previous-full.json"}}
        self.commands = []
        self.incomplete = incomplete
        self.report = {"status": "PASS", "completed": 30000, "startedAt": "start", "finishedAt": "finish",
                       "latency": {"p99MsUpper": 1}, "lag": {"p99MsUpper": 1},
                       "profile": {"seconds": seconds, "rps": 100, "concurrency": 16,
                                   "workload": "auth", "target": "https://proxy:8443"}}
        if scheduler is not None:
            self.report["profile"]["schedulerDiagnostics"] = scheduler

    def status(self):
        return {"ready": True}

    def resource_snapshot(self):
        return {}

    def application_timings(self, started, finished):
        return {}

    def save(self):
        pass

    def compose(self, *args, **kwargs):
        self.commands.append(args)
        if "/stand/bin/client" in args:
            return 0, json.dumps(self.report)
        if "cat" in args:
            if args[-1].endswith(".md"):
                return 0, "# Synthetic CPU profile\n"
            return 0, json.dumps({"nodes": [{"id": 1}], "samples": [1], "timeDeltas": [] if self.incomplete else [1000]})
        return 0, ""


class ResultBoundaries(unittest.TestCase):
    def run_load(self, instance):
        with tempfile.TemporaryDirectory() as directory, patch.object(stand, "RUNTIME", Path(directory)):
            (Path(directory) / "evidence").mkdir()
            with contextlib.redirect_stdout(io.StringIO()):
                code = instance.test()
            files = {path.name: path.read_text() for path in (Path(directory) / "evidence").iterdir()}
        self.assertEqual(code, 0)
        return files

    def test_cpu_profile_pass_preserves_previous_full_failure_and_artifacts(self):
        instance = RecordedStand(cpu=True)
        files = self.run_load(instance)
        self.assertEqual(instance.state["lastFullLoad"]["report"], "previous-full.json")
        self.assertTrue(instance.state["lastLoad"]["diagnostic"])
        self.assertFalse(instance.state["lastLoad"]["fullProfile"])
        report = json.loads(files[instance.state["lastLoad"]["report"]])
        self.assertTrue(report["profile"]["cpuProfiler"])
        for name in report["cpuProfile"]["files"].values():
            self.assertIn(name, files)
        load = next(cmd for cmd in instance.commands if "timeout" in cmd)
        self.assertIn("BUN_OPTIONS=--cpu-prof", " ".join(load))
        self.assertEqual(load[load.index("timeout") + 1:load.index("timeout") + 4], ("-k", "5", "345"))
        self.assertIn("rmdir", instance.commands[-1])

    def test_kernel_probe_or_unknown_mode_cannot_promote_diagnostic_pass(self):
        for mode in [True, None]:
            with self.subTest(scheduler=mode):
                instance = RecordedStand(scheduler=mode)
                self.run_load(instance)
                self.assertEqual(instance.state["lastFullLoad"]["status"], "FAIL")
                self.assertFalse(instance.state["lastLoad"]["fullProfile"])

    def test_plain_full_profile_updates_full_result(self):
        instance = RecordedStand()
        instance.state["binaryImage"] = {"id": "sha256:qualified", "binaries": {"client": "qualified-digest"}}
        files = self.run_load(instance)
        self.assertTrue(instance.state["lastLoad"]["fullProfile"])
        self.assertEqual(instance.state["lastFullLoad"], instance.state["lastLoad"])
        self.assertEqual(instance.state["lastFullLoad"]["binaryImageId"], "sha256:qualified")
        self.assertEqual(json.loads(files[instance.state["lastLoad"]["report"]])["binaryImage"], instance.state["binaryImage"])
        load = next(cmd for cmd in instance.commands if "timeout" in cmd)
        self.assertIn("BUN_OPTIONS=", load)
        self.assertFalse(any("--cpu-prof" in " ".join(cmd) for cmd in instance.commands))

    def test_reported_short_duration_cannot_be_promoted_by_requested_full_duration(self):
        instance = RecordedStand(seconds=10)
        self.run_load(instance)
        self.assertEqual(instance.state["lastFullLoad"]["status"], "FAIL")

    def test_reported_workload_and_destination_must_match_full_auth_profile(self):
        for field, value in [("workload", "proxy-status"), ("target", "http://app-a:3000")]:
            with self.subTest(field=field):
                instance = RecordedStand()
                instance.report["profile"][field] = value
                self.run_load(instance)
                self.assertEqual(instance.state["lastFullLoad"]["status"], "FAIL")

    def test_incomplete_cpu_profile_fails_before_promotion_and_cleans_tmpfs(self):
        instance = RecordedStand(cpu=True, incomplete=True)
        with self.assertRaisesRegex(RuntimeError, "CPU profile is incomplete"):
            self.run_load(instance)
        self.assertEqual(instance.state["lastFullLoad"]["status"], "FAIL")
        self.assertNotIn("lastLoad", instance.state)
        self.assertIn("rmdir", instance.commands[-1])


class NativeBinaryPackaging(unittest.TestCase):
    def test_application_logs_include_the_complete_final_millisecond(self):
        instance = object.__new__(stand.Stand)
        commands = []
        def compose(*args, **kwargs):
            commands.append(args)
            last = 'app-a | info: GET /api/admin/settings 200 1ms {"method":"GET","path":"/api/admin/settings","status":200,"durationMs":1}'
            return 0, last if args[args.index("--until") + 1] == "2026-09-21T00:00:00.000Z" else ""
        instance.compose = compose
        result = instance.application_timings("2026-09-20T23:59:59.000Z", "2026-09-20T23:59:59.999Z")
        self.assertEqual(result["groups"]["GET /api/admin/settings"]["count"], 1)
        self.assertEqual(result["until"], "2026-09-20T23:59:59.999Z")
        self.assertEqual(result["logUntilExclusive"], "2026-09-21T00:00:00.000Z")
        self.assertIn("50000", commands[0])

    def fixture(self):
        return {"services": {**{name: {"image": "base", "cpus": 1.5, "read_only": True,
                    "volumes": [f"{stand.RUNTIME / 'bin'}:/stand/bin:ro", "/private/config:/stand/config.json:ro"]}
                    for name in stand.BINARY_SERVICES}, "postgres": {"image": "base", "volumes": ["data:/var/lib/postgresql/data"]}},
                "networks": {"stand": {"internal": True}}, "volumes": {"data": {"labels": {"owner": "test"}}}}

    def test_migration_changes_only_binary_image_and_executable_mount(self):
        original = self.fixture()
        snapshot = json.loads(json.dumps(original))
        migrated = stand.native_compose(original, "sha256:native")
        self.assertEqual(original, snapshot)
        for name in stand.BINARY_SERVICES:
            self.assertEqual(migrated["services"][name], {**original["services"][name], "image": "sha256:native",
                             "volumes": ["/private/config:/stand/config.json:ro"]})
        self.assertEqual(migrated["services"]["postgres"], original["services"]["postgres"])
        self.assertEqual(migrated["networks"], original["networks"])
        self.assertEqual(migrated["volumes"], original["volumes"])
        self.assertEqual(stand.native_compose(migrated, "sha256:native"), migrated)

    def test_shadowing_binary_or_parent_mount_is_rejected(self):
        for target in ["/", "/stand", "/stand/", "/stand/bin", "//stand/bin", "/stand/bin/client", "/stand/./bin", "/stand/elsewhere/../bin/client"]:
            for mount in ["elsewhere:" + target + ":ro", {"type": "bind", "source": "/elsewhere", "target": target}]:
                with self.subTest(mount=mount):
                    compose = self.fixture()
                    compose["services"]["load"]["volumes"].append(mount)
                    with self.assertRaisesRegex(RuntimeError, "hide packaged"):
                        stand.native_compose(compose, "sha256:native")

    def test_binary_hash_mismatch_blocks_packaging_before_docker(self):
        instance = object.__new__(stand.Stand)
        instance.state = {"binaries": {name: hashlib.sha256(b"qualified").hexdigest() for name in stand.BINARIES}}
        with tempfile.TemporaryDirectory() as directory, patch.object(stand, "RUNTIME", Path(directory)):
            (Path(directory) / "bin").mkdir()
            for name in stand.BINARIES:
                (Path(directory) / "bin" / name).write_bytes(b"qualified")
            self.assertEqual(instance.binary_digests(), instance.state["binaries"])
            (Path(directory) / "bin/client").write_bytes(b"changed")
            with self.assertRaisesRegex(RuntimeError, "binary changed"):
                instance.build_binary_image()

    def test_image_owner_or_manifest_mismatch_blocks_start(self):
        image_id = "sha256:" + "a" * 64
        expected = hashlib.sha256(b"{}").hexdigest()
        instance = object.__new__(stand.Stand)
        instance.state = {"id": "stand-owner", "binaryImage": {"id": image_id, "binaries": {}, "manifestSha256": expected}}
        instance.binary_digests = lambda: {}
        for owner, manifest in [("someone-else", expected), ("stand-owner", "wrong")]:
            instance.run = lambda *args, **kwargs: (0, json.dumps([{"Id": image_id, "Config": {"Labels": {
                stand.LABEL: owner, stand.ARTIFACT_LABEL: "runtime", "osnova.jwt-manifest": manifest}}}]))
            with self.assertRaisesRegex(RuntimeError, "owner or manifest mismatch"):
                instance.check_binary_image()

    def test_failed_build_preserves_existing_compose_and_state(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(stand, "RUNTIME", Path(directory)):
            compose = Path(directory) / "compose.json"
            state = Path(directory) / "state.json"
            compose.write_text(json.dumps(self.fixture()))
            state.write_text('{"existing":"preserve"}')
            before = (compose.read_bytes(), state.read_bytes())
            instance = object.__new__(stand.Stand)
            instance.state_path = state
            instance.owned = lambda: None
            def fail():
                raise RuntimeError("image verification failed")
            instance.build_binary_image = fail
            with self.assertRaisesRegex(RuntimeError, "image verification failed"):
                instance.package()
            self.assertEqual((compose.read_bytes(), state.read_bytes()), before)


if __name__ == "__main__":
    unittest.main()
