"""Fit and score frozen rain-rate candidates without changing deployed weather."""

import argparse
import collections
import datetime as dt
import gzip
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import sys

# bound native pools before numerical imports
os.environ['OPENBLAS_NUM_THREADS'] = '1'
os.environ['OMP_NUM_THREADS'] = '1'
os.environ['MKL_NUM_THREADS'] = '1'

import numpy as np
import rain_rate_model as model
import humidity_research as shared

PERIODS = {
    'completeMonths': ('2025-01-01', '2026-08-31'),
    'partialSeptember': ('2026-09-01', '2026-09-06'),
}
THRESHOLDS = (0.1, 1.0, 2.5)
GATES = {
    'minimumDates': 180, 'minimumWetDates': 20,
    'overallMae': 'strictly_better_than_raw',
    'rmseAndObservedWetMae': 'no_worse_than_raw',
    'absoluteVolumeRatioError': 'no_worse_than_raw',
    'allThresholdPodAndEts': 'no_worse_than_raw',
    'allThresholdFar': 'no_worse_than_raw',
    'missingMetrics': 'fail_closed',
    'productionEligible': False,
    'interpretation': 'development_screen_only_not_independent_qualification',
}


# hash exact bytes without reading bulk inputs twice into memory
def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


# retain deterministic strict json artifacts
def write_json(path, value):
    with Path(path).open('x') as stream:
        json.dump(value, stream, allow_nan=False, sort_keys=True, separators=(',', ':'))
        stream.write('\n')


# average vintages within hours and hours within local dates
def weights(rows):
    result = shared.balanced_weights(rows)
    return result / result.sum()


# retain point-rate error and detection on the identical population
def score(rows, actual_field='actualPrecipitationMm', candidates=model.CANDIDATES):
    result = {'rows': len(rows), 'hours': len({row['validAt'] for row in rows}),
              'dates': len({shared.calendar(row)['localDate'] for row in rows}),
              'supportedRows': sum(row['modelSupported'] for row in rows),
              'wetDates': 0, 'candidates': {}}
    # keep missing score populations explicit
    if not rows:
        return result
    # retain candidate-specific support without filtering scoring rows
    if any('candidateSupported' in row for row in rows):
        result['supportByCandidate'] = {}
        # count supported dates separately for each fitted arm
        for name in candidates:
            supported = [row for row in rows if row.get('candidateSupported', {}).get(name) is True]
            result['supportByCandidate'][name] = {
                'rows': len(supported),
                'hours': len({row['validAt'] for row in supported}),
                'dates': len({shared.calendar(row)['localDate'] for row in supported}),
                'wetDates': len({shared.calendar(row)['localDate'] for row in supported if row[actual_field] >= THRESHOLDS[0]}),
            }
    actual = np.asarray([row[actual_field] for row in rows], dtype=float)
    wet = actual >= THRESHOLDS[0]
    wet_rows = [row for row, flag in zip(rows, wet) if flag]
    result['wetDates'] = len({shared.calendar(row)['localDate'] for row in wet_rows})
    weight = weights(rows)
    wet_weight = weights(wet_rows) if wet_rows else None
    observed = float(weight @ actual)
    # score all candidates without dropping adverse events
    for name in candidates:
        predicted = np.asarray([row['predictions'][name] for row in rows])
        error = predicted - actual
        metrics = {'maeMmPerHour': float(weight @ np.abs(error)),
                   'rmseMmPerHour': math.sqrt(float(weight @ (error ** 2))),
                   'biasMmPerHour': float(weight @ error),
                   'volumeRatio': None if observed == 0 else float(weight @ predicted) / observed,
                   'observedWetMaeMmPerHour': None if wet_weight is None else float(wet_weight @ np.abs(error[wet])),
                   'thresholds': {}}
        # retain wet and heavy-event detection separately from magnitude error
        for threshold in THRESHOLDS:
            event = actual >= threshold
            forecast = predicted >= threshold
            hit = float(weight @ (event & forecast))
            miss = float(weight @ (event & ~forecast))
            false_alarm = float(weight @ (~event & forecast))
            random_hit = (hit + miss) * (hit + false_alarm)
            denominator = hit + miss + false_alarm - random_hit
            metrics['thresholds'][str(threshold)] = {
                'POD': None if hit + miss == 0 else hit / (hit + miss),
                'FAR': None if hit + false_alarm == 0 else false_alarm / (hit + false_alarm),
                'ETS': None if denominator == 0 else (hit - random_hit) / denominator,
                'frequencyBias': None if hit + miss == 0 else (hit + false_alarm) / (hit + miss),
                'eventHours': len({row['validAt'] for row, flag in zip(rows, event) if flag}),
            }
        result['candidates'][name] = metrics
    return result


# preserve genuine same-reference contiguous accumulation windows
def accumulations(rows, candidates=model.CANDIDATES):
    groups = collections.defaultdict(dict)
    # fixed anchors have no reconstructed model initialization
    for row in rows:
        if row.get('referenceAt') is not None:
            group = groups[(row['cohort'], row['referenceAt'])]
            at = shared.instant(row['validAt'])
            # reject ambiguous same-run values
            if at in group:
                raise ValueError('duplicate same-reference accumulation hour')
            group[at] = row
    result = {}
    # report missing windows instead of filling absent hours with zero
    for hours in (3, 6, 12, 24):
        totals = []
        # construct windows within one run only
        for group in groups.values():
            for at, row in group.items():
                pieces = [group.get(at - dt.timedelta(hours=offset)) for offset in range(hours)]
                # require complete observed windows
                if any(piece is None for piece in pieces):
                    continue
                totals.append({**row,
                    'actualPrecipitationMm': sum(piece['actualPrecipitationMm'] for piece in pieces),
                    'predictions': {name: sum(piece['predictions'][name] for piece in pieces) for name in candidates}})
        summary = {'rows': len(totals), 'dates': len({shared.calendar(row)['localDate'] for row in totals}), 'candidates': {}}
        # totals use millimeters rather than hourly rate thresholds
        if totals:
            weight = weights(totals)
            actual = np.asarray([row['actualPrecipitationMm'] for row in totals])
            for name in candidates:
                predicted = np.asarray([row['predictions'][name] for row in totals])
                summary['candidates'][name] = {'maeMm': float(weight @ np.abs(predicted - actual)),
                    'biasMm': float(weight @ (predicted - actual)),
                    'volumeRatio': None if weight @ actual == 0 else float(weight @ predicted / (weight @ actual))}
        result[str(hours)] = summary
    return result


# require finite metrics for each declared directional comparison
def no_worse(candidate, baseline, direction=1):
    return candidate is not None and baseline is not None and math.isfinite(candidate) and math.isfinite(baseline) and direction * candidate <= direction * baseline


# screen candidates without treating a retrospective pass as release approval
def screen(summary, candidates=model.CANDIDATES):
    result = {}
    # never qualify an empty population
    if not summary['candidates']:
        return result
    raw = summary['candidates']['raw']
    # retain every failed gate rather than selecting a favorable statistic
    for name in candidates[2:]:
        candidate = summary['candidates'][name]
        support = summary.get('supportByCandidate', {}).get(name, summary)
        checks = {
            'support': support['dates'] >= GATES['minimumDates'] and support['wetDates'] >= GATES['minimumWetDates'] and ((support.get('rows', 0) if 'supportByCandidate' in summary else summary['supportedRows']) > 0),
            'mae': candidate['maeMmPerHour'] < raw['maeMmPerHour'],
            'rmse': no_worse(candidate['rmseMmPerHour'], raw['rmseMmPerHour']),
            'wetMae': no_worse(candidate['observedWetMaeMmPerHour'], raw['observedWetMaeMmPerHour']),
            'volume': no_worse(None if candidate['volumeRatio'] is None else abs(candidate['volumeRatio'] - 1), None if raw['volumeRatio'] is None else abs(raw['volumeRatio'] - 1)),
        }
        # require event skill at every frozen threshold
        for threshold in THRESHOLDS:
            for metric, direction in (('POD', -1), ('ETS', -1), ('FAR', 1)):
                checks[f'{threshold}:{metric}'] = no_worse(candidate['thresholds'][str(threshold)][metric], raw['thresholds'][str(threshold)][metric], direction)
        result[name] = {'passesDevelopmentScreen': all(checks.values()), 'checks': checks}
    return result


# report every native source and explicit transfer separately
def summarize(rows, candidates=model.CANDIDATES):
    result = {}
    # do not combine long-anchor evidence with short-live history
    for cohort in shared.COHORTS:
        selected = [row for row in rows if row['cohort'] == cohort]
        overall = score(selected, candidates=candidates)
        summary = {'overall': overall, 'developmentScreen': screen(overall, candidates), 'accumulations': accumulations(selected, candidates)}
        # retain lead and calendar diagnostics without winner selection
        for field, key_function in [('byLeadBand', shared.lead_band), ('byMonth', lambda row: shared.calendar(row)['localDate'][:7]), ('bySeason', lambda row: shared.calendar(row)['season'])]:
            groups = collections.defaultdict(list)
            for row in selected:
                groups[key_function(row)].append(row)
            summary[field] = {key: score(value, candidates=candidates) for key, value in sorted(groups.items())}
        summary['leadBandDevelopmentScreens'] = {key: screen(value, candidates) for key, value in summary['byLeadBand'].items()}
        # change only the target in gauge and alignment sensitivities
        for name, target in [('alignmentSensitivity', 'shiftMinus5MinutesMm'), ('networkMeanSensitivity', 'gaugeMeanPrecipitationMm')]:
            paired = [row for row in selected if row.get(target) is not None]
            summary[name] = {'unchangedPrimaryPredictions': True, 'primary': score(paired, candidates=candidates), 'alternative': score(paired, target, candidates)}
        result[cohort] = summary
    return result


# validate model outputs before they become scoring evidence
def validate_predictions(row, predictions, supported):
    # reject incomplete or silently extended model arms
    if set(predictions) != set(model.CANDIDATES):
        raise ValueError('prediction candidate keys changed')
    # require physical finite rates
    for value in predictions.values():
        model.rain.amount(value)
    raw = row['rawPrecipitationMm']
    # preserve controls and unsupported raw fallback
    if predictions['raw'] != raw or predictions['zero'] != 0 or (not supported and any(predictions[name] != raw for name in model.CANDIDATES[2:])):
        raise ValueError('prediction controls or fallback changed')
    # keep the intensity-only detection contract explicit
    if (raw == 0 and predictions['intensityGuard'] != 0) or any((raw >= threshold) != (predictions['intensityGuard'] >= threshold) for threshold in THRESHOLDS):
        raise ValueError('intensity guard changed an event category')


# fit source-bound monthly states and retain full replayable model material
def evaluate(rows, output):
    seen = set()
    partitions = collections.defaultdict(list)
    # validate identities once before selecting model months
    for row in rows:
        shared.forecast_identity(row)
        model.features(row)
        model.rain.amount(row['actualPrecipitationMm'])
        # reject altered targets and ambiguous identities before any fit
        if row['key'] in seen or row.get('liquidOnly') is not True:
            raise ValueError('duplicate key or non-liquid target')
        # validate alternative targets without changing primary selection
        for field in ('shiftMinus5MinutesMm', 'gaugeMeanPrecipitationMm'):
            if row.get(field) is not None:
                model.rain.amount(row[field])
        seen.add(row['key'])
        partitions[(row['cohort'], shared.lead_band(row))].append(row)
    scoring = collections.defaultdict(list)
    # retain the complete declared evaluation calendar
    for row in rows:
        if '2025-01-01' <= shared.calendar(row)['localDate'] <= '2026-09-06':
            scoring[(shared.issue_month(row), row['cohort'], shared.lead_band(row))].append(row)
    keys = set(scoring)
    keys |= {(month, 'ecmwf_single_run_hindcast', band) for month, cohort, band in keys if cohort == 'best_match_single_run_transfer'}
    fitted = {}
    # snapshot every model including unsupported cells
    with gzip.open(output / 'models.jsonl.gz', 'xt', compresslevel=1) as stream:
        for month, cohort, band in sorted(keys):
            state = model.fit(partitions[(cohort, band)], month, cohort, band)
            fitted[(month, cohort, band)] = state
            stream.write(json.dumps(state, allow_nan=False, separators=(',', ':')) + '\n')
    predictions = []
    # retain source rows and model identities privately for independent verification
    with gzip.open(output / 'predictions.jsonl.gz', 'xt', compresslevel=1) as stream:
        for (month, cohort, band), selected in sorted(scoring.items()):
            branches = [('native', fitted[(month, cohort, band)])]
            # explicitly reuse the ecmwf fit without training on the transfer population
            if cohort == 'best_match_single_run_transfer':
                branches.append(('ecmwf_to_best_match', fitted[(month, 'ecmwf_single_run_hindcast', band)]))
            for kind, state in branches:
                values = model.predict_many(selected, state, transfer=kind != 'native')
                for row, predicted in zip(selected, values, strict=True):
                    validate_predictions(row, predicted, state['supported'])
                    event = {**row, 'predictions': predicted, 'recordKind': kind, 'modelSupported': state['supported'],
                             'modelIdentity': [month, state['cohort'], band], 'trainingCutoffUtc': state['trainingCutoffUtc']}
                    predictions.append(event)
                    stream.write(json.dumps(event, allow_nan=False, separators=(',', ':')) + '\n')
    report = {'policy': model.POLICY, 'gates': GATES, 'units': 'mean rain rate over complete reporting hour, mm/h; not instantaneous rain rate',
              'candidateSelection': 'two_frozen_challengers_no_retuning_prior_period_already_consumed',
              'productionEligible': False, 'periods': {}, 'modelCount': len(fitted),
              'inputRows': len(rows), 'predictionRows': len(predictions)}
    # keep partial september separate and retain explicit unsupported cohorts
    for name, (start, end) in PERIODS.items():
        selected = [row for row in predictions if start <= shared.calendar(row)['localDate'] <= end]
        report['periods'][name] = {kind: summarize([row for row in selected if row['recordKind'] == kind]) for kind in ('native', 'ecmwf_to_best_match')}
    return report


# freeze exact sources and inputs before starting a bounded private experiment
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('input', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--input-sha256', required=True)
    args = parser.parse_args()
    os.umask(0o077)
    # require a verified source rather than silently consuming changed data
    if digest(args.input) != args.input_sha256:
        raise ValueError('rain input checksum mismatch')
    args.output.mkdir(mode=0o700)
    sources = [Path(__file__), Path(model.__file__), Path(shared.__file__), Path(model.rain.__file__)]
    source_hashes = {source.name: digest(source) for source in sources}
    snapshot = args.output / 'sources'
    snapshot.mkdir(mode=0o700)
    # copy sources without touching the frozen moisture continuation
    for source in sources:
        shutil.copy2(source, snapshot / source.name)
        # bind copied sources rather than trusting a completed copy
        if digest(snapshot / source.name) != source_hashes[source.name]:
            raise ValueError('source changed during snapshot')
    freeze = {'policy': model.POLICY, 'gates': GATES, 'inputSha256': args.input_sha256,
              'sourceSha256': source_hashes,
              'frozenAtUtc': dt.datetime.now(dt.timezone.utc).isoformat(), 'productionEligible': False,
              'runtime': {'python': sys.version, 'numpy': np.__version__, 'xgboost': None if model.xgb is None else model.xgb.__version__}}
    write_json(args.output / 'freeze.json', freeze)
    # preserve exact model-ready input for encrypted reproduction
    shutil.copy2(args.input, args.output / 'input.jsonl.gz')
    with gzip.open(args.input, 'rt') as stream:
        rows = [json.loads(line) for line in stream]
    report = evaluate(rows, args.output)
    # fail if an in-flight edit or input mutation invalidates provenance
    if freeze['sourceSha256'] != {source.name: digest(source) for source in sources} or digest(args.input) != args.input_sha256:
        raise ValueError('research source changed while fitting')
    write_json(args.output / 'report.json', report)
    receipt = {'productionEligible': False, 'inputRows': report['inputRows'], 'predictionRows': report['predictionRows'],
               'files': {name: digest(args.output / name) for name in ('input.jsonl.gz', 'models.jsonl.gz', 'predictions.jsonl.gz', 'report.json', 'freeze.json')}}
    receipt['files'].update({'sources/' + source.name: digest(snapshot / source.name) for source in sources})
    write_json(args.output / 'receipt.json', receipt)
    print(json.dumps(receipt), flush=True)


# imports do not start fitting
if __name__ == '__main__':
    main()
