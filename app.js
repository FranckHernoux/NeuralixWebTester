/**
 * Neuralix Web Tester - Application principale
 *
 * Streaming de donnees EOG vers ESP32-S3 via Web Serial API
 * Affichage comparatif avec annotations
 *
 * Protocole ESP32:
 *   Envoi: #SERIAL, #RESET, #ADC, valeurs numeriques
 *   Reception: @ACK:*, @PRED:{json}, @PROGRESS:n/total, @ERR:*, @INFO:*
 */

// ============================================================================
// Constantes
// ============================================================================

const CHUNK_SIZE = 7680;    // Échantillons par epoch (30s @ 256Hz)
const SAMPLE_RATE = 256;
const STAGE_NAMES = ['Wake', 'N1', 'N2', 'N3', 'REM'];
const STAGE_LABELS = [0, 1, 2, 3, 5]; // Label original pour REM = 5
const STAGE_COLORS = {
    'Wake': '#ef4444', 'W': '#ef4444', '0': '#ef4444',
    'N1':   '#f59e0b', '1': '#f59e0b',
    'N2':   '#3b82f6', '2': '#3b82f6',
    'N3':   '#6366f1', '3': '#6366f1',
    'REM':  '#22c55e', 'R': '#22c55e', '5': '#22c55e', '4': '#22c55e'
};

// Filtres de statistiques
const STATS_FILTERS = {
    'all':           { label: 'Tous (aucun filtre)',            fn: () => true },
    'a1_vs_ia':      { label: 'Annoteur 1 vs IA',              fn: p => p.annot1 !== null },
    'a2_vs_ia':      { label: 'Annoteur 2 vs IA',              fn: p => p.annot2 !== null },
    'a1_eq_a2':      { label: 'Annoteurs unanimes vs IA',      fn: p => p.annot1 !== null && p.annot2 !== null && p.annot1 === p.annot2 },
    'a1_ne_a2':      { label: 'Annoteurs en désaccord',        fn: p => p.annot1 !== null && p.annot2 !== null && p.annot1 !== p.annot2 },
    'ia_ok_a1':      { label: 'IA correcte (vs Annot. 1)',     fn: p => p.matchA1 === true },
    'ia_ko_a1':      { label: 'IA incorrecte (vs Annot. 1)',   fn: p => p.matchA1 === false },
    'ia_ok_a2':      { label: 'IA correcte (vs Annot. 2)',     fn: p => p.matchA2 === true },
    'ia_ko_a2':      { label: 'IA incorrecte (vs Annot. 2)',   fn: p => p.matchA2 === false },
    'ia_consensus':  { label: 'IA = consensus annoteurs',      fn: p => p.annot1 !== null && p.annot2 !== null && p.annot1 === p.annot2 && p.name === p.annot1 },
    'ia_no_consensus': { label: 'IA != consensus annoteurs',   fn: p => p.annot1 !== null && p.annot2 !== null && p.annot1 === p.annot2 && p.name !== p.annot1 },
    'all_disagree':  { label: 'Aucun accord (3 differents)',   fn: p => p.annot1 !== null && p.annot2 !== null && p.annot1 !== p.annot2 && p.name !== p.annot1 && p.name !== p.annot2 },
};

// ============================================================================
// Web Worker pour calculs lourds
// ============================================================================

let _computeWorker = null;
let _workerCallbacks = {};
let _workerIdCounter = 0;

function _getComputeWorker() {
    if (!_computeWorker && typeof Worker !== 'undefined') {
        try {
            _computeWorker = new Worker('compute-worker.js');
            _computeWorker.onmessage = function(e) {
                const { id, result, error } = e.data;
                const cb = _workerCallbacks[id];
                if (cb) {
                    delete _workerCallbacks[id];
                    if (error) cb.reject(new Error(error));
                    else cb.resolve(result);
                }
            };
            _computeWorker.onerror = function(err) {
                console.warn('Compute worker error:', err);
            };
        } catch (e) {
            console.warn('Web Worker not available, using main thread:', e);
        }
    }
    return _computeWorker;
}

function _workerTask(type, data) {
    return new Promise((resolve, reject) => {
        const worker = _getComputeWorker();
        if (!worker) { reject(new Error('no worker')); return; }
        const id = ++_workerIdCounter;
        _workerCallbacks[id] = { resolve, reject };
        worker.postMessage({ type, id, data });
    });
}

// ============================================================================
// FFT (Cooley-Tukey radix-2) + Analyse frequentielle
// ============================================================================

function fft(re, im) {
    const n = re.length;
    if (n <= 1) return;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            [re[i], re[j]] = [re[j], re[i]];
            [im[i], im[j]] = [im[j], im[i]];
        }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const angle = -2 * Math.PI / len;
        const wRe = Math.cos(angle), wIm = Math.sin(angle);
        for (let i = 0; i < n; i += len) {
            let curRe = 1, curIm = 0;
            for (let j = 0; j < len / 2; j++) {
                const tRe = curRe * re[i + j + len/2] - curIm * im[i + j + len/2];
                const tIm = curRe * im[i + j + len/2] + curIm * re[i + j + len/2];
                re[i + j + len/2] = re[i + j] - tRe;
                im[i + j + len/2] = im[i + j] - tIm;
                re[i + j] += tRe;
                im[i + j] += tIm;
                const tmp = curRe * wRe - curIm * wIm;
                curIm = curRe * wIm + curIm * wRe;
                curRe = tmp;
            }
        }
    }
}

function computePowerSpectrum(signal) {
    const N = 8192;           // taille de chaque segment FFT
    const halfN = N / 2;
    const hop = N / 2;        // 50% overlap (Welch)

    // Pre-calculer la fenetre de Hann
    const win = new Float64Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)));

    const avgPower = new Float64Array(halfN);  // accumulation lineaire
    let nSegments = 0;

    for (let start = 0; start + N <= signal.length; start += hop) {
        const re = new Float64Array(N);
        const im = new Float64Array(N);
        for (let i = 0; i < N; i++) re[i] = signal[start + i] * win[i];
        fft(re, im);
        for (let i = 0; i < halfN; i++) {
            avgPower[i] += (re[i] * re[i] + im[i] * im[i]) / (N * N);
        }
        nSegments++;
    }

    // Si le signal est trop court pour un segment complet, zero-pad
    if (nSegments === 0) {
        const re = new Float64Array(N);
        const im = new Float64Array(N);
        const len = Math.min(signal.length, N);
        for (let i = 0; i < len; i++) re[i] = signal[i] * win[i];
        fft(re, im);
        for (let i = 0; i < halfN; i++) {
            avgPower[i] = (re[i] * re[i] + im[i] * im[i]) / (N * N);
        }
        nSegments = 1;
    }

    const freqs = new Float64Array(halfN);
    const power = new Float64Array(halfN);
    for (let i = 0; i < halfN; i++) {
        freqs[i] = i * SAMPLE_RATE / N;
        power[i] = 10 * Math.log10(Math.max(avgPower[i] / nSegments, 1e-20)); // PSD en dB
    }
    return { freqs, power };
}

const FREQ_BANDS = [
    { name: 'Delta', lo: 0.5, hi: 4,  color: 'rgba(138,43,226,0.15)',  border: '#8a2be2' },
    { name: 'Theta', lo: 4,   hi: 8,  color: 'rgba(0,191,255,0.15)',   border: '#00bfff' },
    { name: 'Alpha', lo: 8,   hi: 13, color: 'rgba(50,205,50,0.15)',   border: '#32cd32' },
    { name: 'Beta',  lo: 13,  hi: 30, color: 'rgba(255,165,0,0.15)',   border: '#ffa500' },
];

function _drawSpectrum(canvas, spec, color, label) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const rect = canvas.parentElement.getBoundingClientRect();
    if (rect.width < 50) return;
    canvas.width = rect.width;
    canvas.height = 280;

    const w = canvas.width, h = canvas.height;
    const margin = { top: 20, bottom: 30, left: 50, right: 15 };
    const plotW = w - margin.left - margin.right;
    const plotH = h - margin.top - margin.bottom;

    ctx.fillStyle = '#2a2f38';
    ctx.fillRect(0, 0, w, h);

    const maxFreq = 60;
    const maxIdx = Math.ceil(maxFreq * 8192 / SAMPLE_RATE);

    let minDb = Infinity, maxDb = -Infinity;
    for (let i = 1; i < maxIdx && i < spec.power.length; i++) {
        if (spec.power[i] < minDb) minDb = spec.power[i];
        if (spec.power[i] > maxDb) maxDb = spec.power[i];
    }
    const dbRange = (maxDb - minDb) || 1;
    minDb -= dbRange * 0.05;
    maxDb += dbRange * 0.05;
    const totalDb = maxDb - minDb;

    for (const band of FREQ_BANDS) {
        const x1 = margin.left + (band.lo / maxFreq) * plotW;
        const x2 = margin.left + (Math.min(band.hi, maxFreq) / maxFreq) * plotW;
        ctx.fillStyle = band.color;
        ctx.fillRect(x1, margin.top, x2 - x1, plotH);
    }

    ctx.strokeStyle = '#3a3f4a';
    ctx.lineWidth = 0.5;
    ctx.fillStyle = '#6b7280';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    const nGridY = 5;
    for (let i = 0; i <= nGridY; i++) {
        const db = maxDb - (i / nGridY) * totalDb;
        const y = margin.top + (i / nGridY) * plotH;
        ctx.beginPath();
        ctx.moveTo(margin.left, y);
        ctx.lineTo(w - margin.right, y);
        ctx.stroke();
        ctx.fillText(db.toFixed(0) + ' dB', margin.left - 4, y + 3);
    }

    ctx.textAlign = 'center';
    const freqTicks = [0, 4, 8, 13, 20, 30, 40, 50, 60];
    for (const f of freqTicks) {
        if (f > maxFreq) break;
        const x = margin.left + (f / maxFreq) * plotW;
        ctx.beginPath();
        ctx.strokeStyle = '#3a3f4a';
        ctx.moveTo(x, margin.top);
        ctx.lineTo(x, margin.top + plotH);
        ctx.stroke();
        ctx.fillStyle = '#6b7280';
        ctx.fillText(f + ' Hz', x, h - 8);
    }

    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    for (let i = 1; i < maxIdx && i < spec.power.length; i++) {
        const x = margin.left + (spec.freqs[i] / maxFreq) * plotW;
        const y = margin.top + ((maxDb - spec.power[i]) / totalDb) * plotH;
        if (i === 1) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.fillStyle = '#9aa0a6';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(label + ' — Epoch ' + (state.currentEpoch + 1), margin.left + 4, margin.top - 6);
}

function _drawSpectrumEmpty(canvas, msg) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const rect = canvas.parentElement.getBoundingClientRect();
    if (rect.width < 50) return;
    canvas.width = rect.width;
    canvas.height = 280;
    ctx.fillStyle = '#2a2f38';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#6b7280';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(msg, canvas.width / 2, canvas.height / 2);
}

function drawFrequencyAnalysis() {
    const canvasBrut = document.getElementById('freqCanvasBrut');
    const canvasFiltre = document.getElementById('freqCanvasFiltre');
    if (!canvasBrut) return;

    // Tente d'utiliser le Web Worker pour le calcul FFT
    const worker = _getComputeWorker();

    if (worker && state.fullNightEog && state.fullNightEog.length > 0) {
        _workerTask('powerSpectrum', { signal: Array.from(state.fullNightEog), sampleRate: SAMPLE_RATE })
            .then(spec => _drawSpectrum(canvasBrut, spec, '#4a9eff', 'EOG brut'))
            .catch(() => {
                const spec = computePowerSpectrum(state.fullNightEog);
                _drawSpectrum(canvasBrut, spec, '#4a9eff', 'EOG brut');
            });
    } else if (state.fullNightEog && state.fullNightEog.length > 0) {
        const spec = computePowerSpectrum(state.fullNightEog);
        _drawSpectrum(canvasBrut, spec, '#4a9eff', 'EOG brut');
    } else {
        _drawSpectrumEmpty(canvasBrut, 'Aucune donnée brute');
    }

    if (worker && canvasFiltre && state.fullNightEogFiltre && state.fullNightEogFiltre.length > 0) {
        _workerTask('powerSpectrum', { signal: Array.from(state.fullNightEogFiltre), sampleRate: SAMPLE_RATE })
            .then(spec => _drawSpectrum(canvasFiltre, spec, '#f59e0b', 'EOG filtre'))
            .catch(() => {
                const spec = computePowerSpectrum(state.fullNightEogFiltre);
                _drawSpectrum(canvasFiltre, spec, '#f59e0b', 'EOG filtre');
            });
    } else if (canvasFiltre && state.fullNightEogFiltre && state.fullNightEogFiltre.length > 0) {
        const spec = computePowerSpectrum(state.fullNightEogFiltre);
        _drawSpectrum(canvasFiltre, spec, '#f59e0b', 'EOG filtre');
    } else if (canvasFiltre) {
        _drawSpectrumEmpty(canvasFiltre, 'Aucune donnée filtrée');
    }
}

// ============================================================================
// Etat global
// ============================================================================

const state = {
    // Serial
    port: null,
    reader: null,
    writer: null,
    connected: false,

    // Donnees chargees (streaming - jamais tout en RAM)
    fileRef: null,          // Reference au fichier File (pour streaming)
    fileConfig: null,       // Configuration detectee {separator, eogCol, ...}
    currentEpochData: [],   // Donnees de l'epoch courante (pour canvas)
    annotations1: [],       // Annotations annotateur 1 (par epoch, remplies au fur et a mesure)
    annotations2: [],       // Annotations annotateur 2 (par epoch, remplies au fur et a mesure)
    totalEpochs: 0,

    // Streaming
    running: false,
    paused: false,
    currentEpoch: 0,
    speed: 0,

    // Resultats
    predictions: [],    // Resultats ESP32 [{epoch, class, name, confidence, probs, time_ms}]
    matchesA1: 0,
    matchesA2: 0,
    totalCompared: 0,
    totalTimeMs: 0,

    // Filtres
    statsFilter: 'all',           // cle dans STATS_FILTERS
    confidenceThreshold: 60,      // en %

    // Zoom hypnogramme
    hypnoZoom: { start: 0, end: null },  // null = vue complete

    // Signal nuit complete
    fullNightEog: null,         // Float32Array du signal EOG brut (ou null)
    fullNightEogFiltre: null,   // Float32Array du signal EOG filtre (ou null)
    fullNightLoading: false,
    fnView: { startSample: 0, visibleSamples: 0 },  // vue courante (zoom/scroll)
    fnZoomLevel: 1,             // 1 = vue complete
    fnShowBrut: true,           // afficher le signal brut
    fnShowFiltre: false,        // afficher le signal filtre
    fnDisplayMode: 'separate',  // 'separate' ou 'overlay'
    fnCanvasHeight: 250,        // hauteur du canvas nuit complete (redimensionnable)

    // Spectrogramme zoom
    spectroZoom: { startFrame: 0, endFrame: null },  // null = vue complete

    // Reception
    rxBuffer: '',
    waitingForPrediction: false,
    predictionResolve: null,
};

// ============================================================================
// Persistance (IndexedDB pour les donnees, localStorage pour les parametres)
// ============================================================================

const IDB_NAME = 'neuralix-webtester';
const IDB_VERSION = 1;
const IDB_STORE = 'session';
const LS_UI_KEY = 'neuralix-ui-params';
let _restoring = false;          // Guard: pas de sauvegarde pendant la restauration
let _restoredFileName = null;    // Nom du fichier restaure (pas de fileRef apres reload)
let _restoredFileSize = 0;

// Identifiant unique par onglet pour isoler les donnees IndexedDB
const _tabId = sessionStorage.getItem('neuralix-tab-id') || (() => {
    const id = crypto.randomUUID();
    sessionStorage.setItem('neuralix-tab-id', id);
    return id;
})();

function _openIDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(IDB_STORE))
                req.result.createObjectStore(IDB_STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });
}

async function _idbPut(key, value) {
    try {
        const db = await _openIDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).put(value, key);
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror    = () => { db.close(); reject(tx.error); };
        });
    } catch (e) { console.warn('IDB put:', e); }
}

async function _idbGet(key) {
    try {
        const db = await _openIDB();
        return new Promise((resolve, reject) => {
            const tx  = db.transaction(IDB_STORE, 'readonly');
            const req = tx.objectStore(IDB_STORE).get(key);
            req.onsuccess = () => { db.close(); resolve(req.result); };
            req.onerror   = () => { db.close(); reject(req.error); };
        });
    } catch (e) { console.warn('IDB get:', e); return undefined; }
}

async function _idbClear() {
    try {
        const db = await _openIDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).clear();
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror    = () => { db.close(); reject(tx.error); };
        });
    } catch (e) { console.warn('IDB clear:', e); }
}

/** Sauvegarde les signaux EOG dans IndexedDB. */
function saveEogToIDB() {
    if (_restoring) return;
    const data = {
        fileName: state.fileRef ? state.fileRef.name : _restoredFileName,
        fileSize: state.fileRef ? state.fileRef.size : _restoredFileSize,
        totalEpochs: state.totalEpochs,
        fileConfig: state.fileConfig,
    };
    if (state.fullNightEog) data.fullNightEog = state.fullNightEog.buffer.slice(0);
    if (state.fullNightEogFiltre) data.fullNightEogFiltre = state.fullNightEogFiltre.buffer.slice(0);
    _idbPut('eog-' + _tabId, data);
}

/** Construit l'objet predictions a sauvegarder. */
function _buildPredData() {
    return {
        predictions: state.predictions,
        annotations1: state.annotations1,
        annotations2: state.annotations2,
        matchesA1: state.matchesA1,
        matchesA2: state.matchesA2,
        totalCompared: state.totalCompared,
        totalTimeMs: state.totalTimeMs,
        currentEpoch: state.currentEpoch,
        currentEpochData: Array.from(state.currentEpochData || []),
    };
}

const LS_PRED_KEY = 'neuralix-predictions';

/**
 * Sauvegarde les predictions :
 *   - localStorage (synchrone, immediat) : fiable meme si la page se ferme
 *   - IndexedDB (async, debounced) : backup pour les gros volumes
 */
let _savePredTimer = null;
function savePredictionsToIDB() {
    if (_restoring) return;
    // Sauvegarde synchrone dans sessionStorage (isole par onglet)
    try { sessionStorage.setItem(LS_PRED_KEY, JSON.stringify(_buildPredData())); } catch (e) { }
    // Sauvegarde async dans IndexedDB (debounced pour performance pendant le streaming)
    if (_savePredTimer) clearTimeout(_savePredTimer);
    _savePredTimer = setTimeout(() => {
        _savePredTimer = null;
        _idbPut('predictions-' + _tabId, _buildPredData());
    }, 500);
}

/** Sauvegarde les parametres UI dans localStorage (debounced 300ms). */
let _saveUITimer = null;
function saveUIParams() {
    if (_restoring) return;
    if (_saveUITimer) clearTimeout(_saveUITimer);
    _saveUITimer = setTimeout(() => {
        _saveUITimer = null;
        try {
            sessionStorage.setItem(LS_UI_KEY, JSON.stringify({
                fnShowBrut: state.fnShowBrut,
                fnShowFiltre: state.fnShowFiltre,
                fnDisplayMode: state.fnDisplayMode,
                fnCanvasHeight: state.fnCanvasHeight,
                fnZoomLevel: state.fnZoomLevel,
                fnViewStart: state.fnView.startSample,
                fnViewVisible: state.fnView.visibleSamples,
                statsFilter: state.statsFilter,
                confidenceThreshold: state.confidenceThreshold,
                hypnoZoom: state.hypnoZoom,
                speed: state.speed,
            }));
        } catch (e) { }
    }, 300);
}

/** Restaure l'etat depuis IndexedDB + localStorage au chargement. Retourne true si des donnees ont ete trouvees. */
async function restoreFromStorage() {
    _restoring = true;

    // 1. Parametres UI depuis sessionStorage
    try {
        const raw = sessionStorage.getItem(LS_UI_KEY);
        if (raw) {
            const p = JSON.parse(raw);
            if (p.fnShowBrut !== undefined) state.fnShowBrut = p.fnShowBrut;
            if (p.fnShowFiltre !== undefined) state.fnShowFiltre = p.fnShowFiltre;
            if (p.fnDisplayMode) state.fnDisplayMode = p.fnDisplayMode;
            if (p.fnCanvasHeight) state.fnCanvasHeight = p.fnCanvasHeight;
            if (p.statsFilter) state.statsFilter = p.statsFilter;
            if (p.confidenceThreshold !== undefined) state.confidenceThreshold = p.confidenceThreshold;
            if (p.hypnoZoom) state.hypnoZoom = p.hypnoZoom;
            if (p.speed !== undefined) state.speed = p.speed;
        }
    } catch (e) { }

    // 2. Appliquer les parametres UI au DOM
    _applyUIParamsToDOM();

    // 3. Donnees EOG depuis IndexedDB
    const eog = await _idbGet('eog-' + _tabId);
    if (eog) {
        if (eog.fullNightEog) state.fullNightEog = new Float32Array(eog.fullNightEog);
        if (eog.fullNightEogFiltre) state.fullNightEogFiltre = new Float32Array(eog.fullNightEogFiltre);
        state.totalEpochs = eog.totalEpochs || 0;
        state.fileConfig = eog.fileConfig || null;
        _restoredFileName = eog.fileName || null;
        _restoredFileSize = eog.fileSize || 0;

        if (eog.fileName) {
            document.getElementById('fileName').textContent =
                `${eog.fileName} (${formatFileSize(eog.fileSize || 0)}, ~${state.totalEpochs} epochs)`;
        }

        // Restaurer la vue du signal nuit complete
        try {
            const raw = sessionStorage.getItem(LS_UI_KEY);
            if (raw) {
                const p = JSON.parse(raw);
                if (p.fnZoomLevel) state.fnZoomLevel = p.fnZoomLevel;
                if (p.fnViewStart !== undefined) state.fnView.startSample = p.fnViewStart;
                if (p.fnViewVisible !== undefined) state.fnView.visibleSamples = p.fnViewVisible;
            }
        } catch (e) { }

        const refData = state.fullNightEog || state.fullNightEogFiltre;
        if (refData && state.fnView.visibleSamples === 0) {
            state.fnView.visibleSamples = refData.length;
            state.fnZoomLevel = 1;
        }
    }

    // 4. Predictions + epoch courante depuis sessionStorage (rapide) ou IndexedDB (fallback)
    let pred = null;
    try {
        const lsRaw = sessionStorage.getItem(LS_PRED_KEY);
        if (lsRaw) pred = JSON.parse(lsRaw);
    } catch (e) { }
    if (!pred) {
        pred = await _idbGet('predictions-' + _tabId);
    }
    if (pred) {
        if (pred.predictions?.length > 0) {
            state.predictions = pred.predictions;
            state.matchesA1 = pred.matchesA1 || 0;
            state.matchesA2 = pred.matchesA2 || 0;
            state.totalCompared = pred.totalCompared || 0;
            state.totalTimeMs = pred.totalTimeMs || 0;
            for (const r of state.predictions) {
                if (r.matchA1 === undefined) r.matchA1 = r.annot1 ? (r.name === r.annot1) : null;
                if (r.matchA2 === undefined) r.matchA2 = r.annot2 ? (r.name === r.annot2) : null;
            }
        }
        if (pred.annotations1?.length > 0) state.annotations1 = pred.annotations1;
        if (pred.annotations2?.length > 0) state.annotations2 = pred.annotations2;
        // Reconstruire annotations si absentes (stockage V3-RT met annot1/annot2 dans predictions)
        if (state.annotations1.length === 0 && state.predictions.length > 0) {
            state.annotations1 = state.predictions.map(p => p.annot1 || null);
        }
        if (state.annotations2.length === 0 && state.predictions.length > 0) {
            state.annotations2 = state.predictions.map(p => p.annot2 || null);
        }
        if (pred.currentEpoch) state.currentEpoch = pred.currentEpoch;
        if (pred.currentEpochData?.length > 0) state.currentEpochData = pred.currentEpochData;
    }

    // 5. Mettre a jour l'UI si des donnees ont ete restaurees
    const hasData = state.predictions.length > 0 || state.currentEpochData.length > 0
                 || state.fullNightEog != null || state.fullNightEogFiltre != null;
    if (hasData) {
        rebuildHistoryTable();
        updateStats();
        updateFilteredStats();
        updateHypnoZoomUI();
        updateControls();
        updateFnCheckboxes();
        updateFullNightSlider();

        // Restaurer le nom du fichier dans le panneau principal
        if (_restoredFileName && !state.fileRef) {
            const fnEl = document.getElementById('fileName');
            if (fnEl) {
                const nEpochs = state.fullNightEog
                    ? Math.floor(state.fullNightEog.length / CHUNK_SIZE)
                    : state.totalEpochs || '?';
                fnEl.textContent = `${_restoredFileName} (~${nEpochs} epochs, en mémoire)`;
            }
        }

        // Restaurer les indicateurs de l'onglet analyse
        if (_restoredFileName) {
            const analysisDataName = document.getElementById('analysisDataName');
            if (analysisDataName && (state.fullNightEog || state.fullNightEogFiltre)) {
                analysisDataName.textContent = _restoredFileName;
            }
            const analysisJsonName = document.getElementById('analysisJsonName');
            if (analysisJsonName && state.predictions.length > 0) {
                analysisJsonName.textContent = _restoredFileName + ' (session restaurée)';
            }
        }
        // Masquer le hint analyse si le signal est disponible
        const analysisHint = document.getElementById('analysisHint');
        if (analysisHint) {
            if (state.fullNightEog || state.fullNightEogFiltre) {
                analysisHint.style.display = 'none';
            } else if (state.predictions.length > 0) {
                analysisHint.style.display = 'block';
                analysisHint.textContent = 'Signal EOG (nuit complète) non disponible. '
                    + 'Chargez le fichier de données correspondant pour afficher le signal.';
            }
        }

        log(`Session restauree: ${state.predictions.length} predictions`, 'info');
    }

    _restoring = false;

    // Notifier la sidebar si des donnees sont disponibles au demarrage
    if (hasData) {
        if (typeof window.sidebarNotifyRealtimeData === 'function') {
            window.sidebarNotifyRealtimeData(true);
        }
        if (typeof window.sidebarNotifyAnalysisData === 'function') {
            window.sidebarNotifyAnalysisData(true);
        }
    }

    return hasData;
}

/** Applique les parametres d'etat aux elements du DOM. */
function _applyUIParamsToDOM() {
    const cbBrut = document.getElementById('fnShowBrut');
    const cbFiltre = document.getElementById('fnShowFiltre');
    if (cbBrut) cbBrut.checked = state.fnShowBrut;
    if (cbFiltre) cbFiltre.checked = state.fnShowFiltre;

    if (state.fnDisplayMode === 'overlay') {
        document.getElementById('fnModeOverlay')?.classList.add('fn-mode-active');
        document.getElementById('fnModeSeparate')?.classList.remove('fn-mode-active');
    } else {
        document.getElementById('fnModeSeparate')?.classList.add('fn-mode-active');
        document.getElementById('fnModeOverlay')?.classList.remove('fn-mode-active');
    }

    const filterSelect = document.getElementById('statsFilterSelect');
    if (filterSelect) filterSelect.value = state.statsFilter;

    const slider = document.getElementById('confidenceSlider');
    const input = document.getElementById('confidenceInput');
    if (slider) slider.value = state.confidenceThreshold;
    if (input) input.value = state.confidenceThreshold;

    const speedSelect = document.getElementById('speedSelect');
    if (speedSelect && state.speed) speedSelect.value = state.speed;
}

/** Efface les donnees persistees de l'onglet analyse (sans toucher multifile/comparative). */
async function clearPersistedData() {
    try {
        const db = await _openIDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            const store = tx.objectStore(IDB_STORE);
            store.delete('eog-' + _tabId);
            store.delete('predictions-' + _tabId);
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror    = () => { db.close(); reject(tx.error); };
        });
    } catch (e) { console.warn('clearPersistedData:', e); }
    try { sessionStorage.removeItem(LS_UI_KEY); } catch (e) { }
    try { sessionStorage.removeItem(LS_PRED_KEY); } catch (e) { }
    _restoredFileName = null;
    _restoredFileSize = 0;
}

// ============================================================================
// Logging
// ============================================================================

function log(msg, type = 'info') {
    const console = document.getElementById('logConsole');
    const entry = document.createElement('div');
    entry.className = `log-entry log-${type}`;
    const time = new Date().toLocaleTimeString('fr-FR', { hour12: false });
    entry.textContent = `[${time}] ${msg}`;
    console.appendChild(entry);
    console.scrollTop = console.scrollHeight;

    // Limiter a 500 lignes
    while (console.children.length > 500) {
        console.removeChild(console.firstChild);
    }
}

// ============================================================================
// Web Serial API
// ============================================================================

async function connectSerial() {
    if (!('serial' in navigator)) {
        alert('Web Serial API non supportee.\nUtilisez Chrome ou Edge (version 89+).');
        return;
    }

    try {
        state.port = await navigator.serial.requestPort();
        await state.port.open({ baudRate: 115200 });

        state.connected = true;
        updateConnectionUI(true);
        updateControls();
        log('Port serie connecte', 'info');

        // Demarrer la lecture
        startReading();

        // Passer l'ESP32 en mode serial
        await sendCommand('#SERIAL');

    } catch (err) {
        log(`Erreur connexion: ${err.message}`, 'error');
    }
}

async function disconnectSerial() {
    try {
        state.running = false;

        if (state.reader) {
            await state.reader.cancel();
            state.reader = null;
        }

        if (state.writer) {
            state.writer.releaseLock();
            state.writer = null;
        }

        if (state.port) {
            await state.port.close();
            state.port = null;
        }

        state.connected = false;
        updateConnectionUI(false);
        updateControls();
        log('Deconnecte', 'info');

    } catch (err) {
        log(`Erreur deconnexion: ${err.message}`, 'error');
        state.connected = false;
        updateConnectionUI(false);
        updateControls();
    }
}

async function startReading() {
    const decoder = new TextDecoderStream();
    const readableStreamClosed = state.port.readable.pipeTo(decoder.writable);
    state.reader = decoder.readable.getReader();

    try {
        while (true) {
            const { value, done } = await state.reader.read();
            if (done) break;
            if (value) {
                processReceivedData(value);
            }
        }
    } catch (err) {
        if (state.connected) {
            log(`Erreur lecture: ${err.message}`, 'error');
        }
    }
}

function processReceivedData(data) {
    state.rxBuffer += data;

    let lines = state.rxBuffer.split('\n');
    state.rxBuffer = lines.pop(); // Garder le fragment incomplet

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith('@PRED:')) {
            const jsonStr = trimmed.substring(6);
            try {
                const pred = JSON.parse(jsonStr);
                handlePrediction(pred);
                log(`PRED: ${pred.name} (${(pred.confidence * 100).toFixed(1)}%) [${pred.time_ms}ms]`, 'pred');
            } catch (e) {
                log(`JSON parse error: ${jsonStr}`, 'error');
            }
        } else if (trimmed.startsWith('@ACK:')) {
            log(`ACK: ${trimmed.substring(5)}`, 'recv');
        } else if (trimmed.startsWith('@PROGRESS:')) {
            // Progression silencieuse
            const parts = trimmed.substring(10).split('/');
            if (parts.length === 2) {
                updateSendingProgress(parseInt(parts[0]), parseInt(parts[1]));
            }
        } else if (trimmed.startsWith('@ERR:')) {
            log(`ESP32 ERROR: ${trimmed.substring(5)}`, 'error');
        } else if (trimmed.startsWith('@TIMING:')) {
            // Profiling par phase: @TIMING:conv1=Xms,conv2=Xms,conv3=Xms,gru=Xms,dense=Xms,total=Xms
            const parts = {};
            trimmed.substring(8).split(',').forEach(kv => {
                const [k, v] = kv.split('=');
                if (k && v) parts[k] = parseInt(v);
            });
            if (parts.total !== undefined) {
                const bar = (ms, total) => {
                    const pct = Math.round(ms / total * 20);
                    return '█'.repeat(pct) + '░'.repeat(20 - pct);
                };
                const t = parts.total || 1;
                const lines = [
                    `Timing inference (total: ${parts.total} ms)`,
                    `  Conv1 ${String(parts.conv1 || 0).padStart(5)}ms ${bar(parts.conv1, t)} ${((parts.conv1||0)/t*100).toFixed(0)}%`,
                    `  Conv2 ${String(parts.conv2 || 0).padStart(5)}ms ${bar(parts.conv2, t)} ${((parts.conv2||0)/t*100).toFixed(0)}%`,
                    `  Conv3 ${String(parts.conv3 || 0).padStart(5)}ms ${bar(parts.conv3, t)} ${((parts.conv3||0)/t*100).toFixed(0)}%`,
                    `  GRU   ${String(parts.gru   || 0).padStart(5)}ms ${bar(parts.gru,   t)} ${((parts.gru  ||0)/t*100).toFixed(0)}%`,
                    `  Dense ${String(parts.dense || 0).padStart(5)}ms ${bar(parts.dense, t)} ${((parts.dense||0)/t*100).toFixed(0)}%`,
                ];
                lines.forEach(l => log(l, 'timing'));
            }
        } else if (trimmed.startsWith('@DBG:')) {
            log(`DBG: ${trimmed.substring(5)}`, 'recv');
        } else if (trimmed.startsWith('@INFO:')) {
            log(`ESP32: ${trimmed.substring(6)}`, 'recv');
        } else if (trimmed.startsWith('[')) {
            // Messages de log ESP32 standards
            log(`ESP32: ${trimmed}`, 'recv');
        }
    }
}

async function sendCommand(cmd) {
    if (!state.connected || !state.port?.writable) return;

    try {
        const writer = state.port.writable.getWriter();
        const encoder = new TextEncoder();
        await writer.write(encoder.encode(cmd + '\n'));
        writer.releaseLock();
        log(`CMD: ${cmd}`, 'send');
    } catch (err) {
        log(`Erreur envoi: ${err.message}`, 'error');
    }
}

/**
 * Envoi des échantillons vers l'ESP32 avec cadence contrôlée.
 *
 * Cadence par vitesse (BATCH_SIZE = 256 échantillons) :
 *   speed=1  → 256 Hz reel    → delai ~1000ms entre batches de 256
 *   speed=2  → 512 Hz         → delai ~500ms
 *   speed=5  → 1280 Hz        → delai ~200ms
 *   speed=10 → 2560 Hz        → delai ~100ms
 *   speed=30 → 7680 Hz        → delai ~33ms
 *   speed=0  → Max (USB CDC)  → pas de delai artificiel
 *
 * La formule est : delai = (BATCH_SIZE / (speed * 256Hz)) * 1000ms
 * L'ESP32 reçoit via USB CDC (plusieurs Mbit/s) et bufferise dans son
 * double-buffer (16 Ko RX hardware + 7680 floats actifs + 7680 floats
 * en attente CNN). Il n'y a pas de risque de debordement.
 */
async function sendData(values, speed) {
    if (!state.connected || !state.port?.writable) return;

    // Taille du batch : 256 échantillons = 1 seconde à 256 Hz
    // → les delais s'expriment en secondes entieres, plus lisible
    const BATCH_SIZE = 256;

    // Delai en ms entre chaque batch
    // speed=0 (max) → 0ms, sinon : duree reelle d'un batch / vitesse
    const batchDelayMs = (speed > 0)
        ? Math.max(0, Math.round(BATCH_SIZE / (speed * SAMPLE_RATE) * 1000) - 3)
        : 0;

    // Compteur de samples envoyes pour l'affichage
    let sentCount = 0;
    const t0 = performance.now();

    let writer = null;
    try {
        writer = state.port.writable.getWriter();
        const encoder = new TextEncoder();

        for (let i = 0; i < values.length; i += BATCH_SIZE) {
            if (!state.running) break;

            const batch = values.slice(i, i + BATCH_SIZE);
            const text = batch.map(v => Math.round(v).toString()).join('\n') + '\n';
            await writer.write(encoder.encode(text));

            sentCount += batch.length;

            // Mettre a jour le compteur d'envoi
            updateSendingProgress(sentCount, values.length, speed, t0);

            // Attendre la duree correspondant a la cadence choisie
            if (batchDelayMs > 0 && i + BATCH_SIZE < values.length) {
                await sleep(batchDelayMs);
            }
        }
    } catch (err) {
        log(`Erreur envoi donnees: ${err.message}`, 'error');
    } finally {
        if (writer) {
            try { writer.releaseLock(); } catch (_) {}
        }
    }
}

// ============================================================================
// Chargement de fichier
// ============================================================================

/**
 * Chargement par streaming : on ne lit que les premiers ~200 Ko
 * pour detecter le format et afficher un apercu du signal.
 * Le reste sera lu epoch par epoch pendant le streaming.
 */
async function loadFile(file) {
    state.fileRef = file;
    state.currentEpochData = [];
    state.annotations1 = [];
    state.annotations2 = [];

    const config = getFileConfig();

    // Lire les premiers ~200 Ko pour detection + apercu
    const peekSize = Math.min(200 * 1024, file.size);
    const peekText = await file.slice(0, peekSize).text();
    const lines = peekText.split('\n');
    const nonEmpty = lines.filter(l => l.trim());

    // Auto-detect separateur
    if (config.separator === 'auto') {
        const sample = nonEmpty[config.skipLines] || nonEmpty[0] || '';
        if (sample.includes('\t')) config.separator = '\t';
        else if (sample.includes(',')) config.separator = ',';
        else if (sample.includes(';')) config.separator = ';';
        else config.separator = null; // Colonne unique
    }
    state.fileConfig = config;

    // Estimer le nombre d'epochs
    const avgBytes = peekSize / Math.max(nonEmpty.length, 1);
    const estLines = Math.floor(file.size / avgBytes) - config.skipLines;
    state.totalEpochs = Math.floor(Math.max(estLines, 0) / CHUNK_SIZE);

    // Parser la premiere epoch pour l'apercu du signal
    let skipped = 0;
    for (const raw of nonEmpty) {
        const line = raw.trim();
        if (!line) continue;
        if (skipped < config.skipLines) { skipped++; continue; }
        const cols = config.separator ? line.split(config.separator).map(s => s.trim()) : [line];
        const val = parseFloat(cols[config.eogCol]);
        if (!isNaN(val)) state.currentEpochData.push(val);
        if (state.currentEpochData.length >= CHUNK_SIZE) break;
    }

    document.getElementById('fileName').textContent =
        `${file.name} (${formatFileSize(file.size)}, ~${state.totalEpochs} epochs)`;

    log(`Fichier selectionne: ${file.name} (${formatFileSize(file.size)})`, 'info');
    log(`  Estimation: ~${state.totalEpochs} epochs (${formatTime(state.totalEpochs * 30)})`, 'info');

    updateControls();
    drawSignal(0);
    savePredictionsToIDB();  // Sauvegarder currentEpochData pour survie au reload

    // Charger le signal complet en arriere-plan pour la vue nuit complete
    loadFullNightEog(file, config);
}

function getFileConfig() {
    let sep = document.getElementById('cfgSeparator').value;
    // Convertir la sequence echappee en vrai caractere tabulation
    if (sep === '\\t') sep = '\t';

    return {
        skipLines: parseInt(document.getElementById('cfgSkipLines').value) || 0,
        eogCol: parseInt(document.getElementById('cfgEogCol').value) || 0,
        annot1Col: parseInt(document.getElementById('cfgAnnot1Col').value),
        annot2Col: parseInt(document.getElementById('cfgAnnot2Col').value),
        annotPer: document.getElementById('cfgAnnotPer').value,
        separator: sep,
    };
}

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' o';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' Ko';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' Mo';
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' Go';
}

/**
 * Generateur asynchrone : lit le fichier en streaming et produit
 * une epoch complète à chaque itération (7680 échantillons + annotations).
 * Memoire utilisee : seulement le buffer texte courant + 1 epoch.
 */
async function* createEpochReader(file, config) {
    const stream = file.stream().pipeThrough(new TextDecoderStream());
    const reader = stream.getReader();

    let remainder = '';
    let linesSkipped = 0;
    let epochSamples = [];
    let rawAnnot1 = [];
    let rawAnnot2 = [];
    let epochIndex = 0;
    const sep = config.separator;

    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            remainder += value;
            const parts = remainder.split('\n');
            remainder = parts.pop(); // Garder le fragment incomplet

            for (const rawLine of parts) {
                const line = rawLine.trim();
                if (!line) continue;

                if (linesSkipped < config.skipLines) {
                    linesSkipped++;
                    continue;
                }

                const cols = sep ? line.split(sep).map(s => s.trim()) : [line];
                const val = parseFloat(cols[config.eogCol]);
                if (isNaN(val)) continue;

                epochSamples.push(val);

                if (config.annot1Col >= 0 && cols[config.annot1Col] !== undefined) {
                    rawAnnot1.push(cols[config.annot1Col].trim());
                }
                if (config.annot2Col >= 0 && cols[config.annot2Col] !== undefined) {
                    rawAnnot2.push(cols[config.annot2Col].trim());
                }

                if (epochSamples.length >= CHUNK_SIZE) {
                    // Produire une epoch complete
                    yield {
                        index: epochIndex,
                        eogData: epochSamples.slice(0, CHUNK_SIZE),
                        annot1: rawAnnot1.length > 0 ? normalizeAnnotation(modeValue(rawAnnot1)) : null,
                        annot2: rawAnnot2.length > 0 ? normalizeAnnotation(modeValue(rawAnnot2)) : null,
                    };

                    epochSamples = epochSamples.slice(CHUNK_SIZE); // Garder le surplus
                    rawAnnot1 = [];
                    rawAnnot2 = [];
                    epochIndex++;
                }
            }
        }

        // Traiter le dernier fragment de remainder
        if (remainder.trim()) {
            const line = remainder.trim();
            const cols = sep ? line.split(sep).map(s => s.trim()) : [line];
            const val = parseFloat(cols[config.eogCol]);
            if (!isNaN(val)) {
                epochSamples.push(val);
                if (config.annot1Col >= 0 && cols[config.annot1Col] !== undefined)
                    rawAnnot1.push(cols[config.annot1Col].trim());
                if (config.annot2Col >= 0 && cols[config.annot2Col] !== undefined)
                    rawAnnot2.push(cols[config.annot2Col].trim());
            }
        }

        // Dernière epoch si assez d'échantillons
        if (epochSamples.length >= CHUNK_SIZE) {
            yield {
                index: epochIndex,
                eogData: epochSamples.slice(0, CHUNK_SIZE),
                annot1: rawAnnot1.length > 0 ? normalizeAnnotation(modeValue(rawAnnot1)) : null,
                annot2: rawAnnot2.length > 0 ? normalizeAnnotation(modeValue(rawAnnot2)) : null,
            };
        }
    } finally {
        try { reader.cancel(); } catch (e) { /* stream fermee */ }
    }
}

/**
 * Generateur d'epochs a partir du signal fullNightEog deja en memoire.
 * Utilise quand fileRef n'est plus disponible (apres reconnexion/refresh).
 */
async function* createEpochReaderFromMemory(eogArray, annots1, annots2) {
    const totalSamples = eogArray.length;
    const totalEpochs = Math.floor(totalSamples / CHUNK_SIZE);
    for (let i = 0; i < totalEpochs; i++) {
        const start = i * CHUNK_SIZE;
        yield {
            index: i,
            eogData: Array.from(eogArray.slice(start, start + CHUNK_SIZE)),
            annot1: (annots1 && annots1[i]) || null,
            annot2: (annots2 && annots2[i]) || null,
        };
    }
}

function normalizeAnnotation(raw) {
    if (raw === undefined || raw === null || raw === '') return null;
    const s = String(raw).toUpperCase().trim();

    // Numerique
    if (s === '0') return 'Wake';
    if (s === '1') return 'N1';
    if (s === '2') return 'N2';
    if (s === '3') return 'N3';
    if (s === '4' || s === '5') return 'REM';

    // Texte
    if (s === 'W' || s === 'WAKE' || s.includes('EVEIL')) return 'Wake';
    if (s === 'R' || s === 'REM') return 'REM';
    if (s === 'N1' || s === 'NREM1') return 'N1';
    if (s === 'N2' || s === 'NREM2') return 'N2';
    if (s === 'N3' || s === 'NREM3' || s === 'SWS') return 'N3';

    return raw; // Non reconnu, garder tel quel
}

function modeValue(arr) {
    const counts = {};
    for (const v of arr) {
        counts[v] = (counts[v] || 0) + 1;
    }
    let maxCount = 0, mode = arr[0];
    for (const [val, count] of Object.entries(counts)) {
        if (count > maxCount) { maxCount = count; mode = val; }
    }
    return mode;
}

// ============================================================================
// Streaming principal
// ============================================================================

async function startStreaming() {
    const hasSource = state.fileRef || (state.fullNightEog && state.fullNightEog.length >= CHUNK_SIZE);
    if (!state.connected || !hasSource) return;

    // Sauvegarder les annotations avant reset (pour le reader memoire)
    const savedAnnots1 = !state.fileRef ? [...state.annotations1] : [];
    const savedAnnots2 = !state.fileRef ? [...state.annotations2] : [];

    state.running = true;
    state.paused = false;
    state.currentEpoch = 0;
    state.predictions = [];
    state.annotations1 = [];
    state.annotations2 = [];
    state.matchesA1 = 0;
    state.matchesA2 = 0;
    state.totalCompared = 0;
    state.totalTimeMs = 0;

    savePredictionsToIDB();
    updateControls();

    // Vider l'historique visuel des predictions precedentes
    const histBody = document.getElementById('historyBody');
    if (histBody) histBody.innerHTML = '';

    // Notifier la sidebar que des donnees temps-reel sont disponibles
    if (typeof window.sidebarNotifyRealtimeData === 'function') {
        window.sidebarNotifyRealtimeData(true);
    }

    // Reset l'historique ESP32
    await sendCommand('#RESET');
    await sleep(200);

    // Si pas de fileRef mais fullNightEog en memoire, recalculer totalEpochs
    if (!state.fileRef && state.fullNightEog) {
        state.totalEpochs = Math.floor(state.fullNightEog.length / CHUNK_SIZE);
        log(`=== Demarrage du streaming (depuis memoire, ${state.totalEpochs} epochs) ===`, 'info');
    } else {
        log('=== Demarrage du streaming (lecture fichier en continu) ===', 'info');
    }

    // Creer le lecteur d'epochs : fichier en streaming, ou fullNightEog en memoire
    const epochReader = state.fileRef
        ? createEpochReader(state.fileRef, state.fileConfig)
        : createEpochReaderFromMemory(state.fullNightEog, savedAnnots1, savedAnnots2);
    let epochCount = 0;

    for await (const epoch of epochReader) {
        if (!state.running) break;

        // Pause
        while (state.paused && state.running) {
            await sleep(100);
        }
        if (!state.running) break;

        epochCount++;
        state.currentEpoch = epoch.index;

        // Stocker les annotations au fur et a mesure (pour hypnogramme)
        state.annotations1[epoch.index] = epoch.annot1;
        state.annotations2[epoch.index] = epoch.annot2;

        // Stocker les donnees courantes pour le canvas
        state.currentEpochData = epoch.eogData;

        // Mettre a jour le total estime si necessaire
        state.totalEpochs = Math.max(state.totalEpochs, epoch.index + 1);

        updateProgressUI();
        drawSignal(epoch.index);
        if (state.fullNightEog || state.fullNightEogFiltre) drawFullNight();

        // Afficher immediatement les annotations + etat "en attente" pour ESP32
        showPendingEpoch(epoch.index);

        log(`Epoch ${epoch.index + 1}/${state.totalEpochs}: envoi de ${epoch.eogData.length} échantillons...`, 'send');
        updateConnectionUI(true, true); // Sending status

        // Envoyer les donnees a la vitesse choisie et attendre la prediction
        // speed est passe explicitement pour que sendData applique la cadence correcte
        const prediction = await sendEpochAndWaitPrediction(epoch.eogData, state.speed);

        if (prediction) {
            processPredictionResult(epoch.index, prediction);
        } else {
            // Timeout: garder la ligne dans l'historique, marquer comme non recu
            finalizeTimeoutRow();
            drawHypnogram();
        }

        updateConnectionUI(true, false); // Connected status
        // Pas de delai supplementaire : sendData cadence deja l'envoi selon state.speed,
        // et l'attente de la prediction CNN constitue la backpressure naturelle.
    }

    // Mettre a jour le vrai nombre d'epochs
    state.totalEpochs = epochCount;
    updateProgressUI();

    if (state.running) {
        log('=== Streaming termine ===', 'info');
        log(`Resultats: ${state.predictions.length} predictions sur ${epochCount} epochs`, 'info');
        if (state.totalCompared > 0) {
            log(`Précision A1: ${(state.matchesA1/state.totalCompared*100).toFixed(1)}%`, 'info');
            log(`Précision A2: ${(state.matchesA2/state.totalCompared*100).toFixed(1)}%`, 'info');
        }
    }

    state.running = false;
    updateControls();
    if (state.fullNightEog || state.fullNightEogFiltre) drawFullNight();  // Masquer la barre orange
}

async function sendEpochAndWaitPrediction(epochData, speed) {
    return new Promise(async (resolve) => {
        let resolved = false;

        // Timeout adaptatif :
        //   temps d'envoi estime + 30s marge pour la CNN (en cas de charge)
        const sendTimeMs = (speed > 0)
            ? Math.ceil(CHUNK_SIZE / (speed * SAMPLE_RATE)) * 1000
            : 5000; // 115200 baud max: ~3.3s d'envoi reel (38 KB), 5s de securite
        const timeoutMs = sendTimeMs + 30000;

        const timeout = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                state.waitingForPrediction = false;
                state.predictionResolve = null;
                log(`Timeout: pas de prediction recue en ${(timeoutMs/1000).toFixed(0)}s`, 'error');
                resolve(null);
            }
        }, timeoutMs);

        // Installer le callback AVANT d'envoyer les donnees
        // pour que toute prediction recue pendant sendData soit correctement traitee
        state.waitingForPrediction = true;
        state.predictionResolve = (pred) => {
            if (!resolved) {
                resolved = true;
                clearTimeout(timeout);
                state.waitingForPrediction = false;
                state.predictionResolve = null;
                resolve(pred);
            }
        };

        // Envoyer les donnees avec la cadence choisie
        await sendData(epochData, speed);
    });
}

function handlePrediction(pred) {
    if (state.predictionResolve) {
        state.predictionResolve(pred);
    }
}

function showPendingEpoch(epoch) {
    const annot1 = state.annotations1[epoch] || null;
    const annot2 = state.annotations2[epoch] || null;

    // Section comparaison supprimee — guard null
    if (document.getElementById('stageESP32')) {
        const stageEl = document.getElementById('stageESP32');
        stageEl.textContent = '...';
        stageEl.className = 'stage-display';
        document.getElementById('confESP32').textContent = 'En attente...';
        document.getElementById('timeESP32').textContent = 'Envoi des donnees...';
        document.getElementById('cardESP32').className = 'comparison-card';

        const a1El = document.getElementById('stageAnnot1');
        a1El.textContent = annot1 || '--';
        a1El.className = `stage-display stage-${getStageClass(annot1)}`;
        document.getElementById('matchAnnot1').textContent = 'En attente ESP32...';
        document.getElementById('matchAnnot1').className = 'match-indicator';
        document.getElementById('cardAnnot1').className = 'comparison-card';

        const a2El = document.getElementById('stageAnnot2');
        a2El.textContent = annot2 || '--';
        a2El.className = `stage-display stage-${getStageClass(annot2)}`;
        document.getElementById('matchAnnot2').textContent = 'En attente ESP32...';
        document.getElementById('matchAnnot2').className = 'match-indicator';
        document.getElementById('cardAnnot2').className = 'comparison-card';
    }

    // Ajouter une ligne en attente dans le tableau
    addPendingHistoryRow(epoch, annot1, annot2);
}

function addPendingHistoryRow(epoch, annot1, annot2) {
    const tbody = document.getElementById('historyBody');

    // Supprimer la ligne pending precedente s'il y en a une
    const existing = document.getElementById('pending-row');
    if (existing) existing.remove();

    const row = document.createElement('tr');
    row.id = 'pending-row';
    row.innerHTML = `
        <td>${epoch + 1}</td>
        <td>${formatTime((epoch + 1) * 30)}</td>
        <td class="stage-cell cell-bg-pending">...</td>
        <td class="stage-cell cell-bg-pending">${annot1 || '--'}</td>
        <td class="stage-cell cell-bg-pending">${annot2 || '--'}</td>
        <td>--</td>
        <td>...</td>
    `;
    tbody.insertBefore(row, tbody.firstChild);
}

function processPredictionResult(epoch, pred) {
    const result = {
        epoch: epoch,
        class: pred.class,
        name: pred.name,
        label: pred.label,
        confidence: pred.confidence,
        probs: pred.probs,
        transition: pred.transition,
        time_ms: pred.time_ms,
        annot1: state.annotations1[epoch] || null,
        annot2: state.annotations2[epoch] || null,
    };

    result.matchA1 = result.annot1 ? (result.name === result.annot1) : null;
    result.matchA2 = result.annot2 ? (result.name === result.annot2) : null;

    state.predictions.push(result);
    state.totalTimeMs += pred.time_ms;

    // Notifier la sidebar des la premiere prediction
    if (state.predictions.length === 1 && typeof window.sidebarNotifyRealtimeData === 'function') {
        window.sidebarNotifyRealtimeData(true);
    }

    if (result.matchA1 !== null) {
        state.totalCompared++;
        if (result.matchA1) state.matchesA1++;
        if (result.matchA2) state.matchesA2++;
    }

    // Mettre a jour l'interface
    updateComparisonCards(result);
    addHistoryRow(result);
    updateStats();
    updateFilteredStats();
    drawHypnogram();
    savePredictionsToIDB();
}

// ============================================================================
// Interface utilisateur
// ============================================================================

function updateConnectionUI(connected, sending = false) {
    const status = document.getElementById('connectionStatus');
    if (!connected) {
        status.textContent = 'Déconnecté';
        status.className = 'status disconnected';
    } else if (sending) {
        status.textContent = 'Envoi en cours...';
        status.className = 'status sending';
    } else {
        status.textContent = 'Connecté';
        status.className = 'status connected';
    }
}

function updateControls() {
    const hasData = state.fileRef !== null || (state.fullNightEog && state.fullNightEog.length >= CHUNK_SIZE);
    const canStart = state.connected && hasData && !state.running;

    document.getElementById('btnConnect').disabled    = state.connected;
    document.getElementById('btnDisconnect').disabled = !state.connected;
    document.getElementById('btnStart').disabled      = !canStart;
    document.getElementById('btnPause').disabled      = !state.running;
    document.getElementById('btnStop').disabled       = !state.running;
    document.getElementById('btnReset').disabled      = !state.connected;

    // Boutons export: actifs uniquement quand il y a des predictions
    const hasPreds = state.predictions.length > 0;
    document.getElementById('btnSaveSession').disabled  = !hasPreds;
    document.getElementById('btnExportCSV').disabled    = !hasPreds;
    document.getElementById('btnExportHypno').disabled  = !hasPreds;
}

function updateProgressUI() {
    const pct = ((state.currentEpoch + 1) / state.totalEpochs * 100).toFixed(1);
    document.getElementById('progressBar').style.width = pct + '%';
    document.getElementById('epochInfo').textContent =
        `Epoch ${state.currentEpoch + 1} / ${state.totalEpochs}`;
    document.getElementById('timeInfo').textContent =
        `${formatTime((state.currentEpoch + 1) * 30)} / ${formatTime(state.totalEpochs * 30)}`;
}

function updateSendingProgress(count, total) {
    const pct = (count / total * 100).toFixed(0);
    document.getElementById('sendingInfo').textContent =
        `Buffer ESP32: ${count}/${total} (${pct}%)`;
}

function updateComparisonCards(result) {
    // Section comparaison supprimee — guard null
    if (!document.getElementById('stageESP32')) return;

    const colors = getCellColors(result.name, result.annot1, result.annot2);

    // Mapping des classes de cellule vers les bordures des cards
    function cardBorderClass(cellClass) {
        if (cellClass.includes('cell-bg-agree')) return 'card-match';
        if (cellClass.includes('cell-bg-partial')) return 'card-partial';
        if (cellClass.includes('cell-bg-wrong')) return 'card-mismatch';
        if (cellClass.includes('cell-bg-outlier')) return 'card-outlier';
        return '';
    }

    // ESP32
    const stageEl = document.getElementById('stageESP32');
    stageEl.textContent = result.name;
    stageEl.className = `stage-display stage-${result.name === 'Wake' ? 'W' : result.name}`;
    document.getElementById('confESP32').textContent =
        `Confiance: ${(result.confidence * 100).toFixed(1)}%`;
    document.getElementById('timeESP32').textContent =
        `Traitement: ${result.time_ms} ms`;
    document.getElementById('cardESP32').className =
        `comparison-card ${cardBorderClass(colors.esp32)}`;

    // Annotateur 1
    const a1El = document.getElementById('stageAnnot1');
    a1El.textContent = result.annot1 || '--';
    a1El.className = `stage-display stage-${getStageClass(result.annot1)}`;
    const m1El = document.getElementById('matchAnnot1');
    document.getElementById('cardAnnot1').className =
        `comparison-card ${cardBorderClass(colors.a1)}`;
    if (result.matchA1 !== null) {
        m1El.textContent = result.matchA1 ? 'MATCH' : 'DIFFERENT';
        m1El.className = `match-indicator ${result.matchA1 ? 'match-yes' : 'match-no'}`;
    } else {
        m1El.textContent = 'Pas d\'annotation';
        m1El.className = 'match-indicator';
    }

    // Annotateur 2
    const a2El = document.getElementById('stageAnnot2');
    a2El.textContent = result.annot2 || '--';
    a2El.className = `stage-display stage-${getStageClass(result.annot2)}`;
    const m2El = document.getElementById('matchAnnot2');
    document.getElementById('cardAnnot2').className =
        `comparison-card ${cardBorderClass(colors.a2)}`;
    if (result.matchA2 !== null) {
        m2El.textContent = result.matchA2 ? 'MATCH' : 'DIFFERENT';
        m2El.className = `match-indicator ${result.matchA2 ? 'match-yes' : 'match-no'}`;
    } else {
        m2El.textContent = 'Pas d\'annotation';
        m2El.className = 'match-indicator';
    }
}

function getCellColors(esp32Name, annot1, annot2) {
    const hasA1 = annot1 !== null;
    const hasA2 = annot2 !== null;

    if (!hasA1 && !hasA2) return { esp32: 'stage-cell', a1: 'stage-cell', a2: 'stage-cell' };

    const matchA1 = hasA1 && esp32Name === annot1;
    const matchA2 = hasA2 && esp32Name === annot2;

    if (hasA1 && hasA2) {
        if (matchA1 && matchA2) {
            // Unanime: les 3 sont identiques
            return { esp32: 'stage-cell cell-bg-agree', a1: 'stage-cell cell-bg-agree', a2: 'stage-cell cell-bg-agree' };
        } else if (matchA1) {
            // ESP32 = Annot1, Annot2 diverge
            return { esp32: 'stage-cell cell-bg-partial', a1: 'stage-cell cell-bg-partial', a2: 'stage-cell cell-bg-outlier' };
        } else if (matchA2) {
            // ESP32 = Annot2, Annot1 diverge
            return { esp32: 'stage-cell cell-bg-partial', a1: 'stage-cell cell-bg-outlier', a2: 'stage-cell cell-bg-partial' };
        } else {
            // ESP32 ne correspond a aucun annotateur
            return { esp32: 'stage-cell cell-bg-wrong', a1: 'stage-cell', a2: 'stage-cell' };
        }
    } else if (hasA1) {
        return {
            esp32: matchA1 ? 'stage-cell cell-bg-agree' : 'stage-cell cell-bg-wrong',
            a1: matchA1 ? 'stage-cell cell-bg-agree' : 'stage-cell',
            a2: 'stage-cell'
        };
    } else {
        return {
            esp32: matchA2 ? 'stage-cell cell-bg-agree' : 'stage-cell cell-bg-wrong',
            a1: 'stage-cell',
            a2: matchA2 ? 'stage-cell cell-bg-agree' : 'stage-cell'
        };
    }
}

function addHistoryRow(result) {
    const tbody = document.getElementById('historyBody');

    // Supprimer la ligne pending de cette epoch
    const pending = document.getElementById('pending-row');
    if (pending) pending.remove();

    // Verifier si cette prediction passe le filtre actif
    const filterFn = STATS_FILTERS[state.statsFilter]?.fn;
    if (filterFn && !filterFn(result)) return;

    const colors = getCellColors(result.name, result.annot1, result.annot2);
    const row = document.createElement('tr');
    row.setAttribute('data-epoch', result.epoch);

    row.innerHTML = `
        <td>${result.epoch + 1}</td>
        <td>${formatTime((result.epoch + 1) * 30)}</td>
        <td class="${colors.esp32}">${result.name}</td>
        <td class="${colors.a1}">${result.annot1 || '--'}</td>
        <td class="${colors.a2}">${result.annot2 || '--'}</td>
        <td>${(result.confidence * 100).toFixed(1)}%</td>
        <td>${result.time_ms}</td>
    `;

    // Inserer en haut (plus recent en premier)
    tbody.insertBefore(row, tbody.firstChild);
}

function finalizeTimeoutRow() {
    const pending = document.getElementById('pending-row');
    if (!pending) return;
    pending.removeAttribute('id');
    const cells = pending.querySelectorAll('td');
    if (cells[2]) { cells[2].className = 'stage-cell'; cells[2].textContent = '—'; }
    if (cells[3]) cells[3].className = 'stage-cell';
    if (cells[4]) cells[4].className = 'stage-cell';
    if (cells[6]) cells[6].textContent = 'timeout';
}

// Retourne les predictions filtrées par le filtre actif
function getFilteredPredictions() {
    const f = STATS_FILTERS[state.statsFilter];
    if (!f || state.statsFilter === 'all') return state.predictions;
    return state.predictions.filter(f.fn);
}

// Reconstruit le tableau d'historique à partir des prédictions filtrées
function rebuildHistoryTable() {
    const tbody = document.getElementById('historyBody');
    tbody.innerHTML = '';
    const filtered = getFilteredPredictions();
    for (const result of filtered) {
        const colors = getCellColors(result.name, result.annot1, result.annot2);
        const row = document.createElement('tr');
        row.setAttribute('data-epoch', result.epoch);
        row.innerHTML = `
            <td>${result.epoch + 1}</td>
            <td>${formatTime((result.epoch + 1) * 30)}</td>
            <td class="${colors.esp32}">${result.name}</td>
            <td class="${colors.a1}">${result.annot1 || '--'}</td>
            <td class="${colors.a2}">${result.annot2 || '--'}</td>
            <td>${(result.confidence * 100).toFixed(1)}%</td>
            <td>${result.time_ms}</td>
        `;
        tbody.insertBefore(row, tbody.firstChild);
    }
    // Info filtre
    updateStatsFilterInfo();
}

// Met a jour le compteur affiché a cote du filtre
function updateStatsFilterInfo() {
    const el = document.getElementById('statsFilterInfo');
    if (!el) return;
    const total = state.predictions.length;
    if (total === 0 || state.statsFilter === 'all') {
        el.textContent = '';
        return;
    }
    const filtered = getFilteredPredictions();
    const pct = (filtered.length / total * 100).toFixed(0);
    el.textContent = `${filtered.length} / ${total} epochs (${pct}%)`;
}

// Applique le filtre: reconstruit l'historique et recalcule les stats
function applyStatsFilter(filterId) {
    state.statsFilter = filterId;
    rebuildHistoryTable();
    updateStats();
    updateFilteredStats();
    drawHypnogram();
    saveUIParams();
}

function updateStats() {
    const filtered = getFilteredPredictions();
    const nPred = filtered.length;
    document.getElementById('statEpochs').textContent = nPred;
    document.getElementById('statEpochsDuration').innerHTML =
        nPred > 0 ? formatDuration(nPred) : '';

    // Précision vs Annotateur 1
    const cmpA1 = filtered.filter(p => p.matchA1 !== null);
    const hitA1 = cmpA1.filter(p => p.matchA1).length;
    document.getElementById('statAccA1').textContent =
        cmpA1.length > 0 ? `${(hitA1 / cmpA1.length * 100).toFixed(1)}%` : '--';

    // Précision vs Annotateur 2
    const cmpA2 = filtered.filter(p => p.matchA2 !== null);
    const hitA2 = cmpA2.filter(p => p.matchA2).length;
    document.getElementById('statAccA2').textContent =
        cmpA2.length > 0 ? `${(hitA2 / cmpA2.length * 100).toFixed(1)}%` : '--';

    // Temps moyen
    if (nPred > 0) {
        const avgTime = (filtered.reduce((s, p) => s + p.time_ms, 0) / nPred).toFixed(0);
        document.getElementById('statAvgTime').textContent = avgTime;
    } else {
        document.getElementById('statAvgTime').textContent = '--';
    }

    // Distribution
    updateDistribution();
}

// ============================================================================
// Statistiques filtrées par seuil de confiance
// ============================================================================

function updateFilteredStats() {
    const base      = getFilteredPredictions();
    const threshold = state.confidenceThreshold / 100;
    const filtered  = base.filter(p => p.confidence >= threshold);
    const total     = base.length;

    const section = document.getElementById('confidenceFilterSection');
    if (total === 0) {
        section.style.display = 'none';
        return;
    }
    section.style.display = 'block';

    // Compteur "X / Y (Z%)"
    const pctKept = total > 0 ? (filtered.length / total * 100).toFixed(0) : 0;
    document.getElementById('filtStatEpochs').textContent = `${filtered.length} / ${total}`;
    document.getElementById('filtStatEpochsDuration').innerHTML =
        filtered.length > 0 ? durHtml(filtered.length, total) : '';
    document.getElementById('filteredCountLabel').textContent =
        `— ${filtered.length} epoch(s) retenues (${pctKept}%)`;

    // Précision vs Annotateur 1
    const cmpA1   = filtered.filter(p => p.matchA1 !== null);
    const hitA1   = cmpA1.filter(p => p.matchA1).length;
    document.getElementById('filtStatAccA1').textContent =
        cmpA1.length > 0 ? `${(hitA1 / cmpA1.length * 100).toFixed(1)}%` : '--';

    // Précision vs Annotateur 2
    const cmpA2   = filtered.filter(p => p.matchA2 !== null);
    const hitA2   = cmpA2.filter(p => p.matchA2).length;
    document.getElementById('filtStatAccA2').textContent =
        cmpA2.length > 0 ? `${(hitA2 / cmpA2.length * 100).toFixed(1)}%` : '--';

    // Temps moyen
    if (filtered.length > 0) {
        const avg = (filtered.reduce((s, p) => s + p.time_ms, 0) / filtered.length).toFixed(0);
        document.getElementById('filtStatAvgTime').textContent = avg;
    } else {
        document.getElementById('filtStatAvgTime').textContent = '--';
    }

    // Distribution par stade
    const grid   = document.getElementById('filteredDistributionGrid');
    grid.innerHTML = '';
    if (filtered.length === 0) {
        const msg = document.createElement('div');
        msg.style.cssText = 'color:#9aa0a6; padding:8px; font-size:13px;';
        msg.textContent = 'Aucune epoch au-dessus de ce seuil.';
        grid.appendChild(msg);
        return;
    }
    const counts = { 'Wake': 0, 'N1': 0, 'N2': 0, 'N3': 0, 'REM': 0 };
    // Per-stage accuracy vs annotators
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
        // Faux = ni A1 ni A2 d'accord (les deux annoteurs comparables)
        if (p.matchA1 !== null && p.matchA2 !== null && !p.matchA1 && !p.matchA2) {
            stageWrongBoth[s]++;
        }
    }
    const filtTotal = filtered.length;

    // Legende (inseree avant la grille, pas dedans)
    let legend = grid.previousElementSibling;
    if (!legend || !legend.classList.contains('stat-legend')) {
        legend = document.createElement('div');
        legend.className = 'stat-legend';
        grid.parentNode.insertBefore(legend, grid);
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
        const pct   = (count / filtTotal * 100).toFixed(1);
        const accA1 = stageCmpA1[stage] > 0
            ? (stageHitA1[stage] / stageCmpA1[stage] * 100).toFixed(0) + '%' : '--';
        const accA2 = stageCmpA2[stage] > 0
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
        const card  = document.createElement('div');
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

function updateDistribution() {
    const grid = document.getElementById('distributionGrid');
    const section = document.getElementById('confusionSection');
    const filtered = getFilteredPredictions();

    if (filtered.length === 0) {
        section.style.display = 'none';
        return;
    }
    section.style.display = 'block';

    const counts = { 'Wake': 0, 'N1': 0, 'N2': 0, 'N3': 0, 'REM': 0 };
    for (const p of filtered) {
        counts[p.name] = (counts[p.name] || 0) + 1;
    }

    const total = filtered.length;
    grid.innerHTML = '';
    for (const stage of STAGE_NAMES) {
        const count = counts[stage] || 0;
        const pct = (count / total * 100).toFixed(1);
        const card = document.createElement('div');
        card.className = 'stat-card';
        card.innerHTML = `
            <div class="stat-label stage-${getStageClass(stage)}">${stage}</div>
            <div class="stat-value" style="color:${STAGE_COLORS[stage]}">${count}</div>
            <div style="font-size:12px;color:#9aa0a6">${pct}%</div>
            <div class="stat-duration">${durHtml(count, total)}</div>
        `;
        grid.appendChild(card);
    }
}

// ============================================================================
// Canvas - Signal EOG
// ============================================================================

function drawSignal(epoch) {
    const canvas = document.getElementById('signalCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    // Resize pour DPI
    const rect = canvas.parentElement.getBoundingClientRect();
    if (rect.width < 50) return; // element cache ou trop etroit
    canvas.width = rect.width - 40;
    canvas.height = 200;

    const w = canvas.width;
    const h = canvas.height;

    ctx.fillStyle = '#2a2f38';
    ctx.fillRect(0, 0, w, h);

    // En mode streaming, les donnees courantes sont dans state.currentEpochData
    const data = state.currentEpochData;

    if (!data || data.length === 0) {
        ctx.fillStyle = '#6b7280';
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Chargez un fichier EOG pour voir le signal', w / 2, h / 2);
        return;
    }

    // Trouver min/max pour normalisation
    let min = Infinity, max = -Infinity;
    for (const v of data) {
        if (v < min) min = v;
        if (v > max) max = v;
    }
    const range = max - min || 1;
    const margin = 10;

    // Dessiner la grille
    ctx.strokeStyle = '#3a3f4a';
    ctx.lineWidth = 0.5;
    for (let y = 0; y < h; y += h / 5) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
    }

    // Dessiner le signal (tous les échantillons pour fidélité visuelle)
    ctx.beginPath();
    ctx.strokeStyle = '#4a9eff';
    ctx.lineWidth = 1;

    const drawH = h - 2 * margin;
    for (let i = 0; i < data.length; i++) {
        const x = (i / data.length) * w;
        const y = h - margin - ((data[i] - min) / range) * drawH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Labels
    ctx.fillStyle = '#9aa0a6';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`Epoch ${epoch + 1} | ${data.length} pts | min=${min.toFixed(0)} max=${max.toFixed(0)}`, 8, 16);

    // Axe temps
    ctx.textAlign = 'center';
    for (let s = 0; s <= 30; s += 5) {
        const x = (s / 30) * w;
        ctx.fillText(`${s}s`, x, h - 2);
    }
}

// ============================================================================
// Canvas - Signal Nuit Complete
// ============================================================================

/**
 * Charge tout le signal EOG depuis le fichier en arriere-plan.
 * Utilise un streaming par chunks pour eviter de bloquer l'UI.
 */
async function loadFullNightEog(file, config) {
    state.fullNightLoading = true;
    state.fullNightEog = null;
    state.fullNightEogFiltre = null;
    drawFullNight();  // Afficher "Chargement..."

    // Colonne du signal filtre (col 0 si eogCol n'est pas 0, sinon pas dispo)
    const filtreCol = (config.eogCol !== 0 && config.separator) ? 0 : -1;

    try {
        const text = await file.text();
        const lines = text.split('\n');
        const samplesBrut = [];
        const samplesFiltre = [];
        let skipped = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            if (skipped < config.skipLines) { skipped++; continue; }
            const cols = config.separator ? line.split(config.separator) : [line];

            const valBrut = parseFloat(cols[config.eogCol]);
            if (!isNaN(valBrut)) samplesBrut.push(valBrut);

            if (filtreCol >= 0 && cols[filtreCol] !== undefined) {
                const valFiltre = parseFloat(cols[filtreCol]);
                if (!isNaN(valFiltre)) samplesFiltre.push(valFiltre);
            }

            // Yield au navigateur toutes les 500k lignes
            if (i % 500000 === 0 && i > 0) {
                await new Promise(r => setTimeout(r, 0));
            }
        }

        state.fullNightEog = new Float32Array(samplesBrut);
        if (samplesFiltre.length > 0) {
            state.fullNightEogFiltre = new Float32Array(samplesFiltre);
        }
        state.fnZoomLevel = 1;
        state.fnView.startSample = 0;
        state.fnView.visibleSamples = state.fullNightEog.length;

        log(`Signal nuit complète chargé: ${state.fullNightEog.length} échantillons (${(state.fullNightEog.length / CHUNK_SIZE).toFixed(0)} epochs)`, 'info');
        if (state.fullNightEogFiltre) {
            log(`  Signal filtre egalement charge (${state.fullNightEogFiltre.length} ech.)`, 'info');
        }
    } catch (e) {
        log(`Erreur chargement signal complet: ${e.message}`, 'error');
        state.fullNightEog = null;
        state.fullNightEogFiltre = null;
    }

    state.fullNightLoading = false;
    saveEogToIDB();
    updateFnCheckboxes();
    updateFullNightSlider();
    drawFullNight();
    drawFrequencyAnalysis();
    updateSignalQuality();
    updateAdvancedAnalysis();
}

/**
 * Dessine le signal EOG sur la nuit complete avec la vue courante (zoom/scroll).
 */
function drawFullNight() {
    const canvas = document.getElementById('fullNightCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const rect = canvas.parentElement.getBoundingClientRect();
    if (rect.width < 50) return; // element cache ou trop etroit
    canvas.width = rect.width - 40;
    canvas.height = state.fnCanvasHeight;

    const w = canvas.width;
    const h = canvas.height;
    const marginTop = 24;
    const marginBottom = 22;
    const marginLeft = 55;
    const drawW = w - marginLeft;
    const drawH = h - marginTop - marginBottom;

    // Fond
    ctx.fillStyle = '#2a2f38';
    ctx.fillRect(0, 0, w, h);

    // Message si pas de donnees
    if (state.fullNightLoading) {
        ctx.fillStyle = '#f59e0b';
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Chargement du signal complet...', w / 2, h / 2);
        return;
    }

    const refData = state.fullNightEog || state.fullNightEogFiltre;
    if (!refData || refData.length === 0) {
        ctx.fillStyle = '#6b7280';
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Chargez un fichier EOG pour voir le signal complet', w / 2, h / 2);
        return;
    }

    // Construire la liste des traces a afficher (brut en haut, filtre en bas)
    const traces = [];
    if (state.fnShowBrut && state.fullNightEog) {
        traces.push({ data: state.fullNightEog, color: '#4a9eff', fill: 'rgba(74, 158, 255, 0.15)', label: 'EOG brut' });
    }
    if (state.fnShowFiltre && state.fullNightEogFiltre) {
        traces.push({ data: state.fullNightEogFiltre, color: '#f59e0b', fill: 'rgba(245, 158, 11, 0.12)', label: 'EOG filtrée' });
    }

    if (traces.length === 0) {
        ctx.fillStyle = '#6b7280';
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Cochez au moins une courbe a afficher', w / 2, h / 2);
        return;
    }

    const totalSamples = refData.length;
    const start = Math.max(0, Math.floor(state.fnView.startSample));
    const visible = Math.min(state.fnView.visibleSamples, totalSamples - start);
    const end = start + visible;

    const scanStep = Math.max(1, Math.floor(visible / 2000));
    const samplesPerPixel = visible / drawW;
    const startEpoch = Math.floor(start / CHUNK_SIZE);
    const endEpoch = Math.ceil(end / CHUNK_SIZE);

    // Helper: dessiner grille + separateurs d'epochs dans une bande
    function _drawBandGrid(bandTop, bandH) {
        ctx.strokeStyle = '#3a3f4a';
        ctx.lineWidth = 0.5;
        for (let gy = 0; gy < 5; gy++) {
            const y = bandTop + (gy / 4) * bandH;
            ctx.beginPath();
            ctx.moveTo(marginLeft, y);
            ctx.lineTo(w, y);
            ctx.stroke();
        }
        ctx.strokeStyle = '#3a3f4a44';
        ctx.lineWidth = 0.5;
        for (let ep = startEpoch; ep <= endEpoch; ep++) {
            const samplePos = ep * CHUNK_SIZE;
            if (samplePos >= start && samplePos <= end) {
                const x = marginLeft + ((samplePos - start) / visible) * drawW;
                ctx.beginPath();
                ctx.moveTo(x, bandTop);
                ctx.lineTo(x, bandTop + bandH);
                ctx.stroke();
            }
        }
    }

    // Helper: dessiner les labels Y (min, milieu, max) pour une bande
    function _drawYLabels(bandTop, bandH, mm, color) {
        ctx.fillStyle = color || '#6b7280';
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'right';
        const fmt = (v) => Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + 'k' : v.toFixed(0);
        // Max (haut)
        ctx.fillText(fmt(mm.max), marginLeft - 4, bandTop + 9);
        // Milieu
        const mid = (mm.min + mm.max) / 2;
        ctx.fillText(fmt(mid), marginLeft - 4, bandTop + bandH / 2 + 3);
        // Min (bas)
        ctx.fillText(fmt(mm.min), marginLeft - 4, bandTop + bandH - 2);
    }

    // Helper: calculer min/max d'une trace sur la fenetre visible
    function _traceMinMax(data) {
        let tMin = Infinity, tMax = -Infinity;
        for (let i = start; i < end; i += scanStep) {
            const v = data[i];
            if (v < tMin) tMin = v;
            if (v > tMax) tMax = v;
        }
        return { min: tMin, max: tMax, range: (tMax - tMin) || 1 };
    }

    const useSeparate = state.fnDisplayMode === 'separate' && traces.length > 1;

    if (useSeparate) {
        // --- Mode separe : chaque trace dans sa propre bande ---
        const bandGap = 8;
        const bandH = (drawH - bandGap * (traces.length - 1)) / traces.length;

        for (let t = 0; t < traces.length; t++) {
            const trace = traces[t];
            const bandTop = marginTop + t * (bandH + bandGap);
            const mm = _traceMinMax(trace.data);

            _drawBandGrid(bandTop, bandH);
            _drawYLabels(bandTop, bandH, mm, trace.color);
            _drawFnTrace(ctx, trace.data, start, end, visible, marginLeft, drawW, bandTop, bandH, mm.min, mm.range, samplesPerPixel, trace.color);

            // Label de la bande
            ctx.fillStyle = trace.color;
            ctx.font = '10px sans-serif';
            ctx.textAlign = 'right';
            ctx.fillText(trace.label, w - 8, bandTop + 12);

            // Separateur entre bandes
            if (t < traces.length - 1) {
                const sepY = bandTop + bandH + bandGap / 2;
                ctx.strokeStyle = '#3a3f4a';
                ctx.lineWidth = 1;
                ctx.setLineDash([4, 4]);
                ctx.beginPath();
                ctx.moveTo(marginLeft, sepY);
                ctx.lineTo(w, sepY);
                ctx.stroke();
                ctx.setLineDash([]);
            }
        }
    } else {
        // --- Mode superpose (ou 1 seule trace) ---
        _drawBandGrid(marginTop, drawH);

        // Labels Y pour la premiere trace (ou l'unique trace)
        const firstMm = _traceMinMax(traces[0].data);
        _drawYLabels(marginTop, drawH, firstMm, traces[0].color);

        for (const trace of traces) {
            const mm = _traceMinMax(trace.data);
            _drawFnTrace(ctx, trace.data, start, end, visible, marginLeft, drawW, marginTop, drawH, mm.min, mm.range, samplesPerPixel, trace.color);
        }
    }

    // Indicateur de l'epoch courante (rectangle semi-transparent)
    if (state.currentEpochData.length > 0) {
        const epStart = state.currentEpoch * CHUNK_SIZE;
        const epEnd = epStart + CHUNK_SIZE;
        const x1 = marginLeft + ((epStart - start) / visible) * drawW;
        const x2 = marginLeft + ((epEnd - start) / visible) * drawW;
        if (x2 > marginLeft && x1 < w) {
            const clampX1 = Math.max(x1, marginLeft);
            const clampX2 = Math.min(x2, w);
            ctx.fillStyle = 'rgba(74, 158, 255, 0.15)';
            ctx.fillRect(clampX1, marginTop, clampX2 - clampX1, drawH);
            ctx.strokeStyle = 'rgba(74, 158, 255, 0.6)';
            ctx.lineWidth = 1;
            ctx.strokeRect(clampX1, marginTop, clampX2 - clampX1, drawH);
        }
    }

    // Barre de progression orange (classification temps reel uniquement)
    if (state.running && state.currentEpoch >= 0 && totalSamples > 0) {
        const progSample = (state.currentEpoch + 1) * CHUNK_SIZE;
        const progX = marginLeft + ((progSample - start) / visible) * drawW;
        const clampProgX = Math.max(marginLeft, Math.min(progX, marginLeft + drawW));

        // Zone deja traitee (fond orange semi-transparent)
        if (clampProgX > marginLeft) {
            ctx.fillStyle = 'rgba(255, 152, 0, 0.10)';
            ctx.fillRect(marginLeft, marginTop, clampProgX - marginLeft, drawH);
        }

        // Ligne verticale orange (position actuelle)
        if (progX >= marginLeft && progX <= marginLeft + drawW) {
            ctx.strokeStyle = '#ff9800';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(clampProgX, marginTop);
            ctx.lineTo(clampProgX, marginTop + drawH);
            ctx.stroke();

            // Label epoch au-dessus de la ligne
            ctx.fillStyle = '#ff9800';
            ctx.font = 'bold 10px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(`E${state.currentEpoch + 1}`, clampProgX, marginTop - 3);
        }
    }

    // Minimap en haut (barre de position)
    if (state.fnZoomLevel > 1) {
        const barY = 2;
        const barH = 6;
        ctx.fillStyle = '#3a3f4a';
        ctx.fillRect(marginLeft, barY, drawW, barH);
        const viewStart = marginLeft + (start / totalSamples) * drawW;
        const viewWidth = Math.max(4, (visible / totalSamples) * drawW);
        ctx.fillStyle = 'rgba(74, 158, 255, 0.6)';
        ctx.fillRect(viewStart, barY, viewWidth, barH);
    }

    // Labels
    const epochStart = (start / CHUNK_SIZE) + 1;
    const epochEnd = (end / CHUNK_SIZE);
    const timeStart = formatTime(Math.floor(start / CHUNK_SIZE) * 30);
    const timeEnd = formatTime(Math.ceil(end / CHUNK_SIZE) * 30);

    ctx.fillStyle = '#9aa0a6';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`Epochs ${Math.floor(epochStart)}-${Math.ceil(epochEnd)} | ${timeStart} - ${timeEnd} | Zoom x${state.fnZoomLevel.toFixed(1)}`, marginLeft + 4, 16);

    // Mettre a jour le label dans la toolbar
    const rangeEl = document.getElementById('fullNightRange');
    if (rangeEl) {
        rangeEl.textContent = `Epochs ${Math.floor(epochStart)}-${Math.ceil(epochEnd)} (${timeStart} - ${timeEnd})`;
    }

    // Axe temps en bas
    ctx.fillStyle = '#9aa0a6';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    const nTicks = Math.min(12, Math.ceil(visible / CHUNK_SIZE));
    const tickInterval = visible / nTicks;
    for (let t = 0; t <= nTicks; t++) {
        const samplePos = start + t * tickInterval;
        const x = marginLeft + (t / nTicks) * drawW;
        const epochNum = Math.floor(samplePos / CHUNK_SIZE) + 1;
        const timeStr = formatTime(Math.floor(samplePos / CHUNK_SIZE) * 30);
        ctx.fillText(timeStr, x, h - 4);
    }
}

/**
 * Dessine une trace sur le canvas fullNight (ligne mediane par pixel).
 * mLeft et dW = marge gauche et largeur utile du dessin.
 */
function _drawFnTrace(ctx, data, start, end, visible, mLeft, dW, bandTop, bandH, min, range, samplesPerPixel, color) {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;

    if (samplesPerPixel <= 2) {
        // Zoom proche : tracer chaque echantillon
        for (let i = start; i < end; i++) {
            const x = mLeft + ((i - start) / visible) * dW;
            const y = bandTop + bandH - ((data[i] - min) / range) * bandH;
            if (i === start) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
    } else {
        // Vue large : ligne mediane (moyenne min/max par pixel)
        for (let px = 0; px < dW; px++) {
            const s = start + Math.floor(px * (visible / dW));
            const e2 = Math.min(start + Math.floor((px + 1) * (visible / dW)), end);
            let pxMin = Infinity, pxMax = -Infinity;
            for (let i = s; i < e2; i++) {
                const v = data[i];
                if (v < pxMin) pxMin = v;
                if (v > pxMax) pxMax = v;
            }
            if (pxMin === Infinity) { pxMin = pxMax = data[s] || 0; }
            const y = bandTop + bandH - (((pxMax + pxMin) / 2 - min) / range) * bandH;
            if (px === 0) ctx.moveTo(mLeft + px, y);
            else ctx.lineTo(mLeft + px, y);
        }
    }

    ctx.stroke();
}

/**
 * Active/desactive les checkboxes selon les donnees disponibles.
 */
function updateFnCheckboxes() {
    const cbBrut = document.getElementById('fnShowBrut');
    const cbFiltre = document.getElementById('fnShowFiltre');
    if (cbBrut) {
        cbBrut.disabled = !state.fullNightEog;
        cbBrut.checked = state.fnShowBrut;
    }
    if (cbFiltre) {
        cbFiltre.disabled = !state.fullNightEogFiltre;
        cbFiltre.checked = state.fnShowFiltre;
    }
}

/**
 * Met a jour le slider de scroll selon la vue courante.
 * Masque le slider si on est en vue complete (zoom = 1).
 */
function updateFullNightSlider() {
    const slider = document.getElementById('fullNightScroll');
    const container = document.getElementById('fullNightScrollContainer');
    const refData = state.fullNightEog || state.fullNightEogFiltre;
    if (!slider || !refData) return;

    // Masquer le slider si vue complete
    if (container) {
        container.style.display = (state.fnZoomLevel > 1) ? 'block' : 'none';
    }

    const total = refData.length;
    const maxStart = Math.max(0, total - state.fnView.visibleSamples);
    slider.max = 1000;
    slider.value = maxStart > 0 ? Math.round((state.fnView.startSample / maxStart) * 1000) : 0;
    saveUIParams();
}

/**
 * Convertit une coordonnee CSS X sur le fullNight canvas en position d'echantillon.
 */
function fnCssXToSample(canvas, cssX) {
    const scaleX = canvas.width / canvas.getBoundingClientRect().width;
    const canvasX = cssX * scaleX;
    const mLeft = 55; // doit correspondre a marginLeft dans drawFullNight
    const dW = canvas.width - mLeft;
    const frac = Math.max(0, Math.min(1, (canvasX - mLeft) / dW));
    return state.fnView.startSample + frac * state.fnView.visibleSamples;
}

/**
 * Remet le fullNight en vue complete.
 */
function resetFullNightZoom() {
    const refData = state.fullNightEog || state.fullNightEogFiltre;
    if (!refData) return;
    state.fnView.startSample = 0;
    state.fnView.visibleSamples = refData.length;
    state.fnZoomLevel = 1;
    updateFullNightSlider();
    drawFullNight();
}

/**
 * Initialise les evenements pour la section nuit complete.
 */
function initFullNightEvents() {
    const canvas = document.getElementById('fullNightCanvas');
    const slider = document.getElementById('fullNightScroll');
    const selDiv = document.getElementById('fullNightSelection');
    if (!canvas) return;

    // Helper : signal de reference (brut prioritaire)
    const _fnRef = () => state.fullNightEog || state.fullNightEogFiltre;

    // --- Click-drag selection zoom ---
    let _fnDrag = { active: false, startX: 0 };

    canvas.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || !_fnRef()) return;
        e.preventDefault();
        const r = canvas.getBoundingClientRect();
        _fnDrag.startX = e.clientX - r.left;
        _fnDrag.active = true;
        if (selDiv) selDiv.style.display = 'none';
    });

    document.addEventListener('mousemove', (e) => {
        if (!_fnDrag.active) return;
        const r = canvas.getBoundingClientRect();
        const cur = e.clientX - r.left;
        const lo = Math.max(0, Math.min(_fnDrag.startX, cur));
        const hi = Math.min(r.width, Math.max(_fnDrag.startX, cur));
        if (hi - lo > 4 && selDiv) {
            selDiv.style.left = lo + 'px';
            selDiv.style.width = (hi - lo) + 'px';
            selDiv.style.display = 'block';
        }
    });

    document.addEventListener('mouseup', (e) => {
        if (!_fnDrag.active) return;
        _fnDrag.active = false;
        if (selDiv) selDiv.style.display = 'none';
        if (e.button !== 0 || !_fnRef()) return;

        const r = canvas.getBoundingClientRect();
        const cur = e.clientX - r.left;
        if (Math.abs(cur - _fnDrag.startX) < 6) {
            // Clic simple → naviguer vers l'epoch correspondante
            const sample = fnCssXToSample(canvas, cur);
            const refData = _fnRef();
            if (refData && sample >= 0 && sample < refData.length) {
                const maxEpoch = Math.floor(refData.length / CHUNK_SIZE) - 1;
                const newEpoch = Math.min(Math.floor(sample / CHUNK_SIZE), maxEpoch);
                if (newEpoch !== state.currentEpoch || state.currentEpochData.length === 0) {
                    state.currentEpoch = newEpoch;
                    const off = newEpoch * CHUNK_SIZE;
                    state.currentEpochData = Array.from(refData.slice(off, off + CHUNK_SIZE));
                    drawSignal(state.currentEpoch);
                    drawFullNight();
                    savePredictionsToIDB();
                }
            }
            return;
        }

        const s1 = fnCssXToSample(canvas, Math.min(_fnDrag.startX, cur));
        const s2 = fnCssXToSample(canvas, Math.max(_fnDrag.startX, cur));
        const total = _fnRef().length;

        let newStart = Math.max(0, Math.floor(s1));
        let newEnd = Math.min(total, Math.ceil(s2));
        let newVisible = newEnd - newStart;

        // Minimum 1 epoch de visible
        if (newVisible < CHUNK_SIZE) return;

        state.fnView.startSample = newStart;
        state.fnView.visibleSamples = newVisible;
        state.fnZoomLevel = total / newVisible;
        updateFullNightSlider();
        drawFullNight();
    });

    // --- Clic droit : reinitialiser le zoom ---
    canvas.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        resetFullNightZoom();
    });

    // --- Molette : defilement horizontal quand on est zoome ---
    canvas.addEventListener('wheel', (e) => {
        if (!_fnRef() || state.fnZoomLevel <= 1) return;
        e.preventDefault();

        const total = _fnRef().length;
        // Défiler de 2% de la zone visible par cran de molette
        const scrollAmount = Math.max(1, Math.round(state.fnView.visibleSamples * 0.02));
        const delta = e.deltaY > 0 ? scrollAmount : -scrollAmount;
        const maxStart = Math.max(0, total - state.fnView.visibleSamples);
        state.fnView.startSample = Math.max(0, Math.min(maxStart, state.fnView.startSample + delta));

        updateFullNightSlider();
        drawFullNight();
    }, { passive: false });

    // --- Scroll avec le slider ---
    if (slider) {
        slider.addEventListener('input', () => {
            if (!_fnRef()) return;
            const total = _fnRef().length;
            const maxStart = Math.max(0, total - state.fnView.visibleSamples);
            state.fnView.startSample = Math.round((slider.value / 1000) * maxStart);
            drawFullNight();
        });
    }

    // --- Boutons zoom ---
    document.getElementById('btnFnZoomIn')?.addEventListener('click', () => {
        if (!_fnRef()) return;
        const total = _fnRef().length;
        const oldVisible = state.fnView.visibleSamples;
        let newVisible = Math.round(oldVisible / 1.5);
        newVisible = Math.max(CHUNK_SIZE, newVisible);
        const center = state.fnView.startSample + oldVisible / 2;
        let newStart = Math.round(center - newVisible / 2);
        newStart = Math.max(0, Math.min(total - newVisible, newStart));
        state.fnView.startSample = newStart;
        state.fnView.visibleSamples = newVisible;
        state.fnZoomLevel = total / newVisible;
        updateFullNightSlider();
        drawFullNight();
    });

    document.getElementById('btnFnZoomOut')?.addEventListener('click', () => {
        if (!_fnRef()) return;
        const total = _fnRef().length;
        const oldVisible = state.fnView.visibleSamples;
        let newVisible = Math.round(oldVisible * 1.5);
        newVisible = Math.min(total, newVisible);
        const center = state.fnView.startSample + oldVisible / 2;
        let newStart = Math.round(center - newVisible / 2);
        newStart = Math.max(0, Math.min(total - newVisible, newStart));
        state.fnView.startSample = newStart;
        state.fnView.visibleSamples = newVisible;
        state.fnZoomLevel = total / newVisible;
        updateFullNightSlider();
        drawFullNight();
    });

    document.getElementById('btnFnZoomReset')?.addEventListener('click', () => {
        resetFullNightZoom();
    });

    // --- Checkboxes courbes ---
    document.getElementById('fnShowBrut')?.addEventListener('change', (e) => {
        state.fnShowBrut = e.target.checked;
        drawFullNight();
        saveUIParams();
    });
    document.getElementById('fnShowFiltre')?.addEventListener('change', (e) => {
        state.fnShowFiltre = e.target.checked;
        drawFullNight();
        saveUIParams();
    });

    // --- Mode separe / superpose ---
    document.getElementById('fnModeSeparate')?.addEventListener('click', () => {
        state.fnDisplayMode = 'separate';
        document.getElementById('fnModeSeparate').classList.add('fn-mode-active');
        document.getElementById('fnModeOverlay').classList.remove('fn-mode-active');
        drawFullNight();
        saveUIParams();
    });
    document.getElementById('fnModeOverlay')?.addEventListener('click', () => {
        state.fnDisplayMode = 'overlay';
        document.getElementById('fnModeOverlay').classList.add('fn-mode-active');
        document.getElementById('fnModeSeparate').classList.remove('fn-mode-active');
        drawFullNight();
        saveUIParams();
    });

    // --- Poignee de redimensionnement vertical ---
    const resizeHandle = document.getElementById('fullNightResizeHandle');
    if (resizeHandle) {
        let _resizing = false;
        let _resizeStartY = 0;
        let _resizeStartH = 0;

        resizeHandle.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            _resizing = true;
            _resizeStartY = e.clientY;
            _resizeStartH = state.fnCanvasHeight;
            document.body.style.cursor = 'ns-resize';
            document.body.style.userSelect = 'none';
        });

        document.addEventListener('mousemove', (e) => {
            if (!_resizing) return;
            const delta = e.clientY - _resizeStartY;
            const newH = Math.max(120, Math.min(800, _resizeStartH + delta));
            state.fnCanvasHeight = Math.round(newH);
            drawFullNight();
        });

        document.addEventListener('mouseup', () => {
            if (!_resizing) return;
            _resizing = false;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            saveUIParams();
        });
    }
}

// ============================================================================
// Canvas - Hypnogramme
// ============================================================================

// Retourne le nombre max d'epochs connu (toutes sources confondues)
function getMaxEpochs() {
    const dataLen = Math.max(state.predictions.length, state.annotations1.length, 1);
    // Pendant le streaming on montre le total estime (progression visible).
    // Apres streaming / import : on utilise la longueur reelle pour remplir le canvas.
    if (state.running) {
        return Math.max(state.totalEpochs, dataLen);
    }
    return dataLen;
}

// Convertit une coordonnee CSS X (relative au canvas) en indice d'epoch
function cssXToEpoch(canvas, cssX) {
    const scaleX = canvas.width / canvas.getBoundingClientRect().width;
    const canvasX = cssX * scaleX;
    const margin = { left: 50, right: 20 };
    const plotW = canvas.width - margin.left - margin.right;
    const zStart = state.hypnoZoom.start;
    const zEnd   = state.hypnoZoom.end ?? getMaxEpochs();
    const relX = canvasX - margin.left;
    if (relX <= 0) return zStart;
    if (relX >= plotW) return zEnd;
    return zStart + (relX / plotW) * (zEnd - zStart);
}

function resetHypnoZoom() {
    state.hypnoZoom.start = 0;
    state.hypnoZoom.end   = null;
    updateHypnoZoomUI();
    drawHypnogram();
}

// factor < 1 = zoom avant, factor > 1 = zoom arriere
function zoomHypno(factor) {
    const maxEp  = getMaxEpochs();
    const zStart = state.hypnoZoom.start;
    const zEnd   = state.hypnoZoom.end ?? maxEp;
    const center   = (zStart + zEnd) / 2;
    const halfSpan = ((zEnd - zStart) / 2) * factor;
    const newStart = Math.max(0,     Math.round(center - halfSpan));
    const newEnd   = Math.min(maxEp, Math.round(center + halfSpan));
    if (newEnd - newStart < 2) return;  // trop petit, ignorer
    state.hypnoZoom.start = newStart;
    state.hypnoZoom.end   = (newStart === 0 && newEnd === maxEp) ? null : newEnd;
    updateHypnoZoomUI();
    drawHypnogram();
}

function updateHypnoZoomUI() {
    const maxEp  = getMaxEpochs();
    const zStart = state.hypnoZoom.start;
    const zEnd   = state.hypnoZoom.end ?? maxEp;
    const isZoomed = zStart > 0 || state.hypnoZoom.end !== null;
    document.getElementById('btnZoomReset').disabled = !isZoomed;
    const infoEl = document.getElementById('hypnoZoomInfo');
    if (isZoomed) {
        infoEl.textContent =
            `${formatTime(zStart * 30)} - ${formatTime(zEnd * 30)}` +
            `  (${zEnd - zStart} epochs / ${formatDuration(zEnd - zStart)})`;
    } else {
        infoEl.textContent = '';
    }
    saveUIParams();
}

function drawHypnogram() {
    const canvas = document.getElementById('hypnogramCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const rect = canvas.parentElement.getBoundingClientRect();
    if (rect.width < 50) return; // element cache ou trop etroit
    canvas.width = rect.width - 40;

    // Extra bands below the hypnogram
    const hasConfidence = state.predictions.some(p => p.confidence !== undefined);
    const hasAnnotators = state.predictions.some(p => p.annot1 && p.annot2);
    const extraBands = (hasConfidence ? 30 : 0) + (hasAnnotators ? 26 : 0);
    canvas.height = 310 + extraBands;

    const w = canvas.width;
    const h = canvas.height;
    const margin = { top: 40, bottom: 30 + extraBands, left: 50, right: 20 };
    const plotW = w - margin.left - margin.right;
    const plotH = h - margin.top - margin.bottom;

    ctx.fillStyle = '#2a2f38';
    ctx.fillRect(0, 0, w, h);

    const allEpochs = getMaxEpochs();
    const zStart    = state.hypnoZoom.start;
    const zEnd      = state.hypnoZoom.end ?? allEpochs;
    const visEpochs = Math.max(1, zEnd - zStart);
    const epochW    = plotW / visEpochs;

    // Positions Y equidistantes pour chaque stage
    const stageOrder = ['Wake', 'REM', 'N1', 'N2', 'N3'];
    const stageY = {};
    stageOrder.forEach((name, i) => {
        stageY[name] = margin.top + (i / (stageOrder.length - 1)) * plotH;
    });

    // Labels Y
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'right';
    for (const [name, y] of Object.entries(stageY)) {
        ctx.fillStyle = STAGE_COLORS[name] || '#9aa0a6';
        ctx.fillText(name, margin.left - 6, y + 4);
    }

    // Grille horizontale
    ctx.strokeStyle = '#3a3f4a';
    ctx.lineWidth = 0.5;
    ctx.setLineDash([]);
    for (const y of Object.values(stageY)) {
        ctx.beginPath();
        ctx.moveTo(margin.left, y);
        ctx.lineTo(w - margin.right, y);
        ctx.stroke();
    }

    // Bandes de cycles (fond semi-transparent, avant les step lines)
    drawCycleBands(ctx, margin, epochW, zStart, zEnd, plotH);

    // Checkboxes de visibilite
    const showA2 = document.getElementById('hypnoShowA2')?.checked !== false;
    const showA1 = document.getElementById('hypnoShowA1')?.checked !== false;
    const showNeuralix = document.getElementById('hypnoShowNeuralix')?.checked !== false;

    // Annotateur 2 (vert, pointilles courts) — dessinee en premier (fond)
    if (showA2) {
        drawHypnogramStepLine(ctx, state.annotations2, stageY, margin, epochW, zStart, zEnd,
                              '#22c55e', 1.5, [3, 3]);
    }

    // Annotateur 1 (rouge, pointilles longs)
    if (showA1) {
        drawHypnogramStepLine(ctx, state.annotations1, stageY, margin, epochW, zStart, zEnd,
                              '#ef4444', 1.5, [6, 3]);
    }

    // Predictions ESP32 / Neuralix (bleu, trait plein) — au premier plan
    if (showNeuralix) {
        drawHypnogramStepLine(ctx, state.predictions.map(p => p.name), stageY, margin, epochW, zStart, zEnd,
                              '#3b82f6', 2.5, []);
    }

    // Masque : assombrir les epochs exclues par le filtre stats ET/OU le seuil de confiance
    const confThreshold = state.confidenceThreshold / 100;
    const maskOpacity = (parseInt(document.getElementById('hypnoMaskOpacity')?.value) || 0) / 100;
    const filterFn = STATS_FILTERS[state.statsFilter]?.fn || (() => true);
    const hasFilter = state.statsFilter !== 'all';
    if (maskOpacity > 0 && state.predictions.length > 0 && (confThreshold > 0 || hasFilter)) {
        ctx.fillStyle = `rgba(26, 29, 35, ${maskOpacity})`;
        for (let i = zStart; i < zEnd && i < state.predictions.length; i++) {
            const p = state.predictions[i];
            const belowConf = confThreshold > 0 && p.confidence !== undefined && p.confidence < confThreshold;
            const excludedByFilter = hasFilter && !filterFn(p);
            if (belowConf || excludedByFilter) {
                const x = margin.left + (i - zStart) * epochW;
                ctx.fillRect(x, margin.top, epochW, plotH);
            }
        }
    }

    // Marqueur de position courante
    if (state.running && state.currentEpoch >= zStart && state.currentEpoch < zEnd) {
        const markerX = margin.left + (state.currentEpoch - zStart) * epochW;
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(markerX, margin.top);
        ctx.lineTo(markerX, h - margin.bottom);
        ctx.stroke();
        ctx.setLineDash([]);
    }

    // Axe temps (affiche les temps reels de la zone visible)
    ctx.fillStyle = '#6b7280';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    const timeSteps = Math.min(10, visEpochs);
    for (let i = 0; i <= timeSteps; i++) {
        const epoch = zStart + Math.floor(i * visEpochs / timeSteps);
        const x = margin.left + (epoch - zStart) * epochW;
        ctx.fillText(formatTime(epoch * 30), x, h - 8);
    }

    // Legende (bandeau superieur) — seulement les lignes visibles
    const legendItems = [];
    if (showNeuralix) legendItems.push({ color: '#3b82f6', dash: [],    label: 'Neuralix (ESP32)' });
    if (showA1)       legendItems.push({ color: '#ef4444', dash: [6, 3], label: 'Annotateur 1' });
    if (showA2)       legendItems.push({ color: '#22c55e', dash: [3, 3], label: 'Annotateur 2' });
    let lx = margin.left;
    const ly = 14;
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';
    for (const item of legendItems) {
        ctx.strokeStyle = item.color;
        ctx.lineWidth = 2;
        ctx.setLineDash(item.dash);
        ctx.beginPath();
        ctx.moveTo(lx, ly);
        ctx.lineTo(lx + 20, ly);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#d1d5db';
        ctx.fillText(item.label, lx + 24, ly + 4);
        lx += 130;
    }

    // Indicateur des filtres actifs sur l'hypnogramme
    if (maskOpacity > 0 && (confThreshold > 0 || hasFilter)) {
        ctx.fillStyle = `rgba(26, 29, 35, ${maskOpacity})`;
        ctx.fillRect(lx, ly - 6, 14, 12);
        ctx.fillStyle = '#9aa0a6';
        ctx.font = '10px sans-serif';
        const parts = [];
        if (confThreshold > 0) parts.push(`Conf. < ${state.confidenceThreshold}%`);
        if (hasFilter) parts.push(STATS_FILTERS[state.statsFilter]?.label || state.statsFilter);
        ctx.fillText(parts.join(' + '), lx + 18, ly + 4);
    }

    // Label "Confiance" / "Accord" dans la marge gauche
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillStyle = '#9aa0a6';

    // Bande de confiance sous l'hypnogramme
    if (hasConfidence) {
        const bandY = h - margin.bottom + 4;
        drawConfidenceBand(ctx, margin, epochW, zStart, zEnd, bandY, 22);
    }

    // Bande accord/désaccord annotateurs
    if (hasAnnotators) {
        const bandY = h - margin.bottom + (hasConfidence ? 32 : 4);
        drawDisagreementBand(ctx, margin, epochW, zStart, zEnd, bandY, 18);
    }

    // Afficher/masquer la legende des bandes (par groupe)
    const hasCycles = detectSleepCycles().length > 0;
    const legendEl = document.getElementById('hypnoBandLegend');
    if (legendEl) {
        legendEl.style.display = (hasCycles || hasConfidence || hasAnnotators) ? 'flex' : 'none';
        const gc = document.getElementById('legendCycles');
        const gf = document.getElementById('legendConfidence');
        const ga = document.getElementById('legendAnnot');
        if (gc) gc.style.display = hasCycles ? 'flex' : 'none';
        if (gf) gf.style.display = hasConfidence ? 'flex' : 'none';
        if (ga) ga.style.display = hasAnnotators ? 'flex' : 'none';
    }
}

// Trace un hypnogramme en escalier pour une serie de donnees.
// data : tableau de noms de stage ('Wake', 'N1', ...)
// Chaque epoch est representee par un segment horizontal; les transitions sont verticales.
// zStart/zEnd : indices d'epoch de la zone visible (zoom).
// Seuls les epochs dans [zStart, zEnd) sont traces.
function drawHypnogramStepLine(ctx, data, stageY, margin, epochW, zStart, zEnd, color, lineWidth, dashPattern) {
    if (!data || data.length === 0) return;

    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.setLineDash(dashPattern);

    let started = false;

    for (let i = zStart; i < zEnd && i < data.length; i++) {
        const name = data[i];
        if (!name || stageY[name] === undefined) continue;

        const x    = margin.left + (i - zStart) * epochW;
        const xEnd = margin.left + (i - zStart + 1) * epochW;
        const y    = stageY[name];

        if (!started) {
            ctx.moveTo(x, y);
            started = true;
        } else {
            ctx.lineTo(x, y); // transition verticale
        }
        ctx.lineTo(xEnd, y); // segment horizontal
    }

    ctx.stroke();
    ctx.setLineDash([]);
}

// ============================================================================
// Utilitaires
// ============================================================================

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Convertit un nombre d'epochs (1 epoch = 30s) en chaine "Xh Ymin Zs"
function formatDuration(epochs) {
    const totalSec = epochs * 30;
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0 && s === 0) return `${h}h ${m}min`;
    if (h > 0)            return `${h}h ${m}min ${s}s`;
    if (m > 0 && s === 0) return `${m}min`;
    if (m > 0)            return `${m}min ${s}s`;
    return `${s}s`;
}

// Renvoie le HTML "duree_stade <sep> duree_totale"
function durHtml(stageEpochs, totalEpochs) {
    if (totalEpochs === 0) return '';
    return `${formatDuration(stageEpochs)}<span class="dur-sep">/</span>${formatDuration(totalEpochs)}`;
}

function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
}

function getStageClass(name) {
    if (!name) return '';
    if (name === 'Wake') return 'W';
    return name;
}

// ============================================================================
// Sauvegarde / Chargement de session
// ============================================================================

/**
 * Exporte toute la session en cours au format JSON.
 * Le fichier contient les predictions, annotations, stats et metadonnees.
 * Peut etre rechargé sans ESP32 connecté via importSession().
 */
function exportSession() {
    if (state.predictions.length === 0) {
        log('Aucune prediction a sauvegarder', 'error');
        return;
    }

    const timestamp = new Date().toISOString();
    const data = {
        version: 1,
        neuralix: true,
        timestamp: timestamp,
        session: {
            fileName: state.fileRef ? state.fileRef.name : 'inconnu',
            totalEpochs: state.totalEpochs,
            epochsProcessed: state.predictions.length,
        },
        predictions: state.predictions,
        annotations1: state.annotations1,
        annotations2: state.annotations2,
        stats: {
            matchesA1: state.matchesA1,
            matchesA2: state.matchesA2,
            totalCompared: state.totalCompared,
            totalTimeMs: state.totalTimeMs,
        },
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    const dateStr = timestamp.slice(0, 19).replace(/[T:]/g, '-');
    a.href     = url;
    a.download = `neuralix_session_${dateStr}.json`;
    a.click();
    URL.revokeObjectURL(url);
    log(`Session sauvegardee: ${state.predictions.length} epochs`, 'info');
}

/**
 * Charge une session precedemment sauvegardee (.json).
 * Restaure les predictions, annotations, historique et hypnogramme.
 * Ne necessite pas de connexion ESP32.
 */
async function importSession(file) {
    try {
        const text = await file.text();
        const data = JSON.parse(text);

        if (!data.neuralix) {
            log('Fichier invalide: pas une session Neuralix', 'error');
            return;
        }

        // Restaurer l'etat
        state.predictions     = data.predictions    || [];
        state.annotations1    = data.annotations1   || [];
        state.annotations2    = data.annotations2   || [];

        // Reconstruire annotations si absentes (V3-RT stocke annot1/annot2 dans predictions)
        if (state.annotations1.length === 0 && state.predictions.length > 0) {
            state.annotations1 = state.predictions.map(p => p.annot1 || null);
        }
        if (state.annotations2.length === 0 && state.predictions.length > 0) {
            state.annotations2 = state.predictions.map(p => p.annot2 || null);
        }
        state.matchesA1       = data.stats.matchesA1      || 0;
        state.matchesA2       = data.stats.matchesA2      || 0;
        state.totalCompared   = data.stats.totalCompared  || 0;
        state.totalTimeMs     = data.stats.totalTimeMs    || 0;
        state.totalEpochs     = data.session.totalEpochs  || state.predictions.length;
        state.currentEpoch    = state.predictions.length  - 1;

        // S'assurer que matchA1/matchA2 sont presents (calcul si absent)
        for (const r of state.predictions) {
            if (r.matchA1 === undefined)
                r.matchA1 = r.annot1 ? (r.name === r.annot1) : null;
            if (r.matchA2 === undefined)
                r.matchA2 = r.annot2 ? (r.name === r.annot2) : null;
        }

        // Reconstruire le tableau d'historique (respecte le filtre actif)
        rebuildHistoryTable();

        // Si le signal EOG en memoire ne correspond pas a cette session, le nettoyer
        const eogFileName = state.fileRef ? state.fileRef.name : _restoredFileName;
        if (eogFileName && data.session.fileName && eogFileName !== data.session.fileName) {
            state.fullNightEog = null;
            state.fullNightEogFiltre = null;
            state.fnZoomLevel = 1;
            state.fnView.startSample = 0;
            state.fnView.visibleSamples = 0;
            log(`Signal EOG efface (fichier different: ${eogFileName} vs ${data.session.fileName})`, 'info');
        }

        // Restaurer le signal de l'epoch courante pour le canvas Signal EOG
        const refEog = state.fullNightEog || state.fullNightEogFiltre;
        if (refEog && refEog.length >= CHUNK_SIZE) {
            // Extraire depuis le signal nuit complete
            const offset = state.currentEpoch * CHUNK_SIZE;
            state.currentEpochData = Array.from(refEog.slice(offset, offset + CHUNK_SIZE));
        } else if (state.predictions.length > 0 && state.predictions[0].eogData) {
            state.currentEpochData = state.predictions[0].eogData;
        }

        // Mettre a jour toute l'interface
        updateStats();
        updateFilteredStats();
        drawHypnogram();
        drawSignal(state.currentEpoch);
        drawFullNight();
        drawFrequencyAnalysis();
        updateSleepArchitecture();
        updateSleepCycles();
        updateAnnotatorAgreement();
        drawTransitionMatrix();
        updateSignalQuality();
        updateAdvancedAnalysis();
        updateFnCheckboxes();
        updateFullNightSlider();
        updateControls();

        // Afficher les infos de session
        const dateStr  = new Date(data.timestamp).toLocaleString('fr-FR');
        const infoDiv  = document.getElementById('sessionInfo');
        infoDiv.style.display = 'block';
        infoDiv.innerHTML =
            `Session chargee &mdash; Fichier: <b>${data.session.fileName}</b> &nbsp;|&nbsp; ` +
            `Date: <b>${dateStr}</b> &nbsp;|&nbsp; ` +
            `${state.predictions.length} epoch(s) sur ${state.totalEpochs}`;

        log(`Session chargee: ${data.session.fileName}`, 'info');
        log(`  ${state.predictions.length} epochs | ${dateStr}`, 'info');
        if (state.totalCompared > 0) {
            log(`  Précision A1: ${(state.matchesA1/state.totalCompared*100).toFixed(1)}%` +
                ` | A2: ${(state.matchesA2/state.totalCompared*100).toFixed(1)}%`, 'info');
        }

        savePredictionsToIDB();

    } catch (e) {
        log(`Erreur chargement session: ${e.message}`, 'error');
    }
}

/**
 * Exporte les resultats en CSV (ouvert facilement dans Excel/LibreOffice).
 * Colonnes: Epoch, Temps, ESP32, Annot1, Annot2, Confiance(%), Temps_ms, MatchA1, MatchA2
 */
function exportCSV() {
    if (state.predictions.length === 0) {
        log('Aucune prediction a exporter', 'error');
        return;
    }

    const rows = ['Epoch,Temps,ESP32,Annotateur1,Annotateur2,Confiance(%),Temps_ms,MatchA1,MatchA2'];
    for (const p of state.predictions) {
        rows.push([
            p.epoch + 1,
            formatTime((p.epoch + 1) * 30),
            p.name,
            p.annot1 || '',
            p.annot2 || '',
            (p.confidence * 100).toFixed(1),
            p.time_ms,
            p.matchA1 !== null ? (p.matchA1 ? 1 : 0) : '',
            p.matchA2 !== null ? (p.matchA2 ? 1 : 0) : '',
        ].join(','));
    }

    const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `neuralix_resultats_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    log(`CSV exporte: ${state.predictions.length} lignes`, 'info');
}

/**
 * Exporte le canvas hypnogramme en image PNG.
 */
function exportHypnogram() {
    const canvas = document.getElementById('hypnogramCanvas');
    const url    = canvas.toDataURL('image/png');
    const a      = document.createElement('a');
    a.href       = url;
    a.download   = `neuralix_hypnogramme_${new Date().toISOString().slice(0, 10)}.png`;
    a.click();
    log('Hypnogramme exporte en PNG', 'info');
}

// ============================================================================
// Architecture du sommeil
// ============================================================================

function computeSleepArchitecture() {
    const preds = state.predictions;
    if (preds.length === 0) return null;

    const stages = preds.map(p => p.name);
    const totalEpochs = stages.length;
    const totalMinutes = totalEpochs * 0.5;

    // Sleep onset: first non-Wake epoch
    let sleepOnsetIdx = -1;
    for (let i = 0; i < stages.length; i++) {
        if (stages[i] !== 'Wake') { sleepOnsetIdx = i; break; }
    }

    // Sleep offset: last non-Wake epoch
    let sleepOffsetIdx = -1;
    for (let i = stages.length - 1; i >= 0; i--) {
        if (stages[i] !== 'Wake') { sleepOffsetIdx = i; break; }
    }

    const sleepLatency = sleepOnsetIdx >= 0 ? sleepOnsetIdx * 0.5 : null;

    // REM latency (from sleep onset to first REM)
    let remLatencyIdx = -1;
    if (sleepOnsetIdx >= 0) {
        for (let i = sleepOnsetIdx; i < stages.length; i++) {
            if (stages[i] === 'REM') { remLatencyIdx = i; break; }
        }
    }
    const remLatency = (sleepOnsetIdx >= 0 && remLatencyIdx >= 0)
        ? (remLatencyIdx - sleepOnsetIdx) * 0.5 : null;

    // Stage counts
    const counts = { Wake: 0, N1: 0, N2: 0, N3: 0, REM: 0 };
    for (const s of stages) counts[s] = (counts[s] || 0) + 1;

    // TST
    const tstEpochs = totalEpochs - counts.Wake;
    const tst = tstEpochs * 0.5;

    // WASO (Wake between sleep onset and offset)
    let wasoEpochs = 0;
    if (sleepOnsetIdx >= 0 && sleepOffsetIdx >= 0) {
        for (let i = sleepOnsetIdx; i <= sleepOffsetIdx; i++) {
            if (stages[i] === 'Wake') wasoEpochs++;
        }
    }
    const waso = wasoEpochs * 0.5;

    // Sleep efficiency
    const sleepPeriod = (sleepOnsetIdx >= 0 && sleepOffsetIdx >= 0)
        ? (sleepOffsetIdx - sleepOnsetIdx + 1) * 0.5 : 0;
    const sleepEfficiency = sleepPeriod > 0
        ? ((sleepPeriod - waso) / totalMinutes) * 100 : 0;

    // Micro-arousals: transitions to Wake after sleep onset
    let microArousals = 0;
    if (sleepOnsetIdx >= 0) {
        for (let i = sleepOnsetIdx + 1; i <= (sleepOffsetIdx >= 0 ? sleepOffsetIdx : stages.length - 1); i++) {
            if (stages[i] === 'Wake' && stages[i - 1] !== 'Wake') microArousals++;
        }
    }

    return {
        tst, sleepLatency, remLatency, sleepEfficiency,
        waso, microArousals, totalMinutes,
        counts, tstEpochs, totalEpochs, sleepOnsetIdx, sleepOffsetIdx
    };
}

function updateSleepArchitecture() {
    const grid = document.getElementById('sleepArchGrid');
    if (!grid) return;
    const arch = computeSleepArchitecture();

    if (!arch) {
        grid.innerHTML = '<div style="color:#6b7280;padding:8px;">Aucune prédiction disponible.</div>';
        _drawStageDurationEmpty();
        return;
    }

    grid.innerHTML = '';
    const cards = [
        { label: 'Temps de sommeil total (TST)', value: `${arch.tst.toFixed(0)} min`, sub: formatDuration(arch.tstEpochs) },
        { label: 'Efficacité du sommeil', value: `${arch.sleepEfficiency.toFixed(1)}%`, sub: '' },
        { label: 'Latence d\'endormissement', value: arch.sleepLatency !== null ? `${arch.sleepLatency.toFixed(1)} min` : '--', sub: '' },
        { label: 'Latence REM', value: arch.remLatency !== null ? `${arch.remLatency.toFixed(1)} min` : '--', sub: '' },
        { label: 'WASO', value: `${arch.waso.toFixed(1)} min`, sub: `${(arch.waso / arch.totalMinutes * 100).toFixed(1)}% du temps total` },
        { label: 'Micro-éveils', value: arch.microArousals, sub: '' },
    ];

    for (const c of cards) {
        const card = document.createElement('div');
        card.className = 'stat-card';
        card.innerHTML = `
            <div class="stat-label">${c.label}</div>
            <div class="stat-value">${c.value}</div>
            ${c.sub ? `<div class="stat-duration">${c.sub}</div>` : ''}
        `;
        grid.appendChild(card);
    }

    drawStageDurationBars(arch);
}

function drawStageDurationBars(arch) {
    const canvas = document.getElementById('stageDurationCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const rect = canvas.parentElement.getBoundingClientRect();
    if (rect.width < 50) return;
    canvas.width = rect.width;
    canvas.height = 160;

    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = '#2a2f38';
    ctx.fillRect(0, 0, w, h);

    if (!arch || arch.totalEpochs === 0) return;

    const margin = { left: 80, right: 20, top: 20, bottom: 40 };
    const barH = 35;
    const barW = w - margin.left - margin.right;

    let x = margin.left;
    const barY = margin.top;
    const stageOrder = ['Wake', 'N1', 'N2', 'N3', 'REM'];

    for (const stage of stageOrder) {
        const count = arch.counts[stage] || 0;
        if (count === 0) continue;
        const segW = (count / arch.totalEpochs) * barW;
        ctx.fillStyle = STAGE_COLORS[stage];
        ctx.fillRect(x, barY, segW, barH);
        if (segW > 40) {
            ctx.fillStyle = '#1a1d23';
            ctx.font = 'bold 11px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(stage, x + segW / 2, barY + barH / 2 + 4);
        }
        x += segW;
    }

    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    let lx = margin.left;
    const ly = barY + barH + 20;
    const colW = barW / 5;

    for (const stage of STAGE_NAMES) {
        const count = arch.counts[stage] || 0;
        const mins = (count * 0.5).toFixed(0);
        const pct = arch.tstEpochs > 0
            ? ((count / arch.tstEpochs) * 100).toFixed(1) : '0.0';
        ctx.fillStyle = STAGE_COLORS[stage];
        ctx.fillRect(lx + colW / 2 - 6, ly - 8, 12, 12);
        ctx.fillStyle = '#e8eaed';
        ctx.fillText(`${stage}: ${mins} min (${pct}%)`, lx + colW / 2, ly + 16);
        lx += colW;
    }
}

function _drawStageDurationEmpty() {
    const canvas = document.getElementById('stageDurationCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const rect = canvas.parentElement.getBoundingClientRect();
    if (rect.width < 50) return;
    canvas.width = rect.width;
    canvas.height = 160;
    ctx.fillStyle = '#2a2f38';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#6b7280';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Aucune prédiction disponible', canvas.width / 2, canvas.height / 2);
}

// ============================================================================
// Cycles de sommeil
// ============================================================================

function detectSleepCycles() {
    const preds = state.predictions;
    if (preds.length === 0) return [];

    const stages = preds.map(p => p.name);
    const cycles = [];

    let sleepOnset = -1;
    for (let i = 0; i < stages.length; i++) {
        if (stages[i] !== 'Wake') { sleepOnset = i; break; }
    }
    if (sleepOnset < 0) return [];

    let inNREM = false;
    let nremStart = -1;
    let remStart = -1;
    const MIN_NREM_EPOCHS = 5;  // 2.5 min min de NREM
    const MIN_REM_EPOCHS = 2;   // 1 min min de REM

    let nremCount = 0;
    let remCount = 0;

    for (let i = sleepOnset; i < stages.length; i++) {
        const s = stages[i];
        const isNREM = (s === 'N1' || s === 'N2' || s === 'N3');
        const isREM = (s === 'REM');

        if (!inNREM && isNREM) {
            inNREM = true;
            nremStart = i;
            nremCount = 1;
            remCount = 0;
        } else if (inNREM && isNREM) {
            nremCount++;
        } else if (inNREM && isREM) {
            if (nremCount >= MIN_NREM_EPOCHS) {
                if (remStart < 0) remStart = i;
                remCount++;
            }
        } else if (inNREM && !isNREM && !isREM) {
            if (remCount >= MIN_REM_EPOCHS) {
                cycles.push({
                    start: nremStart,
                    end: i - 1,
                    nremStart: nremStart,
                    remEnd: i - 1,
                    durationMin: (i - nremStart) * 0.5
                });
            }
            inNREM = false;
            nremStart = -1;
            remStart = -1;
            nremCount = 0;
            remCount = 0;
        }
    }

    // Fermer le dernier cycle s'il se termine par du REM
    if (remCount >= MIN_REM_EPOCHS && nremStart >= 0) {
        cycles.push({
            start: nremStart,
            end: stages.length - 1,
            nremStart: nremStart,
            remEnd: stages.length - 1,
            durationMin: (stages.length - nremStart) * 0.5
        });
    }

    return cycles;
}

function updateSleepCycles() {
    const grid = document.getElementById('sleepCyclesGrid');
    const tbody = document.getElementById('cyclesBody');
    if (!grid || !tbody) return;

    const cycles = detectSleepCycles();
    grid.innerHTML = '';
    tbody.innerHTML = '';

    if (cycles.length === 0) {
        grid.innerHTML = '<div style="color:#6b7280;padding:8px;">Aucun cycle détecté.</div>';
        return;
    }

    const avgDur = cycles.reduce((s, c) => s + c.durationMin, 0) / cycles.length;

    const cards = [
        { label: 'Nombre de cycles', value: cycles.length },
        { label: 'Durée moyenne', value: `${avgDur.toFixed(0)} min` },
        { label: 'Durée min', value: `${Math.min(...cycles.map(c => c.durationMin)).toFixed(0)} min` },
        { label: 'Durée max', value: `${Math.max(...cycles.map(c => c.durationMin)).toFixed(0)} min` },
    ];

    for (const c of cards) {
        const card = document.createElement('div');
        card.className = 'stat-card';
        card.innerHTML = `
            <div class="stat-label">${c.label}</div>
            <div class="stat-value">${c.value}</div>
        `;
        grid.appendChild(card);
    }

    for (let ci = 0; ci < cycles.length; ci++) {
        const c = cycles[ci];
        let nEp = 0, rEp = 0;
        for (let i = c.start; i <= c.end; i++) {
            const s = state.predictions[i]?.name;
            if (s === 'N1' || s === 'N2' || s === 'N3') nEp++;
            else if (s === 'REM') rEp++;
        }
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${ci + 1}</td>
            <td>${formatTime(c.start * 30)}</td>
            <td>${formatTime(c.end * 30)}</td>
            <td>${c.durationMin.toFixed(0)} min</td>
            <td>${(nEp * 0.5).toFixed(0)} min</td>
            <td>${(rEp * 0.5).toFixed(0)} min</td>
        `;
        tbody.appendChild(row);
    }
}

function drawCycleBands(ctx, margin, epochW, zStart, zEnd, plotH) {
    const cycles = detectSleepCycles();
    if (cycles.length === 0) return;

    const cycleColors = [
        'rgba(74, 158, 255, 0.08)',
        'rgba(52, 211, 153, 0.08)',
        'rgba(251, 191, 36, 0.08)',
        'rgba(168, 85, 247, 0.08)',
        'rgba(236, 72, 153, 0.08)',
    ];

    for (let ci = 0; ci < cycles.length; ci++) {
        const c = cycles[ci];
        if (c.end < zStart || c.start >= zEnd) continue;

        const xStart = margin.left + Math.max(0, c.start - zStart) * epochW;
        const xEnd = margin.left + Math.min(c.end - zStart + 1, zEnd - zStart) * epochW;

        ctx.fillStyle = cycleColors[ci % cycleColors.length];
        ctx.fillRect(xStart, margin.top, xEnd - xStart, plotH);

        ctx.fillStyle = '#9aa0a680';
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`C${ci + 1}`, (xStart + xEnd) / 2, margin.top + 12);
    }
}

// ============================================================================
// Spectrogramme (temps-frequence)
// ============================================================================

async function computeSpectrogram(signal, windowSize, hopSize, maxFreq) {
    const N = windowSize;
    const halfN = N / 2;
    const hop = hopSize;

    const win = new Float64Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)));

    const maxBin = Math.min(halfN, Math.ceil(maxFreq * N / SAMPLE_RATE));
    const nFrames = Math.floor((signal.length - N) / hop) + 1;

    const freqs = new Float64Array(maxBin);
    for (let i = 0; i < maxBin; i++) freqs[i] = i * SAMPLE_RATE / N;

    const times = new Float64Array(nFrames);
    const power = [];

    for (let frame = 0; frame < nFrames; frame++) {
        const start = frame * hop;
        times[frame] = (start + N / 2) / SAMPLE_RATE;

        const re = new Float64Array(N);
        const im = new Float64Array(N);
        for (let i = 0; i < N; i++) re[i] = signal[start + i] * win[i];
        fft(re, im);

        const framePower = new Float64Array(maxBin);
        for (let i = 0; i < maxBin; i++) {
            framePower[i] = 10 * Math.log10(Math.max(
                (re[i] * re[i] + im[i] * im[i]) / (N * N), 1e-20));
        }
        power.push(framePower);

        if (frame % 100 === 0 && frame > 0) {
            await new Promise(r => requestAnimationFrame(r));
            const pct = ((frame / nFrames) * 100).toFixed(0);
            const statusEl = document.getElementById('spectroStatus');
            if (statusEl) statusEl.textContent = `Calcul: ${pct}%...`;
        }
    }

    return { times, freqs, power, nFrames, maxBin };
}

function heatmapColor(t) {
    let r, g, b;
    if (t < 0.33) {
        const s = t / 0.33;
        r = 0; g = Math.floor(255 * s); b = 255;
    } else if (t < 0.66) {
        const s = (t - 0.33) / 0.33;
        r = Math.floor(255 * s); g = 255; b = Math.floor(255 * (1 - s));
    } else {
        const s = (t - 0.66) / 0.34;
        r = 255; g = Math.floor(255 * (1 - s)); b = 0;
    }
    return [r, g, b];
}

function drawSpectrogram(canvas, spectro, label) {
    if (!canvas || !spectro) return;
    const ctx = canvas.getContext('2d');
    const rect = canvas.parentElement.getBoundingClientRect();
    if (rect.width < 50) return;
    canvas.width = rect.width;
    canvas.height = 300;

    const w = canvas.width, h = canvas.height;
    const margin = { top: 20, bottom: 35, left: 50, right: 60 };
    const plotW = w - margin.left - margin.right;
    const plotH = h - margin.top - margin.bottom;

    ctx.fillStyle = '#2a2f38';
    ctx.fillRect(0, 0, w, h);

    // Zoom : plage de frames visibles
    const zStart = state.spectroZoom.startFrame;
    const zEnd = state.spectroZoom.endFrame ?? spectro.nFrames;
    const visFrames = Math.max(1, zEnd - zStart);

    let minDb = Infinity, maxDb = -Infinity;
    for (let f = zStart; f < zEnd && f < spectro.power.length; f++) {
        const frame = spectro.power[f];
        for (let i = 1; i < frame.length; i++) {
            if (frame[i] < minDb) minDb = frame[i];
            if (frame[i] > maxDb) maxDb = frame[i];
        }
    }
    const dbRange = maxDb - minDb || 1;

    // Heatmap via ImageData (seulement la plage zoomee)
    const imgData = ctx.createImageData(plotW, plotH);
    const data = imgData.data;

    for (let px = 0; px < plotW; px++) {
        const frameIdx = zStart + Math.floor((px / plotW) * visFrames);
        const frame = spectro.power[Math.min(frameIdx, spectro.nFrames - 1)];

        for (let py = 0; py < plotH; py++) {
            const binIdx = Math.floor(((plotH - 1 - py) / plotH) * spectro.maxBin);
            const db = frame[Math.min(binIdx, frame.length - 1)];
            const norm = Math.max(0, Math.min(1, (db - minDb) / dbRange));

            const [r, g, b] = heatmapColor(norm);
            const idx = (py * plotW + px) * 4;
            data[idx] = r;
            data[idx + 1] = g;
            data[idx + 2] = b;
            data[idx + 3] = 255;
        }
    }

    ctx.putImageData(imgData, margin.left, margin.top);

    // Marqueurs bandes de frequence
    const maxFreq = spectro.freqs[spectro.freqs.length - 1];
    for (const band of FREQ_BANDS) {
        if (band.lo > maxFreq) continue;
        const y1 = margin.top + plotH - (Math.min(band.hi, maxFreq) / maxFreq) * plotH;
        const y2 = margin.top + plotH - (band.lo / maxFreq) * plotH;
        ctx.strokeStyle = band.border;
        ctx.lineWidth = 0.8;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(margin.left, y1);
        ctx.lineTo(margin.left + plotW, y1);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = band.border;
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(band.name, margin.left + plotW + 4, (y1 + y2) / 2 + 3);
    }

    // Axe Y (frequence)
    ctx.fillStyle = '#6b7280';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    const freqTicks = [0, 4, 8, 13, 20, 30, 50];
    for (const f of freqTicks) {
        if (f > maxFreq) break;
        const y = margin.top + plotH - (f / maxFreq) * plotH;
        ctx.fillText(f + ' Hz', margin.left - 4, y + 3);
    }

    // Axe X (temps de la zone visible)
    ctx.fillStyle = '#6b7280';
    ctx.textAlign = 'center';
    const startSec = spectro.times[zStart] || 0;
    const endSec = spectro.times[Math.min(zEnd - 1, spectro.times.length - 1)] || 0;
    const visDuration = endSec - startSec;
    const nTicks = Math.min(10, Math.max(2, Math.floor(visDuration / 600)));
    for (let i = 0; i <= nTicks; i++) {
        const sec = startSec + (i / nTicks) * visDuration;
        const x = margin.left + (i / nTicks) * plotW;
        ctx.fillText(formatTime(Math.floor(sec)), x, h - 10);
    }

    // Titre
    ctx.fillStyle = '#9aa0a6';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(label, margin.left + 4, margin.top - 6);

    // Colorbar
    const cbX = margin.left + plotW + 35;
    const cbW = 12;
    for (let i = 0; i < plotH; i++) {
        const norm = 1 - i / plotH;
        const [r, g, b] = heatmapColor(norm);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(cbX, margin.top + i, cbW, 1);
    }
    ctx.fillStyle = '#6b7280';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`${maxDb.toFixed(0)} dB`, cbX + cbW + 3, margin.top + 8);
    ctx.fillText(`${minDb.toFixed(0)} dB`, cbX + cbW + 3, margin.top + plotH);
}

/** Convertit une position CSS X sur un canvas spectro en indice de frame. */
function spectroCssXToFrame(canvas, cssX, spectro) {
    if (!spectro) return 0;
    const scaleX = canvas.width / canvas.getBoundingClientRect().width;
    const canvasX = cssX * scaleX;
    const margin = { left: 50, right: 60 };
    const plotW = canvas.width - margin.left - margin.right;
    const zStart = state.spectroZoom.startFrame;
    const zEnd = state.spectroZoom.endFrame ?? spectro.nFrames;
    const relX = canvasX - margin.left;
    if (relX <= 0) return zStart;
    if (relX >= plotW) return zEnd;
    return zStart + (relX / plotW) * (zEnd - zStart);
}

/** Redessine les deux spectrogrammes depuis le cache. */
function redrawSpectrograms() {
    if (state._cachedSpectroBrut)
        drawSpectrogram(document.getElementById('spectroCanvasBrut'), state._cachedSpectroBrut, 'EOG brut');
    if (state._cachedSpectroFiltre)
        drawSpectrogram(document.getElementById('spectroCanvasFiltre'), state._cachedSpectroFiltre, 'EOG filtré');
    updateSpectroZoomUI();
}

/** Met a jour l'UI du zoom spectrogramme (bouton reset, info). */
function updateSpectroZoomUI() {
    const spectro = state._cachedSpectroBrut || state._cachedSpectroFiltre;
    if (!spectro) return;
    const zStart = state.spectroZoom.startFrame;
    const zEnd = state.spectroZoom.endFrame ?? spectro.nFrames;
    const isZoomed = zStart > 0 || state.spectroZoom.endFrame !== null;
    const btnReset = document.getElementById('btnSpectroZoomReset');
    if (btnReset) btnReset.disabled = !isZoomed;
    const infoEl = document.getElementById('spectroZoomInfo');
    if (infoEl) {
        if (isZoomed) {
            const startSec = spectro.times[zStart] || 0;
            const endSec = spectro.times[Math.min(zEnd - 1, spectro.times.length - 1)] || 0;
            infoEl.textContent = `${formatTime(Math.floor(startSec))} - ${formatTime(Math.floor(endSec))}`;
        } else {
            infoEl.textContent = '';
        }
    }
}

/** Initialise les evenements zoom sur les canvas spectrogramme. */
function initSpectroEvents() {
    const canvasBrut = document.getElementById('spectroCanvasBrut');
    const canvasFiltre = document.getElementById('spectroCanvasFiltre');
    const selBrut = document.getElementById('spectroSelBrut');
    const selFiltre = document.getElementById('spectroSelFiltre');
    const canvases = [canvasBrut, canvasFiltre].filter(Boolean);
    const sels = [selBrut, selFiltre];

    const _spectroRef = () => state._cachedSpectroBrut || state._cachedSpectroFiltre;
    let _drag = { active: false, startX: 0, canvas: null };

    for (let ci = 0; ci < canvases.length; ci++) {
        const cv = canvases[ci];
        const sel = sels[ci];

        // Clic-glisser : selection pour zoom
        cv.addEventListener('mousedown', (e) => {
            if (e.button !== 0 || !_spectroRef()) return;
            e.preventDefault();
            const r = cv.getBoundingClientRect();
            _drag.startX = e.clientX - r.left;
            _drag.active = true;
            _drag.canvas = cv;
            sels.forEach(s => { if (s) s.style.display = 'none'; });
        });

        // Molette : defilement horizontal quand zoome
        cv.addEventListener('wheel', (e) => {
            const spectro = _spectroRef();
            if (!spectro) return;
            const zStart = state.spectroZoom.startFrame;
            const zEnd = state.spectroZoom.endFrame ?? spectro.nFrames;
            if (zStart === 0 && zEnd === spectro.nFrames) return; // pas zoome
            e.preventDefault();

            const visFrames = zEnd - zStart;
            const scrollAmount = Math.max(1, Math.round(visFrames * 0.05));
            const delta = e.deltaY > 0 ? scrollAmount : -scrollAmount;
            const maxStart = Math.max(0, spectro.nFrames - visFrames);
            const newStart = Math.max(0, Math.min(maxStart, zStart + delta));
            state.spectroZoom.startFrame = newStart;
            state.spectroZoom.endFrame = newStart + visFrames;
            redrawSpectrograms();
        }, { passive: false });

        // Clic droit : reset zoom
        cv.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            state.spectroZoom.startFrame = 0;
            state.spectroZoom.endFrame = null;
            redrawSpectrograms();
        });
    }

    // Mousemove global (selection)
    document.addEventListener('mousemove', (e) => {
        if (!_drag.active || !_drag.canvas) return;
        const r = _drag.canvas.getBoundingClientRect();
        const cur = e.clientX - r.left;
        const lo = Math.max(0, Math.min(_drag.startX, cur));
        const hi = Math.min(r.width, Math.max(_drag.startX, cur));
        if (hi - lo > 4) {
            // Afficher la selection sur les deux canvas
            sels.forEach(s => {
                if (s) {
                    s.style.left = lo + 'px';
                    s.style.width = (hi - lo) + 'px';
                    s.style.display = 'block';
                }
            });
        }
    });

    // Mouseup global (appliquer le zoom)
    document.addEventListener('mouseup', (e) => {
        if (!_drag.active) return;
        const cv = _drag.canvas;
        _drag.active = false;
        _drag.canvas = null;
        sels.forEach(s => { if (s) s.style.display = 'none'; });
        if (e.button !== 0 || !cv) return;

        const spectro = _spectroRef();
        if (!spectro) return;

        const r = cv.getBoundingClientRect();
        const cur = e.clientX - r.left;
        if (Math.abs(cur - _drag.startX) < 6) return; // clic simple

        const f1 = Math.round(spectroCssXToFrame(cv, Math.min(_drag.startX, cur), spectro));
        const f2 = Math.round(spectroCssXToFrame(cv, Math.max(_drag.startX, cur), spectro));
        const newStart = Math.max(0, f1);
        const newEnd = Math.min(spectro.nFrames, f2);
        if (newEnd - newStart < 10) return; // trop petit

        state.spectroZoom.startFrame = newStart;
        state.spectroZoom.endFrame = (newStart === 0 && newEnd === spectro.nFrames) ? null : newEnd;
        redrawSpectrograms();
    });

    // Boutons zoom
    document.getElementById('btnSpectroZoomIn')?.addEventListener('click', () => {
        const spectro = _spectroRef();
        if (!spectro) return;
        const zStart = state.spectroZoom.startFrame;
        const zEnd = state.spectroZoom.endFrame ?? spectro.nFrames;
        const visFrames = zEnd - zStart;
        let newVis = Math.round(visFrames / 1.5);
        newVis = Math.max(20, newVis);
        const center = zStart + visFrames / 2;
        let newStart = Math.round(center - newVis / 2);
        newStart = Math.max(0, Math.min(spectro.nFrames - newVis, newStart));
        state.spectroZoom.startFrame = newStart;
        state.spectroZoom.endFrame = newStart + newVis;
        redrawSpectrograms();
    });

    document.getElementById('btnSpectroZoomOut')?.addEventListener('click', () => {
        const spectro = _spectroRef();
        if (!spectro) return;
        const zStart = state.spectroZoom.startFrame;
        const zEnd = state.spectroZoom.endFrame ?? spectro.nFrames;
        const visFrames = zEnd - zStart;
        let newVis = Math.round(visFrames * 1.5);
        newVis = Math.min(spectro.nFrames, newVis);
        const center = zStart + visFrames / 2;
        let newStart = Math.round(center - newVis / 2);
        newStart = Math.max(0, Math.min(spectro.nFrames - newVis, newStart));
        state.spectroZoom.startFrame = newStart;
        state.spectroZoom.endFrame = (newStart === 0 && newStart + newVis >= spectro.nFrames) ? null : newStart + newVis;
        redrawSpectrograms();
    });

    document.getElementById('btnSpectroZoomReset')?.addEventListener('click', () => {
        state.spectroZoom.startFrame = 0;
        state.spectroZoom.endFrame = null;
        redrawSpectrograms();
    });
}

async function computeAndDrawSpectrograms() {
    // Reset zoom au recalcul
    state.spectroZoom.startFrame = 0;
    state.spectroZoom.endFrame = null;

    const windowSize = parseInt(document.getElementById('spectroWindowSize').value) || 2048;
    const maxFreq = parseInt(document.getElementById('spectroMaxFreq').value) || 30;
    const hopSize = Math.floor(windowSize / 2);
    const statusEl = document.getElementById('spectroStatus');

    if (state.fullNightEog && state.fullNightEog.length > 0) {
        statusEl.textContent = 'Calcul EOG brut...';
        state._cachedSpectroBrut = await computeSpectrogram(state.fullNightEog, windowSize, hopSize, maxFreq);
        drawSpectrogram(document.getElementById('spectroCanvasBrut'), state._cachedSpectroBrut, 'EOG brut');
    } else {
        _drawSpectrumEmpty(document.getElementById('spectroCanvasBrut'), 'Aucune donnée brute');
    }

    if (state.fullNightEogFiltre && state.fullNightEogFiltre.length > 0) {
        statusEl.textContent = 'Calcul EOG filtré...';
        state._cachedSpectroFiltre = await computeSpectrogram(state.fullNightEogFiltre, windowSize, hopSize, maxFreq);
        drawSpectrogram(document.getElementById('spectroCanvasFiltre'), state._cachedSpectroFiltre, 'EOG filtré');
    } else {
        _drawSpectrumEmpty(document.getElementById('spectroCanvasFiltre'), 'Aucune donnée filtrée');
    }

    statusEl.textContent = 'Terminé.';
    setTimeout(() => { statusEl.textContent = ''; }, 3000);
}

// ============================================================================
// Matrice de transitions
// ============================================================================

function computeTransitionMatrix(stages) {
    const n = STAGE_NAMES.length;
    const counts = Array.from({ length: n }, () => new Array(n).fill(0));
    const rowTotals = new Array(n).fill(0);

    for (let i = 0; i < stages.length - 1; i++) {
        const from = STAGE_NAMES.indexOf(stages[i]);
        const to = STAGE_NAMES.indexOf(stages[i + 1]);
        if (from >= 0 && to >= 0) {
            counts[from][to]++;
            rowTotals[from]++;
        }
    }

    const matrix = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
            matrix[i][j] = rowTotals[i] > 0 ? counts[i][j] / rowTotals[i] : 0;
        }
    }

    return { matrix, counts, rowTotals };
}

function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

function drawTransitionMatrix() {
    const canvas = document.getElementById('transitionCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const interpEl = document.getElementById('transitionInterpretation');

    const source = document.getElementById('transitionSource')?.value || 'predictions';
    let stages, sourceLabel;
    if (source === 'predictions') {
        stages = state.predictions.map(p => p.name);
        sourceLabel = 'Predictions ESP32';
    } else if (source === 'annot1') {
        stages = state.annotations1.filter(Boolean);
        sourceLabel = 'Annotateur 1';
    } else {
        stages = state.annotations2.filter(Boolean);
        sourceLabel = 'Annotateur 2';
    }

    const rowEl = canvas.parentElement;
    const sectionW = rowEl.parentElement.getBoundingClientRect().width - 40;

    if (stages.length < 2) {
        const fallback = Math.min(Math.round(sectionW * 0.42), 460);
        canvas.width = fallback; canvas.height = fallback;
        ctx.fillStyle = '#2a2f38'; ctx.fillRect(0, 0, fallback, fallback);
        ctx.fillStyle = '#6b7280'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('Pas assez de données', fallback / 2, fallback / 2);
        if (interpEl) interpEl.innerHTML = '';
        return;
    }

    const tm = computeTransitionMatrix(stages);

    // 1) Generer le texte d'interpretation d'abord pour mesurer sa hauteur
    if (interpEl) updateTransitionInterpretation(interpEl, tm, stages, sourceLabel);

    // 2) Mesurer la hauteur du panneau texte et dimensionner le canvas
    const textH = interpEl ? interpEl.offsetHeight : 0;
    const sizeW = Math.min(Math.round(sectionW * 0.42), 460);
    const size = Math.max(sizeW, Math.min(textH, 600));
    canvas.width = size;
    canvas.height = size;

    // 3) Dessiner la matrice
    const w = size, h = size;
    ctx.fillStyle = '#2a2f38';
    ctx.fillRect(0, 0, w, h);

    const margin = { top: 50, bottom: 20, left: 60, right: 20 };
    const gridW = w - margin.left - margin.right;
    const gridH = h - margin.top - margin.bottom;
    const cellW = gridW / 5;
    const cellH = gridH / 5;

    for (let i = 0; i < 5; i++) {
        for (let j = 0; j < 5; j++) {
            const prob = tm.matrix[i][j];
            const x = margin.left + j * cellW;
            const y = margin.top + i * cellH;

            const color = STAGE_COLORS[STAGE_NAMES[j]];
            const alpha = Math.max(0.05, prob);
            ctx.fillStyle = hexToRgba(color, alpha);
            ctx.fillRect(x, y, cellW - 1, cellH - 1);

            const fontSize = cellH > 50 ? 14 : 12;
            ctx.fillStyle = prob > 0.3 ? '#1a1d23' : '#e8eaed';
            ctx.font = prob > 0 ? `bold ${fontSize}px sans-serif` : `${fontSize - 1}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.fillText(
                prob > 0 ? (prob * 100).toFixed(1) + '%' : '0',
                x + cellW / 2, y + cellH / 2 + 4
            );

            if (tm.counts[i][j] > 0) {
                ctx.fillStyle = '#9aa0a6';
                ctx.font = `${Math.max(9, fontSize - 3)}px sans-serif`;
                ctx.fillText(`(${tm.counts[i][j]})`, x + cellW / 2, y + cellH / 2 + (fontSize > 12 ? 20 : 16));
            }
        }
    }

    // Labels lignes
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'right';
    for (let i = 0; i < 5; i++) {
        ctx.fillStyle = STAGE_COLORS[STAGE_NAMES[i]];
        ctx.fillText(STAGE_NAMES[i], margin.left - 8, margin.top + i * cellH + cellH / 2 + 4);
    }

    // Labels colonnes
    ctx.textAlign = 'center';
    for (let j = 0; j < 5; j++) {
        ctx.fillStyle = STAGE_COLORS[STAGE_NAMES[j]];
        ctx.fillText(STAGE_NAMES[j], margin.left + j * cellW + cellW / 2, margin.top - 10);
    }

    // Titres axes
    ctx.fillStyle = '#9aa0a6';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Stage suivant \u2192', margin.left + gridW / 2, margin.top - 30);
    ctx.save();
    ctx.translate(14, margin.top + gridH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('Stage courant \u2192', 0, 0);
    ctx.restore();
}

function updateTransitionInterpretation(el, tm, stages, sourceLabel) {
    const m = tm.matrix;
    const c = tm.counts;
    const totalTransitions = tm.rowTotals.reduce((a, b) => a + b, 0);
    const pct = (v) => (v * 100).toFixed(1) + '%';
    const cls = (v, good, warn) => v >= good ? 'ti-good' : v >= warn ? 'ti-warn' : 'ti-bad';

    // --- Stabilite (diagonale) ---
    const stability = STAGE_NAMES.map((name, i) => ({
        name, prob: m[i][i], count: c[i][i], total: tm.rowTotals[i]
    })).filter(s => s.total > 0);
    const avgStab = stability.length > 0
        ? stability.reduce((a, s) => a + s.prob, 0) / stability.length : 0;
    const mostStable = stability.reduce((a, b) => b.prob > a.prob ? b : a, stability[0]);
    const leastStable = stability.filter(s => s.total >= 3)
        .reduce((a, b) => b.prob < a.prob ? b : a, stability[0]);

    // --- Transitions les plus frequentes (hors diagonale) ---
    const offDiag = [];
    for (let i = 0; i < 5; i++) {
        for (let j = 0; j < 5; j++) {
            if (i !== j && c[i][j] > 0) {
                offDiag.push({ from: STAGE_NAMES[i], to: STAGE_NAMES[j],
                    prob: m[i][j], count: c[i][j] });
            }
        }
    }
    offDiag.sort((a, b) => b.count - a.count);
    const top3 = offDiag.slice(0, 3);

    // --- Transitions impossibles / inhabituelles ---
    const unusual = [
        { from: 'Wake', to: 'N3' }, { from: 'N3', to: 'Wake' },
        { from: 'Wake', to: 'REM' }, { from: 'REM', to: 'N3' },
        { from: 'N3', to: 'REM' },
    ];
    const foundUnusual = unusual.map(u => {
        const fi = STAGE_NAMES.indexOf(u.from), ti = STAGE_NAMES.indexOf(u.to);
        return { ...u, count: c[fi][ti], prob: m[fi][ti] };
    }).filter(u => u.count > 0);

    // --- Fragmentation ---
    let changeCount = 0;
    for (let i = 0; i < stages.length - 1; i++) {
        if (stages[i] !== stages[i + 1]) changeCount++;
    }
    const fragRate = stages.length > 1 ? changeCount / (stages.length - 1) : 0;

    // --- Construction du HTML ---
    let html = `<div class="ti-title">Interpretation (${sourceLabel})</div>`;

    // Lecture de la matrice
    html += `<div class="ti-section">`;
    html += `<div class="ti-section-title">Comment lire cette matrice</div>`;
    html += `Chaque ligne = stade <em>courant</em>, chaque colonne = stade <em>suivant</em>. `;
    html += `La valeur indique la probabilite de passer d'un stade a l'autre d'une epoch a la suivante. `;
    html += `La <span class="ti-highlight">diagonale</span> (meme stade) montre la stabilite.`;
    html += `</div>`;

    // Stabilite
    html += `<div class="ti-section">`;
    html += `<div class="ti-section-title">Stabilite des stades</div>`;
    html += `Stabilite moyenne : <span class="ti-highlight ${cls(avgStab, 0.85, 0.70)}">${pct(avgStab)}</span>`;
    if (mostStable) {
        html += `<br>Le plus stable : <span class="ti-highlight">${mostStable.name}</span> (${pct(mostStable.prob)}) `;
        html += mostStable.prob >= 0.90
            ? '&mdash; <span class="ti-good">tres bien maintenu</span>'
            : mostStable.prob >= 0.75
                ? '&mdash; <span class="ti-warn">correctement maintenu</span>'
                : '&mdash; <span class="ti-bad">peu stable</span>';
    }
    if (leastStable && leastStable.name !== mostStable?.name) {
        html += `<br>Le moins stable : <span class="ti-highlight">${leastStable.name}</span> (${pct(leastStable.prob)}) `;
        html += leastStable.prob < 0.50
            ? '&mdash; <span class="ti-bad">tres instable, souvent confondu</span>'
            : leastStable.prob < 0.70
                ? '&mdash; <span class="ti-warn">moderement stable</span>'
                : '';
    }
    html += `</div>`;

    // Transitions frequentes
    if (top3.length > 0) {
        html += `<div class="ti-section">`;
        html += `<div class="ti-section-title">Transitions les plus frequentes</div>`;
        for (const t of top3) {
            html += `<span class="ti-highlight">${t.from} \u2192 ${t.to}</span> : `;
            html += `${pct(t.prob)} (${t.count} fois)<br>`;
        }
        html += `</div>`;
    }

    // Fragmentation
    html += `<div class="ti-section">`;
    html += `<div class="ti-section-title">Fragmentation</div>`;
    html += `<span class="ti-highlight">${changeCount}</span> changements de stade `;
    html += `sur ${stages.length - 1} transitions `;
    html += `(taux : <span class="${cls(1 - fragRate, 0.85, 0.70)}">${pct(fragRate)}</span>).<br>`;
    if (fragRate > 0.30) {
        html += `<span class="ti-bad">Sommeil tres fragmente</span> &mdash; `;
        html += `le modele change frequemment de stade, ce qui peut indiquer `;
        html += `des difficultes de classification ou un sommeil reellement perturbe.`;
    } else if (fragRate > 0.15) {
        html += `<span class="ti-warn">Fragmentation moderee</span> &mdash; `;
        html += `quelques oscillations entre stades, typique d'un sommeil leger ou d'incertitudes N1/N2.`;
    } else {
        html += `<span class="ti-good">Sommeil peu fragmente</span> &mdash; `;
        html += `les stades sont bien maintenus avec peu d'oscillations.`;
    }
    html += `</div>`;

    // Transitions inhabituelles
    if (foundUnusual.length > 0) {
        html += `<div class="ti-section" style="border-left-color:#f87171;">`;
        html += `<div class="ti-section-title">Transitions inhabituelles</div>`;
        html += `Selon les regles AASM, certaines transitions sont rares ou impossibles :<br>`;
        for (const u of foundUnusual) {
            html += `<span class="ti-bad">${u.from} \u2192 ${u.to}</span> : `;
            html += `${u.count} fois (${pct(u.prob)})<br>`;
        }
        html += `Cela peut indiquer des erreurs de classification ou des micro-eveils non detectes.`;
        html += `</div>`;
    } else {
        html += `<div class="ti-section" style="border-left-color:#34d399;">`;
        html += `<span class="ti-good">Aucune transition inhabituelles detectee.</span> `;
        html += `Les enchainements respectent les regles physiologiques AASM.`;
        html += `</div>`;
    }

    el.innerHTML = html;
}

// ============================================================================
// Accord inter-annotateurs + bandes confiance/désaccord
// ============================================================================

function computeAnnotatorAgreement() {
    const preds = state.predictions;
    if (preds.length === 0) return null;

    // Kappa A1 vs A2
    const validA1A2 = preds.filter(p => p.annot1 && p.annot2);
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

    // Kappa ESP32 vs A1, ESP32 vs A2
    const kappaEspA1 = typeof computeKappa === 'function'
        ? computeKappa(preds, 'annot1') : null;
    const kappaEspA2 = typeof computeKappa === 'function'
        ? computeKappa(preds, 'annot2') : null;

    // Per-stage Kappa (A1 vs A2, one-vs-rest)
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

    return { kappaA1A2, kappaEspA1, kappaEspA2, perStageKappa };
}

function updateAnnotatorAgreement() {
    const grid = document.getElementById('annotKappaGrid');
    if (!grid) return;
    const agreement = computeAnnotatorAgreement();
    if (!agreement) {
        grid.innerHTML = '<div style="color:#6b7280;padding:8px;">Aucune donnée annotateurs disponible.</div>';
        return;
    }

    grid.innerHTML = '';
    const cards = [
        { label: 'Kappa A1 vs A2', value: agreement.kappaA1A2 !== null ? agreement.kappaA1A2.toFixed(3) : '--' },
        { label: 'Kappa ESP32 vs A1', value: agreement.kappaEspA1 !== null ? agreement.kappaEspA1.toFixed(3) : '--' },
        { label: 'Kappa ESP32 vs A2', value: agreement.kappaEspA2 !== null ? agreement.kappaEspA2.toFixed(3) : '--' },
    ];

    for (const stage of STAGE_NAMES) {
        const k = agreement.perStageKappa[stage];
        cards.push({
            label: `Kappa ${stage} (A1 vs A2)`,
            value: k !== undefined ? k.toFixed(3) : '--',
            color: STAGE_COLORS[stage]
        });
    }

    for (const c of cards) {
        const card = document.createElement('div');
        card.className = 'stat-card';
        const valColor = c.color || 'var(--accent)';
        card.innerHTML = `
            <div class="stat-label">${c.label}</div>
            <div class="stat-value" style="color:${valColor};font-size:22px;">${c.value}</div>
        `;
        grid.appendChild(card);
    }
}

function drawConfidenceBand(ctx, margin, epochW, zStart, zEnd, bandY, bandH) {
    const preds = state.predictions;
    if (preds.length === 0) return;

    for (let i = zStart; i < zEnd && i < preds.length; i++) {
        const conf = preds[i].confidence;
        if (conf === undefined) continue;
        const x = margin.left + (i - zStart) * epochW;

        let r, g, b;
        if (conf >= 0.7) {
            const t = (conf - 0.7) / 0.3;
            r = Math.floor(255 * (1 - t));
            g = Math.floor(200 + 55 * t);
            b = 50;
        } else if (conf >= 0.4) {
            const t = (conf - 0.4) / 0.3;
            r = 255;
            g = Math.floor(200 * t);
            b = 50;
        } else {
            r = 255; g = 50; b = 50;
        }

        ctx.fillStyle = `rgba(${r},${g},${b},0.7)`;
        ctx.fillRect(x, bandY, Math.max(epochW, 1), bandH);
    }

    ctx.fillStyle = '#9aa0a6';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('Confiance', margin.left - 6, bandY + bandH / 2 + 3);
}

function drawDisagreementBand(ctx, margin, epochW, zStart, zEnd, bandY, bandH) {
    const preds = state.predictions;
    if (preds.length === 0) return;

    for (let i = zStart; i < zEnd && i < preds.length; i++) {
        const p = preds[i];
        if (!p.annot1 || !p.annot2) continue;
        const x = margin.left + (i - zStart) * epochW;

        if (p.annot1 !== p.annot2) {
            ctx.fillStyle = 'rgba(248, 113, 113, 0.6)';
        } else {
            ctx.fillStyle = 'rgba(52, 211, 153, 0.15)';
        }
        ctx.fillRect(x, bandY, Math.max(epochW, 1), bandH);
    }

    ctx.fillStyle = '#9aa0a6';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('Accord', margin.left - 6, bandY + bandH / 2 + 3);
}

// ============================================================================
// Qualite du signal
// ============================================================================

function computeSignalQuality() {
    const signal = state.fullNightEog;
    if (!signal || signal.length === 0) return null;

    const nEpochs = Math.floor(signal.length / CHUNK_SIZE);
    const epochRanges = new Float64Array(nEpochs);
    let artifactCount = 0;
    let saturationCount = 0;

    const SATURATION_THRESHOLD = 3200;
    const ARTIFACT_RANGE_THRESHOLD = 5000;

    for (let e = 0; e < nEpochs; e++) {
        const offset = e * CHUNK_SIZE;
        let min = Infinity, max = -Infinity;
        for (let i = 0; i < CHUNK_SIZE; i++) {
            const v = signal[offset + i];
            if (v < min) min = v;
            if (v > max) max = v;
        }
        const range = max - min;
        epochRanges[e] = range;

        if (range > ARTIFACT_RANGE_THRESHOLD) artifactCount++;
        if (Math.abs(max) > SATURATION_THRESHOLD || Math.abs(min) > SATURATION_THRESHOLD) {
            saturationCount++;
        }
    }

    const meanRange = epochRanges.reduce((s, v) => s + v, 0) / nEpochs;

    return { epochRanges, meanRange, artifactCount, saturationCount, nEpochs };
}

function updateSignalQuality() {
    const grid = document.getElementById('signalQualityGrid');
    if (!grid) return;
    const quality = computeSignalQuality();

    if (!quality) {
        grid.innerHTML = '<div style="color:#6b7280;padding:8px;">Signal EOG non chargé.</div>';
        _drawSignalQualityEmpty();
        return;
    }

    grid.innerHTML = '';
    const cards = [
        { label: 'Epochs analysées', value: quality.nEpochs },
        { label: 'Amplitude moyenne', value: quality.meanRange.toFixed(0) },
        { label: 'Epochs artefactées', value: `${quality.artifactCount} (${(quality.artifactCount / quality.nEpochs * 100).toFixed(1)}%)` },
        { label: 'Epochs saturées', value: `${quality.saturationCount} (${(quality.saturationCount / quality.nEpochs * 100).toFixed(1)}%)` },
    ];

    for (const c of cards) {
        const card = document.createElement('div');
        card.className = 'stat-card';
        card.innerHTML = `
            <div class="stat-label">${c.label}</div>
            <div class="stat-value">${c.value}</div>
        `;
        grid.appendChild(card);
    }

    drawSignalQualityCanvas(quality);
}

function drawSignalQualityCanvas(quality) {
    const canvas = document.getElementById('signalQualityCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const rect = canvas.parentElement.getBoundingClientRect();
    if (rect.width < 50) return;
    canvas.width = rect.width;
    canvas.height = 120;

    const w = canvas.width, h = canvas.height;
    const margin = { top: 15, bottom: 20, left: 50, right: 15 };
    const plotW = w - margin.left - margin.right;
    const plotH = h - margin.top - margin.bottom;

    ctx.fillStyle = '#2a2f38';
    ctx.fillRect(0, 0, w, h);

    if (!quality) return;

    let maxRange = 0;
    for (const r of quality.epochRanges) if (r > maxRange) maxRange = r;
    if (maxRange === 0) maxRange = 1;

    const barW = plotW / quality.nEpochs;

    for (let e = 0; e < quality.nEpochs; e++) {
        const range = quality.epochRanges[e];
        const barH = (range / maxRange) * plotH;
        const x = margin.left + e * barW;
        const y = margin.top + plotH - barH;

        const norm = Math.min(1, range / (maxRange * 0.7));
        const [r, g, b] = heatmapColor(norm);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(x, y, Math.max(barW - 0.5, 1), barH);
    }

    ctx.fillStyle = '#6b7280';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(maxRange.toFixed(0), margin.left - 4, margin.top + 8);
    ctx.fillText('0', margin.left - 4, margin.top + plotH);

    ctx.textAlign = 'center';
    const nTicks = Math.min(10, quality.nEpochs);
    for (let i = 0; i <= nTicks; i++) {
        const epoch = Math.floor(i * quality.nEpochs / nTicks);
        const x = margin.left + epoch * barW;
        ctx.fillText(formatTime(epoch * 30), x, h - 4);
    }

    ctx.fillStyle = '#9aa0a6';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('Amplitude (range par epoch)', margin.left + 4, margin.top - 3);
}

function _drawSignalQualityEmpty() {
    const canvas = document.getElementById('signalQualityCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const rect = canvas.parentElement.getBoundingClientRect();
    if (rect.width < 50) return;
    canvas.width = rect.width;
    canvas.height = 120;
    ctx.fillStyle = '#2a2f38';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#6b7280';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Signal EOG non chargé', canvas.width / 2, canvas.height / 2);
}

// ============================================================================
// Courbe de calibration (Confiance vs Précision)
// ============================================================================

function drawCalibrationCurve() {
    const canvas = document.getElementById('calibrationCanvas');
    if (!canvas) return;
    const preds = getFilteredPredictions().filter(p => p.matchA1 !== null);
    if (preds.length === 0) {
        const ctx = canvas.getContext('2d');
        const _rect = canvas.parentElement ? canvas.parentElement.getBoundingClientRect() : { width: 500 };
        const _w = Math.min(500, Math.max(_rect.width || 500, 400));
        canvas.width = _w; canvas.height = 400;
        ctx.fillStyle = '#2a2f38'; ctx.fillRect(0, 0, _w, 400);
        ctx.fillStyle = '#9aa0a6'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('Pas de données annotées', _w / 2, 200);
        return;
    }

    const nBins = 10;
    const bins = Array.from({ length: nBins }, () => ({ total: 0, correct: 0, sumConf: 0 }));

    for (const p of preds) {
        const conf = typeof p.confidence === 'number' ? p.confidence : 0;
        // confidence peut etre 0-1 ou 0-100
        const c = conf > 1 ? conf / 100 : conf;
        const idx = Math.min(Math.floor(c * nBins), nBins - 1);
        bins[idx].total++;
        bins[idx].sumConf += c;
        if (p.matchA1) bins[idx].correct++;
    }

    const rect = canvas.parentElement ? canvas.parentElement.getBoundingClientRect() : { width: 500 };
    const w = Math.min(500, Math.max(rect.width || 500, 400)), h = 400;
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#2a2f38'; ctx.fillRect(0, 0, w, h);

    const m = { top: 40, bottom: 50, left: 60, right: 20 };
    const pw = w - m.left - m.right, ph = h - m.top - m.bottom;

    // Grille
    ctx.strokeStyle = '#3a3f4a'; ctx.lineWidth = 1;
    for (let i = 0; i <= 10; i++) {
        const x = m.left + (i / 10) * pw;
        const y = m.top + (1 - i / 10) * ph;
        ctx.beginPath(); ctx.moveTo(x, m.top); ctx.lineTo(x, m.top + ph); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(m.left, y); ctx.lineTo(m.left + pw, y); ctx.stroke();
    }

    // Diagonale parfaite
    ctx.strokeStyle = '#555'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(m.left, m.top + ph);
    ctx.lineTo(m.left + pw, m.top);
    ctx.stroke();
    ctx.setLineDash([]);

    // Barres + courbe
    const points = [];
    for (let i = 0; i < nBins; i++) {
        const b = bins[i];
        if (b.total === 0) continue;
        const meanConf = b.sumConf / b.total;
        const accuracy = b.correct / b.total;
        const x = m.left + meanConf * pw;
        const y = m.top + (1 - accuracy) * ph;
        points.push({ x, y, meanConf, accuracy, total: b.total });

        // Barre
        const barW = pw / nBins * 0.6;
        const barX = m.left + (i + 0.2) * (pw / nBins);
        const barH = (b.total / preds.length) * ph * 3;
        ctx.fillStyle = 'rgba(59,130,246,0.25)';
        ctx.fillRect(barX, m.top + ph - barH, barW, barH);
    }

    // Courbe
    if (points.length > 1) {
        ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
        ctx.stroke();
    }

    // Points
    for (const p of points) {
        ctx.fillStyle = '#3b82f6';
        ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2); ctx.fill();
    }

    // Axes
    ctx.fillStyle = '#e8eaed'; ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    for (let i = 0; i <= 10; i += 2) {
        ctx.fillText((i * 10) + '%', m.left + (i / 10) * pw, h - m.bottom + 20);
        ctx.textAlign = 'right';
        ctx.fillText((i * 10) + '%', m.left - 8, m.top + (1 - i / 10) * ph + 4);
        ctx.textAlign = 'center';
    }

    ctx.fillStyle = '#e8eaed'; ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Confiance moyenne du modèle', w / 2, h - 8);
    ctx.save();
    ctx.translate(14, h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('Précision réelle (vs A1)', 0, 0);
    ctx.restore();

    // Titre
    ctx.fillStyle = '#e8eaed'; ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('Calibration — ' + preds.length + ' epochs', m.left, m.top - 15);

    // ECE (Expected Calibration Error)
    let ece = 0;
    for (const b of bins) {
        if (b.total === 0) continue;
        const acc = b.correct / b.total;
        const conf = b.sumConf / b.total;
        ece += (b.total / preds.length) * Math.abs(acc - conf);
    }
    ctx.fillStyle = '#9aa0a6'; ctx.font = '12px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('ECE = ' + (ece * 100).toFixed(2) + '%', w - m.right, m.top - 15);
}

// ============================================================================
// Bland-Altman Plot
// ============================================================================

function drawBlandAltman() {
    const canvas = document.getElementById('blandAltmanCanvas');
    if (!canvas) return;
    const preds = getFilteredPredictions().filter(p => p.annot1 !== null);
    if (preds.length === 0) {
        const ctx = canvas.getContext('2d');
        const _rect = canvas.parentElement ? canvas.parentElement.getBoundingClientRect() : { width: 900 };
        const _w = Math.max(_rect.width || 900, 600);
        canvas.width = _w; canvas.height = 400;
        ctx.fillStyle = '#2a2f38'; ctx.fillRect(0, 0, _w, 400);
        ctx.fillStyle = '#9aa0a6'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('Pas de données annotées', _w / 2, 200);
        return;
    }

    // Encoder les stades en valeurs numériques (ordinal)
    const stageVal = { 'Wake': 0, 'REM': 1, 'N1': 2, 'N2': 3, 'N3': 4 };
    const diffs = [];
    const avgs = [];
    const stages = [];

    for (const p of preds) {
        const predV = stageVal[p.name];
        const annotV = stageVal[p.annot1];
        if (predV === undefined || annotV === undefined) continue;
        diffs.push(predV - annotV);
        avgs.push((predV + annotV) / 2);
        stages.push(p.name);
    }

    if (diffs.length === 0) return;

    const meanDiff = diffs.reduce((s, v) => s + v, 0) / diffs.length;
    const sdDiff = Math.sqrt(diffs.reduce((s, v) => s + (v - meanDiff) ** 2, 0) / diffs.length);
    const upper = meanDiff + 1.96 * sdDiff;
    const lower = meanDiff - 1.96 * sdDiff;

    const rect = canvas.parentElement ? canvas.parentElement.getBoundingClientRect() : { width: 900 };
    const w = Math.max(rect.width || 900, 600), h = 400;
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

    // Grille
    ctx.strokeStyle = '#3a3f4a'; ctx.lineWidth = 0.5;
    for (let i = -4; i <= 4; i++) {
        const y = toY(i);
        if (y >= m.top && y <= m.top + ph) {
            ctx.beginPath(); ctx.moveTo(m.left, y); ctx.lineTo(m.left + pw, y); ctx.stroke();
        }
    }

    // Limites d'accord
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(m.left, toY(upper)); ctx.lineTo(m.left + pw, toY(upper)); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(m.left, toY(lower)); ctx.lineTo(m.left + pw, toY(lower)); ctx.stroke();

    ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(m.left, toY(meanDiff)); ctx.lineTo(m.left + pw, toY(meanDiff)); ctx.stroke();
    ctx.setLineDash([]);

    // Points avec jitter
    const jitterMap = {};
    for (let i = 0; i < diffs.length; i++) {
        const key = avgs[i] + ',' + diffs[i];
        jitterMap[key] = (jitterMap[key] || 0) + 1;
        const jx = (Math.random() - 0.5) * 15;
        const jy = (Math.random() - 0.5) * 5;
        const color = STAGE_COLORS[stages[i]] || '#666';
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(toX(avgs[i]) + jx, toY(diffs[i]) + jy, 3.5, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Labels
    ctx.fillStyle = '#3b82f6'; ctx.font = '11px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('Biais = ' + meanDiff.toFixed(3), m.left + pw + 4 > w - 100 ? m.left + 4 : m.left + pw - 150, toY(meanDiff) - 5);
    ctx.fillStyle = '#ef4444';
    ctx.fillText('+1.96 SD = ' + upper.toFixed(2), m.left + 4, toY(upper) - 5);
    ctx.fillText('-1.96 SD = ' + lower.toFixed(2), m.left + 4, toY(lower) + 15);

    // Axes
    ctx.fillStyle = '#e8eaed'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
    const stageLabels = ['Wake', 'REM', 'N1', 'N2', 'N3'];
    for (let i = 0; i < 5; i++) {
        ctx.fillStyle = STAGE_COLORS[stageLabels[i]] || '#e8eaed';
        ctx.fillText(stageLabels[i], toX(i), h - m.bottom + 20);
    }
    ctx.fillStyle = '#e8eaed'; ctx.font = '13px sans-serif';
    ctx.fillText('Moyenne (IA + A1) / 2', w / 2, h - 8);

    ctx.save();
    ctx.translate(14, h / 2); ctx.rotate(-Math.PI / 2);
    ctx.fillText('Différence (IA - A1)', 0, 0);
    ctx.restore();

    // Légende stades
    ctx.font = '11px sans-serif'; ctx.textAlign = 'left';
    let lx = m.left + 10;
    for (const s of STAGE_NAMES) {
        ctx.fillStyle = STAGE_COLORS[s];
        ctx.fillRect(lx, m.top - 12, 10, 10);
        ctx.fillStyle = '#e8eaed';
        ctx.fillText(s, lx + 13, m.top - 3);
        lx += 55;
    }
}

// ============================================================================
// ICC (Intraclass Correlation Coefficient) — ICC(3,1) two-way mixed, consistency
// ============================================================================

function updateICC() {
    const grid = document.getElementById('iccGrid');
    if (!grid) return;

    const preds = getFilteredPredictions();
    const stageVal = { 'Wake': 0, 'REM': 1, 'N1': 2, 'N2': 3, 'N3': 4 };

    function calcICC(raterA, raterB) {
        const n = raterA.length;
        if (n < 3) return null;
        const meanA = raterA.reduce((s, v) => s + v, 0) / n;
        const meanB = raterB.reduce((s, v) => s + v, 0) / n;
        const grandMean = (meanA + meanB) / 2;

        let ssRows = 0, ssCols = 0, ssRes = 0;
        for (let i = 0; i < n; i++) {
            const rowMean = (raterA[i] + raterB[i]) / 2;
            ssRows += 2 * (rowMean - grandMean) ** 2;
            ssRes += (raterA[i] - rowMean) ** 2 + (raterB[i] - rowMean) ** 2;
        }
        ssCols = n * ((meanA - grandMean) ** 2 + (meanB - grandMean) ** 2);

        const msRows = ssRows / (n - 1);
        const msRes = ssRes / (n - 1);
        // ICC(3,1) consistency
        return msRows > 0 ? (msRows - msRes) / (msRows + msRes) : 0;
    }

    function iccInterpretation(v) {
        if (v === null) return { text: '--', color: '#6b7280' };
        if (v < 0.5) return { text: 'Faible', color: '#ef4444' };
        if (v < 0.75) return { text: 'Modéré', color: '#f59e0b' };
        if (v < 0.9) return { text: 'Bon', color: '#22c55e' };
        return { text: 'Excellent', color: '#3b82f6' };
    }

    // IA vs A1
    const validA1 = preds.filter(p => p.annot1 !== null && stageVal[p.name] !== undefined && stageVal[p.annot1] !== undefined);
    const iccIaA1 = validA1.length >= 3 ? calcICC(validA1.map(p => stageVal[p.name]), validA1.map(p => stageVal[p.annot1])) : null;

    // IA vs A2
    const validA2 = preds.filter(p => p.annot2 !== null && stageVal[p.name] !== undefined && stageVal[p.annot2] !== undefined);
    const iccIaA2 = validA2.length >= 3 ? calcICC(validA2.map(p => stageVal[p.name]), validA2.map(p => stageVal[p.annot2])) : null;

    // A1 vs A2
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

    // Légende
    const legend = document.createElement('div');
    legend.style.cssText = 'margin-top:12px;font-size:11px;color:#9aa0a6;';
    legend.innerHTML = '<b>Interprétation ICC:</b> &lt;0.5 Faible · 0.5-0.75 Modéré · 0.75-0.9 Bon · &gt;0.9 Excellent';
    grid.appendChild(legend);
}

// ============================================================================
// Heatmap temporelle
// ============================================================================

function drawHeatmap() {
    const canvas = document.getElementById('heatmapCanvas');
    if (!canvas) return;
    const preds = getFilteredPredictions();
    if (preds.length === 0) {
        const ctx = canvas.getContext('2d');
        const _rect = canvas.parentElement ? canvas.parentElement.getBoundingClientRect() : { width: 1200 };
        const _w = Math.max(_rect.width || 1200, 600);
        canvas.width = _w; canvas.height = 250;
        ctx.fillStyle = '#2a2f38'; ctx.fillRect(0, 0, _w, 250);
        ctx.fillStyle = '#9aa0a6'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('Pas de données', _w / 2, 125);
        return;
    }

    const rect = canvas.parentElement.getBoundingClientRect();
    const w = Math.max(rect.width || 1200, 600), h = 250;
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#2a2f38'; ctx.fillRect(0, 0, w, h);

    const m = { top: 10, bottom: 40, left: 60, right: 10 };
    const pw = w - m.left - m.right;
    const nE = preds.length;
    const barW = Math.max(pw / nE, 0.5);

    // Rangée 1: Stade prédit (hauteur 40px)
    // Rangée 2: Confiance (hauteur 30px)
    // Rangée 3: Erreur A1 (hauteur 25px)
    // Rangée 4: Erreur A2 (hauteur 25px)
    const rows = [
        { label: 'Stade', h: 50, y: m.top },
        { label: 'Confiance', h: 35, y: m.top + 55 },
        { label: 'Erreur A1', h: 30, y: m.top + 95 },
        { label: 'Erreur A2', h: 30, y: m.top + 130 },
    ];

    // Labels Y
    ctx.fillStyle = '#9aa0a6'; ctx.font = '11px sans-serif'; ctx.textAlign = 'right';
    for (const r of rows) ctx.fillText(r.label, m.left - 5, r.y + r.h / 2 + 4);

    for (let i = 0; i < nE; i++) {
        const p = preds[i];
        const x = m.left + i * barW;

        // Stade
        ctx.fillStyle = STAGE_COLORS[p.name] || '#666';
        ctx.fillRect(x, rows[0].y, Math.max(barW - 0.3, 0.5), rows[0].h);

        // Confiance
        const conf = (typeof p.confidence === 'number' ? p.confidence : 0);
        const c = conf > 1 ? conf / 100 : conf;
        const green = Math.round(c * 255);
        ctx.fillStyle = `rgb(${255 - green}, ${green}, 80)`;
        ctx.fillRect(x, rows[1].y, Math.max(barW - 0.3, 0.5), rows[1].h);

        // Erreur A1
        if (p.matchA1 !== null) {
            ctx.fillStyle = p.matchA1 ? 'rgba(34,197,94,0.7)' : 'rgba(239,68,68,0.8)';
        } else {
            ctx.fillStyle = '#3a3f4a';
        }
        ctx.fillRect(x, rows[2].y, Math.max(barW - 0.3, 0.5), rows[2].h);

        // Erreur A2
        if (p.matchA2 !== null) {
            ctx.fillStyle = p.matchA2 ? 'rgba(34,197,94,0.7)' : 'rgba(239,68,68,0.8)';
        } else {
            ctx.fillStyle = '#3a3f4a';
        }
        ctx.fillRect(x, rows[3].y, Math.max(barW - 0.3, 0.5), rows[3].h);
    }

    // Axe X
    ctx.fillStyle = '#9aa0a6'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
    const nTicks = Math.min(12, nE);
    for (let i = 0; i <= nTicks; i++) {
        const epoch = Math.floor(i * nE / nTicks);
        ctx.fillText(formatTime(epoch * 30), m.left + epoch * barW, h - 10);
    }

    // Légende stades en bas
    ctx.font = '10px sans-serif'; ctx.textAlign = 'left';
    let lx = m.left;
    for (const s of STAGE_NAMES) {
        ctx.fillStyle = STAGE_COLORS[s]; ctx.fillRect(lx, h - 30, 10, 10);
        ctx.fillStyle = '#e8eaed'; ctx.fillText(s, lx + 12, h - 21);
        lx += 55;
    }
}

// ============================================================================
// Hypnogramme + Confiance superposée
// ============================================================================

function drawConfidenceOverlay() {
    const canvas = document.getElementById('confidenceOverlayCanvas');
    if (!canvas) return;
    const preds = getFilteredPredictions();
    if (preds.length === 0) {
        const ctx = canvas.getContext('2d');
        const _rect = canvas.parentElement ? canvas.parentElement.getBoundingClientRect() : { width: 1200 };
        const _w = Math.max(_rect.width || 1200, 600);
        canvas.width = _w; canvas.height = 300;
        ctx.fillStyle = '#2a2f38'; ctx.fillRect(0, 0, _w, 300);
        ctx.fillStyle = '#9aa0a6'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('Pas de données', _w / 2, 150);
        return;
    }

    const rect = canvas.parentElement.getBoundingClientRect();
    const w = Math.max(rect.width || 1200, 600), h = 340;
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#2a2f38'; ctx.fillRect(0, 0, w, h);

    const m = { top: 20, bottom: 70, left: 60, right: 20 };
    const pw = w - m.left - m.right;
    const hypnoH = 140; // zone hypnogramme
    const confH = 80;   // zone confiance
    const gap = 10;

    const nE = preds.length;
    const epochW = pw / nE;

    // === Hypnogramme ===
    const stageOrder = ['Wake', 'REM', 'N1', 'N2', 'N3'];
    const stageY = {};
    stageOrder.forEach((name, i) => {
        stageY[name] = m.top + (i / (stageOrder.length - 1)) * hypnoH;
    });

    // Labels Y
    ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
    for (const [name, y] of Object.entries(stageY)) {
        ctx.fillStyle = STAGE_COLORS[name] || '#9aa0a6';
        ctx.fillText(name, m.left - 5, y + 4);
    }

    // Grille
    ctx.strokeStyle = '#3a3f4a'; ctx.lineWidth = 0.5;
    for (const y of Object.values(stageY)) {
        ctx.beginPath(); ctx.moveTo(m.left, y); ctx.lineTo(m.left + pw, y); ctx.stroke();
    }

    // Dessiner l'hypnogramme
    const stageData = preds.map(p => p.name);
    if (typeof drawHypnogramStepLine === 'function') {
        drawHypnogramStepLine(ctx, stageData, stageY, m, epochW, 0, nE, '#3b82f6', 2.5, []);
        // A1
        const a1Data = preds.map(p => p.annot1 || null);
        drawHypnogramStepLine(ctx, a1Data, stageY, m, epochW, 0, nE, '#ef4444', 1, [6, 3]);
    }

    // === Confiance ===
    const confTop = m.top + hypnoH + gap;
    ctx.fillStyle = '#9aa0a6'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
    ctx.fillText('100%', m.left - 5, confTop + 4);
    ctx.fillText('0%', m.left - 5, confTop + confH);

    // Fond gradient pour la zone de confiance
    const grad = ctx.createLinearGradient(0, confTop, 0, confTop + confH);
    grad.addColorStop(0, 'rgba(34,197,94,0.12)');
    grad.addColorStop(1, 'rgba(239,68,68,0.12)');
    ctx.fillStyle = grad;
    ctx.fillRect(m.left, confTop, pw, confH);

    // Seuil dynamique (slider)
    const sliderEl = document.getElementById('overlayThresholdSlider');
    const thresh = sliderEl ? parseInt(sliderEl.value, 10) / 100 : 0.6;
    const threshY = confTop + confH * (1 - thresh);
    ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(m.left, threshY); ctx.lineTo(m.left + pw, threshY); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#f59e0b'; ctx.font = '9px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(Math.round(thresh * 100) + '%', m.left + pw + 3, threshY + 3);

    // Courbe de confiance
    ctx.strokeStyle = '#6366f1'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < nE; i++) {
        const conf = typeof preds[i].confidence === 'number' ? preds[i].confidence : 0;
        const c = conf > 1 ? conf / 100 : conf;
        const x = m.left + (i + 0.5) * epochW;
        const y = confTop + confH * (1 - c);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Colorier les zones sous le seuil
    ctx.fillStyle = 'rgba(239,68,68,0.2)';
    for (let i = 0; i < nE; i++) {
        const conf = typeof preds[i].confidence === 'number' ? preds[i].confidence : 0;
        const c = conf > 1 ? conf / 100 : conf;
        if (c < thresh) {
            ctx.fillRect(m.left + i * epochW, confTop, epochW, confH);
        }
    }

    // Axe X
    ctx.fillStyle = '#9aa0a6'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
    const nTicks = Math.min(12, nE);
    for (let i = 0; i <= nTicks; i++) {
        const epoch = Math.floor(i * nE / nTicks);
        ctx.fillText(formatTime(epoch * 30), m.left + epoch * epochW, h - 8);
    }

    // === Légende ===
    const legendY = h - 30;
    let lx = m.left;
    ctx.font = '10px sans-serif'; ctx.textAlign = 'left';

    // Neuralix (bleu, trait plein)
    ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 2.5; ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(lx, legendY); ctx.lineTo(lx + 20, legendY); ctx.stroke();
    ctx.fillStyle = '#e8eaed';
    ctx.fillText('Neuralix (IA)', lx + 24, legendY + 4);
    lx += 120;

    // Annoteur 1 (rouge, pointillés)
    ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 3]);
    ctx.beginPath(); ctx.moveTo(lx, legendY); ctx.lineTo(lx + 20, legendY); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#e8eaed';
    ctx.fillText('Annoteur 1', lx + 24, legendY + 4);
    lx += 110;

    // Confiance (violet)
    ctx.strokeStyle = '#6366f1'; ctx.lineWidth = 1.5; ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(lx, legendY); ctx.lineTo(lx + 20, legendY); ctx.stroke();
    ctx.fillStyle = '#e8eaed';
    ctx.fillText('Confiance', lx + 24, legendY + 4);
    lx += 100;

    // Seuil (jaune, pointillés)
    ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(lx, legendY); ctx.lineTo(lx + 20, legendY); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#e8eaed';
    ctx.fillText('Seuil ' + Math.round(thresh * 100) + '%', lx + 24, legendY + 4);
    lx += 100;

    // Zone rouge
    ctx.fillStyle = 'rgba(239,68,68,0.3)';
    ctx.fillRect(lx, legendY - 5, 14, 10);
    ctx.fillStyle = '#e8eaed';
    ctx.fillText('Sous le seuil', lx + 18, legendY + 4);
}

// ============================================================================
// Diagramme Sunburst
// ============================================================================

function _drawSunburstOnCanvas(canvas, preds, title, centerExtra) {
    if (!canvas) return;
    if (preds.length === 0) {
        const ctx = canvas.getContext('2d');
        canvas.width = 500; canvas.height = 500;
        ctx.fillStyle = '#2a2f38'; ctx.fillRect(0, 0, 500, 500);
        ctx.fillStyle = '#9aa0a6'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('Pas de données', 250, 250);
        return;
    }

    const w = 500, h = 500;
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#2a2f38'; ctx.fillRect(0, 0, w, h);

    // Titre
    ctx.fillStyle = '#e8eaed'; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(title, w / 2, 18);

    const cx = w / 2, cy = h / 2 + 5;
    const r1 = 75, r2 = 130, r3 = 178;

    const counts = {}, correctA1 = {}, wrongA1 = {}, noAnnot = {};
    for (const s of STAGE_NAMES) { counts[s] = 0; correctA1[s] = 0; wrongA1[s] = 0; noAnnot[s] = 0; }

    for (const p of preds) {
        counts[p.name] = (counts[p.name] || 0) + 1;
        if (p.matchA1 === true) correctA1[p.name]++;
        else if (p.matchA1 === false) wrongA1[p.name]++;
        else noAnnot[p.name]++;
    }

    const total = preds.length;
    let startAngle = -Math.PI / 2;

    for (const stage of STAGE_NAMES) {
        const cnt = counts[stage] || 0;
        if (cnt === 0) continue;
        const sweep = (cnt / total) * Math.PI * 2;
        const endAngle = startAngle + sweep;

        ctx.beginPath();
        ctx.arc(cx, cy, r2, startAngle, endAngle);
        ctx.arc(cx, cy, r1, endAngle, startAngle, true);
        ctx.closePath();
        ctx.fillStyle = STAGE_COLORS[stage]; ctx.globalAlpha = 0.85; ctx.fill();
        ctx.globalAlpha = 1; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();

        const subTotal = cnt;
        const subParts = [
            { count: correctA1[stage], color: 'rgba(34,197,94,0.8)', textColor: '#15803d' },
            { count: wrongA1[stage], color: 'rgba(239,68,68,0.8)', textColor: '#b91c1c' },
            { count: noAnnot[stage], color: 'rgba(200,200,200,0.5)', textColor: '#888' },
        ];

        let subStart = startAngle;
        const outerLabels = [];
        for (const sp of subParts) {
            if (sp.count === 0) continue;
            const subSweep = (sp.count / subTotal) * sweep;
            ctx.beginPath();
            ctx.arc(cx, cy, r3, subStart, subStart + subSweep);
            ctx.arc(cx, cy, r2 + 2, subStart + subSweep, subStart, true);
            ctx.closePath();
            ctx.fillStyle = sp.color; ctx.fill();
            ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();

            const pct = (sp.count / subTotal * 100).toFixed(0) + '%';
            const midA = subStart + subSweep / 2;
            const arcLen = subSweep * (r2 + r3) / 2;
            outerLabels.push({ pct, midA, arcLen, textColor: sp.textColor });

            subStart += subSweep;
        }

        for (const ol of outerLabels) {
            const midR = (r2 + 2 + r3) / 2;
            ctx.font = 'bold 9px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            if (ol.arcLen > 28) {
                ctx.fillStyle = '#fff';
                ctx.fillText(ol.pct, cx + Math.cos(ol.midA) * midR, cy + Math.sin(ol.midA) * midR);
            } else {
                const innerX = cx + Math.cos(ol.midA) * r3;
                const innerY = cy + Math.sin(ol.midA) * r3;
                const outerR = r3 + 25;
                const outerX = cx + Math.cos(ol.midA) * outerR;
                const outerY = cy + Math.sin(ol.midA) * outerR;
                ctx.strokeStyle = ol.textColor; ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(innerX, innerY); ctx.lineTo(outerX, outerY); ctx.stroke();
                ctx.fillStyle = ol.textColor;
                ctx.fillText(ol.pct, outerX + Math.cos(ol.midA) * 12, outerY + Math.sin(ol.midA) * 4);
            }
        }
        ctx.textBaseline = 'alphabetic';

        const midAngle = startAngle + sweep / 2;
        const labelR = (r1 + r2) / 2;
        const lx = cx + Math.cos(midAngle) * labelR;
        const ly = cy + Math.sin(midAngle) * labelR;
        ctx.fillStyle = '#fff'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(stage, lx, ly - 2);
        ctx.font = '10px sans-serif';
        ctx.fillText((cnt / total * 100).toFixed(0) + '%', lx, ly + 12);

        startAngle = endAngle;
    }

    // Centre
    ctx.beginPath(); ctx.arc(cx, cy, r1, 0, Math.PI * 2);
    ctx.fillStyle = '#2a2f38'; ctx.fill();
    ctx.fillStyle = '#e8eaed'; ctx.font = 'bold 16px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(total + '', cx, cy - 8);
    ctx.font = '11px sans-serif'; ctx.fillStyle = '#9aa0a6';
    ctx.fillText('epochs', cx, cy + 8);
    if (centerExtra) {
        ctx.font = '10px sans-serif'; ctx.fillStyle = '#777';
        ctx.fillText(centerExtra, cx, cy + 22);
    }

    // Légende
    ctx.font = '11px sans-serif'; ctx.textAlign = 'left';
    const legY = h - 25;
    ctx.fillStyle = 'rgba(34,197,94,0.8)'; ctx.fillRect(20, legY, 12, 12);
    ctx.fillStyle = '#e8eaed'; ctx.fillText('Correct (A1)', 36, legY + 10);
    ctx.fillStyle = 'rgba(239,68,68,0.8)'; ctx.fillRect(140, legY, 12, 12);
    ctx.fillStyle = '#e8eaed'; ctx.fillText('Erreur (A1)', 156, legY + 10);
    ctx.fillStyle = 'rgba(200,200,200,0.5)'; ctx.fillRect(260, legY, 12, 12);
    ctx.fillStyle = '#e8eaed'; ctx.fillText('Non annoté', 276, legY + 10);
}

function drawSunburst() {
    // Sunburst global (toutes les prédictions filtrées par le filtre stats)
    const allPreds = getFilteredPredictions();
    _drawSunburstOnCanvas(
        document.getElementById('sunburstCanvas'),
        allPreds,
        'Global (toutes confiances)'
    );

    // Sunburst seuillé (filtre + seuil de confiance)
    const threshold = state.confidenceThreshold / 100;
    const threshPreds = allPreds.filter(p => {
        const c = typeof p.confidence === 'number' ? (p.confidence > 1 ? p.confidence / 100 : p.confidence) : 0;
        return c >= threshold;
    });
    _drawSunburstOnCanvas(
        document.getElementById('sunburstThreshCanvas'),
        threshPreds,
        'Seuil confiance \u2265 ' + state.confidenceThreshold + '% (' + threshPreds.length + '/' + allPreds.length + ')'
    );
}

// ============================================================================
// Timeline d'erreurs
// ============================================================================

function drawErrorTimeline() {
    const canvas = document.getElementById('errorTimelineCanvas');
    if (!canvas) return;
    const preds = getFilteredPredictions();
    if (preds.length === 0) {
        const ctx = canvas.getContext('2d');
        const _rect = canvas.parentElement ? canvas.parentElement.getBoundingClientRect() : { width: 1200 };
        const _w = Math.max(_rect.width || 1200, 600);
        canvas.width = _w; canvas.height = 120;
        ctx.fillStyle = '#2a2f38'; ctx.fillRect(0, 0, _w, 120);
        ctx.fillStyle = '#9aa0a6'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('Pas de données', _w / 2, 60);
        return;
    }

    const rect = canvas.parentElement.getBoundingClientRect();
    const w = Math.max(rect.width || 1200, 600), h = 120;
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#2a2f38'; ctx.fillRect(0, 0, w, h);

    const m = { top: 15, bottom: 35, left: 60, right: 10 };
    const pw = w - m.left - m.right;
    const nE = preds.length;
    const barW = Math.max(pw / nE, 0.5);

    // Rangée 1: vs A1 (hauteur 30px)
    // Rangée 2: vs A2 (hauteur 30px)
    const rowH = 28;
    const row1Y = m.top;
    const row2Y = m.top + rowH + 5;

    ctx.fillStyle = '#9aa0a6'; ctx.font = '11px sans-serif'; ctx.textAlign = 'right';
    ctx.fillText('vs A1', m.left - 5, row1Y + rowH / 2 + 4);
    ctx.fillText('vs A2', m.left - 5, row2Y + rowH / 2 + 4);

    let errCountA1 = 0, errCountA2 = 0, totalA1 = 0, totalA2 = 0;

    for (let i = 0; i < nE; i++) {
        const p = preds[i];
        const x = m.left + i * barW;

        // vs A1
        if (p.matchA1 !== null) {
            totalA1++;
            if (p.matchA1) {
                ctx.fillStyle = 'rgba(34,197,94,0.7)';
            } else {
                ctx.fillStyle = 'rgba(239,68,68,0.85)';
                errCountA1++;
            }
        } else {
            ctx.fillStyle = '#3a3f4a';
        }
        ctx.fillRect(x, row1Y, Math.max(barW - 0.3, 0.5), rowH);

        // vs A2
        if (p.matchA2 !== null) {
            totalA2++;
            if (p.matchA2) {
                ctx.fillStyle = 'rgba(34,197,94,0.7)';
            } else {
                ctx.fillStyle = 'rgba(239,68,68,0.85)';
                errCountA2++;
            }
        } else {
            ctx.fillStyle = '#3a3f4a';
        }
        ctx.fillRect(x, row2Y, Math.max(barW - 0.3, 0.5), rowH);
    }

    // Axe X
    ctx.fillStyle = '#9aa0a6'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
    const nTicks = Math.min(12, nE);
    for (let i = 0; i <= nTicks; i++) {
        const epoch = Math.floor(i * nE / nTicks);
        ctx.fillText(formatTime(epoch * 30), m.left + epoch * barW, h - 8);
    }

    // Résumé erreurs
    ctx.font = '11px sans-serif'; ctx.textAlign = 'left';
    ctx.fillStyle = '#e8eaed';
    if (totalA1 > 0) ctx.fillText('A1: ' + errCountA1 + ' erreurs / ' + totalA1 + ' (' + (errCountA1 / totalA1 * 100).toFixed(1) + '%)', m.left + pw - 250, row1Y + rowH / 2 + 4);
    if (totalA2 > 0) ctx.fillText('A2: ' + errCountA2 + ' erreurs / ' + totalA2 + ' (' + (errCountA2 / totalA2 * 100).toFixed(1) + '%)', m.left + pw - 250, row2Y + rowH / 2 + 4);
}

// ============================================================================
// Presets / Profils
// ============================================================================

var _presets = {};
try { _presets = JSON.parse(localStorage.getItem('neuralix-presets') || '{}'); } catch(e) {}

function _savePresets() {
    try { localStorage.setItem('neuralix-presets', JSON.stringify(_presets)); } catch(e) {}
}

function presetsRenderList() {
    const container = document.getElementById('presetsList');
    if (!container) return;
    container.innerHTML = '';
    for (const name of Object.keys(_presets)) {
        const btn = document.createElement('button');
        btn.className = 'btn btn-small';
        btn.style.cssText = 'background:#f3f4f6;color:#333;border:1px solid #d1d5db;';
        btn.textContent = name;
        btn.title = 'Cliquer pour charger ce profil';
        btn.addEventListener('click', () => presetsLoad(name));
        container.appendChild(btn);
    }
}

function presetsSave() {
    const nameInput = document.getElementById('presetNameInput');
    if (!nameInput) return;
    const name = nameInput.value.trim();
    if (!name) return;
    _presets[name] = {
        statsFilter: state.statsFilter,
        confidenceThreshold: state.confidenceThreshold,
        speed: state.speed,
    };
    _savePresets();
    nameInput.value = '';
    presetsRenderList();
}

function presetsLoad(name) {
    const p = _presets[name];
    if (!p) return;
    if (p.statsFilter) {
        state.statsFilter = p.statsFilter;
        const sel = document.getElementById('statsFilterSelect');
        if (sel) sel.value = p.statsFilter;
    }
    if (p.confidenceThreshold != null) {
        state.confidenceThreshold = p.confidenceThreshold;
        const sl = document.getElementById('confidenceSlider');
        const inp = document.getElementById('confidenceInput');
        if (sl) sl.value = p.confidenceThreshold;
        if (inp) inp.value = p.confidenceThreshold;
    }
    if (p.speed != null) {
        state.speed = p.speed;
        const sp = document.getElementById('speedSelect');
        if (sp) sp.value = p.speed;
    }
    // Rafraîchir les stats
    if (typeof updateStats === 'function') updateStats();
}

function presetsDelete() {
    const nameInput = document.getElementById('presetNameInput');
    if (!nameInput) return;
    const name = nameInput.value.trim();
    if (!name || !_presets[name]) return;
    delete _presets[name];
    _savePresets();
    nameInput.value = '';
    presetsRenderList();
}

// ============================================================================
// Dashboard
// ============================================================================

function updateDashboard() {
    const grid = document.getElementById('dashboardGrid');
    if (!grid) return;
    const preds = getFilteredPredictions();
    if (preds.length === 0) { grid.innerHTML = '<p style="color:#9aa0a6;">Pas de données</p>'; return; }

    const withA1 = preds.filter(p => p.matchA1 !== null);
    const withA2 = preds.filter(p => p.matchA2 !== null);
    const accA1 = withA1.length ? (withA1.filter(p => p.matchA1).length / withA1.length * 100) : null;
    const accA2 = withA2.length ? (withA2.filter(p => p.matchA2).length / withA2.length * 100) : null;

    // Kappa vs A1
    let kappaA1 = null;
    if (withA1.length > 0) {
        const N = withA1.length;
        const labels = STAGE_NAMES;
        let po = withA1.filter(p => p.matchA1).length / N;
        let pe = 0;
        for (const s of labels) {
            const pIA = withA1.filter(p => p.name === s).length / N;
            const pAn = withA1.filter(p => p.annot1 === s).length / N;
            pe += pIA * pAn;
        }
        kappaA1 = pe < 1 ? ((po - pe) / (1 - pe)) : 1;
    }

    // ECE
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

    // Average confidence
    const avgConf = preds.reduce((s, p) => {
        const c = typeof p.confidence === 'number' ? p.confidence : 0;
        return s + (c > 1 ? c : c * 100);
    }, 0) / preds.length;

    const cards = [
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

// ============================================================================
// Confusion Heatmap (normalized)
// ============================================================================

function drawConfusionHeatmap() {
    const canvas = document.getElementById('confusionHeatmapCanvas');
    if (!canvas) return;
    const preds = getFilteredPredictions().filter(p => p.matchA1 !== null);
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

    const m = { top: 50, bottom: 40, left: 70, right: 20 };
    const cw = w - m.left - m.right, ch = h - m.top - m.bottom;
    const cellW = cw / N, cellH = ch / N;

    // Title
    ctx.fillStyle = '#e8eaed'; ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('Matrice de confusion (normalisée par ligne)', w / 2, 20);

    // Labels
    ctx.fillStyle = '#9aa0a6'; ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Prédit (IA)', m.left + cw / 2, h - 10);
    ctx.save(); ctx.translate(15, m.top + ch / 2); ctx.rotate(-Math.PI / 2);
    ctx.fillText('Vrai (Annoteur)', 0, 0); ctx.restore();

    // Column headers
    ctx.fillStyle = '#e8eaed'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
    for (let j = 0; j < N; j++) {
        ctx.fillText(STAGE_NAMES[j], m.left + j * cellW + cellW / 2, m.top - 8);
    }
    // Row headers
    ctx.textAlign = 'right';
    for (let i = 0; i < N; i++) {
        ctx.fillText(STAGE_NAMES[i], m.left - 8, m.top + i * cellH + cellH / 2 + 4);
    }

    // Draw cells
    for (let i = 0; i < N; i++) {
        const rowSum = matrix[i].reduce((a, b) => a + b, 0);
        for (let j = 0; j < N; j++) {
            const val = rowSum > 0 ? matrix[i][j] / rowSum : 0;
            const x = m.left + j * cellW, y = m.top + i * cellH;

            // Color: green diagonal, red off-diagonal
            if (i === j) {
                const g = Math.round(80 + val * 175);
                ctx.fillStyle = `rgba(34, ${g}, 94, ${0.3 + val * 0.7})`;
            } else {
                const r = Math.round(80 + val * 175);
                ctx.fillStyle = `rgba(${r}, 68, 68, ${0.2 + val * 0.8})`;
            }
            ctx.fillRect(x + 1, y + 1, cellW - 2, cellH - 2);

            // Text
            ctx.fillStyle = '#e8eaed'; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center';
            ctx.fillText((val * 100).toFixed(1) + '%', x + cellW / 2, y + cellH / 2 - 4);
            ctx.font = '10px sans-serif'; ctx.fillStyle = '#9aa0a6';
            ctx.fillText(`(${matrix[i][j]})`, x + cellW / 2, y + cellH / 2 + 12);
        }
    }
}

// ============================================================================
// Error Bursts Analysis
// ============================================================================

function analyzeErrorBursts() {
    const grid = document.getElementById('errorBurstsGrid');
    const canvas = document.getElementById('errorBurstsCanvas');
    if (!grid || !canvas) return;
    const preds = getFilteredPredictions().filter(p => p.matchA1 !== null);
    if (preds.length === 0) {
        grid.innerHTML = '<p style="color:#9aa0a6;">Pas de données</p>';
        const ctx = canvas.getContext('2d');
        canvas.width = 400; canvas.height = 300;
        ctx.fillStyle = '#2a2f38'; ctx.fillRect(0, 0, 400, 300);
        return;
    }

    // Detect bursts
    const errors = preds.map(p => !p.matchA1);
    const bursts = [];
    let currentLen = 0;
    for (let i = 0; i < errors.length; i++) {
        if (errors[i]) {
            currentLen++;
        } else {
            if (currentLen > 0) bursts.push(currentLen);
            currentLen = 0;
        }
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

    // Histogram of burst lengths
    if (bursts.length === 0) return;
    const maxLen = Math.max(...bursts);
    const hist = new Array(maxLen).fill(0);
    for (const b of bursts) hist[b - 1]++;

    const pw = canvas.parentElement ? canvas.parentElement.getBoundingClientRect().width : 500;
    const w = Math.max(pw, 300), h = 300;
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#2a2f38'; ctx.fillRect(0, 0, w, h);

    const mg = { top: 30, bottom: 40, left: 50, right: 20 };
    const cw = w - mg.left - mg.right, ch = h - mg.top - mg.bottom;
    const maxCount = Math.max(...hist, 1);
    const barW = Math.max(2, cw / hist.length - 2);

    // Title
    ctx.fillStyle = '#e8eaed'; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('Distribution des longueurs de séquences d\'erreurs', w / 2, 18);

    // Bars
    for (let i = 0; i < hist.length; i++) {
        const barH = (hist[i] / maxCount) * ch;
        const x = mg.left + (i / hist.length) * cw;
        const y = mg.top + ch - barH;
        ctx.fillStyle = (i + 1) >= 5 ? '#ef4444' : '#3b82f6';
        ctx.fillRect(x, y, barW, barH);
    }

    // X axis labels
    ctx.fillStyle = '#9aa0a6'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
    const step = Math.max(1, Math.floor(hist.length / 10));
    for (let i = 0; i < hist.length; i += step) {
        ctx.fillText(String(i + 1), mg.left + (i / hist.length) * cw + barW / 2, h - 10);
    }
    ctx.fillText('Longueur', mg.left + cw / 2, h - 2);

    // Y axis
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
        const val = Math.round((i / 4) * maxCount);
        const y = mg.top + (1 - i / 4) * ch;
        ctx.fillText(String(val), mg.left - 5, y + 4);
    }
}

// ============================================================================
// Tooltip system
// ============================================================================

let _tooltipEl = null;
function _getTooltip() {
    if (!_tooltipEl) {
        _tooltipEl = document.createElement('div');
        _tooltipEl.style.cssText = 'position:fixed;background:#1e2228;color:#e8eaed;padding:6px 10px;border-radius:6px;font-size:12px;pointer-events:none;z-index:10000;display:none;max-width:300px;box-shadow:0 2px 8px rgba(0,0,0,0.5);border:1px solid #3a3f4a;';
        document.body.appendChild(_tooltipEl);
    }
    return _tooltipEl;
}

function _showTooltip(e, text) {
    const el = _getTooltip();
    el.innerHTML = text;
    el.style.display = 'block';
    el.style.left = (e.clientX + 12) + 'px';
    el.style.top = (e.clientY - 30) + 'px';
}

function _hideTooltip() {
    const el = _getTooltip();
    el.style.display = 'none';
}

function _setupConfusionHeatmapTooltip() {
    const canvas = document.getElementById('confusionHeatmapCanvas');
    if (!canvas || canvas._tooltipBound) return;
    canvas._tooltipBound = true;
    canvas.addEventListener('mousemove', function(e) {
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        const N = STAGE_NAMES.length;
        const m = { top: 50, bottom: 40, left: 70, right: 20 };
        const cw = canvas.width - m.left - m.right, ch = canvas.height - m.top - m.bottom;
        const cellW = cw / N, cellH = ch / N;
        const col = Math.floor((mx - m.left) / cellW);
        const row = Math.floor((my - m.top) / cellH);
        if (col >= 0 && col < N && row >= 0 && row < N) {
            _showTooltip(e, `<b>${STAGE_NAMES[row]}</b> → <b>${STAGE_NAMES[col]}</b>`);
        } else {
            _hideTooltip();
        }
    });
    canvas.addEventListener('mouseleave', _hideTooltip);
}

function _setupHeatmapTooltip() {
    const canvas = document.getElementById('heatmapCanvas');
    if (!canvas || canvas._tooltipBound) return;
    canvas._tooltipBound = true;
    canvas.addEventListener('mousemove', function(e) {
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        const preds = getFilteredPredictions().filter(p => p.matchA1 !== null);
        if (preds.length === 0) return;
        const epochIdx = Math.floor(mx / (canvas.width / preds.length));
        if (epochIdx >= 0 && epochIdx < preds.length) {
            const p = preds[epochIdx];
            const conf = typeof p.confidence === 'number' ? (p.confidence > 1 ? p.confidence : p.confidence * 100) : 0;
            _showTooltip(e, `Epoch ${epochIdx + 1}<br>IA: <b>${p.name}</b> | Annot: <b>${p.annot1 || '?'}</b><br>Confiance: ${conf.toFixed(1)}%`);
        } else {
            _hideTooltip();
        }
    });
    canvas.addEventListener('mouseleave', _hideTooltip);
}

function _setupErrorTimelineTooltip() {
    const canvas = document.getElementById('errorTimelineCanvas');
    if (!canvas || canvas._tooltipBound) return;
    canvas._tooltipBound = true;
    canvas.addEventListener('mousemove', function(e) {
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const preds = getFilteredPredictions().filter(p => p.matchA1 !== null);
        if (preds.length === 0) return;
        const epochIdx = Math.floor(mx / (canvas.width / preds.length));
        if (epochIdx >= 0 && epochIdx < preds.length) {
            const p = preds[epochIdx];
            const status = p.matchA1 ? '✓ Correct' : '✗ Erreur';
            _showTooltip(e, `Epoch ${epochIdx + 1}: ${status}<br>IA: <b>${p.name}</b> | Annot: <b>${p.annot1 || '?'}</b>`);
        } else {
            _hideTooltip();
        }
    });
    canvas.addEventListener('mouseleave', _hideTooltip);
}

function setupTooltips() {
    _setupHeatmapTooltip();
    _setupErrorTimelineTooltip();
    _setupConfusionHeatmapTooltip();
}

// ============================================================================
// Appel centralisé de tous les nouveaux outils
// ============================================================================

function updateAdvancedAnalysis() {
    updateDashboard();
    drawCalibrationCurve();
    drawBlandAltman();
    updateICC();
    drawHeatmap();
    drawConfidenceOverlay();
    drawSunburst();
    drawErrorTimeline();
    drawConfusionHeatmap();
    analyzeErrorBursts();
    setupTooltips();
}

// ============================================================================
// Event listeners
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
    // =========================================================================
    // Theme switcher
    // =========================================================================
    const themeSelect = document.getElementById('themeSelect');
    const themeIcon = document.getElementById('themeIcon');
    const THEMES = [
        { value: 'dark', icon: '🌙' },
        { value: 'light', icon: '☀️' },
        { value: 'highcontrast', icon: '🔳' },
    ];

    function applyTheme(theme) {
        document.body.classList.remove('theme-light', 'theme-highcontrast');
        if (theme === 'light') document.body.classList.add('theme-light');
        else if (theme === 'highcontrast') document.body.classList.add('theme-highcontrast');
        localStorage.setItem('neuralix-theme', theme);
        themeSelect.value = theme;
        const t = THEMES.find(t => t.value === theme) || THEMES[0];
        if (themeIcon) themeIcon.textContent = t.icon;
    }

    const savedTheme = localStorage.getItem('neuralix-theme') || 'dark';
    applyTheme(savedTheme);
    themeSelect.addEventListener('change', () => applyTheme(themeSelect.value));

    if (themeIcon) {
        themeIcon.addEventListener('click', () => {
            const cur = THEMES.findIndex(t => t.value === themeSelect.value);
            const next = THEMES[(cur + 1) % THEMES.length];
            applyTheme(next.value);
        });
    }

    // Connexion Serial
    document.getElementById('btnConnect').addEventListener('click', connectSerial);
    document.getElementById('btnDisconnect').addEventListener('click', disconnectSerial);

    // Fichier
    document.getElementById('fileInput').addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            loadFile(e.target.files[0]);
        }
    });

    // Controles de streaming
    document.getElementById('btnStart').addEventListener('click', () => {
        state.speed = parseInt(document.getElementById('speedSelect').value);
        startStreaming();
    });

    document.getElementById('btnPause').addEventListener('click', () => {
        state.paused = !state.paused;
        const btn = document.getElementById('btnPause');
        btn.textContent = state.paused ? 'Reprendre' : 'Pause';
        log(state.paused ? 'Pause' : 'Reprise', 'info');
    });

    document.getElementById('btnStop').addEventListener('click', () => {
        state.running = false;
        state.paused = false;
        log('Arret du streaming', 'info');
        updateControls();
        if (state.fullNightEog || state.fullNightEogFiltre) drawFullNight();
    });

    document.getElementById('btnReset').addEventListener('click', async () => {
        await sendCommand('#RESET');
        state.predictions = [];
        state.annotations1 = [];
        state.annotations2 = [];
        state.matchesA1 = 0;
        state.matchesA2 = 0;
        state.totalCompared = 0;
        state.totalTimeMs = 0;
        state.currentEpoch = 0;
        state.currentEpochData = [];
        state.fullNightEog = null;
        state.fullNightEogFiltre = null;
        state.fnZoomLevel = 1;
        state.fnView.startSample = 0;
        state.fnView.visibleSamples = 0;
        state._cachedSpectroBrut = null;
        state._cachedSpectroFiltre = null;
        state.spectroZoom.startFrame = 0;
        state.spectroZoom.endFrame = null;
        document.getElementById('historyBody').innerHTML = '';
        updateStats();
        drawHypnogram();
        drawSignal(0);
        drawFullNight();
        updateSleepArchitecture();
        updateSleepCycles();
        updateAnnotatorAgreement();
        drawTransitionMatrix();
        updateSignalQuality();
        updateAdvancedAnalysis();
        await clearPersistedData();
        if (typeof window.sidebarNotifyRealtimeData === 'function') {
            window.sidebarNotifyRealtimeData(false);
        }
        if (typeof window.sidebarNotifyAnalysisData === 'function') {
            window.sidebarNotifyAnalysisData(false);
        }
        log('Reset effectue', 'info');
    });

    // Vitesse
    document.getElementById('speedSelect').addEventListener('change', (e) => {
        state.speed = parseInt(e.target.value);
        saveUIParams();
    });

    // Clear log
    document.getElementById('btnClearLog').addEventListener('click', () => {
        document.getElementById('logConsole').innerHTML = '';
    });

    // Filtre de confiance: slider et input synchronises
    const slider = document.getElementById('confidenceSlider');
    const input  = document.getElementById('confidenceInput');
    slider.addEventListener('input', () => {
        const v = parseInt(slider.value);
        input.value = v;
        state.confidenceThreshold = v;
        updateFilteredStats();
        drawHypnogram();
        drawSunburst();
        saveUIParams();
    });
    input.addEventListener('input', () => {
        let v = parseInt(input.value);
        if (isNaN(v)) return;
        v = Math.max(0, Math.min(100, v));
        input.value  = v;
        slider.value = v;
        state.confidenceThreshold = v;
        updateFilteredStats();
        drawHypnogram();
        drawSunburst();
        saveUIParams();
    });

    // Slider seuil confiance overlay (Hypnogramme + Confiance)
    const ovSlider = document.getElementById('overlayThresholdSlider');
    const ovInput  = document.getElementById('overlayThresholdInput');
    if (ovSlider && ovInput) {
        ovSlider.addEventListener('input', () => {
            ovInput.value = ovSlider.value;
            drawConfidenceOverlay();
        });
        ovInput.addEventListener('input', () => {
            let v = parseInt(ovInput.value);
            if (isNaN(v)) return;
            v = Math.max(0, Math.min(100, v));
            ovInput.value = v;
            ovSlider.value = v;
            drawConfidenceOverlay();
        });
    }

    // Filtre de statistiques
    document.getElementById('statsFilterSelect').addEventListener('change', (e) => {
        applyStatsFilter(e.target.value);
    });

    // Navigation epochs avec fleches gauche/droite
    document.addEventListener('keydown', (e) => {
        // Ignorer si on est dans un champ de saisie
        const tag = document.activeElement?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();

        const refData = state.fullNightEog || state.fullNightEogFiltre;
        if (!refData) return;

        const maxEpoch = Math.floor(refData.length / CHUNK_SIZE) - 1;
        const newEpoch = e.key === 'ArrowRight'
            ? Math.min(state.currentEpoch + 1, maxEpoch)
            : Math.max(state.currentEpoch - 1, 0);

        if (newEpoch === state.currentEpoch) return;

        state.currentEpoch = newEpoch;
        const offset = newEpoch * CHUNK_SIZE;
        state.currentEpochData = Array.from(refData.slice(offset, offset + CHUNK_SIZE));
        drawSignal(newEpoch);
        savePredictionsToIDB();
    });

    // Restaurer l'etat persiste (avant le dessin initial)
    await restoreFromStorage();

    // Restaurer l'onglet actif
    const savedTab = localStorage.getItem('neuralix-active-tab');
    if (savedTab && ['realtime', 'analysis', 'multifile', 'comparative'].includes(savedTab)) {
        switchTab(savedTab);
    } else {
        switchTab('realtime');
    }

    // Dessiner les canvas (avec les donnees restaurees ou vides)
    // Double rAF pour attendre que le layout soit calcule apres switchTab
    requestAnimationFrame(() => { requestAnimationFrame(() => {
        drawSignal(state.currentEpoch);
        drawHypnogram();
        drawFullNight();
    }); });
    initFullNightEvents();
    initSpectroEvents();

    // Redimensionnement
    window.addEventListener('resize', () => {
        drawSignal(state.currentEpoch);
        drawHypnogram();
        if (state.fullNightEog || state.fullNightEogFiltre) drawFullNight();
        drawFrequencyAnalysis();
        drawStageDurationBars(computeSleepArchitecture());
        drawTransitionMatrix();
        drawSignalQualityCanvas(computeSignalQuality());
        redrawSpectrograms();
    });

    // -----------------------------------------------------------------------
    // Zoom hypnogramme
    // -----------------------------------------------------------------------
    const hypCanvas = document.getElementById('hypnogramCanvas');
    const selDiv    = document.getElementById('hypnoSelection');
    let   _drag = { active: false, startX: 0 };

    // Clic gauche : debut de selection
    hypCanvas.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const r = hypCanvas.getBoundingClientRect();
        _drag.startX = e.clientX - r.left;
        _drag.active = true;
        selDiv.style.display = 'none';
    });

    // Deplacement : afficher le rectangle de selection
    document.addEventListener('mousemove', (e) => {
        if (!_drag.active) return;
        const r   = hypCanvas.getBoundingClientRect();
        const cur = e.clientX - r.left;
        const lo  = Math.max(0, Math.min(_drag.startX, cur));
        const hi  = Math.min(hypCanvas.getBoundingClientRect().width, Math.max(_drag.startX, cur));
        if (hi - lo > 4) {
            selDiv.style.left    = lo + 'px';
            selDiv.style.width   = (hi - lo) + 'px';
            selDiv.style.display = 'block';
        }
    });

    // Relachement : appliquer le zoom
    document.addEventListener('mouseup', (e) => {
        if (!_drag.active) return;
        _drag.active = false;
        selDiv.style.display = 'none';
        if (e.button !== 0) return;

        const r   = hypCanvas.getBoundingClientRect();
        const cur = e.clientX - r.left;
        if (Math.abs(cur - _drag.startX) < 6) return;  // clic simple, ignorer

        const ep1 = Math.round(cssXToEpoch(hypCanvas, Math.min(_drag.startX, cur)));
        const ep2 = Math.round(cssXToEpoch(hypCanvas, Math.max(_drag.startX, cur)));
        const maxEp = getMaxEpochs();
        const newStart = Math.max(0, ep1);
        const newEnd   = Math.min(maxEp, ep2);
        if (newEnd - newStart < 2) return;

        state.hypnoZoom.start = newStart;
        state.hypnoZoom.end   = (newStart === 0 && newEnd === maxEp) ? null : newEnd;
        updateHypnoZoomUI();
        drawHypnogram();
    });

    // Clic droit : reinitialiser le zoom
    hypCanvas.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        resetHypnoZoom();
    });

    // Boutons zoom
    document.getElementById('btnZoomIn').addEventListener('click',    () => zoomHypno(0.5));
    document.getElementById('btnZoomOut').addEventListener('click',   () => zoomHypno(2.0));
    document.getElementById('btnZoomReset').addEventListener('click', () => resetHypnoZoom());

    // Checkboxes de visibilite hypnogramme
    for (const id of ['hypnoShowNeuralix', 'hypnoShowA1', 'hypnoShowA2']) {
        document.getElementById(id)?.addEventListener('change', () => drawHypnogram());
    }

    // Slider d'opacité du masque de confiance
    const maskSlider = document.getElementById('hypnoMaskOpacity');
    const maskLabel = document.getElementById('hypnoMaskLabel');
    if (maskSlider) {
        maskSlider.addEventListener('input', () => {
            if (maskLabel) maskLabel.textContent = maskSlider.value + '%';
            drawHypnogram();
        });
    }

    // Spectrogramme : calcul a la demande
    document.getElementById('btnComputeSpectro')?.addEventListener('click', computeAndDrawSpectrograms);

    // Matrice de transitions : changement de source
    document.getElementById('transitionSource')?.addEventListener('change', drawTransitionMatrix);

    // Re-dessiner les canvas quand une section fermée est ouverte
    document.getElementById('transitionSection')?.addEventListener('section-expand', () => {
        drawTransitionMatrix();
    });
    document.getElementById('signalQualitySection')?.addEventListener('section-expand', () => {
        const q = computeSignalQuality();
        if (q) drawSignalQualityCanvas(q);
    });
    document.getElementById('sleepArchSection')?.addEventListener('section-expand', () => {
        updateSleepArchitecture();
    });

    // Sauvegarde / Rapport
    document.getElementById('btnSaveSession').addEventListener('click', exportSession);
    document.getElementById('btnExportCSV').addEventListener('click', exportCSV);
    document.getElementById('btnExportHypno').addEventListener('click', exportHypnogram);
    // -----------------------------------------------------------------------
    // Onglets (3 onglets : realtime, analysis, multifile)
    // -----------------------------------------------------------------------
    function switchTab(tabName) {
        // Boutons
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        const activeBtn = document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
        if (activeBtn) activeBtn.classList.add('active');

        // Containers principaux
        const mainSections = document.getElementById('mainSections');
        const tabMultifile = document.getElementById('tabMultifile');
        const tabComparative = document.getElementById('tabComparative');

        // Masquer tous les conteneurs secondaires
        tabMultifile.classList.remove('active');
        if (tabComparative) tabComparative.classList.remove('active');

        if (tabName === 'multifile') {
            mainSections.classList.add('tab-main-hidden');
            tabMultifile.classList.add('active');
            // Redessiner les hypnogrammes et outils avancés apres que le layout soit calcule
            requestAnimationFrame(() => { requestAnimationFrame(() => {
                if (typeof mfDrawHypnograms === 'function') mfDrawHypnograms();
                if (typeof mfUpdateAdvancedAnalysis === 'function') mfUpdateAdvancedAnalysis();
            }); });
        } else if (tabName === 'comparative') {
            mainSections.classList.add('tab-main-hidden');
            if (tabComparative) tabComparative.classList.add('active');
        } else {
            mainSections.classList.remove('tab-main-hidden');

            // Masquer/afficher les sections selon data-tabs
            mainSections.querySelectorAll(':scope > section[data-tabs]').forEach(section => {
                const tabs = section.dataset.tabs.split(' ');
                if (tabs.includes(tabName)) {
                    section.classList.remove('tab-hidden');
                } else {
                    section.classList.add('tab-hidden');
                }
            });

            // Redessiner les canvases visibles apres le switch
            // Double rAF : la sidebar peut rendre des sections visibles dans le meme tick,
            // il faut attendre un cycle de layout avant de mesurer les canvases
            requestAnimationFrame(() => { requestAnimationFrame(() => {
                if (state.fullNightEog || state.fullNightEogFiltre) drawFullNight();
                drawSignal(state.currentEpoch);
                drawHypnogram();
                if (tabName === 'analysis') {
                    drawFrequencyAnalysis();
                    updateSleepArchitecture();
                    updateSleepCycles();
                    updateAnnotatorAgreement();
                    drawTransitionMatrix();
                    updateSignalQuality();
                    updateAdvancedAnalysis();
                }
            }); });
        }

        // Persister l'onglet actif
        try { localStorage.setItem('neuralix-active-tab', tabName); } catch(e) {}

        // Notifier la sidebar du changement d'onglet
        if (typeof window.sidebarNotifyTabChanged === 'function') {
            window.sidebarNotifyTabChanged(tabName);
        }
    }

    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    // -----------------------------------------------------------------------
    // Chargement fichier (onglet Analyse d'un fichier)
    // -----------------------------------------------------------------------
    const analysisDataInput = document.getElementById('analysisDataInput');
    if (analysisDataInput) {
        analysisDataInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            document.getElementById('analysisDataName').textContent = file.name;
            await loadFile(file);
            // Masquer le hint (le fichier de donnees est charge)
            const hint = document.getElementById('analysisHint');
            if (hint) hint.style.display = 'none';
            if (typeof window.sidebarNotifyAnalysisData === 'function') {
                window.sidebarNotifyAnalysisData(true);
            }
            e.target.value = '';
        });
    }

    const analysisJsonInput = document.getElementById('analysisJsonInput');
    if (analysisJsonInput) {
        analysisJsonInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            document.getElementById('analysisJsonName').textContent = file.name;
            await importSession(file);
            // Indiquer si le signal nuit complete n'est pas disponible
            const hint = document.getElementById('analysisHint');
            if (hint && !state.fullNightEog && !state.fullNightEogFiltre) {
                hint.style.display = 'block';
                hint.textContent = 'Signal EOG (nuit complète) non disponible. '
                    + 'Chargez le fichier de données correspondant pour afficher le signal.';
            } else if (hint) {
                hint.style.display = 'none';
            }
            if (typeof window.sidebarNotifyAnalysisData === 'function') {
                window.sidebarNotifyAnalysisData(true);
            }
            e.target.value = '';
        });
    }

    // -----------------------------------------------------------------------
    // Redessiner TOUTE section qui redevient visible après avoir été masquée
    // -----------------------------------------------------------------------
    const _sectionRefreshMap = {
        // Sections principales (canvas)
        'fullNightSection':        () => drawFullNight(),
        'signalSection':           () => { if (state.currentEpochData.length > 0) drawSignal(state.currentEpoch); },
        'hypnogramSection':        () => drawHypnogram(),
        'sleepArchSection':        () => updateSleepArchitecture(),
        'sleepCyclesSection':      () => updateSleepCycles(),
        'spectrogramSection':      () => { if (state._cachedSpectroBrut) drawSpectrogram(document.getElementById('spectroCanvasBrut'), state._cachedSpectroBrut, 'EOG brut'); if (state._cachedSpectroFiltre) drawSpectrogram(document.getElementById('spectroCanvasFiltre'), state._cachedSpectroFiltre, 'EOG filtré'); },
        'frequencySection':        () => drawFrequencyAnalysis(),
        'transitionSection':       () => drawTransitionMatrix(),
        'annotAgreementSection':   () => updateAnnotatorAgreement(),
        'signalQualitySection':    () => updateSignalQuality(),
        'historySection':          () => rebuildHistoryTable(),
        'statsSection':            () => { updateStats(); updateFilteredStats(); },
        // Outils avancés
        'dashboardSection':        () => updateDashboard(),
        'calibrationSection':      () => drawCalibrationCurve(),
        'blandAltmanSection':      () => drawBlandAltman(),
        'iccSection':              () => updateICC(),
        'heatmapSection':          () => drawHeatmap(),
        'confidenceOverlaySection':() => drawConfidenceOverlay(),
        'sunburstSection':         () => drawSunburst(),
        'errorTimelineSection':    () => drawErrorTimeline(),
        'confusionHeatmapSection': () => drawConfusionHeatmap(),
        'errorBurstsSection':      () => analyzeErrorBursts(),
    };
    window.addEventListener('neuralix-section-shown', (e) => {
        const id = e.detail && e.detail.id;
        const fn = _sectionRefreshMap[id];
        const hasData = state.predictions.length > 0 || state.fullNightEog || state.fullNightEogFiltre;
        if (fn && hasData) {
            requestAnimationFrame(() => requestAnimationFrame(() => {
                try { fn(); } catch (err) { console.warn('Section refresh error:', id, err); }
            }));
        }
    });

    // -----------------------------------------------------------------------
    // Initialisation multi-fichiers (si multifile.js est charge)
    // -----------------------------------------------------------------------
    if (typeof mfInit === 'function') mfInit();

    // -----------------------------------------------------------------------
    // Sauvegarde garantie avant fermeture/rechargement
    // -----------------------------------------------------------------------
    window.addEventListener('beforeunload', () => {
        // Flush les timers debounced
        if (_savePredTimer) { clearTimeout(_savePredTimer); _savePredTimer = null; }
        if (_saveUITimer)   { clearTimeout(_saveUITimer);   _saveUITimer = null; }
        // Sauvegarde synchrone dans sessionStorage (isole par onglet)
        try { sessionStorage.setItem(LS_PRED_KEY, JSON.stringify(_buildPredData())); } catch (e) { }
        try {
            sessionStorage.setItem(LS_UI_KEY, JSON.stringify({
                fnShowBrut: state.fnShowBrut, fnShowFiltre: state.fnShowFiltre,
                fnDisplayMode: state.fnDisplayMode, fnCanvasHeight: state.fnCanvasHeight,
                fnZoomLevel: state.fnZoomLevel, fnViewStart: state.fnView.startSample,
                fnViewVisible: state.fnView.visibleSamples, statsFilter: state.statsFilter,
                confidenceThreshold: state.confidenceThreshold, hypnoZoom: state.hypnoZoom,
                speed: state.speed,
            }));
        } catch (e) { }
    });

    // Presets
    document.getElementById('presetSaveBtn')?.addEventListener('click', presetsSave);
    document.getElementById('presetDeleteBtn')?.addEventListener('click', presetsDelete);
    presetsRenderList();

    log('Neuralix Web Tester initialisé', 'info');
    log('Étapes : 1) Connecter le port série  2) Charger un fichier EOG  3) Démarrer', 'info');

    if (!('serial' in navigator)) {
        log('ATTENTION: Web Serial API non disponible. Utilisez Chrome ou Edge.', 'error');
    }
});
