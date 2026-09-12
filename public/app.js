const refreshButton = document.querySelector("#refresh");
const statusMessage = document.querySelector("#status");
const errorMessage = document.querySelector("#error");
let hasResults = false;
let latestResults = null;

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

function renderMostActive(data) {
    const container = document.querySelector("#active-list");
    container.replaceChildren();
    const overflow = document.querySelector("#active-overflow");
    overflow.replaceChildren();
    document.querySelector("#more-active").hidden = data.mostActiveVaults.length <= 3;
    if (!data.mostActiveVaults.length) {
        container.append(element("p", "empty", "No vault is currently showing more than one type of change at the same time."));
    }
    for (const [index, vault] of data.mostActiveVaults.entries()) {
        const row = element("article", "active-feature", "");
        const count = element("p", "feature-count", vault.categoryCount);
        count.append(element("span", "", "OBSERVED CATEGORIES"));
        row.append(count, vaultDetails(vault), element("p", "category-count", `Appears here because ${vault.categories.join(", ")} changed in this comparison.`));
        (index < 3 ? container : overflow).append(row);
    }
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
        if (node.closest(".ecosystem-metrics")) node.parentElement.classList.toggle("is-zero", data.summary[node.dataset.summary] === 0);
    }
    renderTime("#current-time", data.timestamp);
    renderTime("#previous-time", data.previousTimestamp);
    renderActivity(data);
    renderMostActive(data);
    document.querySelector("#raw-count").textContent = `(${data.summary.tvlChanges})`;
    renderChanges("#notable-list", data.notableTvlChanges, "tvl", "No notable TVL movement in this snapshot. All detected movements remain available below.");
    renderChanges("#tvl-list", data.tvlChanges, "tvl", "No TVL changes detected in this snapshot.");
    renderChanges("#apy-list", data.apyChanges, "apy", "No APY movement detected in this snapshot.");
    renderChanges("#depositors-list", data.depositorChanges, "depositors", "No depositor activity detected in this snapshot.");
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
refreshPulse();
