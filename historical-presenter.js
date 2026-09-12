import {
  analyzeHistory,
  rankLargestApyMovers,
  rankLargestDepositorMovers,
  rankLargestTvlMovers,
  rankMostActiveVaults,
} from "./history-analytics.js";

export const HISTORICAL_RANKING_LIMIT = 5;

function identity(vault) {
  return {
    chainId: vault.chainId,
    address: vault.address,
    name: vault.name,
  };
}

function presentMostActive(vault) {
  return {
    ...identity(vault),
    categoriesChanged: vault.activity.categoriesChanged,
    totalChangedIntervals: vault.activity.totalChangedIntervals,
    notableTvlIntervals: vault.activity.notableTvlIntervals,
  };
}

function presentTvlMover(vault) {
  return {
    ...identity(vault),
    startValue: vault.tvl.startValue,
    endValue: vault.tvl.endValue,
    netChange: vault.tvl.netChange,
    percentageChange: vault.tvl.percentageChange,
    notableIntervals: vault.tvl.notableIntervals,
  };
}

function presentApyMover(vault) {
  return {
    ...identity(vault),
    startValue: vault.apy.startValue,
    endValue: vault.apy.endValue,
    netChange: vault.apy.netChange,
    percentagePointChange: vault.apy.percentagePointChange,
    changeIntervals: vault.apy.changeIntervals,
  };
}

function presentDepositorMover(vault) {
  return {
    ...identity(vault),
    startValue: vault.depositors.startValue,
    endValue: vault.depositors.endValue,
    netChange: vault.depositors.netChange,
    changeIntervals: vault.depositors.changeIntervals,
  };
}

function sum(vaults, read) {
  return vaults.reduce((total, vault) => total + read(vault), 0);
}

function presentWindow(window) {
  const mostActive = rankMostActiveVaults(window);
  const tvlMovers = rankLargestTvlMovers(window);
  const apyMovers = rankLargestApyMovers(window);
  const depositorMovers = rankLargestDepositorMovers(window);

  return {
    startTime: window.startTime,
    endTime: window.endTime,
    observedSpanMs: window.observedSpanMs,
    observationCount: window.observationCount,
    partial: window.partial,
    counts: {
      activeVaults: mostActive.length,
      tvlMovers: tvlMovers.length,
      notableTvlIntervals: sum(window.vaults, (vault) => vault.tvl.notableIntervals),
      apyChangeIntervals: sum(window.vaults, (vault) => vault.apy.changeIntervals),
      depositorChangeIntervals: sum(
        window.vaults,
        (vault) => vault.depositors.changeIntervals,
      ),
      presenceChangeIntervals: sum(
        window.vaults,
        (vault) => vault.activity.presenceChangeIntervals,
      ),
    },
    mostActive: mostActive
      .slice(0, HISTORICAL_RANKING_LIMIT)
      .map(presentMostActive),
    tvlMovers: tvlMovers
      .slice(0, HISTORICAL_RANKING_LIMIT)
      .map(presentTvlMover),
    apyMovers: apyMovers
      .slice(0, HISTORICAL_RANKING_LIMIT)
      .map(presentApyMover),
    depositorMovers: depositorMovers
      .slice(0, HISTORICAL_RANKING_LIMIT)
      .map(presentDepositorMover),
  };
}

// This is the only history-derived object intended for a public response. It
// deliberately omits raw observations and the complete per-vault analytics set.
export function presentHistoricalAnalytics(history, anchorTime) {
  const analytics = analyzeHistory(history, { anchorTime });

  return {
    anchorTime: analytics.anchorTime,
    windows: {
      "1h": presentWindow(analytics.oneHour),
      "24h": presentWindow(analytics.twentyFourHours),
    },
  };
}

export function presentPulseGeneration(generation) {
  return {
    ...generation.result,
    historical: presentHistoricalAnalytics(
      generation.history ?? [],
      generation.collectedAt,
    ),
  };
}
