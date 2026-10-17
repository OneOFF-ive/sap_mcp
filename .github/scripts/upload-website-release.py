"""Upload verified installers over bounded SSH chunks; retries resume safely."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time


def ssh(options, command, content=b'', timeout=210):
    result = subprocess.run(['ssh', *options, 'saplinksync@118.89.185.57', command],
                            input=content, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=timeout, check=False)
    if result.returncode:
        # SSH errors contain no private-key contents; retain the actionable error.
        raise RuntimeError(result.stderr.decode(errors='replace')[-2000:])
    return json.loads(result.stdout)


def transfer(manifest_path, options, call=ssh):
    manifest = json.loads(manifest_path.read_text())
    version = manifest['version']
    print(f'Checking website for v{version}...', flush=True)
    if call(options, 'check', manifest_path.read_bytes(), timeout=180)['need_upload'] is False:
        print('Installers already verified; synchronizing metadata only.', flush=True)
        return call(options, 'sync', Path(os.environ['METADATA']).read_bytes(), timeout=300)
    prepared = call(options, 'prepare', manifest_path.read_bytes(), timeout=300)
    chunk_size = prepared['chunk_size']
    if type(chunk_size) is not int or not 0 < chunk_size <= 4 * 1024 * 1024:
        raise ValueError('Invalid server chunk size')
    for arch in ('x64', 'arm64'):
        asset = manifest['platforms'][arch]
        with (manifest_path.parent / asset['filename']).open('rb') as source:
            total = (asset['size'] + chunk_size - 1) // chunk_size
            for index in range(total):
                data = source.read(chunk_size)
                digest = hashlib.sha256(data).hexdigest()
                if prepared['chunks'].get(arch, {}).get(str(index)) == digest:
                    print(f'{arch}: chunk {index + 1}/{total} already verified; resuming.', flush=True)
                    continue
                for attempt in range(3):
                    try:
                        result = call(options, f'chunk {version} {arch} {index} {digest}', data)
                        if result.get('status') != 'stored' or result.get('sha256') != digest:
                            raise ValueError('Server did not confirm the chunk checksum')
                        break
                    except (RuntimeError, subprocess.TimeoutExpired):
                        if attempt == 2:
                            raise
                        print(f'{arch}: chunk {index + 1}/{total} interrupted; retry {attempt + 1}/2.', flush=True)
                        time.sleep(2 ** attempt)
                print(f'{arch}: chunk {index + 1}/{total} verified.', flush=True)
    print('All chunks transferred; verifying complete installers and promoting release...', flush=True)
    return call(options, f'promote {version}', timeout=300)


if __name__ == '__main__':
    options = ['-T', '-i', os.environ['SYNC_SSH_KEY'], '-o', 'IdentitiesOnly=yes',
               '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
               '-o', 'UserKnownHostsFile=' + os.environ['SYNC_SSH_HOSTS'],
               '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=15',
               '-o', 'ServerAliveCountMax=4', '-o', 'IPQoS=none']
    result = transfer(Path(os.environ['MANIFEST']), options)
    print(json.dumps(result), flush=True)
