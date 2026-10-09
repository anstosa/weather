import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, cp, readFile, realpath, rm, } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { FORECAST_LEAD_BANDS, FORECAST_ADJUSTMENT_METRICS, FORECAST_OBSERVATION_STATIONS, forecastLeadBandFor, validatePromotableForecastAdjustmentEvidence, canonicalizeJson, } from "@weather/domain";
import { canonicalJsonBytes, canonicalObjectSha256, canonicalSha256, createForecastAdjustmentCandidate, createForecastAdjustmentPreregistration, deepFreeze, FORECAST_ADJUSTMENT_CANONICAL_TRAINING_PROVENANCE_V1, verifyForecastAdjustmentCandidate, verifyForecastAdjustmentPreregistration, } from "./candidate.js";
import { verifyDevelopmentReport, verifyForecastAdjustmentEvaluationReport, verifyForecastAdjustmentQualificationReceipt, } from "./evaluate.js";
import { FORECAST_ADJUSTMENT_WIND_CANARY_TRAINING_IDENTITY_V1, createForecastAdjustmentWindCanaryAuthorization, createForecastAdjustmentWindCanaryCandidate, createForecastAdjustmentWindCanaryRuntimeBundle, createForecastAdjustmentWindCanaryTransferReport, } from "./wind-canary.js";
import { appendEvidenceLifecycleRecord, parseHoldoutLedger, deriveHoldoutLineage, verifyEvidenceLifecycleRecord, verifyHoldoutAccessMarker, withGuardedHoldoutAccess, } from "./holdout-ledger.js";
import { FORECAST_ADJUSTMENT_ALGORITHM_VERSION, applyCappedCorrection, corePairedSkill, createTrainingEnvelope, deduplicateForecastAtomicCandidates, directionNetworkActual, fitRobustHierarchy, forecastResidual, scalarNetworkActual, selectHierarchyCoefficient, withLocalHierarchyFeatures, parseSanitizedTrainingExportRow, wrap180, } from "./algorithm-v1.js";
import { isMaterialHarm, } from "./algorithm-v1.js";
import { movingBlockBootstrap, } from "./bootstrap-v1.js";
import { createQualificationCalendarEpoch, addLocalCalendarDays, localCalendarFeaturesFor, runtimeCalendarFingerprint, } from "./calendar.js";
import { createDevelopmentReport, createForecastAdjustmentEvaluationReport, createForecastAdjustmentQualificationReceipt, evaluateDevelopmentLosoFold, } from "./evaluate.js";
import { analyzeTemperatureLeadResearch, } from "./temperature-lead-research.js";
import { analyzeTemperatureBoostedHybridResearch, analyzeTemperatureBoostedResearch, analyzeTemperatureNearNowcastResearch, analyzeTemperatureOnlyResearch, analyzeTemperatureWeatherAdaptiveResearch, analyzeTemperatureWeatherHorizonResearch, analyzeTemperatureWeatherHybridResearch, analyzeTemperatureWeatherShrinkageResearch, analyzeTemperatureWeatherRecencyResearch, analyzeTemperatureWeatherResearch, } from "./temperature-weather-research.js";
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const EVIDENCE_KINDS = [
    "snapshot-manifest",
    "development-report",
    "preregistration",
    "holdout-access-marker",
    "candidate",
    "evaluation-report",
    "qualification-receipt",
];
export const MODEL_EVIDENCE_ROOT = join(homedir(), ".weather", "model-evidence");
export const MODEL_EVIDENCE_REDUNDANCY_ROOT = process.env.WEATHER_MODEL_EVIDENCE_REDUNDANCY_ROOT ??
    join(homedir(), ".weather", "model-evidence-redundancy");
// construct the production deterministic retained-row engine
export function createDefaultRetainedForecastAdjustmentEngine() {
    return {
        // fit development evidence and one final immutable candidate
        async fitDevelopment(input) {
            return fitRetainedDevelopment(input);
        },
        // score the unchanged candidate on the guarded holdout rows
        async evaluateHoldout(input) {
            return evaluateRetainedHoldout(input);
        },
    };
}
// bound future-only archive member metadata without reducing numerical support
export const ADJUSTMENT_ARCHIVE_WIND_FIT_MAXIMUM_MEMBERS = 1_000_000;
const ARCHIVE_WIND_FIT_MANIFEST_KEYS = [
    "aggregationContractSha256", "contractVersion", "coordinateManifestSha256",
    "epochWitnessSha256", "fromLocalDate", "historyRootSha256", "members",
    "metricEligibilitySha256", "sourceLineageSha256", "spatialWeightsSha256",
    "stationManifestSha256", "toLocalDate", "totalRowCount",
];
const SNAPSHOT_PROVENANCE_HASHES = {
    aggregationContractSha256: FORECAST_ADJUSTMENT_CANONICAL_TRAINING_PROVENANCE_V1.aggregationContractSha256,
    coordinateManifestSha256: FORECAST_ADJUSTMENT_CANONICAL_TRAINING_PROVENANCE_V1.coordinateManifestSha256,
    metricEligibilitySha256: FORECAST_ADJUSTMENT_CANONICAL_TRAINING_PROVENANCE_V1.metricEligibilitySha256,
    sourceLineageSha256: FORECAST_ADJUSTMENT_CANONICAL_TRAINING_PROVENANCE_V1.observationSourceLineageSha256,
    spatialWeightsSha256: FORECAST_ADJUSTMENT_CANONICAL_TRAINING_PROVENANCE_V1.spatialWeightSha256,
    stationManifestSha256: FORECAST_ADJUSTMENT_CANONICAL_TRAINING_PROVENANCE_V1.observationStationManifestSha256,
};
const SNAPSHOT_MANIFEST_KEYS = [
    "aggregationContractSha256",
    "contractVersion",
    "coordinateManifestSha256",
    "createdAtUtc",
    "databaseManifest",
    "fromLocalDate",
    "limits",
    "members",
    "metricEligibilitySha256",
    "migrationHistorySha256",
    "observedSourceIdentities",
    "queryContractSha256",
    "queryContractVersion",
    "rowSchemaSha256",
    "siteKey",
    "siteTimezone",
    "sourceIdentities",
    "sourceLineageSha256",
    "spatialWeightsSha256",
    "stationMetricCoverage",
    "stationManifestSha256",
    "toLocalDate",
    "totalRowCount",
    "transaction",
    "usageBoundary",
];
const SNAPSHOT_STATION_METRIC_COVERAGE_KEYS = [
    "eligibleMetricNonNullLocalDates",
    "stationKey",
];
const SNAPSHOT_STATION_METRIC_FIELDS = [
    "relative_humidity_percent",
    "temperature_c",
    "wind_direction_degrees",
    "wind_gust_mps",
    "wind_speed_mps",
];
const SNAPSHOT_MEMBER_KEYS = [
    "localDate",
    "maxValidAt",
    "minValidAt",
    "path",
    "plaintextBytes",
    "recordKind",
    "rowCount",
    "sha256",
    "sizeBytes",
    "stationKey",
];
const SNAPSHOT_QUERY_CONTRACT_SHA256 = "3b7926c47bbdb208ac2e305ee7798bfe4ea9590ce2863f556e752a71d1158e76";
const SNAPSHOT_ROW_SCHEMA_SHA256 = "2717b6c3c704a1b52c7748b59c37d635efd92d92efb9dc97ea4ddef97cd504fc";
// create a sanitized deterministic insufficiency result
export function createInsufficientDataReport(input) {
    validateHash(input.snapshotManifestSha256, "snapshotManifestSha256");
    const failedGates = [...new Set(input.failedGates)].sort(compareText);
    // require at least one stable failed gate
    if (failedGates.length === 0 ||
        failedGates.some((gate) => !/^[a-z0-9]+(?:_[a-z0-9]+)*$/u.test(gate))) {
        throw new RangeError("insufficient-data report requires bounded reason keys");
    }
    const unsigned = {
        contractVersion: "forecast-adjustment-insufficient-data/v1",
        failedGates,
        snapshotManifestSha256: input.snapshotManifestSha256,
        state: "insufficient_data",
    };
    return deepFreeze({
        ...unsigned,
        reportSha256: sha256(canonicalJsonBytes(unsigned)),
    });
}
// reject sufficient fitting without durable retained evidence
export function assertDurableTrainingRetention(input) {
    // permit ignored local output only for insufficiency
    if (input.state === "sufficient" && !input.retentionVerified) {
        throw new Error("sufficient forecast-adjustment training requires durable external retention");
    }
}
// evaluate manifest-level sufficiency without designating a holdout
export async function evaluateForecastAdjustmentSnapshot(input) {
    const snapshotRoot = await requireFixedLocalRoot(input.snapshotPath, ".weather-data", "snapshot");
    const outputRoot = await requireFixedLocalRoot(input.outputPath, ".weather-models", "output", true);
    const accessTrace = ["manifest_control_opened"];
    const manifestBytes = await readFile(join(snapshotRoot, "manifest.json"), "utf8");
    const manifestSha256 = sha256(manifestBytes);
    const checksumBytes = await readFile(join(snapshotRoot, "manifest.sha256"), "utf8");
    // bind the exact canonical manifest and directory identity
    if (checksumBytes !== `${manifestSha256}  manifest.json\n` ||
        basename(snapshotRoot) !== manifestSha256) {
        throw new RangeError("snapshot manifest identity mismatch");
    }
    const manifest = JSON.parse(manifestBytes);
    // require canonical manifest bytes before any member access
    if (manifestBytes !== canonicalJsonBytes(manifest)) {
        throw new RangeError("snapshot manifest is not canonical JSON");
    }
    validateSnapshotManifestBoundary(manifest);
    accessTrace.push("manifest_schema_verified");
    for (const member of manifest.members) {
        validateSnapshotMember(member, snapshotRoot);
    }
    accessTrace.push("member_metadata_verified");
    for (const member of manifest.members) {
        const bytes = await readVerifiedSnapshotMember(snapshotRoot, member.path);
        // verify compressed bytes without parsing row contents
        if (bytes.byteLength !== member.sizeBytes || sha256(bytes) !== member.sha256) {
            throw new RangeError("snapshot member checksum or size mismatch");
        }
        accessTrace.push(`member_hash_verified:${member.path}`);
    }
    const failedGates = inferManifestInsufficiency(manifest);
    // refuse ignored-local fitting when manifest evidence might be sufficient
    if (failedGates.length === 0) {
        assertDurableTrainingRetention({ retentionVerified: false, state: "sufficient" });
    }
    const report = createInsufficientDataReport({
        failedGates,
        snapshotManifestSha256: manifestSha256,
    });
    const result = deepFreeze({
        ...report,
        accessTrace: [...accessTrace, "insufficient_data_emitted"],
        exitCode: 2,
        outputFile: "insufficient-data.json",
    });
    await atomicWriteNew(join(outputRoot, result.outputFile), canonicalJsonBytes(result));
    return result;
}
// run a sufficient snapshot only from externally retained evidence
export async function evaluateRetainedForecastAdjustmentSnapshot(input, engine) {
    const evidenceRoot = await requireCanonicalDirectory(input.evidenceRoot, "evidence root");
    const snapshotRoot = await requireCanonicalDirectory(input.snapshotPath, "retained snapshot");
    // require the snapshot below the caller-injected durable root
    if (!snapshotRoot.startsWith(`${evidenceRoot}${sep}`)) {
        throw new RangeError("retained snapshot is outside the durable evidence root");
    }
    const accessTrace = [];
    const manifestBytes = (await readVerifiedRegularFile(join(snapshotRoot, "manifest.json"), snapshotRoot, "retained snapshot manifest", accessTrace, "control", "manifest.json")).toString("utf8");
    const manifestSha256 = sha256(manifestBytes);
    const checksumBytes = (await readVerifiedRegularFile(join(snapshotRoot, "manifest.sha256"), snapshotRoot, "retained snapshot checksum", accessTrace, "control", "manifest.sha256")).toString("utf8");
    // bind the retained content-addressed snapshot identity
    if (checksumBytes !== `${manifestSha256}  manifest.json\n` ||
        basename(snapshotRoot) !== manifestSha256) {
        throw new RangeError("snapshot manifest identity mismatch");
    }
    const manifest = JSON.parse(manifestBytes);
    // verify control bytes before opening any row member
    if (manifestBytes !== canonicalJsonBytes(manifest)) {
        throw new RangeError("snapshot manifest is not canonical JSON");
    }
    validateSnapshotManifestBoundary(manifest);
    accessTrace.push("manifest_schema_verified");
    // validate only metadata before phase-scoped member access
    for (const member of manifest.members) {
        validateSnapshotMember(member, snapshotRoot);
    }
    accessTrace.push("member_metadata_verified");
    const manifestFailedGates = inferManifestInsufficiency(manifest);
    // stop before row parsing when the control plane proves insufficiency
    if (manifestFailedGates.length > 0) {
        const report = createInsufficientDataReport({
            failedGates: manifestFailedGates,
            snapshotManifestSha256: manifestSha256,
        });
        return deepFreeze({
            ...report,
            accessTrace: [...accessTrace, "insufficient_data_emitted"],
            exitCode: 2,
            outputFile: "insufficient-data.json",
        });
    }
    const epoch = createQualificationCalendarEpoch(manifest.toLocalDate);
    const preHoldoutRows = await readSnapshotPhaseRows(snapshotRoot, manifest.members.filter((member) => member.localDate >= epoch.finalTraining.startLocalDate &&
        member.localDate <= epoch.finalTraining.endLocalDate), "preholdout", accessTrace);
    const authoritativeEngine = createDefaultRetainedForecastAdjustmentEngine();
    const engineInput = {
        manifest: deepFreeze(manifest),
        preHoldoutRows,
        snapshotManifestSha256: manifestSha256,
    };
    const preHoldout = await authoritativeEngine.fitDevelopment(engineInput);
    // permit injected engines only when the default engine independently agrees
    if (engine !== undefined) {
        const claimed = await engine.fitDevelopment(engineInput);
        // reject fabricated sufficiency, coefficients, or preregistration
        if (canonicalizeJson(claimed) !==
            canonicalizeJson(preHoldout)) {
            throw new RangeError("injected retained engine disagrees with authoritative fit");
        }
    }
    // emit deterministic insufficiency without burning a holdout
    if (preHoldout.state === "insufficient_data") {
        return deepFreeze({
            ...preHoldout,
            accessTrace: [...accessTrace, "insufficient_data_emitted"],
            exitCode: 2,
            outputFile: "insufficient-data.json",
        });
    }
    const redundancyRoot = await requireCanonicalDirectory(input.redundancyRoot ?? MODEL_EVIDENCE_REDUNDANCY_ROOT, "evidence redundancy root");
    const [evidenceRootMetadata, redundancyRootMetadata] = await Promise.all([
        lstat(evidenceRoot),
        lstat(redundancyRoot),
    ]);
    // require a distinct storage device before holdout access
    if (evidenceRootMetadata.dev === redundancyRootMetadata.dev) {
        throw new RangeError("evidence redundancy root must use a distinct storage device");
    }
    verifyDevelopmentReport(preHoldout.developmentReport);
    verifyForecastAdjustmentPreregistration(preHoldout.preregistration, preHoldout.candidate);
    // require the engine to bind the verified retained snapshot and development bytes
    if (preHoldout.candidate.exportManifestSha256 !== manifestSha256 ||
        preHoldout.candidate.developmentReportSha256 !==
            preHoldout.developmentReport.developmentReportSha256) {
        throw new RangeError("retained pre-holdout evidence cross-link mismatch");
    }
    accessTrace.push("candidate_and_preregistration_verified");
    let evaluated;
    let durableMarker;
    await withGuardedHoldoutAccess({
        candidate: preHoldout.candidate,
        directory: evidenceRoot,
        lineage: preHoldout.lineage,
        onDurableMarker: (marker) => {
            durableMarker = marker;
            accessTrace.push(`holdout_marker_durable:${marker.markerSha256}`);
        },
        preregistration: preHoldout.preregistration,
    }, async (marker) => {
        const holdoutRows = await readSnapshotPhaseRows(snapshotRoot, manifest.members.filter((member) => member.localDate >= preHoldout.preregistration.holdoutStartLocalDate &&
            member.localDate <= preHoldout.preregistration.holdoutEndLocalDate), "holdout", accessTrace);
        const holdoutInput = {
            candidate: preHoldout.candidate,
            holdoutAccessMarker: marker,
            holdoutRows,
            preregistration: preHoldout.preregistration,
        };
        const authoritative = await authoritativeEngine.evaluateHoldout(holdoutInput);
        // compare any injected scorer to independently derived holdout evidence
        if (engine !== undefined) {
            const claimed = await engine.evaluateHoldout(holdoutInput);
            // reject fabricated event scoring while allowing attestation clock variance
            if (canonicalizeJson(claimed.evaluationReport) !==
                canonicalizeJson(authoritative.evaluationReport)) {
                throw new RangeError("injected retained engine disagrees with authoritative holdout score");
            }
        }
        evaluated = authoritative;
    });
    // require the guarded callback to produce every post-holdout object
    if (evaluated === undefined || durableMarker === undefined) {
        throw new Error("retained holdout evaluation did not produce evidence");
    }
    const complete = {
        candidate: preHoldout.candidate,
        developmentReport: preHoldout.developmentReport,
        evaluationReport: evaluated.evaluationReport,
        holdoutAccessMarker: durableMarker,
        preregistration: preHoldout.preregistration,
        qualificationReceipt: evaluated.qualificationReceipt,
        snapshotManifest: manifest,
    };
    await stageEvidenceRedundancyAttestation(evidenceRoot, evaluated.attestation);
    await stageRedundantRetainedSnapshot(redundancyRoot, evaluated.attestation.status, snapshotRoot, manifestSha256);
    for (const kind of EVIDENCE_KINDS) {
        const value = valueForKind(complete, kind);
        await stageForecastAdjustmentEvidenceObject(evidenceRoot, kind, value);
        await stageRedundantEvidenceObject(redundancyRoot, evaluated.attestation.status, kind, value);
    }
    const hashes = {
        candidateArtifactSha256: preHoldout.candidate.candidateArtifactSha256,
        evaluationReportSha256: evaluated.evaluationReport.evaluationReportSha256,
        qualificationReceiptSha256: evaluated.qualificationReceipt.qualificationReceiptSha256,
    };
    await promoteForecastAdjustmentEvidenceAtRoot(evidenceRoot, hashes, redundancyRoot);
    return deepFreeze({
        ...hashes,
        accessTrace: [...accessTrace, "evidence_promoted"],
        contractVersion: "forecast-adjustment-evidence-result/v1",
        state: "promoted",
    });
}
// fit and bridge-score one separately authorized wind-transfer canary
export async function evaluateRetainedForecastAdjustmentWindCanarySnapshot(input) {
    const enabledMetrics = [...input.enabledMetrics].sort(compareText);
    // require an explicit nonempty unique wind-only request
    if (enabledMetrics.length === 0 ||
        new Set(enabledMetrics).size !== enabledMetrics.length ||
        enabledMetrics.some((metric) => metric !== "windDirectionDegrees" &&
            metric !== "windGustMps" &&
            metric !== "windSpeedMps")) {
        throw new RangeError("wind canary enabled metrics are invalid");
    }
    const evidenceRoot = await requireCanonicalDirectory(input.evidenceRoot, "evidence root");
    const snapshotRoot = await requireCanonicalDirectory(input.snapshotPath, "retained snapshot");
    // require the snapshot below the durable evidence root
    if (!snapshotRoot.startsWith(`${evidenceRoot}${sep}`)) {
        throw new RangeError("retained snapshot is outside the durable evidence root");
    }
    const accessTrace = [];
    const manifestBytes = (await readVerifiedRegularFile(join(snapshotRoot, "manifest.json"), snapshotRoot, "retained snapshot manifest", accessTrace, "control", "manifest.json")).toString("utf8");
    const snapshotManifestSha256 = sha256(manifestBytes);
    const checksumBytes = (await readVerifiedRegularFile(join(snapshotRoot, "manifest.sha256"), snapshotRoot, "retained snapshot checksum", accessTrace, "control", "manifest.sha256")).toString("utf8");
    // bind the content-addressed snapshot identity
    if (checksumBytes !== `${snapshotManifestSha256}  manifest.json\n` ||
        basename(snapshotRoot) !== snapshotManifestSha256) {
        throw new RangeError("snapshot manifest identity mismatch");
    }
    const manifest = JSON.parse(manifestBytes);
    // verify control bytes before opening row members
    if (manifestBytes !== canonicalJsonBytes(manifest)) {
        throw new RangeError("snapshot manifest is not canonical JSON");
    }
    validateSnapshotManifestBoundary(manifest);
    accessTrace.push("manifest_schema_verified");
    // verify all member metadata before row access
    for (const member of manifest.members) {
        validateSnapshotMember(member, snapshotRoot);
    }
    accessTrace.push("member_metadata_verified");
    const rows = await readSnapshotPhaseRows(snapshotRoot, manifest.members, "canary", accessTrace);
    const bridgeRows = rows.filter((row) => row.recordKind === "legacy_v4_retrieval_snapshot");
    // require a separate live-v4 transfer cohort
    if (bridgeRows.length === 0) {
        throw new RangeError("wind canary snapshot lacks live-v4 bridge rows");
    }
    const bridgeStartInclusive = bridgeRows
        .map((row) => row.validAt)
        .sort(compareText)[0];
    const bridgeEndInclusive = bridgeRows
        .map((row) => row.validAt)
        .sort(compareText)
        .at(-1);
    const fixedEvents = buildRetainedTrainingEvents(rows, "fixed_lead_anchor", enabledMetrics).filter((event) => event.validAt < bridgeStartInclusive);
    const bridgeEvents = buildRetainedTrainingEvents(rows, "legacy_v4_retrieval_snapshot", enabledMetrics);
    const pairKeys = [...new Set(bridgeEvents.map((event) => `${event.metric}:${event.leadBand}`))].sort(compareText);
    const fitted = pairKeys.flatMap((key) => {
        const [metric, leadBand] = key.split(":");
        const pair = { leadBand, metric };
        const trainingEvents = fixedEvents.filter((event) => event.metric === metric && event.leadBand === leadBand);
        const coefficients = fitEventHierarchy(trainingEvents, pair);
        // require the literal hierarchy root before bridge scoring
        if (!coefficients.some((coefficient) => coefficient.level === 1)) {
            return [];
        }
        const trainingEnvelope = metric === "windDirectionDegrees"
            ? null
            : createTrainingEnvelope(metric, leadBand, trainingEvents.map((event) => event.rawForecast));
        const scoredEvents = scoreFittedCanaryBridgeEvents(coefficients, bridgeEvents.filter((event) => event.metric === metric && event.leadBand === leadBand), pair, trainingEnvelope);
        // omit unscoreable transfer pairs
        if (scoredEvents.length === 0) {
            return [];
        }
        const losses = pairedLoss(scoredEvents, metric === "windDirectionDegrees");
        const score = { ...losses, eventCount: scoredEvents.length };
        // retain only wind pairs with positive live-v4 transfer
        if (score.eventCount < 30 ||
            !Number.isFinite(score.skill) ||
            score.skill <= 0) {
            return [];
        }
        return [{ coefficients, pair, score, trainingEnvelope }];
    });
    // refuse a canary without positive cross-cohort evidence
    if (fitted.length === 0 ||
        enabledMetrics.some((metric) => !fitted.some((item) => item.pair.metric === metric))) {
        throw new RangeError("wind canary snapshot lacks positive live-v4 bridge evidence");
    }
    const enabledMetricBands = fitted.map((item) => item.pair);
    const finalTrainingCutoff = fixedEvents
        .map((event) => event.validAt)
        .sort(compareText)
        .at(-1);
    const candidate = createForecastAdjustmentWindCanaryCandidate({
        coefficients: fitted.flatMap((item) => item.coefficients),
        enabledMetricBands,
        exportManifestSha256: snapshotManifestSha256,
        finalTrainingCutoff,
        runtimeFingerprint: runtimeCalendarFingerprint(),
        servedForecastIdentity: {
            adapterVersion: bridgeRows[0]?.adapterVersion,
            cohort: "legacy_v4_retrieval_snapshot",
            contractEpoch: bridgeRows[0]?.contractEpoch,
            dataset: bridgeRows[0]?.dataset,
            referenceKind: "retrieval_snapshot",
            sourceConfigFingerprint: bridgeRows[0]?.sourceConfigFingerprints[0],
            sourceKey: bridgeRows[0]?.sourceKeys[0],
            upstreamModel: bridgeRows[0]?.upstreamModel,
        },
        trainingEnvelopes: fitted.flatMap((item) => item.trainingEnvelope === null ? [] : [item.trainingEnvelope]),
        trainingForecastIdentity: FORECAST_ADJUSTMENT_WIND_CANARY_TRAINING_IDENTITY_V1,
        trainingProvenance: {
            aggregationContractSha256: manifest.aggregationContractSha256,
            coordinateManifestSha256: manifest.coordinateManifestSha256,
            metricEligibilitySha256: manifest.metricEligibilitySha256,
            observationSourceLineageSha256: manifest.sourceLineageSha256,
            observationStationManifestSha256: manifest.stationManifestSha256,
            spatialWeightSha256: manifest.spatialWeightsSha256,
        },
    });
    const transferReport = createForecastAdjustmentWindCanaryTransferReport({
        bridgeEndExclusive: new Date(Date.parse(bridgeEndInclusive) + 1).toISOString(),
        bridgeEvaluations: fitted.map((item) => ({
            metricBand: item.pair,
            network: item.score,
        })),
        bridgeStartInclusive,
        candidate,
    });
    const authorization = createForecastAdjustmentWindCanaryAuthorization({
        ...input.authorization,
        candidate,
        transferReport,
    });
    const bundle = createForecastAdjustmentWindCanaryRuntimeBundle({
        authorization,
        candidate,
        transferReport,
    });
    return deepFreeze({
        accessTrace: [...accessTrace, "wind_canary_bundle_ready"],
        authorization,
        bundle,
        candidate,
        contractVersion: "forecast-adjustment-retained-wind-canary-result/v1",
        snapshotManifestSha256,
        transferReport,
    });
}
// enumerate the frozen thirty-five research pairs
const FULL_HISTORY_RESEARCH_METRIC_BANDS = FORECAST_LEAD_BANDS.flatMap(
// expand every lead band's supported metrics
(leadBand) => FORECAST_ADJUSTMENT_METRICS.map(
// bind one metric to the current band
(metric) => ({
    leadBand: leadBand.key,
    metric,
})));
// fit one inactive model from independently verified bounded exports
export async function fitRetainedForecastAdjustmentFullHistoryResearch(input) {
    const { expectedRange, snapshots, snapshotIdentitySha256, fixedEvents, liveEvents, liveFirstRow, liveLastRow, } = await readRetainedResearchEvents(input);
    const liveStartLocalDate = localCalendarFeaturesFor(liveFirstRow.validAt).localDate;
    const archiveScoreEndLocalDate = addLocalCalendarDays(liveStartLocalDate, -1);
    const archiveScoreStartLocalDate = addLocalCalendarDays(archiveScoreEndLocalDate, -29);
    const archiveScoreDates = inclusiveLocalDates(archiveScoreStartLocalDate, archiveScoreEndLocalDate);
    // isolate the consumed archive score window
    const archiveScoreEvents = fixedEvents.filter((event) => archiveScoreDates.includes(event.localDate));
    // stop fitting before the seven-date archive embargo
    const archiveTrainingEvents = fixedEvents.filter((event) => event.localDate < addLocalCalendarDays(archiveScoreStartLocalDate, -7));
    const archiveDiagnostic = createFullHistoryResearchDiagnostic({
        cohort: "fixed_lead_anchor",
        scoreEndInclusive: maximumEventInstant(archiveScoreEvents, "archive diagnostic score"),
        scoreEvents: archiveScoreEvents,
        scoreLocalDates: archiveScoreDates,
        scoreStartInclusive: minimumEventInstant(archiveScoreEvents, "archive diagnostic score"),
        trainingEvents: archiveTrainingEvents,
    });
    const liveScoreDates = inclusiveLocalDates(liveStartLocalDate, localCalendarFeaturesFor(liveLastRow.validAt).localDate);
    const liveV4Diagnostic = createFullHistoryResearchDiagnostic({
        cohort: "legacy_v4_retrieval_snapshot",
        scoreEndInclusive: liveLastRow.validAt,
        scoreEvents: liveEvents,
        scoreLocalDates: liveScoreDates,
        scoreStartInclusive: liveFirstRow.validAt,
        // stop fitting before the seven-date live embargo
        trainingEvents: fixedEvents.filter((event) => event.localDate < addLocalCalendarDays(liveStartLocalDate, -7)),
    });
    const fitted = fitFullHistoryResearchPairs(fixedEvents, true);
    // flatten deterministic pair-order coefficients
    const coefficients = fitted.flatMap((item) => item.coefficients);
    // omit direction's inapplicable scalar envelope
    const trainingEnvelopes = fitted.flatMap((item) => item.trainingEnvelope === null ? [] : [item.trainingEnvelope]);
    const coefficientPayloadSha256 = canonicalSha256(coefficients);
    const [fitterModuleBytes, algorithmModuleBytes, calendarModuleBytes, domainModuleBytes] = await Promise.all([
        readFile(new URL("./evidence.js", import.meta.url)),
        readFile(new URL("./algorithm-v1.js", import.meta.url)),
        readFile(new URL("./calendar.js", import.meta.url)),
        readFile(new URL("./forecast-adjustment.js", import.meta.resolve("@weather/domain"))),
    ]);
    const fitterModuleSha256 = sha256(fitterModuleBytes);
    const algorithmModuleSha256 = sha256(algorithmModuleBytes);
    const calendarModuleSha256 = sha256(calendarModuleBytes);
    const domainModuleSha256 = sha256(domainModuleBytes);
    const algorithmIdentity = {
        algorithmContractVersion: FORECAST_ADJUSTMENT_ALGORITHM_VERSION,
        algorithmModuleSha256,
        calendarModuleSha256,
        domainModuleSha256,
        fitterModuleSha256,
        implementationSha256: canonicalSha256({
            algorithmContractVersion: FORECAST_ADJUSTMENT_ALGORITHM_VERSION,
            algorithmModuleSha256,
            calendarModuleSha256,
            domainModuleSha256,
            fitterModuleSha256,
            implementationVersion: "forecast-adjustment-full-history-research/v1",
        }),
        implementationVersion: "forecast-adjustment-full-history-research/v1",
    };
    // bind every independent child manifest
    const snapshotBindings = snapshots.map((snapshot) => ({
        fromLocalDate: snapshot.manifest.fromLocalDate,
        manifestSha256: snapshot.manifestSha256,
        toLocalDate: snapshot.manifest.toLocalDate,
        totalRowCount: snapshot.manifest.totalRowCount,
    }));
    const servedForecastIdentity = servedForecastIdentityForResearch(liveFirstRow);
    const expectedLocalDates = inclusiveLocalDates(expectedRange.fromLocalDate, expectedRange.toLocalDate);
    // retain each date with matched fixed-anchor support
    const fixedAnchorLocalDates = new Set(fixedEvents.map((event) => event.localDate));
    // expose rather than impute complete-history gaps
    const fixedAnchorMissingLocalDates = expectedLocalDates.filter((localDate) => !fixedAnchorLocalDates.has(localDate));
    const unsigned = {
        algorithmIdentity,
        archiveDiagnostic,
        coefficientPayloadSha256,
        coefficients,
        contractVersion: "forecast-adjustment-full-history-research-result/v1",
        expectedRange,
        finalFit: {
            exactModelIndependentlyValidated: false,
            finalTrainingCutoff: maximumEventInstant(fixedEvents, "final research fit"),
            fixedAnchorMissingLocalDateCount: fixedAnchorMissingLocalDates.length,
            fixedAnchorMissingLocalDates,
            fixedAnchorObservedLocalDateCount: fixedAnchorLocalDates.size,
            // preserve metric-specific calendar gaps beside matched counts
            metricBands: fitted.map((item) => {
                // retain each pair's matched date set
                const pairLocalDates = new Set(item.events.map((event) => event.localDate));
                // expose pair-specific missing dates
                const missingLocalDates = expectedLocalDates.filter((localDate) => !pairLocalDates.has(localDate));
                return {
                    eventCount: item.events.length,
                    firstLocalDate: minimumEventLocalDate(item.events),
                    lastLocalDate: maximumEventLocalDate(item.events),
                    metricBand: item.pair,
                    missingLocalDateCount: missingLocalDates.length,
                    missingLocalDates,
                };
            }),
            usesAllEligibleFixedAnchorHistory: true,
        },
        liveV4Diagnostic,
        productionActivationAllowed: false,
        promotable: false,
        qualificationStatus: "not_qualified",
        reasonCodes: [
            "research_artifact_only",
            "diagnostics_use_different_pre_refit_models",
            "exact_final_refit_not_independently_validated",
        ],
        runtimeBundleCreated: false,
        servedForecastIdentity,
        siteKey: "ballydidean",
        snapshotIdentitySha256,
        snapshotSetSemantics: "independent_read_only_exports_not_atomic_merged_snapshot",
        snapshots: snapshotBindings,
        timezone: "America/Los_Angeles",
        trainingEnvelopes,
        trainingForecastIdentity: FORECAST_ADJUSTMENT_WIND_CANARY_TRAINING_IDENTITY_V1,
    };
    return deepFreeze({
        ...unsigned,
        researchArtifactSha256: canonicalSha256(unsigned),
    });
}
// compare temperature lead corrections without creating a runtime artifact
export async function evaluateRetainedForecastAdjustmentTemperatureLeads(input) {
    const { expectedRange, snapshots, snapshotIdentitySha256, fixedEvents, liveEvents, liveFirstRow, } = await readRetainedResearchEvents(input);
    const liveStartLocalDate = localCalendarFeaturesFor(liveFirstRow.validAt).localDate;
    const embargoStartLocalDate = addLocalCalendarDays(liveStartLocalDate, -7);
    // freeze the baseline before the original live diagnostic embargo
    const trainingEvents = fixedEvents.filter((event) => event.metric === "temperatureC" && event.localDate < embargoStartLocalDate);
    // keep every matched temperature example including correction fallbacks
    const temperatureEvents = liveEvents.filter((event) => event.metric === "temperatureC");
    // require both genuine archive training and live score material
    if (trainingEvents.length === 0 || temperatureEvents.length === 0) {
        throw new RangeError("temperature lead research lacks matched temperature history");
    }
    // preserve truthful live retrieval timestamps
    const references = temperatureEvents.map((event) => {
        // reject a missing retrieval timestamp
        if (event.referenceAt === null) {
            throw new RangeError("temperature lead research lacks a forecast reference");
        }
        return event.referenceAt;
    }).sort(compareText);
    const earliestForecastReferenceAt = references[0];
    const finalTrainingCutoff = maximumEventInstant(trainingEvents, "temperature archive baseline");
    // prevent even the frozen baseline from seeing information after forecast issuance
    if (Date.parse(finalTrainingCutoff) + 3_600_000 > Date.parse(earliestForecastReferenceAt)) {
        throw new RangeError("temperature baseline crosses the earliest forecast reference");
    }
    // retain the existing capped archive estimator separately for each broad band
    const fitted = fitTemperatureResearchBaseline(trainingEvents);
    // index fitted broad-band baselines
    const byBand = new Map(fitted.map((fit) => [fit.pair.leadBand, fit]));
    const coverage = { adjusted: 0, missingCoefficient: 0, outsideTrainingEnvelope: 0 };
    // use the same temperature examples for every comparison strategy
    const examples = temperatureEvents.map((event) => {
        const fit = byBand.get(event.leadBand);
        // require the complete configured lead inventory
        if (fit === undefined || event.referenceAt === null) {
            throw new RangeError("temperature lead research event identity is incomplete");
        }
        const coefficient = selectHierarchyCoefficient(fit.coefficients, "temperatureC", event.leadBand, localCalendarFeaturesFor(event.validAt));
        const outsideEnvelope = fit.trainingEnvelope !== null && (event.rawForecast < fit.trainingEnvelope.minimum || event.rawForecast > fit.trainingEnvelope.maximum);
        let baselineAdjusted = event.rawForecast;
        // count unavailable corrections rather than dropping their score rows
        if (coefficient === null || fit.trainingEnvelope === null) {
            coverage.missingCoefficient += 1;
        }
        else if (outsideEnvelope) {
            // preserve the raw out-of-envelope fallback
            coverage.outsideTrainingEnvelope += 1;
        }
        else {
            // apply only the existing bounded correction
            coverage.adjusted += 1;
            baselineAdjusted = applyCappedCorrection("temperatureC", event.rawForecast, coefficient);
        }
        return {
            actual: event.actual,
            baselineAdjusted,
            rawForecast: event.rawForecast,
            referenceAt: event.referenceAt,
            targetLeadHours: event.targetLeadHours,
            validAt: event.validAt,
        };
    });
    const analysis = analyzeTemperatureLeadResearch(examples);
    const moduleNames = ["evidence.js", "algorithm-v1.js", "calendar.js", "temperature-lead-research.js"];
    // bind the exact frozen built modules used for this run
    const implementationModules = await Promise.all(moduleNames.map(async (name) => ({
        name,
        sha256: sha256(await readFile(new URL(`./${name}`, import.meta.url))),
    })));
    // bind domain lead boundaries and correction caps as well as the scorer
    implementationModules.push({
        name: "@weather/domain/forecast-adjustment.js",
        sha256: sha256(await readFile(new URL("./forecast-adjustment.js", import.meta.resolve("@weather/domain")))),
    });
    const unsigned = {
        analysis,
        baseline: {
            coverage,
            earliestForecastReferenceAt,
            embargoStartLocalDate,
            finalTrainingCutoff,
            fitted,
            modelSha256: canonicalSha256(fitted),
            trainingCohort: "fixed_lead_anchor",
        },
        contractVersion: "forecast-adjustment-retained-temperature-lead-research/v1",
        expectedRange,
        implementationModules,
        interpretation: "exploratory_consumed_dates_pseudo_real_time_not_qualification",
        productionActivationAllowed: false,
        promotable: false,
        runtimeBundleCreated: false,
        servedForecastIdentity: servedForecastIdentityForResearch(liveFirstRow),
        snapshotIdentitySha256,
        // preserve independent export bindings rather than fabricating an atomic snapshot
        snapshots: snapshots.map((snapshot) => ({
            fromLocalDate: snapshot.manifest.fromLocalDate,
            manifestSha256: snapshot.manifestSha256,
            toLocalDate: snapshot.manifest.toLocalDate,
            totalRowCount: snapshot.manifest.totalRowCount,
        })),
    };
    return deepFreeze({
        ...unsigned,
        researchArtifactSha256: canonicalSha256(unsigned),
    });
}
// compare frozen weather refinements across seasonal archive and live windows
export async function evaluateRetainedForecastAdjustmentTemperatureWeather(input) {
    return evaluateRetainedTemperatureWeatherResearch(input, analyzeTemperatureWeatherResearch, "forecast-adjustment-retained-temperature-weather-research/v1");
}
// evaluate one fixed near-term raw gate without changing the original weather report
export async function evaluateRetainedForecastAdjustmentTemperatureWeatherHorizon(input) {
    return evaluateRetainedTemperatureWeatherResearch(input, analyzeTemperatureWeatherHorizonResearch, "forecast-adjustment-retained-temperature-weather-horizon-research/v1");
}
// isolate the existing raw-start temperature stage without refitting or gating
export async function evaluateRetainedForecastAdjustmentTemperatureOnly(input) {
    return evaluateRetainedTemperatureWeatherResearch(input, analyzeTemperatureOnlyResearch, "forecast-adjustment-retained-temperature-only-research/v1");
}
// replay live-only correction strength without inventing archive retrieval times
export async function evaluateRetainedForecastAdjustmentTemperatureWeatherAdaptive(input) {
    return evaluateRetainedTemperatureWeatherResearch(input, analyzeTemperatureWeatherAdaptiveResearch, "forecast-adjustment-retained-temperature-weather-adaptive-research/v1");
}
// combine frozen near-term adaptation with the full longer-range correction
export async function evaluateRetainedForecastAdjustmentTemperatureWeatherHybrid(input) {
    return evaluateRetainedTemperatureWeatherResearch(input, analyzeTemperatureWeatherHybridResearch, "forecast-adjustment-retained-temperature-weather-hybrid-research/v1");
}
// halve only the frozen weather component before cumulative clipping
export async function evaluateRetainedForecastAdjustmentTemperatureWeatherShrinkage(input) {
    return evaluateRetainedTemperatureWeatherResearch(input, analyzeTemperatureWeatherShrinkageResearch, "forecast-adjustment-retained-temperature-weather-shrinkage-research/v1");
}
// compare a fixed recent-year refinement fit with the original full-history model
export async function evaluateRetainedForecastAdjustmentTemperatureWeatherRecency(input) {
    return evaluateRetainedTemperatureWeatherResearch(input, analyzeTemperatureWeatherRecencyResearch, "forecast-adjustment-retained-temperature-weather-recency-research/v1");
}
// evaluate one externally fitted tree challenger on the unchanged retained cohorts
export async function evaluateRetainedForecastAdjustmentTemperatureBoosted(input) {
    return evaluateRetainedTemperatureBoostedResearch(input, analyzeTemperatureBoostedResearch, "forecast-adjustment-retained-temperature-boosted-research/v1");
}
// combine unchanged near-term adaptation with a retained longer-range tree
export async function evaluateRetainedForecastAdjustmentTemperatureBoostedHybrid(input) {
    return evaluateRetainedTemperatureBoostedResearch(input, analyzeTemperatureBoostedHybridResearch, "forecast-adjustment-retained-temperature-boosted-hybrid-research/v1");
}
// test first-twelve-hour error persistence without changing later forecasts
export async function evaluateRetainedForecastAdjustmentTemperatureNearNowcast(input) {
    const onPrivatePredictionAudit = input.onPrivatePredictionAudit;
    // reject an invalid private sink before any retained filesystem reads
    if (onPrivatePredictionAudit !== undefined && typeof onPrivatePredictionAudit !== "function") {
        throw new RangeError("near nowcast private audit callback must be a function");
    }
    return evaluateRetainedTemperatureBoostedResearch(input, 
    // preserve the captured private callback across every retained await
    (examples) => analyzeTemperatureNearNowcastResearch({
        ...examples,
        ...(onPrivatePredictionAudit === undefined ? {} : { onPrivatePredictionAudit }),
    }), "forecast-adjustment-retained-temperature-near-nowcast-research/v1");
}
// capture the common isolated implementation before any retained filesystem await
async function evaluateRetainedTemperatureBoostedResearch(input, analyze, contractVersion) {
    const trainer = input.trainer;
    const trainerIdentity = { ...input.trainerIdentity };
    // reject an unbound research implementation before reading snapshots
    if (typeof trainer !== "function" ||
        trainerIdentity.contractVersion !== "temperature-boosted-python-bridge/v1" ||
        !HASH_PATTERN.test(trainerIdentity.runtimeSha256) ||
        !HASH_PATTERN.test(trainerIdentity.sourceSha256) ||
        !HASH_PATTERN.test(trainerIdentity.parametersSha256) ||
        Object.keys(trainerIdentity).sort().join("|") !==
            "contractVersion|parametersSha256|runtimeSha256|sourceSha256") {
        throw new RangeError("boosted research requires a bound isolated trainer");
    }
    return evaluateRetainedTemperatureWeatherResearch(input, 
    // preserve the captured callback across retained filesystem awaits
    (examples) => analyze({ ...examples, trainer }), contractVersion, trainerIdentity);
}
// share retained inputs, chronological fits and evidence binding across fixed experiments
async function evaluateRetainedTemperatureWeatherResearch(input, analyze, contractVersion, externalTrainer) {
    const experimentPlanSha256 = input.experimentPlanSha256;
    // bind the externally retained pre-analysis policy without authorizing promotion
    if (!HASH_PATTERN.test(experimentPlanSha256)) {
        throw new RangeError("temperature weather research requires an experiment plan hash");
    }
    const material = await readRetainedResearchEvents(input);
    const liveStartLocalDate = localCalendarFeaturesFor(material.liveFirstRow.validAt).localDate;
    const liveEndLocalDate = localCalendarFeaturesFor(material.liveLastRow.validAt).localDate;
    // isolate the target while retaining predictors from its exact selected forecast row
    const fixedTemperatureEvents = material.fixedEvents.filter((event) => event.metric === "temperatureC");
    // preserve every matched live temperature forecast
    const liveTemperatureEvents = material.liveEvents.filter((event) => event.metric === "temperatureC");
    const archiveWindows = [
        { key: "winter-2025", fromLocalDate: "2025-01-01", toLocalDate: "2025-01-30" },
        { key: "spring-2025", fromLocalDate: "2025-04-01", toLocalDate: "2025-04-30" },
        { key: "summer-2025", fromLocalDate: "2025-07-01", toLocalDate: "2025-07-30" },
        { key: "autumn-2025", fromLocalDate: "2025-10-01", toLocalDate: "2025-10-30" },
        {
            key: "pre-live-30-days",
            fromLocalDate: addLocalCalendarDays(liveStartLocalDate, -30),
            toLocalDate: addLocalCalendarDays(liveStartLocalDate, -1),
        },
    ];
    // fit each archive diagnostic strictly before its own score interval
    const diagnostics = archiveWindows.map((window) => createTemperatureWeatherDiagnostic({
        ...window,
        cohort: "fixed_lead_anchor",
        expectedRange: material.expectedRange,
        fixedTemperatureEvents,
        // retain the complete matched window without cherry-picking feature support
        scoreEvents: fixedTemperatureEvents.filter((event) => event.localDate >= window.fromLocalDate && event.localDate <= window.toLocalDate),
    }, analyze));
    diagnostics.push(createTemperatureWeatherDiagnostic({
        cohort: "legacy_v4_retrieval_snapshot",
        expectedRange: material.expectedRange,
        fixedTemperatureEvents,
        fromLocalDate: liveStartLocalDate,
        key: "live-v4",
        scoreEvents: liveTemperatureEvents,
        toLocalDate: liveEndLocalDate,
    }, analyze));
    const moduleNames = [
        "evidence.js",
        "algorithm-v1.js",
        "calendar.js",
        "candidate.js",
        "wind-canary.js",
        "temperature-lead-research.js",
        "temperature-weather-research.js",
        "temperature-nowcast-research.js",
    ];
    // bind the research pipeline and its shared numerical/scoring dependencies
    const implementationModules = await Promise.all(moduleNames.map(async (name) => ({
        name,
        sha256: sha256(await readFile(new URL(`./${name}`, import.meta.url))),
    })));
    // bind the domain's policy and canonical serialization implementation
    for (const name of ["forecast-adjustment.js", "provenance.js"]) {
        implementationModules.push({
            name: `@weather/domain/${name}`,
            sha256: sha256(await readFile(new URL(`./${name}`, import.meta.resolve("@weather/domain")))),
        });
    }
    const runtime = { nodeVersion: process.versions.node, ...runtimeCalendarFingerprint() };
    // preserve original identities while binding the optional isolated learner
    const externalImplementation = externalTrainer === undefined ? {} : { externalTrainer };
    const unsigned = {
        contractVersion,
        diagnostics,
        expectedRange: material.expectedRange,
        experimentPlanSha256,
        implementationIdentitySha256: canonicalSha256({
            implementationModules,
            runtime,
            ...externalImplementation,
        }),
        implementationModules,
        ...externalImplementation,
        interpretation: "fixed_exploratory_comparisons_on_consumed_dates_not_qualification",
        predictorSource: "exact_selected_temperature_forecast_row_not_observations",
        productionActivationAllowed: false,
        promotable: false,
        runtime,
        runtimeBundleCreated: false,
        servedForecastIdentity: servedForecastIdentityForResearch(material.liveFirstRow),
        snapshotIdentitySha256: material.snapshotIdentitySha256,
        snapshotSetSemantics: "independent_read_only_exports_not_atomic_merged_snapshot",
        // retain every independently verified child identity
        snapshots: material.snapshots.map((snapshot) => ({
            fromLocalDate: snapshot.manifest.fromLocalDate,
            manifestSha256: snapshot.manifestSha256,
            toLocalDate: snapshot.manifest.toLocalDate,
            totalRowCount: snapshot.manifest.totalRowCount,
        })),
    };
    return deepFreeze({
        ...unsigned,
        researchArtifactSha256: canonicalSha256(unsigned),
    });
}
// fit one independent pre-window model and retain complete fallback coverage
function createTemperatureWeatherDiagnostic(input, analyze) {
    const embargoStartLocalDate = addLocalCalendarDays(input.fromLocalDate, -7);
    let informationBoundaryMilliseconds = Number.POSITIVE_INFINITY;
    // constrain training against every forecast's actual or conservative information boundary
    for (const event of input.scoreEvents) {
        // require truthful live retrieval provenance
        if (input.cohort === "legacy_v4_retrieval_snapshot" && event.referenceAt === null) {
            throw new RangeError("weather diagnostic live forecast reference is missing");
        }
        const boundary = event.referenceAt === null
            ? Date.parse(event.validAt) - event.targetLeadHours * 3_600_000
            : Date.parse(event.referenceAt);
        informationBoundaryMilliseconds = Math.min(informationBoundaryMilliseconds, boundary);
    }
    // enforce both the local-date embargo and the UTC observation-availability boundary
    const trainingEvents = input.fixedTemperatureEvents.filter((event) => event.localDate < embargoStartLocalDate &&
        Date.parse(event.validAt) + 3_600_000 <= informationBoundaryMilliseconds);
    const fitted = fitTemperatureResearchBaseline(trainingEvents);
    const training = temperatureWeatherExamples(trainingEvents, fitted);
    const scoring = temperatureWeatherExamples(input.scoreEvents, fitted);
    const analysis = analyze({
        scoreCohort: input.cohort,
        scoreEvents: scoring.examples,
        trainingEvents: training.examples,
    });
    const finalTrainingCutoff = trainingEvents.length === 0
        ? null
        : maximumEventInstant(trainingEvents, "weather diagnostic training");
    const scoreLocalDates = inclusiveLocalDates(input.fromLocalDate, input.toLocalDate);
    // identify missing dates without imputing or dropping score examples
    const observedScoreDates = new Set(input.scoreEvents.map((event) => event.localDate));
    // retain explicit missing-window coverage
    const missingScoreLocalDates = scoreLocalDates.filter((date) => !observedScoreDates.has(date));
    const snapshotRangeCoversWindow = input.expectedRange.fromLocalDate <= input.fromLocalDate &&
        input.expectedRange.toLocalDate >= input.toLocalDate;
    return {
        analysis,
        baseline: {
            finalTrainingCutoff,
            fitted,
            modelSha256: canonicalSha256(fitted),
            scoreCoverage: scoring.coverage,
            trainingCoverage: training.coverage,
        },
        cohort: input.cohort,
        embargoEndLocalDate: addLocalCalendarDays(input.fromLocalDate, -1),
        embargoStartLocalDate,
        fromLocalDate: input.fromLocalDate,
        informationBoundaryAt: Number.isFinite(informationBoundaryMilliseconds)
            ? new Date(informationBoundaryMilliseconds).toISOString()
            : null,
        informationBoundaryKind: input.cohort === "fixed_lead_anchor"
            ? "validAt_minus_targetLead_not_observed_issue_timestamp"
            : "observed_forecast_retrieval",
        key: input.key,
        missingScoreLocalDates,
        observedScoreLocalDateCount: observedScoreDates.size,
        refinementModelSha256: canonicalSha256(analysis.models),
        snapshotRangeCoversWindow,
        toLocalDate: input.toLocalDate,
        trainingBeforeInformationBoundary: finalTrainingCutoff === null ||
            Date.parse(finalTrainingCutoff) + 3_600_000 <= informationBoundaryMilliseconds,
    };
}
// retain exact-row forecast features and the existing raw-fallback policy
function temperatureWeatherExamples(events, fitted) {
    // index the complete seven-band baseline inventory
    const byBand = new Map(fitted.map((fit) => [fit.pair.leadBand, fit]));
    const coverage = { adjusted: 0, missingCoefficient: 0, outsideTrainingEnvelope: 0 };
    // project predictors only from the selected temperature forecast material
    const examples = events.map((event) => {
        const fit = byBand.get(event.leadBand);
        // reject a broken internal target or band contract
        if (event.metric !== "temperatureC" || fit === undefined) {
            throw new RangeError("weather research requires matched temperature events");
        }
        const coefficient = selectHierarchyCoefficient(fit.coefficients, "temperatureC", event.leadBand, localCalendarFeaturesFor(event.validAt));
        let baselineEligible = false;
        let baselineAdjusted = event.rawForecast;
        // preserve missing baseline support as raw output
        if (coefficient === null || fit.trainingEnvelope === null) {
            coverage.missingCoefficient += 1;
        }
        else if (event.rawForecast < fit.trainingEnvelope.minimum || event.rawForecast > fit.trainingEnvelope.maximum) {
            // retain out-of-envelope examples in every strategy denominator
            coverage.outsideTrainingEnvelope += 1;
        }
        else {
            // apply only the unchanged capped calendar correction
            coverage.adjusted += 1;
            baselineEligible = true;
            baselineAdjusted = applyCappedCorrection("temperatureC", event.rawForecast, coefficient);
        }
        return {
            actual: event.actual,
            baselineAdjusted,
            baselineEligible,
            rawForecast: event.rawForecast,
            rawRelativeHumidityPercent: event.rawForecastMetrics.relativeHumidityPercent,
            rawWindSpeedMps: event.rawForecastMetrics.windSpeedMps,
            referenceAt: event.referenceAt,
            targetLeadHours: event.targetLeadHours,
            validAt: event.validAt,
        };
    });
    return { coverage, examples };
}
// reuse the unchanged temperature baseline and its scalar envelopes
function fitTemperatureResearchBaseline(trainingEvents) {
    return FORECAST_LEAD_BANDS.map(
    // fit each broad-band archive baseline independently
    (band) => {
        const pair = { metric: "temperatureC", leadBand: band.key };
        // isolate only this exact archive endpoint
        const events = trainingEvents.filter((event) => event.leadBand === band.key);
        // fit an envelope only when this endpoint has training support
        return {
            pair,
            coefficients: fitEventHierarchy(events, pair),
            trainingEventCount: events.length,
            trainingEnvelope: events.length === 0 ? null : createTrainingEnvelope("temperatureC", band.key, events.map((event) => event.rawForecast)),
        };
    });
}
// share the unchanged verified reader without broadening its export boundary
async function readRetainedResearchEvents(input) {
    const expectedRange = {
        fromLocalDate: input.expectedRange.fromLocalDate,
        toLocalDate: input.expectedRange.toLocalDate,
    };
    const snapshotPaths = [...input.snapshotPaths];
    const evidenceRoot = await requireCanonicalDirectory(input.evidenceRoot, "research evidence root");
    // require a genuinely segmented multi-export history
    if (snapshotPaths.length < 2 ||
        new Set(snapshotPaths).size !== snapshotPaths.length) {
        throw new RangeError("full-history research requires multiple unique snapshots");
    }
    const snapshots = [];
    // verify each independent package control plane
    for (const snapshotPath of snapshotPaths) {
        snapshots.push(await readRetainedFullHistoryResearchSnapshotControl(evidenceRoot, snapshotPath));
    }
    validateLocalDateRange(expectedRange.fromLocalDate, expectedRange.toLocalDate);
    validateFullHistoryResearchSnapshotSet(snapshots, expectedRange);
    const snapshotIdentitySha256 = fullHistoryResearchSnapshotIdentitySha256(snapshots[0]?.manifest);
    const fixedEvents = [];
    const liveEvents = [];
    let liveFirstRow;
    let liveLastRow;
    // parse complete local dates so station and forecast collision handling stays atomic
    for (const snapshot of snapshots) {
        const observedSourceIdentities = new Map();
        // enumerate declared member dates once
        const localDates = [...new Set(snapshot.manifest.members.map((member) => member.localDate))].sort(compareText);
        // build events without retaining the full raw export corpus in memory
        for (const localDate of localDates) {
            // retain all same-date shards for collision handling
            const dateMembers = snapshot.manifest.members.filter((member) => member.localDate === localDate);
            const rows = await readSnapshotPhaseRows(snapshot.snapshotRoot, dateMembers, "research", []);
            // reconstruct the package's observed identity inventory from verified rows
            for (const row of rows) {
                // pair each source with its aligned provenance fields
                for (let index = 0; index < row.sourceKeys.length; index += 1) {
                    const sourceKey = row.sourceKeys[index];
                    const sourceConfigFingerprint = row.sourceConfigFingerprints[index];
                    observedSourceIdentities.set(`${sourceKey}:${sourceConfigFingerprint}`, {
                        adapterContract: row.adapterContracts[index],
                        sourceConfigFingerprint,
                        sourceKey,
                    });
                }
            }
            fixedEvents.push(...buildRetainedTrainingEvents(rows, "fixed_lead_anchor", FORECAST_ADJUSTMENT_METRICS).map(compactFullHistoryResearchEvent));
            // isolate live rows for boundary identity
            const liveRows = rows.filter((row) => row.recordKind === "legacy_v4_retrieval_snapshot").sort((left, right) => left.validAt.localeCompare(right.validAt));
            liveEvents.push(...buildRetainedTrainingEvents(rows, "legacy_v4_retrieval_snapshot", FORECAST_ADJUSTMENT_METRICS).map(compactFullHistoryResearchEvent));
            // retain the exact live cohort boundary and served identity
            if (liveRows.length > 0) {
                liveFirstRow ??= liveRows[0];
                liveLastRow = liveRows.at(-1);
            }
        }
        // stabilize the reconstructed source inventory
        const observed = [...observedSourceIdentities.values()].sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));
        // require row-derived sources to match each independent manifest exactly
        if (canonicalizeJson(observed) !==
            canonicalizeJson(snapshot.manifest.observedSourceIdentities)) {
            throw new RangeError("full-history research observed source inventory mismatch");
        }
    }
    // require both the complete fixed training cohort and a live transfer cohort
    if (fixedEvents.length === 0 ||
        liveEvents.length === 0 ||
        liveFirstRow === undefined ||
        liveLastRow === undefined) {
        throw new RangeError("full-history research requires fixed-anchor and live-v4 matched events");
    }
    return {
        expectedRange,
        snapshots,
        snapshotIdentitySha256,
        fixedEvents,
        liveEvents,
        liveFirstRow,
        liveLastRow,
    };
}
// read and verify one bounded research snapshot control plane
async function readRetainedFullHistoryResearchSnapshotControl(evidenceRoot, snapshotPath) {
    const snapshotRoot = await requireCanonicalDirectory(snapshotPath, "research snapshot");
    // require every decrypted snapshot below the caller's external root
    if (!snapshotRoot.startsWith(`${evidenceRoot}${sep}`)) {
        throw new RangeError("research snapshot is outside the evidence root");
    }
    const manifestBytes = await readVerifiedRegularFile(join(snapshotRoot, "manifest.json"), snapshotRoot, "research snapshot manifest");
    const checksumBytes = await readVerifiedRegularFile(join(snapshotRoot, "manifest.sha256"), snapshotRoot, "research snapshot checksum");
    const manifestText = manifestBytes.toString("utf8");
    const manifestSha256 = sha256(manifestBytes);
    // bind canonical bytes, checksum file, and directory identity
    if (checksumBytes.toString("utf8") !== `${manifestSha256}  manifest.json\n` ||
        basename(snapshotRoot) !== manifestSha256) {
        throw new RangeError("research snapshot manifest identity mismatch");
    }
    const manifest = JSON.parse(manifestText);
    // reject noncanonical manifests before member access
    if (manifestText !== canonicalJsonBytes(manifest)) {
        throw new RangeError("research snapshot manifest is not canonical JSON");
    }
    validateSnapshotManifestBoundary(manifest);
    // verify each declared member before reading row material
    for (const member of manifest.members) {
        validateSnapshotMember(member, snapshotRoot);
        // bind every member to the declared package date range
        if (member.localDate < manifest.fromLocalDate ||
            member.localDate > manifest.toLocalDate) {
            throw new RangeError("research snapshot member is outside its date range");
        }
    }
    return { manifest, manifestSha256, snapshotRoot };
}
// require one chronological lineage-consistent snapshot sequence
function validateFullHistoryResearchSnapshotSet(snapshots, expectedRange) {
    const first = snapshots[0];
    // retain the compiler-proven first package
    if (first === undefined) {
        throw new RangeError("full-history research snapshot set is empty");
    }
    const identitySha256 = fullHistoryResearchSnapshotIdentitySha256(first.manifest);
    const last = snapshots.at(-1);
    // bind the exact operator-requested production history interval
    if (first.manifest.fromLocalDate !== expectedRange.fromLocalDate ||
        last.manifest.toLocalDate !== expectedRange.toLocalDate) {
        throw new RangeError("full-history research snapshots do not cover the expected range");
    }
    // compare each caller-ordered bounded package
    for (let index = 0; index < snapshots.length; index += 1) {
        const snapshot = snapshots[index];
        const previous = snapshots[index - 1];
        // reject query, schema, provenance, site, or declared-source drift
        if (fullHistoryResearchSnapshotIdentitySha256(snapshot.manifest) !==
            identitySha256) {
            throw new RangeError("full-history research snapshot identity drift");
        }
        validateObservedResearchSourceIdentities(snapshot.manifest);
        // require exact chronological adjacency without overlap or gaps
        if (previous !== undefined &&
            addLocalCalendarDays(previous.manifest.toLocalDate, 1) !==
                snapshot.manifest.fromLocalDate) {
            throw new RangeError("full-history research snapshots must be chronological and contiguous");
        }
    }
}
// hash the identities that must remain stable across independent exports
function fullHistoryResearchSnapshotIdentitySha256(manifest) {
    return canonicalSha256({
        aggregationContractSha256: manifest.aggregationContractSha256,
        coordinateManifestSha256: manifest.coordinateManifestSha256,
        databaseManifest: manifest.databaseManifest,
        metricEligibilitySha256: manifest.metricEligibilitySha256,
        migrationHistorySha256: manifest.migrationHistorySha256,
        queryContractSha256: manifest.queryContractSha256,
        queryContractVersion: manifest.queryContractVersion,
        rowSchemaSha256: manifest.rowSchemaSha256,
        siteKey: manifest.siteKey,
        siteTimezone: manifest.siteTimezone,
        sourceIdentities: manifest.sourceIdentities,
        sourceLineageSha256: manifest.sourceLineageSha256,
        spatialWeightsSha256: manifest.spatialWeightsSha256,
        stationManifestSha256: manifest.stationManifestSha256,
    });
}
// bind observed source identities to the snapshot's frozen source catalog
function validateObservedResearchSourceIdentities(manifest) {
    // canonicalize the frozen declared catalog
    const declared = new Set(manifest.sourceIdentities.map((identity) => canonicalizeJson(identity)));
    // reject any observed source identity outside the declared lineage
    if (manifest.observedSourceIdentities.some((identity) => !declared.has(canonicalizeJson(identity)))) {
        throw new RangeError("full-history research observed source identity drift");
    }
}
// fit every supported metric and lead band from exact event material
function fitFullHistoryResearchPairs(events, requireEveryPair) {
    // fit every pair in one frozen order
    const fitted = FULL_HISTORY_RESEARCH_METRIC_BANDS.map((pair) => {
        // isolate exact metric-band events
        const pairEvents = events.filter((event) => event.metric === pair.metric && event.leadBand === pair.leadBand);
        const coefficients = fitEventHierarchy(pairEvents, pair);
        // derive only applicable nonempty scalar envelopes
        const trainingEnvelope = pair.metric === "windDirectionDegrees" || pairEvents.length === 0
            ? null
            : createTrainingEnvelope(pair.metric, pair.leadBand, pairEvents.map((event) => event.rawForecast));
        return { coefficients, events: pairEvents, pair, trainingEnvelope };
    });
    // require literal root support for all thirty-five final-fit pairs
    if (requireEveryPair &&
        fitted.some((item) => !item.coefficients.some((coefficient) => coefficient.level === 1))) {
        throw new RangeError("full-history research lacks root support for every metric and lead band");
    }
    return fitted;
}
// fit and score one consumed descriptive out-of-time window
function createFullHistoryResearchDiagnostic(input) {
    const fitted = fitFullHistoryResearchPairs(input.trainingEvents, false);
    const trainingEventMaximumValidAt = maximumEventInstant(input.trainingEvents, `${input.cohort} diagnostic training`);
    const scoreStartLocalDate = input.scoreLocalDates[0];
    const scoreEndLocalDate = input.scoreLocalDates.at(-1);
    // retain the compiler-proven score window
    if (scoreStartLocalDate === undefined || scoreEndLocalDate === undefined) {
        throw new RangeError("full-history research diagnostic score window is empty");
    }
    const embargoStartLocalDate = addLocalCalendarDays(scoreStartLocalDate, -7);
    // reject any diagnostic fit that crosses the seven-date embargo
    if (localCalendarFeaturesFor(trainingEventMaximumValidAt).localDate >=
        embargoStartLocalDate) {
        throw new RangeError("full-history research diagnostic has temporal leakage");
    }
    // score every diagnostic pair without promotion gates
    const scores = fitted.map((item) => {
        // retain all network matches before envelope scoring
        const matchedEvents = input.scoreEvents.filter((event) => event.metric === item.pair.metric &&
            event.leadBand === item.pair.leadBand);
        // require the literal hierarchy root
        const modelFitted = item.coefficients.some((coefficient) => coefficient.level === 1);
        const scoredEvents = modelFitted
            ? scoreFittedCanaryBridgeEvents(item.coefficients, matchedEvents, item.pair, item.trainingEnvelope)
            : [];
        const losses = scoredEvents.length === 0
            ? null
            : pairedLoss(scoredEvents, item.pair.metric === "windDirectionDegrees");
        return {
            adjustedLoss: losses?.adjustedLoss ?? null,
            eventCount: scoredEvents.length,
            matchedNetworkEventCount: matchedEvents.length,
            metricBand: item.pair,
            modelFitted,
            rawLoss: losses?.rawLoss ?? null,
            skill: losses?.skill ?? null,
        };
    });
    // collect every date with any matched diagnostic event
    const scoreEventDates = new Set(input.scoreEvents.map((event) => event.localDate));
    // expose missing diagnostic dates
    const scoreMissingLocalDates = input.scoreLocalDates.filter((localDate) => !scoreEventDates.has(localDate));
    // bind every different pre-refit diagnostic model
    const diagnosticModelSha256 = canonicalSha256({
        cohort: input.cohort,
        fitted: fitted.map((item) => ({
            coefficients: item.coefficients,
            metricBand: item.pair,
            trainingEnvelope: item.trainingEnvelope,
        })),
        trainingEventMaximumValidAt,
    });
    return deepFreeze({
        cohort: input.cohort,
        diagnosticModelSha256,
        embargoEndLocalDate: addLocalCalendarDays(scoreStartLocalDate, -1),
        embargoStartLocalDate,
        interpretation: "descriptive_only_consumed_dates_not_qualification",
        relationshipToFinalFit: "different_pre_refit_model",
        scoreEndInclusive: input.scoreEndInclusive,
        scoreEndLocalDate,
        scoreMissingLocalDateCount: scoreMissingLocalDates.length,
        scoreMissingLocalDates,
        scoreStartInclusive: input.scoreStartInclusive,
        scoreStartLocalDate,
        scores,
        trainingEndLocalDate: addLocalCalendarDays(embargoStartLocalDate, -1),
        trainingEventMaximumValidAt,
    });
}
const EMPTY_RESEARCH_STATION_ROWS = [];
// release raw station rows after their network actual is derived
function compactFullHistoryResearchEvent(event) {
    return { ...event, stationRows: EMPTY_RESEARCH_STATION_ROWS };
}
// project one exact served live-v4 identity
function servedForecastIdentityForResearch(row) {
    return {
        adapterVersion: row.adapterVersion,
        cohort: "legacy_v4_retrieval_snapshot",
        contractEpoch: row.contractEpoch,
        dataset: row.dataset,
        referenceKind: "retrieval_snapshot",
        sourceConfigFingerprint: row.sourceConfigFingerprints[0],
        sourceKey: row.sourceKeys[0],
        upstreamModel: row.upstreamModel,
    };
}
// select the earliest event instant
function minimumEventInstant(events, description) {
    // order exact event instants
    const value = events.map((event) => event.validAt).sort(compareText)[0];
    // reject empty event windows
    if (value === undefined) {
        throw new RangeError(`${description} lacks matched network events`);
    }
    return value;
}
// select the latest event instant
function maximumEventInstant(events, description) {
    // order exact event instants
    const value = events.map((event) => event.validAt).sort(compareText).at(-1);
    // reject empty event windows
    if (value === undefined) {
        throw new RangeError(`${description} lacks matched network events`);
    }
    return value;
}
// select the earliest event local date
function minimumEventLocalDate(events) {
    // order exact local dates
    return events.map((event) => event.localDate).sort(compareText)[0];
}
// select the latest event local date
function maximumEventLocalDate(events) {
    // order exact local dates
    return events.map((event) => event.localDate).sort(compareText).at(-1);
}
// parse one authorized phase of compressed date shards through the core boundary
async function readSnapshotPhaseRows(snapshotRoot, members, phase, accessTrace) {
    const rows = [];
    // open only the selected local-date phase members
    for (const member of members) {
        const compressed = await readVerifiedSnapshotMember(snapshotRoot, member.path, accessTrace, phase);
        // bind compressed bytes inside the authorized phase
        if (compressed.byteLength !== member.sizeBytes || sha256(compressed) !== member.sha256) {
            throw new RangeError("snapshot member checksum or size mismatch");
        }
        accessTrace.push(`${phase}_member_hash_verified:${member.path}`);
        const plaintext = gunzipSync(compressed);
        // require declared plaintext size and complete JSONL bytes
        if (plaintext.byteLength !== member.plaintextBytes ||
            !plaintext.toString("utf8").endsWith("\n")) {
            throw new RangeError("snapshot member plaintext boundary mismatch");
        }
        const lines = plaintext.toString("utf8").split("\n").filter(Boolean);
        // require the exact declared row cardinality
        if (lines.length !== member.rowCount) {
            throw new RangeError("snapshot member row count mismatch");
        }
        for (const line of lines) {
            const row = parseSanitizedTrainingExportRow(JSON.parse(line));
            const expectedRecordKind = member.recordKind === "station-hour"
                ? "station_hour"
                : member.recordKind === "fixed-lead-anchor"
                    ? "fixed_lead_anchor"
                    : "legacy_v4_retrieval_snapshot";
            // bind every row to its declared date, kind, and physical-station shard
            if (localCalendarFeaturesFor(row.validAt).localDate !== member.localDate ||
                row.recordKind !== expectedRecordKind ||
                (row.recordKind === "station_hour" &&
                    row.physicalStationKey !== member.stationKey) ||
                (row.recordKind !== "station_hour" && member.stationKey !== null)) {
                throw new RangeError("snapshot row does not match its member partition");
            }
            rows.push(row);
        }
        accessTrace.push(`${phase}_member_parsed:${member.path}`);
    }
    return deepFreeze(rows);
}
// require one absolute canonical directory
async function requireCanonicalDirectory(path, description) {
    const absolute = resolve(path);
    const canonical = await realpath(absolute);
    const metadata = await lstat(absolute);
    // reject aliases, links, and non-directories
    if (path !== absolute ||
        canonical !== absolute ||
        metadata.isSymbolicLink() ||
        !metadata.isDirectory()) {
        throw new RangeError(`${description} must be a canonical directory`);
    }
    return canonical;
}
// read one member while rejecting intermediate links and path races
async function readVerifiedSnapshotMember(snapshotRoot, memberPath, accessTrace, phase) {
    return readVerifiedRegularFile(resolve(snapshotRoot, memberPath), snapshotRoot, "snapshot member", accessTrace, phase, memberPath);
}
// read one stable regular file below an exact canonical root
async function readVerifiedRegularFile(path, root, description, accessTrace, phase, tracePath) {
    const absoluteRoot = resolve(root);
    const target = resolve(path);
    // reject root aliases and lexical escapes before traversal
    if (await realpath(absoluteRoot) !== absoluteRoot ||
        target === absoluteRoot ||
        !target.startsWith(`${absoluteRoot}${sep}`)) {
        throw new RangeError(`${description} escapes its canonical root`);
    }
    const segments = target.slice(absoluteRoot.length + 1).split(sep);
    let cursor = absoluteRoot;
    // verify each path component without following links
    for (let index = 0; index < segments.length; index += 1) {
        cursor = join(cursor, segments[index]);
        const metadata = await lstat(cursor);
        const last = index === segments.length - 1;
        const canonical = await realpath(cursor);
        // reject links, special nodes, and intermediate aliases
        if (metadata.isSymbolicLink() ||
            canonical !== cursor ||
            !canonical.startsWith(`${absoluteRoot}${sep}`) ||
            (last ? !metadata.isFile() : !metadata.isDirectory())) {
            throw new RangeError(`${description} path contains a noncanonical node`);
        }
    }
    const before = await lstat(target);
    const beforeReal = await realpath(target);
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const opened = await handle.stat();
        // bind the opened descriptor to the validated path node
        if (!opened.isFile() ||
            !sameFileMetadata(before, opened) ||
            beforeReal !== target) {
            throw new RangeError(`${description} changed before open`);
        }
        // trace the real successful filesystem open
        if (accessTrace !== undefined && phase !== undefined) {
            accessTrace.push(`fs_opened:${phase}:${tracePath ?? target}`);
        }
        const bytes = await handle.readFile();
        // trace the real completed filesystem read
        if (accessTrace !== undefined && phase !== undefined) {
            accessTrace.push(`fs_read:${phase}:${tracePath ?? target}`);
        }
        const openedAfter = await handle.stat();
        const pathAfter = await lstat(target);
        const afterReal = await realpath(target);
        // reject inode, size, or path replacement during the read
        if (!sameFileMetadata(opened, openedAfter) ||
            !sameFileMetadata(opened, pathAfter) ||
            afterReal !== beforeReal) {
            throw new RangeError(`${description} changed during verification`);
        }
        return bytes;
    }
    finally {
        await handle.close();
    }
}
// compare the required stable file identity fields
function sameFileMetadata(left, right) {
    return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}
// promote one exact triple from fixed external staging
export async function promoteForecastAdjustmentEvidence(input) {
    return promoteForecastAdjustmentEvidenceAtRoot(MODEL_EVIDENCE_ROOT, input, MODEL_EVIDENCE_REDUNDANCY_ROOT);
}
// promote one exact triple under a test-injected evidence root
export async function promoteForecastAdjustmentEvidenceAtRoot(root, input, redundancyRoot = root) {
    validateRequestedHashes(input);
    const evidence = await readCompleteEvidence(root, "staging", input);
    await verifyCompleteEvidenceAtRoot(root, redundancyRoot, evidence, "staging", false);
    for (const kind of EVIDENCE_KINDS) {
        const hash = hashForKind(evidence, kind);
        const source = evidenceObjectPath(root, "staging", kind, hash);
        const destination = evidenceObjectPath(root, "objects", kind, hash);
        await publishExactFile(root, source, destination);
    }
    const lifecycleHashes = completeEvidenceHashes(evidence);
    await appendEvidenceLifecycleRecord(root, lifecycleHashes);
    await verifyCompleteEvidenceAtRoot(root, redundancyRoot, evidence, "objects", true);
    return deepFreeze({
        ...input,
        contractVersion: "forecast-adjustment-evidence-result/v1",
        state: "promoted",
    });
}
// retrieve and verify evidence by receipt identity
export async function verifyForecastAdjustmentEvidence(input) {
    return verifyForecastAdjustmentEvidenceAtRoot(MODEL_EVIDENCE_ROOT, input, MODEL_EVIDENCE_REDUNDANCY_ROOT);
}
// retrieve evidence under a test-injected fixed root
export async function verifyForecastAdjustmentEvidenceAtRoot(root, input, redundancyRoot = root) {
    validateHash(input.qualificationReceiptSha256, "qualificationReceiptSha256");
    const receipt = await readJsonObject(evidenceObjectPath(root, "objects", "qualification-receipt", input.qualificationReceiptSha256), root);
    const hashes = {
        candidateArtifactSha256: receipt.candidateArtifactSha256,
        evaluationReportSha256: receipt.evaluationReportSha256,
        qualificationReceiptSha256: input.qualificationReceiptSha256,
    };
    const evidence = await readCompleteEvidence(root, "objects", hashes);
    await verifyCompleteEvidenceAtRoot(root, redundancyRoot, evidence, "objects", true);
    return deepFreeze({
        ...hashes,
        contractVersion: "forecast-adjustment-evidence-result/v1",
        state: "verified",
    });
}
// load one verified promotable triple from the fixed evidence store
export async function loadVerifiedForecastAdjustmentEvidence(input) {
    return loadVerifiedForecastAdjustmentEvidenceAtRoot(MODEL_EVIDENCE_ROOT, input, MODEL_EVIDENCE_REDUNDANCY_ROOT);
}
// load one verified promotable triple under a test root
export async function loadVerifiedForecastAdjustmentEvidenceAtRoot(root, input, redundancyRoot = root) {
    validateRequestedHashes(input);
    const evidence = await readCompleteEvidence(root, "objects", input);
    await verifyCompleteEvidenceAtRoot(root, redundancyRoot, evidence, "objects", true);
    return deepFreeze({
        candidate: evidence.candidate,
        evaluationReport: evidence.evaluationReport,
        qualificationReceipt: evidence.qualificationReceipt,
    });
}
// write one exact staged evidence object for operator preparation
export async function stageForecastAdjustmentEvidenceObject(root, kind, value) {
    verifyTypedEvidenceObject(kind, value);
    const hash = objectHashForKind(kind, value);
    const path = evidenceObjectPath(root, "staging", kind, hash);
    await atomicWriteNew(path, canonicalJsonBytes(value));
    return hash;
}
// create an immutable redundancy attestation
export function createEvidenceRedundancyAttestation(input) {
    validateHash(input.candidateArtifactSha256, "candidateArtifactSha256");
    validateHash(input.evaluationReportSha256, "evaluationReportSha256");
    const unsigned = {
        candidateArtifactSha256: input.candidateArtifactSha256,
        contractVersion: "forecast-adjustment-evidence-redundancy/v1",
        evaluationReportSha256: input.evaluationReportSha256,
        status: input.status,
        verifiedAtUtc: input.verifiedAtUtc,
    };
    return deepFreeze({
        ...unsigned,
        attestationSha256: sha256(canonicalJsonBytes(unsigned)),
    });
}
// stage one immutable attestation under a test or operator root
export async function stageEvidenceRedundancyAttestation(root, attestation) {
    // reject attestation substitution
    if (canonicalObjectSha256(attestation, "attestationSha256") !== attestation.attestationSha256) {
        throw new RangeError("evidence redundancy attestation SHA-256 mismatch");
    }
    await atomicWriteNew(join(root, "attestations", `sha256-${attestation.attestationSha256}.json`), canonicalJsonBytes(attestation));
}
// stage a physically separate exact evidence copy for verification
export async function stageRedundantEvidenceObject(root, status, kind, value) {
    verifyTypedEvidenceObject(kind, value);
    const store = status === "independent_content_addressed_copy"
        ? "independent-copy"
        : "restored-backup";
    const hash = objectHashForKind(kind, value);
    await atomicWriteNew(evidenceObjectPath(root, store, kind, hash), canonicalJsonBytes(value));
}
// verify exact links, hashes, and physical redundancy
async function verifyCompleteEvidenceAtRoot(root, redundancyRoot, triple, primaryStore, requireLifecycle) {
    const [canonicalRoot, canonicalRedundancyRoot] = await Promise.all([
        requireCanonicalDirectory(root, "evidence root"),
        requireCanonicalDirectory(redundancyRoot, "evidence redundancy root"),
    ]);
    const [rootMetadata, redundancyMetadata] = await Promise.all([
        lstat(canonicalRoot),
        lstat(canonicalRedundancyRoot),
    ]);
    // require independent failure domains before trusting copied bytes
    if (rootMetadata.dev === redundancyMetadata.dev) {
        throw new RangeError("evidence redundancy must use a distinct storage device");
    }
    verifyForecastAdjustmentCandidate(triple.candidate);
    verifyForecastAdjustmentEvaluationReport(triple.evaluationReport);
    verifyForecastAdjustmentQualificationReceipt(triple.qualificationReceipt);
    verifyDevelopmentReport(triple.developmentReport);
    verifyForecastAdjustmentPreregistration(triple.preregistration, triple.candidate);
    verifyHoldoutAccessMarker(triple.holdoutAccessMarker);
    validatePromotableForecastAdjustmentEvidence(triple);
    // require every immutable evidence edge to agree
    if (canonicalSha256(triple.snapshotManifest) !== triple.candidate.exportManifestSha256 ||
        triple.developmentReport.developmentReportSha256 !==
            triple.candidate.developmentReportSha256 ||
        triple.preregistration.preregistrationSha256 !==
            triple.evaluationReport.preregistrationSha256 ||
        triple.holdoutAccessMarker.markerSha256 !==
            triple.evaluationReport.holdoutAccessMarkerSha256 ||
        triple.holdoutAccessMarker.candidateArtifactSha256 !==
            triple.candidate.candidateArtifactSha256 ||
        triple.holdoutAccessMarker.enabledMetricBandsSha256 !==
            triple.preregistration.enabledMetricBandsSha256 ||
        triple.holdoutAccessMarker.evaluationEpochId !==
            triple.candidate.evaluationEpochId ||
        triple.holdoutAccessMarker.preregistrationSha256 !==
            triple.preregistration.preregistrationSha256 ||
        triple.holdoutAccessMarker.snapshotManifestSha256 !==
            triple.candidate.exportManifestSha256 ||
        triple.holdoutAccessMarker.startInclusive !==
            triple.preregistration.holdoutStartInclusive ||
        triple.holdoutAccessMarker.startLocalDate !==
            triple.preregistration.holdoutStartLocalDate ||
        triple.holdoutAccessMarker.endExclusive !==
            triple.preregistration.holdoutEndExclusive ||
        triple.holdoutAccessMarker.endLocalDate !==
            triple.preregistration.holdoutEndLocalDate) {
        throw new RangeError("complete evidence cross-link mismatch");
    }
    const ledger = parseHoldoutLedger((await readVerifiedRegularFile(join(root, "ledger.jsonl"), root, "evidence ledger").catch((error) => {
        throw boundedFilesystemError(error, "evidence ledger cannot be read");
    })).toString("utf8"));
    // require the exact access marker in the durable chain
    if (!ledger.some((marker) => marker.markerSha256 === triple.holdoutAccessMarker.markerSha256)) {
        throw new RangeError("holdout access marker is absent from evidence ledger");
    }
    // require promotion lifecycle after publication
    if (requireLifecycle) {
        await verifyEvidenceLifecycleRecord(root, completeEvidenceHashes(triple));
    }
    const attestation = await readJsonObject(join(root, "attestations", `sha256-${triple.qualificationReceipt.evidenceRedundancy.attestationSha256}.json`), root);
    // require an immutable matching attestation
    if (canonicalObjectSha256(attestation, "attestationSha256") !== attestation.attestationSha256 ||
        attestation.attestationSha256 !==
            triple.qualificationReceipt.evidenceRedundancy.attestationSha256 ||
        attestation.status !== triple.qualificationReceipt.evidenceRedundancy.status ||
        attestation.candidateArtifactSha256 !==
            triple.candidate.candidateArtifactSha256 ||
        attestation.evaluationReportSha256 !==
            triple.evaluationReport.evaluationReportSha256) {
        throw new RangeError("evidence redundancy attestation mismatch");
    }
    const redundantStore = attestation.status === "independent_content_addressed_copy"
        ? "independent-copy"
        : "restored-backup";
    await verifyRetainedSnapshotRedundancy(root, redundancyRoot, triple.snapshotManifest, redundantStore, triple.candidate.exportManifestSha256);
    for (const kind of EVIDENCE_KINDS) {
        const hash = hashForKind(triple, kind);
        const primary = evidenceObjectPath(root, primaryStore, kind, hash);
        const redundant = evidenceObjectPath(redundancyRoot, redundantStore, kind, hash);
        const [primaryReal, redundantReal] = await Promise.all([
            realpath(primary).catch(() => primary),
            realpath(redundant).catch(() => redundant),
        ]);
        // reject same-path aliases as fake redundancy
        if (primaryReal === redundantReal) {
            throw new RangeError("evidence redundancy cannot alias the primary object");
        }
        const [primaryMetadata, redundantMetadata] = await Promise.all([
            lstat(primary),
            lstat(redundant),
        ]);
        // require a distinct storage device rather than another local inode
        if (primaryMetadata.dev === redundantMetadata.dev) {
            throw new RangeError("evidence redundancy must use a distinct storage device");
        }
        const [primaryBytes, redundantBytes] = await Promise.all([
            readVerifiedRegularFile(primary, root, "primary evidence object"),
            readVerifiedRegularFile(redundant, redundancyRoot, "redundant evidence object"),
        ]);
        // require exact independently retrievable bytes
        if (!primaryBytes.equals(redundantBytes)) {
            throw new RangeError("evidence redundant copy does not match primary bytes");
        }
    }
}
// create a separately addressable retained snapshot copy
async function stageRedundantRetainedSnapshot(redundancyRoot, status, snapshotRoot, snapshotManifestSha256) {
    const store = status === "independent_content_addressed_copy"
        ? "independent-copy"
        : "restored-backup";
    const destination = join(redundancyRoot, store, "snapshots", `sha256-${snapshotManifestSha256}`);
    await mkdir(dirname(destination), { mode: 0o700, recursive: true });
    await cp(snapshotRoot, destination, {
        errorOnExist: true,
        force: false,
        recursive: true,
    });
}
// verify the complete compressed snapshot and a physically separate copy
async function verifyRetainedSnapshotRedundancy(root, redundancyRoot, snapshotManifest, redundantStore, snapshotManifestSha256) {
    const manifest = snapshotManifest;
    // skip non-package test artifacts while retaining their object-level hash proof
    if (manifest.contractVersion !== "forecast-training-export-package/v1" ||
        !Array.isArray(manifest.members)) {
        return;
    }
    const primaryRoot = join(root, "snapshots", snapshotManifestSha256);
    const redundantRoot = join(redundancyRoot, redundantStore, "snapshots", `sha256-${snapshotManifestSha256}`);
    const [primaryManifest, redundantManifest] = await Promise.all([
        readVerifiedRegularFile(join(primaryRoot, "manifest.json"), root, "primary retained snapshot manifest").then((bytes) => bytes.toString("utf8")),
        readVerifiedRegularFile(join(redundantRoot, "manifest.json"), redundancyRoot, "redundant retained snapshot manifest").then((bytes) => bytes.toString("utf8")),
    ]);
    // require both retained manifests to equal the immutable evidence object
    if (primaryManifest !== canonicalJsonBytes(snapshotManifest) ||
        redundantManifest !== primaryManifest) {
        throw new RangeError("retained snapshot manifest redundancy mismatch");
    }
    for (const member of manifest.members) {
        const [primaryBytes, redundantBytes] = await Promise.all([
            readVerifiedSnapshotMember(primaryRoot, member.path),
            readVerifiedSnapshotMember(redundantRoot, member.path),
        ]);
        const [primaryMetadata, redundantMetadata] = await Promise.all([
            lstat(join(primaryRoot, member.path)),
            lstat(join(redundantRoot, member.path)),
        ]);
        // require exact hashes, bytes, and a distinct storage device
        if (sha256(primaryBytes) !== member.sha256 ||
            !primaryBytes.equals(redundantBytes) ||
            primaryMetadata.dev === redundantMetadata.dev) {
            throw new RangeError("retained snapshot member redundancy mismatch");
        }
    }
}
// collect every immutable evidence identity for one lifecycle transition
function completeEvidenceHashes(evidence) {
    return {
        candidateArtifactSha256: evidence.candidate.candidateArtifactSha256,
        developmentReportSha256: evidence.developmentReport.developmentReportSha256,
        evaluationReportSha256: evidence.evaluationReport.evaluationReportSha256,
        holdoutAccessMarkerSha256: evidence.holdoutAccessMarker.markerSha256,
        preregistrationSha256: evidence.preregistration.preregistrationSha256,
        qualificationReceiptSha256: evidence.qualificationReceipt.qualificationReceiptSha256,
        snapshotManifestSha256: evidence.candidate.exportManifestSha256,
    };
}
// read an exact evidence triple by hashes
async function readEvidenceTriple(root, store, hashes) {
    const [candidate, evaluationReport, qualificationReceipt] = await Promise.all([
        readJsonObject(evidenceObjectPath(root, store, "candidate", hashes.candidateArtifactSha256), root),
        readJsonObject(evidenceObjectPath(root, store, "evaluation-report", hashes.evaluationReportSha256), root),
        readJsonObject(evidenceObjectPath(root, store, "qualification-receipt", hashes.qualificationReceiptSha256), root),
    ]);
    // require filename identities to equal object identities
    if (candidate.candidateArtifactSha256 !== hashes.candidateArtifactSha256 ||
        evaluationReport.evaluationReportSha256 !== hashes.evaluationReportSha256 ||
        qualificationReceipt.qualificationReceiptSha256 !==
            hashes.qualificationReceiptSha256) {
        throw new RangeError("evidence filename identity mismatch");
    }
    return { candidate, evaluationReport, qualificationReceipt };
}
// read the complete evidence graph discovered from immutable triple links
async function readCompleteEvidence(root, store, hashes) {
    const triple = await readEvidenceTriple(root, store, hashes);
    const [snapshotManifest, developmentReport, preregistration, holdoutAccessMarker] = await Promise.all([
        readJsonObject(evidenceObjectPath(root, store, "snapshot-manifest", triple.candidate.exportManifestSha256), root),
        readJsonObject(evidenceObjectPath(root, store, "development-report", triple.candidate.developmentReportSha256), root),
        readJsonObject(evidenceObjectPath(root, store, "preregistration", triple.evaluationReport.preregistrationSha256), root),
        readJsonObject(evidenceObjectPath(root, store, "holdout-access-marker", triple.evaluationReport.holdoutAccessMarkerSha256), root),
    ]);
    return {
        ...triple,
        developmentReport,
        holdoutAccessMarker,
        preregistration,
        snapshotManifest,
    };
}
// verify one typed immutable evidence object
function verifyTypedEvidenceObject(kind, value) {
    // verify a snapshot by its canonical content identity
    if (kind === "snapshot-manifest") {
        canonicalSha256(value);
        return;
    }
    // dispatch development verification
    if (kind === "development-report") {
        verifyDevelopmentReport(value);
        return;
    }
    // validate preregistration hash before graph verification
    if (kind === "preregistration") {
        const preregistration = value;
        // reject preregistration substitution
        if (canonicalObjectSha256(preregistration, "preregistrationSha256") !== preregistration.preregistrationSha256) {
            throw new RangeError("preregistration SHA-256 mismatch");
        }
        return;
    }
    // dispatch durable marker verification
    if (kind === "holdout-access-marker") {
        verifyHoldoutAccessMarker(value);
        return;
    }
    // dispatch one closed object class
    if (kind === "candidate") {
        verifyForecastAdjustmentCandidate(value);
        return;
    }
    // dispatch report verification
    if (kind === "evaluation-report") {
        verifyForecastAdjustmentEvaluationReport(value);
        return;
    }
    verifyForecastAdjustmentQualificationReceipt(value);
}
// select one object's own immutable identity
function objectHashForKind(kind, value) {
    // select the snapshot content identity
    if (kind === "snapshot-manifest") {
        return canonicalSha256(value);
    }
    // select the development report identity
    if (kind === "development-report") {
        return value.developmentReportSha256;
    }
    // select the preregistration identity
    if (kind === "preregistration") {
        return value.preregistrationSha256;
    }
    // select the marker identity
    if (kind === "holdout-access-marker") {
        return value.markerSha256;
    }
    // select the candidate identity
    if (kind === "candidate") {
        return value.candidateArtifactSha256;
    }
    // select the report identity
    if (kind === "evaluation-report") {
        return value.evaluationReportSha256;
    }
    return value
        .qualificationReceiptSha256;
}
// select a triple member's immutable identity
function hashForKind(triple, kind) {
    // select the snapshot identity
    if (kind === "snapshot-manifest") {
        return triple.candidate.exportManifestSha256;
    }
    // select the development identity
    if (kind === "development-report") {
        return triple.developmentReport.developmentReportSha256;
    }
    // select the preregistration identity
    if (kind === "preregistration") {
        return triple.preregistration.preregistrationSha256;
    }
    // select the marker identity
    if (kind === "holdout-access-marker") {
        return triple.holdoutAccessMarker.markerSha256;
    }
    // select the candidate identity
    if (kind === "candidate") {
        return triple.candidate.candidateArtifactSha256;
    }
    // select the report identity
    if (kind === "evaluation-report") {
        return triple.evaluationReport.evaluationReportSha256;
    }
    return triple.qualificationReceipt.qualificationReceiptSha256;
}
// select one complete graph object by its evidence class
function valueForKind(evidence, kind) {
    // select the snapshot
    if (kind === "snapshot-manifest") {
        return evidence.snapshotManifest;
    }
    // select the development report
    if (kind === "development-report") {
        return evidence.developmentReport;
    }
    // select the preregistration
    if (kind === "preregistration") {
        return evidence.preregistration;
    }
    // select the durable marker
    if (kind === "holdout-access-marker") {
        return evidence.holdoutAccessMarker;
    }
    // select the candidate
    if (kind === "candidate") {
        return evidence.candidate;
    }
    // select the evaluation report
    if (kind === "evaluation-report") {
        return evidence.evaluationReport;
    }
    return evidence.qualificationReceipt;
}
// build one fixed content-addressed object path
function evidenceObjectPath(root, store, kind, hash) {
    validateHash(hash, `${kind}Sha256`);
    return join(root, store, kind, `sha256-${hash}.json`);
}
// publish one immutable exact-byte file
async function publishExactFile(root, source, destination) {
    const bytes = await readVerifiedRegularFile(source, root, "staged evidence object");
    await atomicWriteNew(destination, bytes).catch(async (error) => {
        const existing = await readVerifiedRegularFile(destination, root, "published evidence object").catch(() => null);
        // accept an idempotent exact publication only
        if (existing !== null && existing.equals(bytes)) {
            return;
        }
        throw boundedFilesystemError(error, "evidence publication failed");
    });
}
// atomically create one new immutable object
async function atomicWriteNew(path, bytes) {
    await mkdir(dirname(path), { mode: 0o700, recursive: true });
    const temporary = `${path}.partial-${process.pid}`;
    const handle = await open(temporary, "wx", 0o600);
    try {
        await handle.writeFile(bytes);
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    try {
        await link(temporary, path);
        const parent = await open(dirname(path), constants.O_RDONLY);
        try {
            await parent.sync();
        }
        finally {
            await parent.close();
        }
    }
    finally {
        await rm(temporary, { force: true });
    }
}
// read one regular canonical JSON object
async function readJsonObject(path, root) {
    const bytes = (await readVerifiedRegularFile(path, root, "evidence object")).toString("utf8");
    const value = JSON.parse(bytes);
    // require canonical exact bytes
    if (bytes !== canonicalJsonBytes(value)) {
        throw new RangeError("evidence object is not canonical JSON");
    }
    return value;
}
// require one absolute canonical ignored-local path
async function requireFixedLocalRoot(path, requiredSegment, description, create = false) {
    const absolute = resolve(path);
    const fixedParent = dirname(absolute);
    // require caller canonicalization and fixed ignored root
    if (path !== absolute ||
        basename(fixedParent) !== requiredSegment ||
        /(?:^|[/\\])\.\.(?:[/\\]|$)/u.test(path)) {
        throw new RangeError(`${description} path is outside ${requiredSegment}`);
    }
    // create only the output leaf
    if (create) {
        await mkdir(fixedParent, { mode: 0o700, recursive: false }).catch((error) => {
            // accept one existing fixed output parent
            if (error.code !== "EEXIST") {
                throw boundedFilesystemError(error, `${description} parent cannot be created`);
            }
        });
        const parentReal = await realpath(fixedParent);
        const parentMetadata = await lstat(fixedParent);
        // require the fixed parent itself to be canonical
        if (parentReal !== fixedParent ||
            !parentMetadata.isDirectory() ||
            parentMetadata.isSymbolicLink()) {
            throw new RangeError(`${description} parent must be a canonical directory`);
        }
        await mkdir(absolute, { mode: 0o700, recursive: false }).catch((error) => {
            // accept one existing output directory
            if (error.code !== "EEXIST") {
                throw boundedFilesystemError(error, `${description} path cannot be created`);
            }
        });
    }
    const canonical = await realpath(absolute);
    const metadata = await lstat(canonical);
    // reject aliases and non-directory roots
    if (canonical !== absolute || !metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new RangeError(`${description} path must be a canonical directory`);
    }
    return canonical;
}
// validate one archive-derived wind manifest without accepting legacy export assertions
function validateArchiveWindFitManifest(manifest) {
    requireExactKeys(manifest, ARCHIVE_WIND_FIT_MANIFEST_KEYS, "archive wind fit manifest");
    // require every root identity and one bounded exact member population
    for (const field of [
        "aggregationContractSha256", "coordinateManifestSha256", "epochWitnessSha256",
        "historyRootSha256", "metricEligibilitySha256", "sourceLineageSha256",
        "spatialWeightsSha256", "stationManifestSha256",
    ]) {
        validateHash(manifest[field], `archive wind fit manifest ${field}`);
    }
    validateLocalDateRange(manifest.fromLocalDate, manifest.toLocalDate);
    if (!Array.isArray(manifest.members) || manifest.members.length < 1 ||
        manifest.members.length > ADJUSTMENT_ARCHIVE_WIND_FIT_MAXIMUM_MEMBERS ||
        !Number.isSafeInteger(manifest.totalRowCount) || manifest.totalRowCount < 1 ||
        manifest.totalRowCount > 4_000_000 ||
        manifest.members.reduce((total, member) => total + member.rowCount, 0) !==
            manifest.totalRowCount) {
        throw new RangeError("archive wind fit manifest population is invalid");
    }
    let previousPath = null;
    // validate exact archive-member metadata without claiming exported files exist
    for (const member of manifest.members) {
        requireExactKeys(member, SNAPSHOT_MEMBER_KEYS, "archive wind fit member");
        validateHash(member.sha256, "archive wind fit member identity");
        validateLocalDateRange(member.localDate, member.localDate);
        if (!/^archive-members\/\d{4}-\d{2}-\d{2}\/(?:forecast|target)\/[a-f0-9]{64}$/u
            .test(member.path) || !member.path.startsWith(`archive-members/${member.localDate}/`) ||
            !Number.isSafeInteger(member.rowCount) || member.rowCount !== 1 ||
            !Number.isSafeInteger(member.sizeBytes) || member.sizeBytes < 1 ||
            !Number.isSafeInteger(member.plaintextBytes) || member.plaintextBytes < 1 ||
            !windMaintenanceInstant(member.minValidAt) ||
            !windMaintenanceInstant(member.maxValidAt) ||
            member.minValidAt !== member.maxValidAt ||
            !["actual_best_match", "target_revision"].includes(member.recordKind) ||
            (member.recordKind === "target_revision") !== (member.stationKey !== null) ||
            (previousPath !== null && previousPath >= member.path)) {
            throw new RangeError("archive wind fit member is invalid");
        }
        previousPath = member.path;
    }
}
// validate the sanitized package boundary before member reads
function validateSnapshotManifestBoundary(manifest) {
    requireExactKeys(manifest, SNAPSHOT_MANIFEST_KEYS, "snapshot manifest");
    // require exact site, usage, and provenance identities
    if (manifest.contractVersion !== "forecast-training-export-package/v1" ||
        manifest.siteKey !== "ballydidean" ||
        manifest.siteTimezone !== "America/Los_Angeles" ||
        manifest.usageBoundary?.databaseImportAllowed !== false ||
        manifest.usageBoundary?.productionDerived !== true ||
        manifest.usageBoundary?.snapshotOnly !== true ||
        manifest.queryContractVersion !== "forecast-training-export-query/v2" ||
        manifest.queryContractSha256 !== SNAPSHOT_QUERY_CONTRACT_SHA256 ||
        manifest.rowSchemaSha256 !== SNAPSHOT_ROW_SCHEMA_SHA256 ||
        manifest.limits?.maxDays !== 450 ||
        manifest.limits?.maxRows !== 4_000_000 ||
        manifest.limits?.conservativeExportRows !== 3_045_600 ||
        manifest.limits?.exportRowHeadroom !== 954_400 ||
        manifest.limits?.rowCountMeaning !== "export_rows_not_training_events" ||
        manifest.limits?.conservativeExportRowFormula !==
            "450 * ((24 * 264) + (11 * 24) + 168)" ||
        manifest.transaction?.readOnly !== "on" ||
        manifest.transaction?.isolationLevel !== "repeatable read" ||
        manifest.transaction?.statementTimeout !== "15min" ||
        manifest.transaction?.lockTimeout !== "5s" ||
        manifest.transaction?.idleInTransactionSessionTimeout !== "30s" ||
        manifest.databaseManifest?.query_contract_version !==
            manifest.queryContractVersion ||
        manifest.databaseManifest?.schema_migration !==
            "0010_forecast_training_export.sql" ||
        !Array.isArray(manifest.databaseManifest?.migration_names) ||
        manifest.databaseManifest.migration_names.length === 0 ||
        manifest.databaseManifest.migration_names.length !==
            manifest.databaseManifest.migration_checksums.length ||
        manifest.databaseManifest.migration_checksums.some((hash) => !HASH_PATTERN.test(hash)) ||
        !HASH_PATTERN.test(manifest.migrationHistorySha256) ||
        !Array.isArray(manifest.sourceIdentities) ||
        !Array.isArray(manifest.observedSourceIdentities) ||
        !Number.isSafeInteger(manifest.totalRowCount) ||
        manifest.totalRowCount < 0 ||
        manifest.totalRowCount > 4_000_000) {
        throw new RangeError("snapshot manifest boundary is invalid");
    }
    for (const [key, expected] of Object.entries(SNAPSHOT_PROVENANCE_HASHES)) {
        // reject provenance substitution
        if (manifest[key] !== expected) {
            throw new RangeError(`snapshot manifest provenance mismatch: ${key}`);
        }
    }
    validateLocalDateRange(manifest.fromLocalDate, manifest.toLocalDate);
    validateSnapshotStationMetricCoverage(manifest.stationMetricCoverage, inclusiveDateCount(manifest.fromLocalDate, manifest.toLocalDate));
    // require manifest and member row totals to agree
    if (manifest.members.reduce((sum, member) => sum + member.rowCount, 0) !==
        manifest.totalRowCount) {
        throw new RangeError("snapshot manifest row count does not match members");
    }
    // require deterministic member order
    if (!Array.isArray(manifest.members) ||
        manifest.members.some((member, index) => index > 0 &&
            (manifest.members[index - 1]?.path ?? "") >= member.path)) {
        throw new RangeError("snapshot members are not canonically ordered");
    }
}
// validate sanitized station coverage exactly
function validateSnapshotStationMetricCoverage(value, maximumDates) {
    const expectedStationKeys = FORECAST_OBSERVATION_STATIONS
        .map((station) => station.key)
        .sort(compareText);
    // require exactly one entry per frozen station
    if (!Array.isArray(value) || value.length !== expectedStationKeys.length) {
        throw new RangeError("snapshot station metric coverage is invalid");
    }
    // validate every station and metric count
    for (const entry of value) {
        // reject nonobject station entries
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
            throw new RangeError("snapshot station metric coverage is invalid");
        }
        requireExactKeys(entry, SNAPSHOT_STATION_METRIC_COVERAGE_KEYS, "snapshot station metric coverage");
        const metricCounts = entry.eligibleMetricNonNullLocalDates;
        // reject nonobject metric counts
        if (metricCounts === null ||
            typeof metricCounts !== "object" ||
            Array.isArray(metricCounts)) {
            throw new RangeError("snapshot station metric coverage is invalid");
        }
        requireExactKeys(metricCounts, SNAPSHOT_STATION_METRIC_FIELDS, "snapshot station metric coverage counts");
        // reject impossible or fractional date counts
        if (SNAPSHOT_STATION_METRIC_FIELDS.some((metric) => {
            const count = metricCounts[metric];
            return (!Number.isSafeInteger(count) ||
                count < 0 ||
                count > maximumDates);
        })) {
            throw new RangeError("snapshot station metric coverage is invalid");
        }
    }
    // bind canonical station order and identity
    if (canonicalizeJson(value.map((entry) => entry.stationKey)) !==
        canonicalizeJson(expectedStationKeys)) {
        throw new RangeError("snapshot station metric coverage is invalid");
    }
}
// validate member metadata without opening its file
function validateSnapshotMember(member, root) {
    requireExactKeys(member, SNAPSHOT_MEMBER_KEYS, "snapshot member");
    const allowedPath = /^members\/\d{4}-\d{2}-\d{2}\/(?:station-hour|fixed-lead-anchor|legacy-v4-retrieval)\/[a-z0-9._-]+\.jsonl\.gz$/u;
    validateHash(member.sha256, "member.sha256");
    // reject unsafe or malformed members before member access
    if (!allowedPath.test(member.path) ||
        !member.path.startsWith(`members/${member.localDate}/`) ||
        member.path.includes("..") ||
        resolve(root, member.path) === root ||
        !resolve(root, member.path).startsWith(`${root}${sep}`) ||
        !Number.isSafeInteger(member.rowCount) ||
        member.rowCount < 1 ||
        !Number.isSafeInteger(member.sizeBytes) ||
        member.sizeBytes < 1 ||
        !Number.isSafeInteger(member.plaintextBytes) ||
        member.plaintextBytes < 1 ||
        !Number.isFinite(Date.parse(member.minValidAt)) ||
        !Number.isFinite(Date.parse(member.maxValidAt)) ||
        member.minValidAt > member.maxValidAt) {
        throw new RangeError("snapshot member metadata is invalid");
    }
    validateLocalDateRange(member.localDate, member.localDate);
}
// infer only hard gates proven by sanitized manifest metadata
function inferManifestInsufficiency(manifest) {
    const failed = [];
    const epochDates = inclusiveDateCount(manifest.fromLocalDate, manifest.toLocalDate);
    // count distinct served-cohort dates
    const liveV4Dates = new Set(manifest.members
        .filter((member) => member.recordKind === "legacy-v4-retrieval")
        .map((member) => member.localDate)).size;
    // require the complete frozen epoch
    if (epochDates < 402) {
        failed.push("epoch_402_local_dates");
    }
    // require enough possible served-cohort network dates
    if (liveV4Dates < 330) {
        failed.push("network_330_local_dates");
    }
    return failed.sort(compareText);
}
// fit the shared robust hierarchy without accessing confirmation targets
async function fitRetainedDevelopmentCore(input) {
    const epoch = createQualificationCalendarEpoch(input.manifest.toLocalDate);
    const events = input.maintenanceWindOnly
        ? buildRetainedTrainingEvents(input.preHoldoutRows, "legacy_v4_retrieval_snapshot", ["windSpeedMps", "windGustMps"])
            .filter((event) => event.metric !== "windGustMps" || event.leadBand !== "049-072")
        : buildRetainedTrainingEvents(input.preHoldoutRows);
    const failedGates = retainedSufficiencyFailures(events, epoch.finalTraining.localDates);
    // stop before fitting when literal event support is absent
    if (failedGates.length > 0) {
        return createInsufficientDataReport({
            failedGates,
            snapshotManifestSha256: input.snapshotManifestSha256,
        });
    }
    const pairKeys = [...new Set(events.map((event) => `${event.metric}:${event.leadBand}`))]
        .sort();
    const foldResults = pairKeys.flatMap((key) => {
        const [metric, leadBand] = key.split(":");
        return epoch.folds.map((fold) => scoreDevelopmentFold(events.filter((event) => event.metric === metric && event.leadBand === leadBand), { leadBand, metric }, fold));
    });
    const enabledMetricBands = pairKeys
        .map((key) => {
        const [metric, leadBand] = key.split(":");
        return { leadBand, metric };
    })
        .filter((pair) => {
        const folds = foldResults.filter((fold) => fold.metricBand.metric === pair.metric &&
            fold.metricBand.leadBand === pair.leadBand);
        return folds.filter((fold) => fold.passed).length >= 4 && folds[4]?.passed;
    });
    // require at least one deterministic development-qualified pair
    if (enabledMetricBands.length === 0) {
        return createInsufficientDataReport({
            failedGates: ["development_loso_qualification"],
            snapshotManifestSha256: input.snapshotManifestSha256,
        });
    }
    const enabledKeys = new Set(enabledMetricBands.map((pair) => `${pair.metric}:${pair.leadBand}`));
    const developmentReport = createDevelopmentReport({
        enabledMetricBands,
        folds: foldResults.filter((fold) => enabledKeys.has(`${fold.metricBand.metric}:${fold.metricBand.leadBand}`)),
    });
    const coefficients = enabledMetricBands.flatMap((pair) => fitEventHierarchy(events.filter((event) => event.metric === pair.metric && event.leadBand === pair.leadBand), pair));
    const trainingEnvelopes = enabledMetricBands
        .filter((pair) => pair.metric !== "windDirectionDegrees")
        .map((pair) => createTrainingEnvelope(pair.metric, pair.leadBand, events
        .filter((event) => event.metric === pair.metric && event.leadBand === pair.leadBand)
        .map((event) => event.rawForecast)));
    const identityRow = input.preHoldoutRows.find((row) => row.recordKind === "legacy_v4_retrieval_snapshot");
    // retain the exact served forecast identity
    if (identityRow === undefined) {
        throw new RangeError("retained rows lack the served forecast identity");
    }
    const candidate = createForecastAdjustmentCandidate({
        coefficients,
        developmentReportSha256: developmentReport.developmentReportSha256,
        enabledMetricBands,
        evaluationEpochId: canonicalSha256({
            d0: epoch.d0,
            d401: epoch.d401,
            snapshotManifestSha256: input.snapshotManifestSha256,
        }),
        exportManifestSha256: input.snapshotManifestSha256,
        finalTrainingCutoff: new Date(Date.parse(nextLocalMidnightUtc(epoch.finalTraining.endLocalDate)) - 1).toISOString(),
        forecastIdentity: {
            adapterVersion: identityRow.adapterVersion,
            cohort: "legacy_v4_retrieval_snapshot",
            contractEpoch: identityRow.contractEpoch,
            dataset: identityRow.dataset,
            referenceKind: "retrieval_snapshot",
            sourceConfigFingerprint: identityRow.sourceConfigFingerprints[0],
            sourceKey: identityRow.sourceKeys[0],
            upstreamModel: identityRow.upstreamModel,
        },
        runtimeFingerprint: runtimeCalendarFingerprint(),
        trainingEnvelopes,
        trainingProvenance: {
            aggregationContractSha256: input.manifest.aggregationContractSha256,
            coordinateManifestSha256: input.manifest.coordinateManifestSha256,
            metricEligibilitySha256: input.manifest.metricEligibilitySha256,
            observationSourceLineageSha256: input.manifest.sourceLineageSha256,
            observationStationManifestSha256: input.manifest.stationManifestSha256,
            spatialWeightSha256: input.manifest.spatialWeightsSha256,
        },
    });
    return deepFreeze({ candidate, developmentReport, state: "sufficient" });
}
// preserve the legacy thirty-date preregistration and result bytes
async function fitRetainedDevelopment(input) {
    const result = await fitRetainedDevelopmentCore(input);
    // propagate literal insufficiency without constructing a holdout
    if (result.state === "insufficient_data") {
        return result;
    }
    const { candidate, developmentReport } = result;
    const epoch = createQualificationCalendarEpoch(input.manifest.toLocalDate);
    const holdoutMembers = input.manifest.members.filter((member) => epoch.holdout.localDates.includes(member.localDate));
    const holdoutStartInclusive = minimumMemberInstant(holdoutMembers);
    const holdoutEndExclusive = nextLocalMidnightUtc(epoch.holdout.endLocalDate);
    const preregistration = createForecastAdjustmentPreregistration({
        algorithmImplementationSha256: canonicalSha256({
            algorithm: candidate.algorithmContractVersion,
            bootstrap: "moving-block-bootstrap/v1",
            implementation: "forecast-adjustment-retained-engine/v1",
        }),
        candidate,
        holdoutEndExclusive,
        holdoutEndLocalDate: epoch.holdout.endLocalDate,
        holdoutStartInclusive,
        holdoutStartLocalDate: epoch.holdout.startLocalDate,
        snapshotManifestSha256: input.snapshotManifestSha256,
    });
    const lineage = deriveHoldoutLineage(candidate);
    return deepFreeze({
        candidate,
        developmentReport,
        lineage,
        preregistration,
        state: "sufficient",
    });
}
// reject normalized or offset receipt clocks before comparing a due cutoff
function windMaintenanceInstant(value) {
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
        Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
// fit all thirteen existing wind pairs on the original monthly cutoff
export async function fitWindMaintenanceDevelopment(input) {
    // reject a caller-shaped epoch before any numerical fitting
    if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(input.dueMonth) ||
        !/^[a-f0-9]{64}$/u.test(input.snapshotManifestSha256)) {
        throw new RangeError("invalid wind maintenance identity");
    }
    // accept the legacy export only disjointly from the authenticated archive manifest
    if ("epochWitnessSha256" in input.manifest &&
        input.manifest.contractVersion === "adjustment-wind-archive-fit-manifest/v2") {
        validateArchiveWindFitManifest(input.manifest);
    }
    else {
        validateSnapshotManifestBoundary(input.manifest);
    }
    // bind the exact manifest instead of accepting a claimed content address
    if (canonicalSha256(input.manifest) !== input.snapshotManifestSha256) {
        throw new RangeError("wind maintenance manifest identity differs");
    }
    const epoch = createQualificationCalendarEpoch(input.manifest.toLocalDate);
    const cutoff = nextLocalMidnightUtc(addLocalCalendarDays(`${input.dueMonth}-01`, -1));
    const opened = new Map(input.openedMembers.map((member) => [member.memberSha256, member]));
    // reject duplicate receipts and incomplete calendar coverage
    if (opened.size !== input.openedMembers.length || input.manifest.fromLocalDate !== epoch.d0 ||
        input.manifest.toLocalDate !== epoch.d401 || nextLocalMidnightUtc(epoch.d401) > cutoff) {
        throw new RangeError("wind maintenance requires an earlier complete 402-date epoch");
    }
    // require actual source and target availability for every immutable member
    for (const member of input.manifest.members) {
        const receipt = opened.get(member.sha256);
        // reserved or unknown members cannot be opened by a fitter
        if (receipt === undefined || !windMaintenanceInstant(receipt.maximumSourceReceiptAt) ||
            !windMaintenanceInstant(receipt.maximumTargetReceiptAt) ||
            receipt.maximumSourceReceiptAt >= cutoff || receipt.maximumTargetReceiptAt >= cutoff) {
            throw new RangeError("wind maintenance member is not opened before the original cutoff");
        }
    }
    const covered = new Set(input.manifest.members.map((member) => member.localDate));
    // do not slide missed-month support to a later export
    if (epoch.localDates.some((date) => !covered.has(date))) {
        throw new RangeError("wind maintenance epoch has missing dates");
    }
    const trainingRows = input.rows.filter((row) => {
        const localDate = localCalendarFeaturesFor(row.validAt).localDate;
        return localDate >= epoch.finalTraining.startLocalDate && localDate <= epoch.finalTraining.endLocalDate;
    });
    // reject unknown and post-cutoff receipts rather than inventing training availability
    if (input.rows.some((row) => row.receivedAt === null ||
        !windMaintenanceInstant(row.receivedAt) || row.receivedAt >= cutoff ||
        !covered.has(localCalendarFeaturesFor(row.validAt).localDate))) {
        return createInsufficientDataReport({ failedGates: ["maintenance_earlier_receipt_provenance"],
            snapshotManifestSha256: input.snapshotManifestSha256 });
    }
    const result = await fitRetainedDevelopmentCore({ manifest: input.manifest,
        preHoldoutRows: trainingRows, snapshotManifestSha256: input.snapshotManifestSha256,
        maintenanceWindOnly: true });
    // preserve honest support refusal after a real numerical attempt
    if (result.state === "insufficient_data") {
        return result;
    }
    const pairs = result.candidate.enabledMetricBands;
    // an incomplete mask cannot become a recurring candidate
    if (pairs.length !== 13 || pairs.some((pair) => pair.metric === "windDirectionDegrees" ||
        (pair.metric === "windGustMps" && pair.leadBand === "049-072"))) {
        return createInsufficientDataReport({ failedGates: ["maintenance_exact_thirteen_pairs"],
            snapshotManifestSha256: input.snapshotManifestSha256 });
    }
    return deepFreeze({ contractVersion: "wind-maintenance-fit/v2",
        state: "development_candidate", candidate: result.candidate,
        developmentReport: result.developmentReport, dueMonth: input.dueMonth, confirmationOpened: false });
}
// construct metric-correct network events from one verified row phase
function buildRetainedTrainingEvents(rows, cohort = "legacy_v4_retrieval_snapshot", metrics = FORECAST_ADJUSTMENT_METRICS) {
    const stationsByInstant = new Map();
    // index physical station rows by exact forecast instant
    for (const row of rows) {
        if (row.recordKind !== "station_hour") {
            continue;
        }
        const current = stationsByInstant.get(row.validAt) ?? [];
        current.push(row);
        stationsByInstant.set(row.validAt, current);
    }
    const materials = new Map();
    const candidates = rows.flatMap((row, rowIndex) => {
        // isolate the requested immutable forecast cohort
        if (row.recordKind !== cohort) {
            return [];
        }
        return metrics.flatMap((metric) => {
            const raw = row.metrics[metric];
            // omit missing metric values
            if (raw === null ||
                (metric === "windDirectionDegrees" &&
                    (row.metrics.windSpeedMps === null || row.metrics.windSpeedMps < 1))) {
                return [];
            }
            const stableId = `${row.contentHashes[0]}:${rowIndex}:${metric}`;
            materials.set(stableId, { metric, row, stableId });
            return [{
                    cohort,
                    continuousLeadHours: row.referenceAt === null
                        ? row.targetLeadHours
                        : (Date.parse(row.validAt) - Date.parse(row.referenceAt)) /
                            3_600_000,
                    metric,
                    referenceAt: row.referenceAt,
                    referenceKind: row.referenceKind,
                    stableId,
                    targetLeadHours: row.targetLeadHours,
                    validAt: row.validAt,
                }];
        });
    });
    const selected = deduplicateForecastAtomicCandidates(candidates);
    const events = [];
    // build one equal-mass target for each selected forecast identity
    for (const selection of selected) {
        const material = materials.get(selection.stableId);
        // retain the compiler-proven candidate material
        if (material === undefined) {
            throw new Error("selected forecast material disappeared");
        }
        const stationRows = stationsByInstant.get(selection.validAt) ?? [];
        const actual = networkActualFor(stationRows, material.metric);
        // omit uncovered network targets
        if (actual === null) {
            continue;
        }
        events.push({
            actual,
            leadBand: forecastLeadBandFor(selection.targetLeadHours),
            localDate: localCalendarFeaturesFor(selection.validAt).localDate,
            metric: material.metric,
            rawForecast: material.row.metrics[material.metric],
            rawForecastMetrics: material.row.metrics,
            rawWindSpeedMps: material.row.metrics.windSpeedMps,
            referenceAt: selection.referenceAt,
            stableId: selection.stableId,
            stationRows,
            targetLeadHours: selection.targetLeadHours,
            validAt: selection.validAt,
        });
    }
    return deepFreeze(events);
}
// derive one network actual with an optional physical station excluded
function networkActualFor(rows, metric, excludedStation) {
    const contributions = rows.flatMap((row) => {
        const station = FORECAST_OBSERVATION_STATIONS.find((item) => item.key === row.physicalStationKey);
        const value = stationMetricValue(row, metric);
        // omit excluded, ineligible, and missing physical values
        if (station === undefined ||
            station.key === excludedStation ||
            !station.eligibleMetrics.includes(metric) ||
            value === null) {
            return [];
        }
        return [{
                nearestRank: station.nearestRank,
                pairedWindSpeedMps: row.metrics.windSpeedMps,
                physicalStationKey: station.key,
                unnormalizedSpatialWeight: station.unnormalizedSpatialWeight,
                value,
            }];
    });
    const actual = metric === "windDirectionDegrees"
        ? directionNetworkActual(contributions)
        : scalarNetworkActual(contributions);
    return actual?.value ?? null;
}
// apply metric-specific station eligibility at one matched instant
function stationMetricValue(row, metric) {
    const value = row.metrics[metric];
    // exclude calm station direction evidence
    if (metric === "windDirectionDegrees" &&
        (row.metrics.windSpeedMps === null || row.metrics.windSpeedMps < 1)) {
        return null;
    }
    return value;
}
// enforce the literal pre-holdout event support gates
function retainedSufficiencyFailures(events, expectedDates) {
    const failed = [];
    const dates = new Set(events.map((event) => event.localDate));
    // require broad network-date coverage
    if (dates.size < 330) {
        failed.push("network_330_local_dates");
    }
    for (const metric of FORECAST_ADJUSTMENT_METRICS) {
        const metricEvents = events.filter((event) => event.metric === metric);
        // require literal metric-wide support
        if (metricEvents.length > 0 && metricEvents.length < 6_000) {
            failed.push(`metric_6000_events_${metricToReason(metric)}`);
        }
    }
    const pairs = [...new Set(events.map((event) => `${event.metric}:${event.leadBand}`))];
    for (const pair of pairs) {
        const pairEvents = events.filter((event) => `${event.metric}:${event.leadBand}` === pair);
        // require literal metric-band support
        if (pairEvents.length < 500) {
            failed.push(`metric_band_500_events_${reasonKey(pair)}`);
        }
        const stationCounts = FORECAST_OBSERVATION_STATIONS.map((station) => ({
            count: pairEvents.filter((event) => event.stationRows.some((row) => row.physicalStationKey === station.key &&
                stationMetricValue(row, pairEvents[0]?.metric) !== null)).length,
            key: station.key,
        }));
        // require five physically distinct long-running stations
        if (stationCounts.filter((station) => station.count >= 1_000).length < 5) {
            failed.push(`five_stations_1000_events_${reasonKey(pair)}`);
        }
    }
    for (const season of ["winter", "spring", "summer", "autumn"]) {
        const seasonDates = new Set(events
            .filter((event) => localCalendarFeaturesFor(event.validAt).season === season)
            .map((event) => event.localDate));
        // require seasonal calendar support when the epoch contains the season
        if (new Set(expectedDates.filter((date) => localCalendarFeaturesFor(`${date}T12:00:00.000Z`).season === season)).size >= 60 &&
            seasonDates.size < 60) {
            failed.push(`season_60_dates_${season}`);
        }
    }
    return [...new Set(failed)].sort();
}
// score one development fold with station-excluded auxiliary models
function scoreDevelopmentFold(pairEvents, pair, fold) {
    const scored = FORECAST_OBSERVATION_STATIONS.flatMap((station) => {
        const training = pairEvents.filter((event) => fold.training.localDates.includes(event.localDate) &&
            event.stationRows.some((row) => row.physicalStationKey === station.key &&
                stationMetricValue(row, pair.metric) !== null));
        const score = pairEvents.filter((event) => fold.score.localDates.includes(event.localDate) &&
            event.stationRows.some((row) => row.physicalStationKey === station.key &&
                stationMetricValue(row, pair.metric) !== null));
        const auxiliaryEvents = training.flatMap((event) => {
            const actual = networkActualFor(event.stationRows, pair.metric, station.key);
            // omit targets that lose network coverage under exclusion
            if (actual === null) {
                return [];
            }
            return [{ ...event, actual }];
        });
        const coefficients = fitEventHierarchy(auxiliaryEvents, pair);
        const pairedEvents = score.flatMap((event) => {
            const remaining = networkActualFor(event.stationRows, pair.metric, station.key);
            const heldRow = event.stationRows.find((row) => row.physicalStationKey === station.key);
            const held = heldRow === undefined
                ? null
                : stationMetricValue(heldRow, pair.metric);
            // score only matched held-station and remaining-network events
            if (remaining === null || held === null || held === undefined) {
                return [];
            }
            const coefficient = selectHierarchyCoefficient(coefficients, pair.metric, pair.leadBand, localCalendarFeaturesFor(event.validAt));
            // require one exact auxiliary root
            if (coefficient === null) {
                return [];
            }
            return [{
                    actual: held,
                    adjustedPrediction: applyCappedCorrection(pair.metric, event.rawForecast, coefficient),
                    localDate: event.localDate,
                    rawPrediction: event.rawForecast,
                }];
        });
        // retain only literally scoreable auxiliary models
        if (auxiliaryEvents.length < 500 ||
            pairedEvents.length < 100 ||
            score.filter((event) => networkActualFor(event.stationRows, pair.metric, station.key) !== null).length < 100) {
            return [];
        }
        const losses = pairedLoss(pairedEvents, pair.metric === "windDirectionDegrees");
        return [{
                auxiliaryModelSha256: canonicalSha256({
                    coefficients,
                    fold: fold.fold,
                    metricBand: pair,
                    physicalStationKey: station.key,
                }),
                pairedEvents,
                score: {
                    adjustedLoss: losses.adjustedLoss,
                    eventCount: pairedEvents.length,
                    physicalStationKey: station.key,
                    pointSkill: losses.skill,
                    providerFamily: station.providerFamily,
                    rawLoss: losses.rawLoss,
                    remainingNetworkScoreEvents: pairedEvents.length,
                    scoreMatches: pairedEvents.length,
                    trainingMatches: auxiliaryEvents.length,
                },
            }];
    });
    const bootstrap = providerBalancedBootstrap(scored, fold.score.localDates, pair.metric);
    const harm = scored.flatMap((station) => {
        const result = bootstrapForEvents(station.pairedEvents, fold.score.localDates, station.score.physicalStationKey, pair.metric);
        return isMaterialHarm(result) ? [station.score.physicalStationKey] : [];
    });
    return evaluateDevelopmentLosoFold({
        auxiliaryModelSha256s: scored.map((station) => station.auxiliaryModelSha256),
        bootstrapLowerBound: bootstrap?.bootstrapLowerBound ?? -1,
        fold: fold.fold,
        materialHarmSliceKeys: harm,
        metricBand: pair,
        stationScores: scored.map((station) => station.score),
    });
}
// fit one hierarchy from equal-mass network events
function fitEventHierarchy(events, pair) {
    return fitRobustHierarchy(pair.metric, pair.leadBand, events.flatMap((event) => {
        const residual = forecastResidual({
            actualValue: event.actual,
            metric: event.metric,
            rawForecastValue: event.rawForecast,
            rawWindSpeedMps: event.rawWindSpeedMps,
        });
        // omit calm direction residuals
        if (residual === null) {
            return [];
        }
        return [withLocalHierarchyFeatures({
                referenceAt: event.referenceAt,
                residual,
                stableId: event.stableId,
                targetLeadHours: event.targetLeadHours,
                validAt: event.validAt,
                weight: 1,
            })];
    }));
}
// score exact paired event losses
function pairedLoss(events, direction) {
    const rawLoss = events.reduce((sum, event) => sum +
        (direction
            ? Math.abs(wrap180(event.actual - event.rawPrediction))
            : Math.abs(event.actual - event.rawPrediction)), 0) / events.length;
    const adjustedLoss = events.reduce((sum, event) => sum +
        (direction
            ? Math.abs(wrap180(event.actual - event.adjustedPrediction))
            : Math.abs(event.actual - event.adjustedPrediction)), 0) / events.length;
    return { adjustedLoss, rawLoss, skill: corePairedSkill(rawLoss, adjustedLoss) };
}
// bootstrap one scored event collection over exact local-date slots
function bootstrapForEvents(events, localDates, key, metric) {
    return movingBlockBootstrap([{
            dateSlots: localDates.map((localDate) => ({
                events: events.filter((event) => event.localDate === localDate),
                localDate,
            })),
            key,
        }], metric === "windDirectionDegrees");
}
// preserve equal station-within-family and equal-family bootstrap mass
function providerBalancedBootstrap(stations, localDates, metric) {
    // reject an unscoreable fold without drawing
    if (stations.length === 0) {
        return null;
    }
    const balanced = [];
    for (const localDate of localDates) {
        const families = [...new Set(stations.map((station) => station.score.providerFamily))]
            .sort();
        for (const family of families) {
            const familyStations = stations.filter((station) => station.score.providerFamily === family);
            const stationLosses = familyStations.flatMap((station) => {
                const events = station.pairedEvents.filter((event) => event.localDate === localDate);
                return events.length === 0
                    ? []
                    : [pairedLoss(events, metric === "windDirectionDegrees")];
            });
            // retain one equal-family daily loss occurrence
            if (stationLosses.length > 0) {
                balanced.push({
                    actual: 0,
                    adjustedPrediction: stationLosses.reduce((sum, loss) => sum + loss.adjustedLoss, 0) /
                        stationLosses.length,
                    localDate,
                    rawPrediction: stationLosses.reduce((sum, loss) => sum + loss.rawLoss, 0) /
                        stationLosses.length,
                });
            }
        }
    }
    return bootstrapForEvents(balanced, localDates, "provider-balanced", metric);
}
// score one unchanged candidate after the durable holdout burn
async function evaluateRetainedHoldout(input) {
    const events = buildRetainedTrainingEvents(input.holdoutRows);
    const holdoutDates = inclusiveLocalDates(input.preregistration.holdoutStartLocalDate, input.preregistration.holdoutEndLocalDate);
    const evaluations = input.candidate.enabledMetricBands.map((pair) => {
        const pairEvents = events.filter((event) => event.metric === pair.metric && event.leadBand === pair.leadBand);
        const networkEvents = scoreCandidateEvents(input.candidate, pairEvents, pair);
        const network = bootstrapForEvents(networkEvents, holdoutDates, `network:${pair.metric}:${pair.leadBand}`, pair.metric);
        const stationEvidence = FORECAST_OBSERVATION_STATIONS.flatMap((station) => {
            const stationEvents = networkEvents.flatMap((event) => {
                const source = pairEvents.find((candidate) => candidate.stableId === event.stableId);
                const actualRow = source?.stationRows.find((row) => row.physicalStationKey === station.key);
                const actual = actualRow === undefined
                    ? null
                    : stationMetricValue(actualRow, pair.metric);
                return actual === null || actual === undefined
                    ? []
                    : [{ ...event, actual }];
            });
            return stationEvents.length < 100
                ? []
                : [{
                        pairedEvents: stationEvents,
                        score: {
                            physicalStationKey: station.key,
                            providerFamily: station.providerFamily,
                        },
                        summary: toPairedScore(bootstrapForEvents(stationEvents, holdoutDates, station.key, pair.metric)),
                    }];
        });
        const providerBalanced = providerBalancedBootstrap(stationEvidence, holdoutDates, pair.metric);
        // require literal scoreable holdout support
        if (providerBalanced === null) {
            throw new RangeError("holdout lacks provider-balanced station evidence");
        }
        const providerSlices = [...new Set(stationEvidence.map((station) => station.score.providerFamily))].sort().map((family) => {
            const familyEvents = stationEvidence
                .filter((station) => station.score.providerFamily === family)
                .flatMap((station) => station.pairedEvents);
            return {
                ...toPairedScore(bootstrapForEvents(familyEvents, holdoutDates, `provider:${family}`, pair.metric)),
                key: family,
                kind: "provider_family",
            };
        });
        const nearestEvents = networkEvents.flatMap((event) => {
            const source = pairEvents.find((candidate) => candidate.stableId === event.stableId);
            const nearestRows = source?.stationRows.filter((row) => (FORECAST_OBSERVATION_STATIONS.find((station) => station.key === row.physicalStationKey)?.nearestRank ?? Number.POSITIVE_INFINITY) <= 3) ?? [];
            const actual = networkActualFor(nearestRows, pair.metric);
            return actual === null ? [] : [{ ...event, actual }];
        });
        const nearestSlice = {
            ...toPairedScore(bootstrapForEvents(nearestEvents, holdoutDates, "nearest-three", pair.metric)),
            key: "nearest-three",
            kind: "nearest_three",
        };
        const seasonGroups = new Map();
        for (const event of networkEvents) {
            const calendar = localCalendarFeaturesFor(event.validAt);
            const key = `${calendar.season}-${calendar.daypart}`;
            seasonGroups.set(key, [...(seasonGroups.get(key) ?? []), event]);
        }
        const seasonSlices = [...seasonGroups.entries()]
            .filter(([, occurrences]) => occurrences.length >= 100)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, occurrences]) => ({
            ...toPairedScore(bootstrapForEvents(occurrences, holdoutDates, `season:${key}`, pair.metric)),
            key: key,
            kind: "season_daypart",
        }));
        const criticalSlices = [
            nearestSlice,
            ...providerSlices,
            ...seasonSlices,
            ...stationEvidence.map((station) => ({
                ...station.summary,
                key: station.score.physicalStationKey,
                kind: "station",
            })),
        ];
        return {
            criticalSlices,
            evaluatedSeasonDaypartKeys: seasonSlices.map((slice) => slice.key),
            metricBand: pair,
            network: toPairedScore(network),
            providerBalanced: toPairedScore(providerBalanced),
            scoreableStationKeys: stationEvidence.map((station) => station.score.physicalStationKey).sort(),
        };
    });
    const evaluationReport = createForecastAdjustmentEvaluationReport({
        candidate: input.candidate,
        holdoutAccessMarker: input.holdoutAccessMarker,
        metricBandEvaluations: evaluations,
        preregistration: input.preregistration,
    });
    const attestation = createEvidenceRedundancyAttestation({
        candidateArtifactSha256: input.candidate.candidateArtifactSha256,
        evaluationReportSha256: evaluationReport.evaluationReportSha256,
        status: "independent_content_addressed_copy",
        verifiedAtUtc: new Date().toISOString(),
    });
    const contextByMetricBand = Object.fromEntries(evaluations.map((evaluation) => [
        `${evaluation.metricBand.metric}:${evaluation.metricBand.leadBand}`,
        {
            coefficientCoverageAndCapsPassed: input.candidate.coefficients.some((coefficient) => coefficient.level === 1 &&
                coefficient.metric === evaluation.metricBand.metric &&
                coefficient.leadBand === evaluation.metricBand.leadBand),
            criticalSlicesPassed: !evaluation.criticalSlices.some(isMaterialHarm),
            developmentFoldSkillPassed: true,
            productionIdentityPassed: true,
        },
    ]));
    const qualificationReceipt = createForecastAdjustmentQualificationReceipt({
        candidate: input.candidate,
        contextByMetricBand,
        evaluationReport,
        evidenceRedundancy: {
            attestationSha256: attestation.attestationSha256,
            status: attestation.status,
            verified: true,
        },
    });
    return { attestation, evaluationReport, qualificationReceipt };
}
// apply one candidate without refitting to matched holdout events
function scoreCandidateEvents(candidate, events, pair) {
    return events.flatMap((event) => {
        const coefficient = selectHierarchyCoefficient(candidate.coefficients, pair.metric, pair.leadBand, localCalendarFeaturesFor(event.validAt));
        // score only an exact enabled root
        if (coefficient === null) {
            return [];
        }
        return [{
                actual: event.actual,
                adjustedPrediction: applyCappedCorrection(pair.metric, event.rawForecast, coefficient),
                localDate: event.localDate,
                rawPrediction: event.rawForecast,
                stableId: event.stableId,
                validAt: event.validAt,
            }];
    });
}
// score one fixed-lead fit against separate live-v4 bridge events
function scoreFittedCanaryBridgeEvents(coefficients, events, pair, trainingEnvelope) {
    return events.flatMap((event) => {
        // match the runtime scalar training-envelope guard
        if (trainingEnvelope !== null &&
            (event.rawForecast < trainingEnvelope.minimum ||
                event.rawForecast > trainingEnvelope.maximum)) {
            return [];
        }
        const coefficient = selectHierarchyCoefficient(coefficients, pair.metric, pair.leadBand, localCalendarFeaturesFor(event.validAt));
        // score only an exact fitted hierarchy cell
        if (coefficient === null) {
            return [];
        }
        return [{
                actual: event.actual,
                adjustedPrediction: applyCappedCorrection(pair.metric, event.rawForecast, coefficient),
                localDate: event.localDate,
                rawPrediction: event.rawForecast,
            }];
    });
}
// strip bootstrap replicate material from an immutable aggregate score
function toPairedScore(result) {
    return {
        adjustedLoss: result.adjustedLoss,
        bootstrapLowerBound: result.bootstrapLowerBound,
        bootstrapUpperBound: result.bootstrapUpperBound,
        eventCount: result.eventCount,
        rawLoss: result.rawLoss,
        skill: result.skill,
    };
}
// derive every inclusive local-date label
function inclusiveLocalDates(start, end) {
    const dates = [];
    // advance by calendar labels rather than elapsed hours
    for (let date = start; date <= end; date = addLocalCalendarDays(date, 1)) {
        dates.push(date);
    }
    return dates;
}
// create a bounded reason fragment
function metricToReason(metric) {
    return metric.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
}
// sanitize one composite pair identity for a stable reason key
function reasonKey(value) {
    return value.replace(/[^a-zA-Z0-9]+/gu, "_").replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`).replace(/^_|_$/gu, "");
}
// select the first declared holdout instant
function minimumMemberInstant(members) {
    const minimum = members.map((member) => member.minValidAt).sort().at(0);
    // reject a holdout without any designated members
    if (minimum === undefined) {
        throw new RangeError("snapshot lacks designated holdout members");
    }
    return minimum;
}
// derive the exact Los Angeles midnight after one local date
function nextLocalMidnightUtc(endLocalDate) {
    const nextDate = addLocalCalendarDays(endLocalDate, 1);
    const target = Date.parse(`${nextDate}T00:00:00.000Z`);
    const formatter = new Intl.DateTimeFormat("en-US", {
        day: "2-digit",
        hour: "2-digit",
        hourCycle: "h23",
        minute: "2-digit",
        month: "2-digit",
        second: "2-digit",
        timeZone: "America/Los_Angeles",
        year: "numeric",
    });
    let candidate = target;
    // converge UTC to the requested local wall midnight
    for (let iteration = 0; iteration < 3; iteration += 1) {
        const parts = new Map(formatter.formatToParts(new Date(candidate)).map((part) => [part.type, part.value]));
        const represented = Date.UTC(Number(parts.get("year")), Number(parts.get("month")) - 1, Number(parts.get("day")), Number(parts.get("hour")), Number(parts.get("minute")), Number(parts.get("second")));
        candidate += target - represented;
    }
    return new Date(candidate).toISOString();
}
// validate one inclusive local-date range
function validateLocalDateRange(from, to) {
    const fromTime = Date.parse(`${from}T00:00:00.000Z`);
    const toTime = Date.parse(`${to}T00:00:00.000Z`);
    // reject grammar, rollover, or reverse bounds
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(from) ||
        !/^\d{4}-\d{2}-\d{2}$/u.test(to) ||
        new Date(fromTime).toISOString().slice(0, 10) !== from ||
        new Date(toTime).toISOString().slice(0, 10) !== to ||
        fromTime > toTime) {
        throw new RangeError("snapshot local-date range is invalid");
    }
}
// count inclusive UTC calendar labels
function inclusiveDateCount(from, to) {
    return ((Date.parse(`${to}T00:00:00.000Z`) -
        Date.parse(`${from}T00:00:00.000Z`)) /
        86_400_000 +
        1);
}
// require one exact object key set
function requireExactKeys(value, expected, description) {
    const actual = Object.keys(value).sort(compareText);
    const sortedExpected = [...expected].sort(compareText);
    // reject missing or extra manifest fields
    if (canonicalizeJson(actual) !== canonicalizeJson(sortedExpected)) {
        throw new RangeError(`${description} has unexpected fields`);
    }
}
// validate a requested exact triple
function validateRequestedHashes(input) {
    validateHash(input.candidateArtifactSha256, "candidateArtifactSha256");
    validateHash(input.evaluationReportSha256, "evaluationReportSha256");
    validateHash(input.qualificationReceiptSha256, "qualificationReceiptSha256");
}
// validate one SHA-256 identity
function validateHash(value, fieldName) {
    // require lowercase hexadecimal
    if (!HASH_PATTERN.test(value)) {
        throw new RangeError(`${fieldName} must be a SHA-256 hex value`);
    }
}
// hash exact bytes
function sha256(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}
// compare strings by code unit
function compareText(left, right) {
    // order lower values first
    if (left < right) {
        return -1;
    }
    // order higher values last
    if (left > right) {
        return 1;
    }
    return 0;
}
// convert filesystem failures to bounded diagnostics
function boundedFilesystemError(error, message) {
    const code = error !== null && typeof error === "object" && "code" in error
        ? String(error.code)
        : "unknown";
    return new Error(`${message} (${code})`);
}
