/**
 * LACIEVAULT · Script
 * Búsqueda AniList + colección personal + paneles favoritos
 * Almacenamiento: Supabase (auth.js)
 */

/* ── State ──────────────────────────────────────────────── */
let myLibrary        = [];
let currentManga     = null;
let editingIndex     = null;
let currentView      = 'grid';
let currentFilter    = 'all';
let searchTypeFilter = 'all';

/* ── DOM refs ───────────────────────────────────────────── */
const searchInput   = document.getElementById('searchInput');
const previewArea   = document.getElementById('preview-area');
const libraryGrid   = document.getElementById('library-grid');
const toastEl       = document.getElementById('toast');
const resultsHolder = document.getElementById('searchResults');
const librarySearch = document.getElementById('librarySearch');

/* ── Init ───────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
    initAuth(); // en auth.js → al loguearse llama loadLibraryFromDB()
    wireEvents();
});

/* ── Event Wiring ───────────────────────────────────────── */
function wireEvents() {
    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (suggestionsIndex < 0 || resultsHolder.classList.contains('hidden'))) {
            searchManga();
        }
    });
    const debouncedFetch = debounce((v) => fetchSuggestions(v), 320);
    searchInput.addEventListener('input', (e) => debouncedFetch(e.target.value.trim()));
    searchInput.addEventListener('keydown', handleSuggestionsKeydown);
    document.addEventListener('click', (ev) => {
        const path = ev.composedPath ? ev.composedPath() : [];
        if (!path.includes(resultsHolder) && ev.target !== searchInput) hideSuggestions();
    });
    if (librarySearch) {
        const onInput = debounce(() => renderLibrary(), 200);
        librarySearch.addEventListener('input', onInput);
    }
    const libClear = document.getElementById('librarySearchClear');
    if (libClear) {
        libClear.addEventListener('click', () => {
            librarySearch.value = '';
            renderLibrary();
            librarySearch.focus();
        });
    }
    const pr = document.getElementById('personalRating');
    const prv = document.getElementById('personalRatingValue');
    if (pr && prv) {
        pr.addEventListener('input', () => {
            prv.textContent = pr.value;
            const stars = document.getElementById('previewPersonalStars');
            if (stars) stars.innerHTML = renderStarDots(parseFloat(pr.value));
        });
    }
    document.addEventListener('keydown', (e) => {
        const pv = document.getElementById('panelViewer');
        if (!pv || pv.classList.contains('hidden')) return;
        if (e.key === 'Escape')     closePanelViewer();
        if (e.key === 'ArrowRight') nextPanel();
        if (e.key === 'ArrowLeft')  prevPanel();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && previewArea && !previewArea.classList.contains('hidden')) closePreview();
    });
}

/* ── Utilities ──────────────────────────────────────────── */
function debounce(fn, delay) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), delay); };
}

function showToast(text, ms = 2400) {
    if (!toastEl) return;
    toastEl.textContent = text;
    toastEl.classList.remove('hidden');
    toastEl.classList.add('show');
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => toastEl.classList.remove('show'), ms);
}

/* ── Stats ──────────────────────────────────────────────── */
function updateStats() {
    const total  = myLibrary.length;
    const manga  = myLibrary.filter(m => (m.status || '').toUpperCase().includes('MANGA')).length;
    const anime  = myLibrary.filter(m => (m.status || '').toUpperCase().includes('ANIME')).length;
    const panels = myLibrary.reduce((acc, m) => acc + (m.panels ? m.panels.length : 0), 0);
    const setN = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    setN('statTotal', total); setN('statManga', manga); setN('statAnime', anime); setN('statPanels', panels);
}

/* ── Type/filter/view ───────────────────────────────────── */
function setTypeFilter(btn, type) {
    document.querySelectorAll('.type-pill').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    searchTypeFilter = type;
}
function setLibFilter(btn, filter) {
    document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = filter;
    renderLibrary();
}
function setView(mode) {
    currentView = mode;
    libraryGrid.classList.toggle('view-list', mode === 'list');
    document.getElementById('viewGrid').classList.toggle('active', mode === 'grid');
    document.getElementById('viewList').classList.toggle('active', mode === 'list');
    renderLibrary();
}

/* ── AniList Search ─────────────────────────────────────── */
async function searchManga() {
    const queryText = searchInput.value.trim();
    if (queryText.length < 2) { showToast('Escribe al menos 2 caracteres'); return; }
    hideSuggestions();
    const btn = document.getElementById('searchBtn');
    if (btn) { btn.innerHTML = '<i class="fas fa-spinner"></i>'; btn.disabled = true; }
    const typeFilter = searchTypeFilter !== 'all' ? `type: ${searchTypeFilter},` : '';
    const gqlQuery = `
        query ($search: String) {
            Page(page: 1, perPage: 8) {
                media(search: $search, ${typeFilter} sort: [POPULARITY_DESC]) {
                    id title { romaji english }
                    coverImage { extraLarge large medium }
                    averageScore status siteUrl format type
                    startDate { year }
                    genres
                }
            }
        }`;
    try {
        const response = await fetch('https://graphql.anilist.co', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ query: gqlQuery, variables: { search: queryText } })
        });
        const json = await response.json();
        const results = json?.data?.Page?.media;
        if (results && results.length > 0) {
            selectResult(results[0]);
        } else {
            showToast('Sin resultados — prueba otro término');
        }
    } catch (err) {
        console.error(err);
        showToast('Error de conexión con AniList');
    } finally {
        if (btn) { btn.innerHTML = '<i class="fas fa-search"></i><span>BUSCAR</span>'; btn.disabled = false; }
    }
}

function selectResult(r) {
    const image = r.coverImage?.extraLarge || r.coverImage?.large || r.coverImage?.medium || '';
    currentManga = {
        id:             r.id,
        title:          r.title.romaji || r.title.english || 'Sin título',
        image,
        score:          r.averageScore ? (r.averageScore / 10).toFixed(1) : 'N/A',
        status:         `${r.type || ''} · ${r.format || ''} · ${r.startDate?.year || ''}`.replace(/·\s*·/g,'·').trim().replace(/^·|·$/g,'').trim(),
        url:            r.siteUrl || '',
        type:           r.type || '',
        format:         r.format || '',
        genres:         r.genres || [],
        panels:         [],
        personalRating: 0,
        comment:        ''
    };
    hideSuggestions();
    showPreview(currentManga);
}

/* ── Typeahead ──────────────────────────────────────────── */
let lastSuggestions  = [];
let suggestionsIndex = -1;

async function fetchSuggestions(q) {
    if (!q || q.length < 2) { hideSuggestions(); return; }
    const typeFilter = searchTypeFilter !== 'all' ? `type: ${searchTypeFilter},` : '';
    const gqlQuery = `
        query ($search: String) {
            Page(page: 1, perPage: 7) {
                media(search: $search, ${typeFilter} sort: [POPULARITY_DESC]) {
                    id title { romaji english }
                    coverImage { extraLarge large medium }
                    averageScore format type startDate { year }
                    siteUrl status genres
                }
            }
        }`;
    try {
        const res = await fetch('https://graphql.anilist.co', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: gqlQuery, variables: { search: q } })
        });
        const j = await res.json();
        lastSuggestions = j?.data?.Page?.media || [];
        renderSuggestions(lastSuggestions);
    } catch { hideSuggestions(); }
}

function renderSuggestions(items) {
    if (!resultsHolder) return;
    resultsHolder.innerHTML = '';
    suggestionsIndex = -1;
    if (!items.length) { resultsHolder.classList.add('hidden'); return; }
    items.forEach((it, idx) => {
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        li.innerHTML = `
            <img src="${it.coverImage?.medium || ''}" alt="" loading="lazy">
            <div class="meta">
                <div class="title">${it.title.romaji || it.title.english || 'Sin título'}</div>
                <div class="sub">${it.format || ''} ${it.startDate?.year ? '· ' + it.startDate.year : ''} · ${it.averageScore ? (it.averageScore/10).toFixed(1) + '★' : 'N/A'}</div>
            </div>`;
        li.addEventListener('click', (ev) => { ev.stopPropagation(); selectSuggestion(idx); });
        li.addEventListener('mouseenter', () => setSuggestionHighlight(idx));
        resultsHolder.appendChild(li);
    });
    resultsHolder.classList.remove('hidden');
}

function handleSuggestionsKeydown(e) {
    if (!resultsHolder || resultsHolder.classList.contains('hidden')) return;
    const children = Array.from(resultsHolder.children);
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = Math.min(children.length - 1, suggestionsIndex + 1);
        setSuggestionHighlight(next);
        children[next]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = Math.max(0, suggestionsIndex - 1);
        setSuggestionHighlight(prev);
        children[prev]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && suggestionsIndex >= 0) {
        e.preventDefault();
        selectSuggestion(suggestionsIndex);
    } else if (e.key === 'Escape') {
        hideSuggestions();
    }
}

function selectSuggestion(idx) { const it = lastSuggestions[idx]; if (it) selectResult(it); }
function setSuggestionHighlight(idx) {
    if (!resultsHolder) return;
    Array.from(resultsHolder.children).forEach((c, i) => c.classList.toggle('highlight', i === idx));
    suggestionsIndex = idx;
}
function hideSuggestions() {
    if (resultsHolder) { resultsHolder.innerHTML = ''; resultsHolder.classList.add('hidden'); }
    lastSuggestions = []; suggestionsIndex = -1;
}

/* ── Preview ────────────────────────────────────────────── */
function showPreview(manga) {
    previewArea.classList.remove('hidden');
    document.getElementById('preview-img').src             = manga.image;
    document.getElementById('preview-title').textContent   = manga.title;
    document.getElementById('preview-score').textContent   = `★ ${manga.score}`;
    document.getElementById('preview-status').textContent  = manga.status;
    const linkEl = document.getElementById('preview-anilist-link');
    if (linkEl) linkEl.href = manga.url || '#';
    const pr  = document.getElementById('personalRating');
    const prv = document.getElementById('personalRatingValue');
    if (pr) { pr.value = manga.personalRating || 0; if (prv) prv.textContent = pr.value; }
    const stars = document.getElementById('previewPersonalStars');
    if (stars) stars.innerHTML = renderStarDots(manga.personalRating || 0);
    const pc = document.getElementById('personalComment');
    if (pc) pc.value = manga.comment || '';
    currentManga = manga;
    if (!currentManga.panels) currentManga.panels = [];
    renderPanelsPreview();
    previewArea.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function closePreview() {
    previewArea.classList.add('hidden');
    searchInput.value = '';
    currentManga  = null;
    editingIndex  = null;
}

/* ── Add / Save ─────────────────────────────────────────── */
async function addToLibrary() {
    console.log("addToLibrary START");
    if (!currentManga) return;
    const pr = document.getElementById('personalRating');
    const personalRating = pr ? parseFloat(pr.value) || 0 : 0;
    const pc = document.getElementById('personalComment');
    const comment = pc ? pc.value.trim() : '';
    const panels  = currentManga.panels ? currentManga.panels.slice() : [];
    const item    = { ...currentManga, personalRating, comment, panels, addedAt: new Date().toISOString() };

    const btn = document.querySelector('.save-btn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando…'; }

    try {
        if (editingIndex !== null && myLibrary[editingIndex]) {
            // Edición — guardar sin paneles primero
            const itemSinPaneles = { ...item, panels: [] };
            myLibrary[editingIndex] = item;
            editingIndex = null;
            const dbId = await saveItemToDB(itemSinPaneles);
            console.log("dbId resultado:", dbId);
            if (!dbId) throw new Error('Error al guardar en DB');
            showToast(`✓ Cambios guardados — ${item.title}`);
        } else {
            if (myLibrary.some(m => m.id === item.id)) {
                showToast('⚠ Ya está en tu colección');
                if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-bookmark"></i> GUARDAR EN COLECCIÓN'; }
                return;
            }
            console.log("Guardando en DB...");
            const itemSinPaneles = { ...item, panels: [] };
            const dbId = await saveItemToDB(itemSinPaneles);
            console.log("dbId resultado:", dbId);
            if (!dbId) throw new Error('Error al guardar en DB');

            // 2. Subir paneles después si hay
            if (panels.length > 0) {
                showToast('✓ Guardado — subiendo paneles…');
                const uploadedPanels = await uploadPanelsForItem(item);
                item.panels = uploadedPanels;
            }

            myLibrary.unshift(item);
            showToast(`✓ Agregado — ${item.title}`);
        }
    } catch (err) {
        console.error('addToLibrary error:', err);
        showToast('⚠ Error al guardar: ' + err.message);
    }

    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-bookmark"></i> GUARDAR EN COLECCIÓN'; }
    renderLibrary();
    updateStats();
    closePreview();
}

async function uploadPanelsForItem(item) {
    if (!item.panels || !item.panels.length) return [];
    const result = [];
    for (const panel of item.panels) {
        if (panel.storagePath) {
            // Ya está en Supabase
            result.push(panel);
        } else if (panel.dataUrl && panel.dataUrl.startsWith('data:')) {
            // Convertir base64 → File y subir
            const file = dataUrlToFile(panel.dataUrl, panel.name || 'panel.jpg');
            const uploaded = await uploadPanel(file, item.id, null);
            if (uploaded) result.push(uploaded);
            else result.push(panel); // fallback
        }
    }
    return result;
}

function dataUrlToFile(dataUrl, filename) {
    const [header, data] = dataUrl.split(',');
    const mime = header.match(/:(.*?);/)[1];
    const binary = atob(data);
    const arr = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
    return new File([arr], filename, { type: mime });
}

/* ── Register helper ────────────────────────────────────── */
function handleRegister() {
    const email = document.getElementById('regEmail').value;
    const pass  = document.getElementById('regPassword').value;
    const pass2 = document.getElementById('regPassword2').value;
    if (pass !== pass2) { showAuthError('Las contraseñas no coinciden'); return; }
    if (pass.length < 6) { showAuthError('La contraseña debe tener al menos 6 caracteres'); return; }
    registerWithEmail(email, pass);
}

/* ── Edit / Remove ──────────────────────────────────────── */
function editManga(index) {
    if (!myLibrary[index]) return;
    editingIndex = index;
    currentManga = { ...myLibrary[index] };
    showPreview(currentManga);
}

async function removeManga(index) {
    if (!myLibrary[index]) return;
    if (!confirm(`¿Eliminar "${myLibrary[index].title}"?`)) return;
    const item = myLibrary[index];
    const el = libraryGrid.querySelector(`[data-idx="${index}"]`);
    if (el) {
        el.classList.add('removing');
        setTimeout(async () => {
            myLibrary.splice(index, 1);
            await deleteItemFromDB(item.id);
            renderLibrary();
            updateStats();
        }, 340);
    } else {
        myLibrary.splice(index, 1);
        await deleteItemFromDB(item.id);
        renderLibrary();
        updateStats();
    }
}

/* ── Render Library ─────────────────────────────────────── */
function renderLibrary() {
    if (!libraryGrid) return;
    libraryGrid.innerHTML = '';
    libraryGrid.classList.toggle('view-list', currentView === 'list');
    const q = (librarySearch?.value || '').trim().toLowerCase();

    if (myLibrary.length === 0) {
        libraryGrid.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">册</div>
                <h3>Tu colección está vacía</h3>
                <p>Busca manga, anime, manhwa y empieza tu librería personal de 2026.</p>
            </div>`;
        return;
    }

    let filtered = myLibrary.map((m, i) => ({ item: m, idx: i }));
    if (currentFilter !== 'all') {
        filtered = filtered.filter(({ item }) =>
            (item.status || '').toUpperCase().includes(currentFilter) ||
            (item.type   || '').toUpperCase() === currentFilter
        );
    }
    if (q) {
        filtered = filtered.filter(({ item }) =>
            (item.title   || '').toLowerCase().includes(q) ||
            (item.comment || '').toLowerCase().includes(q) ||
            (item.genres  || []).some(g => g.toLowerCase().includes(q))
        );
    }

    const sortVal = document.getElementById('sortSelect')?.value || 'added';
    filtered.sort((a, b) => {
        if (sortVal === 'title')      return (a.item.title || '').localeCompare(b.item.title || '');
        if (sortVal === 'score_asc')  return (a.item.personalRating || 0) - (b.item.personalRating || 0);
        if (sortVal === 'score_desc') return (b.item.personalRating || 0) - (a.item.personalRating || 0);
        return 0;
    });

    if (filtered.length === 0) {
        libraryGrid.innerHTML = `<div class="empty-state"><div class="empty-state-icon">🔍</div><h3>Sin resultados</h3><p>No hay coincidencias para "${q || currentFilter}"</p></div>`;
        return;
    }

    const isList = currentView === 'list';
    filtered.forEach(({ item: manga, idx: index }, i) => {
        const card = document.createElement('div');
        card.className = 'manga-card';
        card.dataset.idx = index;
        card.style.animationDelay = `${Math.min(i * 40, 400)}ms`;
        const panelCount    = manga.panels?.length || 0;
        const favCount      = manga.panels?.filter(p => p.favorite).length || 0;
        const pRating       = manga.personalRating || 0;
        const commentSnippet = manga.comment ? manga.comment.slice(0, 55) + (manga.comment.length > 55 ? '…' : '') : '';
        const genreStr      = (manga.genres || []).slice(0, 2).join(', ');

        if (isList) {
            card.innerHTML = `
                <img src="${manga.image}" alt="${manga.title}" loading="lazy">
                <div class="card-info" style="flex:1">
                    <h3 style="white-space:normal">${manga.title}</h3>
                    <div class="card-badges">
                        <span class="badge badge-score">★ ${manga.score}</span>
                        ${pRating > 0 ? `<span class="badge badge-personal">✦ ${pRating}/10</span>` : ''}
                        ${panelCount > 0 ? `<span class="badge badge-panels"><i class="fas fa-images"></i> ${panelCount}${favCount > 0 ? ` · ⭐${favCount}` : ''}</span>` : ''}
                    </div>
                    <div class="card-status">${manga.status}</div>
                    ${commentSnippet ? `<div class="card-comment">${commentSnippet}</div>` : ''}
                </div>
                <div style="display:flex;gap:6px;flex-shrink:0;margin-left:auto">
                    <button class="edit-btn" onclick="editManga(${index})" title="Editar"><i class="fas fa-pen"></i></button>
                    <button class="delete-btn" onclick="removeManga(${index})" title="Eliminar"><i class="fas fa-times"></i></button>
                </div>`;
        } else {
            card.innerHTML = `
                <div class="card-overlay-btns">
                    <button class="delete-btn" onclick="removeManga(${index})" title="Eliminar"><i class="fas fa-times"></i></button>
                    <button class="edit-btn"   onclick="editManga(${index})"   title="Editar"><i class="fas fa-pen"></i></button>
                </div>
                <img src="${manga.image}" alt="${manga.title}" loading="lazy">
                <div class="card-info">
                    <h3 title="${manga.title}">${manga.title}</h3>
                    <div class="card-badges">
                        <span class="badge badge-score">★ ${manga.score}</span>
                        ${pRating > 0 ? `<span class="badge badge-personal">✦ ${pRating}</span>` : ''}
                        ${panelCount > 0 ? `<span class="badge badge-panels"><i class="fas fa-images"></i> ${panelCount}</span>` : ''}
                    </div>
                    <div class="card-status">${manga.status}${genreStr ? ' · ' + genreStr : ''}</div>
                    ${commentSnippet ? `<div class="card-comment">${commentSnippet}</div>` : ''}
                </div>`;
        }
        libraryGrid.appendChild(card);
    });
}

/* ── Panels ─────────────────────────────────────────────── */
function handlePanelFiles(e) {
    const files = e.target.files;
    if (!files?.length || !currentManga) return;
    if (!currentManga.panels) currentManga.panels = [];
    let loaded = 0;
    Array.from(files).forEach(file => {
        const reader = new FileReader();
        reader.onload = (ev) => {
            currentManga.panels.push({ dataUrl: ev.target.result, name: file.name, favorite: false });
            loaded++;
            if (loaded === files.length) renderPanelsPreview();
        };
        reader.readAsDataURL(file);
    });
}

function renderPanelsPreview() {
    const holder = document.getElementById('panelsPreview');
    if (!holder) return;
    holder.innerHTML = '';
    const panels = currentManga?.panels || [];
    if (!panels.length) { holder.innerHTML = '<span class="panel-empty">Sin paneles importados</span>'; return; }
    panels.forEach((p, idx) => {
        const wrap = document.createElement('div');
        wrap.className = 'panel-thumb';
        wrap.innerHTML = `
            <img src="${p.dataUrl || p.url || ''}" alt="${p.name}" loading="lazy">
            <div class="panel-tools">
                <button onclick="toggleFavPanelPreview(${idx})" title="${p.favorite ? 'Quitar favorito' : 'Favorito'}">
                    ${p.favorite ? '<i class="fas fa-star" style="color:var(--gold)"></i>' : '<i class="far fa-star"></i>'}
                </button>
                <button onclick="openPanelViewer(${idx})" title="Ver"><i class="fas fa-expand"></i></button>
                <button onclick="removePanelPreview(${idx})" title="Eliminar"><i class="fas fa-trash"></i></button>
            </div>`;
        holder.appendChild(wrap);
    });
}

function toggleFavPanelPreview(idx) {
    if (!currentManga?.panels?.[idx]) return;
    currentManga.panels[idx].favorite = !currentManga.panels[idx].favorite;
    renderPanelsPreview();
}

function removePanelPreview(idx) {
    if (!currentManga?.panels?.[idx]) return;
    if (!confirm('¿Eliminar este panel?')) return;
    currentManga.panels.splice(idx, 1);
    renderPanelsPreview();
}

/* ── Panel Viewer ───────────────────────────────────────── */
let _panelIdx = null;

function openPanelViewer(idx) {
    const panels = currentManga?.panels || [];
    if (!panels[idx]) return;
    _panelIdx = idx;
    updatePanelViewer(panels, idx);
    const pv = document.getElementById('panelViewer');
    pv.classList.remove('hidden');
    pv.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
}

function updatePanelViewer(panels, idx) {
    const img = document.getElementById('panelViewerImg');
    const cap = document.getElementById('panelViewerCaption');
    img.src = panels[idx].dataUrl || panels[idx].url || '';
    cap.textContent = `${panels[idx].name}${panels[idx].favorite ? ' · ⭐' : ''} (${idx + 1}/${panels.length})`;
}

function closePanelViewer() {
    const pv = document.getElementById('panelViewer');
    pv.classList.add('hidden');
    pv.setAttribute('aria-hidden', 'true');
    document.getElementById('panelViewerImg').src = '';
    _panelIdx = null;
    document.body.style.overflow = '';
}

function nextPanel() {
    const panels = currentManga?.panels || [];
    if (_panelIdx === null || !panels.length) return;
    _panelIdx = (_panelIdx + 1) % panels.length;
    updatePanelViewer(panels, _panelIdx);
}

function prevPanel() {
    const panels = currentManga?.panels || [];
    if (_panelIdx === null || !panels.length) return;
    _panelIdx = (_panelIdx - 1 + panels.length) % panels.length;
    updatePanelViewer(panels, _panelIdx);
}

/* ── Star render ────────────────────────────────────────── */
function renderStarDots(value) {
    const v    = Math.max(0, Math.min(10, Number(value) || 0));
    const num  = (Math.round(v * 10) / 10).toFixed(1);
    const full = Math.floor(v / 2);
    const half = (v / 2 - full) >= 0.5;
    const empty = 5 - full - (half ? 1 : 0);
    let html = '<span style="display:inline-flex;gap:3px;align-items:center;font-size:0.85rem">';
    for (let i = 0; i < full;  i++) html += '<i class="fas fa-star" style="color:var(--gold)"></i>';
    if (half) html += '<i class="fas fa-star-half-alt" style="color:var(--gold)"></i>';
    for (let i = 0; i < empty; i++) html += '<i class="far fa-star" style="color:var(--text3)"></i>';
    html += `<span style="font-family:var(--font-mono);font-size:0.75rem;color:var(--text2);margin-left:6px">${num}/10</span></span>`;
    return html;
}

/* ── Export / Import ────────────────────────────────────── */
function exportLibrary() {
    const blob = new Blob([JSON.stringify(myLibrary, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    const name = `lacieVault_${new Date().toISOString().slice(0, 10)}.json`;
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    showToast(`✓ Exportado: ${name}`);
}

function triggerImport() {
    const input = document.getElementById('importFile');
    if (!input) return;
    input.value = null;
    input.click();
}

function handleImportFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
        try { applyImported(JSON.parse(evt.target.result)); }
        catch { showToast('⚠ Archivo inválido'); }
    };
    reader.readAsText(file, 'utf-8');
}

async function applyImported(json) {
    if (!Array.isArray(json)) { showToast('⚠ Formato incorrecto'); return; }
    if (myLibrary.length > 0) {
        const replace = confirm('Tu colección no está vacía.\n¿REEMPLAZAR? (Cancelar = fusionar sin duplicados)');
        if (replace) {
            myLibrary = json;
        } else {
            const ids = new Set(myLibrary.map(i => i.id));
            json.forEach(item => { if (!ids.has(item.id)) myLibrary.push(item); });
        }
    } else {
        myLibrary = json;
    }
    // Sincronizar con DB
    for (const item of myLibrary) await saveItemToDB(item);
    renderLibrary();
    updateStats();
    showToast(`✓ Importación completada — ${myLibrary.length} entradas`);
}