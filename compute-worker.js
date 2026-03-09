/**
 * Neuralix Web Worker — Calculs lourds déportés
 *
 * Gère : FFT / spectre de puissance, calcul ROC (AUC), statistiques de bursts d'erreurs
 */

// ============================================================================
// FFT (Cooley-Tukey radix-2)
// ============================================================================

function fftWorker(re, im) {
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
                const tRe = curRe * re[i + j + len / 2] - curIm * im[i + j + len / 2];
                const tIm = curRe * im[i + j + len / 2] + curIm * re[i + j + len / 2];
                re[i + j + len / 2] = re[i + j] - tRe;
                im[i + j + len / 2] = im[i + j] - tIm;
                re[i + j] += tRe;
                im[i + j] += tIm;
                const tmp = curRe * wRe - curIm * wIm;
                curIm = curRe * wIm + curIm * wRe;
                curRe = tmp;
            }
        }
    }
}

function computePowerSpectrumWorker(signal, sampleRate) {
    const N = 8192;
    const halfN = N / 2;
    const hop = N / 2;

    const win = new Float64Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)));

    const avgPower = new Float64Array(halfN);
    let nSegments = 0;

    for (let start = 0; start + N <= signal.length; start += hop) {
        const re = new Float64Array(N);
        const im = new Float64Array(N);
        for (let i = 0; i < N; i++) re[i] = signal[start + i] * win[i];
        fftWorker(re, im);
        for (let i = 0; i < halfN; i++) {
            avgPower[i] += (re[i] * re[i] + im[i] * im[i]) / (N * N);
        }
        nSegments++;
    }

    if (nSegments === 0) {
        const re = new Float64Array(N);
        const im = new Float64Array(N);
        const len = Math.min(signal.length, N);
        for (let i = 0; i < len; i++) re[i] = signal[i] * win[i];
        fftWorker(re, im);
        for (let i = 0; i < halfN; i++) {
            avgPower[i] = (re[i] * re[i] + im[i] * im[i]) / (N * N);
        }
        nSegments = 1;
    }

    const freqs = new Float64Array(halfN);
    const power = new Float64Array(halfN);
    for (let i = 0; i < halfN; i++) {
        freqs[i] = i * sampleRate / N;
        power[i] = 10 * Math.log10(Math.max(avgPower[i] / nSegments, 1e-20));
    }
    return { freqs: Array.from(freqs), power: Array.from(power) };
}

// ============================================================================
// ROC AUC Computation
// ============================================================================

function computeROC(preds, stageNames) {
    const results = [];
    for (let si = 0; si < stageNames.length; si++) {
        const stage = stageNames[si];
        const pairs = [];
        for (const p of preds) {
            const isPositive = p.annot1 === stage ? 1 : 0;
            const prob = Array.isArray(p.probs) && p.probs.length > si ? p.probs[si] : 0;
            pairs.push({ score: prob > 1 ? prob / 100 : prob, label: isPositive });
        }
        pairs.sort((a, b) => b.score - a.score);

        const totalP = pairs.filter(x => x.label === 1).length;
        const totalN = pairs.length - totalP;
        if (totalP === 0 || totalN === 0) {
            results.push({ stage, auc: 0, points: [{ fpr: 0, tpr: 0 }, { fpr: 1, tpr: 1 }] });
            continue;
        }

        const points = [{ fpr: 0, tpr: 0 }];
        let tp = 0, fp = 0;
        for (const pair of pairs) {
            if (pair.label === 1) tp++; else fp++;
            points.push({ fpr: fp / totalN, tpr: tp / totalP });
        }

        let auc = 0;
        for (let i = 1; i < points.length; i++) {
            auc += (points[i].fpr - points[i - 1].fpr) * (points[i].tpr + points[i - 1].tpr) / 2;
        }

        // Downsample points for transfer (keep at most 500 points per curve)
        let sampledPoints = points;
        if (points.length > 500) {
            const step = Math.ceil(points.length / 500);
            sampledPoints = points.filter((_, idx) => idx % step === 0 || idx === points.length - 1);
        }

        results.push({ stage, auc, points: sampledPoints });
    }
    return results;
}

// ============================================================================
// Error Bursts Statistics
// ============================================================================

function computeErrorBursts(matchResults) {
    const bursts = [];
    let currentLen = 0;
    for (let i = 0; i < matchResults.length; i++) {
        if (!matchResults[i]) {
            currentLen++;
        } else {
            if (currentLen > 0) bursts.push(currentLen);
            currentLen = 0;
        }
    }
    if (currentLen > 0) bursts.push(currentLen);

    const totalErrors = matchResults.filter(m => !m).length;
    const isolated = bursts.filter(b => b === 1).length;
    const longBursts = bursts.filter(b => b >= 5);
    const maxBurst = bursts.length > 0 ? Math.max(...bursts) : 0;
    const avgLen = bursts.length > 0 ? bursts.reduce((a, b) => a + b, 0) / bursts.length : 0;
    const errorsInLong = longBursts.reduce((a, b) => a + b, 0);

    // Histogram
    let hist = [];
    if (bursts.length > 0) {
        const maxLen = Math.max(...bursts);
        hist = new Array(maxLen).fill(0);
        for (const b of bursts) hist[b - 1]++;
    }

    return {
        totalErrors, burstCount: bursts.length, isolated,
        longBurstCount: longBursts.length, maxBurst, avgLen, errorsInLong, hist
    };
}

// ============================================================================
// Message handler
// ============================================================================

self.onmessage = function(e) {
    const { type, id, data } = e.data;

    try {
        let result;
        switch (type) {
            case 'powerSpectrum':
                result = computePowerSpectrumWorker(data.signal, data.sampleRate);
                break;
            case 'roc':
                result = computeROC(data.preds, data.stageNames);
                break;
            case 'errorBursts':
                result = computeErrorBursts(data.matchResults);
                break;
            default:
                throw new Error('Unknown task type: ' + type);
        }
        self.postMessage({ id, type, result });
    } catch (err) {
        self.postMessage({ id, type, error: err.message });
    }
};
