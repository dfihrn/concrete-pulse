export function latestActivityState(apyChanges = [], depositorChanges = []) {
    const apyHasActivity = apyChanges.length > 0;
    const depositorsHaveActivity = depositorChanges.length > 0;
    const activeCategories = Number(apyHasActivity) + Number(depositorsHaveActivity);

    return {
        layout: activeCategories === 2 ? "both-active" : activeCategories === 1 ? "mixed" : "quiet",
        apy: apyHasActivity ? "active" : "quiet",
        depositors: depositorsHaveActivity ? "active" : "quiet",
    };
}
