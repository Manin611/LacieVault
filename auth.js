/**
 * LACIEVAULT · Auth + Supabase
 * Maneja: login email/password, Google OAuth, sesión, sync con DB
 */

/* ── Supabase Init ──────────────────────────────────────── */


// Keys desde config.js (ignorado por .gitignore)
const { createClient } = supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

/* ── Estado de sesión ───────────────────────────────────── */
let currentUser = null;

/* ── Init Auth ──────────────────────────────────────────── */
async function initAuth() {
    // IMPORTANTE: No hacer llamadas async a Supabase (postgREST/storage) dentro
    // del callback: provoca deadlock y las siguientes llamadas (ej. guardar) no responden.
    // Ver: https://github.com/supabase/gotrue-js/issues/762
    sb.auth.onAuthStateChange((event, session) => {
        currentUser = session?.user || null;

        if (currentUser) {
            hideAuthModal();
            showApp();
            updateUserUI(currentUser);
            // Diferir carga de la DB para que el callback termine y se libere el lock del token
            setTimeout(() => { loadLibraryFromDB(); }, 0);
        } else {
            showAuthModal();
            hideApp();
        }
    });

    // Verificar sesión activa al cargar
    const { data: { session } } = await sb.auth.getSession();
    if (!session) {
        showAuthModal();
        hideApp();
    } else {
        currentUser = session.user;
        hideAuthModal();
        showApp();
        updateUserUI(currentUser);
        setTimeout(() => { loadLibraryFromDB(); }, 0);
    }
}

/* ── Login Email/Password ───────────────────────────────── */
async function loginWithEmail(email, password) {
    setAuthLoading(true);
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
        showAuthError(error.message);
    }
    setAuthLoading(false);
}

/* ── Registro Email/Password ────────────────────────────── */
async function registerWithEmail(email, password) {
    setAuthLoading(true);
    const { error } = await sb.auth.signUp({ email, password });
    if (error) {
        showAuthError(error.message);
    } else {
        showAuthMessage('✓ Revisa tu email para confirmar la cuenta');
    }
    setAuthLoading(false);
}

/* ── Login Google ───────────────────────────────────────── */
async function loginWithGoogle() {
    setAuthLoading(true);
    const { error } = await sb.auth.signInWithOAuth({
        provider: 'google',
        options: {
            redirectTo: window.location.href
        }
    });
    if (error) {
        showAuthError(error.message);
        setAuthLoading(false);
    }
    // Si no hay error, Google redirige automáticamente
}

/* ── Logout ─────────────────────────────────────────────── */
async function logout() {
    await sb.auth.signOut();
    currentUser = null;
    myLibrary   = [];
    renderLibrary();
    updateStats();
    showAuthModal();
    hideApp();
    showToast('Sesión cerrada');
}

/* ── Reset password ─────────────────────────────────────── */
async function resetPassword(email) {
    const { error } = await sb.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.href
    });
    if (error) {
        showAuthError(error.message);
    } else {
        showAuthMessage('✓ Email de recuperación enviado');
    }
}

/* ══════════════════════════════════════════════════════════
   DB SYNC — Colección
   ══════════════════════════════════════════════════════════ */

async function loadLibraryFromDB() {
    if (!currentUser) return;

    // Query 1: cargar librería
    const { data: libData, error: libErr } = await sb
        .from('library')
        .select('*')
        .eq('user_id', currentUser.id)
        .order('added_at', { ascending: false });

    if (libErr) { console.error('loadLibrary:', libErr); return; }
    if (!libData || libData.length === 0) { myLibrary = []; renderLibrary(); updateStats(); return; }

    // Query 2: cargar paneles por separado
    const mangaIds = libData.map(r => r.manga_id);
    const { data: panelsData, error: panelsErr } = await sb
        .from('panels')
        .select('*')
        .eq('user_id', currentUser.id)
        .in('manga_id', mangaIds);

    if (panelsErr) console.error('loadLibrary panels:', panelsErr);

    // URLs para mostrar imágenes al recargar: firmadas (bucket privado) o públicas (bucket público)
    const panelsByManga = {};
    if (panelsData?.length) {
        await Promise.all(panelsData.map(async (p) => {
            let imageUrl = '';
            const { data: signed, error: signErr } = await sb.storage.from('panels').createSignedUrl(p.storage_path, 3600);
            if (signErr || !signed?.signedUrl) {
                const { data: pub } = sb.storage.from('panels').getPublicUrl(p.storage_path);
                imageUrl = pub?.publicUrl || '';
            } else {
                imageUrl = signed.signedUrl;
            }
            if (!panelsByManga[p.manga_id]) panelsByManga[p.manga_id] = [];
            panelsByManga[p.manga_id].push({
                id:          p.id,
                name:        p.name,
                dataUrl:     imageUrl,
                url:         imageUrl,
                storagePath: p.storage_path,
                favorite:    !!p.favorite
            });
        }));
    }

    myLibrary = libData.map(row => ({
        id:             row.manga_id,
        dbId:           row.id,
        title:          row.title,
        image:          row.image,
        score:          row.score,
        status:         row.status,
        url:            row.url,
        type:           row.type,
        format:         row.format,
        genres:         row.genres || [],
        personalRating: row.personal_rating,
        comment:        row.comment,
        addedAt:        row.added_at,
        panels:         panelsByManga[row.manga_id] || []
    }));

    renderLibrary();
    updateStats();
}

async function saveItemToDB(item) {
    console.log("saveItemToDB START", item.title, currentUser?.id);
    if (!currentUser) return;

    const row = {
        user_id:         currentUser.id,
        manga_id:        item.id,
        title:           item.title,
        image:           item.image,
        score:           item.score,
        status:          item.status,
        url:             item.url,
        type:            item.type,
        format:          item.format,
        genres:          item.genres || [],
        personal_rating: item.personalRating || 0,
        comment:         item.comment || '',
    };

    const { data, error } = await sb
        .from('library')
        .upsert(row, { onConflict: 'user_id,manga_id' })
        .select()
        .single();

    console.log("saveItemToDB DONE", data, error);
    if (error) { console.error("saveItem:", error); showToast("⚠ Error al guardar"); return null; }
    return data.id; // dbId para relacionar paneles
}

async function deleteItemFromDB(mangaId) {
    if (!currentUser) return;
    await sb.from('library')
        .delete()
        .eq('user_id', currentUser.id)
        .eq('manga_id', mangaId);
}

/* ── Panels Storage ─────────────────────────────────────── */
async function uploadPanel(file, mangaId, dbLibraryId) {
    if (!currentUser) return null;

    const ext  = file.name.split('.').pop() || 'jpg';
    const path = `${currentUser.id}/${mangaId}/${Date.now()}.${ext}`;

    // 1. Subir archivo al bucket Storage "panels"
    const { error: upErr } = await sb.storage
        .from('panels')
        .upload(path, file, { upsert: false });

    if (upErr) {
        console.error('uploadPanel Storage:', upErr);
        const msg = upErr.message || String(upErr);
        if (typeof showToast === 'function') {
            showToast('⚠ Imagen no guardada: ' + (msg.includes('Bucket') ? 'crea el bucket "panels" en Storage y revisa políticas.' : msg));
        }
        return null;
    }

    // 2. Guardar referencia en la tabla public.panels
    const { data, error: dbErr } = await sb.from('panels').insert({
        user_id:      currentUser.id,
        manga_id:     mangaId,
        name:         file.name,
        storage_path: path,
        favorite:     false
    }).select().single();

    if (dbErr) {
        console.error('uploadPanel tabla panels:', dbErr);
        if (typeof showToast === 'function') {
            showToast('⚠ Referencia no guardada: ' + (dbErr.message || 'revisa que exista la tabla "panels" y RLS.'));
        }
        return null;
    }

    const { data: urlData } = sb.storage.from('panels').getPublicUrl(path);
    return {
        id:          data.id,
        name:        file.name,
        dataUrl:     urlData?.publicUrl || '',
        url:         urlData?.publicUrl || '',
        storagePath: path,
        favorite:    false
    };
}

async function deletePanel(panel) {
    if (!currentUser || !panel.id) return;
    // Borrar de Storage
    if (panel.storagePath) {
        await sb.storage.from('panels').remove([panel.storagePath]);
    }
    // Borrar de DB
    await sb.from('panels').delete().eq('id', panel.id);
}

async function toggleFavoritePanelDB(panelId, favorite) {
    if (!currentUser || !panelId) return;
    await sb.from('panels').update({ favorite }).eq('id', panelId);
}

/* ── Migrar localStorage → Supabase ─────────────────────── */
async function migrateLocalStorage() {
    const local = JSON.parse(localStorage.getItem('maninVault_v2') || '[]');
    if (!local.length) return;

    const confirmed = confirm(`Tienes ${local.length} entradas guardadas localmente.\n¿Migrarlas a tu cuenta en la nube?`);
    if (!confirmed) return;

    showToast('Migrando colección…');
    let migrated = 0;

    for (const item of local) {
        const dbId = await saveItemToDB(item);
        if (dbId) {
            // Paneles: los base64 locales no se pueden subir directamente
            // Se mantienen en local hasta que el usuario los reimporte
            migrated++;
        }
    }

    localStorage.removeItem('maninVault_v2');
    await loadLibraryFromDB();
    showToast(`✓ ${migrated} entradas migradas a la nube`);
}

/* ══════════════════════════════════════════════════════════
   UI AUTH
   ══════════════════════════════════════════════════════════ */

function showAuthModal()  { document.getElementById('authModal')?.classList.remove('hidden'); }
function hideAuthModal()  { document.getElementById('authModal')?.classList.add('hidden'); }
function showApp()        { document.getElementById('mainApp')?.classList.remove('hidden'); }
function hideApp()        { document.getElementById('mainApp')?.classList.add('hidden'); }

function updateUserUI(user) {
    const el = document.getElementById('userEmail');
    if (el) el.textContent = user.user_metadata?.full_name || user.email || 'Usuario';
    const avatar = document.getElementById('userAvatar');
    if (avatar && user.user_metadata?.avatar_url) {
        avatar.src = user.user_metadata.avatar_url;
        avatar.classList.remove('hidden');
    }
}

function setAuthLoading(on) {
    const btns = document.querySelectorAll('.auth-submit-btn');
    btns.forEach(b => { b.disabled = on; b.classList.toggle('loading', on); });
}

function showAuthError(msg) {
    const el = document.getElementById('authError');
    if (!el) return;
    // Traducir errores comunes de Supabase
    const msgs = {
        'Invalid login credentials': 'Email o contraseña incorrectos',
        'Email not confirmed':       'Confirma tu email antes de entrar',
        'User already registered':   'Este email ya está registrado',
        'Password should be at least 6 characters': 'La contraseña debe tener al menos 6 caracteres'
    };
    el.textContent = msgs[msg] || msg;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 4000);
}

function showAuthMessage(msg) {
    const el = document.getElementById('authMessage');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 5000);
}

function switchAuthTab(tab) {
    // tab: 'login' | 'register' | 'reset'
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    document.querySelectorAll('.auth-form').forEach(f => f.classList.toggle('hidden', f.dataset.form !== tab));
    const el = document.getElementById('authError');
    if (el) el.classList.add('hidden');
}