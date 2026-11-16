import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('prepare_env', ROOT / '.github/scripts/prepare-production-env.py')
PREPARE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREPARE)
SHA = 'a' * 40


class EnvironmentPreparation(unittest.TestCase):
    def test_add_once_without_replacing_signing_key_or_policy(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / '.env'
            original = 'POW_TOKEN_PRIVATE_KEY_BASE64=fixture-key\nPOW_BASE_DIFFICULTY_BITS=20\n'
            path.write_text(original)
            self.assertTrue(PREPARE.prepare(path))
            first = path.read_text()
            self.assertTrue(first.startswith(original))
            secret = first.split('POW_RISK_KEY_SECRET=')[1].strip()
            self.assertEqual(len(secret), 64)
            self.assertFalse(PREPARE.prepare(path))
            self.assertEqual(path.read_text(), first)

    def test_missing_signing_key_does_not_mutate_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / '.env'
            path.write_text('PORT=3000\n')
            with self.assertRaises(ValueError):
                PREPARE.prepare(path)
            self.assertEqual(path.read_text(), 'PORT=3000\n')

    def test_invalid_existing_risk_key_is_not_replaced(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / '.env'
            text = 'POW_TOKEN_PRIVATE_KEY_PEM=fixture-key\nPOW_RISK_KEY_SECRET=short\n'
            path.write_text(text)
            with self.assertRaises(ValueError):
                PREPARE.prepare(path)
            self.assertEqual(path.read_text(), text)

    def test_existing_quoted_key_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / '.env'
            text = "POW_TOKEN_PRIVATE_KEY_BASE64='fixture'\nPOW_RISK_KEY_SECRET='" + 'x' * 32 + "'\n"
            path.write_text(text)
            self.assertFalse(PREPARE.prepare(path))
            self.assertEqual(path.read_text(), text)


class DeploymentFlow(unittest.TestCase):
    def run_flow(self, **overrides):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            repo = home / 'hashguard'
            (repo / '.git').mkdir(parents=True)
            (repo / '.github/scripts').mkdir(parents=True)
            (repo / '.github/scripts/prepare-production-env.py').write_text(
                (ROOT / '.github/scripts/prepare-production-env.py').read_text())
            (repo / '.env').write_text('POW_TOKEN_PRIVATE_KEY_BASE64=fixture-key\n')
            (repo / 'docker-compose.yml').write_text('services: {}\n')
            binary = home / 'bin'
            binary.mkdir()
            log = home / 'commands.log'
            shim = '''#!/usr/bin/env python3
import json, os, pathlib, sys
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ['COMMAND_LOG'], 'a') as f: f.write(json.dumps([name] + args) + '\\n')
if name == 'id': print('0')
if name == 'sysctl': print(os.getenv('MAP_COUNT', '1048576'))
if name == 'git':
    if args[0] == 'diff' and os.getenv('DIRTY') == '1': sys.exit(1)
    if args[0] == 'merge-base' and os.getenv('NOT_MAIN') == '1': sys.exit(1)
    if args[0] == 'rev-parse': print(os.environ['SHA'])
if name == 'docker':
    if args[0] == 'inspect':
        if args[2] == '{{json .HostConfig}}':
            print(json.dumps(dict(ReadonlyRootfs=os.getenv('BAD_HARDENING') != '1', CapDrop=['ALL'], SecurityOpt=['no-new-privileges:true'], PidsLimit=256, Tmpfs={'/tmp':'rw,noexec,nosuid,nodev,size=64m,mode=1777'})))
            sys.exit(0)
        print('sha256:' + 'b'*64 if args[-1] == 'hashguard-api' else ('c'*40 if os.getenv('WRONG_REV') == '1' else os.environ['SHA']))
    if args[:3] == ['compose', 'build', 'app'] and os.getenv('FAIL_BUILD') == '1': sys.exit(1)
    if args[:4] == ['compose', 'ps', '-q', 'app']: print('new-container')
    if args[:2] == ['compose', 'up'] and os.getenv('FAIL_UP') == '1': sys.exit(1)
if name == 'curl' and os.getenv('FAIL_HEALTH') == '1': sys.exit(22)
'''
            for name in ('id', 'git', 'docker', 'curl', 'sysctl'):
                file = binary / name
                file.write_text(shim)
                file.chmod(0o755)
            env = dict(os.environ, HOME=str(home), PATH=str(binary) + os.pathsep + os.environ['PATH'],
                       HASHGUARD_DEPLOY_LOCKED='1', COMMAND_LOG=str(log), SHA=SHA, **overrides)
            result = subprocess.run(['bash', str(ROOT / '.github/scripts/deploy-server.sh'), SHA],
                                    env=env, text=True, capture_output=True)
            commands = [json.loads(line) for line in log.read_text().splitlines()]
            state = home / '.local/state/hashguard/deployed-sha'
            return result, commands, state.read_text() if state.exists() else None

    def test_success_deploys_exact_sha_and_records_only_after_gates(self):
        result, commands, state = self.run_flow()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(state, SHA + '\n')
        self.assertIn(['git', 'checkout', '-B', 'main', SHA], commands)
        self.assertIn('revision=verified', result.stdout)
        build = commands.index(['docker', 'compose', 'build', 'app'])
        start = next(i for i, row in enumerate(commands) if row[:3] == ['docker', 'compose', 'up'])
        self.assertLess(build, start)
        self.assertFalse(any(row[:3] == ['docker', 'compose', '-f'] for row in commands))

    def test_low_map_count_leaves_running_app_and_checkout_untouched(self):
        result, commands, state = self.run_flow(MAP_COUNT='262144')
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(state)
        self.assertIn('vm.max_map_count >= 1048576', result.stderr)
        self.assertFalse(any(row[0] == 'docker' for row in commands))
        self.assertFalse(any(row[:2] == ['git', 'checkout'] for row in commands))

    def test_missing_runtime_hardening_rolls_back(self):
        result, commands, state = self.run_flow(BAD_HARDENING='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(state)
        self.assertIn('Previous app image restored', result.stderr)
        self.assertTrue(any(row[:3] == ['docker', 'compose', '-f'] for row in commands))

    def test_build_failure_leaves_running_app_untouched(self):
        result, commands, state = self.run_flow(FAIL_BUILD='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(state)
        self.assertFalse(any(row[:3] == ['docker', 'compose', 'up'] for row in commands))
        self.assertNotIn('Previous app image restored', result.stderr)

    def test_readiness_failure_rolls_back_only_app_and_does_not_record(self):
        result, commands, state = self.run_flow(FAIL_HEALTH='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(state)
        rollback = next(row for row in commands if row[:3] == ['docker', 'compose', '-f'])
        self.assertIn('--no-deps', rollback)
        self.assertEqual(rollback[-1], 'app')
        self.assertIn('Previous app image restored', result.stderr)

    def test_wrong_image_revision_rolls_back(self):
        result, _, state = self.run_flow(WRONG_REV='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(state)
        self.assertIn('Previous app image restored', result.stderr)

    def test_compose_start_failure_rolls_back(self):
        result, _, state = self.run_flow(FAIL_UP='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(state)
        self.assertIn('Previous app image restored', result.stderr)

    def test_dirty_checkout_is_not_overwritten(self):
        result, commands, state = self.run_flow(DIRTY='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(state)
        self.assertFalse(any(row[0] == 'docker' for row in commands))
        self.assertFalse(any(row[:2] == ['git', 'checkout'] for row in commands))

    def test_non_main_commit_is_not_deployed(self):
        result, commands, state = self.run_flow(NOT_MAIN='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(state)
        self.assertFalse(any(row[0] == 'docker' for row in commands))


if __name__ == '__main__':
    unittest.main()
