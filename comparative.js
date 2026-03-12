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
                 'cmpPerStageSection', 'cmpMetricsSection', 'cmpConfusionSection', 'cmpKappaSection',
                 'cmpSynthesisSection'];
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

    // Compteurs bruts par stade predit (sans filtre confiance)
    const rawStageCounts = {};
    const rawStageHitA1 = {};
    const rawStageCmpA1 = {};
    for (let i = 0; i < STAGE_NAMES.length; i++) {
        const s = STAGE_NAMES[i];
        rawStageCounts[s] = 0; rawStageHitA1[s] = 0; rawStageCmpA1[s] = 0;
    }
    for (const f of files) {
        for (const p of (f.data.predictions || [])) {
            const s = p.name;
            if (rawStageCounts[s] !== undefined) {
                rawStageCounts[s]++;
                const m = p.matchA1 !== undefined ? p.matchA1 : (p.annot1 ? (p.name === p.annot1) : null);
                if (m !== null) { rawStageCmpA1[s]++; if (m) rawStageHitA1[s]++; }
            }
        }
    }

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
        stageCountsRaw: {},       // epochs par stade predit AVANT filtre confiance
        perStageDetailRaw: {},    // hitA1/cmpA1 par stade predit AVANT filtre confiance
        ece: null,                // Expected Calibration Error (0=parfait, 1=catastrophique)
        eceBins: null,            // detail par tranche de confiance
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

        // Accumulateurs recall par stade annote (utilises par d'autres stats)
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
    }

    // ---- Precision par stade avec correction isotonique ----
    // Vraie precision ML : parmi les predictions que l'IA appelle "stade X",
    // combien sont reellement "stade X" selon l'annotateur ?
    // precision = TP / (TP + FP), regroupe par stade PREDIT (pas annote).
    // Correction isotonique (running max droite->gauche) pour garantir
    // la monotonie : seuil plus haut → precision egale ou meilleure.
    function isotonicPerStagePrecision(files, annotKey, matchKey) {
        const result = {};
        for (let i = 0; i < NC; i++) {
            const s = STAGE_NAMES[i];
            // Collecter TOUTES les predictions dont le stade PREDIT == s
            const stagePreds = [];
            for (const f of files) {
                for (const p of (f.data.predictions || [])) {
                    if (si[p.name] === i && p[matchKey] !== null) {
                        stagePreds.push({ conf: p.confidence || 0, hit: p[matchKey] ? 1 : 0 });
                    }
                }
            }
            if (stagePreds.length === 0) { result[s] = null; continue; }

            // Trier par confiance decroissante
            stagePreds.sort((a, b) => b.conf - a.conf);

            // Precision cumulee du top (haute confiance) vers le bas
            let cumHit = 0, cumTotal = 0;
            const cumPrec = new Array(stagePreds.length);
            for (let k = 0; k < stagePreds.length; k++) {
                cumTotal++;
                cumHit += stagePreds[k].hit;
                cumPrec[k] = cumHit / cumTotal;
            }

            // Correction isotonique: running max de droite a gauche
            for (let k = cumPrec.length - 2; k >= 0; k--) {
                cumPrec[k] = Math.max(cumPrec[k], cumPrec[k + 1]);
            }

            // Trouver l'index correspondant au seuil courant
            let lastIdx = -1;
            for (let k = 0; k < stagePreds.length; k++) {
                if (stagePreds[k].conf >= threshold) lastIdx = k;
                else break;
            }
            result[s] = lastIdx >= 0 ? cumPrec[lastIdx] : null;
        }
        return result;
    }

    const isoA1 = isotonicPerStagePrecision(files, 'annot1', 'matchA1');
    const isoA2 = isotonicPerStagePrecision(files, 'annot2', 'matchA2');
    for (let i = 0; i < NC; i++) {
        const s = STAGE_NAMES[i];
        stats.perStageAccA1[s] = isoA1[s];
        stats.perStageAccA2[s] = isoA2[s];
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

    // Kappa A1 vs A2 — calcule sur TOUTES les epochs (sans filtre de confiance)
    // car les annotations humaines ne dependent pas du seuil de confiance de l'IA
    {
        let rawAgree = 0, rawCnt = 0;
        const rawCntA1 = new Array(NC).fill(0);
        const rawCntA2 = new Array(NC).fill(0);
        for (const f of files) {
            for (const p of (f.data.predictions || [])) {
                const ra1 = p.annot1 ? si[p.annot1] : -1;
                const ra2 = p.annot2 ? si[p.annot2] : -1;
                if (ra1 >= 0 && ra2 >= 0) {
                    rawCnt++;
                    if (ra1 === ra2) rawAgree++;
                    rawCntA1[ra1]++;
                    rawCntA2[ra2]++;
                }
            }
        }
        if (rawCnt > 0) {
            const po = rawAgree / rawCnt;
            let pe = 0;
            for (let i = 0; i < NC; i++) {
                pe += (rawCntA1[i] / rawCnt) * (rawCntA2[i] / rawCnt);
            }
            stats.kappaA1_A2 = pe >= 1 ? po : (po - pe) / (1 - pe);
        }
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
    stats.stageCountsRaw = rawStageCounts;
    for (const s of STAGE_NAMES) {
        stats.perStageDetailRaw[s] = { hitA1: rawStageHitA1[s], cmpA1: rawStageCmpA1[s] };
    }

    // ---- ECE (Expected Calibration Error) ----
    // Decoupe les predictions en 10 tranches de confiance (0-10%, 10-20%, ... 90-100%)
    // Pour chaque tranche : compare la confiance moyenne annoncee vs le % reel de bonnes reponses.
    // ECE = somme ponderee des ecarts |confiance_moyenne - accuracy_reelle| par tranche.
    // Un modele bien calibre : quand il dit 80%, il a raison 80% du temps → ECE ≈ 0.
    // Un modele surconfiant : dit 90% mais a raison 50% → ECE eleve.
    {
        const NB = 10; // nombre de tranches
        const bins = [];
        for (let b = 0; b < NB; b++) bins.push({ sumConf: 0, hits: 0, total: 0 });
        for (let i = 0; i < n; i++) {
            const p = preds[i];
            if (p.matchA1 === null) continue;
            const conf = p.confidence || 0;
            const b = Math.min(Math.floor(conf * NB), NB - 1);
            bins[b].total++;
            bins[b].sumConf += conf;
            if (p.matchA1) bins[b].hits++;
        }
        let ece = 0, eceTotal = 0;
        const eceBins = [];
        for (let b = 0; b < NB; b++) {
            const bin = bins[b];
            if (bin.total === 0) { eceBins.push(null); continue; }
            const avgConf = bin.sumConf / bin.total;
            const acc = bin.hits / bin.total;
            const gap = Math.abs(avgConf - acc);
            ece += gap * bin.total;
            eceTotal += bin.total;
            eceBins.push({ range: (b * 10) + '-' + ((b + 1) * 10) + '%',
                avgConf: avgConf, acc: acc, gap: gap, count: bin.total });
        }
        stats.ece = eceTotal > 0 ? ece / eceTotal : 0;
        stats.eceBins = eceBins;
    }

    // ---- Profil de confiance sur donnees BRUTES (avant filtre seuil) ----
    // Percentile 5 = confiance plancher (95% des predictions sont au-dessus)
    // % basse confiance = fraction des predictions < 30%
    // Un bon modele a un plancher eleve et peu de predictions basse confiance.
    {
        const allConfs = [];
        for (const f of files) {
            for (const p of (f.data.predictions || [])) {
                allConfs.push(p.confidence || 0);
            }
        }
        if (allConfs.length > 0) {
            allConfs.sort(function(a, b) { return a - b; });
            const p5idx = Math.floor(allConfs.length * 0.05);
            stats.confP5 = allConfs[p5idx];
            stats.confP25 = allConfs[Math.floor(allConfs.length * 0.25)];
            stats.confMedian = allConfs[Math.floor(allConfs.length * 0.5)];
            let lowCount = 0;
            for (let i = 0; i < allConfs.length; i++) {
                if (allConfs[i] < 0.3) lowCount++;
            }
            stats.confLowPct = lowCount / allConfs.length;
        } else {
            stats.confP5 = 0;
            stats.confP25 = 0;
            stats.confMedian = 0;
            stats.confLowPct = 1;
        }
    }

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
    cmpRenderSynthesis(sA, sB, nameA, nameB, thA, thB);
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
            cmpStatCard('Temps moy.', s.avgTimeMs.toFixed(0) + ' ms', '') +
            '</div></div>';
    }
    el.innerHTML = side(sA, sB, nameA) + '<div class="cmp-divider"></div>' + side(sB, sA, nameB);
}

// ---- Distribution ----
function cmpRenderDistrib(sA, sB, nameA, nameB) {
    const el = document.getElementById('cmpDistribDual');
    if (!el) return;

    // --- Score composite multi-criteres ---
    // 7 axes, chacun note sur 100, pondere puis moyenne = score final
    //
    // 1. Bonnes reponses (20%) : accuracy vs A1
    // 2. Calibration confiance (15%) : ECE par tranche, la confiance est-elle justifiee ?
    // 3. Profil de confiance (10%) : le modele est-il sur de lui ? (plancher eleve, peu de basse confiance)
    // 4. Retention (15%) : epochs gardees / epochs brutes au seuil actuel
    // 5. Fiabilite (15%) : 1 - taux de faux positifs (wrongBoth / total)
    // 6. Distribution realiste (15%) : similarite avec la litterature PSG adulte
    // 7. Couverture des stades (10%) : detecte-t-il les 5 stades ?
    function computeCompositeScore(s) {
        const details = [];

        // 1. Bonnes reponses (accuracy vs A1)
        const accuracy = s.accA1 || 0;
        details.push({ name: 'Bonnes r\u00e9ponses', val: accuracy * 100, weight: 20, icon: '\u2713',
            tip: 'Pourcentage de pr\u00e9dictions correctes par rapport \u00e0 l\u2019annotateur A1. ' +
                 'Ex : sur 1000 epochs, 750 correspondent \u00e0 A1 \u2192 75%. ' +
                 'C\u2019est la mesure la plus directe de la qualit\u00e9 de l\u2019algorithme.' });

        // 2. Calibration confiance (ECE - Expected Calibration Error)
        // On decoupe en tranches de confiance et on verifie que dans chaque tranche
        // le % de bonnes reponses correspond au % de confiance annonce.
        const ece = s.ece || 0;
        const calibScore = Math.max(0, (1 - ece * 2.5)) * 100; // ECE 0 → 100, ECE 0.4 → 0
        // Construire le detail des pires tranches pour le tooltip
        let calibDetail = '';
        if (s.eceBins) {
            const worst = s.eceBins.filter(function(b) { return b !== null; })
                .sort(function(a, b) { return b.gap - a.gap; }).slice(0, 3);
            for (const w of worst) {
                calibDetail += 'Tranche ' + w.range + ' : confiance moy. ' +
                    (w.avgConf * 100).toFixed(0) + '% vs r\u00e9alit\u00e9 ' +
                    (w.acc * 100).toFixed(0) + '% (\u00e9cart ' + (w.gap * 100).toFixed(0) + '%, ' + w.count + ' epochs). ';
            }
        }
        details.push({ name: 'Calibration confiance', val: calibScore, weight: 15, icon: '\u25CE',
            tip: 'Mesure si la confiance du mod\u00e8le correspond \u00e0 la r\u00e9alit\u00e9, tranche par tranche (ECE). ' +
                 'On d\u00e9coupe les pr\u00e9dictions en 10 tranches (0-10%, 10-20%, ... 90-100%) ' +
                 'et on v\u00e9rifie que dans chaque tranche le % de bonnes r\u00e9ponses \u2248 la confiance annonc\u00e9e. ' +
                 'Ex : si le mod\u00e8le dit 90% confiant mais n\u2019a que 50% de bonnes r\u00e9ponses dans cette tranche \u2192 surconfiant, gros \u00e9cart. ' +
                 'ECE = ' + (ece * 100).toFixed(1) + '% (0% = parfait, 50% = catastrophique). ' +
                 'Pires tranches : ' + calibDetail });

        // 3. Profil de confiance (le modele est-il sur de lui ?)
        // Combine : plancher de confiance (P5) + absence de basse confiance (< 30%)
        // Un modele qui ne descend jamais sous 30% est meilleur qu'un qui hesite beaucoup.
        const confP5 = s.confP5 || 0;
        const confLowPct = s.confLowPct || 0;
        // P5 normalise : 0 si P5=0, 100 si P5>=0.5 (toutes les preds >= 50%)
        const p5Score = Math.min(confP5 / 0.5, 1);
        // Basse confiance : 100 si 0% < 30%, 0 si 100% < 30%
        const lowScore = 1 - confLowPct;
        // Moyenne des deux
        const confProfileScore = (p5Score * 0.5 + lowScore * 0.5) * 100;
        details.push({ name: 'Profil de confiance', val: confProfileScore, weight: 10, icon: '\u25B4',
            tip: 'Mesure si le mod\u00e8le est globalement s\u00fbr de ses pr\u00e9dictions (calcul\u00e9 sur toutes les donn\u00e9es brutes, avant filtre seuil). ' +
                 'Deux sous-crit\u00e8res : ' +
                 '1) Plancher de confiance (percentile 5%) = ' + (confP5 * 100).toFixed(0) + '% \u2014 95% des pr\u00e9dictions sont au-dessus de cette valeur. ' +
                 'Plus c\u2019est haut, moins le mod\u00e8le h\u00e9site. ' +
                 '2) Pr\u00e9dictions basse confiance (< 30%) = ' + (confLowPct * 100).toFixed(1) + '% des epochs \u2014 ' +
                 'un bon mod\u00e8le ne devrait quasiment jamais \u00eatre en dessous de 30%. ' +
                 'Confiance m\u00e9diane = ' + ((s.confMedian || 0) * 100).toFixed(0) + '%, P25 = ' + ((s.confP25 || 0) * 100).toFixed(0) + '%.' });

        // 4. Retention (volume)
        const retention = s.totalEpochsRaw > 0 ? s.totalEpochs / s.totalEpochsRaw : 0;
        details.push({ name: 'R\u00e9tention au seuil', val: retention * 100, weight: 15, icon: '\u25A3',
            tip: 'Quel pourcentage des epochs brutes passe le seuil de confiance actuel ? ' +
                 'Ici : ' + s.totalEpochs + ' epochs gard\u00e9es sur ' + s.totalEpochsRaw + ' brutes (' + (retention * 100).toFixed(0) + '%). ' +
                 'Un algo qui filtre trop d\u2019epochs (m\u00eame avec 100% de bonnes r\u00e9ponses) est p\u00e9nalis\u00e9 car il \u00AB refuse \u00BB de se prononcer.' });

        // 5. Fiabilite (pas de faux positifs)
        let totalWrongBoth = 0, totalCnt = 0;
        for (const stage of STAGE_NAMES) {
            const d = s.perStageDetail[stage];
            totalWrongBoth += d.wrongBoth;
            totalCnt += d.count;
        }
        const reliability = totalCnt > 0 ? (totalCnt - totalWrongBoth) / totalCnt : 0;
        details.push({ name: 'Fiabilit\u00e9 (accord annot.)', val: reliability * 100, weight: 15, icon: '\u2691',
            tip: 'Pourcentage d\u2019epochs o\u00f9 au moins un annotateur est d\u2019accord avec l\u2019IA. ' +
                 'Ici : ' + totalWrongBoth + ' epochs sur ' + totalCnt + ' o\u00f9 NI A1 NI A2 ne sont d\u2019accord avec la pr\u00e9diction (faux positifs certains). ' +
                 'Moins il y a de faux positifs, plus le score est \u00e9lev\u00e9.' });

        // 6. Distribution realiste vs litterature PSG adulte
        const expected = { 'Wake': 5, 'N1': 5, 'N2': 50, 'N3': 17, 'REM': 23 };
        let devSum = 0;
        let distribDetail = '';
        for (const stage of STAGE_NAMES) {
            const obs = s.stagePercents[stage] || 0;
            const exp = expected[stage] || 0;
            devSum += Math.abs(obs - exp);
            distribDetail += stage + ': ' + obs.toFixed(0) + '% (attendu ~' + exp + '%) | ';
        }
        const distribSim = Math.max(0, 1 - devSum / 100);
        details.push({ name: 'Distribution (vs litt\u00e9rature)', val: distribSim * 100, weight: 15, icon: '\u2261',
            tip: 'Compare la r\u00e9partition des stades d\u00e9tect\u00e9s avec les proportions typiques d\u2019un adulte en PSG (polysomnographie). ' +
                 'R\u00e9f\u00e9rence : Wake ~5%, N1 ~5%, N2 ~50%, N3 ~17%, REM ~23%. ' +
                 distribDetail +
                 'Un algo qui ne d\u00e9tecte que du Wake et du N2 aura un mauvais score ici.' });

        // 7. Couverture des stades
        let stagesCovered = 0;
        const coveredList = [];
        const missingList = [];
        for (const stage of STAGE_NAMES) {
            if ((s.stagePercents[stage] || 0) >= 1) { stagesCovered++; coveredList.push(stage); }
            else { missingList.push(stage); }
        }
        const coverage = stagesCovered / STAGE_NAMES.length;
        details.push({ name: 'Couverture stades', val: coverage * 100, weight: 10, icon: '\u2630',
            tip: 'Combien des 5 stades de sommeil sont d\u00e9tect\u00e9s (>= 1% du total chacun) ? ' +
                 'D\u00e9tect\u00e9s : ' + coveredList.join(', ') + (missingList.length ? '. Manquants : ' + missingList.join(', ') : '. Tous d\u00e9tect\u00e9s !') + '. ' +
                 'Un bon algorithme doit identifier les 5 stades, pas seulement les plus fr\u00e9quents.' });

        // Score composite pondere
        let wSum = 0, wTotal = 0;
        for (const d of details) {
            wSum += d.val * d.weight;
            wTotal += d.weight;
        }
        const score = wTotal > 0 ? wSum / wTotal : 0;

        return { score: Math.round(score), details };
    }

    // Score par stade (effective accuracy vs raw)
    function computeStageScores(s) {
        const stageScores = {};
        for (const stage of STAGE_NAMES) {
            const rawCnt = s.stageCountsRaw[stage] || 0;
            const d = s.perStageDetail[stage];
            if (rawCnt === 0) { stageScores[stage] = null; continue; }
            stageScores[stage] = (d.hitA1 || 0) / rawCnt * 100;
        }
        return stageScores;
    }

    const scA = computeCompositeScore(sA);
    const scB = computeCompositeScore(sB);
    const ssA = computeStageScores(sA);
    const ssB = computeStageScores(sB);

    function side(s, other, sc, scOther, ss, ssOther, name) {
        const scoreColor = sc.score > scOther.score ? '#22c55e' : sc.score === scOther.score ? '#f59e0b' : '#ef4444';
        let html = '<div class="cmp-side"><h3>' + name + '</h3>';

        // --- Score global avec detail des axes ---
        html += '<div style="margin:8px 0 12px;padding:10px;border-radius:8px;background:rgba(255,255,255,0.05)">';
        html += '<div style="text-align:center;margin-bottom:8px;cursor:help" ' +
            'title="Score composite bas\u00e9 sur 7 crit\u00e8res pond\u00e9r\u00e9s : bonnes r\u00e9ponses (20%), calibration confiance ECE (15%), profil de confiance (10%), r\u00e9tention au seuil (15%), fiabilit\u00e9 (15%), distribution vs litt\u00e9rature (15%) et couverture des stades (10%). Survolez chaque crit\u00e8re ci-dessous pour plus de d\u00e9tails.">' +
            '<span style="font-size:12px;color:#9aa0a6">Score algorithme</span><br>' +
            '<span style="font-size:32px;font-weight:700;color:' + scoreColor + '">' + sc.score + '</span>' +
            '<span style="font-size:14px;color:#9aa0a6">/100</span></div>';
        // Detail des 6 axes (avec tooltips explicatifs)
        for (const d of sc.details) {
            const val = Math.round(d.val);
            const barColor = val >= 70 ? '#22c55e' : val >= 40 ? '#f59e0b' : '#ef4444';
            const tip = d.tip ? ' title="' + d.tip.replace(/"/g, '&quot;') + '"' : '';
            html += '<div style="display:flex;align-items:center;gap:6px;margin:3px 0;font-size:11px;cursor:help"' + tip + '>' +
                '<span style="width:10px;text-align:center;color:#6b7280">' + d.icon + '</span>' +
                '<span style="flex:1;color:#9aa0a6">' + d.name + ' <span style="color:#6b7280">(' + d.weight + '%)</span></span>' +
                '<div style="width:50px;height:4px;border-radius:2px;background:rgba(255,255,255,0.1);overflow:hidden">' +
                '<div style="height:100%;width:' + val + '%;background:' + barColor + ';border-radius:2px"></div></div>' +
                '<span style="width:28px;text-align:right;color:' + barColor + ';font-weight:600">' + val + '</span>' +
                '</div>';
        }
        html += '</div>';

        // --- Cartes par stade ---
        html += '<div class="stats-grid cmp-stats-grid">';
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
            // Barre score effectif par stade
            const stScore = ss[stage];
            const stScoreOther = ssOther[stage];
            let stageScoreHtml = '';
            if (stScore != null) {
                const barColor = stScore >= 70 ? '#22c55e' : stScore >= 40 ? '#f59e0b' : '#ef4444';
                const better = stScoreOther != null && stScore > stScoreOther + 1;
                const worse = stScoreOther != null && stScore < stScoreOther - 1;
                const indicator = better ? ' \u25B2' : worse ? ' \u25BC' : '';
                const indicatorColor = better ? '#22c55e' : '#ef4444';
                const rawCnt = s.stageCountsRaw[stage] || 0;
                const hits = d.hitA1 || 0;
                const stageTip = 'Score effectif ' + stage + ' : ' + hits + ' bonnes r\u00e9ponses (au seuil actuel) sur ' + rawCnt + ' epochs brutes = ' + Math.round(stScore) + '/100. Combine volume et qualit\u00e9 : un algo qui garde beaucoup d\u2019epochs avec un bon % de bonnes r\u00e9ponses aura un score \u00e9lev\u00e9.';
                stageScoreHtml = '<div style="margin-top:3px;cursor:help" title="' + stageTip.replace(/"/g, '&quot;') + '">' +
                    '<div style="display:flex;align-items:center;gap:4px">' +
                    '<div style="flex:1;height:4px;border-radius:2px;background:rgba(255,255,255,0.1);overflow:hidden">' +
                    '<div style="height:100%;width:' + Math.round(stScore) + '%;background:' + barColor + ';border-radius:2px"></div></div>' +
                    '<span style="font-size:10px;color:' + barColor + '">' + Math.round(stScore) + '</span>' +
                    (indicator ? '<span style="font-size:9px;color:' + indicatorColor + '">' + indicator + '</span>' : '') +
                    '</div></div>';
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
                stageScoreHtml +
                '</div>';
        }
        html += '</div></div>';
        return html;
    }
    el.innerHTML = side(sA, sB, scA, scB, ssA, ssB, nameA) + '<div class="cmp-divider"></div>' + side(sB, sA, scB, scA, ssB, ssA, nameB);
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
// Evaluation et Synthese
// ============================================================================

function cmpRenderSynthesis(sA, sB, nameA, nameB, thA, thB) {
    const el = document.getElementById('cmpSynthesisContent');
    if (!el) return;
  try {
    // --- Scoring system ---
    // Each criterion gives a score from -1 (B much better) to +1 (A much better)
    // Weight reflects importance
    const criteria = [];

    // 0. Précision par stade (critère dominant) — chaque stade pèse de façon égale
    // Capture les gros écarts stade par stade (ex: +36% N1, +65% N2)
    {
        let sumA = 0, sumB = 0, nStages = 0;
        const stageList = (typeof STAGE_NAMES !== 'undefined' ? STAGE_NAMES : ['Wake','N1','N2','N3','REM']);
        for (const stage of stageList) {
            const precA = sA.perStageAccA1[stage];
            const precB = sB.perStageAccA1[stage];
            if (precA != null && precB != null) {
                sumA += precA; sumB += precB; nStages++;
            }
        }
        if (nStages > 0) {
            const avgA = sumA / nStages;
            const avgB = sumB / nStages;
            const diff = avgA - avgB;
            criteria.push({
                name: 'Pr\u00e9cision par stade (vs A1)',
                weight: 5,
                score: Math.max(-1, Math.min(1, diff / 0.10)),
                valA: (avgA * 100).toFixed(1) + '% (moy. ' + nStages + ' stades)',
                valB: (avgB * 100).toFixed(1) + '% (moy. ' + nStages + ' stades)',
                diff: diff,
                higherBetter: true
            });
        }
    }

    // 1. Global accuracy vs A1
    if (sA.accA1 != null && sB.accA1 != null) {
        const diff = sA.accA1 - sB.accA1;
        criteria.push({
            name: 'Pr\u00e9cision globale (vs A1)',
            weight: 3,
            score: Math.max(-1, Math.min(1, diff / 0.10)),
            valA: (sA.accA1 * 100).toFixed(1) + '%',
            valB: (sB.accA1 * 100).toFixed(1) + '%',
            diff: diff,
            higherBetter: true
        });
    }

    // 2. Global accuracy vs A2
    if (sA.accA2 != null && sB.accA2 != null) {
        const diff = sA.accA2 - sB.accA2;
        criteria.push({
            name: 'Pr\u00e9cision globale (vs A2)',
            weight: 2,
            score: Math.max(-1, Math.min(1, diff / 0.10)),
            valA: (sA.accA2 * 100).toFixed(1) + '%',
            valB: (sB.accA2 * 100).toFixed(1) + '%',
            diff: diff,
            higherBetter: true
        });
    }

    // 3. Kappa IA vs A1
    if (sA.kappaIA_A1 != null && sB.kappaIA_A1 != null) {
        const diff = sA.kappaIA_A1 - sB.kappaIA_A1;
        criteria.push({
            name: 'Kappa (IA vs A1)',
            weight: 3,
            score: Math.max(-1, Math.min(1, diff / 0.10)),
            valA: sA.kappaIA_A1.toFixed(3),
            valB: sB.kappaIA_A1.toFixed(3),
            diff: diff,
            higherBetter: true
        });
    }

    // 4. Kappa IA vs A2
    if (sA.kappaIA_A2 != null && sB.kappaIA_A2 != null) {
        const diff = sA.kappaIA_A2 - sB.kappaIA_A2;
        criteria.push({
            name: 'Kappa (IA vs A2)',
            weight: 2,
            score: Math.max(-1, Math.min(1, diff / 0.10)),
            valA: sA.kappaIA_A2.toFixed(3),
            valB: sB.kappaIA_A2.toFixed(3),
            diff: diff,
            higherBetter: true
        });
    }

    // 5. Weighted F1 score (pondéré par le support = nb d'epochs par stade)
    const stagesWithMetrics = (typeof STAGE_NAMES !== 'undefined' ? STAGE_NAMES : ['Wake','N1','N2','N3','REM']);
    let wf1SumA = 0, wf1SumB = 0, supportSumA = 0, supportSumB = 0;
    for (const stage of stagesWithMetrics) {
        const mA = sA.metrics[stage];
        const mB = sB.metrics[stage];
        if (mA && mA.f1 != null && mA.support > 0) {
            wf1SumA += mA.f1 * mA.support;
            supportSumA += mA.support;
        }
        if (mB && mB.f1 != null && mB.support > 0) {
            wf1SumB += mB.f1 * mB.support;
            supportSumB += mB.support;
        }
    }
    if (supportSumA > 0 && supportSumB > 0) {
        const wAvgF1A = wf1SumA / supportSumA;
        const wAvgF1B = wf1SumB / supportSumB;
        const diff = wAvgF1A - wAvgF1B;
        criteria.push({
            name: 'F1 pond\u00e9r\u00e9 (par nb epochs)',
            weight: 3,
            score: Math.max(-1, Math.min(1, diff / 0.10)),
            valA: (wAvgF1A * 100).toFixed(1) + '%',
            valB: (wAvgF1B * 100).toFixed(1) + '%',
            diff: diff,
            higherBetter: true
        });
    }

    // 6. Per-stage F1 balance (pire stade, pondéré par volume — un stade à 1 epoch ne compte presque pas)
    let worstWeightedA = 1, worstWeightedB = 1;
    const minSupportForWorst = 10; // ignorer les stades avec trop peu d'epochs
    for (const stage of stagesWithMetrics) {
        const mA = sA.metrics[stage];
        const mB = sB.metrics[stage];
        if (mA && mA.f1 != null && mA.support >= minSupportForWorst) worstWeightedA = Math.min(worstWeightedA, mA.f1);
        if (mB && mB.f1 != null && mB.support >= minSupportForWorst) worstWeightedB = Math.min(worstWeightedB, mB.f1);
    }
    if (worstWeightedA < 1 || worstWeightedB < 1) {
        const diff = worstWeightedA - worstWeightedB;
        criteria.push({
            name: 'F1 pire stade (robustesse)',
            weight: 2,
            score: Math.max(-1, Math.min(1, diff / 0.15)),
            valA: (worstWeightedA * 100).toFixed(1) + '%',
            valB: (worstWeightedB * 100).toFixed(1) + '%',
            diff: diff,
            higherBetter: true
        });
    }

    // 6b. Rappel effectif par stade (recall pondéré × rétention)
    // Pour chaque stade : TP/(TP+FN) pondéré par le nb réel d'epochs du stade
    // Multiplié par la rétention : les epochs sous le seuil comptent comme ratées
    // Un algo qui retrouve 267/300 epochs réelles score mieux que celui qui en retrouve 2/2
    function computeEffectiveRecall(s) {
        let rSum = 0, rSup = 0;
        for (const stage of stagesWithMetrics) {
            const m = s.metrics[stage];
            if (m && m.recall != null && m.support > 0) { rSum += m.recall * m.support; rSup += m.support; }
        }
        if (rSup === 0) return 0;
        const ret = s.totalEpochsRaw > 0 ? s.totalEpochs / s.totalEpochsRaw : 1;
        return (rSum / rSup) * ret;
    }
    const erA = computeEffectiveRecall(sA);
    const erB = computeEffectiveRecall(sB);
    if (erA > 0 || erB > 0) {
        const diff = erA - erB;
        criteria.push({
            name: 'Rappel effectif (par stade)',
            weight: 3,
            score: Math.max(-1, Math.min(1, diff / 0.10)),
            valA: (erA * 100).toFixed(1) + '% (' + sA.totalEpochs + '/' + sA.totalEpochsRaw + ' epochs)',
            valB: (erB * 100).toFixed(1) + '% (' + sB.totalEpochs + '/' + sB.totalEpochsRaw + ' epochs)',
            diff: diff,
            higherBetter: true
        });
    }

    // 7. Data volume (epochs after filtering) — bonus for algo that retains more data
    if (sA.totalEpochs > 0 && sB.totalEpochs > 0) {
        const ratioA = sA.totalEpochsRaw > 0 ? sA.totalEpochs / sA.totalEpochsRaw : 1;
        const ratioB = sB.totalEpochsRaw > 0 ? sB.totalEpochs / sB.totalEpochsRaw : 1;
        const diff = ratioA - ratioB;
        criteria.push({
            name: 'Donn\u00e9es au-dessus du seuil',
            weight: 2,
            score: Math.max(-1, Math.min(1, diff / 0.20)),
            valA: (ratioA * 100).toFixed(1) + '% (' + sA.totalEpochs + '/' + sA.totalEpochsRaw + ')',
            valB: (ratioB * 100).toFixed(1) + '% (' + sB.totalEpochs + '/' + sB.totalEpochsRaw + ')',
            diff: diff,
            higherBetter: true
        });
    }

    // 8. Average confidence
    if (sA.avgConfidence > 0 && sB.avgConfidence > 0) {
        const diff = sA.avgConfidence - sB.avgConfidence;
        criteria.push({
            name: 'Confiance moyenne',
            weight: 1,
            score: Math.max(-1, Math.min(1, diff / 0.10)),
            valA: (sA.avgConfidence * 100).toFixed(1) + '%',
            valB: (sB.avgConfidence * 100).toFixed(1) + '%',
            diff: diff,
            higherBetter: true
        });
    }

    // --- Compute weighted total (relative) ---
    let totalWeight = 0, weightedSum = 0;
    for (const c of criteria) {
        totalWeight += c.weight;
        weightedSum += c.score * c.weight;
    }
    const globalScore = totalWeight > 0 ? weightedSum / totalWeight : 0; // -1 to +1

    // --- Score absolu sur 100 pour chaque algo ---
    // Moyenne pondérée des critères, chacun noté sur 100 :
    //   ★ Précision par stade (poids 5)            = moyenne des précisions par stade × 100
    //   Précision A1 (poids 3)                    = accA1 × 100
    //   Précision A2 (poids 2)                    = accA2 × 100
    //   Kappa A1 (poids 3)                        = kappa × 100
    //   Kappa A2 (poids 2)                        = kappa × 100
    //   F1 pondéré par epochs (poids 3)           = Σ(F1×support) / Σsupport × 100
    //   Robustesse pire stade (poids 2)           = worstF1 × 100  (stades ≥10 epochs)
    //   Rappel effectif par stade (poids 3)       = recall pondéré × rétention
    //   Rétention au seuil (poids 2)              = (epochs filtrées / epochs brutes) × 100
    //   Confiance moyenne (poids 1)               = avgConfidence × 100
    function computeAbsoluteScore(stats) {
        let wSum = 0, wTotal = 0;
        const details = [];

        // 0. Précision par stade (poids 5) — critère dominant
        // Moyenne des précisions par stade (chaque stade pèse autant)
        {
            let pSum = 0, pN = 0;
            for (const stage of stagesWithMetrics) {
                const prec = stats.perStageAccA1[stage];
                if (prec != null) { pSum += prec; pN++; }
            }
            if (pN > 0) {
                const v = (pSum / pN) * 100;
                wSum += v * 5; wTotal += 5;
                details.push({ name: 'Pr\u00e9cision par stade', val: v, weight: 5 });
            }
        }

        // 1. Précision A1 (poids 3)
        if (stats.accA1 != null) {
            const v = stats.accA1 * 100;
            wSum += v * 3; wTotal += 3;
            details.push({ name: 'Pr\u00e9cision A1', val: v, weight: 3 });
        }
        // 2. Précision A2 (poids 2)
        if (stats.accA2 != null) {
            const v = stats.accA2 * 100;
            wSum += v * 2; wTotal += 2;
            details.push({ name: 'Pr\u00e9cision A2', val: v, weight: 2 });
        }
        // 3. Kappa A1 (poids 3)
        if (stats.kappaIA_A1 != null) {
            const v = Math.max(0, stats.kappaIA_A1) * 100;
            wSum += v * 3; wTotal += 3;
            details.push({ name: 'Kappa A1', val: v, weight: 3 });
        }
        // 4. Kappa A2 (poids 2)
        if (stats.kappaIA_A2 != null) {
            const v = Math.max(0, stats.kappaIA_A2) * 100;
            wSum += v * 2; wTotal += 2;
            details.push({ name: 'Kappa A2', val: v, weight: 2 });
        }
        // 5. F1 pondéré par support (poids 3)
        let wf1Sum = 0, supSum = 0;
        for (const stage of stagesWithMetrics) {
            const m = stats.metrics[stage];
            if (m && m.f1 != null && m.support > 0) { wf1Sum += m.f1 * m.support; supSum += m.support; }
        }
        if (supSum > 0) {
            const v = (wf1Sum / supSum) * 100;
            wSum += v * 3; wTotal += 3;
            details.push({ name: 'F1 pond\u00e9r\u00e9', val: v, weight: 3 });
        }
        // 6. Robustesse pire stade (poids 2) — stades ≥ 10 epochs uniquement
        let worstF1 = 1;
        for (const stage of stagesWithMetrics) {
            const m = stats.metrics[stage];
            if (m && m.f1 != null && m.support >= 10) worstF1 = Math.min(worstF1, m.f1);
        }
        if (worstF1 < 1) {
            const v = worstF1 * 100;
            wSum += v * 2; wTotal += 2;
            details.push({ name: 'Robustesse (pire F1)', val: v, weight: 2 });
        }
        // 7. Rappel pondéré par stade (poids 3)
        //    Pour chaque stade : combien d'epochs réelles de ce stade sont correctement
        //    classées ? Les epochs sous le seuil comptent comme ratées.
        //    recall_stade = TP / (TP + FN),  pondéré par le nb réel d'epochs du stade
        //    Un algo qui trouve 267/300 Wake (89%) et 0/2 N1 (0%) → score ~88
        //    Un algo qui trouve 2/2 N1 (100%) mais rate 200/300 Wake → score ~33
        let recallWSum = 0, recallSupSum = 0;
        for (const stage of stagesWithMetrics) {
            const m = stats.metrics[stage];
            if (m && m.recall != null && m.support > 0) {
                recallWSum += m.recall * m.support;
                recallSupSum += m.support;
            }
        }
        if (recallSupSum > 0) {
            // Pénaliser par la rétention : les epochs filtrées sont des epochs ratées
            const retention = stats.totalEpochsRaw > 0 ? stats.totalEpochs / stats.totalEpochsRaw : 1;
            const v = (recallWSum / recallSupSum) * retention * 100;
            wSum += v * 3; wTotal += 3;
            details.push({ name: 'Rappel effectif (par stade)', val: v, weight: 3 });
        }
        // 8. Rétention au seuil (poids 2)
        if (stats.totalEpochsRaw > 0) {
            const v = (stats.totalEpochs / stats.totalEpochsRaw) * 100;
            wSum += v * 2; wTotal += 2;
            details.push({ name: 'R\u00e9tention au seuil', val: v, weight: 2 });
        }
        // 9. Confiance moyenne (poids 1)
        if (stats.avgConfidence > 0) {
            const v = stats.avgConfidence * 100;
            wSum += v * 1; wTotal += 1;
            details.push({ name: 'Confiance moyenne', val: v, weight: 1 });
        }

        const score = wTotal > 0 ? Math.round(wSum / wTotal) : 0;
        return { score, details };
    }

    const resA = computeAbsoluteScore(sA);
    const resB = computeAbsoluteScore(sB);
    const scoreA = resA.score;
    const scoreB = resB.score;

    // --- Determine winner (basé sur globalScore relatif) ---
    const margin = 0.05;
    let winner, loser, winnerName, loserName;
    if (globalScore > margin) {
        winner = sA; loser = sB; winnerName = nameA; loserName = nameB;
    } else if (globalScore < -margin) {
        winner = sB; loser = sA; winnerName = nameB; loserName = nameA;
    } else {
        winner = null;
    }

    // --- Per-stage winners (pondéré par le volume d'epochs) ---
    // Un stade avec beaucoup d'epochs et un bon F1 pèse plus qu'un stade avec 1 epoch à 100%
    const stageWinners = {};
    const stageDetails = {}; // pour affichage détaillé
    for (const stage of stagesWithMetrics) {
        const mA = sA.metrics[stage];
        const mB = sB.metrics[stage];
        const supA = mA ? mA.support : 0;
        const supB = mB ? mB.support : 0;
        // Score = F1 * log(1 + support) — avantage logarithmique au volume
        const scoreA = (mA && mA.f1 != null && supA > 0) ? mA.f1 * Math.log2(1 + supA) : 0;
        const scoreB = (mB && mB.f1 != null && supB > 0) ? mB.f1 * Math.log2(1 + supB) : 0;
        stageDetails[stage] = { scoreA, scoreB, supA, supB };
        if (mA && mB && mA.f1 != null && mB.f1 != null) {
            // Comparer les scores pondérés, pas juste le F1 brut
            if (scoreA - scoreB > 0.1) stageWinners[stage] = nameA;
            else if (scoreB - scoreA > 0.1) stageWinners[stage] = nameB;
            else stageWinners[stage] = null;
        }
    }

    // --- Build advantages/disadvantages ---
    function buildProsCons(stats, other, name, otherName) {
        const pros = [], cons = [];
        // Accuracy
        if (stats.accA1 != null && other.accA1 != null) {
            if (stats.accA1 > other.accA1 + 0.005)
                pros.push('Meilleure pr\u00e9cision globale vs A1 (' + (stats.accA1 * 100).toFixed(1) + '% vs ' + (other.accA1 * 100).toFixed(1) + '%)');
            else if (stats.accA1 < other.accA1 - 0.005)
                cons.push('Pr\u00e9cision globale inf\u00e9rieure vs A1 (' + (stats.accA1 * 100).toFixed(1) + '% vs ' + (other.accA1 * 100).toFixed(1) + '%)');
        }
        // Per-stage precision — highlight stages with big differences
        for (const stage of stagesWithMetrics) {
            const precS = stats.perStageAccA1[stage];
            const precO = other.perStageAccA1[stage];
            if (precS != null && precO != null) {
                const d = precS - precO;
                if (d > 0.10)
                    pros.push('Bien meilleure pr\u00e9cision sur ' + stage + ' (' + (precS * 100).toFixed(1) + '% vs ' + (precO * 100).toFixed(1) + '%, +' + (d * 100).toFixed(0) + '%)');
                else if (d > 0.03)
                    pros.push('Meilleure pr\u00e9cision sur ' + stage + ' (' + (precS * 100).toFixed(1) + '% vs ' + (precO * 100).toFixed(1) + '%)');
                else if (d < -0.10)
                    cons.push('Pr\u00e9cision tr\u00e8s inf\u00e9rieure sur ' + stage + ' (' + (precS * 100).toFixed(1) + '% vs ' + (precO * 100).toFixed(1) + '%, ' + (d * 100).toFixed(0) + '%)');
                else if (d < -0.03)
                    cons.push('Pr\u00e9cision inf\u00e9rieure sur ' + stage + ' (' + (precS * 100).toFixed(1) + '% vs ' + (precO * 100).toFixed(1) + '%)');
            }
        }
        // Kappa
        if (stats.kappaIA_A1 != null && other.kappaIA_A1 != null) {
            if (stats.kappaIA_A1 > other.kappaIA_A1 + 0.01)
                pros.push('Meilleur accord Kappa vs A1 (' + stats.kappaIA_A1.toFixed(3) + ' vs ' + other.kappaIA_A1.toFixed(3) + ')');
            else if (stats.kappaIA_A1 < other.kappaIA_A1 - 0.01)
                cons.push('Accord Kappa inf\u00e9rieur vs A1 (' + stats.kappaIA_A1.toFixed(3) + ' vs ' + other.kappaIA_A1.toFixed(3) + ')');
        }
        // F1 stages — mention le support pour contextualiser
        for (const stage of stagesWithMetrics) {
            const mS = stats.metrics[stage];
            const mO = other.metrics[stage];
            if (mS && mO && mS.f1 != null && mO.f1 != null) {
                const supS = mS.support || 0;
                const supO = mO.support || 0;
                const supInfo = ' (' + supS + ' epochs)';
                if (mS.f1 > mO.f1 + 0.03) {
                    if (supS >= 10)
                        pros.push('Meilleur F1 sur ' + stage + ' (' + (mS.f1 * 100).toFixed(1) + '% vs ' + (mO.f1 * 100).toFixed(1) + '%)' + supInfo);
                    else
                        pros.push('F1 ' + stage + ' sup\u00e9rieur mais peu de donn\u00e9es' + supInfo);
                } else if (mS.f1 < mO.f1 - 0.03) {
                    if (supS >= 10)
                        cons.push('F1 inf\u00e9rieur sur ' + stage + ' (' + (mS.f1 * 100).toFixed(1) + '% vs ' + (mO.f1 * 100).toFixed(1) + '%)' + supInfo);
                    else
                        cons.push('F1 ' + stage + ' inf\u00e9rieur, mais peu de donn\u00e9es' + supInfo);
                }
                // Volume advantage: more correctly detected epochs
                if (supS > supO * 1.5 && supS >= 10 && Math.abs(mS.f1 - mO.f1) < 0.03)
                    pros.push('Plus d\'\u00e9pochs d\u00e9tect\u00e9es sur ' + stage + ' (' + supS + ' vs ' + supO + ') \u00e0 F1 comparable');
                else if (supO > supS * 1.5 && supO >= 10 && Math.abs(mS.f1 - mO.f1) < 0.03)
                    cons.push('Moins d\'\u00e9pochs d\u00e9tect\u00e9es sur ' + stage + ' (' + supS + ' vs ' + supO + ')');
            }
        }
        // Data retention
        const retA = stats.totalEpochsRaw > 0 ? stats.totalEpochs / stats.totalEpochsRaw : 1;
        const retB = other.totalEpochsRaw > 0 ? other.totalEpochs / other.totalEpochsRaw : 1;
        if (retA > retB + 0.05)
            pros.push('Plus de donn\u00e9es au-dessus du seuil (' + (retA * 100).toFixed(1) + '% vs ' + (retB * 100).toFixed(1) + '%)');
        else if (retA < retB - 0.05)
            cons.push('Moins de donn\u00e9es au-dessus du seuil (' + (retA * 100).toFixed(1) + '% vs ' + (retB * 100).toFixed(1) + '%)');
        // Confidence
        if (stats.avgConfidence > other.avgConfidence + 0.02)
            pros.push('Confiance moyenne sup\u00e9rieure (' + (stats.avgConfidence * 100).toFixed(1) + '%)');
        else if (stats.avgConfidence < other.avgConfidence - 0.02)
            cons.push('Confiance moyenne inf\u00e9rieure (' + (stats.avgConfidence * 100).toFixed(1) + '%)');
        // Speed
        return { pros, cons };
    }

    const pcA = buildProsCons(sA, sB, nameA, nameB);
    const pcB = buildProsCons(sB, sA, nameB, nameA);

    // --- Format threshold info ---
    const threshInfo = cmpState.confMode === 'individual'
        ? nameA + ' : ' + (thA * 100).toFixed(0) + '% / ' + nameB + ' : ' + (thB * 100).toFixed(0) + '%'
        : (thA * 100).toFixed(0) + '%';

    // --- Build HTML ---
    let html = '';

    // Score bar — basée sur globalScore relatif (-1 à +1)
    const barPct = ((globalScore + 1) / 2 * 100); // 0-100, 50 = tie
    const scoreColor = globalScore > margin ? '#22c55e' : globalScore < -margin ? '#3b82f6' : '#f59e0b';
    const verdictText = winner
        ? '<span style="color:' + scoreColor + ';font-weight:700;font-size:18px">' + winnerName + '</span> est globalement meilleur'
        : '<span style="color:#f59e0b;font-weight:700;font-size:18px">\u00C9galit\u00e9</span> \u2014 les deux algorithmes sont comparables';

    html += '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:20px;margin-bottom:16px;">';

    // Scores /100 en haut
    const scoreColorA = scoreA >= 80 ? '#22c55e' : scoreA >= 60 ? '#f59e0b' : '#ef4444';
    const scoreColorB = scoreB >= 80 ? '#22c55e' : scoreB >= 60 ? '#f59e0b' : '#ef4444';

    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">';
    // Score A — gauche
    html += '<div style="text-align:center;">';
    html += '<div style="font-size:13px;color:#22c55e;font-weight:600;margin-bottom:4px;">' + nameA + '</div>';
    html += '<div style="font-size:42px;font-weight:800;color:' + scoreColorA + ';line-height:1;">' + scoreA + '</div>';
    html += '<div style="font-size:12px;color:var(--text-secondary);">/ 100</div>';
    html += '</div>';
    // Verdict — centre
    html += '<div style="text-align:center;flex:1;">';
    html += '<div style="font-size:13px;color:var(--text-secondary);margin-bottom:6px;">Seuil de confiance : ' + threshInfo + '</div>';
    html += '<div style="margin-bottom:10px;">' + verdictText + '</div>';
    html += '</div>';
    // Score B — droite
    html += '<div style="text-align:center;">';
    html += '<div style="font-size:13px;color:#3b82f6;font-weight:600;margin-bottom:4px;">' + nameB + '</div>';
    html += '<div style="font-size:42px;font-weight:800;color:' + scoreColorB + ';line-height:1;">' + scoreB + '</div>';
    html += '<div style="font-size:12px;color:var(--text-secondary);">/ 100</div>';
    html += '</div>';
    html += '</div>';

    // Visual bar — vert à gauche, bleu à droite, curseur se déplace
    html += '<div style="position:relative;height:28px;background:#1e2330;border-radius:14px;overflow:hidden;max-width:500px;margin:0 auto;">';
    html += '<div style="position:absolute;left:0;top:0;height:100%;width:' + barPct.toFixed(1) + '%;background:#22c55e;border-radius:14px 0 0 14px;transition:width 0.4s;"></div>';
    html += '<div style="position:absolute;right:0;top:0;height:100%;width:' + (100 - barPct).toFixed(1) + '%;background:#3b82f6;border-radius:0 14px 14px 0;transition:width 0.4s;"></div>';
    html += '<div style="position:absolute;left:50%;top:0;width:2px;height:100%;background:rgba(255,255,255,0.3);transform:translateX(-1px);"></div>';
    html += '<div style="position:absolute;left:8px;top:50%;transform:translateY(-50%);font-size:11px;color:#fff;font-weight:600;">' + nameA + '</div>';
    html += '<div style="position:absolute;right:8px;top:50%;transform:translateY(-50%);font-size:11px;color:#fff;font-weight:600;">' + nameB + '</div>';
    html += '</div>';
    html += '</div>';

    // Criteria table
    html += '<table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:16px;">';
    html += '<tr style="border-bottom:1px solid var(--border);">';
    html += '<th style="text-align:left;padding:6px 8px;color:var(--text-secondary);">Crit\u00e8re</th>';
    html += '<th style="text-align:center;padding:6px 8px;color:var(--text-secondary);">Poids</th>';
    html += '<th style="text-align:center;padding:6px 8px;color:#22c55e;">' + nameA + '</th>';
    html += '<th style="text-align:center;padding:6px 8px;color:#3b82f6;">' + nameB + '</th>';
    html += '<th style="text-align:center;padding:6px 8px;color:var(--text-secondary);">Avantage</th>';
    html += '</tr>';

    for (const c of criteria) {
        const aWins = c.higherBetter ? c.diff > 0.002 : c.diff < -0.002;
        const bWins = c.higherBetter ? c.diff < -0.002 : c.diff > 0.002;
        const advColor = aWins ? '#22c55e' : bWins ? '#3b82f6' : '#9aa0a6';
        const advText = aWins ? nameA : bWins ? nameB : '\u2014';
        const maxW = 5;
        const weightDots = '\u2B24'.repeat(c.weight) + '<span style="opacity:0.2">' + '\u2B24'.repeat(maxW - c.weight) + '</span>';

        html += '<tr style="border-bottom:1px solid rgba(255,255,255,0.05);">';
        html += '<td style="padding:6px 8px;color:var(--text-primary);">' + c.name + '</td>';
        html += '<td style="text-align:center;padding:6px 8px;font-size:8px;color:#f59e0b;">' + weightDots + '</td>';
        html += '<td style="text-align:center;padding:6px 8px;' + (aWins ? 'color:#22c55e;font-weight:600' : 'color:var(--text-secondary)') + '">' + c.valA + '</td>';
        html += '<td style="text-align:center;padding:6px 8px;' + (bWins ? 'color:#3b82f6;font-weight:600' : 'color:var(--text-secondary)') + '">' + c.valB + '</td>';
        html += '<td style="text-align:center;padding:6px 8px;color:' + advColor + ';font-weight:600;">' + advText + '</td>';
        html += '</tr>';
    }
    html += '</table>';
    html += '</div>';

    // --- Pros / Cons cards ---
    html += '<div style="display:flex;gap:16px;flex-wrap:wrap;">';

    function prosConsCard(name, color, pc) {
        let card = '<div style="flex:1;min-width:280px;background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:20px;">';
        card += '<h3 style="margin:0 0 12px;color:' + color + ';">' + name + '</h3>';
        if (pc.pros.length > 0) {
            card += '<div style="margin-bottom:10px;"><span style="color:#22c55e;font-weight:600;font-size:12px;">AVANTAGES</span></div>';
            for (const p of pc.pros) {
                card += '<div style="padding:4px 0 4px 16px;color:var(--text-primary);font-size:13px;border-left:2px solid #22c55e;margin-bottom:4px;">' + p + '</div>';
            }
        }
        if (pc.cons.length > 0) {
            card += '<div style="margin:10px 0;"><span style="color:#ef4444;font-weight:600;font-size:12px;">INCONVENIENTS</span></div>';
            for (const c of pc.cons) {
                card += '<div style="padding:4px 0 4px 16px;color:var(--text-primary);font-size:13px;border-left:2px solid #ef4444;margin-bottom:4px;">' + c + '</div>';
            }
        }
        if (pc.pros.length === 0 && pc.cons.length === 0) {
            card += '<div style="color:var(--text-secondary);font-size:13px;">Aucune diff\u00e9rence notable d\u00e9tect\u00e9e.</div>';
        }
        card += '</div>';
        return card;
    }

    html += prosConsCard(nameA, '#22c55e', pcA);
    html += prosConsCard(nameB, '#3b82f6', pcB);
    html += '</div>';

    // --- Per-stage verdict ---
    html += '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:20px;margin-top:16px;">';
    html += '<h3 style="margin:0 0 4px;color:var(--text-primary);">Verdict par stade</h3>';
    html += '<div style="font-size:11px;color:var(--text-secondary);margin-bottom:12px;">Score = F1 \u00d7 log\u2082(1 + nb epochs) \u2014 un bon F1 sur beaucoup d\'\u00e9pochs p\u00e8se plus</div>';
    html += '<div style="display:flex;gap:10px;flex-wrap:wrap;">';
    for (const stage of stagesWithMetrics) {
        const sw = stageWinners[stage];
        const sd = stageDetails[stage];
        const stageColor = (typeof STAGE_COLORS !== 'undefined' && STAGE_COLORS[stage]) ? STAGE_COLORS[stage] : '#9aa0a6';
        const mA = sA.metrics[stage];
        const mB = sB.metrics[stage];
        const f1A = mA && mA.f1 != null ? (mA.f1 * 100).toFixed(1) + '%' : 'N/A';
        const f1B = mB && mB.f1 != null ? (mB.f1 * 100).toFixed(1) + '%' : 'N/A';
        const supA = sd ? sd.supA : 0;
        const supB = sd ? sd.supB : 0;
        const bgColor = sw === nameA ? 'rgba(34,197,94,0.1)' : sw === nameB ? 'rgba(59,130,246,0.1)' : 'rgba(255,255,255,0.03)';
        const borderColor = sw === nameA ? '#22c55e' : sw === nameB ? '#3b82f6' : 'var(--border)';
        html += '<div style="flex:1;min-width:130px;background:' + bgColor + ';border:1px solid ' + borderColor + ';border-radius:8px;padding:12px;text-align:center;">';
        html += '<div style="font-weight:600;color:' + stageColor + ';margin-bottom:4px;">' + stage + '</div>';
        html += '<div style="font-size:12px;color:var(--text-secondary);">F1 : ' + f1A + ' / ' + f1B + '</div>';
        html += '<div style="font-size:11px;color:var(--text-secondary);">Epochs : ' + supA + ' / ' + supB + '</div>';
        html += '<div style="font-size:11px;margin-top:4px;font-weight:600;color:' + borderColor + ';">' + (sw || '\u00C9gal') + '</div>';
        html += '</div>';
    }
    html += '</div></div>';

    // --- Final recommendation ---
    html += '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:20px;margin-top:16px;">';
    html += '<h3 style="margin:0 0 10px;color:var(--text-primary);">Recommandation</h3>';
    html += '<div style="color:var(--text-primary);font-size:14px;line-height:1.6;">';

    if (winner) {
        const winScore = winner === sA ? scoreA : scoreB;
        const loseScore = winner === sA ? scoreB : scoreA;
        const stageWins = Object.values(stageWinners).filter(w => w === winnerName).length;
        const stageTies = Object.values(stageWinners).filter(w => w === null).length;
        const stageLosses = Object.values(stageWinners).filter(w => w === loserName).length;

        html += '<strong style="color:' + scoreColor + ';">' + winnerName + '</strong> obtient un score de <strong>' + winScore + '/100</strong> ';
        html += 'contre <strong>' + loseScore + '/100</strong> pour ' + loserName + ' (+ ' + (winScore - loseScore) + ' pts). ';
        html += 'Sur les ' + stagesWithMetrics.length + ' stades, <strong>' + winnerName + '</strong> domine sur ';
        html += '<strong>' + stageWins + '</strong> stade' + (stageWins > 1 ? 's' : '');
        if (stageTies > 0) html += ', est \u00e0 \u00e9galit\u00e9 sur <strong>' + stageTies + '</strong>';
        if (stageLosses > 0) html += ' et est inf\u00e9rieur sur <strong>' + stageLosses + '</strong>';
        html += '.';

        // Data volume comment
        const retWinner = winner.totalEpochsRaw > 0 ? winner.totalEpochs / winner.totalEpochsRaw : 1;
        const retLoser = loser.totalEpochsRaw > 0 ? loser.totalEpochs / loser.totalEpochsRaw : 1;
        if (retWinner > retLoser + 0.05) {
            html += ' De plus, <strong>' + winnerName + '</strong> conserve davantage de donn\u00e9es au-dessus du seuil de confiance ';
            html += '(' + (retWinner * 100).toFixed(1) + '% vs ' + (retLoser * 100).toFixed(1) + '%), ce qui renforce sa fiabilit\u00e9.';
        } else if (retLoser > retWinner + 0.05) {
            html += ' Cependant, <strong>' + loserName + '</strong> conserve davantage de donn\u00e9es au-dessus du seuil ';
            html += '(' + (retLoser * 100).toFixed(1) + '% vs ' + (retWinner * 100).toFixed(1) + '%), ';
            html += 'ce qui peut \u00eatre un avantage en conditions r\u00e9elles.';
        }
    } else {
        html += 'Les deux algorithmes pr\u00e9sentent des <strong>performances comparables</strong> au seuil de confiance actuel. ';
        html += 'Essayez de modifier le seuil de confiance pour r\u00e9v\u00e9ler des diff\u00e9rences plus marqu\u00e9es.';
    }

    html += '</div></div>';

    el.innerHTML = html;
  } catch (err) {
    el.innerHTML = '<div style="color:#ef4444;padding:20px;">Erreur synthèse : ' + err.message + '<br><pre>' + err.stack + '</pre></div>';
  }
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

    // Effacer un seul algo
    document.getElementById('cmpClearA').addEventListener('click', function () {
        cmpState.sidesData.A = [];
        document.getElementById('cmpCountA').textContent = '0 fichiers';
        cmpShowSections();
        if (cmpState.sidesData.B.length > 0 && cmpState.sidesData.A.length > 0) cmpRefreshAll();
        cmpSaveToIDB();
    });
    document.getElementById('cmpClearB').addEventListener('click', function () {
        cmpState.sidesData.B = [];
        document.getElementById('cmpCountB').textContent = '0 fichiers';
        cmpShowSections();
        if (cmpState.sidesData.A.length > 0 && cmpState.sidesData.B.length > 0) cmpRefreshAll();
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
