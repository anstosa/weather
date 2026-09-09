"""acquire a separately bounded two-year-plus first-day forecast corpus."""

import argparse
import concurrent.futures
import datetime as dt
import hashlib
import os
import shutil
import stat
import threading
from collections import Counter
from pathlib import Path

import acquire_moisture_runs as shared
from export_moisture_history import validate_private_root

CONTRACT = 'rain-sub24-acquisition/v1'
COHORT = 'ecmwf_single_run_hindcast'
START = dt.date(2024, 3, 14)
END = dt.date(2026, 8, 31)
MAXIMUM_ATTEMPTS = 3800


# freeze the independent request scope before contacting the archive
def plan():
    return {
        'contractVersion': CONTRACT, 'endpoint': shared.ENDPOINT,
        'cohorts': {COHORT: {'model': 'ecmwf_ifs', 'from': START.isoformat(), 'through': END.isoformat()}},
        'cycleHoursUtc': [0, 6, 12, 18], 'requestedRuns': ((END - START).days + 1) * 4,
        'variables': list(shared.EXPECTED_VARIABLES), 'forecastHours': 49, 'selectedLeads': [1, 48],
        'minimumGlobalStartSpacingMs': 1000, 'concurrency': 3,
        'maximumAttemptsPerRun': 2, 'maximumAttempts': MAXIMUM_ATTEMPTS,
        'rateCaps': {'hourly': MAXIMUM_ATTEMPTS, 'daily': MAXIMUM_ATTEMPTS},
        'productionWrites': False, 'modelFit': False, 'actualIssueTimeKnown': False,
        'priorKnownResearchStartsWithin24h': 4417,
        'recentProductionAttemptsWithin24h': 138,
        'scheduledRecoveryMaximumAttempts': 4800,
        'knownImmediateUpperBoundIncludingProduction': 4417 + MAXIMUM_ATTEMPTS + 138,
        'knownScheduledWindowUpperBoundIncludingProduction': MAXIMUM_ATTEMPTS + 4800 + 138,
        'providerDailyLimit': 10000, 'providerHourlyLimit': 5000,
        'providerRateSource': 'https://open-meteo.com/en/pricing',
        'latestStartUtc': '2026-09-09T06:00:00Z',
        'stopPolicy': 'stop_on_429_or_budget_no_endpoint_rotation_no_unbounded_retry',
        'existingScheduledRecovery': 'unchanged_separate_owned_root_and_frozen_sources',
    }


# require byte-equivalent policy semantics on first execution and resume
def validate_plan(value):
    # reject scope, timing, traffic-budget or endpoint changes
    if value != plan():
        raise ValueError('rain sub24 acquisition plan changed')
    return value


# enumerate true model initialization identities without inventing issue times
def identities(value):
    validate_plan(value)
    result = []
    # request every date and all four archived model cycles
    for date in shared.inclusive_dates(START, END):
        for hour in value['cycleHoursUtc']:
            run = f'{date.isoformat()}T{hour:02d}:00'
            key = f'{COHORT}|{run}'
            result.append({'key': key, 'cohort': COHORT, 'model': 'ecmwf_ifs', 'run': run,
                           'runInitializedAt': run + ':00Z',
                           'slug': hashlib.sha256(key.encode()).hexdigest()[:24]})
    return result


# reject links and non-private descendants before shared helpers touch resumed data
def private_child(root, name):
    child = root / name
    # do not follow an existing link even when its target is absent
    if child.is_symlink():
        raise ValueError('rain acquisition child is a symlink')
    child.mkdir(mode=0o700, exist_ok=True)
    # verify all existing descendants once before resuming
    for path in [child, *child.rglob('*')]:
        metadata = path.lstat()
        if stat.S_ISLNK(metadata.st_mode) or not (stat.S_ISDIR(metadata.st_mode) or stat.S_ISREG(metadata.st_mode)) or metadata.st_uid != os.getuid() or metadata.st_mode & 0o077:
            raise ValueError('rain acquisition descendant is not private owned material')
        if not path.resolve().is_relative_to(root.resolve()):
            raise ValueError('rain acquisition descendant escaped its root')
    return child


# assemble only the declared rain cohort under its own contract
def finalize(plan_path, value, population, acquisition, source_hashes, controller):
    validate_plan(value)
    # reject truncated or reordered scope before publishing
    if population != identities(value):
        raise ValueError('rain finalization population changed')
    normalized_root = private_child(acquisition, 'normalized')
    output_path = normalized_root / f'{COHORT}.jsonl'
    temporary = output_path.with_name(f'.{output_path.name}.{os.getpid()}.partial')
    receipts, statuses, gaps = [], Counter(), Counter()
    nulls = {variable: 0 for variable in value['variables']}
    digest, byte_count, row_count, successes = hashlib.sha256(), 0, 0, 0
    # publish an ordered stream only after every retained receipt is verified
    with temporary.open('xb') as output:
        for identity in population:
            run_root = acquisition / 'runs' / COHORT / identity['slug']
            receipt = shared.verified_success(run_root, identity)
            if receipt is None:
                receipt = {**identity, 'status': 'pending', 'actualIssueAt': None,
                           'attemptCount': len(shared.attempt_records(run_root))}
            receipts.append(receipt)
            statuses[receipt['status']] += 1
            if receipt['status'] == 'gap':
                gaps[receipt['gapReason']] += 1
            if receipt['status'] != 'success':
                continue
            normalized = (run_root / receipt['normalizedPath']).read_bytes()
            output.write(normalized)
            digest.update(normalized)
            byte_count += len(normalized)
            row_count += len(normalized.splitlines())
            successes += 1
            for variable, count in receipt['nullCountsSelectedLeads'].items():
                nulls[variable] += count
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, output_path)
    manifest = {
        'contractVersion': CONTRACT, 'completedAtUtc': dt.datetime.now(dt.timezone.utc).isoformat(),
        'plan': {'path': str(plan_path), 'bytes': plan_path.stat().st_size,
                 'sha256': shared.sha256_bytes(plan_path.read_bytes())},
        'sourceSha256': source_hashes, 'endpoint': value['endpoint'],
        'requestCoordinates': {'latitude': float(shared.SITE_LATITUDE), 'longitude': float(shared.SITE_LONGITUDE)},
        'requestedRuns': len(population), 'attemptsStarted': controller.total_attempts,
        'statusCounts': dict(statuses), 'gapCounts': dict(gaps),
        'nullCountsSelectedLeads': {COHORT: nulls},
        'cohortFiles': {COHORT: {'path': str(output_path.relative_to(acquisition)),
                                'bytes': byte_count, 'sha256': digest.hexdigest(),
                                'rows': row_count, 'successfulRuns': successes}},
        'identities': receipts, 'actualIssueTimeKnown': False,
        'runReferenceClassification': shared.ROW_CLASSIFICATION,
        'productionWrites': False, 'modelFit': False,
    }
    shared.write_json(acquisition / 'manifest.json', manifest)
    return manifest


# bind sources and policy without modifying the older scheduled experiment
def freeze(root, evidence, value):
    acquisition = private_child(root, 'acquisition')
    source_root = private_child(root, 'forecast-acquisition-sources')
    sources = [Path(__file__), Path(shared.__file__), Path(__file__).with_name('export_moisture_history.py')]
    hashes = {path.name: shared.sha256_bytes(path.read_bytes()) for path in sources}
    contract = {'contractVersion': CONTRACT, 'plan': value, 'sourceSha256': hashes,
                'productionWrites': False, 'modelFit': False}
    target = acquisition / 'contract.json'
    # require the same immutable contract before any resumed request
    if target.exists():
        if shared.read_json(target) != contract:
            raise ValueError('rain acquisition source or plan changed')
    else:
        shared.write_json(target, contract)
    # retain exact loaded sources with explicit resume integrity
    for path in sources:
        destination = source_root / path.name
        if destination.exists():
            if shared.sha256_bytes(destination.read_bytes()) != hashes[path.name]:
                raise ValueError('frozen rain acquisition source changed')
        else:
            shutil.copy2(path, destination)
            destination.chmod(0o600)
    shared.write_json(evidence / 'acquisition-plan.json', value)
    shared.write_json(evidence / 'acquisition-code-freeze.json', contract)
    return acquisition, hashes


# keep progress resumable while enforcing the separate lower global cap
def acquire(root, evidence):
    root = validate_private_root(root)
    evidence.mkdir(mode=0o700, parents=True, exist_ok=True)
    value = plan()
    population = identities(value)
    # prevent this one-time quota audit being reused on an unaudited later day
    if dt.datetime.now(dt.timezone.utc) >= dt.datetime.fromisoformat(value['latestStartUtc'].replace('Z', '+00:00')):
        raise ValueError('rain acquisition quota audit has expired')
    acquisition, source_hashes = freeze(root, evidence, value)
    starts = shared.prior_attempt_starts(acquisition, population)
    stop = threading.Event()
    controller = shared.AttemptController(value, starts, stop)
    pending, existing = [], []
    # retain every exact prior success or terminal gap on resume
    for identity in population:
        receipt = shared.verified_success(acquisition / 'runs' / COHORT / identity['slug'], identity)
        if receipt is None:
            pending.append(identity)
        else:
            existing.append(receipt)
    progress = shared.ProgressReporter(evidence / 'acquisition-progress.json', acquisition / 'progress.json', len(population), existing, controller)
    progress.write('running')
    failures = []
    # preserve bounded concurrency instead of enqueuing the entire archive
    with concurrent.futures.ThreadPoolExecutor(max_workers=value['concurrency']) as executor:
        iterator = iter(pending)
        in_flight = {}
        exhausted = False
        while in_flight or not exhausted:
            # stop submitting immediately after any rate or budget boundary
            while not exhausted and not stop.is_set() and len(in_flight) < value['concurrency']:
                identity = next(iterator, None)
                if identity is None:
                    exhausted = True
                    break
                future = executor.submit(shared.acquire_identity, identity, value, acquisition, '/usr/bin/curl', shared.DEFAULT_RESOLVE_ADDRESS, controller, stop)
                in_flight[future] = identity
            if not in_flight:
                break
            finished, _ = concurrent.futures.wait(in_flight, return_when=concurrent.futures.FIRST_COMPLETED)
            # preserve terminal outcomes and stop on unexpected failures
            for future in finished:
                identity = in_flight.pop(future)
                try:
                    receipt, newly_terminal = future.result()
                    if newly_terminal:
                        progress.terminal(receipt)
                    # stop the whole batch at authorization or provider quota boundaries
                    if any(status in (401, 403, 429) for status in receipt.get('httpStatuses', [])):
                        stop.set()
                except Exception as error:  # noqa: BLE001 - stop all requests on unexpected worker failures
                    failures.append({'key': identity['key'], 'errorType': type(error).__name__})
                    stop.set()
    # recheck all loaded source bytes before publishing the aggregate
    for name, expected in source_hashes.items():
        if shared.sha256_bytes(Path(__file__).with_name(name).read_bytes()) != expected:
            raise ValueError('rain acquisition sources changed in flight')
    manifest = finalize(evidence / 'acquisition-plan.json', value, population, acquisition, source_hashes, controller)
    complete = manifest['statusCounts'].get('pending', 0) == 0 and not failures
    progress.write('complete' if complete else 'stopped')
    receipt = {'contractVersion': CONTRACT, 'complete': complete, 'requestedRuns': len(population),
               'attemptsStarted': controller.total_attempts, 'statusCounts': manifest['statusCounts'],
               'gapCounts': manifest['gapCounts'], 'sourceSha256': source_hashes,
               'manifestSha256': shared.sha256_bytes((acquisition / 'manifest.json').read_bytes()),
               'productionWrites': False, 'modelFit': False, 'failures': failures}
    shared.write_json(evidence / 'acquisition-receipt.json', receipt)
    print(shared.canonical_json(receipt), flush=True)
    return 0 if complete else 1


# expose only the dedicated private data root and aggregate evidence directory
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('private_root', type=Path)
    parser.add_argument('evidence', type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    return acquire(args.private_root, args.evidence)


# importing this module never contacts a provider
if __name__ == '__main__':
    raise SystemExit(main())
