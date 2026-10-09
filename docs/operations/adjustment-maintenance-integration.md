# Maintenance integration contract

The v13 release is an inactive foundation. Implementing the remaining service
does not authorize replacing genuine qualification evidence with fit results,
transfer acknowledgements, opaque anchors or activation flags.

## Dependency order

1. Separate allocation accounting from evidence trust. Keep the runner beneath
   the existing private `.weather` boundary and use integrity-checked public
   systemd units without repairing unrelated `.local` or `.config` permissions.
2. Close combined cycle inputs before finalization. Bind immutable source,
   target, comparator, body and compact metadata identities into the cold graph.
   Retire only the exact hot generation covered by a verified cold commit and
   acknowledged anchor. Retain first-issuance provenance across retirement.
3. Wire actual API temperature/wind and worker rain inference. Stage body before
   compact append and publish only after exact admission. Complete lead halos
   remain 12, 168 and 23 hours; the registered interval selects scored targets,
   not a truncated capture body. Serving remains available on archival failure;
   failed evidence is permanently unqualified, not backfilled.
4. Run daily monitoring and one original-cutoff monthly attempt per family.
   Hold process locks throughout each operation. A designated family slot remains
   occupied until its immutable terminal result and action are reconciled.
5. Publish sanitized family-only worktrees from the exact deployed source.
   Require exact-commit Check, immutable release/image identities, literal
   capacity, source/settings/fencing CAS and live family verification. Recovery
   uses a new family-only compensating release, not whole-release rollback.
6. Activate in that order, with automatic model actions last. A qualified full
   terminal member promotes without manual approval; unsupported or pending
   members preserve the incumbent. Operator-off always takes precedence.

## Boundaries

- New private archives and state stay on this workstation, without encryption.
- Archive 18 GiB, aggregate 64 GiB, both 16 GiB free-space floors, allocation
  27 GiB and reviewed object/inode ceilings remain conjunctive and unchanged.
- Rain retains 180 actual training dates, 90 calibration days, 60 distinct
  calibration dates and both seven-day gaps.
- Wind retains exactly seven speed and six gust pairs, with no direction or
  49–72-hour gust extension.
- Capture uses the finite rolling bootstrap: 1,053 local dates after
  the first complete post-epoch date. Only a successfully registered genuine
  member can extend its horizon to that member's terminal closure. No timer,
  environment override, history reset or shortened gate extends it.
- Migration 0018 and published release history are immutable. New contracts use
  a new migration and explicitly versioned control transition.
- Tests and fixture proofs do not count as production readiness. Production
  scheduling remains disabled until the corresponding live dependencies pass.

## Versioned release boundary

The next inactive control handoff is v14, with predecessor release
`2026.10.09-1`, source commit `56b327d9c750946f6f6963b6fe1fa5c9bba791ca`
and complete control digest
`603eb8f488ba78be3d7ecf76b0d587346d1c36432255d390d86d2b768c8fecba`.
It freezes all 42 predecessor identities again; the v13 installer and its
source-release recovery scope remain unchanged. The v14 changed-path allowlist
also includes the existing Compose file for private internal ports and the
read-only installed-candidate catalog. The catalog is a root-owned regular
file beneath the existing `/opt/weather/current/deploy/state` directory; no
`/var/lib/weather/deploy` mirror or bind-mount alias is created. No privileged control-tree path is added.
The actual forced dispatcher and remote-operations executable mirrors must
match the new verified control bytes before any new operation is used.

Family actions use a different capacity contract from either inactive code
handoff. All six literal source, target and precomputed compensating images are
measured. Compensation is a new immutable family-only release, published and
journaled before target mutation. The fixed-source restoration contracts do not
authorize model recovery.

The closed apply operands are `TARGET_RELEASE COMPENSATING_RELEASE
EXPECTED_CURRENT_RELEASE EXPECTED_SOURCE_RELEASE EXPECTED_SETTINGS_SHA256 FAMILY
ACTION_SHA256 REPORT_SHA256 FENCING_TOKEN`. Action bytes bind the exact installed
catalog receipt baseline. Shadow releases add inactive candidate material only;
they do not change a serving registry. `compensate_shadow` preserves the original
pending decision and restores only its recorded catalog baseline, without
inventing a qualification or deleting immutable candidate history.

## Private revision transport

The web revision endpoint is private port 3004 on the existing network. API
admission is private port 3003; neither port is published on the host.
Stage accepts only `{projectionBase64}`. Both `projectionIdentitySha256` and
`projectionSha256` mean SHA-256 of the complete canonical projection JSON plus
its terminal newline. A separate `storedContentSha256` binds the authoritative
database content; it is not a substitute for either body identity.

The stage receipt is exactly `{contractVersion,durable,durableAt,
projectionIdentitySha256,projectionKind,projectionSha256,stageReceiptSha256}`.
It uses `adjustment-revision-stage-receipt/v1`; its hash covers canonical bytes
excluding its own hash field. First durable time is immutable across retries.
Publish accepts only `{revisionReceipt,stageReceipt}` after API verifies the
same server-issued database ordinal and current-pointer content binding.
Its receipt is exactly `{contractVersion,committed,committedAt,
projectionIdentitySha256,projectionKind,projectionSha256,
revisionReceiptSha256,publishReceiptSha256}`, with
`adjustment-revision-publish-receipt/v1` and the same unsigned hash rule.
The commit time is the first durable page checkpoint, not retry time.

Logical receipt time inside a projection is descriptive. Server-assigned
archive commit time and ordinal are the cutoff authority. A failed stage,
pointer CAS or publication leaves serving available and the corresponding
revision permanently unqualified. Legacy null pointers are not filled later.

## Closed recurring contracts

The additive database ledger admits only exact reviewed migration bytes.
Migration 0019 is
`f2d9fa34a041449443741963833de798d696eb3c6096c6bd02f81769619dfd44`;
migration 0020 is
`56027b4f2cb2c3c83e746f14dac753b75d573753934898fa7a52f78faa56499c`.
Legacy null receipt pointers remain unqualified. New shadow rows receive a
contract epoch; existing rows are not backfilled.

One server-issued ordinal frontier covers committed projections and explicit
`shadow_prediction` receipts. The latter retain their distinct source/body
identity grammar and full source/prediction capsule; they are not relabeled as
a canonical `native_source` revision. Wind raw inputs are the actual unadjusted
Best Match wind values. Rain native heads are independently replayed from the
captured causal inputs and exact artifact. Each family must retain all inputs,
comparators and targets it actually uses, rather than fill unrelated class counts.

Cold transfer starts with an immutable cutoff/watermark snapshot. Every
successor page binds the verified prior ordinal/frontier and prior page, includes
at most two actual payloads and fits the 4,832 KiB wire ceiling. A complete
retained genesis prefix plus verified new pages is required; a 4,096-entry hot
snapshot bound is not a lifetime history limit. Bodies, stage/publication
receipts and successor links become real members of the combined cold graph.
Identities or seal counts alone do not prove body availability.

A staged payload that never received database admission uses a separate bounded
unqualified-gap transfer. It has no invented commit ordinal, serving pointer or
semantic qualification kind. Its exact bytes and permanent gap are retained in
the cold graph before an exact acknowledgement can remove the staged hot bytes.
Successful and failed transfers share the existing byte, object, inode and hot
retention limits; neither creates an indefinite Blueberry archive.

The installed catalog v2 has at most six entries, unique by `(family, slot)`,
where `slot` is `active` or `shadow`. A pending shadow cannot replace active
serving authority. Promotion installs the qualified active entry and removes its
matching shadow entry atomically. Compensation restores the exact recorded
family baseline; other families and immutable candidate history remain untouched.
Catalog v1 remains compatible only as shadow authority.

New serving registries use
`forecast-adjustment-<family>-maintenance-registry/v1`, with exactly
`activePackage`, `contractVersion`, `rawReason` and `siteKey`. A selected package
binds `actionSha256`, `artifactSha256`, `candidateSha256` and `path`. The registry
is not authority by itself: serving also requires the matching root-owned v2
receipt, independently verified qualified action and non-null full terminal
member root. Pending shadow receipts never acquire serving authority. Legacy
incumbent loaders and their contracts remain separate.

The administrator-only `update.sh inert-v14 RELEASE` command is a one-time
inactive code handoff, not a model action. It requires the literal current v13
source, exact public Check before Publish, ARM64 images, fresh resource and
literal-capacity evidence, bounded complete-0021 source compatibility, runtime
ACLs and live health. Only then can it publish the actionless root source
bootstrap. A failed handoff can remove only its exactly matched actionless
bootstrap after source health is restored. It cannot delete model-action state.

A lifecycle cannot initialize from fabricated empty v1 hashes. If the retained
v1 ledger/tail is unavailable, affected qualification remains
`history_unavailable`; existing models, evidence and legacy history are not reset.

## Approved future-only lineage

On 2026-10-09 the owner explicitly selected a new future-only lineage because
the configured retained v1 ledger was unavailable. This is not an empty-v1
fallback or a legacy-history reset. Existing models, artifacts and descriptive
legacy evidence remain unchanged and cannot acquire v2 qualification authority.

A root-authenticated pre-activation epoch witness records the actual complete
0021 zero frontier, database transaction clock and independently verified
immutable target release/control/image identities. It is created once before
new producers can stage; retries retain its original clock and identity.

The genesis graph contains the actual witness and its retained zero-frontier
snapshot. Each fitted family later archives an actual
`forecast-adjustment-future-only-source-lineage/v1` descriptor with exactly
`contractVersion`, `epochWitnessSha256`, `family` and `sourceIdentitySha256`.
The descriptor's byte hash becomes the registration source identity. The
underlying provider configuration fingerprint is not altered.

Training and qualification require post-epoch server receipts and post-epoch
forecast references/model-run initialization, physical target times and every
causal historical feature. Receiving old values later does not make them new.
Insufficient new history remains unsupported; no candidate is promoted until
its genuine complete confirmation member qualifies.

The owner separately approved a rolling date contract on 2026-10-09. The
legacy v2 dates and bytes remain unchanged. New v3 registrations preregister
before the next local-month start and retain 366 complete local dates for
temperature/wind and 334 for rain, with seven-day target closure. The rain fit
still requires its full 180-date training, 90-day calibration and both
seven-day embargoes before it can attempt registration.

The exact schedule contract hash is
`7c17f5d1a8e8249cd0aa4820638169e51f6edb3433017f50ab4c959e44c62f1f`.
Migration 0021 adds immutable schedule, horizon and registration-window
history without editing migrations 0018–0020. Its frozen checksum is
`ca29db99377001fca2e2e4268fd80d1cbe7b876f71f2d5ba04e575712cb9f13b`.
The inactive v14 bridge applies the exact 0019–0021 tail in one PostgreSQL
transaction. A failure leaves the original 0018 ledger intact; ordinary
migrations keep their existing per-file transaction behavior. Recovery reads
the actual ledger before selecting source or target schema authorization and
refuses an unknown partial history. Operator settings are frozen by descriptor,
bytes and inode before startup and rechecked before root source publication.
A successor begins only after its real predecessor's terminal reconciliation;
predecessor data does not become fresh training or unburned confirmation data.
The 1,053-date bootstrap accommodates the initial rain training/calibration,
the full earlier-only annual development population, monthly alignment, future
confirmation and late closure. Resource and object ceilings remain unchanged.

The new archive-derived wind manifest permits up to 1,000,000 row members and
opened-member proofs. A complete 402-date, four-cycle, 168-lead forecast alone
has 270,144 rows, before physical targets. Legacy manifest limits remain
unchanged. The 512 MiB input, 8 GiB fitter memory and output limits still apply.
Grouped historical bodies are retained once, not copied once per projected row.

Unchanged custody frontiers are authenticated read-only no-ops rather than new
archive objects at each poll. Custody acknowledgements authorize only exact
hot-byte retirement after durable capture. They do not qualify a model or
replace actual complete-member C/T/F proof.

## Prerecorded rain control references

Rain controls have a separate pre-month reference lane. It records the exact
retained control recipes and genuine ordinal artifact after their calibration
window closes, during the final seven days before the next model month. The
actual generation clock must precede that month; monthly fitting cannot backdate
or invent a reference. This lane does not qualify a candidate, register a
confirmation member or activate serving.

`control_reference` and `compensate_control_reference` use the same fenced,
source/settings-preserving family release transaction and a newly published
compensating release. The public selector is
`config/forecast-adjustments/ballydidean-rain-control-reference.json`.
Its state identity is the SHA-256 of the complete canonical state bytes, not
the embedded unsigned state hash. Catalog v3 adds at most one rain `control`
slot to the unchanged six active/shadow slots. Its dedicated root receipt has
no shadow registration or qualification authority. Compensation restores only
the recorded selector and control slot; immutable state and artifact history
remain retained.

The canonical revision consumer captures incumbent comparisons in the actual
shadow capsules and their cold graph. The new maintenance capture job therefore
drains that consumer on every poll; it does not also run the legacy serving
archive consumer. Existing legacy archives and read-only compatibility remain
unchanged.

## Closed owner lifecycle operations

The three fixed owner verbs are
`adjustment-confirmation-access-burn-v3`,
`adjustment-shadow-terminal-record-v3` and
`adjustment-shadow-terminal-retire-v3`. Each accepts exactly one canonical
request SHA-256 operand and bounded canonical request bytes on stdin. Requests
cannot select SQL, paths, dates or an alternate database authority.

Access is recorded before confirmation values are opened. It binds the actual
root-installed shadow registration, retained epoch, acknowledged cold graph,
local burn and native compact metadata. The local journal access identity and
native PostgreSQL access identity remain distinct. PostgreSQL assigns the
native first-access clock and recomputes its identity; retries retain both.

Terminal reconciliation requires the genuine full-member finalization proof
and the independently verified root action acknowledgement, compensation or
closed no-action receipt. Native access fields and clocks must match the actual
database row. Retirement compares the entire immutable terminal record,
including on a lost-response retry after hot registration deletion. It removes
only the reconciled hot registration/access and retains the terminal tombstone
and v3 registration-window history. Disposable PostgreSQL tests exercise these
operations and tamper refusal; fixture documents never count as live evidence.

## Durable terminal recovery

Before C/T/F or a family mutation, the workstation retains the exact terminal
authority and original action intent. The target and newly published
compensating release are fixed before apply. Retries read the root transaction
for that action rather than rebuilding against a changed current release.
Continuation retains the original confirmation due key and fencing token;
an expired lease does not authorize a different action or source baseline.

The daily outcome and exact owner retirement request are retained before the
registration slot is released. A lost report response therefore replays the
original outcome rather than reporting that no candidate existed. Operator-off
remains distinct: a deployed but disabled model and an unapplied qualified
action both report no effective serving change. The latter has a durable root
receipt and the truthful `promoted_operator_off_unapplied` owner disposition;
it does not claim compensation or activation.
