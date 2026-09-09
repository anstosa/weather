"""Research-only trajectory and strength extensions for the ECMWF winner."""

from __future__ import annotations

import datetime as dt
import math

import numpy as np

import temperature_seasonal_ridge as base
import temperature_shortlead_models as short


ECMWF_ONLY = "ecmwf_single_run_hindcast"
COHORTS = (ECMWF_ONLY,)
SCOPES = short.SCOPES
ARMS = ("trajectory", "learned_strength")
ALPHA_GRID = (0.35, 0.5, 0.65, 0.8, 1.0)
HORIZON_BANDS = {
    "1-6": (1, 6),
    "7-12": (7, 12),
}
POLICY = {
    "contractVersion": "temperature-winner-extensions-research/v1",
    "embargoHours": short.POLICY["embargoHours"],
    "minimumTrainingDates": short.POLICY["minimumTrainingDates"],
    "minimumTrainingRows": short.POLICY["minimumTrainingRows"],
    "strengthPenalty": 0.01,
    "correctionWeight": short.POLICY["correctionWeight"],
    "maximumCorrectionC": short.POLICY["maximumCorrectionC"],
    "physicalMinimumC": short.POLICY["physicalMinimumC"],
    "physicalMaximumC": short.POLICY["physicalMaximumC"],
    "productionEligible": False,
}


# require the single experimental provider
def _cohort(value):
    # reject every non-ecmwf cohort
    if value != ECMWF_ONLY:
        raise ValueError("winner extensions require the ECMWF cohort")
    return value


# choose all fixed source leads before reading temperatures
def _required_leads(lead):
    required = set(range(max(1, lead - 3), min(18, lead + 3) + 1))
    # choose the one-hour direction
    if lead >= 2:
        required.add(lead - 1)
    else:
        required.add(lead + 1)
    # choose the three-hour direction
    if lead >= 4:
        required.add(lead - 3)
    else:
        required.add(lead + 3)
    # choose the curvature stencil
    if lead <= 3:
        required.update((lead, lead + 3, lead + 6))
    elif lead >= 16:
        required.update((lead, lead - 3, lead - 6))
    else:
        required.update((lead - 3, lead, lead + 3))
    return sorted(required)


# derive one fixed nine-term trajectory vector
def _trajectory_values(lead, temperatures):
    # use a backward one-hour difference when available
    if lead >= 2:
        slope1 = temperatures[lead] - temperatures[lead - 1]
        slope1_forward = 0.0
    else:
        slope1 = temperatures[lead + 1] - temperatures[lead]
        slope1_forward = 1.0
    # use a backward three-hour difference when available
    if lead >= 4:
        slope3 = (temperatures[lead] - temperatures[lead - 3]) / 3
        slope3_forward = 0.0
    else:
        slope3 = (temperatures[lead + 3] - temperatures[lead]) / 3
        slope3_forward = 1.0
    # use a forward boundary stencil
    if lead <= 3:
        curvature = (
            temperatures[lead + 6]
            - 2 * temperatures[lead + 3]
            + temperatures[lead]
        ) / 9
        curvature_direction = 1.0
    # use a backward boundary stencil
    elif lead >= 16:
        curvature = (
            temperatures[lead]
            - 2 * temperatures[lead - 3]
            + temperatures[lead - 6]
        ) / 9
        curvature_direction = -1.0
    # use the centered stencil
    else:
        curvature = (
            temperatures[lead + 3]
            - 2 * temperatures[lead]
            + temperatures[lead - 3]
        ) / 9
        curvature_direction = 0.0
    window_leads = range(max(1, lead - 3), min(18, lead + 3) + 1)
    window = [temperatures[source_lead] for source_lead in window_leads]
    window_mean = float(np.mean(window))
    result = np.asarray(
        [
            slope1 / 3,
            slope3 / 3,
            curvature,
            (temperatures[lead] - window_mean) / 3,
            (max(window) - min(window)) / 3,
            slope1_forward,
            slope3_forward,
            curvature_direction,
            len(window) / 7,
        ],
        dtype=np.float64,
    )
    # enforce the frozen trajectory schema
    if len(result) != 9 or not np.isfinite(result).all():
        raise ValueError("non-finite trajectory feature vector")
    return result.tolist()


# freeze same-run trajectory metadata for every provider row
def build_trajectories(forecast_rows, cohort):
    selected_cohort = _cohort(cohort)
    runs = {}
    seen_keys = set()
    # validate and group identities before reading temperatures
    for row in forecast_rows:
        # isolate foreign providers before validation
        if row.get("cohort") != selected_cohort:
            continue
        key, run_initialized_at, _, model_lead = short._forecast_identity(row)
        # reject reused durable keys
        if key in seen_keys:
            raise ValueError("duplicate forecast key")
        seen_keys.add(key)
        cycle = row.get("modelCycle")
        # require one declared model cycle
        if not isinstance(cycle, str) or not cycle:
            raise ValueError("model cycle must be a nonempty string")
        run_key = short._format_instant(run_initialized_at)
        run = runs.setdefault(run_key, {"cycle": cycle, "rows": {}})
        # reject contradictory run identity
        if run["cycle"] != cycle:
            raise ValueError("model cycle does not match within initialization")
        # reject duplicate run-lead slots
        if model_lead in run["rows"]:
            raise ValueError("duplicate forecast run and lead")
        run["rows"][model_lead] = row
    trajectories = {}
    # derive each target only from its fixed same-run slots
    for run_key in sorted(runs):
        run = runs[run_key]
        rows_by_lead = run["rows"]
        # visit leads rather than input order
        for lead in sorted(rows_by_lead):
            target = rows_by_lead[lead]
            required_leads = _required_leads(lead)
            selected_rows = [
                rows_by_lead[source_lead]
                for source_lead in required_leads
                if source_lead in rows_by_lead
            ]
            metadata = {
                "cohort": selected_cohort,
                "runInitializedAt": run_key,
                "targetKey": target["key"],
                "modelLeadHours": lead,
                "modelCycle": run["cycle"],
                "sourceKeys": [row["key"] for row in selected_rows],
                "supported": False,
                "features9": None,
            }
            # preserve explicit missing-slot support
            if len(selected_rows) != len(required_leads):
                trajectories[target["key"]] = metadata
                continue
            temperatures = {}
            missing = False
            # read only the previously selected raw values
            for source_lead, source_row in zip(required_leads, selected_rows):
                raw = source_row.get("rawTemperatureC")
                # treat null raw forecasts as unavailable
                if raw is None:
                    missing = True
                    continue
                temperatures[source_lead] = base.number(raw)
            # preserve explicit missing-temperature support
            if missing:
                trajectories[target["key"]] = metadata
                continue
            metadata["supported"] = True
            metadata["features9"] = _trajectory_values(lead, temperatures)
            trajectories[target["key"]] = metadata
    return trajectories


# validate one attached trajectory receipt
def _trajectory_provenance(row):
    trajectory = row.get("trajectory")
    # require serialized trajectory metadata
    if not isinstance(trajectory, dict):
        raise ValueError("row requires trajectory metadata")
    key, run_initialized_at, _, model_lead = short._forecast_identity(row)
    # bind trajectory identity to its row
    if (
        trajectory.get("cohort") != row.get("cohort")
        or trajectory.get("runInitializedAt")
        != short._format_instant(run_initialized_at)
        or trajectory.get("targetKey") != key
        or trajectory.get("modelLeadHours") != model_lead
        or trajectory.get("modelCycle") != row.get("modelCycle")
    ):
        raise ValueError("trajectory identity does not match forecast row")
    source_keys = trajectory.get("sourceKeys")
    # require unique selected source identities
    if (
        not isinstance(source_keys, list)
        or any(not isinstance(source_key, str) or not source_key for source_key in source_keys)
        or len(source_keys) != len(set(source_keys))
    ):
        raise ValueError("trajectory source keys are invalid")
    supported = trajectory.get("supported")
    # require explicit trajectory support
    if not isinstance(supported, bool):
        raise ValueError("trajectory support flag must be boolean")
    values = trajectory.get("features9")
    # preserve explicit unsupported metadata
    if not supported:
        # reject hidden unsupported vectors
        if values is not None:
            raise ValueError("unsupported trajectory must have null features")
        return False, None
    # bind supported receipts to the full fixed stencil
    if len(source_keys) != len(_required_leads(model_lead)) or key not in source_keys:
        raise ValueError("supported trajectory source keys do not match its stencil")
    # enforce the fixed feature width
    if not isinstance(values, list) or len(values) != 9:
        raise ValueError("trajectory features do not match schema")
    converted = np.asarray([base.number(value) for value in values], dtype=np.float64)
    # reject non-finite feature vectors
    if not np.isfinite(converted).all():
        raise ValueError("trajectory features must be finite")
    return True, converted


# expose one validated trajectory vector
def trajectory_features(row):
    supported, features = _trajectory_provenance(row)
    # require support for model features
    if not supported:
        raise ValueError("trajectory features require supported metadata")
    return features


# validate the frozen winner's causal prediction receipt
def _incumbent_provenance(row):
    supported = row.get("incumbentSupported")
    # require explicit incumbent support
    if not isinstance(supported, bool):
        raise ValueError("incumbent support flag must be boolean")
    prediction = row.get("incumbentTemperatureC")
    unscaled = row.get("incumbentUnscaledCorrectionC")
    cutoff_value = row.get("incumbentTrainingCutoffUtc")
    # preserve an explicit incumbent cold start
    if not supported:
        # reject fabricated learned provenance
        if unscaled is not None or cutoff_value is not None:
            raise ValueError("unsupported incumbent must have null learned provenance")
        # permit a null or exact raw display value
        if prediction is not None and base.number(prediction) != base.number(
            row["rawTemperatureC"]
        ):
            raise ValueError("unsupported incumbent display must equal raw")
        return False, prediction, None, None
    prediction = base.number(prediction)
    unscaled = base.number(unscaled)
    cutoff = base.instant(cutoff_value)
    run_initialized_at = base.instant(row["runInitializedAt"])
    # prevent winner leakage
    if cutoff >= run_initialized_at:
        raise ValueError("incumbent cutoff must strictly precede initialization")
    raw = base.number(row["rawTemperatureC"])
    # bind the stored prediction to the winner correction
    if short._adjust(raw, unscaled) != prediction:
        raise ValueError("incumbent prediction does not match its correction")
    return True, prediction, unscaled, cutoff


# append trajectory terms to the direct winner schema
def direct_features(row):
    result = np.concatenate((short.static_features(row), trajectory_features(row)))
    # enforce the fixed direct width
    if len(result) != 44 or not np.isfinite(result).all():
        raise ValueError("non-finite direct trajectory feature vector")
    return result


# append trajectory terms to the adaptive winner schema
def adaptive_features(row):
    result = np.concatenate((short.adaptive_features(row), trajectory_features(row)))
    # enforce the fixed adaptive width
    if len(result) != 58 or not np.isfinite(result).all():
        raise ValueError("non-finite adaptive trajectory feature vector")
    return result


# count unique represented local dates
def _date_count(rows):
    return len(
        {
            base.instant(row["validAt"]).astimezone(base.ZONE).date()
            for row in rows
        }
    )


# determine fixed training support
def _supported(rows):
    return (
        len(rows) >= POLICY["minimumTrainingRows"]
        and _date_count(rows) >= POLICY["minimumTrainingDates"]
    )


# build one deterministic training receipt
def _training_receipt(rows):
    return {
        "trainingRows": len(rows),
        "trainingDates": _date_count(rows),
        "firstTrainingValidAt": min(
            (row["validAt"] for row in rows), default=None
        ),
        "lastTrainingValidAt": max(
            (row["validAt"] for row in rows), default=None
        ),
        "trainingKeys": [row["key"] for row in rows],
    }


# apply one candidate correction strength
def _adjust_strength(raw, unscaled, alpha):
    correction = max(
        -POLICY["maximumCorrectionC"],
        min(POLICY["maximumCorrectionC"], alpha * base.number(unscaled)),
    )
    return max(
        POLICY["physicalMinimumC"],
        min(POLICY["physicalMaximumC"], base.number(raw) + correction),
    )


# score and select one fixed strength grid
def _fit_strength_band(rows):
    supported = _supported(rows)
    receipt = {
        "supported": supported,
        "alpha": POLICY["correctionWeight"],
        "gridCosts": [],
        **_training_receipt(rows),
    }
    # preserve the incumbent strength below support
    if not supported:
        return receipt
    weights = short.event_weights(rows)
    actuals = np.asarray(
        [base.number(row["actualTemperatureC"]) for row in rows],
        dtype=np.float64,
    )
    raw_values = np.asarray(
        [base.number(row["rawTemperatureC"]) for row in rows],
        dtype=np.float64,
    )
    unscaled_values = np.asarray(
        [base.number(row["incumbentUnscaledCorrectionC"]) for row in rows],
        dtype=np.float64,
    )
    candidates = []
    # score every preregistered alpha
    for alpha in ALPHA_GRID:
        predictions = np.asarray(
            [
                _adjust_strength(raw, unscaled, alpha)
                for raw, unscaled in zip(raw_values, unscaled_values)
            ],
            dtype=np.float64,
        )
        mae = float(np.sum(weights * np.abs(predictions - actuals)) / np.sum(weights))
        penalty = POLICY["strengthPenalty"] * (alpha - 0.5) ** 2
        score = mae + penalty
        cost = {
            "alpha": alpha,
            "weightedMaeC": mae,
            "penalty": penalty,
            "penalizedScore": score,
        }
        receipt["gridCosts"].append(cost)
        candidates.append((score, abs(alpha - 0.5), alpha))
    receipt["alpha"] = min(candidates)[2]
    return receipt


# fit both independent winner extensions from earlier-only rows
def fit(rows, month, cohort, scope):
    selected_cohort = _cohort(cohort)
    short._scope(scope)
    cutoff = base.month_start(month) - dt.timedelta(hours=POLICY["embargoHours"])
    selected = short.training_rows(rows, month, selected_cohort, scope)
    trajectory_rows = []
    strength_rows = {band: [] for band in HORIZON_BANDS}
    # validate provenance before independently filtering support
    for row in selected:
        trajectory_supported, _ = _trajectory_provenance(row)
        incumbent_supported, _, _, _ = _incumbent_provenance(row)
        # retain supported same-run trajectories
        if trajectory_supported:
            trajectory_rows.append(row)
        # retain supported historical winner predictions by horizon band
        if incumbent_supported:
            horizon = short._integer(
                row["operationalHorizonHours"], "operational horizon"
            )
            # assign exactly one fixed band
            for band, (minimum, maximum) in HORIZON_BANDS.items():
                # retain matching horizons
                if minimum <= horizon <= maximum:
                    strength_rows[band].append(row)
                    break
    trajectory_supported = _supported(trajectory_rows)
    model = {
        "contractVersion": POLICY["contractVersion"],
        "month": month,
        "cohort": selected_cohort,
        "scope": scope,
        "trajectorySupported": trajectory_supported,
        "trajectoryDirectCoefficients": None,
        "trajectoryAdaptiveCoefficients": None,
        "trainingCutoffUtc": short._format_instant(cutoff),
        **{
            f"trajectory{key[0].upper()}{key[1:]}": value
            for key, value in _training_receipt(trajectory_rows).items()
        },
        "strengthBands": {},
    }
    # fit the two augmented winner schemas
    if trajectory_supported:
        weights = short.event_weights(trajectory_rows)
        residuals = np.asarray(
            [
                short._residual(
                    row["actualTemperatureC"], row["rawTemperatureC"]
                )
                for row in trajectory_rows
            ],
            dtype=np.float64,
        )
        model["trajectoryDirectCoefficients"] = short._fit_coefficients(
            np.stack([direct_features(row) for row in trajectory_rows]),
            residuals,
            weights,
        )
        model["trajectoryAdaptiveCoefficients"] = short._fit_coefficients(
            np.stack([adaptive_features(row) for row in trajectory_rows]),
            residuals,
            weights,
        )
    # fit both horizon-specific strength grids
    for band in HORIZON_BANDS:
        band_model = _fit_strength_band(strength_rows[band])
        band_model["trainingCutoffUtc"] = short._format_instant(cutoff)
        model["strengthBands"][band] = band_model
    return model


# validate one fitted extension model identity
def _validated_model(row, model):
    # require serialized model state
    if not isinstance(model, dict):
        raise ValueError("winner extension model must be an object")
    # reject contract drift
    if model.get("contractVersion") != POLICY["contractVersion"]:
        raise ValueError("winner extension model contract does not match")
    cohort = _cohort(model.get("cohort"))
    scope = model.get("scope")
    short._scope(scope)
    # enforce provider identity
    if row.get("cohort") != cohort:
        raise ValueError("forecast cohort does not match winner extension model")
    _, run_initialized_at, valid_at, _, _ = short._scope_identity(row, scope)
    # enforce target-month selection
    if valid_at.astimezone(base.ZONE).strftime("%Y-%m") != model.get("month"):
        raise ValueError("forecast target month does not match winner extension model")
    trajectory_cutoff = base.instant(model["trainingCutoffUtc"])
    # prevent trajectory fitting leakage
    if trajectory_cutoff >= run_initialized_at:
        raise ValueError("trajectory model cutoff must strictly precede initialization")
    # require explicit trajectory support
    if not isinstance(model.get("trajectorySupported"), bool):
        raise ValueError("trajectory support flag must be boolean")
    bands = model.get("strengthBands")
    # require both fixed strength bands
    if not isinstance(bands, dict) or set(bands) != set(HORIZON_BANDS):
        raise ValueError("strength bands do not match model schema")
    # validate every strength receipt
    for band in HORIZON_BANDS:
        band_model = bands[band]
        # require one serialized band
        if not isinstance(band_model, dict):
            raise ValueError("strength band must be an object")
        # require explicit band support
        if not isinstance(band_model.get("supported"), bool):
            raise ValueError("strength support flag must be boolean")
        alpha = base.number(band_model.get("alpha"))
        # restrict alpha to the frozen grid
        if alpha not in ALPHA_GRID:
            raise ValueError("strength alpha is outside the frozen grid")
        band_cutoff = base.instant(band_model["trainingCutoffUtc"])
        # prevent strength fitting leakage
        if band_cutoff >= run_initialized_at:
            raise ValueError("strength model cutoff must strictly precede initialization")
    return scope


# require one finite coefficient vector of the frozen width
def _coefficients(model, field, width):
    values = model.get(field)
    # enforce vector width
    if not isinstance(values, list) or len(values) != width:
        raise ValueError("winner extension coefficients do not match feature schema")
    converted = np.asarray([base.number(value) for value in values], dtype=np.float64)
    # reject non-finite models
    if not np.isfinite(converted).all():
        raise ValueError("winner extension coefficients must be finite")
    return converted


# map one operational horizon to its fixed strength band
def _horizon_band(horizon):
    # choose the early band
    if horizon <= 6:
        return "1-6"
    return "7-12"


# apply one extension while preserving the current winner as fallback
def predict(row, model, incumbent_prediction, arm):
    # preserve every foreign provider before validating other inputs
    if row.get("cohort") != ECMWF_ONLY:
        return incumbent_prediction
    horizon = short._integer(row["operationalHorizonHours"], "operational horizon")
    # preserve every outer horizon before validating other inputs
    if not 1 <= horizon <= 12:
        return incumbent_prediction
    # require one frozen extension arm
    if arm not in ARMS:
        raise ValueError("unsupported winner extension arm")
    _validated_model(row, model)
    incumbent_supported, incumbent, unscaled, _ = _incumbent_provenance(row)
    # preserve incumbent cold starts exactly
    if not incumbent_supported:
        return incumbent_prediction
    supplied_incumbent = base.number(incumbent_prediction)
    # bind the supplied baseline to row provenance
    if supplied_incumbent != incumbent:
        raise ValueError("incumbent prediction does not match row provenance")
    # apply horizon-specific correction strength
    if arm == "learned_strength":
        band_model = model["strengthBands"][_horizon_band(horizon)]
        # preserve independently unsupported bands
        if not band_model["supported"]:
            return incumbent_prediction
        return _adjust_strength(
            row["rawTemperatureC"], unscaled, base.number(band_model["alpha"])
        )
    # preserve trajectory model cold starts
    if not model["trajectorySupported"]:
        return incumbent_prediction
    trajectory_supported, _ = _trajectory_provenance(row)
    # preserve missing same-run trajectories
    if not trajectory_supported:
        return incumbent_prediction
    raw = base.number(row["rawTemperatureC"])
    state, *_ = short._validated_state(row)
    # use the direct schema without supported recent-error state
    if not state["supported"]:
        coefficients = _coefficients(
            model, "trajectoryDirectCoefficients", 44
        )
        return short._adjust(raw, direct_features(row) @ coefficients)
    coefficients = _coefficients(
        model, "trajectoryAdaptiveCoefficients", 58
    )
    return short._adjust(raw, adaptive_features(row) @ coefficients)
