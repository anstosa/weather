"""Join verified forecasts to private rain and station-pressure observations."""

import argparse
import collections
import datetime as dt
import gzip
import hashlib
import json
import math
from pathlib import Path

import build_moisture_targets as target
import humidity_research as shared

METRICS = {'temperature_c': 'rawTemperatureC', 'relative_humidity_percent': 'rawRelativeHumidityPercent', 'wind_speed_mps': 'rawWindSpeedMps', 'precipitation_mm': 'rawPrecipitationMm', 'pressure_hpa': 'rawPressureHpa', 'cloud_cover_percent': 'rawCloudCoverPercent'}


# stream local model material without exposing rows in reports
def read_jsonl(path):
    opener = gzip.open if path.suffix == '.gz' else open
    # close owned resources after use
    with opener(path, 'rt') as stream:
        # process each selected item
        for line in stream:
            yield json.loads(line)


# normalize production forecasts without inventing archive initializations
def production_forecast(row, kind):
    valid = target.instant(row['valid_at'])
    reference = None if kind == 'anchors' else target.instant(row['product_run_at']) if row['product_run_at'] else None
    # live forecasts require an actual stored retrieval reference
    if kind == 'live' and reference is None:
        return None
    elapsed = row['lead_hours'] if kind == 'anchors' else (valid - reference).total_seconds() / 3600
    lead = math.ceil(elapsed)
    # retain only the frozen forward forecast horizon
    if elapsed <= 0 or not 1 <= lead <= 168:
        return None
    cohort = 'fixed_lead_anchor' if kind == 'anchors' else 'legacy_v4_retrieval_snapshot'
    value = {'key': f'{cohort}|{target.iso(valid)}|{lead}', 'cohort': cohort, 'validAt': target.iso(valid), 'referenceAt': None if reference is None else target.iso(reference), 'targetLeadHours': lead, 'referenceKind': 'fixed_lead_anchor' if reference is None else 'retrieval_snapshot', 'forecastElevationM': row['elevation_m'], 'sourceConfigFingerprint': row['source_config_fingerprint'], 'sourceContentHash': row['content_hash']}
    value.update({field: row[source] for source, field in METRICS.items()})
    priority = (abs(elapsed - lead), value['referenceAt'] or '', row['content_hash'], row['id'])
    return value, priority


# preserve exact jitter selection independently for each target metric
def select_production(rows, kind, metric):
    selected = {}
    # choose by lead/reference identity rather than observed outcome
    for row in rows:
        field = next(key for key, value in METRICS.items() if value == metric)
        # check the next guarded case
        if row[field] is None or not target.quality_ok(row):
            continue
        result = production_forecast(row, kind)
        # check the next guarded case
        if result is None:
            continue
        value, priority = result
        existing = selected.get(value['key'])
        # preserve the existing repository lead-jitter tie order
        if existing is None or priority < existing[1]:
            selected[value['key']] = value, priority
    return [value for value, _ in selected.values()]


# canonicalize timestamp spelling without changing archived forecast instants
def archive_forecast(row):
    result = dict(row)
    # bind target joins and model references to canonical millisecond utc keys
    for field in ('validAt', 'referenceAt', 'runInitializedAt'):
        if result.get(field) is not None:
            result[field] = target.iso(target.instant(result[field]))
    return result


# require a completed acquisition manifest bound to its independent receipt
def acquisition_manifest(root, receipt, evidence):
    data = (root / 'manifest.json').read_bytes()
    # refuse stopped acquisition or changed manifest content
    if receipt.get('status') != 'complete' or hashlib.sha256(data).hexdigest() != receipt.get('manifestSha256'):
        raise ValueError('acquisition receipt does not bind a complete manifest')
    manifest = json.loads(data)
    # preserve the public retrospective research boundary
    if manifest.get('contractVersion') != 'moisture-shortlead-acquisition/v1' or manifest.get('productionWrites') is not False or manifest.get('modelFit') is not False or manifest.get('actualIssueTimeKnown') is not False or set(manifest.get('cohortFiles', {})) != {'ecmwf_single_run_hindcast', 'best_match_single_run_transfer'}:
        raise ValueError('incompatible acquisition manifest')
    plan_bytes = (evidence / 'acquisition-plan.json').read_bytes()
    plan = json.loads(plan_bytes)
    freeze = json.loads((evidence / 'acquisition-code-freeze.json').read_text())
    # reject a completed acquisition from another plan or implementation
    if manifest.get('plan', {}).get('sha256') != hashlib.sha256(plan_bytes).hexdigest() or manifest.get('acquisitionScriptSha256') != freeze['script']['sha256'] or manifest.get('requestedRuns') != plan['requestedRuns'] or manifest.get('requestedRuns') != freeze['plan']['requestedRuns'] or manifest.get('endpoint') != plan['endpoint']:
        raise ValueError('acquisition differs from the frozen plan or source')
    return manifest


# join a metric on honest valid-time and source-specific support
def build(root, evidence, source_group='all'):
    # partition only already isolated source cohorts for bounded execution
    if source_group not in ('all', 'production', 'archive'):
        raise ValueError('invalid source partition')
    suffix = '' if source_group == 'all' else '-' + source_group
    output = root / ('pairs' + suffix)
    output.mkdir(mode=0o700)
    targets = {row['validAt']: row for row in read_jsonl(root / 'targets/rain.jsonl')}
    pressures = collections.defaultdict(dict)
    # station pressure levels are never pooled into one raw target
    for row in read_jsonl(root / 'targets/pressure.jsonl'):
        pressures[row['validAt']][row['stationKey']] = row
    production = root / 'production-moisture'
    manifest = target.production_manifest(production, evidence)
    identities = {row['source_key']: row for row in manifest['sources']}
    forecast_sets = {'rain': [], 'pressure': []}
    # skip production only when evaluating the separate public archive partition
    if source_group != 'archive':
        # read every successful monthly forecast member
        for member in manifest['members']:
            kind = member['transaction']['kind']
            # check the next guarded case
            if kind not in ('anchors', 'live'):
                continue
            rows = list(target.read_member(production, member, identities))
            # process each selected item
            for metric, field in (('rain', 'rawPrecipitationMm'), ('pressure', 'rawPressureHpa')):
                forecast_sets[metric].extend(select_production(rows, kind, field))
    # require complete public acquisition only for the archive-dependent partition
    if source_group != 'production':
        acquisition = root / 'acquisition'
        # require exact complete acquisition receipts before consuming normalized files
        receipt = json.loads((evidence / 'acquisition-summary.json').read_text())
        normalized = []
        source_manifest = acquisition_manifest(acquisition, receipt, evidence)
        # consume only completed source-bound normalized cohorts
        for cohort in ('ecmwf_single_run_hindcast', 'best_match_single_run_transfer'):
            member = source_manifest['cohortFiles'][cohort]
            path = acquisition / member['path']
            # prevent a manifest path from escaping the private acquisition root
            if path.resolve().parent != (acquisition / 'normalized').resolve() or not path.is_file():
                raise ValueError('invalid normalized cohort path')
            # check the next guarded case
            if path.stat().st_size != member['bytes'] or hashlib.sha256(path.read_bytes()).hexdigest() != member['sha256']:
                raise ValueError('normalized cohort content changed')
            count = 0
            # process each selected item
            for row in read_jsonl(path):
                # check the next guarded case
                if row['cohort'] != cohort or row.get('actualIssueAt') is not None:
                    raise ValueError('invalid retrospective archive cohort')
                normalized.append(archive_forecast(row))
                count += 1
            # check the next guarded case
            if count != member['rows']:
                raise ValueError('normalized cohort row count changed')
        # preserve provider missingness independently per target metric
        for metric, field in (('rain', 'rawPrecipitationMm'), ('pressure', 'rawPressureHpa')):
            forecast_sets[metric].extend(row for row in normalized if row.get(field) is not None)
    summary = {}
    # freeze metric-specific paired denominators and support loss counts
    for metric, forecasts in forecast_sets.items():
        counts = collections.defaultdict(collections.Counter)
        seen = set()
        same_run = {(row['cohort'], row['referenceAt'], row['validAt']): row for row in forecasts if row['referenceAt'] is not None}
        handles = {}
        try:
            # process each selected item
            for row in forecasts:
                cohort = row['cohort']
                counts[cohort]['forecastRows'] += 1
                # check the next guarded case
                if row['key'] in seen:
                    raise ValueError('duplicate metric forecast key')
                seen.add(row['key'])
                date = shared.calendar(row)['localDate']
                # do not enlarge the fixed observed target period
                if not '2024-01-01' <= date <= '2026-09-06':
                    counts[cohort]['outsideTargetPeriod'] += 1
                    continue
                # shared forecast covariates have explicit physical availability
                if not target.numeric(row.get('rawRelativeHumidityPercent'), 0, 100):
                    counts[cohort]['missingHumidityPredictor'] += 1
                    continue
                band = shared.lead_band(row)
                name = f'{metric}-{band}.jsonl.gz' if metric == 'pressure' else 'rain.jsonl.gz'
                # check the next guarded case
                if name not in handles:
                    handles[name] = gzip.open(output / name, 'xt', compresslevel=1)
                # check the next guarded case
                if metric == 'rain':
                    observed = targets.get(row['validAt'])
                    # check the next guarded case
                    if observed is None:
                        counts[cohort]['missingNetworkTarget'] += 1
                        continue
                    # check the next guarded case
                    if not observed['liquidOnly']:
                        counts[cohort]['coldOrUnknownTemperature'] += 1
                        continue
                    pair = {**row, **{key: value for key, value in observed.items() if key != 'gaugeWindows'}}
                    handles[name].write(json.dumps(pair, separators=(',', ':')) + '\n')
                    counts[cohort]['pairedRows'] += 1
                else:
                    stations = pressures.get(row['validAt'], {})
                    # check the next guarded case
                    if not stations:
                        counts[cohort]['missingStationTargets'] += 1
                    valid = shared.instant(row['validAt'])
                    previous_at = shared.format_instant(valid - dt.timedelta(hours=3))
                    previous_forecast = same_run.get((cohort, row['referenceAt'], previous_at)) if row['referenceAt'] is not None else None
                    # process each selected item
                    for station, observed in stations.items():
                        previous_observed = pressures.get(previous_at, {}).get(station)
                        # keep forecast and station lineage fingerprints distinct
                        station_material = {key: value for key, value in observed.items() if key != 'sourceConfigFingerprint'}
                        station_material['observationSourceConfigFingerprint'] = observed['sourceConfigFingerprint']
                        pair = {**row, **station_material, 'key': row['key'] + '|' + station, 'forecastPressureChange3h': None if previous_forecast is None else row['rawPressureHpa'] - previous_forecast['rawPressureHpa'], 'actualPressureChange3h': None if previous_observed is None else observed['actualPressureHpa'] - previous_observed['actualPressureHpa']}
                        handles[name].write(json.dumps(pair, separators=(',', ':')) + '\n')
                        counts[cohort]['pairedRows'] += 1
                        counts[cohort]['station:' + station] += 1
        finally:
            # process each selected item
            for handle in handles.values():
                handle.close()
        summary[metric] = counts
    summary['files'] = {path.name: {'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()} for path in sorted(output.iterdir())}
    (evidence / ('moisture-pairs-summary' + suffix + '.json')).write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps(summary), flush=True)


# require an explicit private build invocation
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('private_root', type=Path)
    parser.add_argument('evidence', type=Path)
    parser.add_argument('--source-group', choices=('all', 'production', 'archive'), default='all')
    args = parser.parse_args()
    build(args.private_root.resolve(strict=True), args.evidence, args.source_group)


# do not start reads when imported by tests
if __name__ == '__main__':
    main()
