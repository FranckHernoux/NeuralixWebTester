/**
 * Neuralix Web Tester — Module d'analyse multi-fichiers
 *
 * Charge N sessions JSON (exportées depuis le WebTester ou le BatchProcessor),
 * calcule des statistiques agrégées, affiche des hypnogrammes empilés,
 * et fournit des métriques par stade (Précision/Recall/F1, matrice de confusion).
 *
 * Dépend des globales de app.js : STAGE_NAMES, STAGE_COLORS, STATS_FILTERS,
 * getCellColors, drawHypnogramStepLine, formatDuration, formatTime, getStageClass, durHtml
 */

// ============================================================================
// Etat
// ============================================================================

const mfState = {
    files: [],                // [{id, fileName, data, stats}]
    statsFilter: 'all',
    confidenceThreshold: 60,
    selectedFileId: null,     // fichier selectionne pour l'historique
    maxHypnoCount: 5,
    sortBy: 'name',
    sortAsc: true,
};

const NUM_CLASSES = 5;

// ============================================================================
// Persistance IndexedDB (reutilise _idbPut / _idbGet de app.js)
// ============================================================================

const MF_IDB_KEY = 'multifile-data';

function mfSaveToIDB() {
    if (typeof _idbPut !== 'function') return;
    try {
        const payload = {
            files: mfState.files.map(f => ({
                id: f.id,
                fileName: f.fileName,
                folderName: f.folderName || '',
                data: f.data,
            })),
            statsFilter: mfState.statsFilter,
            confidenceThreshold: mfState.confidenceThreshold,
            selectedFileId: mfState.selectedFileId,
            sortBy: mfState.sortBy,
            sortAsc: mfState.sortAsc,
        };
        _idbPut(MF_IDB_KEY, payload).catch(e => console.warn('mfSaveToIDB:', e));
    } catch (e) {
        console.warn('mfSaveToIDB:', e);
    }
}

async function mfRestoreFromIDB() {
    if (typeof _idbGet !== 'function') {
        console.warn('mfRestoreFromIDB: _idbGet not available');
        return false;
    }
    try {
        const payload = await _idbGet(MF_IDB_KEY);
        if (!payload || !payload.files || payload.files.length === 0) {
            return false;
        }

        console.log('mfRestoreFromIDB: restoring', payload.files.length, 'files');

        // Reconstruire les entries avec stats recalculees
        mfState.files = payload.files.map(raw => ({
            id: raw.id || crypto.randomUUID(),
            fileName: raw.fileName,
            folderName: raw.folderName || '',
            data: raw.data,
            stats: mfComputeFileStats(raw.data),
        }));

        if (payload.statsFilter) mfState.statsFilter = payload.statsFilter;
        if (payload.confidenceThreshold != null) mfState.confidenceThreshold = payload.confidenceThreshold;
        if (payload.selectedFileId) mfState.selectedFileId = payload.selectedFileId;
        if (payload.sortBy) mfState.sortBy = payload.sortBy;
        if (payload.sortAsc != null) mfState.sortAsc = payload.sortAsc;

        // MAJ UI des filtres
        var filterSelect = document.getElementById('mfStatsFilterSelect');
        if (filterSelect) filterSelect.value = mfState.statsFilter;
        var slider = document.getElementById('mfConfidenceSlider');
        var input = document.getElementById('mfConfidenceInput');
        if (slider) slider.value = mfState.confidenceThreshold;
        if (input) input.value = mfState.confidenceThreshold;
        var sortSelect = document.getElementById('mfSortSelect');
        if (sortSelect) sortSelect.value = mfState.sortBy;

        // Refresh complet de l'UI (attendre un frame pour que le DOM soit pret)
        requestAnimationFrame(() => {
            mfUpdateFileCount();
            mfUpdateFileListUI();
            mfUpdateSectionsVisibility();
            mfBuildSummaryTable();
            mfUpdateHypnoSelect();
            mfDrawHypnograms();
            mfRefreshAllStats();
            mfBuildDurationTable();
        });

        return true;
    } catch (e) {
        console.warn('mfRestoreFromIDB:', e);
        return false;
    }
}

// ============================================================================
// Chargement de fichiers
// ============================================================================

async function mfLoadFiles(fileList) {
    const files = Array.from(fileList);
    let loaded = 0, failed = 0;
    const BATCH = 10;

    for (let i = 0; i < files.length; i += BATCH) {
        const batch = files.slice(i, i + BATCH);
        const results = await Promise.allSettled(batch.map(f => mfParseSessionFile(f)));

        for (const r of results) {
            if (r.status === 'fulfilled' && r.value) {
                mfState.files.push(r.value);
                loaded++;
            } else {
                failed++;
            }
        }
        // Yield UI
        mfUpdateFileCount();
        await new Promise(r => setTimeout(r, 0));
    }

    mfUpdateFileListUI();
    mfUpdateSectionsVisibility();
    mfBuildSummaryTable();
    mfUpdateHypnoSelect();
    mfDrawHypnograms();
    mfRefreshAllStats();
    mfBuildDurationTable();

    // Replier la section chargement après un chargement réussi
    if (loaded > 0) {
        const loader = document.getElementById('mfLoaderSection');
        if (loader && !loader.classList.contains('section-collapsed')) {
            loader.classList.add('section-collapsed');
        }
        mfSaveToIDB();
    }
}

async function mfParseSessionFile(file) {
    const text = await file.text();
    const data = JSON.parse(text);

    if (!data.neuralix) {
        throw new Error('Fichier invalide');
    }

    // Assurer matchA1 / matchA2
    for (const p of (data.predictions || [])) {
        if (p.matchA1 === undefined)
            p.matchA1 = p.annot1 ? (p.name === p.annot1) : null;
        if (p.matchA2 === undefined)
            p.matchA2 = p.annot2 ? (p.name === p.annot2) : null;
    }

    // Reconstruire annotations si absentes (V3-RT stocke annot1/annot2 dans predictions)
    if (!data.annotations1 && data.predictions?.length > 0) {
        data.annotations1 = data.predictions.map(p => p.annot1 || null);
    }
    if (!data.annotations2 && data.predictions?.length > 0) {
        data.annotations2 = data.predictions.map(p => p.annot2 || null);
    }

    // Extraire le dossier parent depuis webkitRelativePath (disponible si chargé via dossier)
    let folderName = '';
    if (file.webkitRelativePath) {
        const parts = file.webkitRelativePath.split('/');
        if (parts.length > 1) folderName = parts.slice(0, -1).join('/');
    }

    const entry = {
        id: crypto.randomUUID(),
        fileName: data.session?.fileName || file.name,
        folderName: folderName,
        data: data,
        stats: mfComputeFileStats(data),
    };
    return entry;
}

function mfComputeFileStats(data) {
    const preds = data.predictions || [];
    const stats = {
        totalEpochs: data.session?.totalEpochs || preds.length,
        predictions: preds,
        accA1: null,
        accA2: null,
        avgConfidence: 0,
        avgTimeMs: 0,
        kappaA1: null,
        stageCounts: {},
        stagePercents: {},
    };

    for (const name of STAGE_NAMES) {
        stats.stageCounts[name] = 0;
        stats.stagePercents[name] = 0;
    }

    // Précision
    const cmpA1 = preds.filter(p => p.matchA1 !== null);
    stats.accA1 = cmpA1.length > 0
        ? cmpA1.filter(p => p.matchA1).length / cmpA1.length : null;

    const cmpA2 = preds.filter(p => p.matchA2 !== null);
    stats.accA2 = cmpA2.length > 0
        ? cmpA2.filter(p => p.matchA2).length / cmpA2.length : null;

    // Confiance et temps
    if (preds.length > 0) {
        stats.avgConfidence = preds.reduce((s, p) => s + p.confidence, 0) / preds.length;
        stats.avgTimeMs = preds.reduce((s, p) => s + (p.time_ms || 0), 0) / preds.length;
    }

    // Stades
    for (const p of preds) {
        stats.stageCounts[p.name] = (stats.stageCounts[p.name] || 0) + 1;
    }
    for (const name of STAGE_NAMES) {
        stats.stagePercents[name] = preds.length > 0
            ? (stats.stageCounts[name] || 0) / preds.length * 100 : 0;
    }

    // Cohen's Kappa A1
    stats.kappaA1 = computeKappa(preds, 'annot1');

    return stats;
}

// ============================================================================
// Cohen's Kappa
// ============================================================================

function computeKappa(predictions, annotKey) {
    const matchKey = annotKey === 'annot1' ? 'matchA1' : 'matchA2';
    const valid = predictions.filter(p => p[matchKey] !== null);
    if (valid.length === 0) return null;

    const n = valid.length;
    const po = valid.filter(p => p[matchKey]).length / n;

    let pe = 0;
    for (const stage of STAGE_NAMES) {
        const predProp = valid.filter(p => p.name === stage).length / n;
        const annotProp = valid.filter(p => p[annotKey] === stage).length / n;
        pe += predProp * annotProp;
    }

    return pe < 1 ? (po - pe) / (1 - pe) : 1;
}

// ============================================================================
// Accord inter-annotateurs (Kappa agrégé multi-fichiers)
// ============================================================================

function mfKappaInterpretation(k) {
    if (k === null) return '';
    if (k < 0)    return 'Mauvais';
    if (k < 0.21) return 'Faible';
    if (k < 0.41) return 'Passable';
    if (k < 0.61) return 'Modéré';
    if (k < 0.81) return 'Bon';
    return 'Excellent';
}

function mfKappaColor(k) {
    if (k === null) return '#6b7280';
    if (k < 0.21) return '#ef4444';
    if (k < 0.41) return '#f97316';
    if (k < 0.61) return '#fbbf24';
    if (k < 0.81) return '#22c55e';
    return '#3b82f6';
}

function mfUpdateKappaStats() {
    const grid = document.getElementById('mfKappaGrid');
    if (!grid) return;

    const allPreds = mfGetFilteredPredictions();
    if (allPreds.length === 0) {
        grid.innerHTML = '<div style="color:#6b7280;padding:8px;">Aucune donnée disponible.</div>';
        return;
    }

    // Kappa IA vs A1
    const kappaIaA1 = computeKappa(allPreds, 'annot1');
    // Kappa IA vs A2
    const kappaIaA2 = computeKappa(allPreds, 'annot2');

    // Kappa A1 vs A2 (accord entre annotateurs humains)
    const validA1A2 = allPreds.filter(p => p.annot1 && p.annot2);
    let kappaA1A2 = null;
    if (validA1A2.length > 0) {
        const n = validA1A2.length;
        const po = validA1A2.filter(p => p.annot1 === p.annot2).length / n;
        let pe = 0;
        for (const stage of STAGE_NAMES) {
            const a1Prop = validA1A2.filter(p => p.annot1 === stage).length / n;
            const a2Prop = validA1A2.filter(p => p.annot2 === stage).length / n;
            pe += a1Prop * a2Prop;
        }
        kappaA1A2 = pe < 1 ? (po - pe) / (1 - pe) : 1;
    }

    // Per-stage Kappa A1 vs A2 (one-vs-rest)
    const perStageKappa = {};
    if (validA1A2.length > 0) {
        for (const stage of STAGE_NAMES) {
            const n = validA1A2.length;
            const a = validA1A2.map(p => p.annot1 === stage ? 1 : 0);
            const b = validA1A2.map(p => p.annot2 === stage ? 1 : 0);
            const po = a.reduce((s, v, i) => s + (v === b[i] ? 1 : 0), 0) / n;
            const p1 = a.reduce((s, v) => s + v, 0) / n;
            const p2 = b.reduce((s, v) => s + v, 0) / n;
            const pe = p1 * p2 + (1 - p1) * (1 - p2);
            perStageKappa[stage] = pe < 1 ? (po - pe) / (1 - pe) : 1;
        }
    }

    // Accord brut A1 vs A2
    const agreePctA1A2 = validA1A2.length > 0
        ? (validA1A2.filter(p => p.annot1 === p.annot2).length / validA1A2.length * 100).toFixed(1)
        : null;

    // Construire les cartes
    grid.innerHTML = '';
    const cards = [
        { label: 'Kappa A1 vs A2', value: kappaA1A2, sub: agreePctA1A2 !== null ? `Accord brut : ${agreePctA1A2}%` : '' },
        { label: 'Kappa IA vs A1', value: kappaIaA1 },
        { label: 'Kappa IA vs A2', value: kappaIaA2 },
    ];

    for (const c of cards) {
        const card = document.createElement('div');
        card.className = 'stat-card';
        const k = c.value;
        const kStr = k !== null ? k.toFixed(3) : '--';
        const interp = mfKappaInterpretation(k);
        const color = mfKappaColor(k);
        card.innerHTML = `
            <div class="stat-label">${c.label}</div>
            <div class="stat-value" style="color:${color};font-size:22px;">${kStr}</div>
            <div class="stat-duration" style="color:${color}">${interp}</div>
            ${c.sub ? `<div class="stat-duration">${c.sub}</div>` : ''}
        `;
        grid.appendChild(card);
    }

    // Per-stage kappa A1 vs A2
    for (const stage of STAGE_NAMES) {
        const k = perStageKappa[stage];
        const card = document.createElement('div');
        card.className = 'stat-card';
        const kStr = k !== undefined ? k.toFixed(3) : '--';
        const interp = mfKappaInterpretation(k !== undefined ? k : null);
        const color = STAGE_COLORS[stage] || '#9aa0a6';
        card.innerHTML = `
            <div class="stat-label">Kappa ${stage} (A1 vs A2)</div>
            <div class="stat-value" style="color:${color};font-size:22px;">${kStr}</div>
            <div class="stat-duration" style="color:${mfKappaColor(k !== undefined ? k : null)}">${interp}</div>
        `;
        grid.appendChild(card);
    }
}

// ============================================================================
// Gestion fichiers
// ============================================================================

function mfRemoveFile(id) {
    mfState.files = mfState.files.filter(f => f.id !== id);
    if (mfState.selectedFileId === id) mfState.selectedFileId = null;
    mfUpdateFileListUI();
    mfUpdateSectionsVisibility();
    mfBuildSummaryTable();
    mfUpdateHypnoSelect();
    mfDrawHypnograms();
    mfRefreshAllStats();
    mfBuildDurationTable();
    mfSaveToIDB();
}

function mfClearAllFiles() {
    mfState.files = [];
    mfState.selectedFileId = null;
    mfUpdateFileListUI();
    mfUpdateSectionsVisibility();
    mfSaveToIDB();
}

function mfUpdateFileCount() {
    document.getElementById('mfFileCount').textContent =
        `${mfState.files.length} fichier(s) charge(s)`;
}

function mfGetCommonFolder() {
    if (mfState.files.length === 0) return '';
    const folders = mfState.files.map(f => f.folderName || '');
    // Tous doivent avoir un dossier non-vide et identique
    if (folders.some(f => !f)) return '';
    const first = folders[0];
    if (folders.every(f => f === first)) return first;
    return '';
}

function mfUpdateFolderBanner() {
    const banner = document.getElementById('mfFolderBanner');
    const nameEl = document.getElementById('mfFolderName');
    const folder = mfGetCommonFolder();
    if (folder) {
        nameEl.textContent = folder;
        banner.style.display = '';
    } else {
        banner.style.display = 'none';
    }
}

function mfUpdateFileListUI() {
    mfUpdateFileCount();
    mfUpdateFolderBanner();
    const container = document.getElementById('mfFileList');
    container.innerHTML = '';

    for (const f of mfState.files) {
        const chip = document.createElement('span');
        chip.className = 'mf-file-chip';
        if (f.id === mfState.selectedFileId) chip.classList.add('chip-selected');
        chip.innerHTML = `<span>${f.fileName}</span><span class="chip-remove" data-id="${f.id}">&times;</span>`;
        chip.addEventListener('click', (e) => {
            if (e.target.classList.contains('chip-remove')) {
                mfRemoveFile(e.target.dataset.id);
            } else {
                mfShowHistory(f.id);
            }
        });
        container.appendChild(chip);
    }

    document.getElementById('mfClearFiles').disabled = mfState.files.length === 0;
}

function mfUpdateSectionsVisibility() {
    const has = mfState.files.length > 0;
    // Clearr le style.display inline (les sections ont display:none dans le HTML)
    // La visibilite effective est geree par la sidebar via sidebar-section-hidden
    const ids = ['mfSummarySection', 'mfHypnoSection',
                 'mfStatsSection', 'mfKappaSection', 'mfMetricsSection',
                 'mfDurationSection', 'mfExportSection',
                 'mfCalibrationSection', 'mfBlandAltmanSection', 'mfIccSection',
                 'mfHeatmapSection', 'mfSunburstSection', 'mfErrorTimelineSection',
                 'mfDashboardSection', 'mfConfusionHeatmapSection', 'mfErrorBurstsSection'];
    for (const id of ids) {
        const el = document.getElementById(id);
        if (el) el.style.display = has ? '' : 'none';
    }
    // L'historique et stats fichier ne sont affiches que quand un fichier est selectionne via "Voir"
    if (!has) {
        document.getElementById('mfHistorySection').style.display = 'none';
        document.getElementById('mfFileStatsSection').style.display = 'none';
        mfState.selectedFileId = null;
    }
    // Notifier la sidebar de l'etat des donnees multi-fichiers
    if (typeof window.sidebarNotifyMfData === 'function') {
        window.sidebarNotifyMfData(has);
    }
}

// ============================================================================
// Resume par fichier
// ============================================================================

function mfAccClass(acc) {
    if (acc === null) return '';
    if (acc >= 0.8) return 'acc-high';
    if (acc >= 0.6) return 'acc-mid';
    return 'acc-low';
}

function mfBuildSummaryTable() {
    const sorted = [...mfState.files].sort((a, b) => {
        let va, vb;
        switch (mfState.sortBy) {
            case 'epochs': va = a.stats.totalEpochs; vb = b.stats.totalEpochs; break;
            case 'accA1':  va = a.stats.accA1 ?? -1; vb = b.stats.accA1 ?? -1; break;
            case 'accA2':  va = a.stats.accA2 ?? -1; vb = b.stats.accA2 ?? -1; break;
            case 'avgConf': va = a.stats.avgConfidence; vb = b.stats.avgConfidence; break;
            case 'kappaA1': va = a.stats.kappaA1 ?? -1; vb = b.stats.kappaA1 ?? -1; break;
            default: va = a.fileName.toLowerCase(); vb = b.fileName.toLowerCase();
        }
        const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
        return mfState.sortAsc ? cmp : -cmp;
    });

    const tbody = document.getElementById('mfSummaryBody');
    const frag = document.createDocumentFragment();

    for (const f of sorted) {
        const s = f.stats;
        const row = document.createElement('tr');
        const accA1 = s.accA1 !== null ? `${(s.accA1 * 100).toFixed(1)}%` : '--';
        const accA2 = s.accA2 !== null ? `${(s.accA2 * 100).toFixed(1)}%` : '--';
        const kappa = s.kappaA1 !== null ? s.kappaA1.toFixed(3) : '--';
        const avgConf = `${(s.avgConfidence * 100).toFixed(1)}%`;
        const avgTime = `${Math.round(s.avgTimeMs)}`;

        row.innerHTML = `
            <td title="${f.fileName}" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${f.fileName}</td>
            <td>${s.totalEpochs}</td>
            <td class="${mfAccClass(s.accA1)}">${accA1}</td>
            <td class="${mfAccClass(s.accA2)}">${accA2}</td>
            <td>${avgConf}</td>
            <td>${kappa}</td>
            <td>${avgTime}</td>
            <td><button class="btn btn-small" data-id="${f.id}">Voir</button></td>
        `;
        row.querySelector('button').addEventListener('click', () => mfShowHistory(f.id));
        frag.appendChild(row);
    }

    tbody.innerHTML = '';
    tbody.appendChild(frag);
}

// ============================================================================
// Hypnogrammes empiles
// ============================================================================

function mfUpdateHypnoSelect() {
    const select = document.getElementById('mfHypnoSelect');
    const search = document.getElementById('mfHypnoSearch').value.toLowerCase();
    select.innerHTML = '';

    for (const f of mfState.files) {
        if (search && !f.fileName.toLowerCase().includes(search)) continue;
        const opt = document.createElement('option');
        opt.value = f.id;
        opt.textContent = f.fileName;
        opt.selected = true;
        select.appendChild(opt);
    }
}

function mfGetSelectedHypnoFiles() {
    const select = document.getElementById('mfHypnoSelect');
    const selectedIds = Array.from(select.selectedOptions).map(o => o.value);
    const max = parseInt(document.getElementById('mfHypnoCount').value) || 5;

    // Si rien n'est selectionne, prendre les premiers fichiers
    let ids = selectedIds.length > 0 ? selectedIds : mfState.files.map(f => f.id);
    ids = ids.slice(0, max);

    return mfState.files.filter(f => ids.includes(f.id));
}

function mfDrawHypnograms() {
    const container = document.getElementById('mfHypnoContainer');
    container.innerHTML = '';

    const files = mfGetSelectedHypnoFiles();
    for (const f of files) {
        mfDrawSingleHypnogram(container, f);
    }
}

function mfDrawSingleHypnogram(container, fileEntry) {
    const wrapper = document.createElement('div');
    wrapper.className = 'mf-hypno-item';
    if (fileEntry.id === mfState.selectedFileId) wrapper.classList.add('mf-hypno-selected');

    // Label
    const label = document.createElement('div');
    label.className = 'mf-hypno-label';
    const s = fileEntry.stats;
    const accStr = s.accA1 !== null ? `A1: ${(s.accA1 * 100).toFixed(1)}%` : '';
    label.innerHTML = `<span>${fileEntry.fileName}</span>
                       <span class="mf-hypno-acc">${accStr} | ${s.totalEpochs} epochs</span>`;
    wrapper.appendChild(label);

    // Canvas — haute resolution pour ecrans HiDPI + compensation zoom CSS
    const canvas = document.createElement('canvas');
    canvas.className = 'mf-hypno-canvas';
    wrapper.appendChild(canvas);
    container.appendChild(wrapper);

    // Mesurer apres insertion dans le DOM pour obtenir la largeur reelle
    const bodyZoom = parseFloat(document.body.style.zoom) || 1;
    const wrapperW = wrapper.clientWidth || wrapper.getBoundingClientRect().width / bodyZoom;
    const cssW = Math.max(wrapperW - 40, 400);
    const cssH = 120;
    const dpr = (window.devicePixelRatio || 1) * bodyZoom;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';

    // Dessin
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const w = cssW, h = cssH;
    const margin = { top: 10, bottom: 20, left: 50, right: 20 };
    const plotW = w - margin.left - margin.right;
    const plotH = h - margin.top - margin.bottom;

    ctx.fillStyle = '#2a2f38';
    ctx.fillRect(0, 0, w, h);

    const preds = fileEntry.data.predictions || [];
    const annot1 = (fileEntry.data.annotations1 || []).map(a => a || null);
    const annot2 = (fileEntry.data.annotations2 || []).map(a => a || null);
    const totalEpochs = Math.max(preds.length, annot1.length, 1);
    const epochW = plotW / totalEpochs;

    const stageOrder = ['Wake', 'REM', 'N1', 'N2', 'N3'];
    const stageY = {};
    stageOrder.forEach((name, i) => {
        stageY[name] = margin.top + (i / (stageOrder.length - 1)) * plotH;
    });

    // Labels Y
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'right';
    for (const [name, y] of Object.entries(stageY)) {
        ctx.fillStyle = STAGE_COLORS[name] || '#9aa0a6';
        ctx.fillText(name, margin.left - 4, y + 3);
    }

    // Grille
    ctx.strokeStyle = '#3a3f4a';
    ctx.lineWidth = 0.5;
    for (const y of Object.values(stageY)) {
        ctx.beginPath();
        ctx.moveTo(margin.left, y);
        ctx.lineTo(w - margin.right, y);
        ctx.stroke();
    }

    // Lignes — reutilise drawHypnogramStepLine de app.js
    const showA2 = document.getElementById('mfHypnoShowA2')?.checked !== false;
    const showA1 = document.getElementById('mfHypnoShowA1')?.checked !== false;
    const showNeuralix = document.getElementById('mfHypnoShowNeuralix')?.checked !== false;
    if (typeof drawHypnogramStepLine === 'function') {
        if (showA2) {
            drawHypnogramStepLine(ctx, annot2, stageY, margin, epochW, 0, totalEpochs,
                                  '#22c55e', 1, [3, 3]);
        }
        if (showA1) {
            drawHypnogramStepLine(ctx, annot1, stageY, margin, epochW, 0, totalEpochs,
                                  '#ef4444', 1, [6, 3]);
        }
        if (showNeuralix) {
            drawHypnogramStepLine(ctx, preds.map(p => p.name), stageY, margin, epochW, 0, totalEpochs,
                                  '#3b82f6', 2, []);
        }
    }

    // Clic → selectionner ce fichier pour l'historique
    wrapper.addEventListener('click', () => mfShowHistory(fileEntry.id));
}

// ============================================================================
// Statistiques d'un fichier selectionne
// ============================================================================

function mfShowFileStats(fileId) {
    const f = mfState.files.find(f => f.id === fileId);
    const section = document.getElementById('mfFileStatsSection');
    if (!f || !section) return;

    // S'assurer que la section est placée juste après "Résumé par fichier"
    const summarySection = document.getElementById('mfSummarySection');
    if (summarySection && section.previousElementSibling !== summarySection) {
        summarySection.parentElement.insertBefore(section, summarySection.nextSibling);
    }

    section.style.display = '';
    section.classList.remove('section-collapsed');

    document.getElementById('mfFileStatsName').textContent = f.fileName;

    const preds = f.data.predictions || [];
    const nPred = preds.length;

    // Stats generales
    document.getElementById('mffsStatEpochs').textContent = nPred;
    document.getElementById('mffsStatEpochsDuration').innerHTML =
        nPred > 0 ? formatDuration(nPred) : '';

    const cmpA1 = preds.filter(p => p.matchA1 !== null);
    const hitA1 = cmpA1.filter(p => p.matchA1).length;
    document.getElementById('mffsStatAccA1').textContent =
        cmpA1.length > 0 ? `${(hitA1 / cmpA1.length * 100).toFixed(1)}%` : '--';

    const cmpA2 = preds.filter(p => p.matchA2 !== null);
    const hitA2 = cmpA2.filter(p => p.matchA2).length;
    document.getElementById('mffsStatAccA2').textContent =
        cmpA2.length > 0 ? `${(hitA2 / cmpA2.length * 100).toFixed(1)}%` : '--';

    if (nPred > 0) {
        const avgTime = (preds.reduce((s, p) => s + (p.time_ms || 0), 0) / nPred).toFixed(0);
        document.getElementById('mffsStatAvgTime').textContent = avgTime;
    } else {
        document.getElementById('mffsStatAvgTime').textContent = '--';
    }

    // Distribution des predictions
    const distGrid = document.getElementById('mffsDistributionGrid');
    distGrid.innerHTML = '';
    if (nPred > 0) {
        const counts = { 'Wake': 0, 'N1': 0, 'N2': 0, 'N3': 0, 'REM': 0 };
        for (const p of preds) counts[p.name] = (counts[p.name] || 0) + 1;
        for (const stage of STAGE_NAMES) {
            const count = counts[stage] || 0;
            const pct = (count / nPred * 100).toFixed(1);
            const card = document.createElement('div');
            card.className = 'stat-card';
            card.innerHTML = `
                <div class="stat-label stage-${getStageClass(stage)}">${stage}</div>
                <div class="stat-value" style="color:${STAGE_COLORS[stage]}">${count}</div>
                <div style="font-size:12px;color:#9aa0a6">${pct}%</div>
                <div class="stat-duration">${durHtml(count, nPred)}</div>
            `;
            distGrid.appendChild(card);
        }
    }

    // Mettre a jour les stats filtrees par confiance
    mfUpdateFileStatsFiltered(preds);
}

function mfUpdateFileStatsFiltered(preds) {
    if (!preds) {
        const f = mfState.files.find(f => f.id === mfState.selectedFileId);
        if (!f) return;
        preds = f.data.predictions || [];
    }

    const threshold = (parseInt(document.getElementById('mffsConfidenceSlider').value) || 60) / 100;
    const filtered = preds.filter(p => p.confidence >= threshold);
    const total = preds.length;

    if (total === 0) {
        document.getElementById('mffsConfidenceSection').style.display = 'none';
        return;
    }
    document.getElementById('mffsConfidenceSection').style.display = '';

    const pctKept = (filtered.length / total * 100).toFixed(0);
    document.getElementById('mffsFilteredEpochs').textContent = `${filtered.length} / ${total}`;
    document.getElementById('mffsFilteredEpochsDuration').innerHTML =
        filtered.length > 0 ? durHtml(filtered.length, total) : '';
    document.getElementById('mffsFilteredCountLabel').textContent =
        `— ${filtered.length} epoch(s) retenues (${pctKept}%)`;

    const cmpA1 = filtered.filter(p => p.matchA1 !== null);
    const hitA1 = cmpA1.filter(p => p.matchA1).length;
    document.getElementById('mffsFilteredAccA1').textContent =
        cmpA1.length > 0 ? `${(hitA1 / cmpA1.length * 100).toFixed(1)}%` : '--';

    const cmpA2 = filtered.filter(p => p.matchA2 !== null);
    const hitA2 = cmpA2.filter(p => p.matchA2).length;
    document.getElementById('mffsFilteredAccA2').textContent =
        cmpA2.length > 0 ? `${(hitA2 / cmpA2.length * 100).toFixed(1)}%` : '--';

    if (filtered.length > 0) {
        const avg = (filtered.reduce((s, p) => s + (p.time_ms || 0), 0) / filtered.length).toFixed(0);
        document.getElementById('mffsFilteredAvgTime').textContent = avg;
    } else {
        document.getElementById('mffsFilteredAvgTime').textContent = '--';
    }

    // Distribution par stade filtree
    const grid = document.getElementById('mffsFilteredDistributionGrid');
    grid.innerHTML = '';
    if (filtered.length === 0) {
        const msg = document.createElement('div');
        msg.style.cssText = 'color:#9aa0a6; padding:8px; font-size:13px;';
        msg.textContent = 'Aucune epoch au-dessus de ce seuil.';
        grid.appendChild(msg);
        return;
    }

    const counts = { 'Wake': 0, 'N1': 0, 'N2': 0, 'N3': 0, 'REM': 0 };
    const stageHitA1 = { 'Wake': 0, 'N1': 0, 'N2': 0, 'N3': 0, 'REM': 0 };
    const stageCmpA1 = { 'Wake': 0, 'N1': 0, 'N2': 0, 'N3': 0, 'REM': 0 };
    const stageHitA2 = { 'Wake': 0, 'N1': 0, 'N2': 0, 'N3': 0, 'REM': 0 };
    const stageCmpA2 = { 'Wake': 0, 'N1': 0, 'N2': 0, 'N3': 0, 'REM': 0 };
    const stageWrongBoth = { 'Wake': 0, 'N1': 0, 'N2': 0, 'N3': 0, 'REM': 0 };

    for (const p of filtered) {
        const s = p.name;
        counts[s] = (counts[s] || 0) + 1;
        if (p.matchA1 !== null) { stageCmpA1[s]++; if (p.matchA1) stageHitA1[s]++; }
        if (p.matchA2 !== null) { stageCmpA2[s]++; if (p.matchA2) stageHitA2[s]++; }
        if (p.matchA1 !== null && p.matchA2 !== null && !p.matchA1 && !p.matchA2) {
            stageWrongBoth[s]++;
        }
    }
    const filtTotal = filtered.length;

    for (const stage of STAGE_NAMES) {
        const count = counts[stage] || 0;
        const pct = (count / filtTotal * 100).toFixed(1);
        const accA1 = stageCmpA1[stage] > 0
            ? (stageHitA1[stage] / stageCmpA1[stage] * 100).toFixed(0) + '%' : '--';
        const accA2 = stageCmpA2[stage] > 0
            ? (stageHitA2[stage] / stageCmpA2[stage] * 100).toFixed(0) + '%' : '--';
        const wrong = stageWrongBoth[stage];
        let errText = '';
        if (count > 0) {
            if (wrong === 0) {
                errText = '<span style="color:#22c55e">100% OK</span>';
            } else {
                const correctVal = (count - wrong) / count * 100;
                const okColor = correctVal >= 90 ? '#22c55e' : correctVal >= 70 ? '#f59e0b' : '#ef4444';
                errText = wrong + ' err <span style="color:#9aa0a6">(</span><span style="color:' + okColor + '">' + correctVal.toFixed(1) + '% ok</span><span style="color:#9aa0a6">)</span>';
            }
        }
        const card = document.createElement('div');
        card.className = 'stat-card';
        card.innerHTML = `
            <div class="stat-label stage-${getStageClass(stage)}">${stage}</div>
            <div class="stat-value" style="color:${STAGE_COLORS[stage]}">${count}</div>
            <div style="font-size:12px;color:#9aa0a6">${pct}%</div>
            <div class="stat-duration">${durHtml(count, filtTotal)}</div>
            <div class="stat-accord">` +
                `<span style="color:#22c55e">A1 ${accA1}</span>` +
                `<span style="color:#9aa0a6"> / </span>` +
                `<span style="color:#3b82f6">A2 ${accA2}</span></div>` +
            `<div class="stat-errors">${errText}</div>
        `;
        grid.appendChild(card);
    }
}

// ============================================================================
// Historique (pour un fichier selectionne)
// ============================================================================

function mfShowHistory(fileId) {
    mfState.selectedFileId = fileId;
    const f = mfState.files.find(f => f.id === fileId);
    if (!f) return;

    document.getElementById('mfHistoryFileName').textContent = f.fileName;
    const tbody = document.getElementById('mfHistoryBody');
    const frag = document.createDocumentFragment();
    const preds = f.data.predictions || [];

    for (let i = preds.length - 1; i >= 0; i--) {
        const p = preds[i];
        const colors = getCellColors(p.name, p.annot1, p.annot2);
        const time = typeof formatTime === 'function'
            ? formatTime(p.epoch * 30) : `${Math.floor(p.epoch * 30 / 60)}:${String(p.epoch * 30 % 60).padStart(2, '0')}`;

        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${p.epoch + 1}</td>
            <td>${time}</td>
            <td class="stage-cell ${colors.esp32}">${p.name}</td>
            <td class="stage-cell ${colors.a1}">${p.annot1 || '--'}</td>
            <td class="stage-cell ${colors.a2}">${p.annot2 || '--'}</td>
            <td>${(p.confidence * 100).toFixed(1)}%</td>
            <td>${p.time_ms || '--'}</td>
        `;
        frag.appendChild(row);
    }

    tbody.innerHTML = '';
    tbody.appendChild(frag);

    // Afficher les statistiques du fichier
    mfShowFileStats(fileId);

    // Afficher la section historique et scroller vers elle
    const histSection = document.getElementById('mfHistorySection');
    if (histSection) {
        histSection.style.display = '';
        histSection.classList.remove('section-collapsed');
    }

    // Mettre à jour la sélection visuelle dans les hypnogrammes
    mfUpdateFileListUI();
    document.querySelectorAll('.mf-hypno-item').forEach(el => {
        el.classList.toggle('mf-hypno-selected', el.querySelector(`[data-file-id="${fileId}"]`) !== null);
    });
}

// ============================================================================
// Statistiques agregees
// ============================================================================

function mfGetFilteredPredictions() {
    const filterFn = STATS_FILTERS[mfState.statsFilter]?.fn || (() => true);
    const all = [];
    for (const f of mfState.files) {
        for (const p of f.stats.predictions) {
            if (filterFn(p)) all.push(p);
        }
    }
    return all;
}

function mfRefreshAllStats() {
    mfUpdateAggregatedStats();
    mfUpdateAggregatedDistribution();
    mfUpdateFilteredStats();
    mfUpdateKappaStats();
    mfBuildMetrics();
    mfBuildConfusionMatrix();
    mfUpdateAdvancedAnalysis();
}

// ============================================================================
// Outils avancés multi-fichier
// ============================================================================

function mfUpdateAdvancedAnalysis() {
    mfUpdateDashboard();
    mfDrawCalibrationCurve();
    mfDrawBlandAltman();
    mfUpdateICC();
    mfDrawHeatmap();
    mfDrawSunburst();
    mfDrawErrorTimeline();
    mfDrawConfusionHeatmap();
    mfAnalyzeErrorBursts();
}

// ---------- Calibration ----------
function mfDrawCalibrationCurve() {
    const canvas = document.getElementById('mfCalibrationCanvas');
    if (!canvas) return;
    const preds = mfGetFilteredPredictions().filter(p => p.matchA1 !== null);
    if (preds.length === 0) {
        const ctx = canvas.getContext('2d');
        const parentW = canvas.parentElement ? canvas.parentElement.getBoundingClientRect().width : 500;
        const emptyW = Math.min(500, Math.max(parentW, 400));
        canvas.width = emptyW; canvas.height = 400;
        ctx.fillStyle = '#2a2f38'; ctx.fillRect(0, 0, emptyW, 400);
        ctx.fillStyle = '#9aa0a6'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('Pas de données annotées', emptyW / 2, 200);
        return;
    }

    const nBins = 10;
    const bins = Array.from({ length: nBins }, () => ({ total: 0, correct: 0, sumConf: 0 }));
    for (const p of preds) {
        const conf = typeof p.confidence === 'number' ? p.confidence : 0;
        const c = conf > 1 ? conf / 100 : conf;
        const idx = Math.min(Math.floor(c * nBins), nBins - 1);
        bins[idx].total++;
        bins[idx].sumConf += c;
        if (p.matchA1) bins[idx].correct++;
    }

    const parentW = canvas.parentElement ? canvas.parentElement.getBoundingClientRect().width : 500;
    const w = Math.min(500, Math.max(parentW, 400)), h = 400;
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#2a2f38'; ctx.fillRect(0, 0, w, h);

    const m = { top: 40, bottom: 50, left: 60, right: 20 };
    const pw = w - m.left - m.right, ph = h - m.top - m.bottom;

    ctx.strokeStyle = '#3a3f4a'; ctx.lineWidth = 1;
    for (let i = 0; i <= 10; i++) {
        const x = m.left + (i / 10) * pw;
        const y = m.top + (1 - i / 10) * ph;
        ctx.beginPath(); ctx.moveTo(x, m.top); ctx.lineTo(x, m.top + ph); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(m.left, y); ctx.lineTo(m.left + pw, y); ctx.stroke();
    }

    ctx.strokeStyle = '#555'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(m.left, m.top + ph); ctx.lineTo(m.left + pw, m.top); ctx.stroke();
    ctx.setLineDash([]);

    const points = [];
    for (let i = 0; i < nBins; i++) {
        const b = bins[i];
        if (b.total === 0) continue;
        const meanConf = b.sumConf / b.total;
        const accuracy = b.correct / b.total;
        const x = m.left + meanConf * pw;
        const y = m.top + (1 - accuracy) * ph;
        points.push({ x, y, meanConf, accuracy, total: b.total });
        const barW = pw / nBins * 0.6;
        const barX = m.left + (i + 0.2) * (pw / nBins);
        const barH = (b.total / preds.length) * ph * 3;
        ctx.fillStyle = 'rgba(59,130,246,0.25)';
        ctx.fillRect(barX, m.top + ph - barH, barW, barH);
    }

    if (points.length > 1) {
        ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
        ctx.stroke();
    }
    for (const p of points) {
        ctx.fillStyle = '#3b82f6';
        ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2); ctx.fill();
    }

    ctx.fillStyle = '#9aa0a6'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
    for (let i = 0; i <= 10; i += 2) {
        ctx.fillText((i * 10) + '%', m.left + (i / 10) * pw, h - m.bottom + 20);
        ctx.textAlign = 'right';
        ctx.fillText((i * 10) + '%', m.left - 8, m.top + (1 - i / 10) * ph + 4);
        ctx.textAlign = 'center';
    }
    ctx.fillStyle = '#9aa0a6'; ctx.font = '13px sans-serif';
    ctx.fillText('Confiance moyenne du modèle', w / 2, h - 8);
    ctx.save(); ctx.translate(14, h / 2); ctx.rotate(-Math.PI / 2);
    ctx.fillText('Précision réelle (vs A1)', 0, 0); ctx.restore();

    ctx.fillStyle = '#e8eaed'; ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('Calibration — ' + preds.length + ' epochs (' + mfState.files.length + ' fichiers)', m.left, m.top - 15);

    let ece = 0;
    for (const b of bins) {
        if (b.total === 0) continue;
        ece += (b.total / preds.length) * Math.abs(b.correct / b.total - b.sumConf / b.total);
    }
    ctx.fillStyle = '#9aa0a6'; ctx.font = '12px sans-serif'; ctx.textAlign = 'right';
    ctx.fillText('ECE = ' + (ece * 100).toFixed(2) + '%', w - m.right, m.top - 15);
}

// ---------- Bland-Altman ----------
function mfDrawBlandAltman() {
    const canvas = document.getElementById('mfBlandAltmanCanvas');
    if (!canvas) return;
    const preds = mfGetFilteredPredictions().filter(p => p.annot1 !== null);
    if (preds.length === 0) {
        const ctx = canvas.getContext('2d');
        const parentW = canvas.parentElement ? canvas.parentElement.getBoundingClientRect().width : 900;
        const emptyW = Math.max(parentW, 600);
        canvas.width = emptyW; canvas.height = 400;
        ctx.fillStyle = '#2a2f38'; ctx.fillRect(0, 0, emptyW, 400);
        ctx.fillStyle = '#9aa0a6'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('Pas de données annotées', emptyW / 2, 200);
        return;
    }

    const stageVal = { 'Wake': 0, 'REM': 1, 'N1': 2, 'N2': 3, 'N3': 4 };
    const diffs = [], avgs = [], stages = [];
    for (const p of preds) {
        const predV = stageVal[p.name], annotV = stageVal[p.annot1];
        if (predV === undefined || annotV === undefined) continue;
        diffs.push(predV - annotV); avgs.push((predV + annotV) / 2); stages.push(p.name);
    }
    if (diffs.length === 0) return;

    const meanDiff = diffs.reduce((s, v) => s + v, 0) / diffs.length;
    const sdDiff = Math.sqrt(diffs.reduce((s, v) => s + (v - meanDiff) ** 2, 0) / diffs.length);
    const upper = meanDiff + 1.96 * sdDiff, lower = meanDiff - 1.96 * sdDiff;

    const parentW = canvas.parentElement ? canvas.parentElement.getBoundingClientRect().width : 900;
    const w = Math.max(parentW, 600), h = 400;
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#2a2f38'; ctx.fillRect(0, 0, w, h);

    const m = { top: 40, bottom: 50, left: 60, right: 20 };
    const pw = w - m.left - m.right, ph = h - m.top - m.bottom;
    const xMin = -0.5, xMax = 4.5;
    const yMin = Math.min(lower, Math.min(...diffs)) - 0.5;
    const yMax = Math.max(upper, Math.max(...diffs)) + 0.5;
    function toX(v) { return m.left + ((v - xMin) / (xMax - xMin)) * pw; }
    function toY(v) { return m.top + ((yMax - v) / (yMax - yMin)) * ph; }

    ctx.strokeStyle = '#3a3f4a'; ctx.lineWidth = 0.5;
    for (let i = -4; i <= 4; i++) {
        const y = toY(i);
        if (y >= m.top && y <= m.top + ph) {
            ctx.beginPath(); ctx.moveTo(m.left, y); ctx.lineTo(m.left + pw, y); ctx.stroke();
        }
    }

    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(m.left, toY(upper)); ctx.lineTo(m.left + pw, toY(upper)); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(m.left, toY(lower)); ctx.lineTo(m.left + pw, toY(lower)); ctx.stroke();
    ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(m.left, toY(meanDiff)); ctx.lineTo(m.left + pw, toY(meanDiff)); ctx.stroke();
    ctx.setLineDash([]);

    for (let i = 0; i < diffs.length; i++) {
        const jx = (Math.random() - 0.5) * 15, jy = (Math.random() - 0.5) * 5;
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = STAGE_COLORS[stages[i]] || '#666';
        ctx.beginPath(); ctx.arc(toX(avgs[i]) + jx, toY(diffs[i]) + jy, 3.5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;

    ctx.fillStyle = '#3b82f6'; ctx.font = '11px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('Biais = ' + meanDiff.toFixed(3), m.left + 4, toY(meanDiff) - 5);
    ctx.fillStyle = '#ef4444';
    ctx.fillText('+1.96 SD = ' + upper.toFixed(2), m.left + 4, toY(upper) - 5);
    ctx.fillText('-1.96 SD = ' + lower.toFixed(2), m.left + 4, toY(lower) + 15);

    ctx.fillStyle = '#e8eaed'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
    const stageLabels = ['Wake', 'REM', 'N1', 'N2', 'N3'];
    for (let i = 0; i < 5; i++) {
        ctx.fillStyle = STAGE_COLORS[stageLabels[i]] || '#e8eaed';
        ctx.fillText(stageLabels[i], toX(i), h - m.bottom + 20);
    }
    ctx.fillStyle = '#e8eaed'; ctx.font = '13px sans-serif';
    ctx.fillText('Moyenne (IA + A1) / 2', w / 2, h - 8);
    ctx.save(); ctx.translate(14, h / 2); ctx.rotate(-Math.PI / 2);
    ctx.fillText('Différence (IA - A1)', 0, 0); ctx.restore();

    ctx.font = '11px sans-serif'; ctx.textAlign = 'left';
    let lx = m.left + 10;
    for (const s of STAGE_NAMES) {
        ctx.fillStyle = STAGE_COLORS[s]; ctx.fillRect(lx, m.top - 12, 10, 10);
        ctx.fillStyle = '#e8eaed'; ctx.fillText(s, lx + 13, m.top - 3);
        lx += 55;
    }

    ctx.fillStyle = '#e8eaed'; ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'right';
    ctx.fillText(preds.length + ' epochs · ' + mfState.files.length + ' fichiers', w - m.right, m.top - 15);
}

// ---------- ICC ----------
function mfUpdateICC() {
    const grid = document.getElementById('mfIccGrid');
    if (!grid) return;
    const preds = mfGetFilteredPredictions();
    const stageVal = { 'Wake': 0, 'REM': 1, 'N1': 2, 'N2': 3, 'N3': 4 };

    function calcICC(raterA, raterB) {
        const n = raterA.length;
        if (n < 3) return null;
        const meanA = raterA.reduce((s, v) => s + v, 0) / n;
        const meanB = raterB.reduce((s, v) => s + v, 0) / n;
        const grandMean = (meanA + meanB) / 2;
        let ssRows = 0, ssRes = 0;
        for (let i = 0; i < n; i++) {
            const rowMean = (raterA[i] + raterB[i]) / 2;
            ssRows += 2 * (rowMean - grandMean) ** 2;
            ssRes += (raterA[i] - rowMean) ** 2 + (raterB[i] - rowMean) ** 2;
        }
        const msRows = ssRows / (n - 1);
        const msRes = ssRes / (n - 1);
        return msRows > 0 ? (msRows - msRes) / (msRows + msRes) : 0;
    }

    function iccInterpretation(v) {
        if (v === null) return { text: '--', color: '#6b7280' };
        if (v < 0.5) return { text: 'Faible', color: '#ef4444' };
        if (v < 0.75) return { text: 'Modéré', color: '#f59e0b' };
        if (v < 0.9) return { text: 'Bon', color: '#22c55e' };
        return { text: 'Excellent', color: '#3b82f6' };
    }

    const validA1 = preds.filter(p => p.annot1 !== null && stageVal[p.name] !== undefined && stageVal[p.annot1] !== undefined);
    const iccIaA1 = validA1.length >= 3 ? calcICC(validA1.map(p => stageVal[p.name]), validA1.map(p => stageVal[p.annot1])) : null;
    const validA2 = preds.filter(p => p.annot2 !== null && stageVal[p.name] !== undefined && stageVal[p.annot2] !== undefined);
    const iccIaA2 = validA2.length >= 3 ? calcICC(validA2.map(p => stageVal[p.name]), validA2.map(p => stageVal[p.annot2])) : null;
    const validA1A2 = preds.filter(p => p.annot1 !== null && p.annot2 !== null && stageVal[p.annot1] !== undefined && stageVal[p.annot2] !== undefined);
    const iccA1A2 = validA1A2.length >= 3 ? calcICC(validA1A2.map(p => stageVal[p.annot1]), validA1A2.map(p => stageVal[p.annot2])) : null;

    const items = [
        { label: 'ICC IA vs A1', value: iccIaA1 },
        { label: 'ICC IA vs A2', value: iccIaA2 },
        { label: 'ICC A1 vs A2', value: iccA1A2 },
    ];

    grid.innerHTML = '';
    for (const item of items) {
        const interp = iccInterpretation(item.value);
        const card = document.createElement('div');
        card.className = 'stat-card';
        card.style.cssText = 'background:#2a2f38;border:1px solid #3a3f4a;';
        card.innerHTML = `
            <div class="stat-label" style="color:#9aa0a6;">${item.label}</div>
            <div class="stat-value" style="color:${interp.color};font-size:28px;">${item.value !== null ? item.value.toFixed(3) : '--'}</div>
            <div style="font-size:12px;color:${interp.color};margin-top:4px;">${interp.text}</div>
        `;
        grid.appendChild(card);
    }
    const legend = document.createElement('div');
    legend.style.cssText = 'margin-top:12px;font-size:11px;color:#9aa0a6;';
    legend.innerHTML = '<b>Interprétation ICC:</b> &lt;0.5 Faible · 0.5-0.75 Modéré · 0.75-0.9 Bon · &gt;0.9 Excellent<br><b>' + preds.length + ' epochs poolés sur ' + mfState.files.length + ' fichiers</b>';
    grid.appendChild(legend);
}

// ---------- Heatmap temporelle (1 ligne par fichier) ----------
function mfDrawHeatmap() {
    const canvas = document.getElementById('mfHeatmapCanvas');
    if (!canvas) return;
    const files = mfState.files;
    if (files.length === 0) {
        const ctx = canvas.getContext('2d');
        canvas.width = 1200; canvas.height = 150;
        ctx.fillStyle = '#2a2f38'; ctx.fillRect(0, 0, 1200, 150);
        ctx.fillStyle = '#9aa0a6'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('Pas de données', 600, 75);
        return;
    }

    const filterFn = STATS_FILTERS[mfState.statsFilter]?.fn || (() => true);
    const rect = canvas.parentElement.getBoundingClientRect();
    const rowH = 20;
    const gap = 2;
    const m = { top: 10, bottom: 35, left: 120, right: 10 };
    const nFiles = files.length;
    const totalH = m.top + nFiles * (rowH * 3 + gap * 2 + 6) + m.bottom;
    const w = Math.max(rect.width || 1200, 600);
    canvas.width = w; canvas.height = totalH;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#2a2f38'; ctx.fillRect(0, 0, w, totalH);

    const pw = w - m.left - m.right;

    let yOff = m.top;
    for (let fi = 0; fi < nFiles; fi++) {
        const preds = files[fi].stats.predictions.filter(filterFn);
        const nE = preds.length;
        if (nE === 0) { yOff += rowH * 3 + gap * 2 + 6; continue; }
        const barW = pw / nE;

        // Label fichier
        ctx.fillStyle = '#9aa0a6'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
        const shortName = files[fi].fileName.length > 16 ? files[fi].fileName.slice(0, 14) + '…' : files[fi].fileName;
        ctx.fillText(shortName, m.left - 5, yOff + rowH * 1.5 + 2);

        for (let i = 0; i < nE; i++) {
            const p = preds[i];
            const x = m.left + i * barW;

            // Stade
            ctx.fillStyle = STAGE_COLORS[p.name] || '#666';
            ctx.fillRect(x, yOff, Math.max(barW - 0.2, 0.5), rowH);

            // Erreur A1
            if (p.matchA1 !== null) {
                ctx.fillStyle = p.matchA1 ? 'rgba(34,197,94,0.7)' : 'rgba(239,68,68,0.8)';
            } else {
                ctx.fillStyle = '#e5e7eb';
            }
            ctx.fillRect(x, yOff + rowH + gap, Math.max(barW - 0.2, 0.5), rowH);

            // Confiance
            const conf = typeof p.confidence === 'number' ? p.confidence : 0;
            const c = conf > 1 ? conf / 100 : conf;
            const green = Math.round(c * 255);
            ctx.fillStyle = `rgb(${255 - green}, ${green}, 80)`;
            ctx.fillRect(x, yOff + (rowH + gap) * 2, Math.max(barW - 0.2, 0.5), rowH);
        }

        yOff += rowH * 3 + gap * 2 + 6;
    }

    // Légende en bas
    ctx.font = '10px sans-serif'; ctx.textAlign = 'left';
    let lx = m.left;
    const legends = [
        { label: 'Stade (couleur)', color: '#3b82f6' },
        { label: 'Correct', color: 'rgba(34,197,94,0.7)' },
        { label: 'Erreur', color: 'rgba(239,68,68,0.8)' },
        { label: 'Confiance haute', color: 'rgb(0,255,80)' },
        { label: 'Confiance basse', color: 'rgb(255,0,80)' },
    ];
    for (const l of legends) {
        ctx.fillStyle = l.color; ctx.fillRect(lx, totalH - 20, 10, 10);
        ctx.fillStyle = '#e8eaed'; ctx.fillText(l.label, lx + 13, totalH - 11);
        lx += ctx.measureText(l.label).width + 30;
    }
}

// ---------- Sunburst (agrégé tous fichiers) ----------
function mfDrawSunburst() {
    // Sunburst global
    const allPreds = mfGetFilteredPredictions();
    _drawSunburstOnCanvas(
        document.getElementById('mfSunburstCanvas'),
        allPreds,
        'Global (toutes confiances)',
        mfState.files.length + ' fichiers'
    );

    // Sunburst seuillé
    const threshold = mfState.confidenceThreshold / 100;
    const threshPreds = allPreds.filter(p => {
        const c = typeof p.confidence === 'number' ? (p.confidence > 1 ? p.confidence / 100 : p.confidence) : 0;
        return c >= threshold;
    });
    _drawSunburstOnCanvas(
        document.getElementById('mfSunburstThreshCanvas'),
        threshPreds,
        'Seuil confiance \u2265 ' + mfState.confidenceThreshold + '% (' + threshPreds.length + '/' + allPreds.length + ')',
        mfState.files.length + ' fichiers'
    );
}

// ---------- Error Timeline (1 ligne par fichier) ----------
function mfDrawErrorTimeline() {
    const canvas = document.getElementById('mfErrorTimelineCanvas');
    if (!canvas) return;
    const files = mfState.files;
    if (files.length === 0) {
        const ctx = canvas.getContext('2d');
        canvas.width = 1200; canvas.height = 120;
        ctx.fillStyle = '#2a2f38'; ctx.fillRect(0, 0, 1200, 120);
        ctx.fillStyle = '#9aa0a6'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('Pas de données', 600, 60);
        return;
    }

    const filterFn = STATS_FILTERS[mfState.statsFilter]?.fn || (() => true);
    const rect = canvas.parentElement.getBoundingClientRect();
    const rowH = 24;
    const gap = 3;
    const m = { top: 10, bottom: 35, left: 120, right: 10 };
    const nFiles = files.length;
    const totalH = m.top + nFiles * (rowH + gap) + m.bottom;
    const w = Math.max(rect.width || 1200, 600);
    canvas.width = w; canvas.height = totalH;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#2a2f38'; ctx.fillRect(0, 0, w, totalH);

    const pw = w - m.left - m.right;

    let yOff = m.top;
    for (let fi = 0; fi < nFiles; fi++) {
        const preds = files[fi].stats.predictions.filter(filterFn);
        const nE = preds.length;
        if (nE === 0) { yOff += rowH + gap; continue; }
        const barW = pw / nE;

        // Label
        ctx.fillStyle = '#9aa0a6'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
        const shortName = files[fi].fileName.length > 16 ? files[fi].fileName.slice(0, 14) + '…' : files[fi].fileName;
        ctx.fillText(shortName, m.left - 5, yOff + rowH / 2 + 3);

        let errCount = 0, totalAnnot = 0;
        for (let i = 0; i < nE; i++) {
            const p = preds[i];
            const x = m.left + i * barW;
            if (p.matchA1 !== null) {
                totalAnnot++;
                if (p.matchA1) {
                    ctx.fillStyle = 'rgba(34,197,94,0.7)';
                } else {
                    ctx.fillStyle = 'rgba(239,68,68,0.85)';
                    errCount++;
                }
            } else {
                ctx.fillStyle = '#e5e7eb';
            }
            ctx.fillRect(x, yOff, Math.max(barW - 0.2, 0.5), rowH);
        }

        // Résumé erreurs à droite
        if (totalAnnot > 0) {
            ctx.fillStyle = '#e8eaed'; ctx.font = '9px sans-serif'; ctx.textAlign = 'left';
            ctx.fillText(errCount + '/' + totalAnnot + ' (' + (errCount / totalAnnot * 100).toFixed(0) + '%)', m.left + pw + 4, yOff + rowH / 2 + 3);
        }

        yOff += rowH + gap;
    }

    // Légende
    ctx.font = '10px sans-serif'; ctx.textAlign = 'left';
    let lx = m.left;
    ctx.fillStyle = 'rgba(34,197,94,0.7)'; ctx.fillRect(lx, totalH - 20, 10, 10);
    ctx.fillStyle = '#e8eaed'; ctx.fillText('Correct', lx + 13, totalH - 11); lx += 70;
    ctx.fillStyle = 'rgba(239,68,68,0.85)'; ctx.fillRect(lx, totalH - 20, 10, 10);
    ctx.fillStyle = '#e8eaed'; ctx.fillText('Erreur', lx + 13, totalH - 11); lx += 60;
    ctx.fillStyle = '#e5e7eb'; ctx.fillRect(lx, totalH - 20, 10, 10);
    ctx.fillStyle = '#e8eaed'; ctx.fillText('Non annoté', lx + 13, totalH - 11);
}

// ---------- Dashboard (multi-fichier) ----------
function mfUpdateDashboard() {
    const grid = document.getElementById('mfDashboardGrid');
    if (!grid) return;
    const preds = mfGetFilteredPredictions();
    if (preds.length === 0) { grid.innerHTML = '<p style="color:#9aa0a6;">Pas de données</p>'; return; }

    const withA1 = preds.filter(p => p.matchA1 !== null);
    const withA2 = preds.filter(p => p.matchA2 !== null);
    const accA1 = withA1.length ? (withA1.filter(p => p.matchA1).length / withA1.length * 100) : null;
    const accA2 = withA2.length ? (withA2.filter(p => p.matchA2).length / withA2.length * 100) : null;

    let kappaA1 = null;
    if (withA1.length > 0) {
        const N = withA1.length;
        let po = withA1.filter(p => p.matchA1).length / N;
        let pe = 0;
        for (const s of STAGE_NAMES) {
            pe += (withA1.filter(p => p.name === s).length / N) * (withA1.filter(p => p.annot1 === s).length / N);
        }
        kappaA1 = pe < 1 ? ((po - pe) / (1 - pe)) : 1;
    }

    let ece = null;
    if (withA1.length > 0) {
        const nBins = 10;
        const bins = Array.from({ length: nBins }, () => ({ total: 0, correct: 0, sumConf: 0 }));
        for (const p of withA1) {
            const c = (typeof p.confidence === 'number' ? p.confidence : 0) > 1 ? p.confidence / 100 : (p.confidence || 0);
            const idx = Math.min(Math.floor(c * nBins), nBins - 1);
            bins[idx].total++;
            bins[idx].sumConf += c;
            if (p.matchA1) bins[idx].correct++;
        }
        ece = 0;
        for (const b of bins) {
            if (b.total === 0) continue;
            ece += (b.total / withA1.length) * Math.abs(b.correct / b.total - b.sumConf / b.total);
        }
        ece *= 100;
    }

    const avgConf = preds.reduce((s, p) => {
        const c = typeof p.confidence === 'number' ? p.confidence : 0;
        return s + (c > 1 ? c : c * 100);
    }, 0) / preds.length;

    const cards = [
        { label: 'Fichiers', value: mfState.files.length, color: '#3b82f6' },
        { label: 'Epochs', value: preds.length, color: '#3b82f6' },
        { label: 'Précision A1', value: accA1 !== null ? accA1.toFixed(1) + '%' : 'N/A', color: accA1 !== null && accA1 >= 80 ? '#22c55e' : '#ef4444' },
        { label: 'Précision A2', value: accA2 !== null ? accA2.toFixed(1) + '%' : 'N/A', color: accA2 !== null && accA2 >= 80 ? '#22c55e' : '#ef4444' },
        { label: 'Kappa A1', value: kappaA1 !== null ? kappaA1.toFixed(3) : 'N/A', color: kappaA1 !== null && kappaA1 >= 0.6 ? '#22c55e' : '#f59e0b' },
        { label: 'ECE', value: ece !== null ? ece.toFixed(2) + '%' : 'N/A', color: ece !== null && ece < 5 ? '#22c55e' : '#ef4444' },
        { label: 'Confiance moy.', value: avgConf.toFixed(1) + '%', color: avgConf >= 80 ? '#22c55e' : '#f59e0b' },
    ];

    grid.innerHTML = cards.map(c => `
        <div class="stat-card">
            <div class="stat-label">${c.label}</div>
            <div class="stat-value" style="color:${c.color}">${c.value}</div>
        </div>
    `).join('');
}

// ---------- Confusion Heatmap (multi-fichier) ----------
function mfDrawConfusionHeatmap() {
    const canvas = document.getElementById('mfConfusionHeatmapCanvas');
    if (!canvas) return;
    const preds = mfGetFilteredPredictions().filter(p => p.matchA1 !== null);
    if (preds.length === 0) {
        const ctx = canvas.getContext('2d');
        const pw = canvas.parentElement ? canvas.parentElement.getBoundingClientRect().width : 500;
        const w = Math.min(500, Math.max(pw - 32, 400));
        canvas.width = w; canvas.height = 450;
        ctx.fillStyle = '#2a2f38'; ctx.fillRect(0, 0, w, 450);
        ctx.fillStyle = '#9aa0a6'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('Pas de données annotées', w / 2, 225);
        return;
    }

    const N = STAGE_NAMES.length;
    const matrix = Array.from({ length: N }, () => new Array(N).fill(0));
    const idx = { 'Wake': 0, 'N1': 1, 'N2': 2, 'N3': 3, 'REM': 4 };

    for (const p of preds) {
        const ti = idx[p.annot1];
        const pi = idx[p.name];
        if (ti !== undefined && pi !== undefined) matrix[ti][pi]++;
    }

    const pw = canvas.parentElement ? canvas.parentElement.getBoundingClientRect().width : 500;
    const w = Math.min(500, Math.max(pw - 32, 400)), h = 450;
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#2a2f38'; ctx.fillRect(0, 0, w, h);

    const mg = { top: 50, bottom: 40, left: 70, right: 20 };
    const cw = w - mg.left - mg.right, ch = h - mg.top - mg.bottom;
    const cellW = cw / N, cellH = ch / N;

    ctx.fillStyle = '#e8eaed'; ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('Matrice de confusion (tous fichiers)', w / 2, 20);

    ctx.fillStyle = '#9aa0a6'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('Prédit (IA)', mg.left + cw / 2, h - 10);
    ctx.save(); ctx.translate(15, mg.top + ch / 2); ctx.rotate(-Math.PI / 2);
    ctx.fillText('Vrai (Annoteur)', 0, 0); ctx.restore();

    ctx.fillStyle = '#e8eaed'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
    for (let j = 0; j < N; j++) ctx.fillText(STAGE_NAMES[j], mg.left + j * cellW + cellW / 2, mg.top - 8);
    ctx.textAlign = 'right';
    for (let i = 0; i < N; i++) ctx.fillText(STAGE_NAMES[i], mg.left - 8, mg.top + i * cellH + cellH / 2 + 4);

    for (let i = 0; i < N; i++) {
        const rowSum = matrix[i].reduce((a, b) => a + b, 0);
        for (let j = 0; j < N; j++) {
            const val = rowSum > 0 ? matrix[i][j] / rowSum : 0;
            const x = mg.left + j * cellW, y = mg.top + i * cellH;
            if (i === j) {
                const g = Math.round(80 + val * 175);
                ctx.fillStyle = `rgba(34, ${g}, 94, ${0.3 + val * 0.7})`;
            } else {
                const r = Math.round(80 + val * 175);
                ctx.fillStyle = `rgba(${r}, 68, 68, ${0.2 + val * 0.8})`;
            }
            ctx.fillRect(x + 1, y + 1, cellW - 2, cellH - 2);
            ctx.fillStyle = '#e8eaed'; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center';
            ctx.fillText((val * 100).toFixed(1) + '%', x + cellW / 2, y + cellH / 2 - 4);
            ctx.font = '10px sans-serif'; ctx.fillStyle = '#9aa0a6';
            ctx.fillText(`(${matrix[i][j]})`, x + cellW / 2, y + cellH / 2 + 12);
        }
    }
}

// ---------- Error Bursts (multi-fichier) ----------
function mfAnalyzeErrorBursts() {
    const grid = document.getElementById('mfErrorBurstsGrid');
    const canvas = document.getElementById('mfErrorBurstsCanvas');
    if (!grid || !canvas) return;
    const preds = mfGetFilteredPredictions().filter(p => p.matchA1 !== null);
    if (preds.length === 0) {
        grid.innerHTML = '<p style="color:#9aa0a6;">Pas de données</p>';
        const ctx = canvas.getContext('2d');
        canvas.width = 400; canvas.height = 300;
        ctx.fillStyle = '#2a2f38'; ctx.fillRect(0, 0, 400, 300);
        return;
    }

    const errors = preds.map(p => !p.matchA1);
    const bursts = [];
    let currentLen = 0;
    for (let i = 0; i < errors.length; i++) {
        if (errors[i]) { currentLen++; }
        else { if (currentLen > 0) bursts.push(currentLen); currentLen = 0; }
    }
    if (currentLen > 0) bursts.push(currentLen);

    const totalErrors = errors.filter(Boolean).length;
    const isolated = bursts.filter(b => b === 1).length;
    const longBursts = bursts.filter(b => b >= 5);
    const maxBurst = bursts.length > 0 ? Math.max(...bursts) : 0;
    const avgLen = bursts.length > 0 ? bursts.reduce((a, b) => a + b, 0) / bursts.length : 0;
    const errorsInLong = longBursts.reduce((a, b) => a + b, 0);

    const cards = [
        { label: 'Erreurs totales', value: totalErrors, color: '#ef4444' },
        { label: 'Séquences d\'erreurs', value: bursts.length, color: '#f59e0b' },
        { label: 'Erreurs isolées', value: isolated, color: '#3b82f6' },
        { label: 'Séquences ≥5', value: longBursts.length, color: longBursts.length > 0 ? '#ef4444' : '#22c55e' },
        { label: 'Plus longue séq.', value: maxBurst, color: maxBurst >= 5 ? '#ef4444' : '#22c55e' },
        { label: 'Long. moy.', value: avgLen.toFixed(1), color: '#9aa0a6' },
        { label: 'Err. dans séq. ≥5', value: errorsInLong, color: '#ef4444' },
    ];

    grid.innerHTML = cards.map(c => `
        <div class="stat-card">
            <div class="stat-label">${c.label}</div>
            <div class="stat-value" style="color:${c.color}">${c.value}</div>
        </div>
    `).join('');

    if (bursts.length === 0) return;
    const maxLen = Math.max(...bursts);
    const hist = new Array(maxLen).fill(0);
    for (const b of bursts) hist[b - 1]++;

    const ppw = canvas.parentElement ? canvas.parentElement.getBoundingClientRect().width : 500;
    const w = Math.max(ppw, 300), h = 300;
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#2a2f38'; ctx.fillRect(0, 0, w, h);

    const mg = { top: 30, bottom: 40, left: 50, right: 20 };
    const cww = w - mg.left - mg.right, chh = h - mg.top - mg.bottom;
    const maxCount = Math.max(...hist, 1);
    const barW = Math.max(2, cww / hist.length - 2);

    ctx.fillStyle = '#e8eaed'; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('Distribution des longueurs de séquences d\'erreurs', w / 2, 18);

    for (let i = 0; i < hist.length; i++) {
        const barH = (hist[i] / maxCount) * chh;
        const x = mg.left + (i / hist.length) * cww;
        const y = mg.top + chh - barH;
        ctx.fillStyle = (i + 1) >= 5 ? '#ef4444' : '#3b82f6';
        ctx.fillRect(x, y, barW, barH);
    }

    ctx.fillStyle = '#9aa0a6'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
    const step = Math.max(1, Math.floor(hist.length / 10));
    for (let i = 0; i < hist.length; i += step) {
        ctx.fillText(String(i + 1), mg.left + (i / hist.length) * cww + barW / 2, h - 10);
    }
    ctx.fillText('Longueur', mg.left + cww / 2, h - 2);
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
        const val = Math.round((i / 4) * maxCount);
        ctx.fillText(String(val), mg.left - 5, mg.top + (1 - i / 4) * chh + 4);
    }
}

function mfUpdateAggregatedStats() {
    const files = mfState.files;
    if (files.length === 0) return;

    const filterFn = STATS_FILTERS[mfState.statsFilter]?.fn || (() => true);

    let totalEpochs = 0;
    const accA1s = [], accA2s = [];
    let sumConf = 0, sumTime = 0, countPreds = 0;

    for (const f of files) {
        const filtered = f.stats.predictions.filter(filterFn);
        totalEpochs += filtered.length;

        const cmpA1 = filtered.filter(p => p.matchA1 !== null);
        if (cmpA1.length > 0) accA1s.push(cmpA1.filter(p => p.matchA1).length / cmpA1.length);

        const cmpA2 = filtered.filter(p => p.matchA2 !== null);
        if (cmpA2.length > 0) accA2s.push(cmpA2.filter(p => p.matchA2).length / cmpA2.length);

        for (const p of filtered) {
            sumConf += p.confidence;
            sumTime += (p.time_ms || 0);
            countPreds++;
        }
    }

    // Affichage
    document.getElementById('mfStatFiles').textContent = files.length;
    document.getElementById('mfStatEpochs').textContent = totalEpochs;

    const durEl = document.getElementById('mfStatEpochsDuration');
    if (durEl && typeof formatDuration === 'function') {
        durEl.textContent = formatDuration(totalEpochs);
    }

    const meanA1 = accA1s.length > 0 ? accA1s.reduce((a, b) => a + b) / accA1s.length : null;
    document.getElementById('mfStatAccA1').textContent =
        meanA1 !== null ? `${(meanA1 * 100).toFixed(1)}%` : '--';
    const rangeA1El = document.getElementById('mfStatAccA1Range');
    if (rangeA1El && accA1s.length > 1) {
        const min = Math.min(...accA1s), max = Math.max(...accA1s);
        rangeA1El.textContent = `${(min * 100).toFixed(1)}% - ${(max * 100).toFixed(1)}%`;
    } else if (rangeA1El) rangeA1El.textContent = '';

    const meanA2 = accA2s.length > 0 ? accA2s.reduce((a, b) => a + b) / accA2s.length : null;
    document.getElementById('mfStatAccA2').textContent =
        meanA2 !== null ? `${(meanA2 * 100).toFixed(1)}%` : '--';
    const rangeA2El = document.getElementById('mfStatAccA2Range');
    if (rangeA2El && accA2s.length > 1) {
        const min = Math.min(...accA2s), max = Math.max(...accA2s);
        rangeA2El.textContent = `${(min * 100).toFixed(1)}% - ${(max * 100).toFixed(1)}%`;
    } else if (rangeA2El) rangeA2El.textContent = '';

    document.getElementById('mfStatAvgConf').textContent =
        countPreds > 0 ? `${(sumConf / countPreds * 100).toFixed(1)}%` : '--';
    document.getElementById('mfStatAvgTime').textContent =
        countPreds > 0 ? Math.round(sumTime / countPreds) : '--';

    // Filter info
    const infoEl = document.getElementById('mfStatsFilterInfo');
    if (infoEl) {
        const totalAll = files.reduce((s, f) => s + f.stats.predictions.length, 0);
        if (mfState.statsFilter !== 'all') {
            const pct = totalAll > 0 ? (totalEpochs / totalAll * 100).toFixed(1) : '0';
            infoEl.textContent = `${totalEpochs} / ${totalAll} epochs (${pct}%)`;
        } else {
            infoEl.textContent = '';
        }
    }
}

function mfUpdateAggregatedDistribution() {
    const preds = mfGetFilteredPredictions();
    const total = preds.length;
    const grid = document.getElementById('mfDistributionGrid');
    if (!grid) return;

    const counts = {};
    for (const name of STAGE_NAMES) counts[name] = 0;
    for (const p of preds) counts[p.name] = (counts[p.name] || 0) + 1;

    const frag = document.createDocumentFragment();
    for (const name of STAGE_NAMES) {
        const cnt = counts[name] || 0;
        const pct = total > 0 ? (cnt / total * 100).toFixed(1) : '0.0';
        const card = document.createElement('div');
        card.className = 'stat-card';
        const cls = getStageClass(name);
        const durText = typeof formatDuration === 'function' ? formatDuration(cnt) : '';
        card.innerHTML = `
            <div class="stat-label stage-${cls}">${name}</div>
            <div class="stat-value stage-${cls}">${cnt}</div>
            <div class="stat-duration">${pct}%${durText ? ' | ' + durText : ''}</div>
        `;
        frag.appendChild(card);
    }
    grid.innerHTML = '';
    grid.appendChild(frag);
}

function mfUpdateFilteredStats() {
    const allPreds = mfGetFilteredPredictions();
    const threshold = mfState.confidenceThreshold / 100;
    const filtered = allPreds.filter(p => p.confidence >= threshold);
    const total = allPreds.length;

    const label = document.getElementById('mfFilteredCountLabel');
    if (label) {
        label.textContent = total > 0
            ? `${filtered.length} epochs retenues (${(filtered.length / total * 100).toFixed(1)}%)`
            : '';
    }

    const grid = document.getElementById('mfFilteredStatsGrid');
    const distGrid = document.getElementById('mfFilteredDistributionGrid');

    if (!grid) return;

    if (filtered.length === 0) {
        grid.innerHTML = '<div class="stat-card"><div class="stat-value">--</div></div>';
        if (distGrid) {
            distGrid.innerHTML = '';
            const oldLeg = distGrid.previousElementSibling;
            if (oldLeg && oldLeg.classList.contains('stat-legend')) oldLeg.remove();
        }
        return;
    }

    const cmpA1 = filtered.filter(p => p.matchA1 !== null);
    const hitA1 = cmpA1.filter(p => p.matchA1).length;
    const accA1 = cmpA1.length > 0 ? `${(hitA1 / cmpA1.length * 100).toFixed(1)}%` : '--';

    const cmpA2 = filtered.filter(p => p.matchA2 !== null);
    const hitA2 = cmpA2.filter(p => p.matchA2).length;
    const accA2 = cmpA2.length > 0 ? `${(hitA2 / cmpA2.length * 100).toFixed(1)}%` : '--';

    const avgTime = Math.round(filtered.reduce((s, p) => s + (p.time_ms || 0), 0) / filtered.length);

    grid.innerHTML = `
        <div class="stat-card">
            <div class="stat-label">Epochs filtrées</div>
            <div class="stat-value">${filtered.length} / ${total}</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Précision vs A1</div>
            <div class="stat-value">${accA1}</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Précision vs A2</div>
            <div class="stat-value">${accA2}</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Temps moyen (ms)</div>
            <div class="stat-value">${avgTime}</div>
        </div>
    `;

    // Distribution par stade (meme detail que single-file)
    if (!distGrid) return;
    distGrid.innerHTML = '';

    const counts = { 'Wake': 0, 'N1': 0, 'N2': 0, 'N3': 0, 'REM': 0 };
    const stageHitA1 = { 'Wake': 0, 'N1': 0, 'N2': 0, 'N3': 0, 'REM': 0 };
    const stageCmpA1 = { 'Wake': 0, 'N1': 0, 'N2': 0, 'N3': 0, 'REM': 0 };
    const stageHitA2 = { 'Wake': 0, 'N1': 0, 'N2': 0, 'N3': 0, 'REM': 0 };
    const stageCmpA2 = { 'Wake': 0, 'N1': 0, 'N2': 0, 'N3': 0, 'REM': 0 };
    const stageWrongBoth = { 'Wake': 0, 'N1': 0, 'N2': 0, 'N3': 0, 'REM': 0 };
    for (const p of filtered) {
        const s = p.name;
        counts[s] = (counts[s] || 0) + 1;
        if (p.matchA1 !== null) { stageCmpA1[s]++; if (p.matchA1) stageHitA1[s]++; }
        if (p.matchA2 !== null) { stageCmpA2[s]++; if (p.matchA2) stageHitA2[s]++; }
        if (p.matchA1 !== null && p.matchA2 !== null && !p.matchA1 && !p.matchA2) {
            stageWrongBoth[s]++;
        }
    }
    const filtTotal = filtered.length;

    // Legende (inseree avant la grille)
    let legend = distGrid.previousElementSibling;
    if (!legend || !legend.classList.contains('stat-legend')) {
        legend = document.createElement('div');
        legend.className = 'stat-legend';
        distGrid.parentNode.insertBefore(legend, distGrid);
    }
    legend.innerHTML =
        '<span style="color:#9aa0a6">%</span> = part dans les epochs filtrées · ' +
        '<span style="color:#fbbf24">duree</span> = phase / total filtre · ' +
        '<span style="color:#22c55e">A1</span> = accord annoteur 1 · ' +
        '<span style="color:#3b82f6">A2</span> = accord annoteur 2 · ' +
        '<span style="color:#ef4444">Err</span> = faux (aucun accord) · ' +
        '<span style="color:#22c55e">ok%</span> = bon: <span style="color:#22c55e">&gt;90%</span> ' +
        '<span style="color:#f59e0b">moyen: 70-90%</span> ' +
        '<span style="color:#ef4444">faible: &lt;70%</span>';

    for (const stage of STAGE_NAMES) {
        const count = counts[stage] || 0;
        const pct = (count / filtTotal * 100).toFixed(1);
        const sAccA1 = stageCmpA1[stage] > 0
            ? (stageHitA1[stage] / stageCmpA1[stage] * 100).toFixed(0) + '%' : '--';
        const sAccA2 = stageCmpA2[stage] > 0
            ? (stageHitA2[stage] / stageCmpA2[stage] * 100).toFixed(0) + '%' : '--';
        const wrong = stageWrongBoth[stage];
        let errText = '';
        if (count === 0) {
            errText = '';
        } else if (wrong === 0) {
            errText = '<span style="color:#22c55e">100% OK</span>';
        } else {
            const correctVal = (count - wrong) / count * 100;
            const okColor = correctVal >= 90 ? '#22c55e' : correctVal >= 70 ? '#f59e0b' : '#ef4444';
            errText = wrong + ' err <span style="color:#9aa0a6">(</span><span style="color:' + okColor + '">' + correctVal.toFixed(1) + '% ok</span><span style="color:#9aa0a6">)</span>';
        }
        const card = document.createElement('div');
        card.className = 'stat-card';
        card.innerHTML = `
            <div class="stat-label stage-${getStageClass(stage)}">${stage}</div>
            <div class="stat-value" style="color:${STAGE_COLORS[stage]}">${count}</div>
            <div style="font-size:12px;color:#9aa0a6">${pct}%</div>
            <div class="stat-duration">${durHtml(count, filtTotal)}</div>
            <div class="stat-accord">` +
                `<span style="color:#22c55e">A1 ${sAccA1}</span>` +
                `<span style="color:#9aa0a6"> / </span>` +
                `<span style="color:#3b82f6">A2 ${sAccA2}</span></div>` +
            `<div class="stat-errors">${errText}</div>
        `;
        distGrid.appendChild(card);
    }
}

// ============================================================================
// Métriques par stade: Précision / Recall / F1
// ============================================================================

function mfBuildMetrics() {
    const preds = mfGetFilteredPredictions();
    const tbody = document.getElementById('mfMetricsBody');
    if (!tbody) return;

    const frag = document.createDocumentFragment();

    for (const stage of STAGE_NAMES) {
        const tp = preds.filter(p => p.name === stage && p.annot1 === stage).length;
        const fp = preds.filter(p => p.name === stage && p.annot1 !== null && p.annot1 !== stage).length;
        const fn = preds.filter(p => p.name !== stage && p.annot1 === stage).length;

        const precision = (tp + fp) > 0 ? tp / (tp + fp) : 0;
        const recall = (tp + fn) > 0 ? tp / (tp + fn) : 0;
        const f1 = (precision + recall) > 0 ? 2 * precision * recall / (precision + recall) : 0;
        const support = tp + fn;

        const cls = getStageClass(stage);
        const row = document.createElement('tr');
        row.innerHTML = `
            <td class="stage-${cls}" style="font-weight:700;">${stage}</td>
            <td>${(precision * 100).toFixed(1)}%</td>
            <td>${(recall * 100).toFixed(1)}%</td>
            <td>${(f1 * 100).toFixed(1)}%</td>
            <td>${support}</td>
        `;
        frag.appendChild(row);
    }

    // Macro-average
    const stages = STAGE_NAMES.map(stage => {
        const tp = preds.filter(p => p.name === stage && p.annot1 === stage).length;
        const fp = preds.filter(p => p.name === stage && p.annot1 !== null && p.annot1 !== stage).length;
        const fn = preds.filter(p => p.name !== stage && p.annot1 === stage).length;
        const prec = (tp + fp) > 0 ? tp / (tp + fp) : 0;
        const rec = (tp + fn) > 0 ? tp / (tp + fn) : 0;
        return { prec, rec };
    });
    const macroP = stages.reduce((s, v) => s + v.prec, 0) / NUM_CLASSES;
    const macroR = stages.reduce((s, v) => s + v.rec, 0) / NUM_CLASSES;
    const macroF1 = (macroP + macroR) > 0 ? 2 * macroP * macroR / (macroP + macroR) : 0;
    const totalSupport = preds.filter(p => p.annot1 !== null).length;

    const avgRow = document.createElement('tr');
    avgRow.style.borderTop = '2px solid var(--border)';
    avgRow.style.fontWeight = '700';
    avgRow.innerHTML = `
        <td>Macro-moy</td>
        <td>${(macroP * 100).toFixed(1)}%</td>
        <td>${(macroR * 100).toFixed(1)}%</td>
        <td>${(macroF1 * 100).toFixed(1)}%</td>
        <td>${totalSupport}</td>
    `;
    frag.appendChild(avgRow);

    tbody.innerHTML = '';
    tbody.appendChild(frag);
}

// ============================================================================
// Matrice de confusion
// ============================================================================

function mfBuildConfusionMatrix() {
    const container = document.getElementById('mfConfusionContainer');
    if (!container) return;

    const preds = mfGetFilteredPredictions().filter(p => p.annot1 !== null);
    if (preds.length === 0) {
        container.innerHTML = '<p style="color:var(--text-muted);font-size:13px;">Pas de données annotées</p>';
        return;
    }

    // Construire la matrice
    const matrix = {};
    for (const actual of STAGE_NAMES) {
        matrix[actual] = {};
        for (const predicted of STAGE_NAMES) {
            matrix[actual][predicted] = 0;
        }
    }
    for (const p of preds) {
        if (matrix[p.annot1]) {
            matrix[p.annot1][p.name] = (matrix[p.annot1][p.name] || 0) + 1;
        }
    }

    // Trouver le max pour la coloration
    let maxVal = 0;
    for (const actual of STAGE_NAMES) {
        for (const predicted of STAGE_NAMES) {
            if (matrix[actual][predicted] > maxVal) maxVal = matrix[actual][predicted];
        }
    }

    // Generer le HTML
    let html = '<table class="confusion-matrix"><thead><tr><th class="cm-corner">Réel \\ Prédit</th>';
    for (const name of STAGE_NAMES) {
        html += `<th class="stage-${getStageClass(name)}">${name}</th>`;
    }
    html += '</tr></thead><tbody>';

    for (const actual of STAGE_NAMES) {
        html += `<tr><td class="cm-row-label stage-${getStageClass(actual)}">${actual}</td>`;
        for (const predicted of STAGE_NAMES) {
            const val = matrix[actual][predicted];
            const intensity = maxVal > 0 ? val / maxVal : 0;
            const bg = actual === predicted
                ? `rgba(52, 211, 153, ${0.1 + intensity * 0.5})`
                : `rgba(248, 113, 113, ${intensity * 0.4})`;
            html += `<td class="cm-cell" style="background:${bg};">${val}</td>`;
        }
        html += '</tr>';
    }
    html += '</tbody></table>';

    container.innerHTML = html;
}

// ============================================================================
// Duree des stades par fichier
// ============================================================================

function mfBuildDurationTable() {
    const tbody = document.getElementById('mfDurationBody');
    const statsGrid = document.getElementById('mfDurationStatsGrid');
    if (!tbody || !statsGrid) return;

    const frag = document.createDocumentFragment();
    const allDurations = {};
    for (const name of STAGE_NAMES) allDurations[name] = [];

    for (const f of mfState.files) {
        const counts = {};
        for (const name of STAGE_NAMES) counts[name] = 0;
        for (const p of f.stats.predictions) {
            counts[p.name] = (counts[p.name] || 0) + 1;
        }

        const row = document.createElement('tr');
        let rowHtml = `<td title="${f.fileName}">${f.fileName}</td>`;
        let total = 0;
        for (const name of STAGE_NAMES) {
            const mins = (counts[name] * 30 / 60).toFixed(1);
            allDurations[name].push(parseFloat(mins));
            total += counts[name];
            rowHtml += `<td>${mins}</td>`;
        }
        rowHtml += `<td style="font-weight:700;">${(total * 30 / 60).toFixed(1)}</td>`;
        row.innerHTML = rowHtml;
        frag.appendChild(row);
    }

    tbody.innerHTML = '';
    tbody.appendChild(frag);

    // Stats min/moy/max
    const sfrag = document.createDocumentFragment();
    for (const name of STAGE_NAMES) {
        const vals = allDurations[name];
        if (vals.length === 0) continue;
        const min = Math.min(...vals).toFixed(1);
        const max = Math.max(...vals).toFixed(1);
        const avg = (vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(1);
        const cls = getStageClass(name);

        const card = document.createElement('div');
        card.className = 'stat-card';
        card.innerHTML = `
            <div class="stat-label stage-${cls}">${name}</div>
            <div class="stat-value stage-${cls}">${avg} min</div>
            <div class="stat-duration">${min} - ${max} min</div>
        `;
        sfrag.appendChild(card);
    }
    statsGrid.innerHTML = '';
    statsGrid.appendChild(sfrag);
}

// ============================================================================
// Export
// ============================================================================

function mfExportSummaryCSV() {
    const rows = ['Fichier,Epochs,PrécisionA1(%),PrécisionA2(%),ConfMoy(%),KappaA1,TempsMoy(ms)'];
    for (const f of mfState.files) {
        const s = f.stats;
        rows.push([
            `"${f.fileName}"`,
            s.totalEpochs,
            s.accA1 !== null ? (s.accA1 * 100).toFixed(1) : '',
            s.accA2 !== null ? (s.accA2 * 100).toFixed(1) : '',
            (s.avgConfidence * 100).toFixed(1),
            s.kappaA1 !== null ? s.kappaA1.toFixed(4) : '',
            Math.round(s.avgTimeMs),
        ].join(','));
    }
    mfDownload(rows.join('\n'), 'neuralix_resume_multifile.csv', 'text/csv');
}

function mfExportAllPredictionsCSV() {
    const rows = ['Fichier,Epoch,Temps,ESP32,Annot1,Annot2,Confiance(%),Temps_ms,MatchA1,MatchA2'];
    for (const f of mfState.files) {
        for (const p of f.data.predictions || []) {
            rows.push([
                `"${f.fileName}"`,
                p.epoch,
                typeof formatTime === 'function' ? formatTime(p.epoch * 30) : '',
                p.name,
                p.annot1 || '',
                p.annot2 || '',
                (p.confidence * 100).toFixed(1),
                p.time_ms || '',
                p.matchA1 !== null ? (p.matchA1 ? 1 : 0) : '',
                p.matchA2 !== null ? (p.matchA2 ? 1 : 0) : '',
            ].join(','));
        }
    }
    mfDownload(rows.join('\n'), 'neuralix_all_predictions.csv', 'text/csv');
}

function mfExportHypnogramsPNG() {
    // Creer un canvas composite
    const files = mfGetSelectedHypnoFiles();
    if (files.length === 0) return;

    const singleH = 130;
    const totalH = files.length * singleH + 20;
    const w = 1200;

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = totalH;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#1a1d23';
    ctx.fillRect(0, 0, w, totalH);

    let y = 10;
    for (const f of files) {
        // Label
        ctx.fillStyle = '#9aa0a6';
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(f.fileName, 55, y + 8);

        // Mini hypnogramme
        const margin = { top: y + 14, bottom: y + singleH - 10, left: 50, right: 20 };
        const plotH = margin.bottom - margin.top;
        const plotW = w - margin.left - margin.right;

        const preds = f.data.predictions || [];
        const annot1 = f.data.annotations1 || [];
        const annot2 = f.data.annotations2 || [];
        const totalEpochs = Math.max(preds.length, annot1.length, 1);
        const epochW = plotW / totalEpochs;

        const stageOrder = ['Wake', 'REM', 'N1', 'N2', 'N3'];
        const stageY = {};
        stageOrder.forEach((name, i) => {
            stageY[name] = margin.top + (i / (stageOrder.length - 1)) * plotH;
        });

        // Grille
        ctx.strokeStyle = '#3a3f4a';
        ctx.lineWidth = 0.5;
        for (const sy of Object.values(stageY)) {
            ctx.beginPath();
            ctx.moveTo(margin.left, sy);
            ctx.lineTo(w - margin.right, sy);
            ctx.stroke();
        }

        // Labels Y
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'right';
        for (const [name, sy] of Object.entries(stageY)) {
            ctx.fillStyle = STAGE_COLORS[name] || '#9aa0a6';
            ctx.fillText(name, margin.left - 4, sy + 3);
        }

        const marg = { left: margin.left, right: margin.right, top: margin.top, bottom: 0 };
        if (typeof drawHypnogramStepLine === 'function') {
            drawHypnogramStepLine(ctx, annot2, stageY, marg, epochW, 0, totalEpochs,
                                  '#22c55e', 1, [3, 3]);
            drawHypnogramStepLine(ctx, annot1, stageY, marg, epochW, 0, totalEpochs,
                                  '#ef4444', 1, [6, 3]);
            drawHypnogramStepLine(ctx, preds.map(p => p.name), stageY, marg, epochW, 0, totalEpochs,
                                  '#3b82f6', 2, []);
        }

        y += singleH;
    }

    canvas.toBlob(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'neuralix_hypnograms.png';
        a.click();
        URL.revokeObjectURL(url);
    });
}

function mfDownload(content, filename, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

// ============================================================================
// Initialisation
// ============================================================================

function mfInit() {
    // Chargement fichiers
    document.getElementById('mfFileInput').addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            mfLoadFiles(e.target.files);
            e.target.value = '';
        }
    });

    // Chargement dossier
    document.getElementById('mfFolderInput').addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            const jsonFiles = Array.from(e.target.files).filter(f => f.name.endsWith('.json'));
            if (jsonFiles.length > 0) {
                mfLoadFiles(jsonFiles);
            }
            e.target.value = '';
        }
    });

    document.getElementById('mfClearFiles').addEventListener('click', () => {
        mfClearAllFiles();
    });

    // Tri resume
    document.getElementById('mfSortSelect').addEventListener('change', (e) => {
        mfState.sortBy = e.target.value;
        mfBuildSummaryTable();
    });

    // Export resume
    document.getElementById('mfExportSummary').addEventListener('click', mfExportSummaryCSV);

    // Hypnogrammes
    document.getElementById('mfHypnoSelect').addEventListener('change', () => mfDrawHypnograms());
    document.getElementById('mfHypnoCount').addEventListener('change', () => mfDrawHypnograms());

    // Checkboxes de visibilite hypnogramme multi-fichiers
    for (const id of ['mfHypnoShowNeuralix', 'mfHypnoShowA1', 'mfHypnoShowA2']) {
        document.getElementById(id)?.addEventListener('change', () => mfDrawHypnograms());
    }

    let _searchTimeout;
    document.getElementById('mfHypnoSearch').addEventListener('input', (e) => {
        clearTimeout(_searchTimeout);
        _searchTimeout = setTimeout(() => {
            mfUpdateHypnoSelect();
            mfDrawHypnograms();
        }, 200);
    });

    // Filtre statistiques
    document.getElementById('mfStatsFilterSelect').addEventListener('change', (e) => {
        mfState.statsFilter = e.target.value;
        requestAnimationFrame(() => mfRefreshAllStats());
    });

    // Filtre confiance
    const slider = document.getElementById('mfConfidenceSlider');
    const input = document.getElementById('mfConfidenceInput');
    slider.addEventListener('input', () => {
        input.value = slider.value;
        mfState.confidenceThreshold = parseInt(slider.value);
        mfUpdateFilteredStats();
        mfDrawSunburst();
    });
    input.addEventListener('input', () => {
        let v = parseInt(input.value);
        if (isNaN(v)) return;
        v = Math.max(0, Math.min(100, v));
        input.value = v;
        slider.value = v;
        mfState.confidenceThreshold = v;
        mfUpdateFilteredStats();
        mfDrawSunburst();
    });

    // Filtre confiance du fichier selectionne
    const fsSlider = document.getElementById('mffsConfidenceSlider');
    const fsInput = document.getElementById('mffsConfidenceInput');
    if (fsSlider && fsInput) {
        fsSlider.addEventListener('input', () => {
            fsInput.value = fsSlider.value;
            mfUpdateFileStatsFiltered();
        });
        fsInput.addEventListener('input', () => {
            let v = parseInt(fsInput.value);
            if (isNaN(v)) return;
            v = Math.max(0, Math.min(100, v));
            fsInput.value = v;
            fsSlider.value = v;
            mfUpdateFileStatsFiltered();
        });
    }

    // Exports
    document.getElementById('mfExportAllCSV').addEventListener('click', mfExportAllPredictionsCSV);
    document.getElementById('mfExportStatsCSV').addEventListener('click', mfExportSummaryCSV);
    document.getElementById('mfExportHypnosPNG').addEventListener('click', mfExportHypnogramsPNG);

    // Redimensionnement et changement de zoom
    window.addEventListener('resize', () => {
        if (document.getElementById('tabMultifile').classList.contains('active')) {
            mfDrawHypnograms();
        }
    });
    window.addEventListener('neuralix-zoom-changed', () => {
        if (document.getElementById('tabMultifile').classList.contains('active')) {
            mfDrawHypnograms();
        }
    });

    // Redessiner TOUTE section multifile qui redevient visible
    const _mfSectionRefreshMap = {
        'mfHypnoSection':             () => mfDrawHypnograms(),
        'mfSummarySection':           () => mfBuildSummaryTable(),
        'mfStatsSection':             () => { mfUpdateAggregatedStats(); mfUpdateAggregatedDistribution(); mfUpdateFilteredStats(); },
        'mfKappaSection':             () => mfUpdateKappaStats(),
        'mfMetricsSection':           () => mfBuildMetrics(),
        'mfDurationSection':          () => mfBuildDurationTable(),
        'mfFileStatsSection':         () => { if (mfState.selectedFileId) mfShowFileStats(mfState.selectedFileId); },
        'mfHistorySection':           () => { if (mfState.selectedFileId) mfShowHistory(mfState.selectedFileId); },
        'mfDashboardSection':         () => mfUpdateDashboard(),
        'mfCalibrationSection':       () => mfDrawCalibrationCurve(),
        'mfBlandAltmanSection':       () => mfDrawBlandAltman(),
        'mfIccSection':               () => mfUpdateICC(),
        'mfHeatmapSection':           () => mfDrawHeatmap(),
        'mfSunburstSection':          () => mfDrawSunburst(),
        'mfErrorTimelineSection':     () => mfDrawErrorTimeline(),
        'mfConfusionHeatmapSection':  () => mfDrawConfusionHeatmap(),
        'mfErrorBurstsSection':       () => mfAnalyzeErrorBursts(),
    };
    window.addEventListener('neuralix-section-shown', (e) => {
        if (!document.getElementById('tabMultifile').classList.contains('active')) return;
        if (mfState.files.length === 0) return;
        const id = e.detail && e.detail.id;
        const fn = _mfSectionRefreshMap[id];
        if (fn) {
            requestAnimationFrame(() => requestAnimationFrame(() => {
                try { fn(); } catch (err) { console.warn('MF section refresh error:', id, err); }
            }));
        }
    });

    // Redessiner les hypnogrammes quand la section redevient visible
    // (sidebar toggle, ou restauration IDB quand la section etait masquee)
    var _mfHypnoResizeObs = new ResizeObserver(function () {
        var container = document.getElementById('mfHypnoContainer');
        if (!container || container.children.length === 0) return;
        // Verifier si le premier canvas a une taille incorrecte
        var firstCanvas = container.querySelector('canvas');
        if (!firstCanvas) return;
        var wrapper = firstCanvas.parentElement;
        if (!wrapper) return;
        var wrapperW = wrapper.clientWidth;
        var canvasW = parseFloat(firstCanvas.style.width) || 0;
        // Si le wrapper est significativement plus large que le canvas, redessiner
        if (wrapperW > 0 && (canvasW < wrapperW - 60)) {
            mfDrawHypnograms();
        }
    });
    var hypnoSection = document.getElementById('mfHypnoSection');
    if (hypnoSection) _mfHypnoResizeObs.observe(hypnoSection);

    // Sauvegarder avant fermeture/rechargement
    window.addEventListener('beforeunload', () => {
        if (mfState.files.length > 0) mfSaveToIDB();
    });

    // Restaurer les donnees depuis IndexedDB
    mfRestoreFromIDB();
}
