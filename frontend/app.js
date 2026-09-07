let recordsData = [];
let chainData = [];
let pendingTransactions = [];
let integrityEvents = [];
let filter = "all";
let hashQuery = "";
let lastAlertBlockIndex = null;
let accuracyChart;
let riskChart;
const expandedBlocks = new Set();
const openJsonBlocks = new Set();
let selectedBlockIndex = null;
const seenEventIds = new Set();

const API_BASE = "http://127.0.0.1:5000";

function getStatusClass(status) {
    switch (status) {
        case "VALID": return "valid";
        case "MISSING": return "missing";
        case "TAMPERED": return "tampered";
        case "AT_RISK": return "risk";
        default: return "missing";
    }
}

function shortHash(hash) {
    if (!hash) return "-";
    return hash.length <= 20 ? hash : `${hash.slice(0, 10)}...${hash.slice(-8)}`;
}

function fullHash(hash) {
    return hash || "-";
}

function getBlockUser(block) {
    const tx = (block.transactions || []).find((t) => t.user && String(t.user).trim() !== "");
    return tx ? tx.user : "-";
}

function statusFromTx(tx) {
    if (tx.status && String(tx.status).trim() !== "") return String(tx.status).toUpperCase();
    if (tx.type === "ROLLBACK") return "AT_RISK";
    return "VALID";
}

function reasonFromTx(tx) {
    if (tx.reason && String(tx.reason).trim() !== "") return tx.reason;
    if (tx.type === "ROLLBACK") return `Rollback to model version ${tx.target_version}`;
    return "Block transaction verified";
}

function computeChainIntegrity(blocksDesc) {
    return blocksDesc.map((block, idx) => {
        if (idx === blocksDesc.length - 1) {
            return { ...block, link_broken: false, link_mismatch: false };
        }

        const older = blocksDesc[idx + 1];
        const mismatch = block.previous_hash !== older.hash;
        return { ...block, link_broken: mismatch, link_mismatch: mismatch };
    });
}

function getBlockIntegrityStatus(block) {
    const txStatuses = (block.transactions || []).map(statusFromTx);
    if (txStatuses.includes("TAMPERED")) return "TAMPERED";
    if (txStatuses.includes("MISSING")) return "MISSING";
    if (block.link_broken) return "TAMPERED";
    if (txStatuses.includes("AT_RISK")) return "AT_RISK";
    return "VALID";
}

async function fetchData() {
    try {
        const [recordsRes, blocksRes, eventsRes] = await Promise.all([
            fetch(`${API_BASE}/records`),
            fetch(`${API_BASE}/blocks`),
            fetch(`${API_BASE}/events`),
        ]);

        if (!recordsRes.ok) {
            const text = await recordsRes.text();
            throw new Error(`/records failed (${recordsRes.status}): ${text.slice(0, 120)}`);
        }
        if (!blocksRes.ok) {
            const text = await blocksRes.text();
            throw new Error(`/blocks failed (${blocksRes.status}). Restart backend on updated code. Response: ${text.slice(0, 120)}`);
        }
        if (!eventsRes.ok) {
            const text = await eventsRes.text();
            throw new Error(`/events failed (${eventsRes.status}): ${text.slice(0, 120)}`);
        }

        const recordsType = recordsRes.headers.get("content-type") || "";
        const blocksType = blocksRes.headers.get("content-type") || "";
        const eventsType = eventsRes.headers.get("content-type") || "";
        if (!recordsType.includes("application/json")) {
            const text = await recordsRes.text();
            throw new Error(`/records returned non-JSON: ${text.slice(0, 120)}`);
        }
        if (!blocksType.includes("application/json")) {
            const text = await blocksRes.text();
            throw new Error(`/blocks returned non-JSON. Restart backend on updated code. Response: ${text.slice(0, 120)}`);
        }
        if (!eventsType.includes("application/json")) {
            const text = await eventsRes.text();
            throw new Error(`/events returned non-JSON: ${text.slice(0, 120)}`);
        }

        const recordsPayload = await recordsRes.json();
        const blocksPayload = await blocksRes.json();
        const eventsPayload = await eventsRes.json();

        recordsData = Array.isArray(recordsPayload) ? recordsPayload : [];
        const chain = Array.isArray(blocksPayload.chain) ? blocksPayload.chain : [];
        pendingTransactions = Array.isArray(blocksPayload.pending) ? blocksPayload.pending : [];
        integrityEvents = Array.isArray(eventsPayload.events) ? eventsPayload.events : [];

        chainData = computeChainIntegrity([...chain].sort((a, b) => b.index - a.index));
        if (selectedBlockIndex === null && chainData.length) {
            selectedBlockIndex = chainData[0].index;
        }

        renderLatestBlock();
        renderChain();
        renderSelectedBlockDetails();
        renderEvents();
        renderCharts();
        renderTimeline();
        renderCompareOptions();
        updateChainHealth();
        updateSummary();
        highlightCriticalLatest();

        document.getElementById("pendingCount").innerText = `Pending: ${pendingTransactions.length}`;
        document.getElementById("lastUpdated").innerText = "Updated just now";
    } catch (err) {
        showAlertBar(`Failed to fetch data: ${err.message}`, "error");
    }
}

function renderEvents() {
    const list = document.getElementById("eventsList");
    if (!list) return;
    if (!integrityEvents.length) {
        list.innerHTML = "No events yet.";
        return;
    }

    const html = integrityEvents.slice(0, 20).map((ev) => {
        const ts = new Date(ev.timestamp * 1000).toLocaleString();
        const hash = shortHash(ev.model_hash);
        if (!seenEventIds.has(ev.id)) {
            seenEventIds.add(ev.id);
            if (ev.type === "MODEL_DELETED") {
                showAlertBar(`File deletion detected for model ${hash}`, "error");
            }
        }
        return `<div class="event-item"><b>${ev.type}</b> | ${hash} | ${ts}<br><small>${ev.details}</small></div>`;
    }).join("");

    list.innerHTML = html;
}

function getVisibleBlocks() {
    return chainData.filter((block) => {
        const blockStatus = getBlockIntegrityStatus(block);
        const statusOk = filter === "all" || blockStatus === filter;
        const hashOk = !hashQuery || (block.hash || "").toLowerCase().includes(hashQuery);
        return statusOk && hashOk;
    });
}

function renderLatestBlock() {
    const card = document.getElementById("latestBlockCard");
    if (!chainData.length) {
        card.innerHTML = "<h2>Latest Block</h2><p>No blocks found.</p>";
        return;
    }

    const latest = chainData[0];
    const blockStatus = getBlockIntegrityStatus(latest);
    const reason = latest.transactions[0] ? reasonFromTx(latest.transactions[0]) : "Genesis root block";

    card.innerHTML = `
        <h2>Latest Block (#${latest.index})</h2>
        <p>Status: <span class="status-badge ${getStatusClass(blockStatus)}">${blockStatus}</span></p>
        <p>Nonce: ${latest.nonce}</p>
        <p>Issue: ${reason}</p>
    `;
}

function renderChain() {
    const chainView = document.getElementById("chainView");
    chainView.innerHTML = "";

    const blocks = getVisibleBlocks();

    blocks.forEach((block, idx) => {
        const blockStatus = getBlockIntegrityStatus(block);

        const node = document.createElement("article");
        node.className = `block ${block.link_broken ? "broken" : "linked"} ${block.index === 0 ? "genesis" : ""}`;
        node.id = `block-${block.index}`;
        if (selectedBlockIndex === block.index) node.classList.add("selected");
        if (expandedBlocks.has(block.index)) node.classList.add("expanded");

        const isLast = idx === blocks.length - 1;

        const txList = block.transactions.length
            ? block.transactions.map((tx) => `<li>${tx.type} | model ${shortHash(tx.model_hash)} | dataset ${shortHash(tx.dataset_hash)}</li>`).join("")
            : "<li>No transactions</li>";

        const txDetails = block.transactions.length
            ? block.transactions.map((tx, i) => `
                <div class="tx-inline">
                    <div><b>Tx ${i + 1}:</b> ${tx.type || "-"}</div>
                    <div><b>Dataset:</b> <span class="mono-short">${shortHash(tx.dataset_hash)}</span></div>
                    <div><b>Model:</b> <span class="mono-short">${shortHash(tx.model_hash)}</span></div>
                    <div><b>Accuracy:</b> ${tx.accuracy || "-"}</div>
                    <div><b>Status:</b> ${statusFromTx(tx)}</div>
                    <div><b>Reason:</b> ${reasonFromTx(tx)}</div>
                </div>
            `).join("")
            : "<div class=\"tx-inline\">No transactions</div>";

        node.innerHTML = `
            <div class="block-top">
                <div class="block-title" onclick="selectBlock(${block.index})">Block #${block.index}${block.index === 0 ? " (Genesis)" : ""}</div>
                <button class="block-toggle" onclick="toggleBlock(event, ${block.index})">${expandedBlocks.has(block.index) ? "Close" : "Open"}</button>
            </div>
            <div class="block-header" onclick="selectBlock(${block.index})">
                <p><b>Nonce:</b> ${block.nonce}</p>
                <p><b>Prev Hash:</b> ${shortHash(block.previous_hash)}</p>
                <p><b>Hash:</b> ${shortHash(block.hash)}</p>
                <p><b>User:</b> ${shortHash(getBlockUser(block))}</p>
            </div>

            <div class="block-body" onclick="selectBlock(${block.index})">
                <p><b>Merkle Root:</b> ${shortHash(block.merkle_root)}</p>
                <p><b>Timestamp:</b> ${new Date(block.timestamp * 1000).toLocaleString()}</p>
                <p><b>Status:</b> <span class="status-badge ${getStatusClass(blockStatus)}">${blockStatus}</span></p>
                <p><b>Link Validation:</b> ${block.link_broken ? "BROKEN" : "VERIFIED"}${block.link_mismatch ? " (prev-hash mismatch)" : ""}</p>

                <div class="section">
                    <h4>Dataset</h4>
                    <p>Transaction dataset hashes (short):</p>
                    <ul>${block.transactions.map((tx) => `<li>${shortHash(tx.dataset_hash)}</li>`).join("") || "<li>-</li>"}</ul>
                </div>

                <div class="section">
                    <h4>Model</h4>
                    <p>Transaction model hashes (short):</p>
                    <ul>${block.transactions.map((tx) => `<li>${shortHash(tx.model_hash)} | acc ${tx.accuracy || "-"}</li>`).join("") || "<li>-</li>"}</ul>
                </div>

                <div class="section">
                    <h4>Transactions</h4>
                    <ul>${txList}</ul>
                    ${txDetails}
                </div>

                <div class="actions">
                    <button class="action-toggle" onclick="toggleActionMenu(event, ${block.index})">...</button>
                    <div id="menu-${block.index}" class="menu hidden" onclick="event.stopPropagation()">
                        <button onclick="verifyLatestRecordInBlock(${block.index})">Verify</button>
                        <button onclick="minePending()">Mine Pending</button>
                        <button onclick="compareWithLatestBlock(${block.index})">Compare</button>
                        <button onclick="copyHash('${block.hash}')">Copy Hash</button>
                        <button onclick="toggleBlockJson(${block.index})">JSON View</button>
                    </div>
                </div>

                <pre id="json-${block.index}" class="json-view hidden"></pre>
            </div>

            ${isLast ? "" : `<div class="connector ${block.link_broken ? "broken" : "ok"}"></div>`}
        `;

        chainView.appendChild(node);

        if (openJsonBlocks.has(block.index)) {
            const jsonEl = document.getElementById(`json-${block.index}`);
            if (jsonEl) {
                jsonEl.innerText = JSON.stringify(block, null, 2);
                jsonEl.classList.remove("hidden");
            }
        }
    });
}

function selectBlock(index) {
    selectedBlockIndex = index;
    expandedBlocks.add(index);
    renderChain();
    renderSelectedBlockDetails();
}

function toggleBlock(event, index) {
    event.stopPropagation();
    if (expandedBlocks.has(index)) {
        expandedBlocks.delete(index);
    } else {
        expandedBlocks.add(index);
        selectedBlockIndex = index;
        renderSelectedBlockDetails();
    }
    renderChain();
}

function expandBlock(index) {
    const el = document.getElementById(`block-${index}`);
    if (!el) return;
    el.classList.toggle("expanded");
    if (el.classList.contains("expanded")) expandedBlocks.add(index);
    else expandedBlocks.delete(index);
}

function toggleActionMenu(event, index) {
    event.stopPropagation();
    document.querySelectorAll(".menu").forEach((m) => {
        if (m.id !== `menu-${index}`) m.classList.add("hidden");
    });

    const menu = document.getElementById(`menu-${index}`);
    if (menu) menu.classList.toggle("hidden");
}

function toggleBlockJson(index) {
    const block = chainData.find((b) => b.index === index);
    if (!block) return;

    const el = document.getElementById(`json-${index}`);
    if (!el) return;

    el.innerText = JSON.stringify(block, null, 2);
    el.classList.toggle("hidden");
    if (el.classList.contains("hidden")) openJsonBlocks.delete(index);
    else openJsonBlocks.add(index);
}

function updateChainHealth() {
    const total = chainData.length;
    const broken = chainData.filter((b) => b.link_broken).length;
    const verified = chainData.filter((b) => !b.link_broken).length;
    const health = total === 0 ? 0 : Math.max(0, Math.round(((total - broken) / total) * 100));

    document.getElementById("chainHealthText").innerText = `${health}%`;
    document.getElementById("verifiedBlocks").innerText = verified;
    document.getElementById("brokenLinks").innerText = broken;
    document.getElementById("totalBlocks").innerText = total;
    document.getElementById("chainHealthBar").style.width = `${health}%`;
}

function renderSelectedBlockDetails() {
    const container = document.getElementById("blockDetails");
    if (!container) return;

    const block = chainData.find((b) => b.index === selectedBlockIndex);
    if (!block) {
        container.innerHTML = "Select a block to inspect full header and body.";
        return;
    }

    const blockStatus = getBlockIntegrityStatus(block);
    const txList = (block.transactions || []).map((tx, i) => `
        <div class="detail-tx">
            <div class="tx-title">Transaction ${i + 1}</div>
            <div><b>Type:</b> ${tx.type || "-"}</div>
            <div><b>Dataset Hash:</b> <span class="mono">${fullHash(tx.dataset_hash)}</span></div>
            <div><b>Model Hash:</b> <span class="mono">${fullHash(tx.model_hash)}</span></div>
            <div><b>Accuracy:</b> ${tx.accuracy || "-"}</div>
            <div><b>User:</b> <span class="mono">${tx.user || "-"}</span></div>
        </div>
    `).join("");

    container.innerHTML = `
        <div class="detail-section">
            <h4>Block Header</h4>
            <div><b>Block Index:</b> ${block.index}</div>
            <div><b>Block Hash:</b> <span class="mono">${fullHash(block.hash)}</span> <button onclick="copyHash('${block.hash}')">Copy</button></div>
            <div><b>Previous Hash:</b> <span class="mono">${fullHash(block.previous_hash)}</span> <button onclick="copyHash('${block.previous_hash}')">Copy</button></div>
            <div><b>Timestamp:</b> ${new Date(block.timestamp * 1000).toLocaleString()}</div>
            <div><b>Nonce:</b> ${block.nonce}</div>
            <div><b>User:</b> <span class="mono">${getBlockUser(block)}</span></div>
            <div><b>Merkle Root:</b> <span class="mono">${fullHash(block.merkle_root)}</span> <button onclick="copyHash('${block.merkle_root}')">Copy</button></div>
            <div><b>Integrity:</b> <span class="status-badge ${getStatusClass(blockStatus)}">${blockStatus}</span></div>
        </div>
        <div class="detail-section">
            <h4>Block Body</h4>
            <div><b>Transaction Count:</b> ${(block.transactions || []).length}</div>
            ${txList || "<div>No transactions</div>"}
        </div>
    `;
}

function renderCharts() {
    const chainTx = [...chainData]
        .flatMap((b) => b.transactions || [])
        .filter((tx) => tx.type === "MODEL_STORE");
    const orderedTx = chainTx.sort((a, b) => (a.version || 0) - (b.version || 0));
    const accuracyPoints = orderedTx
        .map((tx, i) => ({
            label: `V${tx.version || i + 1}`,
            value: Number(tx.accuracy),
        }))
        .filter((p) => Number.isFinite(p.value));
    const versions = accuracyPoints.map((p) => p.label);
    const accuracy = accuracyPoints.map((p) => p.value);

    if (accuracyChart) accuracyChart.destroy();
    accuracyChart = new Chart(document.getElementById("accuracyChart"), {
        type: "line",
        data: {
            labels: versions,
            datasets: [{
                label: "Accuracy",
                data: accuracy,
                tension: 0.3,
                borderColor: "#38bdf8",
                backgroundColor: "rgba(56, 189, 248, 0.15)",
                fill: true,
                pointRadius: 2,
                pointHoverRadius: 4,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    labels: { color: "#a5b4c3" },
                },
            },
            scales: {
                x: { ticks: { color: "#7f8ea3" }, grid: { color: "rgba(30,41,59,0.35)" } },
                y: { ticks: { color: "#7f8ea3" }, grid: { color: "rgba(30,41,59,0.35)" } },
            },
        },
    });

    const counts = {
        VALID: chainData.filter((b) => getBlockIntegrityStatus(b) === "VALID").length,
        MISSING: chainData.filter((b) => getBlockIntegrityStatus(b) === "MISSING").length,
        TAMPERED: chainData.filter((b) => getBlockIntegrityStatus(b) === "TAMPERED").length,
        AT_RISK: chainData.filter((b) => getBlockIntegrityStatus(b) === "AT_RISK").length,
    };

    if (riskChart) riskChart.destroy();
    riskChart = new Chart(document.getElementById("riskChart"), {
        type: "pie",
        data: {
            labels: Object.keys(counts),
            datasets: [{
                data: Object.values(counts),
                backgroundColor: ["#16a34a", "#ef4444", "#dc2626", "#f59e0b"],
                borderColor: "rgba(11, 18, 40, 0.95)",
                borderWidth: 2,
                radius: "66%",
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            layout: { padding: { top: 4, bottom: 8 } },
            plugins: {
                legend: {
                    position: "top",
                    labels: { color: "#a5b4c3", boxWidth: 14 },
                },
            },
        },
    });
}

function renderTimeline() {
    const timeline = document.getElementById("timeline");
    timeline.innerHTML = "";

    [...chainData].sort((a, b) => a.index - b.index).forEach((block) => {
        const item = document.createElement("div");
        item.className = "timeline-item";

        let narrative = "Mined block with validated transactions";
        if (block.index === 0) narrative = "Genesis block created";
        if (block.link_broken) narrative = "Chain broken due to previous-hash mismatch";

        item.innerText = `Block #${block.index} -> ${narrative}`;
        timeline.appendChild(item);
    });
}

function renderCompareOptions() {
    const s1 = document.getElementById("compareV1");
    const s2 = document.getElementById("compareV2");

    const opts = [...chainData]
        .sort((a, b) => a.index - b.index)
        .map((b) => `<option value="${b.index}">Block #${b.index}</option>`)
        .join("");

    s1.innerHTML = opts;
    s2.innerHTML = opts;

    if (chainData.length >= 2) {
        s1.value = String(chainData[chainData.length - 1].index);
        s2.value = String(chainData[0].index);
    }
}

function compareBlocks(i1, i2) {
    const b1 = chainData.find((b) => b.index === i1);
    const b2 = chainData.find((b) => b.index === i2);
    if (!b1 || !b2) return showAlertBar("Invalid block selection", "error");

    alert(
        `Transactions Delta: ${b2.transactions.length - b1.transactions.length}\n` +
        `Nonce Delta: ${b2.nonce - b1.nonce}\n` +
        `Prev Hash Match: ${b2.previous_hash === b1.hash}`
    );
}

function compareFromSelects() {
    compareBlocks(Number(document.getElementById("compareV1").value), Number(document.getElementById("compareV2").value));
}

function compareWithLatestBlock(index) {
    if (!chainData.length) return;
    compareBlocks(index, chainData[0].index);
}

function setFilter(nextFilter, buttonEl) {
    filter = nextFilter;
    document.querySelectorAll(".filters button").forEach((btn) => btn.classList.remove("active"));
    buttonEl.classList.add("active");
    renderChain();
}

function searchByHash() {
    hashQuery = document.getElementById("hashSearch").value.trim().toLowerCase();
    renderChain();
}

function clearHashSearch() {
    hashQuery = "";
    document.getElementById("hashSearch").value = "";
    renderChain();
}

function updateSummary() {
    const total = chainData.length;
    const mined = chainData.filter((b) => b.index > 0).length;
    const pending = pendingTransactions.length;
    const broken = chainData.filter((b) => b.link_broken).length;
    const onChainRecords = recordsData.length;
    const chainTransactions = chainData.flatMap((b) => b.transactions || []).filter((tx) => tx.type === "MODEL_STORE").length;

    document.getElementById("summary").innerText =
        `Total Blocks: ${total} | Mined Blocks: ${mined} | Chain Transactions: ${chainTransactions} | Ganache Records: ${onChainRecords} | Pending Transactions: ${pending} | Broken Links: ${broken}`;
}

function showAlertBar(message, type = "info", showAction = false, blockIndex = null) {
    const bar = document.getElementById("alertBar");
    const msg = document.getElementById("alertMessage");
    const action = document.getElementById("alertAction");

    bar.classList.remove("hidden", "error", "info", "success");
    bar.classList.add(type);
    msg.innerText = message;

    if (showAction && blockIndex !== null) {
        action.classList.remove("hidden");
        lastAlertBlockIndex = blockIndex;
    } else {
        action.classList.add("hidden");
        lastAlertBlockIndex = null;
    }
}

function focusLatestAlertBlock() {
    if (lastAlertBlockIndex === null) return;
    const el = document.getElementById(`block-${lastAlertBlockIndex}`);
    if (!el) return;
    el.classList.add("expanded");
    el.scrollIntoView({ behavior: "smooth", block: "center" });
}

function notify(message, type = "info") {
    if (type === "error") {
        showAlertBar(message, "error");
        return;
    }

    const box = document.createElement("div");
    box.className = `notif ${type}`;
    box.innerText = message;
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 3000);
}

function copyHash(hash) {
    navigator.clipboard.writeText(hash);
    notify("Hash copied", "success");
}

function highlightCriticalLatest() {
    if (!chainData.length) return showAlertBar("No chain data available", "info");

    const latest = chainData[0];
    if (latest.link_broken) {
        showAlertBar(`Chain integrity issue: Block #${latest.index} has invalid link`, "error", true, latest.index);
    } else {
        showAlertBar(`Chain healthy. Latest block #${latest.index} verified.`, "success");
    }
}

async function minePending() {
    const res = await fetch(`${API_BASE}/mine`, { method: "POST" });
    const payload = await res.json();
    if (!res.ok) return notify(payload.error || "Mining failed", "error");

    if (payload.status === "idle") {
        notify(payload.message, "info");
    } else {
        notify(`Block #${payload.block.index} mined`, "success");
    }
    fetchData();
}

async function verifyLatestRecordInBlock(blockIndex) {
    const block = chainData.find((b) => b.index === blockIndex);
    if (!block || block.transactions.length === 0) {
        return notify("No verifiable records in this block", "info");
    }

    const tx = block.transactions.find((t) => t.model_hash) || block.transactions[0];
    const rec = recordsData.find((r) => r.blockchain_hash === tx.model_hash);
    if (!rec) return notify("No matching record found for verification", "info");

    const res = await fetch(`${API_BASE}/verify/${rec.version}`);
    const payload = await res.json();
    if (!res.ok) return notify(payload.error || "Verify failed", "error");

    notify(`Verified version ${rec.version}: ${payload.record_status}`, "success");
    fetchData();
}

setInterval(fetchData, 4000);
fetchData();
