import { constants as fsConstants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  statfs,
  unlink,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

// isolate cycle protocol internals within the deployed single source of truth
const adjustmentCyclePageProtocol = (() => {
  const ADJUSTMENT_CYCLE_PAGE_CONTRACT_VERSION = "adjustment-cycle-page/v1";
  const ADJUSTMENT_CYCLE_ACK_CONTRACT_VERSION = "adjustment-cycle-page-ack/v1";
  const ADJUSTMENT_CYCLE_FINAL_MANIFEST_CONTRACT_VERSION =
    "adjustment-cycle-final-manifest/v1";
  const ADJUSTMENT_CYCLE_CAPSULE_CONTRACT_VERSION = "adjustment-cycle-capsule/v2";
  const ADJUSTMENT_EVIDENCE_GAP_CONTRACT_VERSION = "adjustment-evidence-gap/v1";
  const ADJUSTMENT_CYCLE_PAGE_PAYLOAD_BYTES = 256 * 1_024;
  const ADJUSTMENT_CYCLE_MAXIMUM_PAGES = 19;
  const ADJUSTMENT_CYCLE_MAXIMUM_PAYLOAD_BYTES = 4_832 * 1_024;
  const ADJUSTMENT_DAILY_MAXIMUM_PAGES = 22;
  const ADJUSTMENT_DAILY_MAXIMUM_PROJECTIONS = 4_096;
  const ADJUSTMENT_DAILY_RESERVED_SCHEDULER_PROJECTIONS = 4;

  const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
  const DUE_KEY_PATTERN = /^capture\/\d{4}-\d{2}-\d{2}T(?:00|06|12|18):35:00\.000Z$/u;
  const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
  const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
  const UINT64_MAXIMUM = 0xffff_ffff_ffff_ffffn;
  const CAPSULE_MAGIC = Buffer.from("WXACYCL2", "ascii");
  const CAPSULE_HEADER_BYTES = 16;
  const GAP_REASONS = new Set([
    "archive_refused",
    "capacity_refused",
    "page_limit",
    "projection_limit",
    "slot_unavailable",
    "transport_refused",
    "unacknowledged",
  ]);

  // create one empty bounded online page chain
  function createCyclePageState(input) {
    requireExactKeys(input, ["dailyPageCount", "dueKey", "generation", "localDate"], "cycle page state input");
    requireDueKey(input.dueKey);
    requireUint64(input.generation, "generation");
    requireLocalDate(input.localDate);

    // require the open daily page count below its exact ceiling
    if (!Number.isInteger(input.dailyPageCount) || input.dailyPageCount < 0 ||
      input.dailyPageCount >= ADJUSTMENT_DAILY_MAXIMUM_PAGES) {
      throw new TypeError("dailyPageCount is invalid");
    }

    return {
      contractVersion: "adjustment-cycle-page-state/v1",
      dueKey: input.dueKey,
      generation: input.generation,
      localDate: input.localDate,
      dailyPageCountAtOpen: input.dailyPageCount,
      pages: [],
      acknowledgements: [],
      gaps: [],
      slots: [],
      organicProjectionCount: 0,
      schedulerProjectionCount: 0,
      finalized: null,
    };
  }

  // append one predecessor-bound page after durable slot publication
  async function appendCyclePage(state, input, ports) {
    validateCyclePageState(state);
    requireExactKeys(input, ["payload", "projections"], "cycle page append");
    requireDurabilityPort(ports?.persistPage, "persistPage");
    const payload = requireBuffer(input.payload, "page payload");
    const projections = normalizeProjections(input.projections);
    const existingProjectionIdentities = new Set(state.pages.flatMap(
      // collect every already bound projection identity
      (page) => page.projectionIdentities,
    ));

    // prohibit changes after immutable finalization
    if (state.finalized !== null) {
      throw pageError("cycle_already_finalized");
    }

    // preserve only current and next crash slots
    if (state.slots.length >= 2) {
      throw pageError("slot_unavailable");
    }

    // enforce the transport payload ceiling
    if (payload.length === 0 || payload.length > ADJUSTMENT_CYCLE_PAGE_PAYLOAD_BYTES) {
      throw pageError("page_payload_refused");
    }

    // prohibit relabelling or duplicating one immutable projection
    if (projections.some((projection) =>
      existingProjectionIdentities.has(projection.identitySha256))) {
      throw pageError("projection_identity_collision");
    }

    // enforce exact cycle and local-date page ceilings
    if (state.pages.length >= ADJUSTMENT_CYCLE_MAXIMUM_PAGES ||
      state.dailyPageCountAtOpen + state.pages.length >= ADJUSTMENT_DAILY_MAXIMUM_PAGES) {
      throw pageError("page_limit");
    }

    const projectionCounts = countProjections(projections);
    const nextOrganicCount = state.organicProjectionCount + projectionCounts.organic;
    const nextSchedulerCount = state.schedulerProjectionCount + projectionCounts.scheduler;

    // retain four scheduler reservations before organic admission
    if (nextOrganicCount > ADJUSTMENT_DAILY_MAXIMUM_PROJECTIONS -
        ADJUSTMENT_DAILY_RESERVED_SCHEDULER_PROJECTIONS ||
      nextSchedulerCount > ADJUSTMENT_DAILY_RESERVED_SCHEDULER_PROJECTIONS ||
      nextOrganicCount + nextSchedulerCount > ADJUSTMENT_DAILY_MAXIMUM_PROJECTIONS) {
      throw pageError("projection_limit");
    }

    const previous = state.pages.at(-1) ?? null;
    const header = {
      contractVersion: ADJUSTMENT_CYCLE_PAGE_CONTRACT_VERSION,
      dueKey: state.dueKey,
      generation: state.generation,
      pageIndex: state.pages.length,
      predecessorPageSha256: previous?.pageSha256 ?? null,
      payloadSha256: sha256(payload),
      payloadOffset: previous === null
        ? 0
        : previous.payloadOffset + previous.payloadLength,
    };
    const pageSha256 = hashPage(header, payload);
    const slot = state.slots.length === 0 ? "current" : "next";
    const durable = await ports.persistPage({
      header,
      pageSha256,
      payload,
      projections,
      slot,
    });
    requireDurabilityProof(durable, "pageSha256", pageSha256);
    const page = {
      pageIndex: header.pageIndex,
      pageSha256,
      predecessorPageSha256: header.predecessorPageSha256,
      payloadSha256: header.payloadSha256,
      payloadOffset: header.payloadOffset,
      payloadLength: payload.length,
      projectionIdentities: projections.map(
        // retain only ordered immutable projection identities
        (projection) => projection.identitySha256,
      ),
      projectionChannels: projections.map(
        // retain the channel bound by the page payload
        (projection) => projection.channel,
      ),
    };
    return {
      ...state,
      pages: [...state.pages, page],
      slots: [...state.slots, { pageIndex: page.pageIndex, pageSha256, slot }],
      organicProjectionCount: nextOrganicCount,
      schedulerProjectionCount: nextSchedulerCount,
    };
  }

  // acknowledge the oldest page only after exact fsync proof
  async function ackCyclePage(state, input, ports) {
    validateCyclePageState(state);
    requireExactKeys(input, ["acknowledgedAt", "pageSha256"], "cycle page acknowledgement");
    requireSha256(input.pageSha256, "pageSha256");
    requireInstant(input.acknowledgedAt, "acknowledgedAt");
    requireDurabilityPort(ports?.persistAcknowledgement, "persistAcknowledgement");
    const oldest = state.slots[0];

    // require one exact in-order pending page
    if (oldest === undefined || oldest.pageSha256 !== input.pageSha256) {
      const existing = state.acknowledgements.find(
        // locate an exact idempotent prior acknowledgement
        (acknowledgement) => acknowledgement.pageSha256 === input.pageSha256,
      );

      // return only an exact prior acknowledgement
      if (existing !== undefined) {
        // reject retry with a different acknowledgement instant
        if (existing.acknowledgedAt !== input.acknowledgedAt) {
          throw pageError("acknowledgement_collision");
        }
        return state;
      }
      throw pageError("acknowledgement_order_refused");
    }

    const page = state.pages[oldest.pageIndex];
    const acknowledgement = {
      contractVersion: ADJUSTMENT_CYCLE_ACK_CONTRACT_VERSION,
      dueKey: state.dueKey,
      generation: state.generation,
      pageIndex: page.pageIndex,
      pageSha256: page.pageSha256,
      acknowledgedAt: input.acknowledgedAt,
    };
    const acknowledgementSha256 = sha256(canonicalJsonBytes(acknowledgement));
    const nextSlots = state.slots.slice(1).map(
      // move only an already durable next page into current
      (slotValue) => ({ ...slotValue, slot: "current" }),
    );
    const durable = await ports.persistAcknowledgement({
      acknowledgement,
      acknowledgementSha256,
      nextSlots,
    });
    requireDurabilityProof(durable, "acknowledgementSha256", acknowledgementSha256);
    return {
      ...state,
      acknowledgements: [...state.acknowledgements, {
        ...acknowledgement,
        acknowledgementSha256,
      }],
      slots: nextSlots,
    };
  }

  // finalize one closed acknowledged chain after durable publication
  async function finalizeCyclePages(state, input, ports) {
    validateCyclePageState(state);
    requireExactKeys(input, ["finalizedAt"], "cycle finalization");
    requireInstant(input.finalizedAt, "finalizedAt");
    requireDurabilityPort(ports?.persistFinalManifest, "persistFinalManifest");

    // reuse only the already immutable final manifest
    if (state.finalized !== null) {
      // reject a changed finalization instant
      if (state.finalized.manifest.finalizedAt !== input.finalizedAt) {
        throw pageError("final_manifest_collision");
      }
      return { manifest: state.finalized.manifest, state };
    }

    // require at least one fully acknowledged page
    if (state.pages.length === 0 || state.slots.length !== 0 ||
      state.acknowledgements.length !== state.pages.length) {
      throw pageError("cycle_not_fully_acknowledged");
    }

    const pages = state.pages.map(
      // bind exact ordered page metadata without payload duplication
      (page) => ({
        pageIndex: page.pageIndex,
        pageSha256: page.pageSha256,
        predecessorPageSha256: page.predecessorPageSha256,
        payloadSha256: page.payloadSha256,
        payloadOffset: page.payloadOffset,
        payloadLength: page.payloadLength,
      }),
    );
    const acknowledgementHashes = state.acknowledgements.map(
      // bind exact durable acknowledgement order
      (acknowledgement) => acknowledgement.acknowledgementSha256,
    );
    const acknowledgedProjectionIdentities = state.pages.flatMap(
      // admit projections only from pages with durable acknowledgements
      (page) => page.projectionIdentities,
    ).sort();
    const gapHashes = state.gaps.map(
      // bind every durable categorical gap
      (gap) => gap.gapSha256,
    ).sort();
    const manifest = {
      contractVersion: ADJUSTMENT_CYCLE_FINAL_MANIFEST_CONTRACT_VERSION,
      dueKey: state.dueKey,
      generation: state.generation,
      finalizedAt: input.finalizedAt,
      pageCount: pages.length,
      totalPayloadBytes: pages.reduce(
        // sum exact acknowledged payload bytes
        (total, page) => total + page.payloadLength,
        0,
      ),
      pages,
      pageRootSha256: sha256(canonicalJsonBytes(pages)),
      acknowledgementRootSha256: sha256(canonicalJsonBytes(acknowledgementHashes)),
      acknowledgedProjectionCount: acknowledgedProjectionIdentities.length,
      acknowledgedProjectionRootSha256: sha256(canonicalJsonBytes(acknowledgedProjectionIdentities)),
      evidenceGapCount: gapHashes.length,
      evidenceGapRootSha256: sha256(canonicalJsonBytes(gapHashes)),
    };
    validateCycleFinalManifest(manifest);
    const manifestSha256 = sha256(canonicalJsonBytes(manifest));
    const durable = await ports.persistFinalManifest({ manifest, manifestSha256 });
    requireDurabilityProof(durable, "manifestSha256", manifestSha256);
    const nextState = { ...state, finalized: { manifest, manifestSha256 } };
    return { manifest, manifestSha256, state: nextState };
  }

  // reconcile one chain from exact durable pages and acknowledgements
  function reconcileCyclePages(input) {
    requireExactKeys(input, ["durable", "expected"], "cycle reconciliation");
    const expected = input.expected;
    validateCyclePageState(expected);
    requireExactKeys(input.durable, ["acknowledgements", "finalized", "gaps", "pages"], "durable cycle state");
    const durable = input.durable;

    // require arrays for every append-only durable class
    if (!Array.isArray(durable.pages) || !Array.isArray(durable.acknowledgements) ||
      !Array.isArray(durable.gaps)) {
      throw pageError("durable_cycle_state_invalid");
    }

    const durablePages = [];

    // rebuild every durable page against its durable predecessor
    for (let index = 0; index < durable.pages.length; index += 1) {
      durablePages.push(normalizePageMetadata(
        durable.pages[index],
        { ...expected, pages: durablePages },
        index,
      ));
    }
    const durableAcknowledgements = durable.acknowledgements.map(
      // validate and normalize one durable acknowledgement
      (acknowledgement, index) => normalizeDurableAcknowledgement(
        acknowledgement,
        expected,
        durablePages,
        index,
      ),
    );
    const durableGaps = durable.gaps.map(
      // validate one durable gap
      (gap) => validateEvidenceGap(gap, expected),
    );

    // reject any durable chain that conflicts with known local bytes
    if (!isPrefix(expected.pages, durablePages) && !isPrefix(durablePages, expected.pages)) {
      throw pageError("durable_page_collision");
    }

    // retain at most the current and next unacknowledged pages
    if (durablePages.length - durableAcknowledgements.length > 2) {
      throw pageError("hidden_page_spool_refused");
    }

    const slots = durablePages.slice(durableAcknowledgements.length).map(
      // assign only current and next physical slots
      (page, index) => ({
        pageIndex: page.pageIndex,
        pageSha256: page.pageSha256,
        slot: index === 0 ? "current" : "next",
      }),
    );
    const reconciled = {
      ...expected,
      pages: durablePages,
      acknowledgements: durableAcknowledgements,
      gaps: durableGaps,
      slots,
      organicProjectionCount: countPageChannels(durablePages, "organic"),
      schedulerProjectionCount: countPageChannels(durablePages, "scheduler_request"),
      finalized: durable.finalized,
    };
    validateCyclePageState(reconciled);
    return {
      state: reconciled,
      status: reconciled.finalized !== null
        ? "closed"
        : reconciled.slots.length === 0
          ? "ready"
          : "awaiting_acknowledgement",
    };
  }

  // record one durable categorical evidence gap
  async function recordEvidenceGap(state, input, ports) {
    validateCyclePageState(state);
    requireExactKeys(input, ["occurredAt", "projectionIdentitySha256", "reason"], "evidence gap input");
    requireInstant(input.occurredAt, "occurredAt");
    requireSha256(input.projectionIdentitySha256, "projectionIdentitySha256");

    // prohibit rewriting a closed cycle manifest
    if (state.finalized !== null) {
      throw pageError("cycle_already_finalized");
    }

    // require one closed refusal category
    if (!GAP_REASONS.has(input.reason)) {
      throw new TypeError("evidence gap reason is invalid");
    }
    requireDurabilityPort(ports?.persistGap, "persistGap");
    const gap = {
      contractVersion: ADJUSTMENT_EVIDENCE_GAP_CONTRACT_VERSION,
      dueKey: state.dueKey,
      generation: state.generation,
      projectionIdentitySha256: input.projectionIdentitySha256,
      reason: input.reason,
      occurredAt: input.occurredAt,
      qualificationDisposition: "forever_unqualified",
    };
    const gapSha256 = sha256(canonicalJsonBytes(gap));
    const existing = state.gaps.find(
      // find an exact prior gap for idempotent retry
      (candidate) => candidate.projectionIdentitySha256 === input.projectionIdentitySha256,
    );

    // reuse only byte-identical gap evidence
    if (existing !== undefined) {
      // reject relabelling one already gapped projection
      if (existing.gapSha256 !== gapSha256) {
        throw pageError("evidence_gap_collision");
      }
      return state;
    }

    const durable = await ports.persistGap({ gap, gapSha256 });
    requireDurabilityProof(durable, "gapSha256", gapSha256);
    return { ...state, gaps: [...state.gaps, { ...gap, gapSha256 }] };
  }

  // preserve normal serving while page admission records a durable gap
  async function appendCyclePageFailOpen(state, input, ports) {
    try {
      const nextState = await appendCyclePage(state, input, ports);
      return { state: nextState, status: "page_pending_acknowledgement", servingBlocked: false };
    } catch (error) {
      const projection = input.projections?.[0];

      // report an honest unrecorded gap when no stable identity exists
      if (projection === undefined || !SHA256_PATTERN.test(projection.identitySha256 ?? "")) {
        return {
          state,
          status: "evidence_gap_unrecorded",
          reason: classifyPageFailure(error),
          servingBlocked: false,
        };
      }

      try {
        const nextState = await recordEvidenceGap(state, {
          occurredAt: ports.now().toISOString(),
          projectionIdentitySha256: projection.identitySha256,
          reason: classifyPageFailure(error),
        }, ports);
        return { state: nextState, status: "evidence_gap", servingBlocked: false };
      } catch {
        return {
          state,
          status: "evidence_gap_persistence_refused",
          reason: classifyPageFailure(error),
          servingBlocked: false,
        };
      }
    }
  }

  // validate one complete in-memory page-chain state
  function validateCyclePageState(state) {
    requireExactKeys(state, [
      "contractVersion",
      "dueKey",
      "generation",
      "localDate",
      "dailyPageCountAtOpen",
      "pages",
      "acknowledgements",
      "gaps",
      "slots",
      "organicProjectionCount",
      "schedulerProjectionCount",
      "finalized",
    ], "cycle page state");

    // require the exact state contract
    if (state.contractVersion !== "adjustment-cycle-page-state/v1") {
      throw new TypeError("cycle page state contract is invalid");
    }
    requireDueKey(state.dueKey);
    requireUint64(state.generation, "generation");
    requireLocalDate(state.localDate);

    // enforce every bounded array and count
    if (!Array.isArray(state.pages) || state.pages.length > ADJUSTMENT_CYCLE_MAXIMUM_PAGES ||
      !Array.isArray(state.acknowledgements) ||
      !Array.isArray(state.gaps) || !Array.isArray(state.slots) || state.slots.length > 2 ||
      !Number.isInteger(state.dailyPageCountAtOpen) || state.dailyPageCountAtOpen < 0 ||
      state.dailyPageCountAtOpen + state.pages.length > ADJUSTMENT_DAILY_MAXIMUM_PAGES ||
      !Number.isInteger(state.organicProjectionCount) || state.organicProjectionCount < 0 ||
      !Number.isInteger(state.schedulerProjectionCount) || state.schedulerProjectionCount < 0) {
      throw new TypeError("cycle page state bounds are invalid");
    }

    // validate the complete predecessor and offset chain
    for (let index = 0; index < state.pages.length; index += 1) {
      normalizePageMetadata(state.pages[index], state, index);
    }

    // validate every acknowledgement prefix
    for (let index = 0; index < state.acknowledgements.length; index += 1) {
      normalizeDurableAcknowledgement(state.acknowledgements[index], state, state.pages, index);
    }

    // require acknowledgements to form one prefix
    if (state.acknowledgements.length > state.pages.length ||
      state.slots.length !== state.pages.length - state.acknowledgements.length) {
      throw new TypeError("cycle acknowledgement frontier is invalid");
    }

    // validate exact current and next slot projections
    for (let index = 0; index < state.slots.length; index += 1) {
      const slot = state.slots[index];
      requireExactKeys(slot, ["pageIndex", "pageSha256", "slot"], "cycle page slot");
      const pageIndex = state.acknowledgements.length + index;

      // reject hidden or reordered slot state
      if (slot.pageIndex !== pageIndex || slot.pageSha256 !== state.pages[pageIndex].pageSha256 ||
        slot.slot !== (index === 0 ? "current" : "next")) {
        throw new TypeError("cycle page slot is invalid");
      }
    }

    const projectionIdentities = state.pages.flatMap(
      // collect every retained projection identity
      (page) => page.projectionIdentities,
    );
    const uniqueProjectionIdentities = new Set(projectionIdentities);
    const organicProjectionCount = countPageChannels(state.pages, "organic");
    const schedulerProjectionCount = countPageChannels(state.pages, "scheduler_request");

    // require exact counts, uniqueness and reserved scheduler bounds
    if (uniqueProjectionIdentities.size !== projectionIdentities.length ||
      state.organicProjectionCount !== organicProjectionCount ||
      state.schedulerProjectionCount !== schedulerProjectionCount ||
      organicProjectionCount > ADJUSTMENT_DAILY_MAXIMUM_PROJECTIONS -
        ADJUSTMENT_DAILY_RESERVED_SCHEDULER_PROJECTIONS ||
      schedulerProjectionCount > ADJUSTMENT_DAILY_RESERVED_SCHEDULER_PROJECTIONS) {
      throw new TypeError("cycle projection frontier is invalid");
    }

    // validate every durable evidence gap
    for (const gap of state.gaps) {
      validateEvidenceGap(gap, state);
    }

    // validate immutable closure when present
    if (state.finalized !== null) {
      requireExactKeys(state.finalized, ["manifest", "manifestSha256"], "finalized cycle");
      requireSha256(state.finalized.manifestSha256, "finalized manifestSha256");
      validateCycleFinalManifest(state.finalized.manifest);

      // bind the retained final manifest bytes
      if (sha256(canonicalJsonBytes(state.finalized.manifest)) !== state.finalized.manifestSha256) {
        throw new TypeError("finalized manifest hash is invalid");
      }

      const manifest = state.finalized.manifest;
      const projectedPages = state.pages.map(
        // project the exact final page metadata
        (page) => ({
          pageIndex: page.pageIndex,
          pageSha256: page.pageSha256,
          predecessorPageSha256: page.predecessorPageSha256,
          payloadSha256: page.payloadSha256,
          payloadOffset: page.payloadOffset,
          payloadLength: page.payloadLength,
        }),
      );
      const acknowledgementHashes = state.acknowledgements.map(
        // bind the exact acknowledgement prefix
        (acknowledgement) => acknowledgement.acknowledgementSha256,
      );
      const acknowledgedProjectionIdentities = state.pages.flatMap(
        // bind only projections in acknowledged closed pages
        (page) => page.projectionIdentities,
      ).sort();
      const gapHashes = state.gaps.map(
        // bind every durable permanent gap
        (gap) => gap.gapSha256,
      ).sort();

      // require final closure to match the live append-only state exactly
      if (manifest.dueKey !== state.dueKey || manifest.generation !== state.generation ||
        !canonicalJsonBytes(manifest.pages).equals(canonicalJsonBytes(projectedPages)) ||
        manifest.acknowledgementRootSha256 !==
          sha256(canonicalJsonBytes(acknowledgementHashes)) ||
        manifest.acknowledgedProjectionCount !== acknowledgedProjectionIdentities.length ||
        manifest.acknowledgedProjectionRootSha256 !==
          sha256(canonicalJsonBytes(acknowledgedProjectionIdentities)) ||
        manifest.evidenceGapCount !== gapHashes.length ||
        manifest.evidenceGapRootSha256 !== sha256(canonicalJsonBytes(gapHashes))) {
        throw new TypeError("finalized manifest state binding is invalid");
      }
    }

    return state;
  }

  // validate one immutable final page manifest
  function validateCycleFinalManifest(manifest) {
    requireExactKeys(manifest, [
      "contractVersion",
      "dueKey",
      "generation",
      "finalizedAt",
      "pageCount",
      "totalPayloadBytes",
      "pages",
      "pageRootSha256",
      "acknowledgementRootSha256",
      "acknowledgedProjectionCount",
      "acknowledgedProjectionRootSha256",
      "evidenceGapCount",
      "evidenceGapRootSha256",
    ], "cycle final manifest");

    // require the exact immutable final contract
    if (manifest.contractVersion !== ADJUSTMENT_CYCLE_FINAL_MANIFEST_CONTRACT_VERSION) {
      throw new TypeError("cycle final manifest contract is invalid");
    }
    requireDueKey(manifest.dueKey);
    requireUint64(manifest.generation, "generation");
    requireInstant(manifest.finalizedAt, "finalizedAt");
    requireSha256(manifest.pageRootSha256, "pageRootSha256");
    requireSha256(manifest.acknowledgementRootSha256, "acknowledgementRootSha256");
    requireSha256(manifest.acknowledgedProjectionRootSha256, "acknowledgedProjectionRootSha256");
    requireSha256(manifest.evidenceGapRootSha256, "evidenceGapRootSha256");

    // require exact bounded counts
    if (!Array.isArray(manifest.pages) || manifest.pageCount !== manifest.pages.length ||
      manifest.pageCount < 1 || manifest.pageCount > ADJUSTMENT_CYCLE_MAXIMUM_PAGES ||
      !Number.isSafeInteger(manifest.totalPayloadBytes) || manifest.totalPayloadBytes < 1 ||
      manifest.totalPayloadBytes > ADJUSTMENT_CYCLE_MAXIMUM_PAYLOAD_BYTES ||
      !Number.isSafeInteger(manifest.acknowledgedProjectionCount) ||
      manifest.acknowledgedProjectionCount < 0 ||
      !Number.isSafeInteger(manifest.evidenceGapCount) || manifest.evidenceGapCount < 0) {
      throw new TypeError("cycle final manifest bounds are invalid");
    }

    // require the exact ordered page root
    if (sha256(canonicalJsonBytes(manifest.pages)) !== manifest.pageRootSha256) {
      throw new TypeError("cycle final page root is invalid");
    }

    let expectedOffset = 0;
    let predecessorPageSha256 = null;

    // validate exact page ordering, offsets and predecessor links
    for (let index = 0; index < manifest.pages.length; index += 1) {
      const page = manifest.pages[index];
      requireExactKeys(page, [
        "pageIndex",
        "pageSha256",
        "predecessorPageSha256",
        "payloadSha256",
        "payloadOffset",
        "payloadLength",
      ], "cycle final page");
      requireSha256(page.pageSha256, "final pageSha256");
      requireSha256(page.payloadSha256, "final payloadSha256");

      // reject gaps, overlap and predecessor substitution
      if (page.pageIndex !== index || page.predecessorPageSha256 !== predecessorPageSha256 ||
        page.payloadOffset !== expectedOffset || !Number.isInteger(page.payloadLength) ||
        page.payloadLength < 1 || page.payloadLength > ADJUSTMENT_CYCLE_PAGE_PAYLOAD_BYTES) {
        throw new TypeError("cycle final page is invalid");
      }
      predecessorPageSha256 = page.pageSha256;
      expectedOffset += page.payloadLength;
    }

    // bind the exact total to the ordered ranges
    if (expectedOffset !== manifest.totalPayloadBytes) {
      throw new TypeError("cycle final payload total is invalid");
    }
    return manifest;
  }

  // encode one cold capsule member for one finalized cycle
  function encodeCycleCapsule(input) {
    requireExactKeys(input, ["manifest", "manifestSha256", "pagePayloads"], "cycle capsule input");
    const manifest = validateCycleFinalManifest(input.manifest);
    requireSha256(input.manifestSha256, "manifestSha256");
    const manifestBytes = canonicalJsonBytes(manifest);

    // bind the exact immutable final manifest
    if (sha256(manifestBytes) !== input.manifestSha256) {
      throw new TypeError("cycle capsule manifest hash is invalid");
    }

    // require exactly one payload per finalized page
    if (!Array.isArray(input.pagePayloads) ||
      input.pagePayloads.length !== manifest.pageCount) {
      throw new TypeError("cycle capsule payload count is invalid");
    }

    const payloads = input.pagePayloads.map(
      // copy and verify every ordered page payload
      (payload, index) => {
        const bytes = requireBuffer(payload, "cycle capsule page payload");
        const page = manifest.pages[index];

        // reject substituted or resized page bytes
        if (bytes.length !== page.payloadLength || sha256(bytes) !== page.payloadSha256) {
          throw new TypeError("cycle capsule page payload is invalid");
        }
        return Buffer.from(bytes);
      },
    );
    const header = Buffer.alloc(CAPSULE_HEADER_BYTES);
    CAPSULE_MAGIC.copy(header, 0);
    header.writeUInt32BE(manifestBytes.length, 8);
    header.writeUInt32BE(manifest.pageCount, 12);
    return Buffer.concat([header, manifestBytes, ...payloads]);
  }

  // validate one single-capsule finalized-cycle payload
  function validateCycleCapsule(bytes) {
    const payload = requireBuffer(bytes, "cycle capsule bytes");

    // reject a truncated or wrong-magic capsule
    if (payload.length < CAPSULE_HEADER_BYTES ||
      !payload.subarray(0, 8).equals(CAPSULE_MAGIC)) {
      throw new TypeError("cycle capsule header is invalid");
    }
    const manifestLength = payload.readUInt32BE(8);
    const pageCount = payload.readUInt32BE(12);
    const manifestEnd = CAPSULE_HEADER_BYTES + manifestLength;

    // reject unsafe manifest bounds before parsing
    if (manifestLength === 0 || manifestEnd > payload.length) {
      throw new TypeError("cycle capsule manifest length is invalid");
    }

    const manifestBytes = payload.subarray(CAPSULE_HEADER_BYTES, manifestEnd);
    let manifest;

    try {
      manifest = JSON.parse(manifestBytes.toString("utf8"));
    } catch {
      throw new TypeError("cycle capsule manifest JSON is invalid");
    }

    // require exact canonical manifest bytes
    if (!canonicalJsonBytes(manifest).equals(manifestBytes)) {
      throw new TypeError("cycle capsule manifest is not canonical");
    }
    validateCycleFinalManifest(manifest);

    // bind the redundant capsule page count
    if (pageCount !== manifest.pageCount) {
      throw new TypeError("cycle capsule page count is invalid");
    }

    let offset = manifestEnd;

    // verify every page payload in final-manifest order
    for (const page of manifest.pages) {
      const end = offset + page.payloadLength;

      // reject short page bytes before hashing
      if (end > payload.length) {
        throw new TypeError("cycle capsule is truncated");
      }

      // reject a substituted page payload
      if (sha256(payload.subarray(offset, end)) !== page.payloadSha256) {
        throw new TypeError("cycle capsule page hash is invalid");
      }
      offset = end;
    }

    // reject hidden trailing rows or a second capsule
    if (offset !== payload.length) {
      throw new TypeError("cycle capsule has trailing bytes");
    }
    return {
      contractVersion: ADJUSTMENT_CYCLE_CAPSULE_CONTRACT_VERSION,
      dueKey: manifest.dueKey,
      generation: manifest.generation,
      manifest,
      manifestSha256: sha256(manifestBytes),
      pageCount,
      totalPayloadBytes: manifest.totalPayloadBytes,
    };
  }

  // validate one transport page envelope for edge integration
  function validateCyclePage(input) {
    requireExactKeys(input, ["header", "pageSha256", "payload", "projections"], "cycle page envelope");
    const header = input.header;
    requireExactKeys(header, [
      "contractVersion",
      "dueKey",
      "generation",
      "pageIndex",
      "predecessorPageSha256",
      "payloadSha256",
      "payloadOffset",
    ], "cycle page header");

    // require the online header contract without final root or count fields
    if (header.contractVersion !== ADJUSTMENT_CYCLE_PAGE_CONTRACT_VERSION) {
      throw new TypeError("cycle page contract is invalid");
    }
    requireDueKey(header.dueKey);
    requireUint64(header.generation, "generation");
    requireSha256(header.payloadSha256, "payloadSha256");

    // validate nullable predecessor, index and offset bounds
    if (header.predecessorPageSha256 !== null) {
      requireSha256(header.predecessorPageSha256, "predecessorPageSha256");
    }

    if (!Number.isInteger(header.pageIndex) || header.pageIndex < 0 ||
      header.pageIndex >= ADJUSTMENT_CYCLE_MAXIMUM_PAGES ||
      !Number.isSafeInteger(header.payloadOffset) || header.payloadOffset < 0) {
      throw new TypeError("cycle page header bounds are invalid");
    }

    // require genesis or predecessor-bound header consistency
    if ((header.pageIndex === 0 &&
        (header.predecessorPageSha256 !== null || header.payloadOffset !== 0)) ||
      (header.pageIndex > 0 && header.predecessorPageSha256 === null)) {
      throw new TypeError("cycle page predecessor is invalid");
    }

    const payload = requireBuffer(input.payload, "page payload");

    // require exact payload and complete-page hashes
    if (payload.length < 1 || payload.length > ADJUSTMENT_CYCLE_PAGE_PAYLOAD_BYTES ||
      sha256(payload) !== header.payloadSha256 ||
      hashPage(header, payload) !== input.pageSha256) {
      throw new TypeError("cycle page bytes are invalid");
    }
    requireSha256(input.pageSha256, "pageSha256");
    const projections = normalizeProjections(input.projections);
    return { header: { ...header }, pageSha256: input.pageSha256, payload, projections };
  }

  // normalize one projection identity and channel
  function normalizeProjections(projections) {
    // require a bounded projection list
    if (!Array.isArray(projections) || projections.length > ADJUSTMENT_DAILY_MAXIMUM_PROJECTIONS) {
      throw new TypeError("page projections are invalid");
    }

    const normalized = projections.map(
      // validate one immutable projection reference
      (projection) => {
        requireExactKeys(projection, ["channel", "identitySha256"], "page projection");
        requireSha256(projection.identitySha256, "projection identitySha256");

        // allow only reserved scheduler or ordinary organic projections
        if (projection.channel !== "scheduler_request" && projection.channel !== "organic") {
          throw new TypeError("projection channel is invalid");
        }
        return { ...projection };
      },
    ).sort(
      // order exact projection identities
      (left, right) => left.identitySha256.localeCompare(right.identitySha256, "en"),
    );

    // reject duplicate projection identities
    if (normalized.some((projection, index) =>
      index > 0 && projection.identitySha256 === normalized[index - 1].identitySha256)) {
      throw new TypeError("projection identity is duplicated");
    }
    return normalized;
  }

  // count projection channels without pooling them
  function countProjections(projections) {
    return {
      organic: projections.filter(
        // select ordinary projections
        (projection) => projection.channel === "organic",
      ).length,
      scheduler: projections.filter(
        // select scheduler reservations
        (projection) => projection.channel === "scheduler_request",
      ).length,
    };
  }

  // count one retained page channel
  function countPageChannels(pages, channel) {
    return pages.reduce(
      // accumulate exact page channel entries
      (total, page) => total + page.projectionChannels.filter(
        // match one requested channel
        (value) => value === channel,
      ).length,
      0,
    );
  }

  // validate one page metadata record
  function normalizePageMetadata(value, state, index) {
    requireExactKeys(value, [
      "pageIndex",
      "pageSha256",
      "predecessorPageSha256",
      "payloadSha256",
      "payloadOffset",
      "payloadLength",
      "projectionIdentities",
      "projectionChannels",
    ], "durable page");
    requireSha256(value.pageSha256, "page pageSha256");
    requireSha256(value.payloadSha256, "page payloadSha256");

    // require exact consecutive index, predecessor and offset
    if (value.pageIndex !== index ||
      value.predecessorPageSha256 !== (index === 0 ? null : state.pages[index - 1].pageSha256) ||
      value.payloadOffset !== (index === 0
        ? 0
        : state.pages[index - 1].payloadOffset + state.pages[index - 1].payloadLength) ||
      !Number.isInteger(value.payloadLength) || value.payloadLength < 1 ||
      value.payloadLength > ADJUSTMENT_CYCLE_PAGE_PAYLOAD_BYTES ||
      !Array.isArray(value.projectionIdentities) || !Array.isArray(value.projectionChannels) ||
      value.projectionIdentities.length !== value.projectionChannels.length) {
      throw new TypeError("page metadata is invalid");
    }

    // validate every retained projection identity
    for (const identity of value.projectionIdentities) {
      requireSha256(identity, "page projection identity");
    }

    // validate every retained projection channel
    for (const channel of value.projectionChannels) {
      // reject unknown projection channels
      if (channel !== "organic" && channel !== "scheduler_request") {
        throw new TypeError("page projection channel is invalid");
      }
    }
    return { ...value };
  }

  // normalize one durable acknowledgement
  function normalizeDurableAcknowledgement(value, state, pages, index) {
    requireExactKeys(value, [
      "contractVersion",
      "dueKey",
      "generation",
      "pageIndex",
      "pageSha256",
      "acknowledgedAt",
      "acknowledgementSha256",
    ], "durable acknowledgement");

    // require one exact ordered acknowledgement
    if (value.contractVersion !== ADJUSTMENT_CYCLE_ACK_CONTRACT_VERSION ||
      value.dueKey !== state.dueKey || value.generation !== state.generation ||
      value.pageIndex !== index || value.pageSha256 !== pages[index]?.pageSha256) {
      throw new TypeError("durable acknowledgement is invalid");
    }
    requireInstant(value.acknowledgedAt, "acknowledgedAt");
    requireSha256(value.acknowledgementSha256, "acknowledgementSha256");
    const unhashed = { ...value };
    delete unhashed.acknowledgementSha256;

    // bind the exact acknowledgement bytes
    if (sha256(canonicalJsonBytes(unhashed)) !== value.acknowledgementSha256) {
      throw new TypeError("acknowledgement hash is invalid");
    }
    return { ...value };
  }

  // validate one retained evidence gap
  function validateEvidenceGap(value, state) {
    requireExactKeys(value, [
      "contractVersion",
      "dueKey",
      "generation",
      "projectionIdentitySha256",
      "reason",
      "occurredAt",
      "qualificationDisposition",
      "gapSha256",
    ], "evidence gap");

    // require the exact permanent-unqualification semantics
    if (value.contractVersion !== ADJUSTMENT_EVIDENCE_GAP_CONTRACT_VERSION ||
      value.dueKey !== state.dueKey || value.generation !== state.generation ||
      value.qualificationDisposition !== "forever_unqualified" ||
      !GAP_REASONS.has(value.reason)) {
      throw new TypeError("evidence gap is invalid");
    }
    requireSha256(value.projectionIdentitySha256, "gap projectionIdentitySha256");
    requireInstant(value.occurredAt, "gap occurredAt");
    requireSha256(value.gapSha256, "gapSha256");
    const unhashed = { ...value };
    delete unhashed.gapSha256;

    // bind the exact gap bytes
    if (sha256(canonicalJsonBytes(unhashed)) !== value.gapSha256) {
      throw new TypeError("evidence gap hash is invalid");
    }
    return { ...value };
  }

  // compare two arrays as canonical prefixes
  function isPrefix(prefix, complete) {
    // reject a longer alleged prefix
    if (prefix.length > complete.length) {
      return false;
    }
    return prefix.every(
      // compare each canonical element byte for byte
      (value, index) => canonicalJsonBytes(value).equals(canonicalJsonBytes(complete[index])),
    );
  }

  // hash the canonical header framing and exact payload
  function hashPage(header, payload) {
    return createHash("sha256").update(canonicalJsonBytes(header)).update(payload).digest("hex");
  }

  // require an exact fsync durability proof
  function requireDurabilityProof(value, hashKey, expectedSha256) {
    requireExactKeys(value, ["fsynced", hashKey], "durability proof");

    // reject optimistic or mismatched persistence claims
    if (value.fsynced !== true || value[hashKey] !== expectedSha256) {
      throw pageError("durability_proof_refused");
    }
  }

  // require one persistence boundary
  function requireDurabilityPort(value, label) {
    // reject missing persistence instead of mocking success
    if (typeof value !== "function") {
      throw new TypeError(`${label} is required`);
    }
  }

  // classify one page failure into a durable gap category
  function classifyPageFailure(error) {
    // preserve only closed gap reason values
    if (GAP_REASONS.has(error?.reason)) {
      return error.reason;
    }
    return error?.code === "resource_refused" ? "capacity_refused" : "archive_refused";
  }

  // create one closed page refusal
  function pageError(reason) {
    const error = new Error(reason);
    error.code = "adjustment_page_refused";
    error.reason = reason;
    return error;
  }

  // encode recursively sorted canonical JSON
  function canonicalJsonBytes(value) {
    return Buffer.from(`${JSON.stringify(canonicalValue(value))}\n`, "utf8");
  }

  // recursively normalize canonical JSON values
  function canonicalValue(value) {
    // retain JSON scalar values
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      return value;
    }

    // retain only safe finite nonnegative-zero numbers
    if (typeof value === "number") {
      // reject nonfinite and negative-zero encodings
      if (!Number.isFinite(value) || Object.is(value, -0)) {
        throw new TypeError("canonical JSON number is invalid");
      }
      return value;
    }

    // preserve semantic array order
    if (Array.isArray(value)) {
      return value.map(
        // normalize one array value
        (entry) => canonicalValue(entry),
      );
    }

    requirePlainObject(value, "canonical JSON object");
    return Object.fromEntries(Object.keys(value).sort().map(
      // sort and normalize every object field
      (key) => [key, canonicalValue(value[key])],
    ));
  }

  // calculate one lowercase SHA-256 digest
  function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
  }

  // require the exact scheduled capture due-key grammar
  function requireDueKey(value) {
    // reject ambiguous or non-cycle due keys
    if (typeof value !== "string" || !DUE_KEY_PATTERN.test(value)) {
      throw new TypeError("dueKey is invalid");
    }
  }

  // require one canonical local date
  function requireLocalDate(value) {
    // reject noncanonical dates
    if (typeof value !== "string" || !LOCAL_DATE_PATTERN.test(value)) {
      throw new TypeError("localDate is invalid");
    }
  }

  // require one canonical UTC millisecond instant
  function requireInstant(value, label) {
    // reject noncanonical or impossible instants
    if (typeof value !== "string" || !INSTANT_PATTERN.test(value) ||
      new Date(value).toISOString() !== value) {
      throw new TypeError(`${label} is invalid`);
    }
  }

  // require one decimal unsigned 64-bit generation
  function requireUint64(value, label) {
    // reject noncanonical or overflowing decimal strings
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value) ||
      BigInt(value) > UINT64_MAXIMUM) {
      throw new TypeError(`${label} is invalid`);
    }
  }

  // require one lowercase SHA-256 value
  function requireSha256(value, label) {
    // reject noncanonical hashes
    if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
      throw new TypeError(`${label} is invalid`);
    }
  }

  // require one immutable byte buffer
  function requireBuffer(value, label) {
    // reject implicit byte coercion
    if (!Buffer.isBuffer(value)) {
      throw new TypeError(`${label} must be a Buffer`);
    }
    return value;
  }

  // require one plain object
  function requirePlainObject(value, label) {
    // reject null, arrays and custom prototypes
    if (value === null || Array.isArray(value) || typeof value !== "object" ||
      Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError(`${label} must be a plain object`);
    }
  }

  // require one exact closed key set
  function requireExactKeys(value, keys, label) {
    requirePlainObject(value, label);
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();

    // reject unknown or missing fields
    if (actual.length !== expected.length ||
      actual.some((key, index) => key !== expected[index])) {
      throw new TypeError(`${label} has invalid keys`);
    }
  }


  return Object.freeze({
    ADJUSTMENT_CYCLE_PAGE_CONTRACT_VERSION,
    ADJUSTMENT_CYCLE_ACK_CONTRACT_VERSION,
    ADJUSTMENT_CYCLE_FINAL_MANIFEST_CONTRACT_VERSION,
    ADJUSTMENT_CYCLE_CAPSULE_CONTRACT_VERSION,
    ADJUSTMENT_EVIDENCE_GAP_CONTRACT_VERSION,
    ADJUSTMENT_CYCLE_PAGE_PAYLOAD_BYTES,
    ADJUSTMENT_CYCLE_MAXIMUM_PAGES,
    ADJUSTMENT_CYCLE_MAXIMUM_PAYLOAD_BYTES,
    ADJUSTMENT_DAILY_MAXIMUM_PAGES,
    ADJUSTMENT_DAILY_MAXIMUM_PROJECTIONS,
    ADJUSTMENT_DAILY_RESERVED_SCHEDULER_PROJECTIONS,
    createCyclePageState,
    appendCyclePage,
    ackCyclePage,
    finalizeCyclePages,
    reconcileCyclePages,
    recordEvidenceGap,
    appendCyclePageFailOpen,
    validateCyclePageState,
    validateCycleFinalManifest,
    encodeCycleCapsule,
    validateCycleCapsule,
    validateCyclePage,
  });
})();

// export the fixed cycle protocol surface for runtime and research callers
export const {
  ADJUSTMENT_CYCLE_PAGE_CONTRACT_VERSION,
  ADJUSTMENT_CYCLE_ACK_CONTRACT_VERSION,
  ADJUSTMENT_CYCLE_FINAL_MANIFEST_CONTRACT_VERSION,
  ADJUSTMENT_CYCLE_CAPSULE_CONTRACT_VERSION,
  ADJUSTMENT_EVIDENCE_GAP_CONTRACT_VERSION,
  ADJUSTMENT_CYCLE_PAGE_PAYLOAD_BYTES,
  ADJUSTMENT_CYCLE_MAXIMUM_PAGES,
  ADJUSTMENT_CYCLE_MAXIMUM_PAYLOAD_BYTES,
  ADJUSTMENT_DAILY_MAXIMUM_PAGES,
  ADJUSTMENT_DAILY_MAXIMUM_PROJECTIONS,
  ADJUSTMENT_DAILY_RESERVED_SCHEDULER_PROJECTIONS,
  createCyclePageState,
  appendCyclePage,
  ackCyclePage,
  finalizeCyclePages,
  reconcileCyclePages,
  recordEvidenceGap,
  appendCyclePageFailOpen,
  validateCyclePageState,
  validateCycleFinalManifest,
  encodeCycleCapsule,
  validateCycleCapsule,
  validateCyclePage,
} = adjustmentCyclePageProtocol;

export const ADJUSTMENT_EVIDENCE_OBJECT_CONTRACT_VERSION =
  "forecast-adjustment-evidence-object/v1";
export const ADJUSTMENT_EVIDENCE_RECEIPT_CONTRACT_VERSION =
  "forecast-adjustment-edge-receipt/v1";
export const ADJUSTMENT_EVIDENCE_SNAPSHOT_CONTRACT_VERSION =
  "forecast-adjustment-evidence-snapshot/v1";
export const ADJUSTMENT_EVIDENCE_OBJECT_V2_CONTRACT_VERSION =
  "forecast-adjustment-evidence-object/v2";
export const ADJUSTMENT_EVIDENCE_RECEIPT_V2_CONTRACT_VERSION =
  "forecast-adjustment-edge-receipt/v2";
export const ADJUSTMENT_EVIDENCE_CHANNEL_CONTRACT_VERSION =
  "issuance-channel-assertion/v2";
export const ADJUSTMENT_EVIDENCE_SCHEDULER_STATE_CONTRACT_VERSION =
  "adjustment-evidence-scheduler-state/v1";
export const ADJUSTMENT_EVIDENCE_DEFAULT_ROOT =
  "/var/lib/weather/xweather/adjustment-evidence";
const ADJUSTMENT_EVIDENCE_PROTECTED_FREE_BYTES = 2_030_043_136;
const ADJUSTMENT_EVIDENCE_NEXT_CAPTURE_RESERVATION_BYTES = 4_112_384;
export const ADJUSTMENT_EVIDENCE_SCHEDULER_REQUIRED_FREE_BYTES =
  ADJUSTMENT_EVIDENCE_PROTECTED_FREE_BYTES +
  ADJUSTMENT_EVIDENCE_NEXT_CAPTURE_RESERVATION_BYTES;
export const ADJUSTMENT_EVIDENCE_CAPTURE_START = "2026-10-08T00:00:00.000Z";
export const ADJUSTMENT_EVIDENCE_CAPTURE_END = "2027-10-08T00:00:00.000Z";
export const ADJUSTMENT_ARCHIVE_TRANSFER_CONTRACT_VERSION =
  "adjustment-archive-transfer/v1";

const OBJECT_MAXIMUM_BYTES = 512 * 1_024;
const COMPRESSED_OBJECT_MAXIMUM_BYTES = 16 * 1_024;
const RECEIPT_MAXIMUM_BYTES = 16 * 1_024;
const MAXIMUM_COMPRESSION_RATIO = 64;
const MAXIMUM_ROWS = 240;
const MAXIMUM_V2_ROWS = 241;
const MAXIMUM_IDENTITIES = 8_192;
const MAXIMUM_CHANNEL_ASSERTIONS = 256;
const SCHEDULER_HISTORY_LIMIT = 4 * 365;
const SCHEDULER_CATCHUP_MILLISECONDS = 12 * 60 * 60 * 1_000;
const SCHEDULER_POLL_MILLISECONDS = 30_000;
const ARCHIVE_LOCK_LEASE_MILLISECONDS = 5 * 60 * 1_000;
const ARCHIVE_LOCK_ATTEMPTS = 200;
const ARCHIVE_LOCK_RETRY_MILLISECONDS = 10;
const ARCHIVE_TRANSFER_MAXIMUM_BYTES = 1_024 * 1_024;
const LEDGER_ALLOCATION_MAXIMUM_BYTES = 64 * 1_024 * 1_024;
const FREE_INODE_FLOOR = 32_768;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const OBJECT_FILENAME_PATTERN = /^sha256-([a-f0-9]{64})\.json\.gz$/u;
const RECEIPT_FILENAME_PATTERN = /^sha256-([a-f0-9]{64})\.json$/u;
const CHANNEL_FILENAME_PATTERN = /^sha256-([a-f0-9]{64})\.json$/u;
const SCHEDULE_HOURS = [0, 6, 12, 18];
const ISSUANCE_CHANNELS = ["legacy_unattributed", "public_get", "scheduler_request"];
const WINDOWS = ["days=1", "days=5", "days=10", "overnight"];
const WIND_DECISION_STATES = ["active", "disabled", "not_applicable"];
const SOURCE_DECISION_STATES = ["active", "disabled", "raw_fallback"];
const RAW_METRICS = [
  "precipitationMm",
  "temperatureC",
  "windGustMps",
  "windSpeedMps",
];
const ADJUSTED_METRICS = [
  "apparentTemperatureC",
  "relativeHumidityPercent",
  "temperatureC",
  "windDirectionDegrees",
  "windGustMps",
  "windSpeedMps",
];

// keep capture errors outside the response path
export class AdjustmentEvidenceStore {
  #allocatedBytes = 0;
  #blockedIdentities = new Set();
  #initialized = false;
  #objectCount = 0;
  #options;
  #queue = Promise.resolve();
  #receiptCount = 0;
  #status = {
    asyncErrors: 0,
    asyncGaps: 0,
    bytes: 0,
    capacityExhausted: 0,
    channelAssertions: 0,
    channelCollisions: 0,
    closeWithoutFinish: 0,
    collisions: 0,
    finishedSuccesses: 0,
    freeSpaceRefusal: 0,
    inodeRefusal: 0,
    objectTooLarge: 0,
    objects: 0,
    provenanceIncomplete: 0,
  };

  // retain injectable boundaries for deterministic fault tests
  constructor(options = {}) {
    this.#options = {
      beforeObjectWrite: options.beforeObjectWrite ?? (() => undefined),
      now: options.now ?? (() => new Date()),
      root: resolve(options.root ?? ADJUSTMENT_EVIDENCE_DEFAULT_ROOT),
      statfs: options.statfs ?? ((path) => statfs(path, { bigint: true })),
      writeExclusive: options.writeExclusive ?? writeExclusive,
    };
  }

  // create and scan the bounded immutable store
  async initialize() {
    try {
      await ensureEvidenceDirectories(this.#options.root);
      const scan = await scanEvidenceDirectories(this.#options.root, true);
      this.#allocatedBytes = scan.allocatedBytes;
      this.#objectCount = scan.objectCount;
      this.#receiptCount = scan.receiptCount;
      this.#status.channelAssertions = scan.channelAssertionCount;
      this.#status.bytes = scan.allocatedBytes;
      this.#status.objects = scan.objectCount;
      this.#initialized = true;
    } catch {
      this.#status.asyncErrors += 1;
      this.#initialized = false;
    }
    return this;
  }

  // derive immutable capture bytes before writing the response
  prepare(filteredBody, window) {
    // refuse capture while filesystem integrity is unknown
    if (!this.#initialized) {
      this.#status.asyncGaps += 1;
      return null;
    }

    try {
      return createAdjustmentEvidenceCapture(filteredBody, window);
    } catch (error) {
      // classify only bounded projection failures
      if (error?.code === "adjustment_evidence_object_too_large") {
        this.#status.objectTooLarge += 1;
      } else {
        this.#status.asyncErrors += 1;
      }
      this.#status.asyncGaps += 1;
      return null;
    }
  }

  // derive one v2 capture with a trusted server-selected channel
  prepareV2(filteredBody, window, channel) {
    // refuse capture while filesystem integrity is unknown
    if (!this.#initialized) {
      this.#status.asyncGaps += 1;
      return null;
    }

    try {
      requireIssuanceChannel(channel);
      const rowCount = JSON.parse(Buffer.from(filteredBody).toString("utf8"))?.data?.length;
      const capture = rowCount === MAXIMUM_V2_ROWS
        ? createAdjustmentEvidenceCaptureV2(filteredBody, window)
        : createAdjustmentEvidenceCapture(filteredBody, window);
      return Object.freeze({
        ...capture,
        issuanceChannel: channel,
      });
    } catch (error) {
      // classify only bounded projection failures
      if (error?.code === "adjustment_evidence_object_too_large") {
        this.#status.objectTooLarge += 1;
      } else {
        this.#status.asyncErrors += 1;
      }
      this.#status.asyncGaps += 1;
      return null;
    }
  }

  // attach persistence only to Node's successful finish event
  trackResponse(response, prepared, onSettled = () => undefined) {
    let finished = false;

    // persist asynchronously only after the response commits
    response.once("finish", () => {
      finished = true;

      // retain one explicit capture gap when preparation failed
      if (prepared === null) {
        onSettled({ status: "preparation_refused" });
        return;
      }

      const firstEdgeCommittedAt = this.#options.now().toISOString();
      void this.commit(prepared, firstEdgeCommittedAt).then(
        // disclose the post-finish result only to the in-process caller
        (result) => onSettled(result),
        // contain all filesystem failures after response completion
        (error) => {
          this.#status.asyncErrors += 1;
          this.#status.asyncGaps += 1;
          onSettled({ status: "write_failed", error });
        },
      );
    });

    // distinguish aborted sockets from successfully finished responses
    response.once("close", () => {
      if (!finished) {
        this.#status.closeWithoutFinish += 1;
        onSettled({ status: "response_aborted" });
      }
    });
  }

  // serialize exclusive writes and capacity accounting
  async commit(prepared, firstEdgeCommittedAt) {
    const operation = this.#queue.then(
      // keep one writer inside the allocation guard
      () => this.#commitExclusive(prepared, firstEdgeCommittedAt),
    );
    this.#queue = operation.catch(() => undefined);
    return await operation;
  }

  // return bounded in-memory health counters only
  status() {
    return Object.freeze({ ...this.#status });
  }

  // write one content object and one first-issuance receipt
  async #commitExclusive(prepared, firstEdgeCommittedAt) {
    requireInstant(firstEdgeCommittedAt, "firstEdgeCommittedAt");

    // stop prepared work after any integrity-threatening write failure
    if (!this.#initialized) {
      this.#status.asyncGaps += 1;
      return { status: "store_unavailable" };
    }

    // stop a known collision identity without attempting repair
    if (this.#blockedIdentities.has(prepared.edgeReceiptIdentitySha256)) {
      this.#status.asyncGaps += 1;
      return { status: "identity_collision" };
    }

    const objectPath = evidenceObjectPath(this.#options.root, prepared.objectSha256);
    const receiptPath = evidenceReceiptPath(
      this.#options.root,
      prepared.edgeReceiptIdentitySha256,
    );
    const receiptExists = await regularFileExists(receiptPath);

    // honor an existing first receipt before creating any content object
    if (receiptExists) {
      const existingBytes = await readRegularFile(receiptPath, RECEIPT_MAXIMUM_BYTES);
      const existing = parseReceipt(existingBytes, prepared.edgeReceiptIdentitySha256);

      // block a stable identity already bound to different scoring content
      if (existing.objectSha256 !== prepared.objectSha256) {
        this.#blockedIdentities.add(prepared.edgeReceiptIdentitySha256);
        this.#status.collisions += 1;
        this.#status.asyncGaps += 1;
        await this.#refreshAllocationFromDisk();
        return { status: "identity_collision" };
      }

      const existingObject = await readRegularFile(
        objectPath,
        COMPRESSED_OBJECT_MAXIMUM_BYTES,
      );

      // require the receipt's immutable object to remain byte-identical
      if (!existingObject.equals(prepared.compressedObject)) {
        throw new Error("adjustment evidence receipt object is invalid");
      }

      await this.#commitChannelAssertion(prepared, existing, existingBytes, true);
      await this.#refreshAllocationFromDisk();
      return { status: "duplicate" };
    }

    const objectExists = await regularFileExists(objectPath);
    const receipt = createReceipt(prepared, firstEdgeCommittedAt);
    const receiptBytes = Buffer.from(`${canonicalJson(receipt)}\n`);
    const receiptMaximumBytes = receipt.contractVersion ===
      ADJUSTMENT_EVIDENCE_RECEIPT_V2_CONTRACT_VERSION
      ? 2_048
      : RECEIPT_MAXIMUM_BYTES;

    // enforce the independent receipt bound before filesystem work
    if (receiptBytes.byteLength > receiptMaximumBytes) {
      this.#status.objectTooLarge += 1;
      this.#status.asyncGaps += 1;
      return { status: "object_too_large" };
    }

    const filesystem = await this.#options.statfs(this.#options.root);
    const blockSize = Number(filesystem.bsize);
    const prospectiveBytes =
      (objectExists ? 0 : allocatedSize(prepared.compressedObject.byteLength, blockSize)) +
      (receiptExists ? 0 : allocatedSize(receiptBytes.byteLength, blockSize));

    // keep identities and allocated bytes inside the frozen envelope
    if (
      (!objectExists && this.#objectCount >= MAXIMUM_IDENTITIES) ||
      (!receiptExists && this.#receiptCount >= MAXIMUM_IDENTITIES) ||
      this.#allocatedBytes + prospectiveBytes > LEDGER_ALLOCATION_MAXIMUM_BYTES
    ) {
      this.#status.capacityExhausted += 1;
      this.#status.asyncGaps += 1;
      return { status: "capacity_exhausted" };
    }

    const freeBytes = Number(filesystem.bavail * filesystem.bsize);
    const freeInodes = Number(filesystem.ffree);

    // preserve the protected floor and next-capture reservation
    if (freeBytes - prospectiveBytes <
      ADJUSTMENT_EVIDENCE_SCHEDULER_REQUIRED_FREE_BYTES) {
      this.#status.freeSpaceRefusal += 1;
      this.#status.asyncGaps += 1;
      return { status: "capacity_exhausted" };
    }

    // retain enough free inodes for host operations
    if (freeInodes < FREE_INODE_FLOOR) {
      this.#status.inodeRefusal += 1;
      this.#status.asyncGaps += 1;
      return { status: "capacity_exhausted" };
    }

    let objectCreated;

    try {
      await this.#options.beforeObjectWrite();
      objectCreated = await writeOrVerifyImmutable(
        objectPath,
        prepared.compressedObject,
        COMPRESSED_OBJECT_MAXIMUM_BYTES,
        this.#options.writeExclusive,
      );
    } catch (error) {
      // reconcile any complete or injected partial final before disabling capture
      await this.#reconcileWriteFailure();
      throw error;
    }

    // account an object before any receipt race or failure can return
    this.#applyCreatedAllocation(objectCreated, false, prepared, receiptBytes, blockSize);

    let receiptCreated;

    try {
      receiptCreated = await writeOrVerifyReceipt(
        receiptPath,
        receiptBytes,
        prepared,
        this.#options.writeExclusive,
      );
    } catch (error) {
      // retain an orphan immutable object as an explicit gap
      if (objectCreated) {
        this.#status.asyncGaps += 1;
      }
      await this.#reconcileWriteFailure();
      throw error;
    }

    // a concurrent first writer may have bound a different object
    if (!receiptCreated) {
      const existing = await readReceipt(receiptPath, prepared.edgeReceiptIdentitySha256);

      if (existing.objectSha256 !== prepared.objectSha256) {
        this.#blockedIdentities.add(prepared.edgeReceiptIdentitySha256);
        this.#status.collisions += 1;
        this.#status.asyncGaps += 1;
        await this.#refreshAllocationFromDisk();
        return { status: "identity_collision" };
      }
    }

    this.#applyCreatedAllocation(
      false,
      receiptCreated,
      prepared,
      receiptBytes,
      blockSize,
    );

    // count only the writer that retained the first receipt
    if (receiptCreated) {
      // reconcile an object published by another writer after our last scan
      if (!objectCreated) {
        await this.#refreshAllocationFromDisk();
      }
      this.#status.finishedSuccesses += 1;
      this.#status.provenanceIncomplete += prepared.object.rows.length;
      await this.#commitChannelAssertion(prepared, receipt, receiptBytes, false);
      await this.#refreshAllocationFromDisk();
      return { status: "created" };
    }

    const existingBytes = await readRegularFile(receiptPath, RECEIPT_MAXIMUM_BYTES);
    const existingReceipt = parseReceipt(
      existingBytes,
      prepared.edgeReceiptIdentitySha256,
    );
    await this.#commitChannelAssertion(prepared, existingReceipt, existingBytes, true);
    await this.#refreshAllocationFromDisk();
    return { status: "duplicate" };
  }

  // bind the first trusted issuance channel without changing v1 bytes
  async #commitChannelAssertion(prepared, receipt, receiptBytes, receiptWasExisting) {
    // leave legacy callers byte-identical and unattributed
    if (prepared.issuanceChannel === undefined) {
      return;
    }

    requireIssuanceChannel(prepared.issuanceChannel);
    const bindingsPath = join(
      this.#options.root,
      "channel-bindings",
      `sha256-${prepared.edgeReceiptIdentitySha256}.json`,
    );
    const existingBinding = await readOptionalPrivateFile(bindingsPath, RECEIPT_MAXIMUM_BYTES);

    // preserve the first channel selected by trusted process state
    if (existingBinding !== null) {
      const binding = parseChannelBinding(
        existingBinding,
        prepared.edgeReceiptIdentitySha256,
      );
      const assertionBytes = await readRegularFile(
        join(this.#options.root, "channels", `sha256-${binding.assertionSha256}.json`),
        RECEIPT_MAXIMUM_BYTES,
      );
      const assertion = parseChannelAssertion(assertionBytes, binding.assertionSha256);

      // reject a binding substituted for another immutable receipt
      if (assertion.edgeReceiptIdentitySha256 !== prepared.edgeReceiptIdentitySha256 ||
        assertion.receiptSha256 !== sha256(receiptBytes) ||
        assertion.firstEdgeCommittedAt !== receipt.firstEdgeCommittedAt) {
        this.#status.channelCollisions += 1;
        throw new Error("adjustment evidence channel binding collision");
      }
      return;
    }

    const assertion = {
      channel: receiptWasExisting ? "legacy_unattributed" : prepared.issuanceChannel,
      contractVersion: ADJUSTMENT_EVIDENCE_CHANNEL_CONTRACT_VERSION,
      edgeReceiptIdentitySha256: prepared.edgeReceiptIdentitySha256,
      firstEdgeCommittedAt: receipt.firstEdgeCommittedAt,
      receiptSha256: sha256(receiptBytes),
    };
    const assertionBytes = Buffer.from(`${canonicalJson(assertion)}\n`);

    // keep each closed assertion within the independent receipt ceiling
    if (assertionBytes.byteLength > 2_048) {
      throw objectTooLargeError();
    }

    const assertionSha256 = sha256(assertionBytes);
    const assertionPath = join(
      this.#options.root,
      "channels",
      `sha256-${assertionSha256}.json`,
    );
    const binding = {
      assertionSha256,
      contractVersion: "issuance-channel-binding/v2",
      edgeReceiptIdentitySha256: prepared.edgeReceiptIdentitySha256,
    };
    const bindingBytes = Buffer.from(`${canonicalJson(binding)}\n`);
    const [bindingNames, channelNames] = await Promise.all([
      readdir(join(this.#options.root, "channel-bindings")),
      readdir(join(this.#options.root, "channels")),
    ]);
    const assertionExists = await regularFileExists(assertionPath);

    // retain the exact bounded hot assertion ceiling without pruning
    if (bindingNames.length >= MAXIMUM_CHANNEL_ASSERTIONS ||
      (!assertionExists && channelNames.length >= MAXIMUM_CHANNEL_ASSERTIONS)) {
      this.#status.capacityExhausted += 1;
      throw new Error("adjustment evidence channel capacity is exhausted");
    }

    const filesystem = await this.#options.statfs(this.#options.root);
    const blockSize = Number(filesystem.bsize);
    const prospectiveBytes = (assertionExists
      ? 0
      : allocatedSize(assertionBytes.byteLength, blockSize)) +
      allocatedSize(bindingBytes.byteLength, blockSize);
    const freeBytes = Number(filesystem.bavail * filesystem.bsize);

    // preserve the immutable ledger allocation ceiling
    if (this.#allocatedBytes + prospectiveBytes > LEDGER_ALLOCATION_MAXIMUM_BYTES) {
      this.#status.capacityExhausted += 1;
      throw new Error("adjustment evidence channel capacity is exhausted");
    }

    // preserve the protected floor and next-capture reservation
    if (freeBytes - prospectiveBytes < ADJUSTMENT_EVIDENCE_SCHEDULER_REQUIRED_FREE_BYTES) {
      this.#status.freeSpaceRefusal += 1;
      throw new Error("adjustment evidence channel capacity is exhausted");
    }

    // preserve the shared free-inode floor for two new files
    if (Number(filesystem.ffree) < FREE_INODE_FLOOR) {
      this.#status.inodeRefusal += 1;
      throw new Error("adjustment evidence channel capacity is exhausted");
    }

    await writeOrVerifyImmutable(
      assertionPath,
      assertionBytes,
      2_048,
      this.#options.writeExclusive,
    );

    try {
      let created = true;

      try {
        await this.#options.writeExclusive(bindingsPath, bindingBytes);
      } catch (error) {
        // preserve a concurrently installed first trusted channel
        if (error?.code !== "EEXIST") {
          throw error;
        }
        created = false;
        const concurrentBytes = await readRegularFile(bindingsPath, RECEIPT_MAXIMUM_BYTES);
        const concurrent = parseChannelBinding(
          concurrentBytes,
          prepared.edgeReceiptIdentitySha256,
        );
        const concurrentAssertionBytes = await readRegularFile(
          join(this.#options.root, "channels", `sha256-${concurrent.assertionSha256}.json`),
          RECEIPT_MAXIMUM_BYTES,
        );
        const concurrentAssertion = parseChannelAssertion(
          concurrentAssertionBytes,
          concurrent.assertionSha256,
        );

        // reject only a binding for different immutable receipt bytes
        if (concurrentAssertion.receiptSha256 !== sha256(receiptBytes) ||
          concurrentAssertion.firstEdgeCommittedAt !== receipt.firstEdgeCommittedAt) {
          throw new Error("adjustment evidence channel binding collision");
        }
      }

      // count only one newly retained stable binding
      if (created) {
        this.#status.channelAssertions += 1;
      }
    } catch (error) {
      this.#status.channelCollisions += 1;
      throw error;
    }
  }

  // refresh global immutable allocation after a cross-writer observation
  async #refreshAllocationFromDisk() {
    const scan = await scanEvidenceDirectories(this.#options.root, false);
    this.#allocatedBytes = scan.allocatedBytes;
    this.#objectCount = scan.objectCount;
    this.#receiptCount = scan.receiptCount;
    this.#status.bytes = scan.allocatedBytes;
    this.#status.objects = scan.objectCount;
    this.#status.channelAssertions = scan.channelAssertionCount;
  }

  // account retained finals and stop further capture after a write fault
  async #reconcileWriteFailure() {
    try {
      await this.#refreshAllocationFromDisk();
    } finally {
      this.#initialized = false;
    }
  }

  // apply only allocations created by this process
  #applyCreatedAllocation(objectCreated, receiptCreated, prepared, receiptBytes, blockSize) {
    // update immutable object allocation once
    if (objectCreated) {
      this.#objectCount += 1;
      this.#allocatedBytes += allocatedSize(prepared.compressedObject.byteLength, blockSize);
    }

    // update immutable receipt allocation once
    if (receiptCreated) {
      this.#receiptCount += 1;
      this.#allocatedBytes += allocatedSize(receiptBytes.byteLength, blockSize);
    }

    this.#status.bytes = this.#allocatedBytes;
    this.#status.objects = this.#objectCount;
  }
}

// persist bounded scheduler restart state under the existing private root
export class AdjustmentEvidenceSchedulerStateStore {
  #root;

  // retain one injectable private state root
  constructor(options = {}) {
    this.#root = resolve(options.root ?? ADJUSTMENT_EVIDENCE_DEFAULT_ROOT);
  }

  // create only the unprivileged scheduler state directory
  async initialize() {
    const path = join(this.#root, "scheduler");
    await requirePrivateDirectory(this.#root);
    await ensurePrivateDirectory(path);
    return this;
  }

  // recover current or previous validated state after a torn replacement
  async read() {
    let invalidObserved = false;

    for (const name of ["current.json", "previous.json"]) {
      try {
        const bytes = await readPrivateFileIfPresent(join(this.#root, "scheduler", name), 1_024 * 1_024);

        // continue to the older slot only when the newer slot is absent
        if (bytes === null) {
          continue;
        }
        return validateSchedulerState(JSON.parse(bytes.toString("utf8")));
      } catch {
        // try the previous complete slot after one invalid current slot
        invalidObserved = true;
      }
    }

    // never reset a known corrupt durable history to an empty state
    if (invalidObserved) {
      throw new Error("adjustment evidence scheduler state is invalid");
    }
    return createSchedulerState();
  }

  // rotate current to previous and fsync one bounded replacement
  async write(state) {
    validateSchedulerState(state);
    const directory = join(this.#root, "scheduler");
    const currentPath = join(directory, "current.json");
    const previousPath = join(directory, "previous.json");
    const current = await readPrivateFileIfPresent(currentPath, 1_024 * 1_024);

    // preserve the last complete generation before replacement
    if (current !== null) {
      try {
        validateSchedulerState(JSON.parse(current.toString("utf8")));
        await writeAtomicPrivate(previousPath, current);
      } catch {
        // preserve the existing previous slot instead of rotating corruption
      }
    }
    await writeAtomicPrivate(currentPath, Buffer.from(`${canonicalJson(state)}\n`));
  }
}

// schedule traffic-independent trusted forecast captures
export class AdjustmentEvidenceScheduler {
  #admission = { active: false, reason: "not_initialized" };
  #options;
  #running = false;
  #state = createSchedulerState();
  #timer = null;

  // retain injectable clocks, timers, trigger and filesystem probes
  constructor(options = {}) {
    this.#options = {
      clearInterval: options.clearInterval ?? clearInterval,
      enabled: options.enabled === true,
      migrationReady: options.migrationReady === true,
      now: options.now ?? (() => new Date()),
      root: resolve(options.root ?? ADJUSTMENT_EVIDENCE_DEFAULT_ROOT),
      setInterval: options.setInterval ?? setInterval,
      stateStore: options.stateStore ?? new AdjustmentEvidenceSchedulerStateStore({
        root: options.root,
      }),
      statfs: options.statfs ?? ((path) => statfs(path, { bigint: true })),
      trigger: options.trigger ?? (async () => {
        throw new Error("scheduler trigger is unavailable");
      }),
    };
  }

  // recover durable status and evaluate every activation gate
  async initialize() {
    try {
      await this.#options.stateStore.initialize();
      this.#state = await this.#options.stateStore.read();
      this.#admission = await evaluateAdjustmentEvidenceSchedulerAdmission({
        enabled: this.#options.enabled,
        migrationReady: this.#options.migrationReady,
        now: this.#options.now(),
        root: this.#options.root,
        statfs: this.#options.statfs,
      });
      this.#state = {
        ...this.#state,
        activation: this.#admission.reason,
        updatedAt: this.#options.now().toISOString(),
      };
      await this.#options.stateStore.write(this.#state);
    } catch {
      // keep normal forecast serving available when scheduler state refuses
      this.#admission = { active: false, reason: "state_unavailable" };
      this.#state = {
        ...createSchedulerState(),
        activation: "state_unavailable",
        updatedAt: this.#options.now().toISOString(),
      };
    }
    return this;
  }

  // expose one immutable bounded health projection
  status() {
    return Object.freeze({
      ...this.#state,
      attempts: Object.freeze(this.#state.attempts.map((entry) => Object.freeze({ ...entry }))),
      errors: Object.freeze(this.#state.errors.map((entry) => Object.freeze({ ...entry }))),
      gaps: Object.freeze(this.#state.gaps.map((entry) => Object.freeze({ ...entry }))),
    });
  }

  // run at most one current or catch-up due key
  async runDue() {
    // serialize timer and startup ticks without creating a request backlog
    if (this.#running) {
      return { status: "already_running" };
    }
    this.#running = true;

    try {
      const now = this.#options.now();
      const nowIso = now.toISOString();

      // remain truthfully inactive until all controller gates pass
      if (!this.#admission.active) {
        return { status: this.#admission.reason };
      }

      // refuse a wall-clock rollback instead of backdating a capture
      if (this.#state.lastCheckedAt !== null &&
        now.getTime() < Date.parse(this.#state.lastCheckedAt)) {
        return { status: "clock_rollback" };
      }

      const due = currentAdjustmentEvidenceDue(now);

      // stop permanently at the finite capture boundary
      if (due === null && now.getTime() >= Date.parse(ADJUSTMENT_EVIDENCE_CAPTURE_END)) {
        // persist the terminal boundary only once
        if (this.#state.activation !== "capture_ended") {
          await this.#persistStatus("capture_ended", nowIso);
        }
        this.#admission = { active: false, reason: "capture_ended" };
        this.stop();
        return { status: "capture_ended" };
      }

      // wait without traffic when the next jittered due is still future
      if (due === null) {
        return { status: "waiting" };
      }

      const priorAttempt = this.#state.attempts.find(
        // recognize one already terminal due key
        (entry) => entry.dueKey === due.dueKey,
      );

      // never issue the same durable due key twice after restart
      if (priorAttempt !== undefined) {
        return { status: "current_already_processed", dueKey: due.dueKey };
      }

      const gaps = missedAdjustmentEvidenceDueKeys(
        this.#state.lastCheckedAt,
        now,
        due.dueKey,
      ).map(
        // record every skipped cycle categorically without backdating capture
        (dueKey) => ({ dueKey, occurredAt: nowIso, reason: "missed_capture" }),
      );
      this.#state = {
        ...this.#state,
        gaps: retainSchedulerHistory([...this.#state.gaps, ...gaps]),
      };

      try {
        const result = await this.#options.trigger({
          channel: "scheduler_request",
          commitAt: nowIso,
          dueKey: due.dueKey,
          path: "/api/v1/sites/ballydidean/forecast?days=10",
        });
        const attempt = {
          committedAt: nowIso,
          dueKey: due.dueKey,
          status: normalizeSchedulerTriggerStatus(result),
        };
        this.#state = {
          ...this.#state,
          activation: "active",
          attempts: retainSchedulerHistory([...this.#state.attempts, attempt]),
          lastCheckedAt: nowIso,
          updatedAt: nowIso,
        };
        await this.#options.stateStore.write(this.#state);
        return { ...attempt, scheduledAt: due.scheduledAt };
      } catch (error) {
        const failure = {
          at: nowIso,
          code: boundedErrorCode(error),
          dueKey: due.dueKey,
        };
        this.#state = {
          ...this.#state,
          attempts: retainSchedulerHistory([...this.#state.attempts, {
            committedAt: nowIso,
            dueKey: due.dueKey,
            status: "capture_failed",
          }]),
          errors: retainSchedulerHistory([...this.#state.errors, failure]),
          gaps: retainSchedulerHistory([...this.#state.gaps, {
            dueKey: due.dueKey,
            occurredAt: nowIso,
            reason: "capture_failed",
          }]),
          lastCheckedAt: nowIso,
          updatedAt: nowIso,
        };
        await this.#options.stateStore.write(this.#state);
        return { status: "capture_failed", dueKey: due.dueKey };
      }
    } finally {
      this.#running = false;
    }
  }

  // start one immediate restart reconciliation and periodic clock tick
  start() {
    // keep inactive units compiled but timer-free
    if (!this.#admission.active || this.#timer !== null) {
      return false;
    }

    void this.runDue().catch(
      // contain scheduler persistence faults outside request serving
      () => undefined,
    );
    this.#timer = this.#options.setInterval(
      // poll the clock independently of public traffic
      () => void this.runDue().catch(
        // contain later scheduler persistence faults outside request serving
        () => undefined,
      ),
      SCHEDULER_POLL_MILLISECONDS,
    );
    this.#timer.unref?.();
    return true;
  }

  // stop only this process-local clock timer
  stop() {
    // clear only an installed scheduler timer
    if (this.#timer !== null) {
      this.#options.clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  // persist one non-capture scheduler status transition
  async #persistStatus(activation, updatedAt) {
    this.#state = {
      ...this.#state,
      activation: activation === "capture_ended" ? activation : this.#admission.reason,
      lastCheckedAt: updatedAt,
      updatedAt,
    };
    await this.#options.stateStore.write(this.#state);
  }
}

// move acknowledged scheduler evidence through two bounded online slots
export class AdjustmentEvidenceArchiveTransport {
  #now;
  #ports;
  #root;

  // retain only injectable clocks and the existing private evidence root
  constructor(options = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#root = resolve(options.root ?? ADJUSTMENT_EVIDENCE_DEFAULT_ROOT);
    this.#ports = options.ports ?? new AdjustmentCyclePageDiskPorts({
      now: this.#now,
      root: this.#root,
      statfs: options.statfs,
    });
  }

  // initialize the fixed online page directories without activating capture
  async initialize() {
    await this.#ports.initialize();
    return this;
  }

  // append one already committed trusted scheduler projection without blocking serving
  async captureCommittedSchedulerEvidence(input) {
    requireExactKeys(input, ["dueKey", "prepared"], "archive capture input");
    requireSchedulerDueKey(input.dueKey);
    const identitySha256 = requireSha256(
      input.prepared?.edgeReceiptIdentitySha256,
      "prepared.edgeReceiptIdentitySha256",
    );

    // refuse any caller-selected or legacy channel at the archive boundary
    if (input.prepared?.issuanceChannel !== "scheduler_request") {
      throw new TypeError("archive capture issuance channel is invalid");
    }

    try {
      return await withArchiveTransportLock(this.#root, this.#now, async () => {
        const payload = await readCommittedSchedulerPayload(this.#root, input.prepared);
        const current = await this.#ports.readSlot("current");

        // never reuse one pending slot for a later due cycle
        if (current !== null && current.header.dueKey !== input.dueKey) {
          return await this.#recordGap(input.dueKey, identitySha256, "slot_unavailable");
        }

        // make an exact post-crash retry a no-op instead of a second projection
        if (current !== null && current.projections.some(
          // match the stable committed receipt identity
          (projection) => projection.identitySha256 === identitySha256,
        )) {
          // bind retry success to the exact original payload
          if (current.header.payloadSha256 !== sha256(payload)) {
            return await this.#recordGap(input.dueKey, identitySha256, "archive_refused");
          }
          return { servingBlocked: false, status: "page_pending_acknowledgement" };
        }

        const generation = current?.header.generation ??
          String(Date.parse(input.dueKey.slice(8)));
        const finalized = await this.#ports.findFinalManifest(input.dueKey, generation);

        // never backfill or reopen an already finalized causal cycle
        if (finalized !== null) {
          return await this.#recordGap(input.dueKey, identitySha256, "archive_refused");
        }

        const state = await this.#recoverOpenState(input.dueKey, current);
        return await appendCyclePageFailOpen(state, {
          payload,
          projections: [{ channel: "scheduler_request", identitySha256 }],
        }, this.#ports);
      });
    } catch {
      // retain an honest permanent gap while normal forecasts remain successful
      return await this.#recordGap(input.dueKey, identitySha256, "archive_refused");
    }
  }

  // return only the current validated page or one canonical idle marker
  async next() {
    return await withArchiveTransportLock(this.#root, this.#now, async () => {
      await this.#recoverAcknowledgedFinals();
      const pendingFinal = await this.#ports.nextPendingFinalManifest();

      // transfer one genuine immutable cycle closure before later online pages
      if (pendingFinal !== null) {
        return Object.freeze({
          contractVersion: ADJUSTMENT_ARCHIVE_TRANSFER_CONTRACT_VERSION,
          kind: "final",
          manifest: pendingFinal.manifest,
          manifestSha256: pendingFinal.manifestSha256,
        });
      }

      const current = await this.#recoverCurrentSlot();

      // disclose no mutable state when no page awaits acknowledgement
      if (current === null) {
        return Object.freeze({
          contractVersion: ADJUSTMENT_ARCHIVE_TRANSFER_CONTRACT_VERSION,
          kind: "idle",
        });
      }

      const envelope = {
        contractVersion: ADJUSTMENT_ARCHIVE_TRANSFER_CONTRACT_VERSION,
        kind: "page",
        header: current.header,
        pageSha256: current.pageSha256,
        projections: current.projections,
        payloadBase64: current.payload.toString("base64"),
      };
      const bytes = Buffer.from(`${canonicalJson(envelope)}\n`);

      // enforce the closed SSH response ceiling before returning any bytes
      if (bytes.byteLength > ARCHIVE_TRANSFER_MAXIMUM_BYTES) {
        throw new Error("archive transfer envelope is too large");
      }
      return Object.freeze(envelope);
    });
  }

  // bind one page to the workstation open-cycle checkpoint before reusing its slot
  async acknowledge(pageSha256, checkpointSha256) {
    requireSha256(pageSha256, "pageSha256");
    requireSha256(checkpointSha256, "checkpointSha256");

    return await withArchiveTransportLock(this.#root, this.#now, async () => {
      const existing = await this.#ports.readTransferAcknowledgement(pageSha256);
      let acknowledgement = existing;

      // preserve the first fsynced workstation checkpoint for this page
      if (existing !== null) {
        if (existing.checkpointSha256 !== checkpointSha256) {
          throw new Error("archive acknowledgement collision");
        }
      } else {
        const current = await this.#ports.readSlot("current");

        // accept a new acknowledgement only for the exact pending current page
        if (current === null || current.pageSha256 !== pageSha256) {
          throw new Error("archive acknowledgement page is not pending");
        }
        acknowledgement = {
          acknowledgedAt: this.#now().toISOString(),
          contractVersion: "adjustment-archive-transfer-ack/v1",
          checkpointSha256,
          header: current.header,
          pageSha256,
          payloadLength: current.payload.length,
          projections: current.projections,
        };
        await this.#ports.persistTransferAcknowledgement(acknowledgement);
      }

      const current = await this.#ports.readSlot("current");

      // finish a crash-interrupted slot release using the original server clock
      if (current !== null && current.pageSha256 === pageSha256) {
        const pageAcknowledgement = {
          acknowledgedAt: acknowledgement.acknowledgedAt,
          contractVersion: "adjustment-cycle-page-ack/v1",
          dueKey: current.header.dueKey,
          generation: current.header.generation,
          pageIndex: current.header.pageIndex,
          pageSha256,
        };
        await this.#ports.persistAcknowledgement({
          acknowledgement: pageAcknowledgement,
          acknowledgementSha256: sha256(
            Buffer.from(`${canonicalJson(pageAcknowledgement)}\n`),
          ),
          nextSlots: (await this.#ports.readSlot("next")) === null ? [] : [{}],
        });
      } else if (current === null) {
        // finish a crash-interrupted next-slot promotion before returning the retry
        await this.#recoverCurrentSlot();
      }
      await this.#recoverAcknowledgedFinals();
      return Object.freeze({ ...acknowledgement });
    });
  }

  // bind one genuine final manifest to its first fully verified cold graph
  async acknowledgeFinal(manifestSha256, graphSha256) {
    requireSha256(manifestSha256, "manifestSha256");
    requireSha256(graphSha256, "graphSha256");

    return await withArchiveTransportLock(this.#root, this.#now, async () => {
      const existing = await this.#ports.readFinalAcknowledgement(manifestSha256);

      // preserve the first final graph binding on exact retries
      if (existing !== null) {
        if (existing.graphSha256 !== graphSha256) {
          throw new Error("archive final acknowledgement collision");
        }
        return Object.freeze({ ...existing });
      }

      await this.#recoverAcknowledgedFinals();
      const final = await this.#ports.nextPendingFinalManifest();

      // accept T only for the exact oldest genuine pending final manifest
      if (final === null || final.manifestSha256 !== manifestSha256) {
        throw new Error("archive final manifest is not pending");
      }
      const acknowledgement = {
        acknowledgedAt: this.#now().toISOString(),
        contractVersion: "adjustment-archive-final-ack/v1",
        graphSha256,
        manifestSha256,
      };
      await this.#ports.persistFinalAcknowledgement(acknowledgement);
      return Object.freeze(acknowledgement);
    });
  }

  // recover the bounded same-cycle metadata needed for one append
  async #recoverOpenState(dueKey, current) {
    const generation = current?.header.generation ?? String(Date.parse(dueKey.slice(8)));
    const state = createCyclePageState({
      dailyPageCount: Number(dueKey.slice(19, 21)) / 6,
      dueKey,
      generation,
      localDate: dueKey.slice(8, 18),
    });

    // start a fresh chain only when neither physical slot exists
    if (current === null) {
      const next = await this.#ports.readSlot("next");

      if (next !== null) {
        throw new Error("archive next slot has no current predecessor");
      }
      return state;
    }

    const next = await this.#ports.readSlot("next");
    const durablePages = [current, next].filter(
      // keep only existing physical slots in exact order
      (page) => page !== null,
    ).map(
      // reduce the validated transport page to durable chain metadata
      (page) => ({
        pageIndex: page.header.pageIndex,
        pageSha256: page.pageSha256,
        predecessorPageSha256: page.header.predecessorPageSha256,
        payloadSha256: page.header.payloadSha256,
        payloadOffset: page.header.payloadOffset,
        payloadLength: page.payload.length,
        projectionIdentities: page.projections.map(
          // retain the ordered stable projection identity
          (projection) => projection.identitySha256,
        ),
        projectionChannels: page.projections.map(
          // retain the ordered trusted projection channel
          (projection) => projection.channel,
        ),
      }),
    );
    return reconcileCyclePages({
      durable: { acknowledgements: [], finalized: null, gaps: [], pages: durablePages },
      expected: state,
    }).state;
  }

  // promote only a next page whose predecessor has an exact durable checkpoint
  async #recoverCurrentSlot() {
    const current = await this.#ports.readSlot("current");

    // return the ordinary complete state without filesystem mutation
    if (current !== null) {
      return current;
    }

    const next = await this.#ports.readSlot("next");

    // return the stable empty state when no crash promotion remains
    if (next === null) {
      return null;
    }

    const predecessor = next.header.predecessorPageSha256;

    // refuse an orphaned next slot without a durable predecessor acknowledgement
    if (predecessor === null ||
      await this.#ports.readTransferAcknowledgement(predecessor) === null) {
      throw new Error("archive next slot predecessor is not acknowledged");
    }
    await this.#ports.promoteNext();
    return await this.#ports.readSlot("current");
  }

  // finalize each crash-recoverable scheduler cycle after every page acknowledgement
  async #recoverAcknowledgedFinals() {
    const acknowledgements = await this.#ports.listTransferAcknowledgements();
    const groups = new Map();

    // group bounded checkpoint metadata by the exact due and generation identity
    for (const transfer of acknowledgements) {
      const key = `${transfer.header.dueKey}\u0000${transfer.header.generation}`;
      const group = groups.get(key) ?? [];
      group.push(transfer);
      groups.set(key, group);
    }

    const current = await this.#ports.readSlot("current");
    const next = await this.#ports.readSlot("next");

    // recover each finite scheduler-only cycle independently
    for (const transfers of groups.values()) {
      transfers.sort(
        // reconstruct exact page order from checkpointed indices
        (left, right) => left.header.pageIndex - right.header.pageIndex,
      );
      const first = transfers[0];

      // leave organic cycles open for a future explicit closure protocol
      if (transfers.some(
        // require every checkpointed projection to be trusted scheduler evidence
        (transfer) => transfer.projections.some(
          // reject any organic projection from implicit closure
          (projection) => projection.channel !== "scheduler_request",
        ),
      )) {
        continue;
      }

      const existing = await this.#ports.findFinalManifest(
        first.header.dueKey,
        first.header.generation,
      );

      // retain the already immutable final manifest without rewriting it
      if (existing !== null) {
        continue;
      }

      const slotStillOpen = [current, next].some(
        // keep the cycle open until every physical page is acknowledged
        (page) => page !== null && page.header.dueKey === first.header.dueKey &&
          page.header.generation === first.header.generation,
      );

      // never close a cycle while current or next still retains one of its pages
      if (slotStillOpen) {
        continue;
      }

      const pageAcknowledgements = [];

      // recover every durable page acknowledgement in exact page order
      for (const transfer of transfers) {
        const pageAcknowledgement = await this.#ports.readPageAcknowledgement(
          transfer.pageSha256,
        );

        // wait until every page-protocol acknowledgement is durable after a crash
        if (pageAcknowledgement === null) {
          break;
        }
        pageAcknowledgements.push(pageAcknowledgement);
      }

      // refuse closure over a partial acknowledgement prefix
      if (pageAcknowledgements.length !== transfers.length) {
        continue;
      }

      const gaps = await this.#ports.readEvidenceGaps(
        first.header.dueKey,
        first.header.generation,
      );
      const pages = transfers.map(
        // restore exact bounded page metadata without retaining payload bytes
        (transfer) => ({
          pageIndex: transfer.header.pageIndex,
          pageSha256: transfer.pageSha256,
          predecessorPageSha256: transfer.header.predecessorPageSha256,
          payloadSha256: transfer.header.payloadSha256,
          payloadOffset: transfer.header.payloadOffset,
          payloadLength: transfer.payloadLength,
          projectionIdentities: transfer.projections.map(
            // retain exact checkpointed projection identities
            (projection) => projection.identitySha256,
          ),
          projectionChannels: transfer.projections.map(
            // retain exact checkpointed trusted channels
            (projection) => projection.channel,
          ),
        }),
      );
      const state = {
        contractVersion: "adjustment-cycle-page-state/v1",
        dueKey: first.header.dueKey,
        generation: first.header.generation,
        localDate: first.header.dueKey.slice(8, 18),
        dailyPageCountAtOpen: Number(first.header.dueKey.slice(19, 21)) / 6,
        pages,
        acknowledgements: pageAcknowledgements,
        gaps,
        slots: [],
        organicProjectionCount: 0,
        schedulerProjectionCount: transfers.reduce(
          // count every checkpointed scheduler projection exactly once
          (total, transfer) => total + transfer.projections.length,
          0,
        ),
        finalized: null,
      };
      await finalizeCyclePages(state, {
        finalizedAt: pageAcknowledgements.at(-1).acknowledgedAt,
      }, this.#ports);
    }
  }

  // fsync one forever-unqualified projection without delaying serving
  async #recordGap(dueKey, identitySha256, reason) {
    try {
      // reuse the first categorical gap without relabelling its occurrence clock
      if (await this.#ports.hasEvidenceGap(dueKey, identitySha256)) {
        return { servingBlocked: false, status: "evidence_gap" };
      }
      const state = createCyclePageState({
        dailyPageCount: Number(dueKey.slice(19, 21)) / 6,
        dueKey,
        generation: String(Date.parse(dueKey.slice(8))),
        localDate: dueKey.slice(8, 18),
      });
      await recordEvidenceGap(state, {
        occurredAt: this.#now().toISOString(),
        projectionIdentitySha256: identitySha256,
        reason,
      }, this.#ports);
      return { servingBlocked: false, status: "evidence_gap" };
    } catch {
      return {
        reason,
        servingBlocked: false,
        status: "evidence_gap_persistence_refused",
      };
    }
  }
}

// persist current and next online page slots below the evidence root
export class AdjustmentCyclePageDiskPorts {
  #now;
  #root;
  #statfs;

  // retain one existing evidence-volume root without path overrides
  constructor(options = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#root = resolve(options.root ?? ADJUSTMENT_EVIDENCE_DEFAULT_ROOT);
    this.#statfs = options.statfs ?? ((path) => statfs(path, { bigint: true }));
  }

  // provide one injected clock for fail-open gap evidence
  now() {
    return this.#now();
  }

  // create fixed private page-state directories only
  async initialize() {
    const root = join(this.#root, "online-pages");
    await requirePrivateDirectory(this.#root);
    await ensurePrivateDirectory(root);

    // create every bounded metadata class beneath the fixed root
    for (const name of [
      "acknowledgements",
      "archive-acknowledgements",
      "final-acknowledgements",
      "final-manifests",
      "gaps",
      "locks",
      "slots",
    ]) {
      await ensurePrivateDirectory(join(root, name));
    }
    return this;
  }

  // read one bounded slot without following links or accepting noncanonical metadata
  async readSlot(slotValue) {
    const slot = slotValue === "current" ? "current" : slotValue === "next" ? "next" : null;

    // reject caller-named slot paths
    if (slot === null) {
      throw new TypeError("online page slot is invalid");
    }

    let bytes;

    try {
      bytes = await readRegularFile(
        join(this.#root, "online-pages", "slots", `${slot}.page`),
        320 * 1_024,
      );
    } catch (error) {
      // return only an actually absent slot as empty
      if (error?.code === "ENOENT") {
        return null;
      }
      throw error;
    }

    // reject short prefixes and unreasonable metadata lengths before parsing
    if (bytes.byteLength < 5) {
      throw new Error("online page slot is truncated");
    }
    const metadataLength = bytes.readUInt32BE(0);
    const metadataEnd = 4 + metadataLength;

    // bind metadata and payload within the fixed page ceiling
    if (metadataLength < 2 || metadataLength > 32 * 1_024 || metadataEnd >= bytes.byteLength) {
      throw new Error("online page slot metadata is invalid");
    }
    const metadataBytes = bytes.subarray(4, metadataEnd);
    const metadata = JSON.parse(metadataBytes.toString("utf8"));

    // require the exact canonical metadata encoding written by persistPage
    if (!metadataBytes.equals(Buffer.from(`${canonicalJson(metadata)}\n`))) {
      throw new Error("online page slot metadata is not canonical");
    }
    return validateCyclePage({
      header: metadata.header,
      pageSha256: metadata.pageSha256,
      payload: bytes.subarray(metadataEnd),
      projections: metadata.projections,
    });
  }

  // fsync one exclusive current or next page slot
  async persistPage(input) {
    const slot = input.slot === "current" ? "current" : input.slot === "next" ? "next" : null;

    // refuse a third or caller-named slot
    if (slot === null) {
      throw new TypeError("online page slot is invalid");
    }
    const metadata = Buffer.from(`${canonicalJson({
      header: input.header,
      pageSha256: input.pageSha256,
      projections: input.projections,
    })}\n`);
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(metadata.byteLength);
    const bytes = Buffer.concat([prefix, metadata, Buffer.from(input.payload)]);
    await this.#admit(bytes.byteLength, 1);
    await writeOrVerifyImmutable(
      join(this.#root, "online-pages", "slots", `${slot}.page`),
      bytes,
      320 * 1_024,
      writeExclusive,
    );
    return { fsynced: true, pageSha256: input.pageSha256 };
  }

  // read one first-writer checkpoint acknowledgement by exact page identity
  async readTransferAcknowledgement(pageSha256) {
    requireSha256(pageSha256, "pageSha256");
    const path = join(
      this.#root,
      "online-pages",
      "archive-acknowledgements",
      `sha256-${pageSha256}.json`,
    );
    let bytes;

    try {
      bytes = await readRegularFile(path, 2_048);
    } catch (error) {
      // return only a genuinely absent acknowledgement as missing
      if (error?.code === "ENOENT") {
        return null;
      }
      throw error;
    }
    const value = JSON.parse(bytes.toString("utf8"));
    requireExactKeys(value, [
      "acknowledgedAt",
      "checkpointSha256",
      "contractVersion",
      "header",
      "pageSha256",
      "payloadLength",
      "projections",
    ], "archive transfer acknowledgement");
    requireEqual(
      value.contractVersion,
      "adjustment-archive-transfer-ack/v1",
      "archive transfer acknowledgement contractVersion",
    );
    requireEqual(value.pageSha256, pageSha256, "archive transfer acknowledgement pageSha256");
    requireSha256(
      value.checkpointSha256,
      "archive transfer acknowledgement checkpointSha256",
    );
    requireInstant(value.acknowledgedAt, "archive transfer acknowledgement acknowledgedAt");
    validateTransferCheckpointMetadata(value);

    // require exact canonical bytes for every idempotent retry
    if (!bytes.equals(Buffer.from(`${canonicalJson(value)}\n`))) {
      throw new Error("archive transfer acknowledgement is not canonical");
    }
    return value;
  }

  // fsync the first workstation open-cycle checkpoint before releasing its page slot
  async persistTransferAcknowledgement(acknowledgement) {
    requireExactKeys(acknowledgement, [
      "acknowledgedAt",
      "checkpointSha256",
      "contractVersion",
      "header",
      "pageSha256",
      "payloadLength",
      "projections",
    ], "archive transfer acknowledgement");
    requireEqual(
      acknowledgement.contractVersion,
      "adjustment-archive-transfer-ack/v1",
      "archive transfer acknowledgement contractVersion",
    );
    validateTransferCheckpointMetadata(acknowledgement);
    requireSha256(
      acknowledgement.checkpointSha256,
      "archive transfer acknowledgement checkpointSha256",
    );
    requireInstant(
      acknowledgement.acknowledgedAt,
      "archive transfer acknowledgement acknowledgedAt",
    );
    const bytes = Buffer.from(`${canonicalJson(acknowledgement)}\n`);
    await this.#admit(bytes.byteLength, 1);
    const path = join(
      this.#root,
      "online-pages",
      "archive-acknowledgements",
      `sha256-${acknowledgement.pageSha256}.json`,
    );
    await writeOrVerifyImmutable(path, bytes, 2_048, writeExclusive);
    return { fsynced: true, pageSha256: acknowledgement.pageSha256 };
  }

  // list the finite validated page checkpoints for crash reconciliation
  async listTransferAcknowledgements() {
    const directory = join(this.#root, "online-pages", "archive-acknowledgements");
    const names = (await readdir(directory)).sort();

    // refuse an unexpected lifetime checkpoint spool
    if (names.length > 8_192) {
      throw new Error("archive checkpoint history exceeds its bound");
    }

    const acknowledgements = [];

    // validate every content-addressed checkpoint before reconstruction
    for (const name of names) {
      const match = /^sha256-([a-f0-9]{64})\.json$/u.exec(name);

      // reject foreign files in the fixed owner-private directory
      if (match === null) {
        throw new Error("archive checkpoint filename is invalid");
      }
      acknowledgements.push(await this.readTransferAcknowledgement(match[1]));
    }
    return acknowledgements;
  }

  // find the durable page-protocol acknowledgement for one transferred page
  async readPageAcknowledgement(pageSha256) {
    requireSha256(pageSha256, "pageSha256");
    const directory = join(this.#root, "online-pages", "acknowledgements");
    const names = (await readdir(directory)).sort();

    // retain a finite restart scan for the fixed capture horizon
    if (names.length > 8_192) {
      throw new Error("page acknowledgement history exceeds its bound");
    }

    // inspect each canonical acknowledgement until its page identity matches
    for (const name of names) {
      const match = /^sha256-([a-f0-9]{64})\.json$/u.exec(name);

      // reject foreign files in the fixed metadata directory
      if (match === null) {
        throw new Error("page acknowledgement filename is invalid");
      }
      const bytes = await readRegularFile(join(directory, name), 2_048);
      const value = JSON.parse(bytes.toString("utf8"));

      // bind exact canonical acknowledgement bytes to their filename
      if (!bytes.equals(Buffer.from(`${canonicalJson(value)}\n`)) ||
        sha256(bytes) !== match[1]) {
        throw new Error("page acknowledgement is invalid");
      }
      requireExactKeys(value, [
        "acknowledgedAt",
        "contractVersion",
        "dueKey",
        "generation",
        "pageIndex",
        "pageSha256",
      ], "page acknowledgement");
      requireEqual(
        value.contractVersion,
        ADJUSTMENT_CYCLE_ACK_CONTRACT_VERSION,
        "page acknowledgement contractVersion",
      );
      requireSchedulerDueKey(value.dueKey);
      requireSha256(value.pageSha256, "page acknowledgement pageSha256");
      requireInstant(value.acknowledgedAt, "page acknowledgement acknowledgedAt");

      // retain exact unsigned generation and bounded page index fields
      if (!/^(?:0|[1-9][0-9]*)$/u.test(value.generation) ||
        BigInt(value.generation) > 0xffff_ffff_ffff_ffffn ||
        !Number.isSafeInteger(value.pageIndex) || value.pageIndex < 0 ||
        value.pageIndex >= ADJUSTMENT_CYCLE_MAXIMUM_PAGES) {
        throw new Error("page acknowledgement fields are invalid");
      }

      // return only the requested page's closed acknowledgement schema
      if (value.pageSha256 === pageSha256) {
        return { ...value, acknowledgementSha256: match[1] };
      }
    }
    return null;
  }

  // fsync acknowledgement before releasing and rotating one page slot
  async persistAcknowledgement(input) {
    const bytes = Buffer.from(`${canonicalJson(input.acknowledgement)}\n`);
    await this.#admit(bytes.byteLength, 1);
    await writeOrVerifyImmutable(
      join(this.#root, "online-pages", "acknowledgements", `sha256-${input.acknowledgementSha256}.json`),
      bytes,
      2_048,
      writeExclusive,
    );
    const slots = join(this.#root, "online-pages", "slots");
    const current = await this.readSlot("current");

    // unlink only the exact page bound by the durable acknowledgement
    if (current !== null && current.pageSha256 === input.acknowledgement.pageSha256) {
      await unlink(join(slots, "current.page"));
    } else if (current !== null && current.header.predecessorPageSha256 !==
      input.acknowledgement.pageSha256) {
      throw new Error("online page acknowledgement slot collision");
    }

    // promote only an already durable next slot
    if (input.nextSlots.length === 1 && await this.readSlot("current") === null) {
      try {
        await rename(join(slots, "next.page"), join(slots, "current.page"));
      } catch (error) {
        // accept only a retry after the next slot was already promoted
        if (error?.code !== "ENOENT" || await this.readSlot("current") === null) {
          throw error;
        }
      }
    }
    await fsyncDirectory(slots);
    return { acknowledgementSha256: input.acknowledgementSha256, fsynced: true };
  }

  // promote one crash-left next slot after its predecessor acknowledgement is proven
  async promoteNext() {
    const slots = join(this.#root, "online-pages", "slots");
    const current = await this.readSlot("current");

    // avoid replacing any already published current page
    if (current !== null) {
      throw new Error("online current page already exists");
    }
    await rename(join(slots, "next.page"), join(slots, "current.page"));
    await fsyncDirectory(slots);
  }

  // fsync one immutable categorical gap
  async persistGap(input) {
    const bytes = Buffer.from(`${canonicalJson(input.gap)}\n`);
    await this.#admit(bytes.byteLength, 1);
    await writeExclusive(
      join(this.#root, "online-pages", "gaps", `sha256-${input.gapSha256}.json`),
      bytes,
    );
    return { fsynced: true, gapSha256: input.gapSha256 };
  }

  // find one prior immutable gap without creating a second occurrence for retries
  async hasEvidenceGap(dueKey, projectionIdentitySha256) {
    requireSchedulerDueKey(dueKey);
    requireSha256(projectionIdentitySha256, "projectionIdentitySha256");
    return (await this.#listEvidenceGaps()).some(
      // reuse only the first exact due and stable projection identity
      (value) => value.dueKey === dueKey &&
        value.projectionIdentitySha256 === projectionIdentitySha256,
    );
  }

  // return every durable permanent gap belonging to one exact cycle
  async readEvidenceGaps(dueKey, generation) {
    requireSchedulerDueKey(dueKey);
    return (await this.#listEvidenceGaps()).filter(
      // retain only gaps bound to the finalizing cycle identity
      (value) => value.dueKey === dueKey && value.generation === generation,
    );
  }

  // fsync one immutable final cycle manifest
  async persistFinalManifest(input) {
    const bytes = Buffer.from(`${canonicalJson(input.manifest)}\n`);
    await this.#admit(bytes.byteLength, 1);
    await writeOrVerifyImmutable(
      join(this.#root, "online-pages", "final-manifests", `sha256-${input.manifestSha256}.json`),
      bytes,
      32 * 1_024,
      writeExclusive,
    );
    return { fsynced: true, manifestSha256: input.manifestSha256 };
  }

  // read one exact immutable final manifest by content identity
  async readFinalManifest(manifestSha256) {
    requireSha256(manifestSha256, "manifestSha256");
    let bytes;

    try {
      bytes = await readRegularFile(
        join(
          this.#root,
          "online-pages",
          "final-manifests",
          `sha256-${manifestSha256}.json`,
        ),
        32 * 1_024,
      );
    } catch (error) {
      // return only an actually absent final manifest as missing
      if (error?.code === "ENOENT") {
        return null;
      }
      throw error;
    }
    const manifest = JSON.parse(bytes.toString("utf8"));
    validateCycleFinalManifest(manifest);

    // bind exact canonical manifest bytes to the requested identity
    if (!bytes.equals(Buffer.from(`${canonicalJson(manifest)}\n`)) ||
      sha256(bytes) !== manifestSha256) {
      throw new Error("archive final manifest is invalid");
    }
    return { manifest, manifestSha256 };
  }

  // find one immutable closure for the exact due and generation pair
  async findFinalManifest(dueKey, generation) {
    const manifests = await this.#listFinalManifests();
    return manifests.find(
      // match the exact online cycle identity
      (entry) => entry.manifest.dueKey === dueKey &&
        entry.manifest.generation === generation,
    ) ?? null;
  }

  // return the oldest finalized cycle without a cold-graph acknowledgement
  async nextPendingFinalManifest() {
    const manifests = await this.#listFinalManifests();
    manifests.sort(
      // retain deterministic cycle order across restarts
      (left, right) => left.manifest.dueKey.localeCompare(right.manifest.dueKey, "en"),
    );

    // choose only the first final without a T receipt
    for (const manifest of manifests) {
      if (await this.readFinalAcknowledgement(manifest.manifestSha256) === null) {
        return manifest;
      }
    }
    return null;
  }

  // read one immutable final cold-graph receipt
  async readFinalAcknowledgement(manifestSha256) {
    requireSha256(manifestSha256, "manifestSha256");
    let bytes;

    try {
      bytes = await readRegularFile(
        join(
          this.#root,
          "online-pages",
          "final-acknowledgements",
          `sha256-${manifestSha256}.json`,
        ),
        2_048,
      );
    } catch (error) {
      // return only an absent final acknowledgement as missing
      if (error?.code === "ENOENT") {
        return null;
      }
      throw error;
    }
    const value = JSON.parse(bytes.toString("utf8"));
    validateFinalTransferAcknowledgement(value, manifestSha256);

    // require canonical first-writer bytes on every retry
    if (!bytes.equals(Buffer.from(`${canonicalJson(value)}\n`))) {
      throw new Error("archive final acknowledgement is not canonical");
    }
    return value;
  }

  // fsync the first full cold-graph binding for one final manifest
  async persistFinalAcknowledgement(acknowledgement) {
    validateFinalTransferAcknowledgement(
      acknowledgement,
      acknowledgement.manifestSha256,
    );
    const bytes = Buffer.from(`${canonicalJson(acknowledgement)}\n`);
    await this.#admit(bytes.byteLength, 1);
    await writeOrVerifyImmutable(
      join(
        this.#root,
        "online-pages",
        "final-acknowledgements",
        `sha256-${acknowledgement.manifestSha256}.json`,
      ),
      bytes,
      2_048,
      writeExclusive,
    );
    return { fsynced: true, manifestSha256: acknowledgement.manifestSha256 };
  }

  // list each finite validated final manifest for transfer ordering
  async #listFinalManifests() {
    const directory = join(this.#root, "online-pages", "final-manifests");
    const names = (await readdir(directory)).sort();

    // refuse an unexpected lifetime manifest spool
    if (names.length > 8_192) {
      throw new Error("archive final manifest history exceeds its bound");
    }

    const manifests = [];

    // validate every content-addressed final before returning it
    for (const name of names) {
      const match = /^sha256-([a-f0-9]{64})\.json$/u.exec(name);

      // reject foreign files in the fixed final directory
      if (match === null) {
        throw new Error("archive final manifest filename is invalid");
      }
      manifests.push(await this.readFinalManifest(match[1]));
    }
    return manifests;
  }

  // list each bounded canonical permanent gap for retry and finalization
  async #listEvidenceGaps() {
    const directory = join(this.#root, "online-pages", "gaps");
    const names = (await readdir(directory)).sort();

    // refuse an unexpected unbounded gap directory instead of scanning forever
    if (names.length > 8_192) {
      throw new Error("online page gap history exceeds its bound");
    }

    const gaps = [];

    // inspect every bounded canonical gap in content-address order
    for (const name of names) {
      const match = /^sha256-([a-f0-9]{64})\.json$/u.exec(name);

      // reject foreign files in the owner-private fixed directory
      if (match === null) {
        throw new Error("online page gap filename is invalid");
      }
      const bytes = await readRegularFile(join(directory, name), 2_048);
      const value = JSON.parse(bytes.toString("utf8"));
      requireExactKeys(value, [
        "contractVersion",
        "dueKey",
        "generation",
        "projectionIdentitySha256",
        "reason",
        "occurredAt",
        "qualificationDisposition",
      ], "online page gap");
      requireEqual(
        value.contractVersion,
        ADJUSTMENT_EVIDENCE_GAP_CONTRACT_VERSION,
        "online page gap contractVersion",
      );
      requireSchedulerDueKey(value.dueKey);
      requireSha256(value.projectionIdentitySha256, "online page gap projection identity");
      requireInstant(value.occurredAt, "online page gap occurredAt");

      // retain only the page protocol's closed permanent-gap categories
      if (![
        "archive_refused",
        "capacity_refused",
        "page_limit",
        "projection_limit",
        "slot_unavailable",
        "transport_refused",
        "unacknowledged",
      ].includes(value.reason) || value.qualificationDisposition !== "forever_unqualified" ||
        !/^(?:0|[1-9][0-9]*)$/u.test(value.generation)) {
        throw new Error("online page gap fields are invalid");
      }

      // bind canonical bytes and the content-addressed filename
      if (!bytes.equals(Buffer.from(`${canonicalJson(value)}\n`)) ||
        sha256(bytes) !== match[1]) {
        throw new Error("online page gap is invalid");
      }
      gaps.push({ ...value, gapSha256: match[1] });
    }
    return gaps;
  }

  // preserve the protected floor, capture reservation and inodes before each write
  async #admit(byteLength, files) {
    const filesystem = await this.#statfs(this.#root);
    const blockSize = Number(filesystem.bsize);
    const freeInodes = Number(filesystem.ffree);
    const prospectiveBytes = allocatedSize(byteLength, blockSize);
    const freeBytes = Number(filesystem.bavail * filesystem.bsize);

    // refuse without deleting or reusing any acknowledged history
    if (!Number.isSafeInteger(blockSize) || blockSize < 1 ||
      !Number.isSafeInteger(freeBytes) || !Number.isSafeInteger(freeInodes) ||
      freeBytes - prospectiveBytes < ADJUSTMENT_EVIDENCE_SCHEDULER_REQUIRED_FREE_BYTES ||
      freeInodes - files < FREE_INODE_FLOOR) {
      const error = new Error("online page capacity is exhausted");
      error.code = "resource_refused";
      throw error;
    }
  }
}

// validate one deleted-payload checkpoint without fabricating page bytes
function validateTransferCheckpointMetadata(value) {
  requireSha256(value.pageSha256, "archive transfer acknowledgement pageSha256");
  const header = value.header;
  requireExactKeys(header, [
    "contractVersion",
    "dueKey",
    "generation",
    "pageIndex",
    "predecessorPageSha256",
    "payloadSha256",
    "payloadOffset",
  ], "archive transfer acknowledgement header");
  requireEqual(
    header.contractVersion,
    ADJUSTMENT_CYCLE_PAGE_CONTRACT_VERSION,
    "archive transfer acknowledgement page contractVersion",
  );
  requireSchedulerDueKey(header.dueKey);
  requireSha256(header.payloadSha256, "archive transfer acknowledgement payloadSha256");

  // retain the exact unsigned generation and online page bounds
  if (!/^(?:0|[1-9][0-9]*)$/u.test(header.generation) ||
    BigInt(header.generation) > 0xffff_ffff_ffff_ffffn ||
    !Number.isSafeInteger(header.pageIndex) || header.pageIndex < 0 ||
    header.pageIndex >= ADJUSTMENT_CYCLE_MAXIMUM_PAGES ||
    !Number.isSafeInteger(header.payloadOffset) || header.payloadOffset < 0 ||
    !Number.isSafeInteger(value.payloadLength) || value.payloadLength < 1 ||
    value.payloadLength > ADJUSTMENT_CYCLE_PAGE_PAYLOAD_BYTES) {
    throw new TypeError("archive transfer acknowledgement page bounds are invalid");
  }

  // preserve genesis and predecessor-chain header consistency
  if (header.predecessorPageSha256 !== null) {
    requireSha256(
      header.predecessorPageSha256,
      "archive transfer acknowledgement predecessorPageSha256",
    );
  }
  if ((header.pageIndex === 0 &&
      (header.predecessorPageSha256 !== null || header.payloadOffset !== 0)) ||
    (header.pageIndex > 0 && header.predecessorPageSha256 === null)) {
    throw new TypeError("archive transfer acknowledgement predecessor is invalid");
  }

  // require one bounded closed projection list
  if (!Array.isArray(value.projections) || value.projections.length < 1 ||
    value.projections.length > ADJUSTMENT_DAILY_MAXIMUM_PROJECTIONS) {
    throw new TypeError("archive transfer acknowledgement projections are invalid");
  }
  const identities = new Set();

  // validate every exact checkpointed projection identity and channel
  for (const projection of value.projections) {
    requireExactKeys(projection, ["channel", "identitySha256"], "archive projection");
    requireSha256(projection.identitySha256, "archive projection identitySha256");

    // reject unknown channels and duplicate stable projection identities
    if ((projection.channel !== "scheduler_request" && projection.channel !== "organic") ||
      identities.has(projection.identitySha256)) {
      throw new TypeError("archive projection is invalid");
    }
    identities.add(projection.identitySha256);
  }
}

// validate one first-writer genuine final cold-graph receipt
function validateFinalTransferAcknowledgement(value, expectedManifestSha256) {
  requireExactKeys(value, [
    "acknowledgedAt",
    "contractVersion",
    "graphSha256",
    "manifestSha256",
  ], "archive final acknowledgement");
  requireEqual(
    value.contractVersion,
    "adjustment-archive-final-ack/v1",
    "archive final acknowledgement contractVersion",
  );
  requireEqual(
    value.manifestSha256,
    expectedManifestSha256,
    "archive final acknowledgement manifestSha256",
  );
  requireSha256(value.graphSha256, "archive final acknowledgement graphSha256");
  requireInstant(value.acknowledgedAt, "archive final acknowledgement acknowledgedAt");
}

// package the exact committed C metadata and value object bytes into one page payload
async function readCommittedSchedulerPayload(root, prepared) {
  requireSha256(prepared.objectSha256, "prepared.objectSha256");
  const objectGzipBytes = await readRegularFile(
    evidenceObjectPath(root, prepared.objectSha256),
    COMPRESSED_OBJECT_MAXIMUM_BYTES,
  );
  const objectBytes = gunzipBounded(objectGzipBytes);

  // bind the durable compressed member to the exact prepared canonical object
  if (sha256(objectBytes) !== prepared.objectSha256 ||
    !objectBytes.equals(Buffer.from(canonicalJson(prepared.object))) ||
    !gzipSync(objectBytes, { level: 9, mtime: 0 }).equals(objectGzipBytes)) {
    throw new Error("committed scheduler object is invalid");
  }
  validateEvidenceObject(prepared.object);

  const receiptBytes = await readRegularFile(
    evidenceReceiptPath(root, prepared.edgeReceiptIdentitySha256),
    RECEIPT_MAXIMUM_BYTES,
  );
  const receipt = parseReceipt(receiptBytes, prepared.edgeReceiptIdentitySha256);

  // bind the stable receipt to the exact transferred object
  if (receipt.objectSha256 !== prepared.objectSha256 ||
    !receiptBytes.equals(Buffer.from(`${canonicalJson(receipt)}\n`))) {
    throw new Error("committed scheduler receipt is invalid");
  }

  const bindingBytes = await readRegularFile(
    join(
      root,
      "channel-bindings",
      `sha256-${prepared.edgeReceiptIdentitySha256}.json`,
    ),
    RECEIPT_MAXIMUM_BYTES,
  );
  const binding = parseChannelBinding(bindingBytes, prepared.edgeReceiptIdentitySha256);
  const assertionBytes = await readRegularFile(
    join(root, "channels", `sha256-${binding.assertionSha256}.json`),
    RECEIPT_MAXIMUM_BYTES,
  );
  const assertion = parseChannelAssertion(assertionBytes, binding.assertionSha256);

  // archive only an assertion selected by the trusted scheduler request map
  if (assertion.channel !== "scheduler_request" ||
    assertion.receiptSha256 !== sha256(receiptBytes)) {
    throw new Error("committed scheduler channel is invalid");
  }

  const payload = {
    channelAssertionBase64: assertionBytes.toString("base64"),
    channelAssertionSha256: binding.assertionSha256,
    channelBindingBase64: bindingBytes.toString("base64"),
    channelBindingSha256: sha256(bindingBytes),
    contractVersion: "adjustment-evidence-page-payload/v1",
    edgeReceiptIdentitySha256: prepared.edgeReceiptIdentitySha256,
    objectGzipBase64: objectGzipBytes.toString("base64"),
    objectGzipSha256: sha256(objectGzipBytes),
    objectSha256: prepared.objectSha256,
    receiptBase64: receiptBytes.toString("base64"),
    receiptSha256: sha256(receiptBytes),
  };
  return Buffer.from(`${canonicalJson(payload)}\n`);
}

// serialize web capture and forced export operations through one expiring fixed-path lease
async function withArchiveTransportLock(root, now, operation) {
  const directory = join(root, "online-pages", "locks");
  const lockPath = join(directory, "transport.lock");
  const token = randomUUID();
  let acquired = false;
  const lease = {
    contractVersion: "adjustment-archive-lock/v1",
    expiresAt: new Date(now().getTime() + ARCHIVE_LOCK_LEASE_MILLISECONDS).toISOString(),
    token,
  };
  const leaseBytes = Buffer.from(`${canonicalJson(lease)}\n`);

  // wait only for the short bounded capture/export critical section
  for (let attempt = 0; attempt < ARCHIVE_LOCK_ATTEMPTS; attempt += 1) {
    try {
      const handle = await open(
        lockPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY |
          fsConstants.O_NOFOLLOW,
        0o600,
      );

      try {
        await handle.writeFile(leaseBytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fsyncDirectory(directory);
      acquired = true;
      break;
    } catch (error) {
      // fail immediately on every non-contention filesystem error
      if (error?.code !== "EEXIST") {
        throw error;
      }

      const expired = await archiveTransportLockExpired(lockPath, now());

      // atomically remove only an expired lease before retrying acquisition
      if (expired) {
        const stalePath = join(directory, `.stale-${randomUUID()}.lock`);

        try {
          await rename(lockPath, stalePath);
          await unlink(stalePath);
          await fsyncDirectory(directory);
        } catch (renameError) {
          // tolerate only a competing owner changing the fixed lease first
          if (renameError?.code !== "ENOENT") {
            throw renameError;
          }
        }
        continue;
      }

      // yield briefly without permitting an unbounded request backlog
      await new Promise(
        // resume one bounded lease acquisition attempt
        (resolveWait) => setTimeout(resolveWait, ARCHIVE_LOCK_RETRY_MILLISECONDS),
      );
    }
  }

  // refuse rather than bypass a live capture/export owner
  if (!acquired) {
    const error = new Error("archive transport is busy");
    error.code = "archive_busy";
    throw error;
  }

  try {
    return await operation();
  } finally {
    const current = await readRegularFile(lockPath, 2_048).catch(() => null);

    // release only the exact lease created by this operation
    if (current !== null && current.equals(leaseBytes)) {
      await unlink(lockPath);
      await fsyncDirectory(directory);
    }
  }
}

// classify a fixed lock as stale only after its complete lease or file age expires
async function archiveTransportLockExpired(path, nowValue) {
  try {
    const bytes = await readRegularFile(path, 2_048);
    const value = JSON.parse(bytes.toString("utf8"));

    // accept only one complete canonical lease when trusting its expiry
    if (value?.contractVersion === "adjustment-archive-lock/v1" &&
      typeof value.token === "string" && /^[a-f0-9-]{36}$/u.test(value.token) &&
      typeof value.expiresAt === "string" &&
      bytes.equals(Buffer.from(`${canonicalJson(value)}\n`)) &&
      Number.isFinite(Date.parse(value.expiresAt))) {
      return Date.parse(value.expiresAt) <= nowValue.getTime();
    }
  } catch {
    // use age only for an incomplete crash-left lease
  }

  const details = await lstat(path);
  return details.mtimeMs + ARCHIVE_LOCK_LEASE_MILLISECONDS <= nowValue.getTime();
}

// calculate the latest eligible jittered due key
export function currentAdjustmentEvidenceDue(nowValue) {
  const now = new Date(nowValue);

  // reject invalid clocks and stop at the finite boundary
  if (!Number.isFinite(now.getTime()) || now.getTime() >= Date.parse(ADJUSTMENT_EVIDENCE_CAPTURE_END)) {
    return null;
  }

  const candidates = adjustmentEvidenceDueCandidates(now);

  // choose only one current due cycle within the catch-up window
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    const scheduledTime = Date.parse(candidate.scheduledAt);

    // return the newest due instant and never replay older backlog
    if (scheduledTime <= now.getTime() && now.getTime() - scheduledTime <= SCHEDULER_CATCHUP_MILLISECONDS) {
      return Object.freeze(candidate);
    }
  }
  return null;
}

// evaluate the controller, migration, expiry and measured capacity gates
export async function evaluateAdjustmentEvidenceSchedulerAdmission(input) {
  // require explicit controller activation first
  if (input.enabled !== true) {
    return Object.freeze({ active: false, reason: "controller_inactive" });
  }

  // require the data-plane migration before claiming v2 capture
  if (input.migrationReady !== true) {
    return Object.freeze({ active: false, reason: "migration_unavailable" });
  }

  const now = new Date(input.now);

  // close the finite capture window permanently
  if (!Number.isFinite(now.getTime()) || now.getTime() >= Date.parse(ADJUSTMENT_EVIDENCE_CAPTURE_END)) {
    return Object.freeze({ active: false, reason: "capture_ended" });
  }

  try {
    const filesystem = await input.statfs(input.root);
    const freeBytes = Number(filesystem.bavail * filesystem.bsize);

    // require the protected floor plus one complete next-capture reservation
    if (!Number.isSafeInteger(freeBytes) ||
      freeBytes < ADJUSTMENT_EVIDENCE_SCHEDULER_REQUIRED_FREE_BYTES ||
      Number(filesystem.ffree) < FREE_INODE_FLOOR) {
      return Object.freeze({ active: false, freeBytes, reason: "capacity_blocked" });
    }
    return Object.freeze({ active: true, freeBytes, reason: "active" });
  } catch {
    return Object.freeze({ active: false, reason: "capacity_unavailable" });
  }
}

// normalize only supported direct forecast GET query shapes
export function normalizeAdjustmentEvidenceWindow(requestUrl) {
  const entries = [...requestUrl.searchParams.entries()];

  // retain the dedicated overnight query
  if (entries.length === 1 && entries[0][0] === "window" && entries[0][1] === "overnight") {
    return "overnight";
  }

  // treat the API's empty query as its one-day default
  if (entries.length === 0) {
    return "days=1";
  }

  // retain one reviewed daily query only
  if (entries.length === 1 && entries[0][0] === "days" &&
    ["1", "5", "10"].includes(entries[0][1])) {
    return `days=${entries[0][1]}`;
  }

  return null;
}

// create one deterministic object and its stable identity
export function createAdjustmentEvidenceCapture(filteredBody, window) {
  return createAdjustmentEvidenceCaptureVersion(filteredBody, window, {
    contractVersion: ADJUSTMENT_EVIDENCE_OBJECT_CONTRACT_VERSION,
    maximumRows: MAXIMUM_ROWS,
  });
}

// create one v2 object that admits the fall-back DST row
export function createAdjustmentEvidenceCaptureV2(filteredBody, window) {
  return createAdjustmentEvidenceCaptureVersion(filteredBody, window, {
    contractVersion: ADJUSTMENT_EVIDENCE_OBJECT_V2_CONTRACT_VERSION,
    maximumRows: MAXIMUM_V2_ROWS,
  });
}

// create one versioned deterministic object and stable receipt identity
function createAdjustmentEvidenceCaptureVersion(filteredBody, window, version) {
  if (!WINDOWS.includes(window)) {
    throw new TypeError("adjustment evidence window is invalid");
  }

  const forecast = JSON.parse(Buffer.from(filteredBody).toString("utf8"));

  // require one successful filtered forecast envelope
  if (forecast === null || typeof forecast !== "object" || !Array.isArray(forecast.data) ||
    forecast.data.length < 1 || forecast.data.length > version.maximumRows) {
    throw new TypeError("forecast evidence body is invalid");
  }

  const settingsSha256 = sha256(canonicalJson(forecast.adjustmentSettings));
  const bundleIdentities = projectBundleIdentities(forecast);
  const availability = projectAvailability(forecast.data);
  const rows = forecast.data.map(
    // preserve response order for row-to-availability joins
    (row) => projectEvidenceRow(row),
  );
  const object = {
    bundleIdentities,
    contractVersion: version.contractVersion,
    rows,
    settingsSha256,
    siteKey: "ballydidean",
    window,
  };
  const canonicalObject = Buffer.from(canonicalJson(object));

  // bound canonical bytes before compression
  if (canonicalObject.byteLength > OBJECT_MAXIMUM_BYTES) {
    throw objectTooLargeError();
  }

  const compressedObject = gzipSync(canonicalObject, { level: 9, mtime: 0 });

  // reject oversized or suspiciously compressed objects
  if (compressedObject.byteLength > COMPRESSED_OBJECT_MAXIMUM_BYTES ||
    canonicalObject.byteLength > compressedObject.byteLength * MAXIMUM_COMPRESSION_RATIO) {
    throw objectTooLargeError();
  }

  const stableIdentity = {
    bundleIdentities,
    rows: rows.map(
      // exclude all scoring values from the stable record identity
      (row) => ({ record: row.record, source: row.source }),
    ),
    settingsSha256,
    siteKey: "ballydidean",
    window,
  };

  return Object.freeze({
    availability,
    compressedObject,
    edgeReceiptIdentitySha256: sha256(canonicalJson(stableIdentity)),
    object,
    objectSha256: sha256(canonicalObject),
  });
}

// freeze and validate every receipt selected at snapshot start
export async function freezeAdjustmentEvidenceSnapshot(options = {}) {
  const root = resolve(options.root ?? ADJUSTMENT_EVIDENCE_DEFAULT_ROOT);
  const now = options.now ?? (() => new Date());
  await validateEvidenceDirectories(root);
  const receiptDirectory = join(root, "receipts");
  const names = (await readdir(receiptDirectory)).sort();

  // reject unbounded or unexpected receipt directory contents
  if (names.length > MAXIMUM_IDENTITIES || names.some((name) => !RECEIPT_FILENAME_PATTERN.test(name))) {
    throw new Error("adjustment evidence receipt directory is invalid");
  }

  const entries = [];

  // validate the frozen list without observing later receipts
  for (const name of names) {
    const identity = RECEIPT_FILENAME_PATTERN.exec(name)?.[1];
    const receiptPath = evidenceReceiptPath(root, identity);
    const receipt = await readReceipt(receiptPath, identity);
    const objectPath = evidenceObjectPath(root, receipt.objectSha256);
    const objectBytes = await readRegularFile(
      objectPath,
      COMPRESSED_OBJECT_MAXIMUM_BYTES,
    );
    const canonicalObject = gunzipBounded(objectBytes);

    // bind compressed bytes to the content-addressed canonical object
    if (sha256(canonicalObject) !== receipt.objectSha256) {
      throw new Error("adjustment evidence object hash is invalid");
    }

    const object = JSON.parse(canonicalObject.toString("utf8"));
    validateEvidenceObject(object);

    // require canonical deterministic content at the export boundary
    if (!Buffer.from(canonicalJson(object)).equals(canonicalObject) ||
      !gzipSync(canonicalObject, { level: 9, mtime: 0 }).equals(objectBytes)) {
      throw new Error("adjustment evidence object encoding is invalid");
    }

    // bind row availability and stable identity to the selected object
    if (receiptAvailability(receipt).rowTimestampIndexes.length !== object.rows.length ||
      stableIdentitySha256(object) !== identity ||
      receipt.window !== object.window ||
      receipt.contractVersion !== receiptVersionForObject(object.contractVersion)) {
      throw new Error("adjustment evidence receipt pairing is invalid");
    }
    entries.push({
      edgeReceiptIdentitySha256: identity,
      objectPath,
      objectSha256: receipt.objectSha256,
      receiptPath,
    });
  }

  const watermarkSha256 = sha256(canonicalJson(entries.map(
    // exclude host paths from the portable watermark
    (entry) => ({
      edgeReceiptIdentitySha256: entry.edgeReceiptIdentitySha256,
      objectSha256: entry.objectSha256,
    }),
  )));
  return Object.freeze({
    contractVersion: ADJUSTMENT_EVIDENCE_SNAPSHOT_CONTRACT_VERSION,
    entries: Object.freeze(entries),
    frozenAt: now().toISOString(),
    watermarkSha256,
  });
}

// create the first-observed availability receipt
function createReceipt(prepared, firstEdgeCommittedAt) {
  // encode v2 availability compactly without changing v1 receipt bytes
  if (prepared.object.contractVersion === ADJUSTMENT_EVIDENCE_OBJECT_V2_CONTRACT_VERSION) {
    const availabilityBytes = Buffer.from(canonicalJson(prepared.availability));
    return {
      availabilityGzipBase64: gzipSync(availabilityBytes, { level: 9, mtime: 0 }).toString("base64"),
      contractVersion: ADJUSTMENT_EVIDENCE_RECEIPT_V2_CONTRACT_VERSION,
      edgeReceiptIdentitySha256: prepared.edgeReceiptIdentitySha256,
      firstEdgeCommittedAt,
      objectSha256: prepared.objectSha256,
      siteKey: "ballydidean",
      window: prepared.object.window,
    };
  }

  return {
    availability: prepared.availability,
    contractVersion: ADJUSTMENT_EVIDENCE_RECEIPT_CONTRACT_VERSION,
    edgeReceiptIdentitySha256: prepared.edgeReceiptIdentitySha256,
    firstEdgeCommittedAt,
    objectSha256: prepared.objectSha256,
    siteKey: "ballydidean",
    window: prepared.object.window,
  };
}

// retain only active response-level serving identities
function projectBundleIdentities(forecast) {
  return {
    rain: {
      activeBundle: nullableSha256(forecast.rainAdjustmentRuntime?.activeBundle),
    },
    temperature: {
      activeBundle: nullableSha256(forecast.temperatureAdjustmentRuntime?.activeBundle),
      authorizationSha256: nullableSha256(
        forecast.temperatureAdjustmentRuntime?.authorizationSha256,
      ),
    },
    wind: {
      activeBundle: nullableSha256(forecast.adjustmentRuntime?.activeBundle),
      authorizationSha256: nullableSha256(forecast.adjustmentRuntime?.authorizationSha256),
      candidateArtifactSha256: nullableSha256(
        forecast.adjustmentRuntime?.candidateArtifactSha256,
      ),
    },
  };
}

// group mutable first-observed timestamps by ordered row index
function projectAvailability(rows) {
  const indexes = new Map();
  const timestamps = [];
  const rowTimestampIndexes = rows.map(
    // retain each distinct mutable timestamp only once
    (row) => {
      requireInstant(row?.receivedAt, "row.receivedAt");
      let index = indexes.get(row.receivedAt);

      // add one first-seen canonical timestamp
      if (index === undefined) {
        index = timestamps.length;
        indexes.set(row.receivedAt, index);
        timestamps.push(row.receivedAt);
      }

      return index;
    },
  );
  return { rowTimestampIndexes, timestamps };
}

// project one closed scoring row without volatile response metadata
function projectEvidenceRow(row) {
  if (row === null || typeof row !== "object") {
    throw new TypeError("forecast evidence row is invalid");
  }

  return {
    provenanceComplete: false,
    rainAdjustment: projectRainAdjustment(row.rainAdjustment),
    raw: projectMetricValues(row.metrics, RAW_METRICS, "row.metrics"),
    record: {
      id: requireBoundedString(row.id, "row.id"),
      productRunAt: nullableInstant(row.productRunAt, "row.productRunAt"),
      revisionCount: requireRevisionCount(row.revisionCount),
      validAt: instant(row.validAt, "row.validAt"),
    },
    source: {
      dataset: nullableBoundedString(row.metadata?.provider?.dataset, "row.metadata.provider.dataset"),
      providerKey: requireBoundedString(row.provenance?.providerKey, "row.provenance.providerKey"),
      sourceId: requireBoundedString(row.provenance?.sourceId, "row.provenance.sourceId"),
      sourceKey: requireBoundedString(row.provenance?.sourceKey, "row.provenance.sourceKey"),
      upstreamModel: nullableBoundedString(row.metadata?.upstream?.model, "row.metadata.upstream.model"),
    },
    temperatureAdjustment: projectTemperatureAdjustment(row.temperatureAdjustment),
    windAdjustment: projectWindAdjustment(row.adjustment),
  };
}

// retain post-settings generic decision fields only
function projectWindAdjustment(value) {
  const decision = requireDecision(value, "row.adjustment");
  const adjustedMetrics = projectMetricValues(
    decision.adjustedMetrics ?? {},
    ADJUSTED_METRICS,
    "row.adjustment.adjustedMetrics",
    true,
  );
  return {
    adjustedMetrics,
    appliedMetrics: requireStringArray(decision.appliedMetrics ?? [], "row.adjustment.appliedMetrics"),
    authorizationSha256: nullableSha256(decision.authorizationSha256),
    candidateArtifactSha256: nullableSha256(decision.candidateArtifactSha256),
    leadBand: nullableBoundedString(decision.leadBand, "row.adjustment.leadBand"),
    reasonCode: nullableBoundedString(decision.reasonCode, "row.adjustment.reasonCode"),
    state: requireState(decision.state, "row.adjustment.state", WIND_DECISION_STATES),
  };
}

// retain temperature amount, reason and immutable source receipt fields
function projectTemperatureAdjustment(value) {
  const decision = requireDecision(value, "row.temperatureAdjustment");
  return {
    branch: nullableBoundedString(decision.branch, "row.temperatureAdjustment.branch"),
    bundleSha256: nullableSha256(decision.bundleSha256),
    correctedTemperatureC: nullableFinite(
      decision.correctedTemperatureC,
      "row.temperatureAdjustment.correctedTemperatureC",
    ),
    rawBestMatchTemperatureC: nullableFinite(
      decision.rawBestMatchTemperatureC,
      "row.temperatureAdjustment.rawBestMatchTemperatureC",
    ),
    reasonCode: nullableBoundedString(
      decision.reasonCode,
      "row.temperatureAdjustment.reasonCode",
    ),
    sourceForecast: projectTemperatureSource(decision.sourceForecast),
    state: requireState(decision.state, "row.temperatureAdjustment.state", SOURCE_DECISION_STATES),
  };
}

// retain only the closed temperature source forecast
function projectTemperatureSource(value) {
  if (value === null || value === undefined) {
    return null;
  }

  requirePlainObject(value, "row.temperatureAdjustment.sourceForecast");
  return {
    adapterVersion: requireBoundedString(value.adapterVersion, "temperature.source.adapterVersion"),
    dataset: requireBoundedString(value.dataset, "temperature.source.dataset"),
    firstReceivedAt: instant(value.firstReceivedAt, "temperature.source.firstReceivedAt"),
    modelCycle: requireBoundedString(value.modelCycle, "temperature.source.modelCycle"),
    modelLeadHours: requireBoundedInteger(value.modelLeadHours, "temperature.source.modelLeadHours"),
    operationalHorizonHours: requireBoundedInteger(
      value.operationalHorizonHours,
      "temperature.source.operationalHorizonHours",
    ),
    providerKey: requireBoundedString(value.providerKey, "temperature.source.providerKey"),
    providerResponseSha256: requireSha256(value.providerResponseSha256, "temperature.source.providerResponseSha256"),
    rawRelativeHumidityPercent: nullableFinite(value.rawRelativeHumidityPercent, "temperature.source.rawRelativeHumidityPercent"),
    rawTemperatureC: finite(value.rawTemperatureC, "temperature.source.rawTemperatureC"),
    rawWindSpeedMps: nullableFinite(value.rawWindSpeedMps, "temperature.source.rawWindSpeedMps"),
    runInitializedAt: instant(value.runInitializedAt, "temperature.source.runInitializedAt"),
    upstreamModel: requireBoundedString(value.upstreamModel, "temperature.source.upstreamModel"),
    validAt: instant(value.validAt, "temperature.source.validAt"),
  };
}

// retain rain amount, reason and immutable source receipt fields
function projectRainAdjustment(value) {
  const decision = requireDecision(value, "row.rainAdjustment");
  return {
    bundleSha256: nullableSha256(decision.bundleSha256),
    correctedPrecipitationMm: nullableFinite(
      decision.correctedPrecipitationMm,
      "row.rainAdjustment.correctedPrecipitationMm",
    ),
    rawBestMatchPrecipitationMm: nullableFinite(
      decision.rawBestMatchPrecipitationMm,
      "row.rainAdjustment.rawBestMatchPrecipitationMm",
    ),
    reasonCode: nullableBoundedString(decision.reasonCode, "row.rainAdjustment.reasonCode"),
    sourceForecast: projectRainSource(decision.sourceForecast),
    state: requireState(decision.state, "row.rainAdjustment.state", SOURCE_DECISION_STATES),
  };
}

// retain only the closed rain source forecast
function projectRainSource(value) {
  if (value === null || value === undefined) {
    return null;
  }

  requirePlainObject(value, "row.rainAdjustment.sourceForecast");
  return {
    decisionAt: instant(value.decisionAt, "rain.source.decisionAt"),
    firstReceivedAt: instant(value.firstReceivedAt, "rain.source.firstReceivedAt"),
    modelLeadHours: requireBoundedInteger(value.modelLeadHours, "rain.source.modelLeadHours"),
    providerKey: requireBoundedString(value.providerKey, "rain.source.providerKey"),
    rawPrecipitationMm: finite(value.rawPrecipitationMm, "rain.source.rawPrecipitationMm"),
    runInitializedAt: instant(value.runInitializedAt, "rain.source.runInitializedAt"),
    upstreamModel: requireBoundedString(value.upstreamModel, "rain.source.upstreamModel"),
    validAt: instant(value.validAt, "rain.source.validAt"),
  };
}

// retain a fixed metric allowlist with nulls for absent raw values
function projectMetricValues(value, keys, path, omitAbsent = false) {
  requirePlainObject(value, path);
  const projected = {};

  // preserve the reviewed metric order
  for (const key of keys) {
    if (!omitAbsent || Object.hasOwn(value, key)) {
      projected[key] = nullableFinite(value[key] ?? null, `${path}.${key}`);
    }
  }

  return projected;
}

// scan bounded immutable directories and allocation
async function scanEvidenceDirectories(root, validatePairs) {
  await validateEvidenceDirectories(root);
  const objects = await readdir(join(root, "objects"));
  const receipts = await readdir(join(root, "receipts"));
  const channels = await readdir(join(root, "channels"));
  const channelBindings = await readdir(join(root, "channel-bindings"));

  // stop startup on unexpected or unbounded contents
  if (objects.length > MAXIMUM_IDENTITIES || receipts.length > MAXIMUM_IDENTITIES ||
    objects.some((name) => !OBJECT_FILENAME_PATTERN.test(name)) ||
    receipts.some((name) => !RECEIPT_FILENAME_PATTERN.test(name)) ||
    channels.length > MAXIMUM_CHANNEL_ASSERTIONS ||
    channelBindings.length > MAXIMUM_CHANNEL_ASSERTIONS ||
    channels.some((name) => !CHANNEL_FILENAME_PATTERN.test(name)) ||
    channelBindings.some((name) => !RECEIPT_FILENAME_PATTERN.test(name))) {
    throw new Error("adjustment evidence directory is invalid");
  }

  let allocatedBytes = 0;

  // count real allocation without following symlinks
  for (const [directory, names] of [
    ["objects", objects],
    ["receipts", receipts],
    ["channels", channels],
    ["channel-bindings", channelBindings],
  ]) {
    for (const name of names) {
      const details = await lstat(join(root, directory, name), { bigint: true });

      // reject links, devices and oversized files
      if (!details.isFile() || details.isSymbolicLink() ||
        (Number(details.mode) & 0o777) !== 0o600 ||
        details.size > BigInt(directory === "objects"
          ? COMPRESSED_OBJECT_MAXIMUM_BYTES
          : RECEIPT_MAXIMUM_BYTES)) {
        throw new Error("adjustment evidence entry is invalid");
      }

      allocatedBytes += Number(details.blocks * 512n);
    }
  }

  // reserve optional exhaustive validation for export
  if (validatePairs) {
    // validate every object, including a retained orphan from a failed receipt
    for (const name of objects) {
      const expectedSha256 = OBJECT_FILENAME_PATTERN.exec(name)?.[1];
      const bytes = await readRegularFile(
        join(root, "objects", name),
        COMPRESSED_OBJECT_MAXIMUM_BYTES,
      );
      const canonical = gunzipBounded(bytes);
      const object = JSON.parse(canonical.toString("utf8"));

      if (sha256(canonical) !== expectedSha256 ||
        !Buffer.from(canonicalJson(object)).equals(canonical) ||
        !gzipSync(canonical, { level: 9, mtime: 0 }).equals(bytes)) {
        throw new Error("adjustment evidence object is corrupt");
      }

      validateEvidenceObject(object);
    }

    // verify every content-addressed issuance-channel assertion
    for (const name of channels) {
      const expectedSha256 = CHANNEL_FILENAME_PATTERN.exec(name)?.[1];
      const bytes = await readRegularFile(join(root, "channels", name), RECEIPT_MAXIMUM_BYTES);
      parseChannelAssertion(bytes, expectedSha256);
    }

    // verify every stable binding and its exact assertion target
    for (const name of channelBindings) {
      const expectedIdentity = RECEIPT_FILENAME_PATTERN.exec(name)?.[1];
      const bytes = await readRegularFile(
        join(root, "channel-bindings", name),
        RECEIPT_MAXIMUM_BYTES,
      );
      const binding = parseChannelBinding(bytes, expectedIdentity);
      const assertionBytes = await readRegularFile(
        join(root, "channels", `sha256-${binding.assertionSha256}.json`),
        RECEIPT_MAXIMUM_BYTES,
      );
      const assertion = parseChannelAssertion(assertionBytes, binding.assertionSha256);
      const receiptBytes = await readRegularFile(
        evidenceReceiptPath(root, expectedIdentity),
        RECEIPT_MAXIMUM_BYTES,
      );
      const receipt = parseReceipt(receiptBytes, expectedIdentity);

      // bind the pointer filename to the assertion's stable receipt identity
      if (assertion.edgeReceiptIdentitySha256 !== expectedIdentity ||
        assertion.receiptSha256 !== sha256(receiptBytes) ||
        assertion.firstEdgeCommittedAt !== receipt.firstEdgeCommittedAt) {
        throw new Error("adjustment evidence channel pairing is invalid");
      }
    }

    await freezeAdjustmentEvidenceSnapshot({ root });
  }

  return {
    allocatedBytes,
    channelAssertionCount: channelBindings.length,
    objectCount: objects.length,
    receiptCount: receipts.length,
  };
}

// create fixed evidence directories and validate real paths
async function ensureEvidenceDirectories(root) {
  await ensurePrivateDirectory(root);

  // create only fixed private children beneath the validated real root
  for (const directory of ["objects", "receipts", "channels", "channel-bindings"]) {
    await ensurePrivateDirectory(join(root, directory));
  }
  await validateEvidenceDirectories(root);
}

// create one private directory without following or changing existing paths
async function ensurePrivateDirectory(path) {
  const parentPath = dirname(path);
  const canonicalParent = await realpath(parentPath);

  // reject configured ancestors that resolve through links
  if (canonicalParent !== resolve(parentPath)) {
    throw new Error("private directory parent is invalid");
  }

  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    // accept only an already existing path for exact validation
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }
  await requirePrivateDirectory(path, canonicalParent);
}

// require one real owner-private directory at its literal path
async function requirePrivateDirectory(path, expectedParent = null) {
  const details = await lstat(path);
  const canonicalPath = await realpath(path);

  // reject links, aliases and permissions not already owner-private
  if (!details.isDirectory() || details.isSymbolicLink() ||
    (details.mode & 0o777) !== 0o700 || canonicalPath !== resolve(path) ||
    (expectedParent !== null && dirname(canonicalPath) !== expectedParent)) {
    throw new Error("private directory is invalid");
  }
}

// reject directory links and path escapes
async function validateEvidenceDirectories(root) {
  const rootDetails = await lstat(root);

  // require a real private root directory
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink() ||
    (rootDetails.mode & 0o777) !== 0o700) {
    throw new Error("adjustment evidence root is invalid");
  }

  const canonicalRoot = await realpath(root);

  // bind both fixed child directories beneath the canonical root
  for (const directory of ["objects", "receipts", "channels", "channel-bindings"]) {
    const path = join(root, directory);
    const details = await lstat(path);
    const canonicalPath = await realpath(path);

    if (!details.isDirectory() || details.isSymbolicLink() ||
      (details.mode & 0o777) !== 0o700 ||
      dirname(canonicalPath) !== canonicalRoot) {
      throw new Error("adjustment evidence directory is invalid");
    }
  }
}

// create or verify one immutable content object
async function writeOrVerifyImmutable(path, bytes, maximumBytes, writer) {
  try {
    await writer(path, bytes);
    return true;
  } catch (error) {
    // verify an existing content-addressed object byte for byte
    if (error?.code !== "EEXIST") {
      throw error;
    }

    const existing = await readRegularFile(path, maximumBytes);

    if (!existing.equals(bytes)) {
      throw new Error("adjustment evidence object collision");
    }

    return false;
  }
}

// create or verify one exclusive stable-identity receipt
async function writeOrVerifyReceipt(path, bytes, prepared, writer) {
  try {
    await writer(path, bytes);
    return true;
  } catch (error) {
    // leave an existing first receipt authoritative
    if (error?.code !== "EEXIST") {
      throw error;
    }

    const existing = await readReceipt(path, prepared.edgeReceiptIdentitySha256);

    if (existing.objectSha256 !== prepared.objectSha256) {
      return false;
    }

    return false;
  }
}

// durably publish one complete private file through an exclusive hard link
async function writeExclusive(path, bytes) {
  const directoryPath = dirname(path);
  const temporaryPath = join(directoryPath, `.capture-${randomUUID()}.tmp`);
  let handle = await open(
    temporaryPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    0o600,
  );
  let linked = false;
  let temporaryExists = true;

  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await link(temporaryPath, path);
    linked = true;
    await unlink(temporaryPath);
    temporaryExists = false;

    const directory = await open(
      directoryPath,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );

    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    // close only the still-open private temporary handle
    if (handle !== null) {
      await handle.close().catch(() => undefined);
    }

    // remove only the uniquely named temporary created by this call
    if (temporaryExists) {
      try {
        await unlink(temporaryPath);
        temporaryExists = false;
      } catch (cleanupError) {
        // ignore only a path already removed by the publication flow
        if (cleanupError?.code !== "ENOENT") {
          error.adjustmentEvidenceTemporaryCleanupFailed = true;
        }
      }
    }

    // disclose only whether the complete final link exists for reconciliation
    if (linked) {
      error.adjustmentEvidenceFinalCreated = true;
    }
    throw error;
  }
}

// read and validate one first-issuance receipt
async function readReceipt(path, expectedIdentity) {
  const bytes = await readRegularFile(path, RECEIPT_MAXIMUM_BYTES);
  return parseReceipt(bytes, expectedIdentity);
}

// parse one receipt while preserving both exact reader contracts
function parseReceipt(bytes, expectedIdentity) {
  const value = JSON.parse(bytes.toString("utf8"));
  validateReceipt(value, expectedIdentity);

  // enforce the closed v2 receipt ceiling at every reader
  if (value.contractVersion === ADJUSTMENT_EVIDENCE_RECEIPT_V2_CONTRACT_VERSION &&
    bytes.byteLength > 2_048) {
    throw new TypeError("v2 receipt is too large");
  }
  return value;
}

// read one bounded regular file without following links
async function readRegularFile(path, maximumBytes) {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);

  try {
    const details = await handle.stat();

    if (!details.isFile() || (details.mode & 0o777) !== 0o600 ||
      details.size > maximumBytes) {
      throw new Error("adjustment evidence file is invalid");
    }

    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

// validate one receipt without accepting unknown fields
function validateReceipt(value, expectedIdentity) {
  const maximumRows = value.contractVersion === ADJUSTMENT_EVIDENCE_RECEIPT_CONTRACT_VERSION
    ? MAXIMUM_ROWS
    : value.contractVersion === ADJUSTMENT_EVIDENCE_RECEIPT_V2_CONTRACT_VERSION
      ? MAXIMUM_V2_ROWS
      : null;

  // accept only the immutable v1 and v2 receipt schemas
  if (maximumRows === null) {
    throw new TypeError("receipt.contractVersion is invalid");
  }

  // require the exact versioned receipt keys
  requireExactKeys(value, value.contractVersion === ADJUSTMENT_EVIDENCE_RECEIPT_V2_CONTRACT_VERSION
    ? [
        "availabilityGzipBase64",
        "contractVersion",
        "edgeReceiptIdentitySha256",
        "firstEdgeCommittedAt",
        "objectSha256",
        "siteKey",
        "window",
      ]
    : [
        "availability",
        "contractVersion",
        "edgeReceiptIdentitySha256",
        "firstEdgeCommittedAt",
        "objectSha256",
        "siteKey",
        "window",
      ], "receipt");
  requireEqual(value.edgeReceiptIdentitySha256, expectedIdentity, "receipt.edgeReceiptIdentitySha256");
  requireSha256(value.objectSha256, "receipt.objectSha256");
  requireInstant(value.firstEdgeCommittedAt, "receipt.firstEdgeCommittedAt");
  requireEqual(value.siteKey, "ballydidean", "receipt.siteKey");

  if (!WINDOWS.includes(value.window)) {
    throw new TypeError("receipt.window is invalid");
  }

  validateReceiptAvailability(receiptAvailability(value), maximumRows);
}

// recover one receipt's versioned availability projection
function receiptAvailability(receipt) {
  // preserve the exact readable v1 object
  if (receipt.contractVersion === ADJUSTMENT_EVIDENCE_RECEIPT_CONTRACT_VERSION) {
    return receipt.availability;
  }

  if (typeof receipt.availabilityGzipBase64 !== "string" ||
    receipt.availabilityGzipBase64.length > 2_048) {
    throw new TypeError("receipt availability encoding is invalid");
  }
  const compressed = Buffer.from(receipt.availabilityGzipBase64, "base64");

  // reject noncanonical base64 spellings
  if (compressed.toString("base64") !== receipt.availabilityGzipBase64) {
    throw new TypeError("receipt availability encoding is invalid");
  }
  const canonical = gunzipSync(compressed, { maxOutputLength: 32 * 1_024 });
  const availability = JSON.parse(canonical.toString("utf8"));

  // require deterministic compact bytes for the v2 reader
  if (!canonical.equals(Buffer.from(canonicalJson(availability))) ||
    !gzipSync(canonical, { level: 9, mtime: 0 }).equals(compressed)) {
    throw new TypeError("receipt availability encoding is invalid");
  }
  return availability;
}

// validate one grouped first-observed availability projection
function validateReceiptAvailability(availability, maximumRows) {
  requireExactKeys(availability, ["rowTimestampIndexes", "timestamps"], "receipt.availability");

  if (!Array.isArray(availability.timestamps) ||
    !Array.isArray(availability.rowTimestampIndexes) ||
    availability.rowTimestampIndexes.length > maximumRows) {
    throw new TypeError("receipt availability is invalid");
  }

  // validate all grouped timestamps
  for (const timestamp of availability.timestamps) {
    requireInstant(timestamp, "receipt.availability.timestamps[]");
  }

  // validate every row timestamp reference
  for (const index of availability.rowTimestampIndexes) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= availability.timestamps.length) {
      throw new TypeError("receipt availability index is invalid");
    }
  }
}

// validate the outer object and row count before export
function validateEvidenceObject(value) {
  requireExactKeys(value, [
    "bundleIdentities",
    "contractVersion",
    "rows",
    "settingsSha256",
    "siteKey",
    "window",
  ], "object");
  const maximumRows = value.contractVersion === ADJUSTMENT_EVIDENCE_OBJECT_CONTRACT_VERSION
    ? MAXIMUM_ROWS
    : value.contractVersion === ADJUSTMENT_EVIDENCE_OBJECT_V2_CONTRACT_VERSION
      ? MAXIMUM_V2_ROWS
      : null;

  // accept only the immutable v1 and v2 object schemas
  if (maximumRows === null) {
    throw new TypeError("object.contractVersion is invalid");
  }
  requireSha256(value.settingsSha256, "object.settingsSha256");
  requireEqual(value.siteKey, "ballydidean", "object.siteKey");

  if (!WINDOWS.includes(value.window) || !Array.isArray(value.rows) ||
    value.rows.length < 1 || value.rows.length > maximumRows) {
    throw new TypeError("adjustment evidence object is invalid");
  }
}

// decompress within the canonical and ratio limits
function gunzipBounded(compressed) {
  const canonical = gunzipSync(compressed, {
    finishFlush: 4,
    maxOutputLength: OBJECT_MAXIMUM_BYTES + 1,
  });

  if (canonical.byteLength > OBJECT_MAXIMUM_BYTES ||
    canonical.byteLength > compressed.byteLength * MAXIMUM_COMPRESSION_RATIO) {
    throw new Error("adjustment evidence object exceeds decompression limits");
  }

  return canonical;
}

// calculate one content-addressed object path
function evidenceObjectPath(root, sha256Value) {
  requireSha256(sha256Value, "objectSha256");
  return join(root, "objects", `sha256-${sha256Value}.json.gz`);
}

// calculate one stable-identity receipt path
function evidenceReceiptPath(root, sha256Value) {
  requireSha256(sha256Value, "edgeReceiptIdentitySha256");
  return join(root, "receipts", `sha256-${sha256Value}.json`);
}

// detect one existing regular path without accepting invalid entries
async function regularFileExists(path) {
  try {
    const details = await lstat(path);

    if (!details.isFile() || details.isSymbolicLink()) {
      throw new Error("adjustment evidence path is invalid");
    }

    return true;
  } catch (error) {
    // treat only a missing path as available for exclusive creation
    if (error?.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

// calculate conservative filesystem allocation
function allocatedSize(bytes, blockSize) {
  return Math.ceil(bytes / blockSize) * blockSize;
}

// create one empty bounded scheduler state
function createSchedulerState() {
  return {
    activation: "not_initialized",
    attempts: [],
    contractVersion: ADJUSTMENT_EVIDENCE_SCHEDULER_STATE_CONTRACT_VERSION,
    errors: [],
    gaps: [],
    lastCheckedAt: null,
    updatedAt: null,
  };
}

// validate one closed scheduler restart-state document
function validateSchedulerState(state) {
  requireExactKeys(state, [
    "activation",
    "attempts",
    "contractVersion",
    "errors",
    "gaps",
    "lastCheckedAt",
    "updatedAt",
  ], "scheduler state");
  requireEqual(
    state.contractVersion,
    ADJUSTMENT_EVIDENCE_SCHEDULER_STATE_CONTRACT_VERSION,
    "scheduler state contractVersion",
  );

  // enforce bounded status strings and history arrays
  if (typeof state.activation !== "string" || state.activation.length > 64 ||
    !Array.isArray(state.attempts) || state.attempts.length > SCHEDULER_HISTORY_LIMIT ||
    !Array.isArray(state.errors) || state.errors.length > SCHEDULER_HISTORY_LIMIT ||
    !Array.isArray(state.gaps) || state.gaps.length > SCHEDULER_HISTORY_LIMIT) {
    throw new TypeError("scheduler state is invalid");
  }

  // validate optional state instants
  for (const instantValue of [state.lastCheckedAt, state.updatedAt]) {
    if (instantValue !== null) {
      requireInstant(instantValue, "scheduler state instant");
    }
  }

  // validate every bounded capture attempt
  for (const attempt of state.attempts) {
    requireExactKeys(attempt, ["committedAt", "dueKey", "status"], "scheduler attempt");
    requireInstant(attempt.committedAt, "scheduler attempt committedAt");
    requireSchedulerDueKey(attempt.dueKey);
    requireBoundedString(attempt.status, "scheduler attempt status");
  }

  // validate every bounded scheduler error
  for (const error of state.errors) {
    requireExactKeys(error, ["at", "code", "dueKey"], "scheduler error");
    requireInstant(error.at, "scheduler error at");
    requireBoundedString(error.code, "scheduler error code");
    requireSchedulerDueKey(error.dueKey);
  }

  // validate every durable categorical scheduler gap
  for (const gap of state.gaps) {
    requireExactKeys(gap, ["dueKey", "occurredAt", "reason"], "scheduler gap");
    requireSchedulerDueKey(gap.dueKey);
    requireInstant(gap.occurredAt, "scheduler gap occurredAt");

    // retain only the two scheduler refusal categories
    if (gap.reason !== "missed_capture" && gap.reason !== "capture_failed") {
      throw new TypeError("scheduler gap reason is invalid");
    }
  }
  return state;
}

// create nearby deterministic jittered due candidates
function adjustmentEvidenceDueCandidates(now) {
  const candidates = [];

  // inspect yesterday and today to cover pre-midnight catch-up
  for (const dayOffset of [-1, 0]) {
    const date = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + dayOffset,
    ));

    // create the four fixed UTC cycle bases
    for (const hour of SCHEDULE_HOURS) {
      const base = new Date(Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate(),
        hour,
        35,
      ));

      // exclude cycles at or beyond the finite boundary
      if (base.getTime() < Date.parse(ADJUSTMENT_EVIDENCE_CAPTURE_START) ||
        base.getTime() >= Date.parse(ADJUSTMENT_EVIDENCE_CAPTURE_END)) {
        continue;
      }
      const dueKey = `capture/${base.toISOString()}`;
      const jitterSeconds = Number.parseInt(sha256(`ballydidean|${dueKey}`).slice(0, 8), 16) % 300;
      candidates.push({
        dueKey,
        jitterSeconds,
        scheduledAt: new Date(base.getTime() + jitterSeconds * 1_000).toISOString(),
      });
    }
  }
  return candidates;
}

// identify skipped due keys since the last durable clock observation
function missedAdjustmentEvidenceDueKeys(lastCheckedAt, now, selectedDueKey) {
  // treat first startup as one current catch-up without invented history
  if (lastCheckedAt === null) {
    return [];
  }

  const previous = Date.parse(lastCheckedAt);
  const candidates = [];

  // inspect each UTC date between bounded scheduler observations
  for (let cursor = new Date(previous); cursor.getTime() <= now.getTime();
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1_000)) {
    candidates.push(...adjustmentEvidenceDueCandidates(cursor));
  }

  return [...new Map(candidates.map(
    // deduplicate overlapping yesterday/today candidate windows
    (candidate) => [candidate.dueKey, candidate],
  )).values()]
    .filter(
      // retain only elapsed, unselected cycle gaps after the last observation
      (candidate) => Date.parse(candidate.scheduledAt) > previous &&
        Date.parse(candidate.scheduledAt) <= now.getTime() &&
        candidate.dueKey !== selectedDueKey,
    )
    .sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt))
    .map(
      // project only the immutable due identity
      (candidate) => candidate.dueKey,
    );
}

// retain the complete finite scheduler history without pruning
function retainSchedulerHistory(entries) {
  // stop on an impossible overrun instead of deleting causal history
  if (entries.length > SCHEDULER_HISTORY_LIMIT) {
    throw new Error("scheduler history capacity is exhausted");
  }
  return entries;
}

// normalize one internal trigger result to a closed status label
function normalizeSchedulerTriggerStatus(result) {
  const status = result?.status;

  // accept only explicit successful capture outcomes
  if (status !== "created" && status !== "duplicate") {
    const error = new Error("scheduler capture was not committed");
    error.code = "capture_not_committed";
    throw error;
  }
  return status;
}

// reduce one internal failure to a bounded categorical code
function boundedErrorCode(error) {
  const value = typeof error?.code === "string" ? error.code : "capture_failed";
  return /^[a-z0-9_]{1,64}$/u.test(value) ? value : "capture_failed";
}

// require one trusted issuance-channel value
function requireIssuanceChannel(value) {
  if (!ISSUANCE_CHANNELS.includes(value)) {
    throw new TypeError("issuance channel is invalid");
  }
  return value;
}

// parse one canonical content-addressed channel assertion
function parseChannelAssertion(bytes, expectedSha256) {
  const value = JSON.parse(bytes.toString("utf8"));
  validateChannelAssertion(value, expectedSha256);

  // require exact canonical bytes at every reader boundary
  if (!bytes.equals(Buffer.from(`${canonicalJson(value)}\n`))) {
    throw new TypeError("channel assertion encoding is invalid");
  }
  return value;
}

// validate one content-addressed channel assertion
function validateChannelAssertion(value, expectedSha256) {
  requireExactKeys(value, [
    "channel",
    "contractVersion",
    "edgeReceiptIdentitySha256",
    "firstEdgeCommittedAt",
    "receiptSha256",
  ], "channel assertion");
  requireEqual(
    value.contractVersion,
    ADJUSTMENT_EVIDENCE_CHANNEL_CONTRACT_VERSION,
    "channel assertion contractVersion",
  );
  requireIssuanceChannel(value.channel);
  requireSha256(value.edgeReceiptIdentitySha256, "channel assertion identity");
  requireInstant(value.firstEdgeCommittedAt, "channel assertion firstEdgeCommittedAt");
  requireSha256(value.receiptSha256, "channel assertion receiptSha256");
  const bytes = Buffer.from(`${canonicalJson(value)}\n`);

  // bind the content-addressed filename to exact assertion bytes
  if (sha256(bytes) !== expectedSha256) {
    throw new TypeError("channel assertion hash is invalid");
  }
}

// parse one canonical stable receipt-to-assertion binding
function parseChannelBinding(bytes, expectedIdentity) {
  const value = JSON.parse(bytes.toString("utf8"));
  validateChannelBinding(value, expectedIdentity);

  // reject noncanonical mutable binding bytes
  if (!bytes.equals(Buffer.from(`${canonicalJson(value)}\n`))) {
    throw new TypeError("channel binding encoding is invalid");
  }
  return value;
}

// validate one stable receipt-to-assertion binding
function validateChannelBinding(value, expectedIdentity) {
  requireExactKeys(value, [
    "assertionSha256",
    "contractVersion",
    "edgeReceiptIdentitySha256",
  ], "channel binding");
  requireEqual(value.contractVersion, "issuance-channel-binding/v2", "channel binding contractVersion");
  requireEqual(value.edgeReceiptIdentitySha256, expectedIdentity, "channel binding identity");
  requireSha256(value.assertionSha256, "channel binding assertionSha256");
}

// map an immutable object contract to its matching receipt contract
function receiptVersionForObject(contractVersion) {
  // preserve the exact v1 pairing
  if (contractVersion === ADJUSTMENT_EVIDENCE_OBJECT_CONTRACT_VERSION) {
    return ADJUSTMENT_EVIDENCE_RECEIPT_CONTRACT_VERSION;
  }

  // accept only the new v2 pairing otherwise
  if (contractVersion === ADJUSTMENT_EVIDENCE_OBJECT_V2_CONTRACT_VERSION) {
    return ADJUSTMENT_EVIDENCE_RECEIPT_V2_CONTRACT_VERSION;
  }
  throw new TypeError("adjustment evidence object contract is invalid");
}

// require one exact scheduler due-key grammar
function requireSchedulerDueKey(value) {
  if (typeof value !== "string" ||
    !/^capture\/\d{4}-\d{2}-\d{2}T(?:00|06|12|18):35:00\.000Z$/u.test(value)) {
    throw new TypeError("scheduler dueKey is invalid");
  }
}

// read one optional private regular file without following links
async function readOptionalPrivateFile(path, maximumBytes) {
  return await readPrivateFileIfPresent(path, maximumBytes);
}

// read one optional private file and distinguish only absence
async function readPrivateFileIfPresent(path, maximumBytes) {
  try {
    return await readRegularFile(path, maximumBytes);
  } catch (error) {
    // treat only one absent path as empty state
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

// atomically replace one bounded private status file and fsync its directory
async function writeAtomicPrivate(path, bytes) {
  const directoryPath = dirname(path);
  const temporaryPath = join(directoryPath, `.state-${randomUUID()}.tmp`);
  const handle = await open(
    temporaryPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    0o600,
  );

  try {
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
    await fsyncDirectory(directoryPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

// fsync one real directory after rename or slot reuse
async function fsyncDirectory(path) {
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );

  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// create one classified projection limit error
function objectTooLargeError() {
  const error = new RangeError("adjustment evidence object is too large");
  error.code = "adjustment_evidence_object_too_large";
  return error;
}

// create canonical JSON with recursively sorted object keys
function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

// recreate the stable receipt identity from one stored object
function stableIdentitySha256(object) {
  return sha256(canonicalJson({
    bundleIdentities: object.bundleIdentities,
    rows: object.rows.map(
      // exclude all scoring values from the stable record identity
      (row) => ({ record: row.record, source: row.source }),
    ),
    settingsSha256: object.settingsSha256,
    siteKey: object.siteKey,
    window: object.window,
  }));
}

// recursively sort plain object keys and reject unsupported values
function canonicalValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical JSON numbers must be finite");
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(
      // preserve semantic array order
      (entry) => canonicalValue(entry),
    );
  }

  requirePlainObject(value, "canonical value");
  return Object.fromEntries(Object.keys(value).sort().map(
    // normalize every property recursively
    (key) => [key, canonicalValue(value[key])],
  ));
}

// calculate one lowercase SHA-256 digest
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

// require one plain object
function requirePlainObject(value, path) {
  if (value === null || Array.isArray(value) || typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${path} must be a plain object`);
  }
  return value;
}

// require exact closed object keys
function requireExactKeys(value, keys, path) {
  requirePlainObject(value, path);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();

  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${path} has invalid keys`);
  }
}

// require one exact value
function requireEqual(value, expected, path) {
  if (value !== expected) {
    throw new TypeError(`${path} is invalid`);
  }
}

// require one SHA-256 value
function requireSha256(value, path) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${path} is invalid`);
  }
  return value;
}

// normalize an unavailable SHA-256 identity
function nullableSha256(value) {
  if (value === null || value === undefined) {
    return null;
  }
  return requireSha256(value, "sha256");
}

// require one canonical UTC instant
function requireInstant(value, path) {
  if (typeof value !== "string" || !value.endsWith("Z") ||
    !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError(`${path} is invalid`);
  }
}

// return one validated UTC instant
function instant(value, path) {
  requireInstant(value, path);
  return value;
}

// normalize an unavailable UTC instant
function nullableInstant(value, path) {
  if (value === null || value === undefined) {
    return null;
  }
  return instant(value, path);
}

// require one bounded opaque string
function requireBoundedString(value, path) {
  if (typeof value !== "string" || value.length < 1 || value.length > 200 ||
    /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${path} is invalid`);
  }
  return value;
}

// normalize an unavailable bounded string
function nullableBoundedString(value, path) {
  if (value === null || value === undefined) {
    return null;
  }
  return requireBoundedString(value, path);
}

// require one bounded string array
function requireStringArray(value, path) {
  if (!Array.isArray(value) || value.length > 16) {
    throw new TypeError(`${path} is invalid`);
  }
  return value.map(
    // validate every metric name
    (entry) => requireBoundedString(entry, `${path}[]`),
  );
}

// require one nonnegative record revision
function requireRevisionCount(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
    throw new TypeError("row.revisionCount is invalid");
  }
  return value;
}

// require one bounded integer
function requireBoundedInteger(value, path) {
  if (!Number.isSafeInteger(value) || Math.abs(value) > 1_000_000) {
    throw new TypeError(`${path} is invalid`);
  }
  return value;
}

// require one finite number
function finite(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${path} is invalid`);
  }
  return value;
}

// normalize one unavailable number
function nullableFinite(value, path) {
  if (value === null || value === undefined) {
    return null;
  }
  return finite(value, path);
}

// require one adjustment decision object
function requireDecision(value, path) {
  return requirePlainObject(value, path);
}

// require the exact public state union for this family
function requireState(value, path, states) {
  // reject unknown and cross-family states
  if (!states.includes(value)) {
    throw new TypeError(`${path} is invalid`);
  }
  return value;
}

// run the two closed archive verbs against only the installed fixed evidence root
export async function runAdjustmentArchiveCommand(argv, options = {}) {
  const [action, ...argumentsList] = argv;

  // emit one bounded canonical page or idle envelope
  if (action === "archive-next") {
    if (argumentsList.length !== 0) {
      throw new TypeError("archive-next takes no arguments");
    }
    const transport = await new AdjustmentEvidenceArchiveTransport({
      now: options.now,
      root: options.root,
      statfs: options.statfs,
    }).initialize();
    const bytes = Buffer.from(`${canonicalJson(await transport.next())}\n`);

    // retain the forced-command response ceiling at the final byte boundary
    if (bytes.byteLength > ARCHIVE_TRANSFER_MAXIMUM_BYTES) {
      throw new Error("archive transfer envelope is too large");
    }
    (options.stdout ?? process.stdout).write(bytes);
    return;
  }

  // acknowledge only one exact page and open-cycle checkpoint pair
  if (action === "archive-ack") {
    if (argumentsList.length !== 2) {
      throw new TypeError("archive-ack requires PAGE_SHA256 CHECKPOINT_SHA256");
    }
    requireSha256(argumentsList[0], "pageSha256");
    requireSha256(argumentsList[1], "checkpointSha256");
    const transport = await new AdjustmentEvidenceArchiveTransport({
      now: options.now,
      root: options.root,
      statfs: options.statfs,
    }).initialize();
    await transport.acknowledge(argumentsList[0], argumentsList[1]);
    return;
  }

  // acknowledge only one genuine final manifest and cold graph pair
  if (action === "archive-ack-final") {
    if (argumentsList.length !== 2) {
      throw new TypeError("archive-ack-final requires MANIFEST_SHA256 GRAPH_SHA256");
    }
    requireSha256(argumentsList[0], "manifestSha256");
    requireSha256(argumentsList[1], "graphSha256");
    const transport = await new AdjustmentEvidenceArchiveTransport({
      now: options.now,
      root: options.root,
      statfs: options.statfs,
    }).initialize();
    await transport.acknowledgeFinal(argumentsList[0], argumentsList[1]);
    return;
  }
  throw new TypeError("archive operation is invalid");
}

// recognize direct helper execution without affecting web-server imports
function isDirectAdjustmentArchiveCommand() {
  return typeof process.argv[1] === "string" &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}

// execute only a direct closed helper command
if (isDirectAdjustmentArchiveCommand()) {
  runAdjustmentArchiveCommand(process.argv.slice(2)).catch(
    // return one bounded diagnostic and a failing forced-command status
    (error) => {
      process.stderr.write(`error: ${String(error?.message ?? "archive operation failed")}\n`);
      process.exitCode = 1;
    },
  );
}
