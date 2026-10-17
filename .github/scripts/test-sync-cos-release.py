"""Offline release publishing checks. No cloud SDK, network or credentials required."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location('sync_cos', Path(__file__).with_name('sync-cos-release.py'))
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


class Store:
    def __init__(self):
        self.objects = {}
        self.writes = []

    def exists(self, key):
        return key in self.objects

    def read_manifest(self):
        return json.loads(self.objects[sync.LATEST_KEY]) if sync.LATEST_KEY in self.objects else None

    def put_file(self, key, path):
        self.put_bytes(key, path.read_bytes(), immutable=True)

    def put_bytes(self, key, data, immutable):
        if immutable and key in self.objects:
            raise AssertionError('Attempted to overwrite an immutable release file')
        self.objects[key] = data
        self.writes.append(key)

    def verify(self, key, size, digest):
        data = self.objects[key]
        if len(data) != size or hashlib.sha256(data).hexdigest() != digest:
            raise ValueError('Public download is corrupt')

    def public(self, key, limit):
        if len(self.objects[key]) > limit:
            raise ValueError('Oversized metadata')
        return self.objects[key]


class SyncTests(unittest.TestCase):
    def setUp(self):
        test_root = Path(__file__).resolve().parents[2] / '.saplink' / 'tests'
        test_root.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=test_root)
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.release = {'id': 101, 'tag_name': 'v1.0.1', 'published_at': '2026-10-18T00:00:00Z', 'draft': False, 'prerelease': False}
        platforms = {}
        for arch in ('x64', 'arm64'):
            filename = f'SapLink-1.0.1-win-{arch}-setup.exe'
            data = f'fixture-{arch}'.encode()
            (root / filename).write_bytes(data)
            platforms[arch] = {'filename': filename, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
        self.path = root / 'releases.json'
        self.path.write_text(json.dumps({'version': '1.0.1', 'release_id': 101, 'platforms': platforms}), encoding='utf-8')
        self.store = Store()

    def run_sync(self, latest=None, verify=None):
        with contextlib.redirect_stdout(io.StringIO()):
            return sync.sync_release(self.path, self.store, latest or (lambda: self.release), verify or self.store.verify, self.store.public)

    def test_uploads_both_architectures_and_commits_pointer_last(self):
        self.assertTrue(self.run_sync())
        self.assertEqual(self.store.writes[-1], sync.LATEST_KEY)
        manifest = self.store.read_manifest()
        self.assertEqual(manifest['published_at'], self.release['published_at'])
        self.assertEqual({item['architecture'] for item in manifest['downloads']}, {'x64', 'arm64'})
        self.assertEqual(len(self.store.writes), 5)

    def test_retry_reuses_existing_files_and_preserves_manifest(self):
        self.run_sync()
        # A human-uploaded sidecar may have Windows line endings.
        sidecar = next(key for key in self.store.objects if key.endswith('.sha256'))
        self.store.objects[sidecar] = self.store.objects[sidecar].replace(b'\n', b'\r\n')
        self.store.writes.clear()
        self.assertTrue(self.run_sync())
        self.assertEqual(self.store.writes, [])

    def test_verification_failure_keeps_previous_manifest_and_retry_recovers(self):
        previous = {'schema_version': 1, 'version': '1.0.0', 'downloads': []}
        self.store.objects[sync.LATEST_KEY] = json.dumps(previous).encode()
        with self.assertRaises(ValueError):
            self.run_sync(verify=lambda *args: (_ for _ in ()).throw(ValueError('download failed')))
        self.assertEqual(self.store.read_manifest(), previous)
        self.assertTrue(self.run_sync())
        self.assertEqual(self.store.read_manifest()['version'], '1.0.1')

    def test_never_replaces_a_newer_cos_version(self):
        self.store.objects[sync.LATEST_KEY] = json.dumps({'schema_version': 1, 'version': '1.0.10'}).encode()
        self.assertFalse(self.run_sync())
        self.assertEqual(self.store.writes, [])

    def test_same_version_with_changed_binary_is_rejected(self):
        self.run_sync()
        manifest = self.store.read_manifest()
        manifest['downloads'][0]['sha256'] = '0' * 64
        self.store.objects[sync.LATEST_KEY] = json.dumps(manifest).encode()
        self.store.writes.clear()
        with self.assertRaises(ValueError):
            self.run_sync()
        self.assertEqual(self.store.writes, [])

    def test_new_release_mid_upload_prevents_pointer_update(self):
        calls = 0
        def latest():
            nonlocal calls
            calls += 1
            return self.release if calls == 1 else {**self.release, 'id': 102, 'tag_name': 'v1.0.2'}
        self.assertFalse(self.run_sync(latest=latest))
        self.assertNotIn(sync.LATEST_KEY, self.store.objects)

    def test_invalid_local_file_performs_no_upload(self):
        (self.path.parent / 'SapLink-1.0.1-win-x64-setup.exe').write_bytes(b'changed')
        with self.assertRaises(ValueError):
            self.run_sync()
        self.assertEqual(self.store.writes, [])

    def test_missing_architecture_performs_no_upload(self):
        prepared = json.loads(self.path.read_text())
        del prepared['platforms']['arm64']
        self.path.write_text(json.dumps(prepared))
        with self.assertRaises(ValueError):
            self.run_sync()
        self.assertEqual(self.store.writes, [])

    def test_cos_version_is_checked_again_after_upload(self):
        calls = 0
        def latest():
            nonlocal calls
            calls += 1
            if calls == 2:
                self.store.objects[sync.LATEST_KEY] = b'{"schema_version":1,"version":"1.0.2"}'
            return self.release
        self.assertFalse(self.run_sync(latest=latest))
        self.assertEqual(self.store.read_manifest()['version'], '1.0.2')
        self.assertNotIn(sync.LATEST_KEY, self.store.writes)

    def test_existing_corrupt_binary_is_not_overwritten(self):
        key = 'saplink/v1.0.1/SapLink-1.0.1-win-x64-setup.exe'
        self.store.objects[key] = b'corrupt'
        with self.assertRaises(ValueError):
            self.run_sync()
        self.assertEqual(self.store.writes, [])
        self.assertEqual(self.store.objects[key], b'corrupt')

    def test_invalid_existing_metadata_fails_closed(self):
        self.store.objects[sync.LATEST_KEY] = b'{"schema_version":1,"version":"invalid"}'
        with self.assertRaises(ValueError):
            self.run_sync()
        self.assertEqual(self.store.writes, [])

    def test_real_sdk_maps_immutable_headers_and_keeps_latest_mutable(self):
        try:
            from qcloud_cos import CosConfig, CosS3Client
            from qcloud_cos.cos_exception import CosServiceError
        except ImportError:
            self.skipTest('Install pinned COS SDK to check its HTTP parameter mapping')
        client = CosS3Client(CosConfig(Region=sync.REGION, SecretId='synthetic-id', SecretKey='synthetic-key',
                                      Scheme='https', Timeout=60, AllowRedirects=False))
        calls = []
        def request(**kwargs):
            calls.append(kwargs)
            return SimpleNamespace(headers={'ETag': 'synthetic-etag'})
        client.send_request = request
        store = sync.CosStore(client, CosServiceError)
        store.put_file('saplink/v1.0.1/test.exe', self.path)
        self.assertEqual(calls[-1]['headers']['x-cos-forbid-overwrite'], 'true')
        self.assertIn('Content-MD5', calls[-1]['headers'])
        store.put_bytes('saplink/v1.0.1/test.sha256', b'test', immutable=True)
        self.assertEqual(calls[-1]['headers']['x-cos-forbid-overwrite'], 'true')
        store.put_bytes(sync.LATEST_KEY, b'{}', immutable=False)
        self.assertNotIn('x-cos-forbid-overwrite', calls[-1]['headers'])
        self.assertEqual(calls[-1]['headers']['Cache-Control'], 'no-cache')


if __name__ == '__main__':
    unittest.main()
