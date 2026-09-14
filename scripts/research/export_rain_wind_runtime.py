"""export the frozen August wind-hurdle fit from the retained private workspace.

regeneration needs ~/.weather/research-work/weather-moisture-research-rain-wind-20260913-v1;
the released source tree alone intentionally cannot regenerate the model bytes.
"""

import hashlib
import json
from pathlib import Path


ROOT = Path.home() / '.weather/research-work/weather-moisture-research-rain-wind-20260913-v1'
DESTINATION = Path(__file__).resolve().parents[2] / 'packages/forecast-adjustment/src/rain-hurdle-wind-artifact.ts'
PINS = {
    'wind-freeze.json': 'b80c0c6b18b9c026978e1947db734cdbf5ac2b6ae3dc1ff7dce0974493c5d9b8',
    'report.json': 'f3d6c2d570b2029093b288f21e9e62ce0c896f0956b2f06ce6ada9673dfda56a',
    'predictions.npz': 'ff2f2040acd674ba3881e58b9e3337eaf393ce73f71185fd102992c9f0368f1e',
    'wind-states/2026-08.json': 'b0e1b7e520affd787ab73d8da7e2797765e803fe822ffe1837d856dd0a5e58a2',
}
HEADS = ('0.1', '1.0', '2.5', 'amount')


# bind source bytes before exporting a serving representation
def checked_bytes(relative, expected):
    data = (ROOT / relative).read_bytes()
    # reject changed private source evidence
    if hashlib.sha256(data).hexdigest() != expected:
        raise ValueError(f'frozen source changed: {relative}')
    return data


# retain only ordered numerical tree operations from native JSON
def compact_head(data, expected_name, feature_names):
    model = json.loads(data)
    learner = model['learner']
    objective = learner['objective']['name']
    expected_objective = 'reg:gamma' if expected_name == 'amount' else 'binary:logistic'
    # bind objective and ordered predictors
    if objective != expected_objective or learner['feature_names'] != feature_names:
        raise ValueError(f'head identity changed: {expected_name}')
    booster = learner['gradient_booster']['model']
    # accept only the frozen single-output tree geometry
    if learner['gradient_booster']['name'] != 'gbtree' or len(booster['trees']) != 160 or any(value != 0 for value in booster['tree_info']):
        raise ValueError(f'unexpected tree ensemble: {expected_name}')
    trees = []
    # preserve native tree order without fitted observations
    for tree in booster['trees']:
        # exclude categorical nodes from the numerical runtime
        if any(value != 0 for value in tree['split_type']) or tree['categories']:
            raise ValueError('categorical tree cannot use numerical runtime')
        names = ('split_indices', 'split_conditions', 'left_children', 'right_children', 'default_left')
        arrays = [tree[name] for name in names]
        # prevent misaligned node arrays
        if len(set(map(len, arrays))) != 1:
            raise ValueError('tree node arrays have inconsistent sizes')
        trees.append(arrays)
    return {'objective': objective, 'baseScore': float(json.loads(learner['learner_model_param']['base_score'])[0]), 'trees': trees}


# copy no source observations or original private receipts into the artifact
def export():
    # require all frozen parent identities
    for relative, expected in PINS.items():
        checked_bytes(relative, expected)
    state = json.loads((ROOT / 'wind-states/2026-08.json').read_text())
    # reject any different monthly fit or calibration contract
    if state['month'] != '2026-08' or state['supported'] is not True or state['model']['rounds'] != 160 or state['calibration']['contractVersion'] != 'rain-hurdle-calibration/v1':
        raise ValueError('August wind hurdle fit unavailable')
    features = state['model']['featureNames']
    # pin the complete wind-vector feature order
    if len(features) != 107 or len(set(features)) != len(features):
        raise ValueError('wind feature schema changed')
    heads = {}
    native_hashes = {}
    # export only the four fitted August heads
    for name in HEADS:
        head = state['model']['heads'][name]
        # prohibit raw fallback head substitutions
        if head['reason'] != 'fitted' or head['modelFile'] is None:
            raise ValueError(f'frozen head is unsupported: {name}')
        relative = f"wind-models/2026-08/{head['modelFile']}"
        data = checked_bytes(relative, head['sha256'])
        heads[name] = compact_head(data, name, features)
        native_hashes[name] = head['sha256']
    calibration = state['calibration']
    rules = [{'threshold': rule['threshold'], 'cutoff': rule['cutoff']} for rule in calibration['rules']]
    scales = [calibration['categories'][str(category)]['scale'] for category in (1, 2, 3)]
    # bind physical event categories and calibrated scales
    if [rule['threshold'] for rule in rules] != [.1, 1., 2.5] or any(not .1 <= value <= 3 for value in scales):
        raise ValueError('frozen calibration changed')
    artifact = {
        'contractVersion': 'rain-hurdle-wind-runtime/v1',
        'modelMonth': '2026-08',
        'featureNames': features,
        'nativeModelSha256': native_hashes,
        'provenanceSha256': PINS,
        'rules': rules,
        'categoryScales': scales,
        'heads': heads,
    }
    body = json.dumps(artifact, separators=(',', ':'), allow_nan=False)
    sha = hashlib.sha256(body.encode()).hexdigest()
    source = (
        '// generated by scripts/research/export_rain_wind_runtime.py from frozen private model bytes\n'
        f'export const RAIN_HURDLE_WIND_ARTIFACT_SHA256 = {json.dumps(sha)} as const;\n'
        f'export const RAIN_HURDLE_WIND_ARTIFACT_JSON = {json.dumps(body)} as const;\n'
    )
    DESTINATION.write_text(source)
    print(json.dumps({'artifactSha256': sha, 'destination': str(DESTINATION), 'bytes': len(body), 'nativeModelSha256': native_hashes}, sort_keys=True))


# run only for an explicit operator regeneration
if __name__ == '__main__':
    export()
