"""Bounded read-only production extraction for inactive moisture research."""

import argparse
import csv
import datetime as dt
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import subprocess
from zoneinfo import ZoneInfo

ZONE = ZoneInfo("America/Los_Angeles")
FORECAST_KEYS = {"open-meteo-forecast-v4", "open-meteo-previous-runs-v1"}
STATION_KEYS = {f"tempest-{station}-observations-v2" for station in (126537, 168853, 201058, 203055, 225947, 38270, 64255)}
CAP = 400_000


# accept only an owned private root in one explicit research base
def validate_private_root(private_root, home=None):
    supplied = Path(private_root)
    # reject lexical traversal before canonicalization
    if '..' in supplied.parts:
        raise ValueError("invalid private root")
    lexical_root = Path(os.path.abspath(supplied))
    private_home = Path(os.path.abspath(Path.home() if home is None else home))
    tmpfs_base = Path("/dev/shm")
    weather_base = private_home / ".weather"
    disk_base = weather_base / "research-work"
    # select only a direct child of an approved base
    if lexical_root.parent == tmpfs_base:
        base = tmpfs_base
    elif lexical_root.parent == disk_base:
        base = disk_base
    else:
        raise ValueError("invalid private root")
    # require the exact research naming convention
    if not lexical_root.name.startswith("weather-moisture-research-"):
        raise ValueError("invalid private root")
    # reject symlinks in the private disk lineage
    if base == disk_base and (weather_base.is_symlink() or disk_base.is_symlink()):
        raise ValueError("invalid private root")
    # reject a linked research root
    if lexical_root.is_symlink():
        raise ValueError("invalid private root")
    try:
        resolved_base = base.resolve(strict=True)
        root = lexical_root.resolve(strict=True)
        base_status = base.stat()
        root_status = lexical_root.stat()
        weather_status = weather_base.stat() if base == disk_base else None
    except OSError as error:
        raise ValueError("invalid private root") from error
    # require an exact canonical direct child
    if root.parent != resolved_base or not stat.S_ISDIR(root_status.st_mode):
        raise ValueError("invalid private root")
    # require private owned research data
    if root_status.st_uid != os.getuid() or root_status.st_mode & 0o077:
        raise ValueError("invalid private root")
    # require private owned disk ancestors
    if base == disk_base and (not stat.S_ISDIR(base_status.st_mode) or base_status.st_uid != os.getuid() or base_status.st_mode & 0o077 or not stat.S_ISDIR(weather_status.st_mode) or weather_status.st_uid != os.getuid() or weather_status.st_mode & 0o077):
        raise ValueError("invalid private root")
    return root


# require exact frozen source identities
def selected_sources(inventory):
    selected = [row for row in inventory["sources"] if row["source_key"] in STATION_KEYS | FORECAST_KEYS]
    # reject missing or duplicate identities
    if len(selected) != len(STATION_KEYS | FORECAST_KEYS) or {row["source_key"] for row in selected} != STATION_KEYS | FORECAST_KEYS:
        raise ValueError("source catalog is incomplete")
    # process each selected item
    for row in selected:
        # check the next guarded case
        if type(row["id"]) is not int or row["id"] <= 0 or not re.fullmatch(r"[a-f0-9]{64}", row["source_config_fingerprint"]):
            raise ValueError("invalid source identity")
    return selected


# partition the complete fixed local calendar without selecting outcomes
def windows():
    current = dt.date(2024, 1, 1)
    end = dt.date(2026, 9, 7)
    # retain the bounded iteration
    while current < end:
        following = (current.replace(day=28) + dt.timedelta(days=4)).replace(day=1)
        following = min(following, end)
        yield current, following
        current = following


# encode only validated catalog identities in the query
def catalog_sql(sources):
    return ",\n".join(f"({row['id']}, '{row['source_key']}', '{row['source_config_fingerprint']}')" for row in sources)


# construct a bounded transaction without changing the existing export contract
def query(sources, start, end, kind):
    # check the next guarded case
    if (start, end) not in list(windows()) or kind not in ("stations", "anchors", "live"):
        raise ValueError("query is outside the frozen research plan")
    lower = dt.datetime.combine(start, dt.time(), ZONE).astimezone(dt.timezone.utc)
    upper = dt.datetime.combine(end, dt.time(), ZONE).astimezone(dt.timezone.utc)
    selected = [row for row in sources if row["source_key"] in STATION_KEYS] if kind == "stations" else [row for row in sources if row["source_key"] == ("open-meteo-previous-runs-v1" if kind == "anchors" else "open-meteo-forecast-v4")]
    lower -= dt.timedelta(minutes=65 if kind == "stations" else 0)
    table = "forecast_anchor_records" if kind == "anchors" else "weather_records"
    source_kind = "physical_sensor" if kind == "stations" else "forecast"
    extra = "w.lead_hours, w.dataset, w.upstream_model, w.contract_epoch, w.adapter_version, NULL::timestamptz AS product_run_at, NULL::double precision AS precipitation_rate_mm_per_hour" if kind == "anchors" else "NULL::smallint AS lead_hours, w.provider_metadata ->> 'dataset' AS dataset, w.upstream_model, NULL::text AS contract_epoch, NULL::text AS adapter_version, w.product_run_at, w.precipitation_rate_mm_per_hour"
    return f"""\\set ON_ERROR_STOP on
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '120s';
SET LOCAL lock_timeout = '3s';
SET LOCAL idle_in_transaction_session_timeout = '30s';
COPY (SELECT json_build_object('recordKind','transaction','readOnly',current_setting('transaction_read_only'),'isolation',current_setting('transaction_isolation'),'createdAt',transaction_timestamp(),'from','{start}','toExclusive','{end}','kind','{kind}','rowCap',{CAP},'migration',(SELECT max(name) FROM schema_migrations))) TO STDOUT WITH (FORMAT csv);
COPY (
 WITH expected(source_id, source_key, fingerprint) AS (VALUES {catalog_sql(selected)})
 SELECT row_to_json(item) FROM (
 SELECT w.id, w.source_id, s.source_key, s.source_config_fingerprint,
        s.material_provider_config ->> 'contractVersion' AS adapter_contract,
        st.slug AS station_key, w.source_kind, w.valid_at, {extra},
        w.first_received_at, w.last_received_at, w.first_ingestion_run_id,
        w.last_ingestion_run_id, w.revision_count, w.content_hash,
        w.temperature_c, w.relative_humidity_percent, w.wind_speed_mps,
        w.precipitation_mm, w.pressure_hpa, w.cloud_cover_percent,
        w.provider_metadata -> 'report_interval_minutes' AS report_interval_minutes,
        w.provider_metadata -> 'elevation_m' AS elevation_m,
        w.quality_metadata -> 'status' AS quality_status,
        w.quality_metadata -> 'flags' AS quality_flags
 FROM expected e JOIN sources s ON s.id=e.source_id AND s.source_key=e.source_key AND s.source_config_fingerprint=e.fingerprint
 JOIN stations st ON st.id=s.station_id JOIN sites si ON si.id=st.site_id
 JOIN {table} w ON w.source_id=s.id
 WHERE si.slug='ballydidean' AND s.source_kind='{source_kind}' AND w.source_kind='{source_kind}'
   AND w.valid_at >= TIMESTAMPTZ '{lower.isoformat()}'
   AND w.valid_at < TIMESTAMPTZ '{upper.isoformat()}'
 ORDER BY w.source_id, w.valid_at, w.id LIMIT {CAP + 1}
 ) item
) TO STDOUT WITH (FORMAT csv);
COMMIT;
"""


# verify every streamed row before publishing its private compressed member
def export_one(sql, path):
    partial = path.with_suffix(path.suffix + ".partial")
    # check the next guarded case
    if path.exists() or partial.exists():
        raise ValueError("refusing to replace an export")
    process = subprocess.Popen(["ssh", "blueberry", "sudo -n docker exec -i weather-postgres-1 psql -X -q -At --username postgres --dbname weather"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    process.stdin.write(sql.encode())
    process.stdin.close()
    rows = 0
    counts = {}
    transaction = None
    try:
        # close owned resources after use
        with gzip.open(partial, "wt", encoding="utf8") as output:
            # process each selected item
            for record in csv.reader(io.TextIOWrapper(process.stdout, encoding="utf8")):
                # check the next guarded case
                if len(record) != 1:
                    raise ValueError("invalid export framing")
                item = json.loads(record[0])
                # check the next guarded case
                if transaction is None:
                    # check the next guarded case
                    if item.get("recordKind") != "transaction" or item.get("readOnly") != "on" or item.get("isolation") != "repeatable read":
                        raise ValueError("invalid read-only transaction")
                    transaction = item
                    continue
                rows += 1
                # check the next guarded case
                if rows > CAP:
                    raise ValueError("export row cap exceeded")
                source = counts.setdefault(item["source_key"], {"rows": 0, "rain": 0, "pressure": 0, "humidity": 0})
                source["rows"] += 1
                # process each selected item
                for metric, field in (("rain", "precipitation_mm"), ("pressure", "pressure_hpa"), ("humidity", "relative_humidity_percent")):
                    source[metric] += item[field] is not None
                output.write(json.dumps(item, separators=(",", ":"), sort_keys=True) + "\n")
        errors = process.stderr.read().decode()
        # check the next guarded case
        if process.wait(timeout=150) != 0 or transaction is None:
            raise RuntimeError("read-only export failed: " + errors)
        partial.replace(path)
    except BaseException:
        process.terminate()
        process.wait(timeout=10)
        partial.unlink(missing_ok=True)
        raise
    return {"file": path.name, "rows": rows, "bytes": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "sqlSha256": hashlib.sha256(sql.encode()).hexdigest(), "transaction": transaction, "sourceCounts": counts}


# run only the explicit research entry point
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("private_root", type=Path)
    parser.add_argument("evidence", type=Path)
    args = parser.parse_args()
    root = validate_private_root(args.private_root)
    sources = selected_sources(json.loads((args.evidence / "coverage-inventory.json").read_text()))
    output = root / "production-moisture"
    output.mkdir(mode=0o700, exist_ok=True)
    receipt_path = output / "manifest.json"
    manifest = json.loads(receipt_path.read_text()) if receipt_path.exists() else {"contractVersion": "moisture-production-research-export/v1", "sources": sources, "members": [], "productionWrites": False}
    # reject incompatible resume material
    if manifest.get("contractVersion") != "moisture-production-research-export/v1" or manifest.get("sources") != sources or manifest.get("productionWrites") is not False or not isinstance(manifest.get("members"), list):
        raise ValueError("invalid resume manifest")
    receipts = manifest["members"]
    # reject duplicate receipts
    if len({item["file"] for item in receipts}) != len(receipts):
        raise ValueError("duplicate resume member")
    indexed = {receipt["file"]: receipt for receipt in receipts}
    # process each selected item
    for start, end in windows():
        # process each selected item
        for kind in ("stations", "anchors", "live"):
            path = output / f"{start}-{kind}.jsonl.gz"
            sql = query(sources, start, end, kind)
            # check the next guarded case
            if path.name in indexed:
                previous = indexed[path.name]
                # check the next guarded case
                if hashlib.sha256(path.read_bytes()).hexdigest() != previous["sha256"] or hashlib.sha256(sql.encode()).hexdigest() != previous["sqlSha256"]:
                    raise ValueError("retained export changed")
                continue
            receipt = export_one(sql, path)
            receipts.append(receipt)
            manifest = {"contractVersion": "moisture-production-research-export/v1", "sources": sources, "members": receipts, "productionWrites": False}
            receipt_path.write_text(json.dumps(manifest, indent=2) + "\n")
            (args.evidence / "production-extraction-progress.json").write_text(json.dumps({"completedMembers": len(receipts), "rows": sum(item["rows"] for item in receipts), "latest": receipt}, indent=2) + "\n")
            print(json.dumps({"member": path.name, "rows": receipt["rows"], "completed": len(receipts)}), flush=True)
    (args.evidence / "production-extraction-summary.json").write_text(json.dumps(manifest, indent=2) + "\n")


# prevent imports from starting production reads
if __name__ == "__main__":
    main()
