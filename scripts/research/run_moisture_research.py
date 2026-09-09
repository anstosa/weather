"""Run one frozen metric partition with bounded private evidence retention."""

import argparse
import gzip
import hashlib
import json
import shutil
from pathlib import Path
import time

import pressure_research
import rain_research


# run one explicitly named metric partition without production actions
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('metric', choices=('rain', 'pressure'))
    parser.add_argument('input', type=Path)
    parser.add_argument('predictions', type=Path)
    parser.add_argument('report', type=Path)
    args = parser.parse_args()
    started = time.monotonic()
    # read one compressed partition rather than every pressure lead band together
    with gzip.open(args.input, 'rt') as stream:
        rows = [json.loads(line) for line in stream]
    module = rain_research if args.metric == 'rain' else pressure_research
    source_hash = hashlib.sha256(Path(module.__file__).read_bytes()).hexdigest()
    shared_hash = hashlib.sha256(Path(rain_research.shared.__file__).read_bytes()).hexdigest()
    report = module.evaluate(rows, args.predictions)
    # reject changes that would misidentify the source loaded for this run
    if source_hash != hashlib.sha256(Path(module.__file__).read_bytes()).hexdigest() or shared_hash != hashlib.sha256(Path(rain_research.shared.__file__).read_bytes()).hexdigest():
        raise ValueError('model source changed while fitting')
    # retain aggregate reports without replacing earlier experimental results
    with args.report.open('x') as stream:
        json.dump(report, stream, separators=(',', ':'), sort_keys=True)
        stream.write('\n')
    # hash large private predictions without duplicating them in memory
    with args.predictions.open('rb') as source:
        predictions_sha = hashlib.file_digest(source, 'sha256').hexdigest()
    compressed = args.predictions.with_suffix(args.predictions.suffix + '.gz')
    # reduce private tmpfs pressure after the model process has finished writing
    with args.predictions.open('rb') as source, gzip.open(compressed, 'xb', compresslevel=1) as destination:
        shutil.copyfileobj(source, destination, length=1024 * 1024)
    verify = hashlib.sha256()
    # verify exact plaintext before removing only the owned redundant copy
    with gzip.open(compressed, 'rb') as source:
        while block := source.read(1024 * 1024):
            verify.update(block)
    if verify.hexdigest() != predictions_sha:
        raise ValueError('compressed prediction roundtrip failed')
    args.predictions.unlink()
    receipt = {'metric': args.metric, 'inputRows': len(rows), 'elapsedSeconds': time.monotonic() - started, 'inputFile': args.input.name, 'inputSha256': hashlib.sha256(args.input.read_bytes()).hexdigest(), 'reportSha256': hashlib.sha256(args.report.read_bytes()).hexdigest(), 'predictionsFile': compressed.name, 'predictionsSha256': predictions_sha, 'compressedPredictionsSha256': hashlib.sha256(compressed.read_bytes()).hexdigest(), 'modelSourceSha256': source_hash, 'sharedSourceSha256': shared_hash, 'productionEligible': False}
    args.report.with_suffix('.receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt), flush=True)


# imports never start fitting
if __name__ == '__main__':
    main()
