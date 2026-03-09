/* ============================================================================
   Neuralix Web Tester - Sidebar : visibilite des sections
   ============================================================================ */
(function () {
    'use strict';

    var STORAGE_KEY = 'neuralix-sidebar-hidden';
    var STORAGE_OPEN = 'neuralix-sidebar-open';
    var STORAGE_ZOOM = 'neuralix-page-zoom';
    var STORAGE_LOCK = 'neuralix-sidebar-lock';

    /* ------------------------------------------------------------------
       Definition des sections par onglet, avec icone et label
       alwaysOn = true : toujours active, non togglable par l'utilisateur
       requiresData = true : desactivee quand aucun fichier n'est charge
       ------------------------------------------------------------------ */
    var SECTION_DEFS = {
        realtime: [
            { id: 'controls',          icon: '\u2699',  label: 'Contr\u00f4les',            alwaysOn: true },
            { id: 'progressSection',   icon: '\u25B6',  label: 'Progression',              requiresData: true },
            { id: 'fullNightSection',  icon: '\uD83C\uDF19', label: 'Signal nuit compl\u00e8te', requiresData: true },
            { id: 'signalSection',     icon: '\uD83D\uDCC9', label: 'Signal epoch',         requiresData: true },
            { id: 'hypnogramSection',  icon: '\uD83D\uDCC8', label: 'Hypnogramme',          requiresData: true },
            { id: 'historySection',    icon: '\uD83D\uDCCB', label: 'Historique',            requiresData: true },
            { id: 'statsSection',      icon: '\uD83D\uDCCA', label: 'Statistiques',          requiresData: true },
            { id: 'reportSection',     icon: '\uD83D\uDCBE', label: 'Sauvegarde',            requiresData: true },
            { id: 'configSection',     icon: '\uD83D\uDD27', label: 'Configuration',          alwaysOn: true },
            { id: 'logSection',        icon: '\uD83D\uDCDD', label: 'Console',               alwaysOn: true }
        ],
        analysis: [
            { id: 'analysisLoaderSection', icon: '\uD83D\uDCC2', label: 'Charger fichier',        alwaysOn: true },
            { id: 'dashboardSection',      icon: '\uD83D\uDCCA', label: 'Dashboard',               requiresData: true },
            { id: 'fullNightSection',      icon: '\uD83C\uDF19', label: 'Signal nuit compl\u00e8te', requiresData: true },
            { id: 'signalSection',         icon: '\uD83D\uDCC9', label: 'Signal epoch',            requiresData: true },
            { id: 'hypnogramSection',      icon: '\uD83D\uDCC8', label: 'Hypnogramme',             requiresData: true },
            { id: 'sleepArchSection',      icon: '\uD83C\uDFDB', label: 'Architecture sommeil',    requiresData: true },
            { id: 'sleepCyclesSection',    icon: '\uD83D\uDD04', label: 'Cycles sommeil',           requiresData: true },
            { id: 'spectrogramSection',    icon: '\uD83C\uDF08', label: 'Spectrogramme',            requiresData: true },
            { id: 'frequencySection',      icon: '\uD83C\uDF10', label: 'Analyse fr\u00e9quentielle', requiresData: true },
            { id: 'transitionSection',     icon: '\u2194',  label: 'Transitions',                requiresData: true },
            { id: 'annotAgreementSection', icon: '\uD83E\uDD1D', label: 'Accord annotateurs',      requiresData: true },
            { id: 'signalQualitySection',  icon: '\u2714',  label: 'Qualit\u00e9 signal',         requiresData: true },
            { id: 'historySection',        icon: '\uD83D\uDCCB', label: 'Historique',               requiresData: true },
            { id: 'statsSection',          icon: '\uD83D\uDCCA', label: 'Statistiques',             requiresData: true },
            { id: 'calibrationSection',    icon: '\uD83D\uDCC8', label: 'Calibration',              requiresData: true },
            { id: 'blandAltmanSection',    icon: '\uD83D\uDD2C', label: 'Bland-Altman',             requiresData: true },
            { id: 'iccSection',            icon: '\uD83C\uDFAF', label: 'ICC',                      requiresData: true },
            { id: 'heatmapSection',        icon: '\uD83D\uDDFA', label: 'Heatmap temporelle',       requiresData: true },
            { id: 'confidenceOverlaySection', icon: '\uD83D\uDCC9', label: 'Hypno + Confiance',     requiresData: true },
            { id: 'sunburstSection',       icon: '\uD83C\uDF1F', label: 'Sunburst',                 requiresData: true },
            { id: 'errorTimelineSection',  icon: '\u26A0',  label: 'Timeline erreurs',          requiresData: true },
            { id: 'confusionHeatmapSection', icon: '\uD83D\uDD25', label: 'Confusion heatmap',     requiresData: true },
            { id: 'errorBurstsSection',    icon: '\uD83D\uDCA5', label: 'Erreurs cons\u00e9cutives', requiresData: true },
            { id: 'presetsSection',        icon: '\uD83D\uDCBE', label: 'Profils / Presets' }
        ],
        multifile: [
            { id: 'mfLoaderSection',     icon: '\uD83D\uDCC2', label: 'Chargement sessions', alwaysOn: true },
            { id: 'mfKappaSection',      icon: '\uD83E\uDD1D', label: 'Accord annotateurs',  requiresData: true },
            { id: 'mfStatsSection',      icon: '\uD83D\uDCCA', label: 'Statistiques agr\u00e9g\u00e9es', requiresData: true },
            { id: 'mfMetricsSection',    icon: '\uD83C\uDFAF', label: 'M\u00e9triques par stade', requiresData: true },
            { id: 'mfSummarySection',    icon: '\uD83D\uDCCB', label: 'R\u00e9sum\u00e9 par fichier', requiresData: true },
            { id: 'mfFileStatsSection',  icon: '\uD83D\uDCC4', label: 'Stats fichier',       requiresData: true },
            { id: 'mfHypnoSection',      icon: '\uD83D\uDCC8', label: 'Hypnogrammes',        requiresData: true },
            { id: 'mfHistorySection',    icon: '\uD83D\uDD0D', label: 'Historique fichier',   requiresData: true },
            { id: 'mfDurationSection',   icon: '\u23F1',  label: 'Dur\u00e9e des stades', requiresData: true },
            { id: 'mfExportSection',     icon: '\uD83D\uDCE4', label: 'Export',              requiresData: true },
            { id: 'mfCalibrationSection', icon: '📈', label: 'Calibration',         requiresData: true },
            { id: 'mfBlandAltmanSection', icon: '🔬', label: 'Bland-Altman',        requiresData: true },
            { id: 'mfIccSection',         icon: '🎯', label: 'ICC',                 requiresData: true },
            { id: 'mfHeatmapSection',     icon: '🗺', label: 'Heatmap temporelle',  requiresData: true },
            { id: 'mfSunburstSection',    icon: '🌟', label: 'Sunburst',            requiresData: true },
            { id: 'mfErrorTimelineSection', icon: '⚠', label: 'Timeline erreurs',   requiresData: true },
            { id: 'mfDashboardSection',    icon: '\uD83D\uDCCA', label: 'Dashboard',              requiresData: true },
            { id: 'mfConfusionHeatmapSection', icon: '\uD83D\uDD25', label: 'Confusion heatmap',  requiresData: true },
            { id: 'mfErrorBurstsSection',  icon: '\uD83D\uDCA5', label: 'Erreurs cons\u00e9cutives', requiresData: true }
        ],
        comparative: [
            { id: 'cmpLoaderSection',    icon: '\uD83D\uDCC2', label: 'Chargement algos',     alwaysOn: true },
            { id: 'cmpConfSection',      icon: '\uD83C\uDF9A', label: 'Seuil confiance',      requiresData: true },
            { id: 'cmpGlobalSection',    icon: '\uD83D\uDCCA', label: 'Stats globales',       requiresData: true },
            { id: 'cmpDistribSection',   icon: '\uD83D\uDCC8', label: 'Distribution stades',  requiresData: true },
            { id: 'cmpPerStageSection',  icon: '\uD83C\uDFAF', label: 'Pr\u00e9cision par stade', requiresData: true },
            { id: 'cmpMetricsSection',   icon: '\uD83D\uDCCF', label: 'M\u00e9triques (P/R/F1)',  requiresData: true },
            { id: 'cmpConfusionSection', icon: '\uD83D\uDD22', label: 'Matrices confusion',   requiresData: true },
            { id: 'cmpKappaSection',     icon: '\uD83E\uDD1D', label: 'Accord Kappa',         requiresData: true }
        ]
    };

    var TAB_LABELS = {
        realtime:    'Temps r\u00e9el',
        analysis:    'Analyse fichier',
        multifile:   'Multi-fichiers',
        comparative: 'Comparatif algos'
    };

    /* ------------------------------------------------------------------
       State
       ------------------------------------------------------------------ */
    var hiddenSections = {};   // { sectionId: true }
    var currentTab = 'realtime';
    var tabHasData = { realtime: false, analysis: false, multifile: false, comparative: false };
    var sidebarLocked = false;

    /* ------------------------------------------------------------------
       Build a set of alwaysOn section ids (for quick lookup)
       ------------------------------------------------------------------ */
    var alwaysOnIds = {};
    (function () {
        var tabs = Object.keys(SECTION_DEFS);
        for (var t = 0; t < tabs.length; t++) {
            var defs = SECTION_DEFS[tabs[t]];
            for (var i = 0; i < defs.length; i++) {
                if (defs[i].alwaysOn) alwaysOnIds[defs[i].id] = true;
            }
        }
    })();

    /* ------------------------------------------------------------------
       Persistence
       ------------------------------------------------------------------ */
    function loadHidden() {
        try {
            var stored = localStorage.getItem(STORAGE_KEY);
            if (stored) hiddenSections = JSON.parse(stored);
        } catch (e) { /* ignore */ }
        // Nettoyer : ne jamais cacher une section alwaysOn
        var dirty = false;
        for (var id in hiddenSections) {
            if (alwaysOnIds[id]) {
                delete hiddenSections[id];
                dirty = true;
            }
        }
        if (dirty) saveHidden();
    }

    function saveHidden() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(hiddenSections));
        } catch (e) { /* ignore */ }
    }

    function loadSidebarOpen() {
        try {
            return localStorage.getItem(STORAGE_OPEN) === 'true';
        } catch (e) { return false; }
    }

    function saveSidebarOpen(open) {
        try {
            localStorage.setItem(STORAGE_OPEN, open ? 'true' : 'false');
        } catch (e) { /* ignore */ }
    }

    function loadSidebarLock() {
        try { return localStorage.getItem(STORAGE_LOCK) === 'true'; } catch (e) { return false; }
    }

    function saveSidebarLock(locked) {
        try { localStorage.setItem(STORAGE_LOCK, locked ? 'true' : 'false'); } catch (e) { /* ignore */ }
    }

    /* ------------------------------------------------------------------
       Check if a section is effectively disabled (no data loaded)
       ------------------------------------------------------------------ */
    function isSectionDisabled(def, tab) {
        if (def.alwaysOn) return false;
        var t = tab || currentTab;
        if (def.requiresData && !tabHasData[t]) return true;
        return false;
    }

    /* ------------------------------------------------------------------
       Apply visibility to a section in the DOM
       ------------------------------------------------------------------ */
    function applySectionVisibility(sectionId, def) {
        var el = document.getElementById(sectionId);
        if (!el) return;
        // alwaysOn : toujours visible
        if (def && def.alwaysOn) {
            el.classList.remove('sidebar-section-hidden');
            el.style.removeProperty('display');
            return;
        }
        var disabled = def && isSectionDisabled(def);
        if (hiddenSections[sectionId] || disabled) {
            el.classList.add('sidebar-section-hidden');
        } else {
            el.classList.remove('sidebar-section-hidden');
            // Nettoyer le style.display inline qui pourrait bloquer la visibilite
            el.style.removeProperty('display');
        }
    }

    function applyAllVisibility() {
        var defs = SECTION_DEFS[currentTab];
        if (!defs) return;
        var processed = {};
        for (var i = 0; i < defs.length; i++) {
            var def = defs[i];
            if (!processed[def.id]) {
                applySectionVisibility(def.id, def);
                processed[def.id] = true;
            }
        }
    }

    /* ------------------------------------------------------------------
       Get section defs ordered by current DOM order
       ------------------------------------------------------------------ */
    function getOrderedDefs(tab) {
        var defs = SECTION_DEFS[tab];
        if (!defs) return [];

        var defMap = {};
        for (var i = 0; i < defs.length; i++) {
            if (!defMap[defs[i].id]) defMap[defs[i].id] = defs[i];
        }

        // Realtime et analysis partagent mainSections (data-tabs),
        // multifile utilise tabMultifile
        var containerId = (tab === 'multifile') ? 'tabMultifile'
                        : (tab === 'comparative') ? 'tabComparative'
                        : 'mainSections';
        var tabEl = document.getElementById(containerId);
        if (!tabEl) return defs;

        var ordered = [];
        var used = {};
        var sections = tabEl.querySelectorAll(':scope > section');
        for (var j = 0; j < sections.length; j++) {
            var id = sections[j].id;
            if (id && defMap[id] && !used[id]) {
                ordered.push(defMap[id]);
                used[id] = true;
            }
        }

        // Fallback : ajouter les defs absentes du DOM
        for (var k = 0; k < defs.length; k++) {
            if (!used[defs[k].id]) {
                ordered.push(defs[k]);
                used[defs[k].id] = true;
            }
        }

        return ordered;
    }

    /* ------------------------------------------------------------------
       Reorder DOM sections to match a given order of ids
       ------------------------------------------------------------------ */
    function reorderDOMSections(orderedIds) {
        var containerId = (currentTab === 'multifile') ? 'tabMultifile'
                        : (currentTab === 'comparative') ? 'tabComparative'
                        : 'mainSections';
        var container = document.getElementById(containerId);
        if (!container) return;

        for (var i = 0; i < orderedIds.length; i++) {
            var el = document.getElementById(orderedIds[i]);
            if (el && el.parentElement === container) {
                container.appendChild(el);
            }
        }

        // Persister l'ordre dans sections.js localStorage
        saveSectionOrder();
    }

    /* ------------------------------------------------------------------
       Sauvegarder l'ordre des sections (meme format que sections.js)
       ------------------------------------------------------------------ */
    function saveSectionOrder() {
        var STORAGE_ORDER = 'neuralix-order-v2';
        try {
            var order = JSON.parse(localStorage.getItem(STORAGE_ORDER) || '{}');
            document.querySelectorAll('.tab-content').forEach(function (tab) {
                order[tab.id] = [];
                tab.querySelectorAll(':scope > section').forEach(function (s) {
                    if (s.id) order[tab.id].push(s.id);
                });
            });
            localStorage.setItem(STORAGE_ORDER, JSON.stringify(order));
        } catch (e) { /* ignore */ }
    }

    /* ------------------------------------------------------------------
       Build sidebar items for the current tab
       ------------------------------------------------------------------ */
    var dragState = { draggedItem: null, draggedId: null };

    /* ------------------------------------------------------------------
       Zoom page
       ------------------------------------------------------------------ */
    var currentZoom = 100;

    function loadZoom() {
        try {
            var z = parseInt(localStorage.getItem(STORAGE_ZOOM), 10);
            if (z >= 50 && z <= 150) currentZoom = z;
        } catch (e) { /* ignore */ }
    }

    function saveZoom() {
        try { localStorage.setItem(STORAGE_ZOOM, String(currentZoom)); } catch (e) { /* ignore */ }
    }

    function applyZoom() {
        var zoomFactor = currentZoom / 100;
        document.body.style.zoom = zoomFactor;
        // Contre-zoomer la sidebar et le toggle btn pour qu'ils gardent leur taille
        var sidebar = document.getElementById('sectionSidebar');
        var toggleBtn = document.getElementById('sidebarToggleBtn');
        var inverseZoom = 1 / zoomFactor;
        if (sidebar) sidebar.style.zoom = inverseZoom;
        if (toggleBtn) toggleBtn.style.zoom = inverseZoom;
        // Redessiner les canvas qui dependent du zoom
        window.dispatchEvent(new Event('neuralix-zoom-changed'));
    }

    function buildSidebar() {
        var container = document.getElementById('sidebarItems');
        if (!container) return;
        container.innerHTML = '';

        var defs = getOrderedDefs(currentTab);
        if (!defs.length) return;

        // Tab title
        var titleEl = document.createElement('div');
        titleEl.className = 'sidebar-tab-title';
        titleEl.textContent = TAB_LABELS[currentTab] || currentTab;
        container.appendChild(titleEl);

        var processed = {};
        for (var i = 0; i < defs.length; i++) {
            var def = defs[i];
            if (processed[def.id]) continue;
            processed[def.id] = true;

            var disabled = isSectionDisabled(def);
            var isVisible = (def.alwaysOn || !hiddenSections[def.id]) && !disabled;

            var item = document.createElement('div');
            item.className = 'sidebar-item';
            if (isVisible) item.classList.add('active');
            if (def.alwaysOn) item.classList.add('always-on');
            if (disabled) item.classList.add('disabled-section');
            if (hiddenSections[def.id] && !disabled && !def.alwaysOn) item.classList.add('hidden-section');
            item.setAttribute('data-section-id', def.id);
            item.setAttribute('draggable', 'true');

            var icon = document.createElement('span');
            icon.className = 'sidebar-item-icon';
            icon.textContent = def.icon;

            var label = document.createElement('span');
            label.className = 'sidebar-item-label';
            label.textContent = def.label;

            var toggle = document.createElement('span');
            toggle.className = 'sidebar-item-toggle';

            item.appendChild(icon);
            item.appendChild(label);
            item.appendChild(toggle);

            // Toggle visibility (click) — seulement pour les sections non-alwaysOn
            if (!def.alwaysOn) {
                item.addEventListener('click', (function (sectionId, itemEl, defRef) {
                    return function (e) {
                        // Ne pas toggler si on vient de drag
                        if (dragState._justDragged) return;
                        if (isSectionDisabled(defRef)) return;

                        if (hiddenSections[sectionId]) {
                            delete hiddenSections[sectionId];
                            itemEl.classList.add('active');
                            itemEl.classList.remove('hidden-section');
                        } else {
                            hiddenSections[sectionId] = true;
                            itemEl.classList.remove('active');
                            itemEl.classList.add('hidden-section');
                        }
                        applySectionVisibility(sectionId, defRef);
                        saveHidden();
                        // Notifier que la visibilité d'une section a changé
                        if (!hiddenSections[sectionId]) {
                            window.dispatchEvent(new CustomEvent('neuralix-section-shown', { detail: { id: sectionId } }));
                        }
                    };
                })(def.id, item, def));
            }

            // Drag & drop dans la sidebar pour reordonner
            setupItemDrag(item, container);

            container.appendChild(item);
        }

        applyAllVisibility();
    }

    /* ------------------------------------------------------------------
       Drag & drop des items dans la sidebar
       ------------------------------------------------------------------ */
    function setupItemDrag(item, container) {
        item.addEventListener('dragstart', function (e) {
            dragState.draggedItem = item;
            dragState.draggedId = item.getAttribute('data-section-id');
            dragState._justDragged = false;
            item.classList.add('sidebar-item-dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', dragState.draggedId);
            // Petit delai pour que le style s'applique
            setTimeout(function () { item.style.opacity = '0.4'; }, 0);
        });

        item.addEventListener('dragend', function () {
            item.classList.remove('sidebar-item-dragging');
            item.style.opacity = '';
            clearSidebarDropIndicators(container);

            if (dragState._moved) {
                dragState._justDragged = true;
                // Lire le nouvel ordre depuis la sidebar et l'appliquer au DOM
                var newOrder = [];
                container.querySelectorAll('.sidebar-item[data-section-id]').forEach(function (el) {
                    newOrder.push(el.getAttribute('data-section-id'));
                });
                reorderDOMSections(newOrder);
                // Reset apres un court delai (pour eviter que le click se declenche)
                setTimeout(function () { dragState._justDragged = false; }, 100);
            }

            dragState.draggedItem = null;
            dragState.draggedId = null;
            dragState._moved = false;
        });

        item.addEventListener('dragover', function (e) {
            if (!dragState.draggedItem || dragState.draggedItem === item) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            clearSidebarDropIndicators(container);
            var rect = item.getBoundingClientRect();
            var mid = rect.top + rect.height / 2;
            if (e.clientY < mid) {
                item.classList.add('sidebar-item-drag-over-top');
            } else {
                item.classList.add('sidebar-item-drag-over-bottom');
            }
        });

        item.addEventListener('dragleave', function () {
            item.classList.remove('sidebar-item-drag-over-top', 'sidebar-item-drag-over-bottom');
        });

        item.addEventListener('drop', function (e) {
            e.preventDefault();
            if (!dragState.draggedItem || dragState.draggedItem === item) return;
            clearSidebarDropIndicators(container);

            var rect = item.getBoundingClientRect();
            var mid = rect.top + rect.height / 2;
            if (e.clientY < mid) {
                container.insertBefore(dragState.draggedItem, item);
            } else {
                container.insertBefore(dragState.draggedItem, item.nextSibling);
            }
            dragState._moved = true;
        });
    }

    function clearSidebarDropIndicators(container) {
        container.querySelectorAll('.sidebar-item-drag-over-top, .sidebar-item-drag-over-bottom')
            .forEach(function (el) {
                el.classList.remove('sidebar-item-drag-over-top', 'sidebar-item-drag-over-bottom');
            });
    }

    /* ------------------------------------------------------------------
       Toggle sidebar open/collapsed
       ------------------------------------------------------------------ */
    function toggleSidebar() {
        var sidebar = document.getElementById('sectionSidebar');
        if (!sidebar) return;
        var isCollapsed = sidebar.classList.contains('collapsed');
        if (isCollapsed) {
            sidebar.classList.remove('collapsed');
            document.body.classList.add('sidebar-open');
            saveSidebarOpen(true);
        } else {
            sidebar.classList.add('collapsed');
            document.body.classList.remove('sidebar-open');
            saveSidebarOpen(false);
        }
    }

    /* ------------------------------------------------------------------
       Changement d'onglet
       ------------------------------------------------------------------ */
    function switchToTab(tab) {
        if (tab && tab !== currentTab) {
            currentTab = tab;
            buildSidebar();
        }
    }

    function detectCurrentTab() {
        var activeBtn = document.querySelector('.tab-btn.active');
        if (activeBtn) {
            switchToTab(activeBtn.getAttribute('data-tab'));
        }
    }

    /* ------------------------------------------------------------------
       API publique : notifier la sidebar que des donnees sont disponibles
       ------------------------------------------------------------------ */
    function notifyTabData(tab, hasData) {
        var changed = (tabHasData[tab] !== hasData);
        tabHasData[tab] = hasData;
        if (changed && currentTab === tab) {
            buildSidebar();
        }
    }

    window.sidebarNotifyMfData = function (hasFiles) {
        notifyTabData('multifile', hasFiles);
    };

    window.sidebarNotifyRealtimeData = function (hasData) {
        notifyTabData('realtime', hasData);
    };

    window.sidebarNotifyAnalysisData = function (hasData) {
        notifyTabData('analysis', hasData);
    };

    window.sidebarNotifyComparativeData = function (hasData) {
        notifyTabData('comparative', hasData);
    };

    /* ------------------------------------------------------------------
       API publique : notifier la sidebar du changement d'onglet
       ------------------------------------------------------------------ */
    window.sidebarNotifyTabChanged = function (tabName) {
        switchToTab(tabName);
    };

    /* ------------------------------------------------------------------
       API publique : notifier la sidebar que l'ordre des sections a change
       ------------------------------------------------------------------ */
    window.sidebarNotifyOrderChanged = function () {
        buildSidebar();
    };

    /* ------------------------------------------------------------------
       Init
       ------------------------------------------------------------------ */
    function init() {
        loadHidden();
        loadZoom();
        applyZoom();

        // Zoom slider (en bas de la sidebar, element statique dans le HTML)
        var zoomSlider = document.getElementById('sidebarZoomSlider');
        var zoomLabel = document.getElementById('sidebarZoomLabel');
        if (zoomSlider && zoomLabel) {
            zoomSlider.value = String(currentZoom);
            zoomLabel.textContent = 'Zoom : ' + currentZoom + '%';

            zoomSlider.addEventListener('input', function () {
                currentZoom = parseInt(zoomSlider.value, 10);
                zoomLabel.textContent = 'Zoom : ' + currentZoom + '%';
                applyZoom();
                saveZoom();
            });

            zoomSlider.addEventListener('dblclick', function () {
                currentZoom = 100;
                zoomSlider.value = '100';
                zoomLabel.textContent = 'Zoom : 100%';
                applyZoom();
                saveZoom();
            });
        }

        // Sidebar toggle button
        var toggleBtn = document.getElementById('sidebarToggleBtn');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                toggleSidebar();
            });
        }

        // Restore open state
        if (loadSidebarOpen()) {
            var sidebar = document.getElementById('sectionSidebar');
            if (sidebar) {
                sidebar.classList.remove('collapsed');
                document.body.classList.add('sidebar-open');
            }
        }

        // Lock button
        sidebarLocked = loadSidebarLock();
        var lockBtn = document.getElementById('sidebarLockBtn');
        if (lockBtn) {
            lockBtn.textContent = sidebarLocked ? '\u{1F512}' : '\u{1F513}';
            if (sidebarLocked) lockBtn.classList.add('locked');
            lockBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                sidebarLocked = !sidebarLocked;
                lockBtn.textContent = sidebarLocked ? '\u{1F512}' : '\u{1F513}';
                lockBtn.classList.toggle('locked', sidebarLocked);
                saveSidebarLock(sidebarLocked);
            });
        }

        // Fermer la sidebar quand on clique en dehors (sauf si verrouillee)
        document.addEventListener('click', function (e) {
            if (sidebarLocked) return;
            var sidebar = document.getElementById('sectionSidebar');
            if (!sidebar || sidebar.classList.contains('collapsed')) return;
            var toggleBtn = document.getElementById('sidebarToggleBtn');
            if (sidebar.contains(e.target)) return;
            if (toggleBtn && toggleBtn.contains(e.target)) return;
            sidebar.classList.add('collapsed');
            document.body.classList.remove('sidebar-open');
            saveSidebarOpen(false);
        });

        // Build initial sidebar
        detectCurrentTab();
        buildSidebar();

        // Observe tab switches via click on tab buttons
        document.querySelectorAll('.tab-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                setTimeout(function () {
                    detectCurrentTab();
                }, 50);
            });
        });
    }

    /* ------------------------------------------------------------------
       Boot
       ------------------------------------------------------------------ */
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
