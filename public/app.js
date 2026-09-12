import { latestActivityState } from "./latest-activity-state.js";

const refreshButton = document.querySelector("#refresh");
const statusMessage = document.querySelector("#status");
const errorMessage = document.querySelector("#error");
let hasResults = false;
let latestResults = null;
let selectedHistoricalWindow = "1h";

// Use textContent for API values, so vault names are always displayed as text.
function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
}

function signedNumber(value, digits = 2) {
    if (!Number.isFinite(value)) return "Unavailable";
    const sign = value < 0 ? "-" : value > 0 ? "+" : "";
    const magnitude = Math.abs(value);
    if (magnitude > 0 && magnitude < 10 ** -digits) return `${sign}${magnitude.toPrecision(2)}`;
    return sign + magnitude.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function money(value) {
    if (!Number.isFinite(value)) return "Unavailable";
    return value.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function movement(change, type) {
    if (type === "new") return "+1 vault present";
    if (type === "removed") return "-1 vault present";
    if (type === "apy") return `${signedNumber(change.percentagePointChange)} percentage points`;
    const percent = Number.isFinite(change.percentageChange) ? `${signedNumber(change.percentageChange)}%` : "relative change unavailable";
    if (type === "depositors") return `${signedNumber(change.change, 0)} depositors (${percent})`;
    const amount = `${change.change < 0 ? "-" : "+"}${money(Math.abs(change.change))}`;
    return `${amount} (${percent})`;
}

function metricValue(value, type) {
    if (!Number.isFinite(value) || (type === "apy" && value === -1)) return "Unavailable";
    if (type === "tvl") return money(value);
    if (type === "apy") return `${(value * 100).toLocaleString("en-US", { maximumFractionDigits: 4 })}%`;
    return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function vaultDetails(change) {
    const details = document.createElement("div");
    details.append(element("p", "vault-name", change.name));
    const address = String(change.address ?? "");
    const meta = element("div", "vault-meta", `Chain ${change.chainId} · ${address.slice(0, 6)}…${address.slice(-4)}`);
    meta.title = address;
    details.append(meta);
    return details;
}

function renderChanges(id, changes, type, emptyText, limit = changes.length) {
    const container = document.querySelector(id);
    container.replaceChildren();
    if (!changes.length) {
        container.append(element("p", "empty", emptyText));
        return;
    }
    for (const change of changes.slice(0, limit)) {
        const row = element("article", "change-row", "");
        const values = document.createElement("div");
        values.append(element("p", "change-direction", `${type.toUpperCase()} ${change.change > 0 ? "UP" : "DOWN"}`));
        values.append(element("p", "movement", movement(change, type)));
        values.append(element("p", "value-history", `${metricValue(change.previousValue, type)} → ${metricValue(change.currentValue, type)}`));
        row.append(vaultDetails(change), values);
        container.append(row);
    }
}

function renderLatestActivityCategory(panelId, listId, changes, type, emptyText, state) {
    const panel = document.querySelector(panelId);
    panel.classList.toggle("has-activity", state === "active");
    panel.classList.toggle("is-quiet", state === "quiet");
    panel.dataset.state = state;

    if (state === "active") {
        renderChanges(listId, changes, type, emptyText);
        return;
    }

    const container = document.querySelector(listId);
    container.replaceChildren(element("p", "latest-status-message", emptyText));
}

function renderOtherLatestActivity(data) {
    const state = latestActivityState(data.apyChanges, data.depositorChanges);
    document.querySelector("#other-latest-grid").dataset.state = state.layout;
    renderLatestActivityCategory("#apy-panel", "#apy-list", data.apyChanges, "apy", "No APY movement detected in this snapshot.", state.apy);
    renderLatestActivityCategory("#depositors-panel", "#depositors-list", data.depositorChanges, "depositors", "No depositor changes detected in this snapshot.", state.depositors);
}

function renderActivity(data) {
    const container = document.querySelector("#activity");
    container.replaceChildren();
    const overflow = document.querySelector("#activity-overflow");
    overflow.replaceChildren();
    // Round-robin through sorted categories: different units cannot be ranked
    // against dollars. This keeps the biggest change of each kind visible.
    const groups = [
        ["tvl", document.querySelector("#show-all").checked ? data.tvlChanges : data.notableTvlChanges], ["apy", data.apyChanges],
        ["depositors", data.depositorChanges], ["new", data.newVaults], ["removed", data.removedVaults]
    ];
    const items = [];
    const longestCategory = Math.max(...groups.map(([, changes]) => changes.length));
    for (let rank = 0; rank < longestCategory; rank++) {
        for (const [type, changes] of groups) {
            if (changes[rank]) items.push({ type, change: changes[rank] });
        }
    }
    if (!items.length) {
        container.append(element("p", "empty", data.hasPreviousSnapshot
            ? data.summary.totalActivity > 0 ? "Only small TVL changes this time. Include small TVL changes to see them." : "A quiet snapshot. No vault changes detected. Check back for the next pulse."
            : "Your first snapshot is ready. Refresh later to see what changes."));
    }
    document.querySelector("#feed-count").textContent = `${items.length} ${items.length === 1 ? "activity" : "activities"} in this view. Category leaders first; largest movements within each category.`;
    // Feature a bounded selection; keep all remaining activity accessible below.
    document.querySelector("#more-activity").hidden = items.length <= 5;
    for (const [index, { type, change }] of items.entries()) {
        const card = element("article", "activity-card", "");
        const direction = change.change > 0 ? "up" : "down";
        const label = type === "new" ? "NEW VAULT" : type === "removed" ? "REMOVED VAULT" : `${type.toUpperCase()} ${direction.toUpperCase()}`;
        card.append(element("span", `badge ${type === "new" || type === "removed" ? type : direction}`, label));
        card.append(vaultDetails(change), element("p", "movement", movement(change, type)));
        const history = type === "new" ? "Previous: absent → Current: present" : type === "removed"
            ? "Previous: present → Current: absent"
            : `Previous: ${metricValue(change.previousValue, type)} → Current: ${metricValue(change.currentValue, type)}`;
        card.append(element("p", "value-history", history));
        if (type === "apy") card.append(element("p", "value-history", Number.isFinite(change.percentageChange)
            ? `${signedNumber(change.percentageChange)}% relative APY change` : "Relative APY change unavailable"));
        if (type === "new" || type === "removed") card.append(element("p", "value-history", "Presence change only; financial movement unavailable."));
        (index < 5 ? container : overflow).append(card);
    }
}

function durationLabel(milliseconds) {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "0M";
    const totalMinutes = Math.floor(milliseconds / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return hours ? `${hours}H${minutes ? ` ${minutes}M` : ""}` : `${minutes}M`;
}

function comparisonLabel(count) {
    return `${count.toLocaleString("en-US")} changed ${count === 1 ? "comparison" : "comparisons"}`;
}

function renderRankedRows(items, containerId, overflowId, detailsId, renderRow) {
    const container = document.querySelector(containerId);
    const overflow = document.querySelector(overflowId);
    const details = document.querySelector(detailsId);
    container.replaceChildren();
    overflow.replaceChildren();
    details.hidden = items.length <= 3;
    details.open = false;
    items.forEach((item, index) => (index < 3 ? container : overflow).append(renderRow(item, index)));
    return container;
}

function renderHistoricalActive(window) {
    const container = renderRankedRows(
        window.mostActive,
        "#historical-active-list",
        "#historical-active-overflow",
        "#historical-active-more",
        (vault, index) => {
            const row = element("article", "history-row historical-active-row", "");
            const rank = element("p", "history-rank", String(index + 1).padStart(2, "0"));
            const content = document.createElement("div");
            content.append(vaultDetails(vault));
            content.append(element("p", "history-categories", vault.categoriesChanged.join(" · ")));
            const facts = [comparisonLabel(vault.totalChangedIntervals)];
            if (vault.notableTvlIntervals > 0) {
                facts.push(`${vault.notableTvlIntervals} notable TVL ${vault.notableTvlIntervals === 1 ? "movement" : "movements"}`);
            }
            content.append(element("p", "history-facts", facts.join(" · ")));
            row.append(rank, content);
            return row;
        },
    );
    if (!window.mostActive.length) {
        container.append(element("p", "empty", "No vault activity was observed in this window."));
    }
}

function renderHistoricalTvl(window) {
    const container = renderRankedRows(
        window.tvlMovers,
        "#historical-tvl-list",
        "#historical-tvl-overflow",
        "#historical-tvl-more",
        (vault) => {
            const row = element("article", "history-row historical-metric-row", "");
            const values = document.createElement("div");
            const sign = vault.netChange < 0 ? "-" : "+";
            const relative = Number.isFinite(vault.percentageChange)
                ? ` (${signedNumber(vault.percentageChange)}%)`
                : "";
            values.append(element("p", "history-net", `${sign}${money(Math.abs(vault.netChange))}${relative}`));
            values.append(element("p", "value-history", `${metricValue(vault.startValue, "tvl")} → ${metricValue(vault.endValue, "tvl")}`));
            if (vault.notableIntervals > 0) {
                values.append(element("p", "history-facts", `${vault.notableIntervals} notable ${vault.notableIntervals === 1 ? "interval" : "intervals"}`));
            }
            row.append(vaultDetails(vault), values);
            return row;
        },
    );
    if (!window.tvlMovers.length) {
        container.append(element("p", "empty", "No net TVL movement was observed in this window."));
    }
}

function historicalMetricGroup(title, items, type) {
    const group = element("section", "historical-metric-group", "");
    group.append(element("h4", "", title));
    for (const vault of items) {
        const row = element("article", "historical-compact-row", "");
        const values = document.createElement("div");
        if (type === "apy") {
            values.append(element("p", "history-net", `${signedNumber(vault.percentagePointChange)} percentage points`));
        } else {
            values.append(element("p", "history-net", `${signedNumber(vault.netChange, 0)} depositors`));
        }
        values.append(element("p", "value-history", `${metricValue(vault.startValue, type)} → ${metricValue(vault.endValue, type)}`));
        values.append(element("p", "history-facts", comparisonLabel(vault.changeIntervals)));
        row.append(vaultDetails(vault), values);
        group.append(row);
    }
    return group;
}

function renderHistoricalOther(window) {
    const container = document.querySelector("#historical-other-list");
    const quiet = document.querySelector("#historical-quiet");
    container.replaceChildren();
    quiet.replaceChildren();

    if (window.apyMovers.length) {
        container.append(historicalMetricGroup("APY MOVEMENT", window.apyMovers, "apy"));
    }
    if (window.depositorMovers.length) {
        container.append(historicalMetricGroup("DEPOSITOR ACTIVITY", window.depositorMovers, "depositors"));
    }

    const quietMessages = [];
    if (!window.counts.apyChangeIntervals) {
        quietMessages.push("No APY changes were observed in this window.");
    } else if (!window.apyMovers.length) {
        quietMessages.push("APY changed during the window without a net change between its first and last observations.");
    }
    if (!window.counts.depositorChangeIntervals) {
        quietMessages.push("No depositor changes were observed in this window.");
    } else if (!window.depositorMovers.length) {
        quietMessages.push("Depositor counts changed during the window without a net change between its first and last observations.");
    }
    for (const message of quietMessages) quiet.append(element("p", "", message));
    container.hidden = container.childElementCount === 0;
    quiet.hidden = quiet.childElementCount === 0;
}

function renderHistorical(historical) {
    const coverage = document.querySelector("#history-coverage");
    const window = historical?.windows?.[selectedHistoricalWindow];
    for (const button of document.querySelectorAll("[data-history-window]")) {
        button.setAttribute("aria-pressed", String(button.dataset.historyWindow === selectedHistoricalWindow));
    }

    if (!window) {
        coverage.textContent = "Historical activity is not available yet.";
        const emptyWindow = { mostActive: [], tvlMovers: [], apyMovers: [], depositorMovers: [], counts: {} };
        renderHistoricalActive(emptyWindow);
        renderHistoricalTvl(emptyWindow);
        renderHistoricalOther({ ...emptyWindow, counts: { apyChangeIntervals: 0, depositorChangeIntervals: 0 } });
        return;
    }

    const requestedWindow = selectedHistoricalWindow.toUpperCase();
    const observedSpan = durationLabel(window.observedSpanMs);
    const observations = `${window.observationCount.toLocaleString("en-US")} ${window.observationCount === 1 ? "OBSERVATION" : "OBSERVATIONS"}`;
    coverage.replaceChildren();
    if (window.partial) {
        coverage.append(element("strong", "", `PARTIAL WINDOW · ${observedSpan} OF ${requestedWindow} OBSERVED · ${observations}`));
    } else {
        coverage.append(
            element("strong", "", `${requestedWindow} WINDOW COVERED · ${observations}`),
            element("span", "", `${observedSpan} OBSERVED SPAN`),
        );
    }
    renderHistoricalActive(window);
    renderHistoricalTvl(window);
    renderHistoricalOther(window);
}

function renderTime(id, timestamp) {
    const node = document.querySelector(id);
    const date = timestamp ? new Date(timestamp) : null;
    if (!date || !Number.isFinite(date.getTime())) {
        node.textContent = "No previous snapshot";
        node.removeAttribute("datetime");
        return;
    }
    node.dateTime = timestamp;
    node.textContent = date.toLocaleString(undefined, {
        month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short"
    });
}

function renderDashboard(data) {
    for (const node of document.querySelectorAll("[data-summary]")) {
        node.textContent = data.summary[node.dataset.summary].toLocaleString("en-US");
    }
    renderTime("#current-time", data.timestamp);
    renderTime("#previous-time", data.previousTimestamp);
    renderActivity(data);
    renderHistorical(data.historical);
    document.querySelector("#raw-count").textContent = `(${data.summary.tvlChanges})`;
    renderChanges("#notable-list", data.notableTvlChanges, "tvl", "No notable TVL movement in this snapshot. All detected movements remain available below.");
    renderChanges("#tvl-list", data.tvlChanges, "tvl", "No TVL changes detected in this snapshot.");
    renderOtherLatestActivity(data);
    const unavailable = (data.unavailableMetrics ?? []).filter(issue => issue.snapshot === "current" && issue.metric === "apy").length;
    const note = document.querySelector("#data-note");
    note.hidden = unavailable === 0;
    note.textContent = `APY is unavailable for ${unavailable} current vaults. Unavailable values are excluded from APY comparisons.`;
}

async function refreshPulse() {
    if (refreshButton.disabled) return;
    refreshButton.disabled = true;
    document.querySelector("#refresh-label").textContent = "Refreshing…";
    document.querySelector("#dashboard").setAttribute("aria-busy", "true");
    errorMessage.hidden = true;
    statusMessage.textContent = hasResults ? "Refreshing… Showing the last successful snapshot." : "Fetching the latest Concrete data…";
    try {
        const response = await fetch("/api/pulse", { cache: "no-store" });
        if (!response.ok) throw new Error("Pulse request failed");
        const data = await response.json();
        renderDashboard(data);
        latestResults = data;
        hasResults = true;
        statusMessage.textContent = data.freshness?.stale
            ? "Showing the last successful snapshot · data may be stale"
            : `Refresh completed at ${new Date().toLocaleTimeString(undefined, { timeZoneName: "short" })}`;
    } catch {
        statusMessage.textContent = hasResults ? "Refresh failed · showing the last successful snapshot" : "Unable to load snapshot";
        errorMessage.textContent = "We couldn’t load the latest Pulse. Check your connection and try Refresh Pulse again.";
        errorMessage.hidden = false;
        if (!hasResults) {
            for (const node of document.querySelectorAll(".empty")) node.textContent = "Data is unavailable. Try refreshing again.";
        }
    } finally {
        refreshButton.disabled = false;
        document.querySelector("#refresh-label").textContent = "Refresh Pulse";
        document.querySelector("#dashboard").setAttribute("aria-busy", "false");
    }
}

refreshButton.addEventListener("click", refreshPulse);
document.querySelector("#show-all").addEventListener("change", () => {
    if (latestResults) renderActivity(latestResults);
});
for (const button of document.querySelectorAll("[data-history-window]")) {
    button.addEventListener("click", () => {
        selectedHistoricalWindow = button.dataset.historyWindow;
        if (latestResults) renderHistorical(latestResults.historical);
    });
    button.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const buttons = [...document.querySelectorAll("[data-history-window]")];
        const direction = event.key === "ArrowRight" ? 1 : -1;
        const next = buttons[(buttons.indexOf(button) + direction + buttons.length) % buttons.length];
        next.focus();
        next.click();
    });
}
refreshPulse();
