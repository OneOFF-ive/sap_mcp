"""Offline checks for interrupted, resumed and corrupted website uploads."""
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


receiver = load('receiver', 'website_upload_receiver.py')
uploader = load('uploader', 'upload-website-release.py')


class UploadTests(unittest.TestCase):
    def setUp(self):
        test_root = Path(__file__).resolve().parents[2] / '.saplink' / 'tests'
        test_root.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=test_root)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.manifest = {'version': '1.0.1', 'release_id': 101, 'platforms': {}}
        self.content = {}
        for arch in ('x64', 'arm64'):
            data = (arch * 9).encode()
            self.content[arch] = data
            name = f'SapLink-1.0.1-win-{arch}-setup.exe'
            (self.root / name).write_bytes(data)
            self.manifest['platforms'][arch] = {'filename': name, 'size': len(data),
                                                'sha256': hashlib.sha256(data).hexdigest(),
                                                'name': 'Windows ARM64' if arch == 'arm64' else 'Windows x64',
                                                'url': f'downloads/v1.0.1/{name}'}
        self.path = self.root / 'releases.json'
        self.path.write_text(json.dumps(self.manifest))
        self.stage = self.root / 'staging'
        self.stage.mkdir()
        self.chunk_patch = patch.object(receiver, 'CHUNK_SIZE', 8)
        self.chunk_patch.start()
        self.addCleanup(self.chunk_patch.stop)

    def put_all(self):
        receiver.prepare(self.stage, self.manifest, self.manifest)
        for arch, data in self.content.items():
            for offset in range(0, len(data), 8):
                chunk = data[offset:offset + 8]
                receiver.upload(self.stage, '1.0.1', arch, str(offset // 8),
                                hashlib.sha256(chunk).hexdigest(), io.BytesIO(chunk))

    def test_official_metadata_required_before_staging(self):
        changed = copy.deepcopy(self.manifest)
        changed['release_id'] = 102
        with self.assertRaises(ValueError):
            receiver.prepare(self.stage, changed, self.manifest)
        self.assertEqual(list(self.stage.iterdir()), [])

    def test_interruption_retains_only_complete_verified_chunks(self):
        receiver.prepare(self.stage, self.manifest, self.manifest)
        chunk = self.content['x64'][:8]
        digest = hashlib.sha256(chunk).hexdigest()
        receiver.upload(self.stage, '1.0.1', 'x64', '0', digest, io.BytesIO(chunk))
        with self.assertRaises(ValueError):
            receiver.upload(self.stage, '1.0.1', 'x64', '1', digest, io.BytesIO(chunk[:3]))
        progress = receiver.prepare(self.stage, self.manifest, self.manifest)
        self.assertEqual(progress['chunks']['x64'], {'0': digest})

    def test_assembled_archive_preserves_both_original_installers(self):
        self.put_all()
        output = io.BytesIO()
        receiver.assemble(self.stage, '1.0.1', output)
        output.seek(0)
        with tarfile.open(fileobj=output) as archive:
            for arch, data in self.content.items():
                self.assertEqual(archive.extractfile(self.manifest['platforms'][arch]['filename']).read(), data)

    def test_corrupted_chunk_prevents_full_archive_verification(self):
        self.put_all()
        (self.stage / 'v1.0.1/x64-0.part').write_bytes(b'changed!')
        with self.assertRaises(ValueError):
            receiver.assemble(self.stage, '1.0.1', io.BytesIO())

    def test_invalid_coordinates_and_digest_do_not_write(self):
        receiver.prepare(self.stage, self.manifest, self.manifest)
        for version, arch, index in [('..', 'x64', '0'), ('1.0.1', '../x64', '0'), ('1.0.1', 'x64', '999')]:
            with self.assertRaises(ValueError):
                receiver.upload(self.stage, version, arch, index, 'a' * 64, io.BytesIO(b'x'))
        self.assertEqual(list((self.stage / 'v1.0.1').glob('*.part')), [])

    def test_missing_chunk_prevents_assembly(self):
        self.put_all()
        (self.stage / 'v1.0.1/arm64-0.part').unlink()
        with self.assertRaises(ValueError):
            receiver.assemble(self.stage, '1.0.1', io.BytesIO())

    @unittest.skipUnless(os.environ.get('RECEIVER_MODULE'), 'Requires the Linux website receiver')
    def test_original_receiver_validates_and_promotes_assembled_payload(self):
        spec = importlib.util.spec_from_file_location('legacy', os.environ['RECEIVER_MODULE'])
        legacy = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(legacy)
        official = {'id': 101, 'tag_name': 'v1.0.1', 'published_at': '2026-10-18T00:00:00Z', 'assets': []}
        for asset in self.manifest['platforms'].values():
            official['assets'].append({'name': asset['filename'], 'size': asset['size'],
                                       'state': 'uploaded', 'digest': 'sha256:' + asset['sha256']})
        self.put_all()
        archive = io.BytesIO()
        receiver.assemble(self.stage, '1.0.1', archive)
        archive.seek(0)
        downloads = self.root / 'isolated-downloads'
        downloads.mkdir()
        result = legacy.receive(archive, downloads, lambda tag: official, lambda: official)
        self.assertEqual(result['status'], 'synced')
        self.assertEqual((downloads / 'latest').resolve().name, 'v1.0.1')
        for arch, data in self.content.items():
            self.assertEqual((downloads / 'latest' / f'SapLink-win-{arch}-setup.exe').read_bytes(), data)

    def test_uploader_skips_verified_chunks_and_retries_interruption(self):
        self.put_all()
        calls = []
        attempts = 0
        def remote(options, command, content=b'', timeout=210):
            nonlocal attempts
            calls.append(command)
            if command == 'check': return {'need_upload': True}
            if command == 'prepare':
                progress = receiver.prepare(self.stage, self.manifest, self.manifest)
                progress['chunks']['x64'].pop('1')
                return progress
            if command.startswith('chunk '):
                attempts += 1
                if attempts == 1: raise RuntimeError('Connection lost')
                return receiver.upload(self.stage, *command.split()[1:], io.BytesIO(content))
            self.assertEqual(command, 'promote 1.0.1')
            return {'status': 'synced'}
        with patch.object(uploader.time, 'sleep'):
            self.assertEqual(uploader.transfer(self.path, [], remote)['status'], 'synced')
        self.assertEqual(attempts, 2)
        self.assertEqual(len([c for c in calls if c.startswith('chunk ')]), 2)

    def test_existing_release_uses_metadata_only(self):
        metadata = self.root / 'metadata.tar'
        metadata.write_bytes(b'metadata fixture')
        calls = []
        def remote(options, command, content=b'', timeout=210):
            calls.append(command)
            if command == 'check': return {'need_upload': False}
            self.assertEqual(content, b'metadata fixture')
            return {'status': 'synced'}
        with patch.dict(os.environ, METADATA=str(metadata)):
            uploader.transfer(self.path, [], remote)
        self.assertEqual(calls, ['check', 'sync'])


if __name__ == '__main__':
    unittest.main()
