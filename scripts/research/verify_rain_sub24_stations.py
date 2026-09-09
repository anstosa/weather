"""independently bind station days, physical identities and raw interval amounts."""

import argparse
import collections
import datetime as dt
import gzip
import hashlib
import json
import math
import os
import stat
from pathlib import Path

IDS = (66270, 34768, 88159, 126197, 27140)


# fail closed on any inconsistent retained evidence
def require(condition, message):
    if not condition:
        raise ValueError(message)


# hash bytes with no credential material in the digest input paths
def sha(data):
    return hashlib.sha256(data).hexdigest()


# reject aliases and record a read-only tree snapshot
def tree(root):
    digest = hashlib.sha256()
    for path in sorted(root.rglob('*')):
        metadata = path.lstat()
        require(not stat.S_ISLNK(metadata.st_mode) and metadata.st_uid == os.getuid() and not metadata.st_mode & 0o077, 'station artifact is not private owned material')
        if stat.S_ISREG(metadata.st_mode):
            require(metadata.st_nlink == 1, 'hardlinked station artifact')
            digest.update(str(path.relative_to(root)).encode() + b'\0' + path.read_bytes())
        else:
            require(stat.S_ISDIR(metadata.st_mode), 'unknown station filesystem member')
    return digest.hexdigest()


# verify every station interval against the original public provider body
def verify_batch(batch, raw, station, date):
    start = dt.datetime.fromisoformat(date + 'T00:00:00+00:00')
    start_seconds = int(start.timestamp())
    expected = None
    if raw is not None:
        payload = json.loads(raw)
        require(payload['type'] == 'obs_st' and payload['device_id'] == station['deviceId'] and payload['status']['status_code'] == 0, 'raw station identity or status changed')
        expected = {}
        for observation in payload['obs'] or []:
            require(len(observation) >= 22 and type(observation[0]) is int, 'raw observation shape changed')
            epoch = observation[0]
            if start_seconds <= epoch < start_seconds + 86400:
                expected.setdefault(epoch, observation)
    seen = set()
    for row in batch['records']:
        time = dt.datetime.fromisoformat(row['validAt'].replace('Z', '+00:00'))
        require(time.tzinfo is not None and time.timestamp() % 60 == 0, 'station timestamp is not an exact minute')
        epoch = int(time.timestamp())
        require(start_seconds <= epoch < start_seconds + 86400 and epoch not in seen, 'duplicate or out-of-day station observation')
        seen.add(epoch)
        provider = row['metadata']['provider']
        require(row['sourceId'] == f"research-tempest-{station['locationId']}" and row['sourceKind'] == 'physical_sensor' and row['productRunAt'] is None, 'normalized station source changed')
        require(provider['device_id'] == station['deviceId'] and provider['location_id'] == station['locationId'] and row['metadata']['device']['serial'] == station['serial'], 'physical rain gauge changed')
        require(row['metadata']['upstreamTimezone'] == station['timezone'], 'station timezone changed')
        amount, interval = row['metrics']['precipitationMm'], provider['report_interval_minutes']
        require(amount is None or (type(amount) in (int, float) and math.isfinite(amount) and amount >= 0), 'invalid normalized rain amount')
        require(interval is None or (type(interval) in (int, float) and math.isfinite(interval) and interval > 0), 'invalid normalized report interval')
        if expected is not None:
            require(epoch in expected, 'normalized timestamp missing from raw response')
            observation = expected[epoch]
            require(amount == observation[12] and interval == observation[17] and row['metrics']['temperatureC'] == observation[7], 'rain amount, duration or temperature normalization changed')
            rate = None if amount is None or interval is None else amount * (60 / interval)
            require(row['metrics']['precipitationRateMmPerHour'] == rate, 'rain rate differs from reported interval amount')
    if expected is not None:
        require(seen == set(expected), 'raw observation omitted from normalization')
    return len(seen)


# independently validate the full frozen day grid and original response lineage
def verify(root, evidence):
    acquisition = root / 'station-acquisition'
    before = tree(acquisition)
    manifest_bytes = (acquisition / 'manifest.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    contract_bytes = (acquisition / 'contract.json').read_bytes()
    contract = json.loads(contract_bytes)
    require(contract_bytes == (evidence / 'station-acquisition-plan.json').read_bytes(), 'station acquisition plan changed')
    require(contract['contractVersion'] == 'rain-sub24-station-acquisition/v1' and contract['stationIds'] == list(IDS), 'wrong station contract or pool')
    require(contract['first'] == '2024-03-13' and contract['last'] == '2026-09-02' and contract['requestedDays'] == 4520 and contract['maximumAttempts'] == 4520 and contract['attemptsPerDay'] == 1 and contract['minimumGlobalStartSpacingMs'] == 1000, 'station acquisition scope changed')
    require(all(manifest[key] == value for key, value in contract.items()) and manifest['complete'] is True and manifest['stopped'] is False and manifest['productionWrites'] is False, 'station final manifest is incomplete or inconsistent')
    catalog_bytes = (root / 'station-discovery/resolved.json').read_bytes()
    require(sha(catalog_bytes) == contract['catalogSha256'], 'station catalog hash changed')
    catalog = {row['locationId']: row for row in json.loads(catalog_bytes) if row['locationId'] in IDS}
    require(set(catalog) == set(IDS) and len({row['deviceId'] for row in catalog.values()}) == 5, 'duplicate or absent physical gauges')
    repo = Path(__file__).resolve().parents[2]
    for path, expected in contract['sourceHashes'].items():
        require(sha((repo / path).read_bytes()) == expected, 'station normalization source changed')
    first = dt.date(2024, 3, 13)
    identities = {(station, (first + dt.timedelta(days=day)).isoformat()) for station in IDS for day in range(904)}
    require(len(manifest['receipts']) == len(identities) and {(row['stationId'], row['date']) for row in manifest['receipts']} == identities, 'missing or unknown station day')
    require({path.name for path in (acquisition / 'days').iterdir()} == {f'{station}-{date}' for station, date in identities}, 'unexpected station day directory')
    counts, rows_by_station, raw_rows, starts = collections.Counter(), collections.Counter(), 0, []
    for receipt in manifest['receipts']:
        station, date = receipt['stationId'], receipt['date']
        day = acquisition / 'days' / f'{station}-{date}'
        require(json.loads((day / 'receipt.json').read_text()) == receipt, 'station day receipt differs from manifest')
        require(receipt['start'] == date + 'T00:00:00.000Z' and receipt['end'] == (dt.date.fromisoformat(date) + dt.timedelta(days=1)).isoformat() + 'T00:00:00.000Z', 'station request window changed')
        require(receipt['status'] in ('success', 'gap') and receipt['attempts'] in (0, 1), 'unknown station terminal result')
        raw = None
        if receipt['attempts'] == 1:
            request = json.loads((day / 'request.json').read_text())
            require(all(request[key] == receipt[key] for key in ('stationId', 'date', 'start', 'end')) and request['credentialRetained'] is False, 'station request identity changed')
            starts.append(dt.datetime.fromisoformat(request['startedAtUtc'].replace('Z', '+00:00')).timestamp())
            if (day / 'response.bin.gz').exists():
                compressed = (day / 'response.bin.gz').read_bytes()
                raw = gzip.decompress(compressed)
                require(sha(compressed) == receipt['compressedResponseSha256'] and sha(raw) == receipt['responseSha256'], 'original station response changed')
        counts[receipt['status']] += 1
        if receipt['status'] == 'gap':
            require(receipt['attempts'] == 1 and 'errorCode' in receipt, 'unexplained station gap')
            continue
        compressed = (day / 'normalized.json.gz').read_bytes()
        require(sha(compressed) == receipt['normalizedSha256'], 'normalized station member changed')
        batch = json.loads(gzip.decompress(compressed))
        require(batch['checksum'] == receipt['providerChecksum'], 'provider checksum changed')
        if receipt['attempts'] == 0:
            require(receipt['reusedProbe'] is True and date in ('2024-09-01', '2026-01-15'), 'unexplained uncounted station request')
            original = json.loads((root / 'station-discovery/probes' / f'{station}-{date}.json').read_text())
            require(original == batch, 'reused probe differs from retained discovery response')
            counts['reusedProbeDaysWithoutRawBody'] += 1
        else:
            require(raw is not None and sha(raw) == batch['checksum'], 'successful station response lacks original provider bytes')
        verified_rows = verify_batch(batch, raw, catalog[station], date)
        require(verified_rows == receipt['rows'], 'station day record count changed')
        rows_by_station[station] += verified_rows
        raw_rows += verified_rows if raw is not None else 0
    starts.sort()
    require(len(starts) == manifest['attempts'] and len(starts) <= 4520, 'station attempt count or bound changed')
    require(all(starts[index] - starts[index - 1] >= .998 for index in range(1, len(starts))), 'station global pacing violated')
    after = tree(acquisition)
    require(before == after, 'station acquisition changed during verification')
    result = {'contractVersion': 'rain-sub24-station-independent-verification/v1', 'verified': True, 'manifestSha256': sha(manifest_bytes), 'treeSha256': after, 'days': 4520, 'attempts': len(starts), 'statusCounts': dict(counts), 'rowsByStation': dict(rows_by_station), 'independentlyReconstructedRawRows': raw_rows, 'historicalReceiptTimesKnown': False, 'productionWrites': False}
    (evidence / 'station-independent-verification.json').write_text(json.dumps(result, sort_keys=True) + '\n')
    return result


# verify only stable private artifacts with no provider requests
if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('evidence', type=Path)
    args = parser.parse_args()
    print(json.dumps(verify(args.root, args.evidence)))
