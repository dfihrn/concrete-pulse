import { isNotableTvlChange } from "./pulse.js";

export const ONE_HOUR_MS = 60 * 60 * 1000;
export const TWENTY_FOUR_HOURS_MS = 24 * ONE_HOUR_MS;

// A five-minute collector will normally place the first and last samples just
// inside a requested boundary. This tolerance allows one expected sampling
// interval plus normal scheduling jitter without pretending a shorter history
// covers the requested window.
export const DEFAULT_COVERAGE_TOLERANCE_MS = 7.5 * 60 * 1000;

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const CATEGORY_ORDER = ["TVL", "APY", "Depositors", "Presence"];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseTimestamp(value, label) {
  const timestamp = value instanceof Date
    ? value.getTime()
    : typeof value === "number"
      ? value
      : Date.parse(value);

  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`${label} must be a valid timestamp.`);
  }

  return timestamp;
}

function normalizeChainId(value, label) {
  const chainId = Number(value);

  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }

  return chainId;
}

function normalizeMetric(value, label, { unavailableValue } = {}) {
  if (value === null || (unavailableValue !== undefined && value === unavailableValue)) {
    return null;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number or null.`);
  }

  return value;
}

function normalizeDepositors(value, label) {
  if (value === null) {
    return null;
  }

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer or null.`);
  }

  return value;
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) {
    throw new TypeError("History must be an array.");
  }

  const observations = history.map((observation, observationIndex) => {
    if (!isPlainObject(observation)) {
      throw new TypeError(`History observation ${observationIndex} must be an object.`);
    }

    const timestamp = parseTimestamp(
      observation.collectedAt,
      `History observation ${observationIndex} collectedAt`,
    );

    if (!isPlainObject(observation.vaults)) {
      throw new TypeError(`History observation ${observationIndex} vaults must be an object.`);
    }

    const vaults = new Map();
    const normalizedChains = new Set();

    for (const [chainKey, chainVaults] of Object.entries(observation.vaults)) {
      const chainId = normalizeChainId(
        chainKey,
        `History observation ${observationIndex} chain ID`,
      );

      if (normalizedChains.has(chainId)) {
        throw new Error(
          `History observation ${observationIndex} contains duplicate normalized chain ID ${chainId}.`,
        );
      }
      normalizedChains.add(chainId);

      if (!isPlainObject(chainVaults)) {
        throw new TypeError(
          `History observation ${observationIndex} chain ${chainId} must contain a vault object.`,
        );
      }

      for (const [sourceAddress, vault] of Object.entries(chainVaults)) {
        if (!ADDRESS_PATTERN.test(sourceAddress)) {
          throw new TypeError(
            `History observation ${observationIndex} contains an invalid vault address.`,
          );
        }

        if (!isPlainObject(vault)) {
          throw new TypeError(
            `History observation ${observationIndex} vault ${sourceAddress} must be an object.`,
          );
        }

        const address = sourceAddress.toLowerCase();
        const identity = `${chainId}:${address}`;

        if (vaults.has(identity)) {
          throw new Error(
            `History observation ${observationIndex} contains duplicate normalized vault identity ${identity}.`,
          );
        }

        const name = typeof vault.name === "string" && vault.name.trim()
          ? vault.name.trim()
          : address;

        vaults.set(identity, {
          identity,
          chainId,
          address,
          name,
          tvl: normalizeMetric(
            vault.tvl,
            `History observation ${observationIndex} vault ${identity} TVL`,
          ),
          apy: normalizeMetric(
            vault.apy,
            `History observation ${observationIndex} vault ${identity} APY`,
            { unavailableValue: -1 },
          ),
          depositors: normalizeDepositors(
            vault.depositors,
            `History observation ${observationIndex} vault ${identity} depositors`,
          ),
        });
      }
    }

    return {
      collectedAt: new Date(timestamp).toISOString(),
      timestamp,
      vaults,
    };
  });

  observations.sort((left, right) => left.timestamp - right.timestamp);

  for (let index = 1; index < observations.length; index += 1) {
    if (observations[index - 1].timestamp === observations[index].timestamp) {
      throw new Error(
        `History contains duplicate collectedAt timestamp ${observations[index].collectedAt}.`,
      );
    }
  }

  return observations;
}

function compareIdentity(left, right) {
  return left.chainId - right.chainId || left.address.localeCompare(right.address);
}

function makeVaultAccumulator(vault, collectedAt) {
  return {
    chainId: vault.chainId,
    address: vault.address,
    name: vault.name,
    firstObservedAt: collectedAt,
    lastObservedAt: collectedAt,
    startTvl: vault.tvl,
    endTvl: vault.tvl,
    startApy: vault.apy,
    endApy: vault.apy,
    startDepositors: vault.depositors,
    endDepositors: vault.depositors,
    tvlChangeIntervals: 0,
    notableTvlIntervals: 0,
    positiveTvlIntervals: 0,
    negativeTvlIntervals: 0,
    apyChangeIntervals: 0,
    depositorChangeIntervals: 0,
    presenceChangeIntervals: 0,
    appeared: false,
    disappeared: false,
    changedIntervals: new Set(),
    categoriesChanged: new Set(),
  };
}

function updateObservedVault(accumulator, vault, collectedAt) {
  accumulator.name = vault.name;
  accumulator.lastObservedAt = collectedAt;
  accumulator.endTvl = vault.tvl;
  accumulator.endApy = vault.apy;
  accumulator.endDepositors = vault.depositors;
}

function recordTvlInterval(accumulator, previousValue, currentValue, intervalIndex) {
  if (previousValue === null || currentValue === null || previousValue === currentValue) {
    return;
  }

  const change = currentValue - previousValue;
  const percentageChange = previousValue === 0
    ? null
    : (change / Math.abs(previousValue)) * 100;

  accumulator.tvlChangeIntervals += 1;
  accumulator.categoriesChanged.add("TVL");
  accumulator.changedIntervals.add(intervalIndex);

  if (change > 0) {
    accumulator.positiveTvlIntervals += 1;
  } else {
    accumulator.negativeTvlIntervals += 1;
  }

  if (isNotableTvlChange({ previousValue, currentValue, change, percentageChange })) {
    accumulator.notableTvlIntervals += 1;
  }
}

function recordMetricInterval(
  accumulator,
  previousValue,
  currentValue,
  intervalIndex,
  countField,
  category,
) {
  if (previousValue === null || currentValue === null || previousValue === currentValue) {
    return;
  }

  accumulator[countField] += 1;
  accumulator.categoriesChanged.add(category);
  accumulator.changedIntervals.add(intervalIndex);
}

function recordPresenceInterval(accumulator, kind, intervalIndex) {
  accumulator[kind] = true;
  accumulator.presenceChangeIntervals += 1;
  accumulator.categoriesChanged.add("Presence");
  accumulator.changedIntervals.add(intervalIndex);
}

function netChange(startValue, endValue) {
  return startValue === null || endValue === null ? null : endValue - startValue;
}

function relativeChange(startValue, change) {
  return change === null || startValue === null || startValue === 0
    ? null
    : (change / Math.abs(startValue)) * 100;
}

function finalizeVault(accumulator) {
  const tvlNetChange = netChange(accumulator.startTvl, accumulator.endTvl);
  const apyNetChange = netChange(accumulator.startApy, accumulator.endApy);
  const depositorNetChange = netChange(
    accumulator.startDepositors,
    accumulator.endDepositors,
  );
  const categoriesChanged = CATEGORY_ORDER.filter((category) =>
    accumulator.categoriesChanged.has(category));

  return {
    chainId: accumulator.chainId,
    address: accumulator.address,
    name: accumulator.name,
    tvl: {
      startValue: accumulator.startTvl,
      endValue: accumulator.endTvl,
      netChange: tvlNetChange,
      percentageChange: relativeChange(accumulator.startTvl, tvlNetChange),
      changeIntervals: accumulator.tvlChangeIntervals,
      notableIntervals: accumulator.notableTvlIntervals,
      positiveIntervals: accumulator.positiveTvlIntervals,
      negativeIntervals: accumulator.negativeTvlIntervals,
    },
    apy: {
      startValue: accumulator.startApy,
      endValue: accumulator.endApy,
      netChange: apyNetChange,
      percentagePointChange: apyNetChange === null ? null : apyNetChange * 100,
      changeIntervals: accumulator.apyChangeIntervals,
    },
    depositors: {
      startValue: accumulator.startDepositors,
      endValue: accumulator.endDepositors,
      netChange: depositorNetChange,
      changeIntervals: accumulator.depositorChangeIntervals,
    },
    presence: {
      firstObservedAt: accumulator.firstObservedAt,
      lastObservedAt: accumulator.lastObservedAt,
      appeared: accumulator.appeared,
      disappeared: accumulator.disappeared,
    },
    activity: {
      notableTvlIntervals: accumulator.notableTvlIntervals,
      apyChangeIntervals: accumulator.apyChangeIntervals,
      depositorChangeIntervals: accumulator.depositorChangeIntervals,
      presenceChangeIntervals: accumulator.presenceChangeIntervals,
      categoriesChanged,
      // Count each observation-to-observation span once, even when several
      // metrics changed in that same span.
      totalChangedIntervals: accumulator.changedIntervals.size,
    },
  };
}

function analyzeNormalizedWindow(
  observations,
  { windowMs, anchorTimestamp, coverageToleranceMs },
) {
  const windowStartTimestamp = anchorTimestamp - windowMs;
  const selected = observations.filter((observation) =>
    observation.timestamp >= windowStartTimestamp && observation.timestamp <= anchorTimestamp);
  const accumulators = new Map();

  for (let observationIndex = 0; observationIndex < selected.length; observationIndex += 1) {
    const observation = selected[observationIndex];

    for (const [identity, vault] of observation.vaults) {
      let accumulator = accumulators.get(identity);

      if (!accumulator) {
        accumulator = makeVaultAccumulator(vault, observation.collectedAt);
        accumulators.set(identity, accumulator);
      } else {
        updateObservedVault(accumulator, vault, observation.collectedAt);
      }
    }

    if (observationIndex === 0) {
      continue;
    }

    const previousObservation = selected[observationIndex - 1];
    const identities = new Set([
      ...previousObservation.vaults.keys(),
      ...observation.vaults.keys(),
    ]);

    for (const identity of identities) {
      const previousVault = previousObservation.vaults.get(identity);
      const currentVault = observation.vaults.get(identity);
      const accumulator = accumulators.get(identity);

      if (!previousVault) {
        recordPresenceInterval(accumulator, "appeared", observationIndex);
        continue;
      }

      if (!currentVault) {
        recordPresenceInterval(accumulator, "disappeared", observationIndex);
        continue;
      }

      recordTvlInterval(
        accumulator,
        previousVault.tvl,
        currentVault.tvl,
        observationIndex,
      );
      recordMetricInterval(
        accumulator,
        previousVault.apy,
        currentVault.apy,
        observationIndex,
        "apyChangeIntervals",
        "APY",
      );
      recordMetricInterval(
        accumulator,
        previousVault.depositors,
        currentVault.depositors,
        observationIndex,
        "depositorChangeIntervals",
        "Depositors",
      );
    }
  }

  const firstObservation = selected[0] ?? null;
  const lastObservation = selected.at(-1) ?? null;
  const startGapMs = firstObservation
    ? firstObservation.timestamp - windowStartTimestamp
    : null;
  const endGapMs = lastObservation
    ? anchorTimestamp - lastObservation.timestamp
    : null;

  return {
    requestedWindowMs: windowMs,
    anchorTime: new Date(anchorTimestamp).toISOString(),
    windowStart: new Date(windowStartTimestamp).toISOString(),
    startTime: firstObservation?.collectedAt ?? null,
    endTime: lastObservation?.collectedAt ?? null,
    observedSpanMs: firstObservation && lastObservation
      ? lastObservation.timestamp - firstObservation.timestamp
      : 0,
    observationCount: selected.length,
    partial: !firstObservation
      || startGapMs > coverageToleranceMs
      || endGapMs > coverageToleranceMs,
    coverage: {
      toleranceMs: coverageToleranceMs,
      startGapMs,
      endGapMs,
    },
    vaults: [...accumulators.values()].map(finalizeVault).sort(compareIdentity),
  };
}

function validateWindowOptions(windowMs, coverageToleranceMs) {
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new TypeError("windowMs must be a positive finite number.");
  }

  if (!Number.isFinite(coverageToleranceMs) || coverageToleranceMs < 0) {
    throw new TypeError("coverageToleranceMs must be a non-negative finite number.");
  }
}

function resolveAnchorTimestamp(observations, anchorTime) {
  if (anchorTime !== undefined && anchorTime !== null) {
    return parseTimestamp(anchorTime, "anchorTime");
  }

  const latestObservation = observations.at(-1);

  if (!latestObservation) {
    throw new Error("Cannot infer anchorTime from empty history.");
  }

  return latestObservation.timestamp;
}

/**
 * Analyze one lookback window without fetching, persisting, or mutating history.
 * Interval counts compare adjacent observations only; missing samples and null
 * metrics are never interpolated.
 */
export function analyzeHistoryWindow(
  history,
  {
    windowMs,
    anchorTime,
    coverageToleranceMs = DEFAULT_COVERAGE_TOLERANCE_MS,
  } = {},
) {
  validateWindowOptions(windowMs, coverageToleranceMs);
  const observations = normalizeHistory(history);
  const anchorTimestamp = resolveAnchorTimestamp(observations, anchorTime);

  return analyzeNormalizedWindow(observations, {
    windowMs,
    anchorTimestamp,
    coverageToleranceMs,
  });
}

/** Derive the standard Concrete Pulse 1-hour and 24-hour windows. */
export function analyzeHistory(
  history,
  {
    anchorTime,
    coverageToleranceMs = DEFAULT_COVERAGE_TOLERANCE_MS,
  } = {},
) {
  validateWindowOptions(ONE_HOUR_MS, coverageToleranceMs);
  const observations = normalizeHistory(history);
  const anchorTimestamp = resolveAnchorTimestamp(observations, anchorTime);
  const options = { anchorTimestamp, coverageToleranceMs };

  return {
    anchorTime: new Date(anchorTimestamp).toISOString(),
    oneHour: analyzeNormalizedWindow(observations, {
      ...options,
      windowMs: ONE_HOUR_MS,
    }),
    twentyFourHours: analyzeNormalizedWindow(observations, {
      ...options,
      windowMs: TWENTY_FOUR_HOURS_MS,
    }),
  };
}

function getVaultList(value) {
  const vaults = Array.isArray(value) ? value : value?.vaults;

  if (!Array.isArray(vaults)) {
    throw new TypeError("Ranking input must be a vault array or window result.");
  }

  return vaults;
}

function applyLimit(vaults, limit) {
  if (limit === undefined) {
    return vaults;
  }

  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new TypeError("Ranking limit must be a non-negative safe integer.");
  }

  return vaults.slice(0, limit);
}

function absoluteOrNegativeOne(value) {
  return Number.isFinite(value) ? Math.abs(value) : -1;
}

/**
 * Most-active order: changed category count, unique changed intervals, notable
 * TVL intervals, absolute TVL net movement, then chain ID and address.
 */
export function rankMostActiveVaults(value, limit) {
  const ranked = getVaultList(value)
    .filter((vault) => vault.activity.categoriesChanged.length > 0)
    .slice()
    .sort((left, right) =>
      right.activity.categoriesChanged.length - left.activity.categoriesChanged.length
      || right.activity.totalChangedIntervals - left.activity.totalChangedIntervals
      || right.activity.notableTvlIntervals - left.activity.notableTvlIntervals
      || absoluteOrNegativeOne(right.tvl.netChange) - absoluteOrNegativeOne(left.tvl.netChange)
      || compareIdentity(left, right));

  return applyLimit(ranked, limit);
}

function rankByNetChange(value, metric, limit) {
  const ranked = getVaultList(value)
    .filter((vault) => Number.isFinite(vault[metric].netChange) && vault[metric].netChange !== 0)
    .slice()
    .sort((left, right) =>
      Math.abs(right[metric].netChange) - Math.abs(left[metric].netChange)
      || right[metric].netChange - left[metric].netChange
      || compareIdentity(left, right));

  return applyLimit(ranked, limit);
}

/** Absolute net movement first; positive movement wins equal-magnitude ties. */
export function rankLargestTvlMovers(value, limit) {
  return rankByNetChange(value, "tvl", limit);
}

/** Absolute net percentage-point movement first; positive wins equal ties. */
export function rankLargestApyMovers(value, limit) {
  return rankByNetChange(value, "apy", limit);
}

/** Absolute net depositor movement first; positive wins equal ties. */
export function rankLargestDepositorMovers(value, limit) {
  return rankByNetChange(value, "depositors", limit);
}
