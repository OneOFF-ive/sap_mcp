"""Publish verified official release assets; keep the COS pointer last and monotonic."""
import hashlib
import importlib.util
import json
import logging
import os
from pathlib import Path
import re
import sys
import urllib.request

BUCKET = 'saplink-1302377695'
REGION = 'ap-shanghai'
ORIGIN = f'https://{BUCKET}.cos.{REGION}.myqcloud.com'
LATEST_KEY = 'saplink/latest.json'
MAX_INSTALLER_SIZE = 256 * 1024 * 1024


class SyncError(ValueError):
    """A locally defined error message that is safe to show in workflow logs."""


def version_tuple(value):
    if not isinstance(value, str) or not re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', value):
        raise SyncError('Expected a stable three-part version')
    return tuple(map(int, value.split('.')))


def prepare_manifest(path, release):
    prepared = json.loads(path.read_text(encoding='utf-8'))
    version = prepared['version']
    version_tuple(version)
    if (release.get('tag_name') != f'v{version}' or release.get('id') != prepared['release_id']
            or release.get('draft') or release.get('prerelease') or not release.get('published_at')):
        raise SyncError('Prepared assets no longer match the latest stable release')
    if set(prepared['platforms']) != {'x64', 'arm64'}:
        raise SyncError('Both official architectures are required')
    files = []
    downloads = []
    for arch in ('x64', 'arm64'):
        asset = prepared['platforms'][arch]
        filename = f'SapLink-{version}-win-{arch}-setup.exe'
        if asset.get('filename') != filename or not re.fullmatch(r'[a-f0-9]{64}', asset.get('sha256', '')):
            raise SyncError('Invalid official asset name or digest')
        if type(asset.get('size')) is not int or not 0 < asset['size'] <= MAX_INSTALLER_SIZE:
            raise SyncError('Invalid installer size')
        local = path.parent / filename
        digest = hashlib.sha256()
        size = 0
        with local.open('rb') as stream:
            while chunk := stream.read(1024 * 1024):
                size += len(chunk)
                if size > asset['size']:
                    raise SyncError('Installer exceeds expected size')
                digest.update(chunk)
        if size != asset['size'] or digest.hexdigest() != asset['sha256']:
            raise SyncError('Local installer does not match the verified release')
        key = f'saplink/v{version}/{filename}'
        files.append((key, local, size, asset['sha256']))
        downloads.append({'architecture': arch, 'url': f'{ORIGIN}/{key}', 'sha256': asset['sha256']})
    return {'schema_version': 1, 'version': version, 'published_at': release['published_at'], 'downloads': downloads}, files


def may_publish(existing, candidate):
    if existing is None:
        return True
    if existing.get('schema_version') != 1:
        raise SyncError('Existing COS manifest has an unsupported schema; inspect it manually')
    current, proposed = version_tuple(existing.get('version')), version_tuple(candidate['version'])
    if current > proposed:
        return False
    if current == proposed:
        # Never silently replace an already published version with different binaries.
        if existing.get('downloads') != candidate['downloads']:
            raise SyncError('Same-version manifest conflicts with published downloads; publish a new version')
    return True


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise SyncError('Unexpected COS redirect')


def open_public(key):
    opener = urllib.request.build_opener(NoRedirect())
    request = urllib.request.Request(f'{ORIGIN}/{key}', headers={'Cache-Control': 'no-cache'})
    return opener.open(request, timeout=60)


def public_bytes(key, limit):
    with open_public(key) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise SyncError('Public metadata exceeds expected size')
    return data


def verify_public(key, expected_size, expected_hash):
    digest = hashlib.sha256()
    size = 0
    with open_public(key) as response:
        while chunk := response.read(1024 * 1024):
            size += len(chunk)
            if size > expected_size:
                raise SyncError('Public object exceeds expected size')
            digest.update(chunk)
    if size != expected_size or digest.hexdigest() != expected_hash:
        raise SyncError('Public COS download failed SHA-256 verification')


def sync_release(path, store, latest_release, verify=verify_public, read_public=public_bytes):
    release = latest_release()
    candidate, files = prepare_manifest(path, release)
    if not may_publish(store.read_manifest(), candidate):
        print('Skipping: COS already advertises a newer version.')
        return False
    for key, local, size, sha256 in files:
        if not store.exists(key):
            store.put_file(key, local)
        # Existing binaries must also match; a failed upload retry never overwrites them.
        verify(key, size, sha256)
        checksum = f'{sha256}  {local.name}\n'.encode()
        checksum_key = key + '.sha256'
        if not store.exists(checksum_key):
            store.put_bytes(checksum_key, checksum, immutable=True)
        if read_public(checksum_key, 1024).decode('utf-8-sig').strip() != checksum.decode().strip():
            raise SyncError('Public COS checksum sidecar is inconsistent')
        print(f'Verified public COS download: {local.name}', flush=True)
    # Release events may queue while a newer release is being published.
    latest = latest_release()
    if latest.get('id') != release['id'] or latest.get('tag_name') != release['tag_name']:
        print('Skipping latest.json: a newer GitHub release was published during upload.')
        return False
    existing = store.read_manifest()
    if not may_publish(existing, candidate):
        print('Skipping latest.json: COS already advertises a newer version.')
        return False
    if existing is None or existing['version'] != candidate['version']:
        encoded = (json.dumps(candidate, indent=2) + '\n').encode()
        store.put_bytes(LATEST_KEY, encoded, immutable=False)
    expected = candidate if existing is None or existing['version'] != candidate['version'] else existing
    # Compare JSON semantically: manually uploaded metadata may use different whitespace.
    if store.read_manifest() != expected:
        raise SyncError('Published COS manifest verification failed')
    if json.loads(read_public(LATEST_KEY, 256 * 1024)) != expected:
        raise SyncError('Public COS manifest verification failed')
    print(f'COS synchronization complete: v{candidate["version"]}')
    return True


class CosStore:
    def __init__(self, client, service_error):
        self.client = client
        self.service_error = service_error

    def exists(self, key):
        try:
            self.client.head_object(Bucket=BUCKET, Key=key)
            return True
        except self.service_error as error:
            if error.get_status_code() == 404 and error.get_error_code() in ('NoSuchKey', 'NoSuchResource'):
                return False
            raise

    def read_manifest(self):
        try:
            response = self.client.get_object(Bucket=BUCKET, Key=LATEST_KEY)
        except self.service_error as error:
            if error.get_status_code() == 404 and error.get_error_code() == 'NoSuchKey':
                return None
            raise
        stream = response['Body'].get_raw_stream()
        try:
            data = stream.read(256 * 1024 + 1)
        finally:
            stream.close()
        if len(data) > 256 * 1024:
            raise SyncError('Existing COS manifest is oversized')
        return json.loads(data)

    def put_file(self, key, path):
        with path.open('rb') as body:
            self.client.put_object(Bucket=BUCKET, Key=key, Body=body, EnableMD5=True,
                                   Metadata={'x-cos-forbid-overwrite': 'true'}, ContentType='application/octet-stream',
                                   CacheControl='public, max-age=31536000, immutable')

    def put_bytes(self, key, data, immutable):
        # SDK 1.9.44 passes custom HTTP headers through Metadata, without adding a prefix.
        options = {'Metadata': {'x-cos-forbid-overwrite': 'true'}} if immutable else {}
        self.client.put_object(Bucket=BUCKET, Key=key, Body=data, EnableMD5=True,
                               ContentType='text/plain' if immutable else 'application/json',
                               CacheControl='public, max-age=31536000, immutable' if immutable else 'no-cache', **options)


def main():
    # Import SDK only in the uploader step; tests use an isolated in-memory store.
    from qcloud_cos import CosConfig, CosS3Client
    from qcloud_cos.cos_exception import CosServiceError
    secret_id = os.environ.get('COS_SECRET_ID')
    secret_key = os.environ.get('COS_SECRET_KEY')
    if not secret_id or not secret_key:
        raise SyncError('Missing COS_SECRET_ID or COS_SECRET_KEY')
    config = CosConfig(Region=REGION, SecretId=secret_id, SecretKey=secret_key, Scheme='https', Timeout=60, AllowRedirects=False)
    client = CosS3Client(config)
    spec = importlib.util.spec_from_file_location('prepare_release', Path(__file__).with_name('prepare-website-release.py'))
    github = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(github)
    sync_release(Path(os.environ['RELEASE_MANIFEST']), CosStore(client, CosServiceError), lambda: github.api('releases/latest'))


if __name__ == '__main__':
    logging.disable(logging.CRITICAL)  # SDK errors can otherwise log request context.
    try:
        main()
    except Exception as error:
        # Do not dump SDK exception text, signed URLs or headers into Actions logs.
        reason = str(error) if isinstance(error, SyncError) else type(error).__name__
        print(f'COS synchronization failed: {reason}. Check assets, public-read access and scoped COS permissions.', file=sys.stderr)
        sys.exit(1)
