// ══════════════════════════════════════════════════════
//  AVATAR — Gestion photo de profil Upload.io
//  Inclure ce script dans chaque dashboard
// ══════════════════════════════════════════════════════

// Retourne l'URL de l'avatar ou le fallback ui-avatars
function getAvatarUrl(user, size = 128) {
  if (user?.avatar_url) return user.avatar_url;
  const name = user ? encodeURIComponent(`${user.first_name} ${user.last_name}`) : 'U';
  const bg   = { etudiant:'00602a', enseignant:'ea580c', admin:'004a77', superadmin:'f59e0b' };
  const color = bg[user?.role] || '00602a';
  return `https://ui-avatars.com/api/?name=${name}&background=${color}&color=fff&size=${size}`;
}

// Met à jour tous les avatars dans la page
function updateAllAvatars(user) {
  const url   = getAvatarUrl(user);
  const url128 = getAvatarUrl(user, 128);
  ['top-av', 'side-av'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.src = url;
  });
  const profAv = document.getElementById('prof-av');
  if (profAv) profAv.src = url128;
}

// Upload et mise à jour de la photo
async function uploadAndSetAvatar(file, API, TK) {
  const UPLOADIO_KEY        = public_W23MTdC4sM22hJB8SGp22Q4b8hFW        || '';
  const UPLOADIO_ACCOUNT_ID = W23MTdC || '';

  if (!UPLOADIO_KEY || UPLOADIO_KEY === 'your_uploadio_api_key') {
    alert('Upload.io non configuré. Renseignez UPLOADIO_KEY et UPLOADIO_ACCOUNT_ID.');
    return null;
  }

  try {
    // Redimensionner l'image avant upload (max 400x400)
    const resized = await resizeImage(file, 400);

    const r = await fetch(
      `https://api.upload.io/v2/accounts/${UPLOADIO_ACCOUNT_ID}/uploads/binary`,
      {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${UPLOADIO_KEY}`,
          'Content-Type':  resized.type || 'image/jpeg',
        },
        body: resized,
      }
    );
    if (!r.ok) { alert('Erreur Upload.io. Vérifiez votre clé API.'); return null; }
    const data = await r.json();
    const avatarUrl = data.fileUrl;

    // Sauvegarder en BDD
    const save = await fetch(`${API}/auth/avatar`, {
      method:  'PUT',
      headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${TK()}` },
      body:    JSON.stringify({ avatar_url: avatarUrl }),
    });
    const saved = await save.json();
    if (saved.token) localStorage.setItem('camunolearn_token', saved.token);

    return avatarUrl;
  } catch(e) {
    console.error('Avatar upload error:', e);
    return null;
  }
}

// Redimensionner une image côté client
function resizeImage(file, maxSize) {
  return new Promise((resolve) => {
    const img  = new Image();
    const url  = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      let { width, height } = img;
      if (width > height) {
        if (width > maxSize) { height = (height * maxSize) / width; width = maxSize; }
      } else {
        if (height > maxSize) { width = (width * maxSize) / height; height = maxSize; }
      }
      canvas.width  = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      canvas.toBlob(blob => resolve(blob || file), 'image/jpeg', 0.85);
    };
    img.src = url;
  });
}

// Créer le widget de changement de photo dans la page profil
function createAvatarWidget(containerId, user, API, TK, onSuccess) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.style.position = 'relative';
  container.style.display  = 'inline-block';

  // Bouton overlay
  const btn = document.createElement('label');
  btn.style.cssText = `
    position:absolute;bottom:0;right:0;
    width:28px;height:28px;border-radius:50%;
    background:#00602a;color:#fff;
    display:flex;align-items:center;justify-content:center;
    cursor:pointer;border:2px solid #fff;
    transition:.15s;z-index:10
  `;
  btn.innerHTML = '<span style="font-family:Material Symbols Outlined;font-size:14px;user-select:none">photo_camera</span>';
  btn.title = 'Changer ma photo';

  // Input file caché
  const input = document.createElement('input');
  input.type   = 'file';
  input.accept = 'image/jpeg,image/png,image/webp';
  input.style.display = 'none';
  input.id = 'avatar-file-input';

  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;

    // Feedback visuel
    btn.innerHTML = '<span style="font-family:Material Symbols Outlined;font-size:14px;animation:spin 1s linear infinite;display:block">autorenew</span>';

    const url = await uploadAndSetAvatar(file, API, TK);
    if (url) {
      // Mettre à jour tous les avatars de la page
      const img = container.querySelector('img');
      if (img) img.src = url;
      updateAllAvatars({ ...user, avatar_url: url });
      // Mettre à jour localStorage
      try {
        const u = JSON.parse(localStorage.getItem('camunolearn_user') || '{}');
        u.avatar_url = url;
        localStorage.setItem('camunolearn_user', JSON.stringify(u));
      } catch(e) {}
      if (onSuccess) onSuccess(url);
    }
    btn.innerHTML = '<span style="font-family:Material Symbols Outlined;font-size:14px;user-select:none">photo_camera</span>';
    input.value = '';
  });

  btn.appendChild(input);
  container.appendChild(btn);
}