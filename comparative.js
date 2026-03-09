/**
 * Neuralix Web Tester — Module Comparatif Algos
 *
 * Charge deux jeux de sessions (un par algorithme) et compare
 * leurs statistiques cote a cote avec mise en evidence des differences.
 *
 * Depend des globales de app.js : STAGE_NAMES, STAGE_COLORS,
 * getCellColors, computeKappa (de multifile.js)
 */

// ============================================================================
// Etat
// ============================================================================

const cmpState = {
    sidesData: { A: [], B: [] },       // fichiers par algo
    algoNames: { A: '', B: '' },       // noms d'algos (dossiers)
    confMode: 'common',                // 'common' | 'individual'
    confThreshold: 60,
    confThresholdA: 60,
    confThresholdB: 60,
};

// ============================================================================
// Persistance IndexedDB (reutilise _idbPut / _idbGet de app.js)
// ============================================================================

const CMP_IDB_KEY = 'comparative-data';

function cmpSaveToIDB() {
    if (typeof _idbPut !== 'function') return;
    const payload = {
        A: cmpState.sidesData.A.map(f => ({ id: f.id, fileName: f.fileName, folderName: f.folderName, data: f.data })),
        B: cmpState.sidesData.B.map(f => ({ id: f.id, fileName: f.fileName, folderName: f.folderName, data: f.data })),
        algoNames: cmpState.algoNames,
        confMode: cmpState.confMode,
        confThreshold: cmpState.confThreshold,
        confThresholdA: cmpState.confThresholdA,
        confThresholdB: cmpState.confThresholdB,
    };
    _idbPut(CMP_IDB_KEY, payload);
}

async function cmpRestoreFromIDB() {
    if (typeof _idbGet !== 'function') return false;
    try {
        const payload = await _idbGet(CMP_IDB_KEY);
        if (!payload || (!payload.A?.length && !payload.B?.length)) return false;

        // Reconstruire les entries avec stats recalculees
        for (const side of ['A', 'B']) {
            cmpState.sidesData[side] = (payload[side] || []).map(raw => ({
                id: raw.id || crypto.randomUUID(),
                fileName: raw.fileName,
                folderName: raw.folderName || '',
                data: raw.data,
                stats: mfComputeFileStats(raw.data),
            }));
            document.getElementById('cmpCount' + side).textContent = cmpState.sidesData[side].length + ' fichiers';
        }

        // Restaurer noms d'algos
        if (payload.algoNames) {
            cmpState.algoNames = payload.algoNames;
            for (const side of ['A', 'B']) {
                const name = payload.algoNames[side];
                if (name) {
                    const input = document.getElementById('cmpAlgoName' + side);
                    if (input) input.value = name;
                    const title = document.getElementById('cmpLoaderTitle' + side);
                    if (title) title.textContent = name;
                    const confLabel = document.getElementById('cmpConfLabel' + side);
                    if (confLabel) confLabel.textContent = name;
                }
            }
        }

        // Restaurer seuils
        if (payload.confMode) cmpState.confMode = payload.confMode;
        if (payload.confThreshold != null) cmpState.confThreshold = payload.confThreshold;
        if (payload.confThresholdA != null) cmpState.confThresholdA = payload.confThresholdA;
        if (payload.confThresholdB != null) cmpState.confThresholdB = payload.confThresholdB;

        // MAJ sliders UI
        var confSlider = document.getElementById('cmpConfSlider');
        if (confSlider) { confSlider.value = cmpState.confThreshold; }
        var confValue = document.getElementById('cmpConfValue');
        if (confValue) confValue.textContent = cmpState.confThreshold + '%';
        var confSliderA = document.getElementById('cmpConfSliderA');
        if (confSliderA) confSliderA.value = cmpState.confThresholdA;
        var confValueA = document.getElementById('cmpConfValueA');
        if (confValueA) confValueA.textContent = cmpState.confThresholdA + '%';
        var confSliderB = document.getElementById('cmpConfSliderB');
        if (confSliderB) confSliderB.value = cmpState.confThresholdB;
        var confValueB = document.getElementById('cmpConfValueB');
        if (confValueB) confValueB.textContent = cmpState.confThresholdB + '%';

        if (cmpState.confMode === 'individual') {
            var modeBtn = document.getElementById('cmpConfModeBtn');
            if (modeBtn) modeBtn.textContent = 'Mode : Individuel';
            var indiv = document.getElementById('cmpConfIndividual');
            if (indiv) indiv.style.display = '';
            if (confSlider) confSlider.parentElement.style.display = 'none';
        }

        // Afficher et calculer
        cmpShowSections();
        if (cmpState.sidesData.A.length > 0 && cmpState.sidesData.B.length > 0) {
            cmpRefreshAll();
        }
        return true;
    } catch (e) {
        console.warn('cmpRestoreFromIDB:', e);
        return false;
    }
}

// ============================================================================
// Chargement de fichiers (reutilise mfParseSessionFile et mfComputeFileStats)
// ============================================================================

async function cmpLoadFolder(side, fileList) {
    const files = Array.from(fileList).filter(f => f.name.endsWith('.json'));
    let loaded = 0;
    const BATCH = 10;

    // Extraire le nom du dossier depuis webkitRelativePath du premier fichier
    let folderName = '';
    if (files.length > 0 && files[0].webkitRelativePath) {
        const parts = files[0].webkitRelativePath.split('/');
        if (parts.length > 1) folderName = parts[0];
    }

    for (let i = 0; i < files.length; i += BATCH) {
        const batch = files.slice(i, i + BATCH);
        const results = await Promise.allSettled(batch.map(f => mfParseSessionFile(f)));
        for (const r of results) {
            if (r.status === 'fulfilled' && r.value) {
                cmpState.sidesData[side].push(r.value);
                loaded++;
            }
        }
        await new Promise(r => setTimeout(r, 0));
    }

    document.getElementById('cmpCount' + side).textContent = cmpState.sidesData[side].length + ' fichiers';

    // Utiliser le nom du dossier comme nom de l'algo
    if (folderName) {
        cmpState.algoNames[side] = folderName;
        const nameInput = document.getElementById('cmpAlgoName' + side);
        if (nameInput) nameInput.value = folderName;
        // Mettre a jour le titre du loader
        const loaderTitle = document.getElementById('cmpLoaderTitle' + side);
        if (loaderTitle) loaderTitle.textContent = folderName;
        // Mettre a jour le label confiance individuelle
        const confLabel = document.getElementById('cmpConfLabel' + side);
        if (confLabel) confLabel.textContent = folderName;
    }

    if (loaded > 0) {
        cmpShowSections();
        cmpRefreshAll();
        cmpSaveToIDB();
    }
}

// ============================================================================
// Visibilite des sections
// ============================================================================

function cmpShowSections() {
    const has = cmpState.sidesData.A.length > 0 && cmpState.sidesData.B.length > 0;
    const ids = ['cmpConfSection', 'cmpGlobalSection', 'cmpDistribSection',
                 'cmpPerStageSection', 'cmpMetricsSection', 'cmpConfusionSection', 'cmpKappaSection'];
    for (const id of ids) {
        const el = document.getElementById(id);
        if (el) el.style.display = has ? '' : 'none';
    }
    if (typeof window.sidebarNotifyComparativeData === 'function') {
        window.sidebarNotifyComparativeData(has);
    }
}

// ============================================================================
// Filtrage par confiance
// ============================================================================

function cmpGetThreshold(side) {
    if (cmpState.confMode === 'individual') {
        return (side === 'A' ? cmpState.confThresholdA : cmpState.confThresholdB) / 100;
    }
    return cmpState.confThreshold / 100;
}

function cmpFilterPredictions(files, threshold) {
    const all = [];
    for (const f of files) {
        for (const p of (f.data.predictions || [])) {
            if (p.confidence >= threshold) all.push(p);
        }
    }
    return all;
}

// ============================================================================
// Calcul des stats agregees pour un cote
// ============================================================================

function cmpComputeSideStats(files, threshold) {
    const preds = cmpFilterPredictions(files, threshold);
    const n = preds.length;
    const NC = STAGE_NAMES.length;

    // Total epochs avant filtrage confiance
    let totalEpochsRaw = 0;
    for (const f of files) totalEpochsRaw += (f.data.predictions || []).length;

    const stats = {
        fileCount: files.length,
        totalEpochs: n,
        totalEpochsRaw: totalEpochsRaw,
        accA1: null,
        accA2: null,
        accA1Range: null,
        accA2Range: null,
        avgConfidence: 0,
        avgTimeMs: 0,
        stageCounts: {},
        stagePercents: {},
        perStageAccA1: {},
        perStageAccA2: {},
        perStageDetail: {},
        kappaIA_A1: null,
        kappaIA_A2: null,
        kappaA1_A2: null,
        perStageKappa: {},
        metrics: {},
        confusion: null,
    };

    // Index rapide : stage name -> indice
    const si = {};
    for (let i = 0; i < NC; i++) {
        const s = STAGE_NAMES[i];
        si[s] = i;
        stats.stageCounts[s] = 0;
        stats.stagePercents[s] = 0;
        stats.perStageAccA1[s] = null;
        stats.perStageAccA2[s] = null;
        stats.perStageDetail[s] = { count: 0, hitA1: 0, cmpA1: 0, hitA2: 0, cmpA2: 0, wrongBoth: 0 };
    }

    if (n === 0) return stats;

    // ---- Passage unique sur toutes les predictions ----
    let hitA1 = 0, cntA1 = 0, hitA2 = 0, cntA2 = 0;
    let sumConf = 0, sumTime = 0;

    // Compteurs par stade pour precision, metrics, kappa
    const stCntPred = new Array(NC).fill(0);       // count par stage predit
    const stCntA1   = new Array(NC).fill(0);        // count par stage annot1
    const stCntA2   = new Array(NC).fill(0);        // count par stage annot2
    const stHitA1   = new Array(NC).fill(0);        // annot1 == stage & match
    const stTotalA1 = new Array(NC).fill(0);        // annot1 == stage
    const stHitA2   = new Array(NC).fill(0);
    const stTotalA2 = new Array(NC).fill(0);

    // Confusion matrix + kappa accumulateurs
    const cm = STAGE_NAMES.map(() => new Array(NC).fill(0));
    let kappaIA1_cnt = 0, kappaIA2_cnt = 0;
    let a1a2_agree = 0, a1a2_cnt = 0;
    const a1a2_cntA1 = new Array(NC).fill(0);
    const a1a2_cntA2 = new Array(NC).fill(0);

    // Binary kappa accumulateurs par stade
    const bkTotal = new Array(NC).fill(0);
    const bkAgree = new Array(NC).fill(0);
    const bkPredP = new Array(NC).fill(0);
    const bkAnnotP = new Array(NC).fill(0);

    for (let i = 0; i < n; i++) {
        const p = preds[i];
        const pi = si[p.name];       // indice du stade predit
        const hasA1 = p.matchA1 !== null;
        const hasA2 = p.matchA2 !== null;
        const a1i = p.annot1 ? si[p.annot1] : -1;
        const a2i = p.annot2 ? si[p.annot2] : -1;

        // Distribution
        if (pi !== undefined) stCntPred[pi]++;

        // Precision globale
        if (hasA1) { cntA1++; if (p.matchA1) hitA1++; }
        if (hasA2) { cntA2++; if (p.matchA2) hitA2++; }

        // Confiance + temps
        sumConf += (p.confidence || 0);
        sumTime += (p.time_ms || 0);

        // Detail par stade
        if (pi !== undefined) {
            const d = stats.perStageDetail[p.name];
            d.count++;
            if (hasA1) { d.cmpA1++; if (p.matchA1) d.hitA1++; }
            if (hasA2) { d.cmpA2++; if (p.matchA2) d.hitA2++; }
            if (hasA1 && hasA2 && !p.matchA1 && !p.matchA2) d.wrongBoth++;
        }

        // Precision par stade (vs A1 / A2)
        if (a1i >= 0) { stTotalA1[a1i]++; if (p.matchA1) stHitA1[a1i]++; }
        if (a2i >= 0) { stTotalA2[a2i]++; if (p.matchA2) stHitA2[a2i]++; }

        // Confusion matrix (pred x annot1)
        if (pi !== undefined && a1i >= 0) cm[pi][a1i]++;

        // Kappa IA vs A1 accumulateurs
        if (a1i >= 0 && pi !== undefined) {
            stCntA1[a1i]++;
            kappaIA1_cnt++;
        }
        if (a2i >= 0 && pi !== undefined) {
            stCntA2[a2i]++;
            kappaIA2_cnt++;
        }

        // Kappa A1 vs A2
        if (a1i >= 0 && a2i >= 0) {
            a1a2_cnt++;
            if (a1i === a2i) a1a2_agree++;
            a1a2_cntA1[a1i]++;
            a1a2_cntA2[a2i]++;
        }

        // Binary kappa par stade
        if (hasA1 && pi !== undefined && a1i >= 0) {
            for (let s = 0; s < NC; s++) {
                bkTotal[s]++;
                const isPred = (pi === s);
                const isAnnot = (a1i === s);
                if (isPred === isAnnot) bkAgree[s]++;
                if (isPred) bkPredP[s]++;
                if (isAnnot) bkAnnotP[s]++;
            }
        }
    }

    // ---- Calculs finaux ----
    stats.accA1 = cntA1 > 0 ? hitA1 / cntA1 : null;
    stats.accA2 = cntA2 > 0 ? hitA2 / cntA2 : null;
    stats.avgConfidence = sumConf / n;
    stats.avgTimeMs = sumTime / n;

    for (let i = 0; i < NC; i++) {
        const s = STAGE_NAMES[i];
        stats.stageCounts[s] = stCntPred[i];
        stats.stagePercents[s] = stCntPred[i] / n * 100;
        stats.perStageAccA1[s] = stTotalA1[i] > 0 ? stHitA1[i] / stTotalA1[i] : null;
        stats.perStageAccA2[s] = stTotalA2[i] > 0 ? stHitA2[i] / stTotalA2[i] : null;
    }

    // Ranges de precision par fichier
    const fileAccA1 = [], fileAccA2 = [];
    for (const f of files) {
        let fHitA1 = 0, fCntA1 = 0, fHitA2 = 0, fCntA2 = 0;
        for (const p of (f.data.predictions || [])) {
            if (p.confidence < threshold) continue;
            if (p.matchA1 !== null) { fCntA1++; if (p.matchA1) fHitA1++; }
            if (p.matchA2 !== null) { fCntA2++; if (p.matchA2) fHitA2++; }
        }
        if (fCntA1 > 0) fileAccA1.push(fHitA1 / fCntA1);
        if (fCntA2 > 0) fileAccA2.push(fHitA2 / fCntA2);
    }
    if (fileAccA1.length > 1) stats.accA1Range = { min: Math.min(...fileAccA1), max: Math.max(...fileAccA1) };
    if (fileAccA2.length > 1) stats.accA2Range = { min: Math.min(...fileAccA2), max: Math.max(...fileAccA2) };

    // Kappa IA vs A1
    if (kappaIA1_cnt > 0) {
        let po = 0, pe = 0;
        for (let i = 0; i < NC; i++) po += cm[i][i];
        po /= kappaIA1_cnt;
        for (let i = 0; i < NC; i++) {
            pe += (stCntPred[i] / kappaIA1_cnt) * (stCntA1[i] / kappaIA1_cnt);
        }
        stats.kappaIA_A1 = pe >= 1 ? po : (po - pe) / (1 - pe);
    }

    // Kappa IA vs A2
    if (kappaIA2_cnt > 0) {
        const cm2 = STAGE_NAMES.map(() => new Array(NC).fill(0));
        for (const p of preds) {
            const pi2 = si[p.name];
            const a2i2 = p.annot2 ? si[p.annot2] : -1;
            if (pi2 !== undefined && a2i2 >= 0) cm2[pi2][a2i2]++;
        }
        let po = 0, pe = 0;
        for (let i = 0; i < NC; i++) po += cm2[i][i];
        po /= kappaIA2_cnt;
        for (let i = 0; i < NC; i++) {
            pe += (stCntPred[i] / kappaIA2_cnt) * (stCntA2[i] / kappaIA2_cnt);
        }
        stats.kappaIA_A2 = pe >= 1 ? po : (po - pe) / (1 - pe);
    }

    // Kappa A1 vs A2
    if (a1a2_cnt > 0) {
        const po = a1a2_agree / a1a2_cnt;
        let pe = 0;
        for (let i = 0; i < NC; i++) {
            pe += (a1a2_cntA1[i] / a1a2_cnt) * (a1a2_cntA2[i] / a1a2_cnt);
        }
        stats.kappaA1_A2 = pe >= 1 ? po : (po - pe) / (1 - pe);
    }

    // Per-stage kappa (binary)
    for (let i = 0; i < NC; i++) {
        if (bkTotal[i] > 0) {
            const nn = bkTotal[i];
            const po = bkAgree[i] / nn;
            const pp = bkPredP[i] / nn;
            const ap = bkAnnotP[i] / nn;
            const pe = pp * ap + (1 - pp) * (1 - ap);
            stats.perStageKappa[STAGE_NAMES[i]] = pe >= 1 ? po : (po - pe) / (1 - pe);
        }
    }

    // Metrics (Precision/Recall/F1) depuis la confusion matrix
    for (let i = 0; i < NC; i++) {
        let tp = cm[i][i], fp = 0, fn = 0;
        for (let j = 0; j < NC; j++) {
            if (j !== i) { fp += cm[i][j]; fn += cm[j][i]; }
        }
        const precision = (tp + fp) > 0 ? tp / (tp + fp) : 0;
        const recall = (tp + fn) > 0 ? tp / (tp + fn) : 0;
        const f1 = (precision + recall) > 0 ? 2 * precision * recall / (precision + recall) : 0;
        stats.metrics[STAGE_NAMES[i]] = { precision, recall, f1, support: tp + fn };
    }

    stats.confusion = cm;
    return stats;
}

// ============================================================================
// Rendu
// ============================================================================

function cmpAlgoName(side) {
    const input = document.getElementById('cmpAlgoName' + side);
    return input ? input.value.trim() || ('Algo ' + side) : 'Algo ' + side;
}

// Calcule l'opacite (0.15..1) proportionnelle a la difference.
// maxDiff = difference (en meme unite que les valeurs) a laquelle l'opacite atteint 1.
function cmpDiffAlpha(diff, maxDiff) {
    var abs = Math.abs(diff);
    if (abs < 0.002) return 0;
    // Min 0.15, max 1, echelle lineaire
    return Math.min(0.15 + (abs / maxDiff) * 0.85, 1);
}

// Style inline avec couleur + transparence proportionnelle a la difference.
function cmpDiffStyle(valA, valB, higherIsBetter, maxDiff) {
    if (valA == null || valB == null) return '';
    var diff = valA - valB;
    var alpha = cmpDiffAlpha(diff, maxDiff || 0.15);
    if (alpha === 0) return '';
    var good = higherIsBetter ? diff > 0 : diff < 0;
    var color = good ? '52,211,153' : '248,113,113';
    return 'border-left:3px solid rgba(' + color + ',' + alpha.toFixed(2) + ');padding-left:6px';
}

function cmpDiffBadge(valA, valB, higherIsBetter, isPercent, maxDiff) {
    if (valA == null || valB == null) return '';
    var diff = valA - valB;
    if (Math.abs(diff) < 0.002) return '';
    var sign = diff > 0 ? '+' : '';
    var fmt = isPercent ? (diff * 100).toFixed(1) + '%' : diff.toFixed(3);
    var good = higherIsBetter ? diff > 0 : diff < 0;
    var alpha = cmpDiffAlpha(diff, maxDiff || 0.15);
    var rgb = good ? '52,211,153' : '248,113,113';
    return '<span class="cmp-badge" style="background:rgba(' + rgb + ',' + (alpha * 0.35).toFixed(2) + ');color:rgba(' + rgb + ',' + alpha.toFixed(2) + ')">' + sign + fmt + '</span>';
}

function cmpStatCard(label, value, diffHtml, styleAttr) {
    return '<div class="stat-card"' + (styleAttr ? ' style="' + styleAttr + '"' : '') + '>' +
        '<div class="stat-label">' + label + '</div>' +
        '<div class="stat-value">' + value + '</div>' +
        (diffHtml ? '<div class="cmp-diff">' + diffHtml + '</div>' : '') +
        '</div>';
}

// ============================================================================
// Refresh all
// ============================================================================

function cmpRefreshAll() {
    const thA = cmpGetThreshold('A');
    const thB = cmpGetThreshold('B');
    const sA = cmpComputeSideStats(cmpState.sidesData.A, thA);
    const sB = cmpComputeSideStats(cmpState.sidesData.B, thB);
    const nameA = cmpAlgoName('A');
    const nameB = cmpAlgoName('B');

    cmpRenderGlobal(sA, sB, nameA, nameB);
    cmpRenderDistrib(sA, sB, nameA, nameB);
    cmpRenderPerStage(sA, sB, nameA, nameB);
    cmpRenderMetrics(sA, sB, nameA, nameB);
    cmpRenderConfusion(sA, sB, nameA, nameB);
    cmpRenderKappa(sA, sB, nameA, nameB);
}

// ---- Global stats ----
function cmpRenderGlobal(sA, sB, nameA, nameB) {
    const el = document.getElementById('cmpGlobalDual');
    if (!el) return;

    function rangeHtml(range) {
        if (!range) return '';
        return '<small style="color:#9aa0a6">' + (range.min * 100).toFixed(1) + '% - ' + (range.max * 100).toFixed(1) + '%</small>';
    }

    function durationHtml(epochs) {
        if (!epochs || typeof formatDuration !== 'function') return '';
        return '<small style="color:#9aa0a6">' + formatDuration(epochs) + '</small>';
    }

    function filteredHtml(s) {
        if (s.totalEpochs >= s.totalEpochsRaw) return '';
        const pct = s.totalEpochsRaw > 0 ? (s.totalEpochs / s.totalEpochsRaw * 100).toFixed(1) : '0';
        return '<small style="color:#9aa0a6">' + s.totalEpochs + ' / ' + s.totalEpochsRaw + ' (' + pct + '%)</small>';
    }

    function side(s, other, name) {
        const accA1 = s.accA1 != null ? (s.accA1 * 100).toFixed(1) + '%' : 'N/A';
        const accA2 = s.accA2 != null ? (s.accA2 * 100).toFixed(1) + '%' : 'N/A';
        return '<div class="cmp-side"><h3>' + name + '</h3><div class="stats-grid cmp-stats-grid">' +
            cmpStatCard('Fichiers', s.fileCount, '') +
            cmpStatCard('Epochs', s.totalEpochs, durationHtml(s.totalEpochs) + filteredHtml(s)) +
            cmpStatCard('Precision A1', accA1,
                cmpDiffBadge(s.accA1, other.accA1, true, true, 0.15) + rangeHtml(s.accA1Range),
                cmpDiffStyle(s.accA1, other.accA1, true, 0.15)) +
            cmpStatCard('Precision A2', accA2,
                cmpDiffBadge(s.accA2, other.accA2, true, true, 0.15) + rangeHtml(s.accA2Range),
                cmpDiffStyle(s.accA2, other.accA2, true, 0.15)) +
            cmpStatCard('Confiance moy.', (s.avgConfidence * 100).toFixed(1) + '%', '') +
            cmpStatCard('Temps moy.', s.avgTimeMs.toFixed(0) + ' ms',
                cmpDiffBadge(s.avgTimeMs, other.avgTimeMs, false, false, 50),
                cmpDiffStyle(s.avgTimeMs, other.avgTimeMs, false, 50)) +
            '</div></div>';
    }
    el.innerHTML = side(sA, sB, nameA) + '<div class="cmp-divider"></div>' + side(sB, sA, nameB);
}

// ---- Distribution ----
function cmpRenderDistrib(sA, sB, nameA, nameB) {
    const el = document.getElementById('cmpDistribDual');
    if (!el) return;

    function side(s, other, name) {
        let html = '<div class="cmp-side"><h3>' + name + '</h3><div class="stats-grid cmp-stats-grid">';
        for (const stage of STAGE_NAMES) {
            const pct = s.stagePercents[stage].toFixed(1) + '%';
            const cnt = s.stageCounts[stage] || 0;
            const d = s.perStageDetail[stage];
            const sAccA1 = d.cmpA1 > 0 ? (d.hitA1 / d.cmpA1 * 100).toFixed(0) + '%' : '--';
            const sAccA2 = d.cmpA2 > 0 ? (d.hitA2 / d.cmpA2 * 100).toFixed(0) + '%' : '--';
            let errText = '';
            if (cnt > 0) {
                if (d.wrongBoth === 0) {
                    errText = '<span style="color:#22c55e;font-size:11px">100% OK</span>';
                } else {
                    const correctVal = (cnt - d.wrongBoth) / cnt * 100;
                    const okColor = correctVal >= 90 ? '#22c55e' : correctVal >= 70 ? '#f59e0b' : '#ef4444';
                    errText = '<span style="font-size:11px">' + d.wrongBoth + ' err <span style="color:' + okColor + '">' + correctVal.toFixed(1) + '% ok</span></span>';
                }
            }
            const durText = typeof durHtml === 'function' ? '<div class="stat-duration">' + durHtml(cnt, s.totalEpochs) + '</div>' : '';
            html += '<div class="stat-card">' +
                '<div class="stat-label stage-' + (typeof getStageClass === 'function' ? getStageClass(stage) : stage.toLowerCase()) + '">' + stage + '</div>' +
                '<div class="stat-value" style="color:' + (STAGE_COLORS[stage] || '#9aa0a6') + '">' + cnt + '</div>' +
                '<div style="font-size:12px;color:#9aa0a6">' + pct + '</div>' +
                durText +
                '<div class="stat-accord" style="font-size:11px">' +
                    '<span style="color:#22c55e">A1 ' + sAccA1 + '</span>' +
                    '<span style="color:#9aa0a6"> / </span>' +
                    '<span style="color:#3b82f6">A2 ' + sAccA2 + '</span>' +
                '</div>' +
                '<div>' + errText + '</div>' +
                '</div>';
        }
        html += '</div></div>';
        return html;
    }
    el.innerHTML = side(sA, sB, nameA) + '<div class="cmp-divider"></div>' + side(sB, sA, nameB);
}

// ---- Per-stage accuracy ----
function cmpRenderPerStage(sA, sB, nameA, nameB) {
    const el = document.getElementById('cmpPerStageDual');
    if (!el) return;

    function side(s, other, name) {
        let html = '<div class="cmp-side"><h3>' + name + '</h3><div class="stats-grid cmp-stats-grid">';
        for (const stage of STAGE_NAMES) {
            const val = s.perStageAccA1[stage];
            const otherVal = other.perStageAccA1[stage];
            const display = val != null ? (val * 100).toFixed(1) + '%' : 'N/A';
            html += cmpStatCard(stage + ' (vs A1)', display,
                cmpDiffBadge(val, otherVal, true, true, 0.15),
                cmpDiffStyle(val, otherVal, true, 0.15));
        }
        html += '</div></div>';
        return html;
    }
    el.innerHTML = side(sA, sB, nameA) + '<div class="cmp-divider"></div>' + side(sB, sA, nameB);
}

// ---- Metrics table ----
function cmpRenderMetrics(sA, sB, nameA, nameB) {
    const el = document.getElementById('cmpMetricsDual');
    if (!el) return;

    function metricsTable(s, other, name) {
        let html = '<div class="cmp-side"><h3>' + name + '</h3>';
        html += '<table class="data-table"><thead><tr><th>Stade</th><th>Precision</th><th>Recall</th><th>F1</th><th>Support</th></tr></thead><tbody>';
        for (const stage of STAGE_NAMES) {
            const m = s.metrics[stage] || {};
            const o = other.metrics[stage] || {};
            function tdStyle(v, ov) {
                var st = cmpDiffStyle(v, ov, true, 0.15);
                return st ? ' style="' + st + '"' : '';
            }
            html += '<tr>' +
                '<td class="' + getStageClass(stage) + '">' + stage + '</td>' +
                '<td' + tdStyle(m.precision, o.precision) + '>' + ((m.precision || 0) * 100).toFixed(1) + '%</td>' +
                '<td' + tdStyle(m.recall, o.recall) + '>' + ((m.recall || 0) * 100).toFixed(1) + '%</td>' +
                '<td' + tdStyle(m.f1, o.f1) + '>' + ((m.f1 || 0) * 100).toFixed(1) + '%</td>' +
                '<td>' + (m.support || 0) + '</td>' +
                '</tr>';
        }
        html += '</tbody></table></div>';
        return html;
    }
    el.innerHTML = metricsTable(sA, sB, nameA) + '<div class="cmp-divider"></div>' + metricsTable(sB, sA, nameB);
}

// ---- Confusion matrices ----
function cmpRenderConfusion(sA, sB, nameA, nameB) {
    const el = document.getElementById('cmpConfusionDual');
    if (!el) return;

    function cmTable(cm, name) {
        if (!cm) return '<div class="cmp-side"><h3>' + name + '</h3><p class="text-muted">Aucune donnee</p></div>';
        const maxVal = Math.max(1, ...cm.flat());
        let html = '<div class="cmp-side"><h3>' + name + '</h3>';
        html += '<table class="confusion-matrix"><thead><tr><th class="cm-corner">Pred \\ Annot</th>';
        for (const s of STAGE_NAMES) html += '<th>' + s + '</th>';
        html += '</tr></thead><tbody>';
        for (let r = 0; r < STAGE_NAMES.length; r++) {
            html += '<tr><td class="cm-row-label">' + STAGE_NAMES[r] + '</td>';
            for (let c = 0; c < STAGE_NAMES.length; c++) {
                const val = cm[r][c];
                const intensity = val / maxVal;
                const bg = r === c
                    ? 'rgba(74,158,255,' + (0.1 + intensity * 0.6) + ')'
                    : 'rgba(255,100,100,' + (intensity * 0.4) + ')';
                html += '<td class="cm-cell" style="background:' + bg + '">' + val + '</td>';
            }
            html += '</tr>';
        }
        html += '</tbody></table></div>';
        return html;
    }
    el.innerHTML = cmTable(sA.confusion, nameA) + '<div class="cmp-divider"></div>' + cmTable(sB.confusion, nameB);
}

// ---- Kappa ----
function cmpRenderKappa(sA, sB, nameA, nameB) {
    const el = document.getElementById('cmpKappaDual');
    if (!el) return;

    function kappaLabel(k) {
        if (k == null) return 'N/A';
        if (k >= 0.81) return 'Excellent';
        if (k >= 0.61) return 'Bon';
        if (k >= 0.41) return 'Modere';
        if (k >= 0.21) return 'Faible';
        return 'Tres faible';
    }

    function kappaColor(k) {
        if (k == null) return '';
        if (k >= 0.81) return 'color:#22c55e';
        if (k >= 0.61) return 'color:#3b82f6';
        if (k >= 0.41) return 'color:#fbbf24';
        if (k >= 0.21) return 'color:#f97316';
        return 'color:#ef4444';
    }

    function side(s, name) {
        let html = '<div class="cmp-side"><h3>' + name + '</h3><div class="stats-grid cmp-stats-grid">';
        // Global kappas
        const items = [
            { label: 'Kappa IA vs A1', val: s.kappaIA_A1 },
            { label: 'Kappa IA vs A2', val: s.kappaIA_A2 },
            { label: 'Kappa A1 vs A2', val: s.kappaA1_A2 },
        ];
        for (const it of items) {
            const display = it.val != null ? it.val.toFixed(3) : 'N/A';
            html += cmpStatCard(it.label,
                '<span style="' + kappaColor(it.val) + '">' + display + '</span>' +
                '<br><small style="' + kappaColor(it.val) + '">' + kappaLabel(it.val) + '</small>',
                '');
        }
        // Per-stage kappa
        for (const stage of STAGE_NAMES) {
            const k = s.perStageKappa[stage];
            const display = k != null ? k.toFixed(3) : 'N/A';
            html += cmpStatCard('Kappa ' + stage,
                '<span style="' + kappaColor(k) + '">' + display + '</span>',
                '<small style="' + kappaColor(k) + '">' + kappaLabel(k) + '</small>');
        }
        html += '</div></div>';
        return html;
    }

    el.innerHTML = side(sA, nameA) + '<div class="cmp-divider"></div>' + side(sB, nameB);
}

// ============================================================================
// Init
// ============================================================================

function cmpInit() {
    // Folder inputs
    document.getElementById('cmpFolderA').addEventListener('change', function (e) {
        cmpLoadFolder('A', e.target.files);
        e.target.value = '';
    });
    document.getElementById('cmpFolderB').addEventListener('change', function (e) {
        cmpLoadFolder('B', e.target.files);
        e.target.value = '';
    });

    // Clear
    document.getElementById('cmpClearBtn').addEventListener('click', function () {
        cmpState.sidesData.A = [];
        cmpState.sidesData.B = [];
        cmpState.algoNames.A = '';
        cmpState.algoNames.B = '';
        document.getElementById('cmpCountA').textContent = '0 fichiers';
        document.getElementById('cmpCountB').textContent = '0 fichiers';
        cmpShowSections();
        cmpSaveToIDB();
    });

    // Algo name changes → refresh headers
    document.getElementById('cmpAlgoNameA').addEventListener('input', function () {
        var name = cmpAlgoName('A');
        cmpState.algoNames.A = name;
        document.getElementById('cmpLoaderTitleA').textContent = name;
        document.getElementById('cmpConfLabelA').textContent = name;
        if (cmpState.sidesData.A.length > 0 && cmpState.sidesData.B.length > 0) cmpRefreshAll();
        cmpSaveToIDB();
    });
    document.getElementById('cmpAlgoNameB').addEventListener('input', function () {
        var name = cmpAlgoName('B');
        cmpState.algoNames.B = name;
        document.getElementById('cmpLoaderTitleB').textContent = name;
        document.getElementById('cmpConfLabelB').textContent = name;
        if (cmpState.sidesData.A.length > 0 && cmpState.sidesData.B.length > 0) cmpRefreshAll();
        cmpSaveToIDB();
    });

    // Debounce pour les sliders de confiance
    var _cmpRefreshTimer = null;
    function cmpDebouncedRefresh() {
        if (_cmpRefreshTimer) cancelAnimationFrame(_cmpRefreshTimer);
        _cmpRefreshTimer = requestAnimationFrame(function () {
            _cmpRefreshTimer = null;
            cmpRefreshAll();
        });
    }

    // Confidence threshold (common)
    var confSlider = document.getElementById('cmpConfSlider');
    confSlider.addEventListener('input', function () {
        cmpState.confThreshold = parseInt(confSlider.value, 10);
        document.getElementById('cmpConfValue').textContent = confSlider.value + '%';
        if (cmpState.confMode === 'common') cmpDebouncedRefresh();
    });
    confSlider.addEventListener('change', function () { cmpSaveToIDB(); });

    // Individual sliders
    var confSliderA = document.getElementById('cmpConfSliderA');
    confSliderA.addEventListener('input', function () {
        cmpState.confThresholdA = parseInt(confSliderA.value, 10);
        document.getElementById('cmpConfValueA').textContent = confSliderA.value + '%';
        if (cmpState.confMode === 'individual') cmpDebouncedRefresh();
    });
    confSliderA.addEventListener('change', function () { cmpSaveToIDB(); });
    var confSliderB = document.getElementById('cmpConfSliderB');
    confSliderB.addEventListener('input', function () {
        cmpState.confThresholdB = parseInt(confSliderB.value, 10);
        document.getElementById('cmpConfValueB').textContent = confSliderB.value + '%';
        if (cmpState.confMode === 'individual') cmpDebouncedRefresh();
    });
    confSliderB.addEventListener('change', function () { cmpSaveToIDB(); });

    // Mode toggle
    document.getElementById('cmpConfModeBtn').addEventListener('click', function () {
        if (cmpState.confMode === 'common') {
            cmpState.confMode = 'individual';
            this.textContent = 'Mode : Individuel';
            document.getElementById('cmpConfIndividual').style.display = '';
            confSlider.parentElement.style.display = 'none';
        } else {
            cmpState.confMode = 'common';
            this.textContent = 'Mode : Commun';
            document.getElementById('cmpConfIndividual').style.display = 'none';
            confSlider.parentElement.style.display = '';
        }
        cmpRefreshAll();
        cmpSaveToIDB();
    });

    // Restaurer les donnees depuis IndexedDB
    cmpRestoreFromIDB();
}

// Boot
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', cmpInit);
} else {
    cmpInit();
}
