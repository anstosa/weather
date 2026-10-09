# Adjustment maintenance runtime snapshot

This directory is the committed plain-JavaScript closure used by
`adjustment_maintenance_runtime_adapter.mjs`. The maintenance runner verifies
these bytes against the exact source commit before installation and never loads
the ignored workspace `dist` tree.

Regenerate the closure only through the supported build and snapshot command:

```sh
npm run build --workspace @weather/forecast-adjustment
node scripts/research/regenerate_adjustment_maintenance_runtime.mjs --write
node scripts/research/regenerate_adjustment_maintenance_runtime.mjs --check
node --test scripts/research/adjustment_maintenance_runtime_adapter.test.mjs
```

`adjustment_maintenance_runtime_manifest.mjs` is the bootstrap-safe source of
`ADJUSTMENT_MAINTENANCE_RUNTIME_ADAPTER_GENERATED_FILES` and
`ADJUSTMENT_MAINTENANCE_RUNTIME_ADAPTER_SOURCE_FILES`. The first is the
authoritative source-to-snapshot manifest; the second is the authoritative
runner installation manifest. Do not hand-edit generated JavaScript in this
directory.
