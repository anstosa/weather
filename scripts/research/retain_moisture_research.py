"""Encrypt and verify owned research evidence without touching deployed services."""

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tarfile


# stream file hashes without duplicating large private inputs in memory
def digest(path):
    value = hashlib.sha256()
    # read bounded blocks from owned artifacts
    with path.open('rb') as stream:
        while block := stream.read(1024 * 1024):
            value.update(block)
    return value.hexdigest()


# accept only an owned private root in one explicit research base
def validate_private_root(private_root, home=None):
    supplied = Path(private_root)
    # reject lexical traversal before canonicalization
    if '..' in supplied.parts:
        raise ValueError('invalid private root')
    lexical_root = Path(os.path.abspath(supplied))
    private_home = Path(os.path.abspath(Path.home() if home is None else home))
    tmpfs_base = Path('/dev/shm')
    weather_base = private_home / '.weather'
    disk_base = weather_base / 'research-work'
    # select only a direct child of an approved base
    if lexical_root.parent == tmpfs_base:
        base = tmpfs_base
    elif lexical_root.parent == disk_base:
        base = disk_base
    else:
        raise ValueError('invalid private root')
    # require the exact research naming convention
    if not lexical_root.name.startswith('weather-moisture-research-'):
        raise ValueError('invalid private root')
    # reject symlinks in the private disk lineage
    if base == disk_base and (weather_base.is_symlink() or disk_base.is_symlink()):
        raise ValueError('invalid private root')
    # reject a linked research root
    if lexical_root.is_symlink():
        raise ValueError('invalid private root')
    try:
        resolved_base = base.resolve(strict=True)
        root = lexical_root.resolve(strict=True)
        base_status = base.stat()
        root_status = lexical_root.stat()
        weather_status = weather_base.stat() if base == disk_base else None
    except OSError as error:
        raise ValueError('invalid private root') from error
    # require an exact canonical direct child
    if root.parent != resolved_base or not stat.S_ISDIR(root_status.st_mode):
        raise ValueError('invalid private root')
    # require private owned research data
    if root_status.st_uid != os.getuid() or root_status.st_mode & 0o077:
        raise ValueError('invalid private root')
    # require private owned disk ancestors
    if base == disk_base and (not stat.S_ISDIR(base_status.st_mode) or base_status.st_uid != os.getuid() or base_status.st_mode & 0o077 or not stat.S_ISDIR(weather_status.st_mode) or weather_status.st_uid != os.getuid() or weather_status.st_mode & 0o077):
        raise ValueError('invalid private root')
    return root


# retain one finalized experiment and verify its exact encrypted roundtrip
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('private_root', type=Path)
    parser.add_argument('evidence', type=Path)
    args = parser.parse_args()
    root = validate_private_root(args.private_root)
    # reject a linked evidence root before inspecting its receipts
    if args.evidence.is_symlink():
        raise ValueError('symlinks are not retained')
    # require completed data acquisition and independent validation
    if json.loads((args.evidence / 'acquisition-summary.json').read_text())['status'] != 'complete' or json.loads((args.evidence / 'final-verification.json').read_text())['verdict'] != 'PASS':
        raise ValueError('research is not ready for retention')
    selected = ['acquisition', 'production-moisture', 'targets', 'pairs-production', 'pairs-archive', 'humidity', 'predictions', 'runtime-sources', 'evidence']
    # preserve links so the manifest boundary rejects them without reading targets
    shutil.copytree(args.evidence, root / 'evidence', symlinks=True)
    expected = {}
    # enumerate only explicit current experiment artifacts
    for name in selected:
        directory = root / name
        if not directory.is_dir() or directory.is_symlink():
            raise ValueError('missing retention directory: ' + name)
        for path in sorted(directory.rglob('*')):
            if path.is_symlink():
                raise ValueError('symlinks are not retained')
            if path.is_file():
                expected[str(path.relative_to(root))] = {'bytes': path.stat().st_size, 'sha256': digest(path)}
    manifest = {'contractVersion': 'moisture-research-private-retention/v1', 'files': expected, 'originalProductionSource': {'cipherSha256': '963e85c1346c1e01cab6ab122d9173b93158a51d3015b8b1b70dd79564297c0e', 'archive': '66b3a1d012e8e8b451f1d8a51c9a197c4e6a38501fce16ed6c85a392e9209540.production-all-season-sample.tar.gz.age'}}
    # bind exact current artifacts to one manifest-addressed archive
    manifest_path = root / 'moisture-retention-files.json'
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
    manifest_sha = digest(manifest_path)
    expected[manifest_path.name] = {'bytes': manifest_path.stat().st_size, 'sha256': manifest_sha}
    filelist = root / 'moisture-retention-filelist.bin'
    filelist.write_bytes(b'\0'.join(name.encode() for name in expected) + b'\0')
    identity = Path.home() / '.config/weather/backup-age-key.txt'
    recipients = Path.home() / '.config/weather/backup-age-recipient.txt'
    # verify the existing recipient without exposing private key material
    derived = subprocess.check_output(['age-keygen', '-y', str(identity)]).strip()
    if derived != recipients.read_bytes().strip():
        raise ValueError('backup recipient does not match existing identity')
    local = Path.home() / '.weather/model-evidence/rain-humidity-pressure-20260908'
    local.mkdir(mode=0o700, exist_ok=True)
    archive = local / f'{manifest_sha}.rain-humidity-pressure.tar.gz.age'
    if archive.exists():
        raise ValueError('refusing to replace retained evidence')
    # encrypt the tar stream directly without a second plaintext archive
    tar = subprocess.Popen(['tar', '--create', '--gzip', '--file=-', '--directory=' + str(root), '--null', '--verbatim-files-from', '--files-from=' + str(filelist)], stdout=subprocess.PIPE)
    encrypted = subprocess.run(['age', '-R', str(recipients), '-o', str(archive)], stdin=tar.stdout, check=False)
    tar.stdout.close()
    if encrypted.returncode != 0 or tar.wait() != 0:
        raise RuntimeError('encryption failed')
    archive.chmod(0o600)
    seen = set()
    # verify every decrypted member through a bounded streaming roundtrip
    decrypt = subprocess.Popen(['age', '-d', '-i', str(identity), str(archive)], stdout=subprocess.PIPE)
    with tarfile.open(fileobj=decrypt.stdout, mode='r|gz') as contents:
        for member in contents:
            if not member.isfile() or member.name not in expected or member.name in seen:
                raise ValueError('unexpected retained member')
            seen.add(member.name)
            source = contents.extractfile(member)
            sha = hashlib.sha256()
            size = 0
            while block := source.read(1024 * 1024):
                sha.update(block)
                size += len(block)
            if size != expected[member.name]['bytes'] or sha.hexdigest() != expected[member.name]['sha256']:
                raise ValueError('retention roundtrip changed a member')
    if decrypt.wait() != 0 or seen != set(expected):
        raise ValueError('incomplete retention roundtrip')
    # upload encrypted evidence only into the existing user evidence convention
    remote = '/home/admin/.weather/model-evidence/rain-humidity-pressure-20260908'
    remote_path = remote + '/' + archive.name
    subprocess.run(['ssh', 'blueberry', f'umask 077; mkdir -p {remote}; test ! -e {remote_path}'], check=True)
    subprocess.run(['scp', '-p', str(archive), 'blueberry:' + remote_path], check=True)
    cipher_sha = digest(archive)
    remote_sha = subprocess.check_output(['ssh', 'blueberry', 'sha256sum ' + remote_path], text=True).split()[0]
    if cipher_sha != remote_sha:
        raise ValueError('remote encrypted copy changed')
    receipt = {'verdict': 'PASS', 'completedAtUtc': dt.datetime.now(dt.timezone.utc).isoformat(), 'archive': archive.name, 'cipherBytes': archive.stat().st_size, 'cipherSha256': cipher_sha, 'manifestSha256': manifest_sha, 'verifiedFiles': len(seen), 'encryptedRoundtripVerified': True, 'remoteCipherChecksumVerified': True, 'localEncryptedDirectory': str(local), 'remoteEncryptedDirectory': 'blueberry:' + remote, 'productionDatabaseOrServiceWrites': False}
    (args.evidence / 'retention-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    shutil.copy2(args.evidence / 'retention-receipt.json', local / 'retention-receipt.json')
    subprocess.run(['scp', '-p', str(local / 'retention-receipt.json'), 'blueberry:' + remote + '/retention-receipt.json'], check=True)
    print(json.dumps(receipt), flush=True)


# require explicit finalized retention
if __name__ == '__main__':
    main()
