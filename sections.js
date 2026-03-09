/* ============================================================================
   Neuralix Web Tester - Sections: Collapse / Expand + Drag & Drop Reorder
   ============================================================================ */
(function () {
    'use strict';

    var STORAGE_COLLAPSED = 'neuralix-collapsed';
    var STORAGE_EXPANDED  = 'neuralix-expanded';
    var STORAGE_ORDER     = 'neuralix-order-v2';

    /* Titres pour les sections qui n'ont pas de h2 */
    var SECTION_TITLES = {
        controls:        'Contrôles',
        progressSection: 'Progression'
    };

    /* ------------------------------------------------------------------ */
    /*  Init                                                               */
    /* ------------------------------------------------------------------ */
    function init() {
        document.querySelectorAll('.tab-content').forEach(initTab);
        restoreState();
    }

    /* ------------------------------------------------------------------ */
    /*  Init d'un onglet : chevron + body wrapper + drag handle            */
    /* ------------------------------------------------------------------ */
    function initTab(tab) {
        var sections = Array.from(tab.querySelectorAll(':scope > section'));

        sections.forEach(function (section) {
            /* --- h2 -------------------------------------------------- */
            var h2 = section.querySelector(':scope > h2');
            if (!h2) {
                h2 = document.createElement('h2');
                h2.textContent = SECTION_TITLES[section.id] || 'Section';
                section.insertBefore(h2, section.firstChild);
            }

            /* --- Envelopper le contenu apres h2 dans .section-body --- */
            var body = document.createElement('div');
            body.className = 'section-body';
            while (h2.nextSibling) body.appendChild(h2.nextSibling);
            section.appendChild(body);

            /* --- Chevron --------------------------------------------- */
            var chevron = document.createElement('span');
            chevron.className = 'section-chevron';
            h2.insertBefore(chevron, h2.firstChild);

            /* --- Drag handle (en haut a gauche du header) -------------- */
            var handle = document.createElement('span');
            handle.className = 'section-drag-handle';
            handle.title = 'Glisser pour réorganiser';
            h2.insertBefore(handle, h2.firstChild);

            /* --- h2 style -------------------------------------------- */
            h2.classList.add('section-header');

            /* --- Click = toggle collapse ----------------------------- */
            h2.addEventListener('click', function (e) {
                if (e.target.closest('.section-drag-handle') ||
                    e.target.closest('button')) return;
                section.classList.toggle('section-collapsed');
                saveCollapsed();
                // Si la section vient d'être ouverte, notifier pour redessiner les canvas
                if (!section.classList.contains('section-collapsed')) {
                    section.dispatchEvent(new Event('section-expand'));
                }
            });

            /* --- Drag : activer uniquement depuis le handle ---------- */
            handle.addEventListener('mousedown', function () {
                section.setAttribute('draggable', 'true');
            });

            document.addEventListener('mouseup', function () {
                section.removeAttribute('draggable');
            });

            section.addEventListener('dragstart', function (e) {
                if (section.getAttribute('draggable') !== 'true') {
                    e.preventDefault();
                    return;
                }
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', section.id);
                section.classList.add('section-dragging');
                tab._draggedSection = section;
            });

            section.addEventListener('dragend', function () {
                section.classList.remove('section-dragging');
                section.removeAttribute('draggable');
                tab._draggedSection = null;
                clearDropIndicators(tab);
                saveOrder();
            });

            section.addEventListener('dragover', function (e) {
                var dragged = tab._draggedSection;
                if (!dragged || dragged === section) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';

                clearDropIndicators(tab);
                var rect = section.getBoundingClientRect();
                var mid  = rect.top + rect.height / 2;
                if (e.clientY < mid) {
                    section.classList.add('section-drag-over-top');
                } else {
                    section.classList.add('section-drag-over-bottom');
                }
            });

            section.addEventListener('dragleave', function () {
                section.classList.remove('section-drag-over-top', 'section-drag-over-bottom');
            });

            section.addEventListener('drop', function (e) {
                e.preventDefault();
                var dragged = tab._draggedSection;
                if (!dragged || dragged === section) return;

                var rect = section.getBoundingClientRect();
                var mid  = rect.top + rect.height / 2;
                if (e.clientY < mid) {
                    tab.insertBefore(dragged, section);
                } else {
                    tab.insertBefore(dragged, section.nextSibling);
                }
                clearDropIndicators(tab);
            });
        });
    }

    /* ------------------------------------------------------------------ */
    /*  Helpers                                                            */
    /* ------------------------------------------------------------------ */
    function clearDropIndicators(tab) {
        tab.querySelectorAll('.section-drag-over-top, .section-drag-over-bottom')
           .forEach(function (s) {
               s.classList.remove('section-drag-over-top', 'section-drag-over-bottom');
           });
    }

    /* ------------------------------------------------------------------ */
    /*  Persistance localStorage                                           */
    /* ------------------------------------------------------------------ */
    function saveCollapsed() {
        var ids = [];
        var expandedIds = [];
        document.querySelectorAll('section.section-collapsed').forEach(function (s) {
            if (s.id) ids.push(s.id);
        });
        // Sauvegarder aussi les sections explicitement dépliées (pour overrider section-collapsed-default)
        document.querySelectorAll('section.section-collapsed-default').forEach(function (s) {
            if (s.id && !s.classList.contains('section-collapsed')) expandedIds.push(s.id);
        });
        try {
            localStorage.setItem(STORAGE_COLLAPSED, JSON.stringify(ids));
            localStorage.setItem(STORAGE_EXPANDED, JSON.stringify(expandedIds));
        } catch (e) { }
    }

    function saveOrder() {
        var order = {};
        document.querySelectorAll('.tab-content').forEach(function (tab) {
            order[tab.id] = [];
            tab.querySelectorAll(':scope > section').forEach(function (s) {
                if (s.id) order[tab.id].push(s.id);
            });
        });
        try { localStorage.setItem(STORAGE_ORDER, JSON.stringify(order)); } catch (e) { }
        // Notifier la sidebar pour synchroniser l'ordre des icones
        if (typeof window.sidebarNotifyOrderChanged === 'function') {
            window.sidebarNotifyOrderChanged();
        }
    }

    function restoreState() {
        /* collapsed — restaurer depuis localStorage */
        try {
            var stored = localStorage.getItem(STORAGE_COLLAPSED);
            if (stored) {
                var ids = JSON.parse(stored);
                ids.forEach(function (id) {
                    var el = document.getElementById(id);
                    if (el) el.classList.add('section-collapsed');
                });
            }
        } catch (e) { }

        /* sections marquées section-collapsed-default : replier sauf si explicitement dépliées */
        try {
            var expandedIds = JSON.parse(localStorage.getItem(STORAGE_EXPANDED) || '[]');
            document.querySelectorAll('.section-collapsed-default').forEach(function (el) {
                if (el.id && expandedIds.indexOf(el.id) === -1 && !el.classList.contains('section-collapsed')) {
                    el.classList.add('section-collapsed');
                }
            });
        } catch (e) {
            document.querySelectorAll('.section-collapsed-default').forEach(function (el) {
                el.classList.add('section-collapsed');
            });
        }

        /* order */
        try {
            var order = JSON.parse(localStorage.getItem(STORAGE_ORDER) || '{}');
            Object.keys(order).forEach(function (tabId) {
                var tab = document.getElementById(tabId);
                if (!tab) return;
                var knownIds = {};
                order[tabId].forEach(function (id) {
                    knownIds[id] = true;
                    var el = document.getElementById(id);
                    if (el && el.parentElement === tab) tab.appendChild(el);
                });
                // Append sections not in saved order to the end
                var remaining = tab.querySelectorAll(':scope > section');
                for (var r = 0; r < remaining.length; r++) {
                    if (remaining[r].id && !knownIds[remaining[r].id]) {
                        tab.appendChild(remaining[r]);
                    }
                }
            });
        } catch (e) { }
    }

    /* ------------------------------------------------------------------ */
    /*  Boot                                                               */
    /* ------------------------------------------------------------------ */
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
