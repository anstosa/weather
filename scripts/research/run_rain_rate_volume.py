"""run one frozen out-of-fold rain-volume calibration experiment."""

import argparse
import collections
import datetime as dt
import gzip
import json
import os
from pathlib import Path
import shutil

# bound numerical pools before importing the shared research code
os.environ['OPENBLAS_NUM_THREADS'] = '1'
os.environ['OMP_NUM_THREADS'] = '1'

import numpy as np
import rain_rate_volume as volume
import run_rain_rate_research as scoring

CONTINUATION_GATES = {
    'minimumMaeImprovementVsRaw': 0.02,
    'absoluteVolumeErrorVsV1Guard': 'strictly_smaller',
    'existingDevelopmentGates': 'all_required_unchanged',
    'candidateSupport': 'at_least_180_supported_dates_and_20_supported_wet_dates',
    'primaryCandidate': 'volumeCalibratedGuard',
    'diagnosticCandidate': 'volumeNeutralGuard',
    'betweenArmSelection': 'none',
    'accuracyQualification': False,
}
NEW_CANDIDATES = ('volumeNeutralGuard', 'volumeCalibratedGuard')
RAW_CATEGORIES = ('zero', 'trace', 'wet', 'heavy1', 'heavy2')


# require one verified baseline without repeating or altering native fits
def verify_baseline(directory, verification_path):
    receipt = json.loads((directory / 'receipt.json').read_text())
    freeze = json.loads((directory / 'freeze.json').read_text())
    verification = json.loads(verification_path.read_text())
    # require the original full refit receipt and immutable input binding
    if (verification.get('verified') is not True or verification.get('fullDeterministicRefit') is not True
            or verification.get('productionEligible') is not False or verification.get('accuracyQualification') is not False
            or verification.get('retainedReceiptSha256') != scoring.digest(directory / 'receipt.json')
            or verification.get('inputSha256') != receipt.get('files', {}).get('input.jsonl.gz')
            or freeze.get('policy', {}).get('contractVersion') != 'rain-rate-tweedie-research/v1'):
        raise ValueError('baseline lacks matching full-refit evidence')
    paths = dict(receipt['files'])
    paths['receipt.json'] = scoring.digest(directory / 'receipt.json')
    # bind every original file and disallow path traversal or linked inputs
    for name, expected in paths.items():
        path = directory / name
        if Path(name).is_absolute() or '..' in Path(name).parts or path.is_symlink() or directory.resolve() not in path.resolve().parents:
            raise ValueError('invalid baseline artifact path')
        if scoring.digest(path) != expected:
            raise ValueError('baseline artifact checksum mismatch')
    # independently bind the pre-fit source snapshot identities
    for name, expected in freeze['sourceSha256'].items():
        if paths.get('sources/' + name) != expected:
            raise ValueError('baseline source freeze mismatch')
    if freeze['inputSha256'] != paths['input.jsonl.gz']:
        raise ValueError('baseline input freeze mismatch')
    return paths


# apply stronger continuation requirements without relaxing existing checks
def continuation_screen(summary):
    result = {}
    # retain explicit absence of a score population
    if not summary['candidates']:
        return result
    existing = scoring.screen(summary, volume.CANDIDATES)
    raw = summary['candidates']['raw']
    guard = summary['candidates']['intensityGuard']
    # report both frozen arms without selecting a favorable result
    for name in NEW_CANDIDATES:
        candidate = summary['candidates'][name]
        candidate_ratio = candidate['volumeRatio']
        guard_ratio = guard['volumeRatio']
        checks = {
            'existingDevelopmentScreen': existing[name]['passesDevelopmentScreen'],
            'minimumTwoPercentMaeGainVsRaw': candidate['maeMmPerHour'] <= (1 - CONTINUATION_GATES['minimumMaeImprovementVsRaw']) * raw['maeMmPerHour'],
            'volumeErrorStrictlyBelowV1Guard': candidate_ratio is not None and guard_ratio is not None and abs(candidate_ratio - 1) < abs(guard_ratio - 1),
        }
        result[name] = {'passesContinuationScreen': all(checks.values()), 'checks': checks}
    return result


# classify forecast categories without consulting observed outcomes
def raw_category(raw):
    # preserve exactly dry forecasts separately from trace amounts
    if raw == 0:
        return 'zero'
    # retain the frozen dry trace interval
    if raw < 0.1:
        return 'trace'
    # retain ordinary wet forecasts
    if raw < 1:
        return 'wet'
    # retain the first heavy interval
    if raw < 2.5:
        return 'heavy1'
    return 'heavy2'


# expose missed rain without renormalizing within favorable categories
def category_volume(rows):
    weights = scoring.weights(rows) if rows else np.asarray([])
    actual = np.asarray([row['actualPrecipitationMm'] for row in rows])
    observed = float(weights @ actual)
    result = {}
    # keep category contributions on the full population's balancing weights
    for category in RAW_CATEGORIES:
        mask = np.asarray([raw_category(row['rawPrecipitationMm']) == category for row in rows], dtype=bool)
        selected = [row for row, included in zip(rows, mask) if included]
        contribution = float(weights[mask] @ actual[mask])
        result[category] = {
            'rows': len(selected), 'hours': len({row['validAt'] for row in selected}),
            'weightMass': float(weights[mask].sum()),
            'observedMeanContributionMmPerHour': contribution,
            'observedVolumeShare': None if observed == 0 else contribution / observed,
            'predictedMeanContributionMmPerHour': {
                name: float(weights[mask] @ np.asarray([row['predictions'][name] for row in selected]))
                for name in volume.CANDIDATES
            },
        }
    return result


# retain every candidate-specific reason on the unchanged scoring population
def fallback_counts(rows):
    return {name: dict(sorted(collections.Counter(row['calibrationReasons'][name] for row in rows).items())) for name in NEW_CANDIDATES}


# group explicit fallback reasons without changing fitted states
def support_report(rows):
    result = {'overall': fallback_counts(rows)}
    # expose source support failures by literal band and valid month
    for field, key_function in [('byLeadBand', scoring.shared.lead_band), ('byMonth', lambda row: scoring.shared.calendar(row)['localDate'][:7])]:
        groups = collections.defaultdict(list)
        for row in rows:
            groups[key_function(row)].append(row)
        result[field] = {key: fallback_counts(value) for key, value in sorted(groups.items())}
    return result


# retain one coherent native-only report with every baseline and challenger
def report_rows(rows, model_count, baseline_receipt_sha):
    result = {'contractVersion': 'rain-rate-volume-report/v1', 'productionEligible': False,
              'accuracyQualification': False, 'policy': volume.POLICY,
              'baseGates': scoring.GATES, 'continuationGates': CONTINUATION_GATES,
              'baselineReceiptSha256': baseline_receipt_sha,
              'predictionRows': len(rows), 'modelCount': model_count,
              'interpretation': 'post_v1_selection_consumed_development_data_no_retuning_no_transfer_claim',
              'periods': {}}
    # retain complete months and partial september separately
    for period, (start, end) in scoring.PERIODS.items():
        selected = [row for row in rows if start <= scoring.shared.calendar(row)['localDate'] <= end]
        summaries = scoring.summarize(selected, volume.CANDIDATES)
        detail = {'native': summaries, 'continuationScreens': {}, 'rawCategoryVolume': {}, 'supportAndFallbacks': {}}
        # never pool sources to obtain favorable denominators
        for cohort in scoring.shared.COHORTS:
            cohort_rows = [row for row in selected if row['cohort'] == cohort]
            summary = summaries[cohort]
            detail['continuationScreens'][cohort] = {
                'overall': continuation_screen(summary['overall']),
                'byLeadBand': {key: continuation_screen(value) for key, value in summary['byLeadBand'].items()},
            }
            detail['rawCategoryVolume'][cohort] = category_volume(cohort_rows)
            detail['supportAndFallbacks'][cohort] = support_report(cohort_rows)
        result['periods'][period] = detail
    return result


# retain the untouched baseline predictions alongside each causal extension
def evaluate(base_rows, output, baseline_receipt_sha):
    partitions = collections.defaultdict(list)
    scoring_groups = collections.defaultdict(list)
    seen = set()
    # reject transfer populations rather than silently extending this experiment
    for row in base_rows:
        if row.get('recordKind') != 'native' or row['key'] in seen:
            raise ValueError('baseline requires unique native predictions')
        seen.add(row['key'])
        month = scoring.shared.issue_month(row)
        band = scoring.shared.lead_band(row)
        partitions[(row['cohort'], band)].append(row)
        scoring_groups[(month, row['cohort'], band)].append(row)
    states = {}
    # fit only volume roots from earlier genuinely out-of-fold predictions
    with gzip.open(output / 'calibration-models.jsonl.gz', 'xt', compresslevel=1) as stream:
        for (month, cohort, band) in sorted(scoring_groups):
            state = volume.fit(partitions[(cohort, band)], month, cohort, band)
            states[(month, cohort, band)] = state
            stream.write(json.dumps(state, allow_nan=False, separators=(',', ':')) + '\n')
    predictions = []
    # keep every original scoring row and exact original four predictions
    with gzip.open(output / 'predictions.jsonl.gz', 'xt', compresslevel=1) as stream:
        for identity, rows in sorted(scoring_groups.items()):
            state = states[identity]
            for row, values in zip(rows, volume.predict_many(rows, state), strict=True):
                supported = {'raw': True, 'zero': True, 'tweedieBlend': row['modelSupported'], 'intensityGuard': row['modelSupported'], **volume.calibration_support(row, state)}
                reasons = {name: 'base_model_unsupported' if not row['modelSupported'] else 'applied' if supported[name] else state['arms'][name]['reason'] for name in NEW_CANDIDATES}
                # fail before scoring if inherited predictions or guard invariants changed
                for name in scoring.model.CANDIDATES:
                    if values[name] != row['predictions'][name]:
                        raise ValueError('volume extension changed a baseline prediction')
                for name in NEW_CANDIDATES:
                    value = scoring.model.rain.amount(values[name])
                    raw = row['rawPrecipitationMm']
                    if (not supported[name] and value != raw) or (raw == 0 and value != 0) or any((value >= threshold) != (raw >= threshold) for threshold in scoring.THRESHOLDS):
                        raise ValueError('volume extension violated raw fallback or categories')
                event = {**row, 'predictions': values, 'candidateSupported': supported,
                         'calibrationIdentity': list(identity), 'calibrationCutoffUtc': state['sourceCutoffUtc'],
                         'calibrationReasons': reasons}
                predictions.append(event)
                stream.write(json.dumps(event, allow_nan=False, separators=(',', ':')) + '\n')
    return report_rows(predictions, len(states), baseline_receipt_sha)


# copy and bind immutable baseline evidence before fitting the new stage
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('baseline', type=Path)
    parser.add_argument('baseline_verification', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    baseline_files = verify_baseline(args.baseline, args.baseline_verification)
    args.output.mkdir(mode=0o700)
    baseline_copy = args.output / 'baseline'
    baseline_copy.mkdir(mode=0o700)
    # copy only receipt-bound baseline artifacts into the new private snapshot
    for name, expected in baseline_files.items():
        destination = baseline_copy / name
        destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        shutil.copy2(args.baseline / name, destination)
        if scoring.digest(destination) != expected:
            raise ValueError('baseline changed while copying')
    shutil.copy2(args.baseline_verification, baseline_copy / 'independent-verification.json')
    baseline_files['independent-verification.json'] = scoring.digest(args.baseline_verification)
    verify_baseline(baseline_copy, baseline_copy / 'independent-verification.json')
    sources = [Path(__file__), Path(volume.__file__), Path(scoring.__file__), Path(scoring.model.__file__), Path(scoring.model.rain.__file__), Path(scoring.shared.__file__)]
    source_hashes = {source.name: scoring.digest(source) for source in sources}
    snapshot = args.output / 'sources'
    snapshot.mkdir(mode=0o700)
    # freeze the exact loaded extension and scorer sources
    for source in sources:
        shutil.copy2(source, snapshot / source.name)
        if scoring.digest(snapshot / source.name) != source_hashes[source.name]:
            raise ValueError('extension source changed while copying')
    freeze = {'contractVersion': 'rain-rate-volume-experiment/v1', 'productionEligible': False,
              'policy': volume.POLICY, 'continuationGates': CONTINUATION_GATES,
              'baselineFilesSha256': baseline_files, 'sourceSha256': source_hashes,
              'frozenAtUtc': dt.datetime.now(dt.timezone.utc).isoformat()}
    scoring.write_json(args.output / 'freeze.json', freeze)
    # consume only exact baseline predictions with their original embedded targets
    with gzip.open(baseline_copy / 'predictions.jsonl.gz', 'rt') as stream:
        rows = [json.loads(line) for line in stream]
    report = evaluate(rows, args.output, baseline_files['receipt.json'])
    # reject in-flight source changes rather than misattribute the experiment
    if source_hashes != {source.name: scoring.digest(source) for source in sources}:
        raise ValueError('extension source changed while fitting')
    scoring.write_json(args.output / 'report.json', report)
    files = {name: scoring.digest(args.output / name) for name in ('freeze.json', 'calibration-models.jsonl.gz', 'predictions.jsonl.gz', 'report.json')}
    files.update({'sources/' + name: expected for name, expected in source_hashes.items()})
    files.update({'baseline/' + name: expected for name, expected in baseline_files.items()})
    # prove all snapshots still match immediately before the completion receipt
    if any(scoring.digest(args.output / name) != expected for name, expected in files.items()):
        raise ValueError('retained snapshot changed while fitting')
    receipt = {'contractVersion': 'rain-rate-volume-receipt/v1', 'productionEligible': False,
               'baselineRows': len(rows), 'predictionRows': report['predictionRows'],
               'modelCount': report['modelCount'], 'files': files}
    scoring.write_json(args.output / 'receipt.json', receipt)
    print(json.dumps(receipt), flush=True)


# importing this module never starts an experiment
if __name__ == '__main__':
    main()
