# Ongoing adjustment maintenance

## Historical v13 implementation boundary

The deployed v13 foundation is **inactive**. The following section records its
pre-v14 boundary; the [integration contract](adjustment-maintenance-integration.md)
is the source of truth for the new future-only rolling lineage. Existing serving selections,
operator switches, generated rain artifact and legacy evidence remain unchanged.
The new components do not constitute a production promotion service yet.

Implemented local components:

- Fixed-gauge weighted-median rain targets, backward interval tiling and strict
  raw target-hour forecast temperature eligibility above 2 °C.
- Data-derived temperature, thirteen-pair wind and complete rain policy gates.
  Native-source comparisons, actual same-hour Best Match comparisons and farm
  diagnostics remain separate. Daily monitoring is not a repeated-look action.
- Exact startup-only raw registries for each family; legacy active registries
  retain their original interpretation. A wind raw selection cannot fall through
  to a different generic model. Rain selection is now loaded once at API/worker
  startup: raw or invalid selection prevents sidecar reads and inference while
  collection continues independently. Its new default active registry binds the
  currently compiled artifact and preserves existing serving behavior.
- Owner-private, current-workstation plaintext CAS packs, predecessor-linked
  graph manifests, bounded streaming verification, restore and legacy read-only
  compatibility. Raw reader buffers are capped at 256 KiB; decoded graph text
  and objects are separately bounded by the existing 32 MiB schema ceiling.
  Large custom members require an explicitly bounded streaming validator.
  No encryption, key operation or off-host research archive is
  introduced. This is not independent hardware recovery.
- Append-only lifecycle/due journal, exclusive leases, release fencing, blinded
  revision snapshots and complete 27/27/24-chunk confirmation assembly.
- An inactive four-cycle edge scheduler with genuine response-finish capture,
  single-use loopback request authority, durable gaps and current/next page ports.
- A separately approved continuous workstation archive consumer and disabled
  user service. Page acknowledgements follow durable open-cycle checkpoints;
  only a genuine final manifest permits one cycle capsule plus its separate
  verification graph. Full-graph verification and the durable head precede the
  final graph acknowledgement. Exact retries and restart reconciliation are
  tested without initializing a production archive.
- Real expanding/trailing-365 temperature fits, the reused robust wind numerical
  core and four-head, 107-feature rain numerical fitting helpers. All three
  execute through the installed credential-isolated bwrap/user-systemd sandbox
  using hash-bound temporary inputs and public code. The supported wind fixture
  passes all 65 development folds across the thirteen pairs. Fit-only entries
  cannot open a designated confirmation or change serving.
- Migration 0018 for inactive workflows with exactly three value-free tables, nine narrow
  functions, four trigger functions and function-only role grants. Disposable
  PostgreSQL 17 tests prove exact body/metadata identity, before-valid receipt
  clocks, role boundaries and owner-only finalization/access. The application
  repository exposes no owner finalization or raw-table API.
- Legacy evaluation packages remain readable. Their unchanged v1 query accepts
  only the pinned complete 0017 or complete 0018 migration ledger; partial,
  drifted and unknown-extra ledgers are refused. This does not give a v1 export
  v2 evaluation, archive-retirement or model-action authority.
- Closed 8/64/12 KiB prediction bodies and compact body-bound metadata. Rain
  records all three threshold probabilities before outcomes; later qualification
  must test nesting rather than hide non-nested predictions. Identity uses exact
  millisecond issue clocks, independently of the fixed capture due key.
- Literal image-chain capacity accounting for both server and web images in
  each source, target and compensation role, including persistent ownership and
  the pull/unpack peak. Contradictory immutable manifests and overflowing sums
  are refused. The deployed helper is the accounting source of truth; the research
  entry is a facade. The fixed v13 bridge binds the exact source and its
  whole-release compensation images. It grants no prospective retirement credit
  and cannot authorize a future family-scoped model release.
- An inert v13 control-plane installer bound to the exact forty-two-file
  `2026.10.07-3` predecessor. It requires all fifteen reviewed changed paths and
  identical remaining paths, backs up the full control surface and bounded
  affected state, installs leaves before ACL/common/update, and restores controls on
  replacement failure. Recovery requires the same transaction lock, canonical
  fixed roots and a complete hash-bound transaction in the private backup root;
  arbitrary imports and hidden control links/special entries are refused.
  Runtime snapshots are retained evidence, not permission to erase newer live
  captures. Recovery restores the forty-two control identities without rewriting
  either runtime root; changed live state is preserved and reported as a nonzero
  drift result. The inert installer never mutates those roots.
  The complete implementation changes all fifteen required paths without padding
  and retains the other twenty-seven frozen byte identities. The real worktree
  candidate is installed and fully recovered in a disposable fixture; a public,
  hash-pinned predecessor fixture makes that test reproducible in CI. Live
  installation still requires fresh exact predecessor and capacity evidence.

## Approved rain policy

The implementation retains the current **90-day calibration window**,
**60 distinct calibration-date minimum** and two seven-day separations, as
explicitly confirmed on 2026-10-08. The earlier plan's 45-day window could not
satisfy its inherited 60-date support requirement; this correction does not
weaken support. Monthly masks reuse the existing fitter's training floor and
UTC calendar. An observed 59-date population remains unsupported even when
its hourly and wet-event counts meet every other minimum.

Real supported refits write four newly trained heads before development
screening. Incomplete development support still emits `no_candidate`; a
completed numerical fit alone never authorizes promotion.

## Storage and deployment admission

The canonical private archive is under
`${HOME}/.weather/adjustment-maintenance/v2/archive-primary` on native ext4.
Directories are `0700` and files `0600`. Existing broad or linked ancestors are
refused before creating descendants; their permissions are not repaired.

The storage ceiling is 64 GiB aggregate with a 16 GiB free-space floor on the
workstation filesystem and its actual backing filesystem. The physical backing
census is mandatory; apparent WSL free space alone is not sufficient. Existing
keys and unrelated encrypted backups are neither opened nor modified.

Blueberry's protected free-space floor is 2,030,043,136 bytes, with another
4,112,384 bytes reserved for the next capture state. The live read-only
preflight on 2026-10-08 observed only 1,950,453,760 available bytes, already below
the protected floor before any new image pull. That historical sample failed
admission; unrelated pruning, baseline resets and a lower floor are not remedies.

A later read-only Docker census at 20:15 UTC observed 1,939,337,216 available
bytes and identified 117 unused Weather images. Current and previous release
images and every container-referenced image, including stopped containers, were
excluded. Their exclusive Docker layer directories occupied 666,492,928 bytes;
this was an inventory measurement, not reclaimed space or admission credit.
On 2026-10-08 the owner approved this cleanup and standing automatic retirement
of obsolete Weather images. A stricter census excluded two mixed-repository
image IDs and removed 115 images without force or general pruning. Current
`2026.10.07-3`, previous `2026.10.07-2` and all fourteen protected image IDs
remained unchanged; all five live services remained healthy. Actual free space
rose from 1,933,533,184 to 2,493,800,448 bytes, reclaiming 560,267,264 bytes.
The post-removal sample had 3,469,137 free inodes. This clears the basic protected
capture floor, not the separate literal target pull/unpack/coexistence proof.

The local release implementation now performs narrowly scoped image cleanup
before pulls and checks fresh free space and inodes. It preserves release and
container references and rejects mixed repositories. Installing these control-plane
bytes does not activate maintenance. The complete six-image release
capacity collector is wired into the fixed source-preserving bridge. Exact
published ARM64 target identities, resource evidence, previous-image
compatibility and live physical capacity remain deployment gates.

The original 8,372-object budget counts cycle capsules but omits their separate
verification graph objects. The owner approved the count correction on
2026-10-08: 8,372 payload objects plus 8,372 verification objects permit 16,744
committed objects; one incoming object and two head pointers permit 16,747
archive files; another 512 catalog, 384 journal/control and 256 staging inodes
permit 17,899 task inodes. The open raw pack is charged to state staging, not a
second archive incoming object. Exact-limit and one-over-limit tests enforce
this arithmetic.

The 18 GiB archive ceiling, 64 GiB aggregate ceiling and both 16 GiB floors
are unchanged. Counts and bytes are conjunctive: a maximum-framed cycle
capsule/graph pair charges at most 5,218,304 bytes, so all 8,372 pairs would need
43,687,641,088 bytes and cannot fit under the archive byte ceiling. The count
correction does not authorize that allocation. Initialization remains closed
on physical and remote readiness. The service has not been installed, enabled
or started in production, and no new private archive has been initialized.

## Continuous archive job

The consumer is `scripts/research/adjustment_archive_job.mjs`. Its fixed forced
SSH surface is:

- `adjustment-archive-next`
- `adjustment-archive-ack PAGE_SHA256 CHECKPOINT_SHA256`
- `adjustment-archive-ack-final MANIFEST_SHA256 GRAPH_SHA256`

Transfers are canonical, bounded to 1 MiB and contain exactly a page, final
manifest or idle marker. A page ACK names the durable open-cycle checkpoint,
not a completed graph or an archive-retirement receipt. Up to nineteen pages
and 4,832 KiB of payload are retained in one uncommitted staging representation;
individual pages do not become committed CAS objects. A final ACK names a fully
verified immutable graph. It does not authorize deleting hot history or model
promotion.

`scripts/install-adjustment-maintenance-runner.sh` packages only a hash-bound
public-code allowlist into the current user's immutable runner release. Its
`weather-adjustment-archive.service` is separate from the four planned
daily/monthly units. It uses `UMask=0077`, a process-lifetime lock, fifteen-second
polling, low CPU/I/O priority and restart-on-failure. Installation and startup
remain fail-closed until physical capacity and remote readiness are proved.
The reviewed count contract now passes; shipping unit bytes is not activation.
Readiness can inspect an absent or safely interrupted empty genesis without
creating anything. It charges the union of archive/state directories, both
locks and the atomic journal-head publication before admission. With an existing
`.weather` and otherwise empty genesis, startup needs six filesystem blocks and
eight inodes. Linked, broad, foreign and incomplete-history layouts still fail
closed. Actual initialization remains gated independently.

The physical probe verifies that a nested read-only `Ubuntu` home identity
matches this process's native ext4 home, then checks the current Ubuntu VHD
registration and actual C-drive free space. It does not depend on shell-only WSL
environment variables or substitute ext4 free space for backing-C free space.
On 2026-10-08 the fresh backing-C probe observed 43,019,538,432 free bytes.
The immutable legacy census charges symlinks using `lstat` without traversing
them; fixed private archive/state roots still reject links. The subsequent
read-only allocation census counts regular and linked legacy inode allocations
without opening their contents or requiring ownership of retained public files.
Dedicated archive and state roots still require owner-private, regular entries.
The runner uses the private `.weather` boundary and public system units rather
than repairing unrelated `.local`/`.config` ancestors. Device drift, special
entries, unsafe private roots and incomplete history remain readiness failures. Available backing-C
space above its 16 GiB floor is also below the full 27 GiB maximum-new-allocation
layout; actual bounded allocations must independently pass both free floors.

## Historical v13 activation checklist

1. Wire actual shadow inference and the orphan-safe body staging, compact-row
   append and exact admission relay into API/worker/web. The local identity and
   role tests are not a live data-plane implementation. Admission must also
   cross-bind the body's candidate to its frozen registration and source row
   hashes/valid times to the verified source geometry; matching a body hash alone
   is not proof of either. The target-interval versus complete-body lead-halo
   contract must be resolved before boundary bodies can qualify. Shortening the
   required lead population is not a remedy.
2. Wire acknowledged immutable revisions to cycle pages, final manifests and
   full-graph cold commits. Only acknowledged evidence may enter a designated
   snapshot. Finalized database accumulators must be joined to the anchored cold
   catalog before deriving eligible or missing keys; a null missing-key field is
   not proof of completeness.
3. Close physical admission, install the separately approved online
   consumer and prove the live page/checkpoint/final round trip. The daily job
   is not the consumer. Complete anchored C/T/F and bounded hot-state retirement
   before ongoing activation; local transfer ACKs alone do not provide them.
   The current producer retains lifetime evidence and ACK files and has a
   256-channel-assertion ceiling: four captures a day would exhaust it after
   64 days. Widening that cap or deleting history without anchored retirement is
   not an activation remedy.
4. Install the workstation controller and daily/monthly timers. Hold each scope's
   process lock for the entire operation, not only journal mutations. Reconcile
   due work using its original cutoff and publish a bounded authenticated v2
   admin projection without exposing reserved-member results before burn.
5. Implement sanitized model-only worktrees, exact-commit Check, immutable
   releases and source/settings/fencing compare-and-swap with family-scoped
   compensation. A completed fit alone must not promote a model.
6. Admit the complete fifteen-path v13 candidate only after exact-commit Check,
   immutable ARM64 image identity, literal inventory and physical capacity pass.
   Install the reviewed control-plane transition from its sole predecessor,
   preserve source settings, and verify affected Blueberry behavior. Shipping
   this inert integration does not make the unfinished maintenance service
   operational.

The historical scheduler defaulted to disabled. Its two deployment gates were
`WEATHER_ADJUSTMENT_SCHEDULED_CAPTURE_ENABLED` and
`WEATHER_ADJUSTMENT_MAINTENANCE_MIGRATION_READY`; setting flags alone is not a
readiness proof. Its old fixed 2027-10-08 end date does not describe the new
v14 future-only rolling bootstrap, which lasts 1,053 local dates and extends
only for a genuine registered member’s terminal closure. No model action is authorized by a v1 scorecard or a daily chart.

## v13 transport and scorecard integration

The fixed forced interfaces are:

- `adjustment-evaluation-export-v2 FROM_DATE TO_DATE`
- `adjustment-confirmation-availability-v2 REGISTRATION_SHA256`
- `adjustment-confirmation-export-v2 REGISTRATION_SHA256 ACCESS_SHA256 CHUNK_INDEX`
- `adjustment-maintenance-anchor-status-v2`
- `install-adjustment-scorecard-v2 SHA256`

Operands use closed canonical syntax; confirmation indices are `0` through `26`
with the registered family's smaller bound enforced by the database. No shell,
caller path, arbitrary SQL or owner function is exposed. Availability is
value-free; confirmation export requires a persisted burned-access identity and
sealed snapshot. Daily v2 transport retains the observational v1 view's local
Los Angeles inclusive-date semantics. It is not a complete finalized cold
catalog and supplies no retirement or model-action authority.

The anchor status reports private fixed-slot presence and hashes only. It says
`schemaReadiness=not_established` and `actionEligible=false`; opaque bytes are
not verified C/T/F evidence. No anchor writer or installer is implied.

Scorecard v2 is a closed, sanitized projection capped at 128 KiB, seven-day
expiry and the last 64 chronological history entries. It binds lineage, policy
and action states, active/shadow/prior/raw identities, confirmation/rollback/rain
progress and fixed warnings; reserved-member results and private artifacts are
refused. Authentication remains required. Legacy v1 is historical display only.
During migration one legacy current projection can coexist with only one
pending v2 projection, clearly shown as pending and unapplied. Pure-v2 hot slots
are bounded current/previous/pending selections. New publication refuses rather
than overwrite unarchived history; anchored retirement is still required for
ongoing rotation. Neither installing a scorecard nor displaying it promotes a
model, and no manual model-approval step is reintroduced.

### Fixed inert release transaction

For this bridge only, `yolo` derives its source environment from the exact active
`2026.10.07-3` release; bootstrap `.env` and caller-selected substitutes are
refused. A state-directory inode lock serializes all mutating release commands
without adding a privileged control path. PostgreSQL and Cloudflared references,
database path/name, canary switches and separately persisted admin settings are
preserved. This is not a future family promotion transaction.

`deploy/scripts/ssh-run.sh preflight` produces the private fixed
`/var/lib/weather/preflight-v13-resource.json` using the unchanged 900-second
sampler. The fixed bridge verifies fresh complete architecture/CPU/load/memory/
swap/inode evidence and rejects any such failure. Only the historical full-clone
storage formula is replaced by the literal image/capture/compatibility-fixture
peak; the protected free-byte and inode floors do not decrease. Legacy
stage/activate retain their original full-clone and encrypted-backup gates and
are not a route around the bridge's capacity proof.

Before active-database mutation, the pinned source API and worker must pass
complete-0018 authorization, negative authorization and deterministic provider
checks in an empty bounded disposable database bootstrapped from public code
and configuration. Production rows are not copied. Its database/WAL/filesystem
cost is reserved and measured. Only that completed proof can produce a
target-bound migration authorization. A subsequent mutation, ACL, health,
capacity or publication failure restores the exact source images and reconciles
runtime/schema markers before a separate post-compensation capacity diagnostic.
Failed recovery never reports a successful deployment.
