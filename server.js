const express = require('express');
const multer = require('multer');
const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3456;
const UNION_NAME = 'mycloud';
const IS_WINDOWS = process.platform === 'win32';
const CLOUD_PASSWORD = (process.env.CLOUD_PASSWORD || '').trim();

// Support loading rclone.conf from RCLONE_CONFIG_BASE64 env var (for Render/Railway/Docker)
let rcloneConfigPath = process.env.RCLONE_CONFIG || null;
if (process.env.RCLONE_CONFIG_BASE64) {
  const confDir = path.join(os.tmpdir(), 'unified-cloud-rclone');
  if (!fs.existsSync(confDir)) fs.mkdirSync(confDir, { recursive: true });
  rcloneConfigPath = path.join(confDir, 'rclone.conf');
  const decoded = Buffer.from(process.env.RCLONE_CONFIG_BASE64.trim(), 'base64').toString('utf8');
  fs.writeFileSync(rcloneConfigPath, decoded, { mode: 0o600 });
  console.log('Loaded rclone.conf from RCLONE_CONFIG_BASE64');
}

app.set('trust proxy', 1);
app.use(express.json());

// ==================== SIMPLE SESSION AUTH ====================
const sessions = new Map(); // token -> { expiresAt }
const loginAttempts = new Map(); // ip -> { count, resetAt }
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return out;
}

function isAuthenticated(req) {
  if (!CLOUD_PASSWORD) return true;
  const cookies = parseCookies(req);
  const token = cookies.uc_session;
  if (!token) return false;
  const sess = sessions.get(token);
  if (!sess) return false;
  if (Date.now() > sess.expiresAt) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

app.get('/api/auth/me', (req, res) => {
  res.json({
    ok: true,
    authRequired: Boolean(CLOUD_PASSWORD),
    authenticated: isAuthenticated(req)
  });
});

app.post('/api/auth/login', (req, res) => {
  if (!CLOUD_PASSWORD) return res.json({ ok: true });

  const ip = req.ip || 'unknown';
  const now = Date.now();
  let rec = loginAttempts.get(ip);
  if (!rec || now > rec.resetAt) {
    rec = { count: 0, resetAt: now + 5 * 60 * 1000 };
    loginAttempts.set(ip, rec);
  }
  if (rec.count >= 10) {
    return res.status(429).json({ ok: false, error: 'יותר מדי ניסיונות כושלים. נסה שוב בעוד 5 דקות.' });
  }

  const password = (req.body && req.body.password) || '';
  if (!safeEqual(password, CLOUD_PASSWORD)) {
    rec.count++;
    return res.status(401).json({ ok: false, error: 'סיסמה שגויה.' });
  }

  loginAttempts.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { expiresAt: now + SESSION_TTL_MS });

  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader(
    'Set-Cookie',
    `uc_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${isHttps ? '; Secure' : ''}`
  );
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  const cookies = parseCookies(req);
  if (cookies.uc_session) sessions.delete(cookies.uc_session);
  res.setHeader('Set-Cookie', 'uc_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

// Protect all other /api/* routes
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/')) return next();
  if (!isAuthenticated(req)) {
    return res.status(401).json({ ok: false, error: 'נדרשת התחברות.' });
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Temp upload directory
const uploadDir = path.join(os.tmpdir(), 'unified-cloud-uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 2GB per file
});

// Track active OAuth process and Mount process
let authJob = null;
let mountProcess = null;
let mountDriveLetter = null;
let mountLogs = [];

function getRcloneEnv() {
  if (!rcloneConfigPath) return process.env;
  return { ...process.env, RCLONE_CONFIG: rcloneConfigPath };
}

function runRclone(args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    execFile('rclone', args, { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, env: getRcloneEnv() }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || 'rclone error').trim();
        return reject(new Error(msg));
      }
      resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

function isWinFspInstalled() {
  return (
    fs.existsSync('C:\\Program Files (x86)\\WinFsp\\bin\\winfsp-x64.dll') ||
    fs.existsSync('C:\\Program Files\\WinFsp\\bin\\winfsp-x64.dll') ||
    fs.existsSync('C:\\Program Files (x86)\\WinFsp\\bin\\winfsp-x86.dll')
  );
}

function sanitizeRelPath(p) {
  if (!p) return '';
  let clean = String(p).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  const parts = clean.split('/').filter(seg => seg && seg !== '.' && seg !== '..');
  return parts.join('/');
}

async function listUserRemotes() {
  try {
    const { stdout } = await runRclone(['listremotes', '--long'], 15000);
    const remotes = [];
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const match = trimmed.match(/^([^:]+):\s+(\S+)/);
      if (match) {
        const name = match[1].trim();
        const type = match[2].trim();
        if (name !== UNION_NAME) {
          remotes.push({ name, type });
        }
      }
    }
    return remotes;
  } catch (e) {
    return [];
  }
}

async function rebuildUnion() {
  const remotes = await listUserRemotes();
  if (remotes.length === 0) {
    try {
      await runRclone(['config', 'delete', UNION_NAME], 15000);
    } catch (_) {}
    return { remotes: [], unionReady: false };
  }

  if (remotes.length === 1) {
    // rclone union requires 2+ upstreams; use alias for a single account
    await runRclone([
      'config', 'create', UNION_NAME, 'alias',
      `remote=${remotes[0].name}:`
    ], 15000);
    return { remotes, unionReady: true };
  }

  const upstreams = remotes.map(r => `${r.name}:`).join(' ');
  await runRclone([
    'config', 'create', UNION_NAME, 'union',
    `upstreams=${upstreams}`,
    'action_policy=epall',
    'create_policy=mfs',
    'search_policy=ff'
  ], 15000);

  return { remotes, unionReady: true };
}

function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const map = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/plain; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.csv': 'text/plain; charset=utf-8',
    '.log': 'text/plain; charset=utf-8',
    '.js': 'text/plain; charset=utf-8',
    '.html': 'text/plain; charset=utf-8',
    '.css': 'text/plain; charset=utf-8',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg'
  };
  return map[ext] || 'application/octet-stream';
}

function decodeFilename(name) {
  try {
    // Multer often decodes UTF-8 filenames as latin1
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    if (decoded.includes('\uFFFD')) return name;
    return decoded;
  } catch {
    return name;
  }
}

// ==================== API: ACCOUNTS & STORAGE ====================

app.get('/api/status', async (req, res) => {
  try {
    const remotes = await listUserRemotes();
    res.json({
      ok: true,
      isWindows: IS_WINDOWS,
      authRequired: Boolean(CLOUD_PASSWORD),
      remotes,
      winfspInstalled: IS_WINDOWS ? isWinFspInstalled() : false,
      mounted: Boolean(mountProcess),
      mountDrive: mountDriveLetter,
      authJob: authJob ? {
        status: authJob.status,
        name: authJob.name,
        provider: authJob.provider,
        error: authJob.error
      } : null
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/storage', async (req, res) => {
  try {
    const remotes = await listUserRemotes();
    const results = await Promise.all(
      remotes.map(async (r) => {
        try {
          const { stdout } = await runRclone(['about', `${r.name}:`, '--json', '--contimeout', '10s', '--timeout', '15s', '--retries', '1'], 20000);
          const data = JSON.parse(stdout || '{}');
          const total = Number(data.total || 0);
          const free = Number(data.free != null ? data.free : Math.max(0, total - Number(data.used || 0)));
          const used = total > 0 ? Math.max(0, total - free) : Number(data.used || 0);
          return { name: r.name, type: r.type, total, used, free, error: null };
        } catch (err) {
          return { name: r.name, type: r.type, total: 0, used: 0, free: 0, error: err.message };
        }
      })
    );

    const summary = results.reduce(
      (acc, item) => {
        acc.total += item.total;
        acc.used += item.used;
        acc.free += item.free;
        return acc;
      },
      { total: 0, used: 0, free: 0 }
    );

    res.json({ ok: true, ...summary, accounts: results });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/accounts/add', async (req, res) => {
  try {
    // Automatically cancel any stale/previous pending auth flow so the user never gets stuck
    if (authJob && authJob.process) {
      try { authJob.process.kill(); } catch (_) {}
      authJob = null;
      await new Promise(r => setTimeout(r, 400));
    }

    const { provider, customName } = req.body || {};
    const allowed = { drive: 'google', onedrive: 'onedrive', dropbox: 'dropbox' };
    if (!allowed[provider]) {
      return res.status(400).json({ ok: false, error: 'ספק לא נתמך. בחר drive, onedrive או dropbox.' });
    }

    const existing = await listUserRemotes();
    const existingNames = new Set(existing.map(r => r.name.toLowerCase()));

    let name = '';
    if (customName && customName.trim()) {
      name = customName.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
      if (!name || name.toLowerCase() === UNION_NAME) {
        return res.status(400).json({ ok: false, error: 'שם חשבון לא חוקי.' });
      }
      if (existingNames.has(name.toLowerCase())) {
        return res.status(400).json({ ok: false, error: 'כבר קיים חשבון בשם הזה.' });
      }
    } else {
      let idx = 1;
      while (existingNames.has(`${allowed[provider]}_${idx}`)) idx++;
      name = `${allowed[provider]}_${idx}`;
    }

    const child = spawn('rclone', ['authorize', provider], {
      windowsHide: true
    });

    authJob = {
      status: 'running',
      name,
      provider,
      authUrl: null,
      error: null,
      process: child,
      stdout: '',
      stderr: ''
    };

    const checkUrl = (chunk) => {
      if (!authJob || authJob.authUrl) return;
      const m = chunk.match(/https?:\/\/127\.0\.0\.1:\d+\/auth\S*/);
      if (m) authJob.authUrl = m[0];
    };

    child.stdout.on('data', d => {
      const s = d.toString();
      if (authJob) {
        authJob.stdout += s;
        checkUrl(s);
      }
    });
    child.stderr.on('data', d => {
      const s = d.toString();
      if (authJob) {
        authJob.stderr += s;
        checkUrl(s);
      }
    });

    child.on('close', async (code) => {
      if (!authJob || authJob.name !== name) return;
      const combinedOut = authJob.stdout + '\n' + authJob.stderr;
      authJob.process = null;

      if (code === 0) {
        try {
          // Extract JSON token from rclone authorize output
          let tokenJson = null;
          const pasteMatch = combinedOut.match(/--->\s*(\{[\s\S]*?\})\s*<---End paste/);
          if (pasteMatch) {
            tokenJson = pasteMatch[1].trim();
          } else {
            const jsonMatch = combinedOut.match(/(\{"access_token"[\s\S]*?\})/);
            if (jsonMatch) tokenJson = jsonMatch[1].trim();
          }

          if (!tokenJson) {
            throw new Error('לא התקבל טוקן התחברות מ-rclone. נסה שוב.');
          }

          const createArgs = ['config', 'create', name, provider, `token=${tokenJson}`, '--non-interactive'];
          if (provider === 'onedrive') {
            createArgs.push('config_type=onedrive');
          }
          await runRclone(createArgs, 30000);
          await rebuildUnion();
          if (authJob && authJob.name === name) {
            authJob.status = 'done';
          }
        } catch (err) {
          console.error('Auth finalize error:', err.message);
          if (authJob && authJob.name === name) {
            authJob.status = 'error';
            authJob.error = err.message;
          }
        }
      } else {
        if (authJob && authJob.name === name) {
          authJob.status = 'error';
          authJob.error = (authJob.stderr || authJob.stdout).trim() || `תהליך ההתחברות הופסק (קוד ${code})`;
        }
      }
    });

    res.json({ ok: true, name, provider, status: 'running' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/accounts/auth-status', (req, res) => {
  if (!authJob) return res.json({ ok: true, status: 'idle' });
  res.json({
    ok: true,
    status: authJob.status,
    name: authJob.name,
    provider: authJob.provider,
    authUrl: authJob.authUrl || null,
    error: authJob.error
  });
});

app.post('/api/accounts/cancel-auth', (req, res) => {
  if (authJob && authJob.process) {
    try { authJob.process.kill(); } catch (_) {}
  }
  authJob = null;
  res.json({ ok: true });
});

app.post('/api/accounts/add-token', async (req, res) => {
  try {
    const { provider, token, customName } = req.body || {};
    const allowed = { drive: 'google', onedrive: 'onedrive', dropbox: 'dropbox' };
    if (!allowed[provider]) {
      return res.status(400).json({ ok: false, error: 'ספק לא נתמך. בחר drive, onedrive או dropbox.' });
    }
    const rawToken = String(token || '').trim();
    let tokenJson = rawToken;
    // Allow pasting full rclone authorize output or raw JSON
    const pasteMatch = rawToken.match(/--->\s*(\{[\s\S]*?\})\s*<---End paste/);
    if (pasteMatch) {
      tokenJson = pasteMatch[1].trim();
    } else {
      const jsonMatch = rawToken.match(/(\{[\s\S]*"access_token"[\s\S]*\})/);
      if (jsonMatch) tokenJson = jsonMatch[1].trim();
    }
    try {
      const parsed = JSON.parse(tokenJson);
      if (!parsed.access_token) throw new Error('missing access_token');
    } catch {
      return res.status(400).json({ ok: false, error: 'הטוקן לא תקין. הדבק את הטוקן JSON שהתקבל מ-rclone authorize.' });
    }

    const existing = await listUserRemotes();
    const existingNames = new Set(existing.map(r => r.name.toLowerCase()));
    let name = '';
    if (customName && customName.trim()) {
      name = customName.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
      if (!name || name.toLowerCase() === UNION_NAME || existingNames.has(name.toLowerCase())) {
        return res.status(400).json({ ok: false, error: 'שם חשבון לא חוקי או כבר קיים.' });
      }
    } else {
      let idx = 1;
      while (existingNames.has(`${allowed[provider]}_${idx}`)) idx++;
      name = `${allowed[provider]}_${idx}`;
    }

    const createArgs = ['config', 'create', name, provider, `token=${tokenJson}`, '--non-interactive'];
    if (provider === 'onedrive') {
      createArgs.push('config_type=onedrive');
    }
    await runRclone(createArgs, 30000);
    await rebuildUnion();

    res.json({ ok: true, name, provider });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/accounts/export-base64', async (req, res) => {
  try {
    let confFile = rcloneConfigPath;
    if (!confFile) {
      const { stdout } = await runRclone(['config', 'file'], 10000);
      const lines = stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      confFile = lines[lines.length - 1];
    }
    if (!confFile || !fs.existsSync(confFile)) {
      return res.status(404).json({ ok: false, error: 'קובץ rclone.conf לא נמצא.' });
    }
    const b64 = fs.readFileSync(confFile).toString('base64');
    res.json({ ok: true, base64: b64 });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/accounts/:name', async (req, res) => {
  try {
    const name = req.params.name;
    if (!name || name === UNION_NAME) {
      return res.status(400).json({ ok: false, error: 'שם לא תקין' });
    }
    await runRclone(['config', 'delete', name], 15000);
    await rebuildUnion();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==================== API: FILES (UNIFIED CLOUD) ====================

app.get('/api/files', async (req, res) => {
  try {
    const remotes = await listUserRemotes();
    if (remotes.length === 0) {
      return res.json({ ok: true, path: '', items: [], emptyCloud: true });
    }
    // Ensure union exists
    await rebuildUnion();

    const relPath = sanitizeRelPath(req.query.path || '');
    const target = relPath ? `${UNION_NAME}:${relPath}` : `${UNION_NAME}:`;
    const { stdout } = await runRclone(['lsjson', target], 30000);
    const rawItems = JSON.parse(stdout || '[]');

    const items = rawItems.map(item => ({
      name: item.Name,
      path: relPath ? `${relPath}/${item.Name}` : item.Name,
      size: item.Size || 0,
      isDir: Boolean(item.IsDir),
      modTime: item.ModTime || null,
      mimeType: item.MimeType || getMimeType(item.Name)
    }));

    items.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, 'he');
    });

    res.json({ ok: true, path: relPath, items, emptyCloud: false });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/upload', upload.array('files', 50), async (req, res) => {
  const uploadedFiles = req.files || [];
  try {
    const remotes = await listUserRemotes();
    if (remotes.length === 0) {
      return res.status(400).json({ ok: false, error: 'אין חשבונות ענן מחוברים עדיין.' });
    }
    const relPath = sanitizeRelPath(req.query.path || '');
    const results = [];

    for (const file of uploadedFiles) {
      const originalName = decodeFilename(file.originalname);
      const destPath = relPath ? `${UNION_NAME}:${relPath}/${originalName}` : `${UNION_NAME}:${originalName}`;
      await runRclone(['copyto', file.path, destPath], 300000);
      results.push({ name: originalName, size: file.size });
    }

    res.json({ ok: true, uploaded: results });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    for (const file of uploadedFiles) {
      fs.unlink(file.path, () => {});
    }
  }
});

app.get('/api/download', (req, res) => {
  const relPath = sanitizeRelPath(req.query.path || '');
  if (!relPath) return res.status(400).send('Missing path');

  const filename = path.basename(relPath);
  const inline = req.query.inline === '1';
  const mime = getMimeType(filename);

  res.setHeader('Content-Type', mime);
  const encodedName = encodeURIComponent(filename);
  res.setHeader(
    'Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodedName}`
  );

  const child = spawn('rclone', ['cat', `${UNION_NAME}:${relPath}`], { env: getRcloneEnv() });
  child.stdout.pipe(res);

  let errOut = '';
  child.stderr.on('data', d => { errOut += d.toString(); });
  child.on('close', code => {
    if (code !== 0 && !res.headersSent) {
      res.status(500).send(errOut || 'Download failed');
    }
  });
});

app.post('/api/mkdir', async (req, res) => {
  try {
    const relPath = sanitizeRelPath(req.body.path || '');
    const folderName = (req.body.name || '').trim().replace(/[\\/:*?"<>|]/g, '');
    if (!folderName) return res.status(400).json({ ok: false, error: 'שם תיקייה לא תקין' });

    const target = relPath ? `${UNION_NAME}:${relPath}/${folderName}` : `${UNION_NAME}:${folderName}`;
    await runRclone(['mkdir', target], 20000);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/rename', async (req, res) => {
  try {
    const oldPath = sanitizeRelPath(req.body.oldPath || '');
    const newName = (req.body.newName || '').trim().replace(/[\\/:*?"<>|]/g, '');
    if (!oldPath || !newName) return res.status(400).json({ ok: false, error: 'פרטים חסרים' });

    const dir = path.posix.dirname(oldPath);
    const newPath = dir === '.' ? newName : `${dir}/${newName}`;
    await runRclone(['moveto', `${UNION_NAME}:${oldPath}`, `${UNION_NAME}:${newPath}`], 30000);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/files', async (req, res) => {
  try {
    const relPath = sanitizeRelPath(req.query.path || '');
    const isDir = req.query.isDir === 'true';
    if (!relPath) return res.status(400).json({ ok: false, error: 'נתיב חסר' });

    const cmd = isDir ? 'purge' : 'deletefile';
    await runRclone([cmd, `${UNION_NAME}:${relPath}`], 30000);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==================== API: WINDOWS DRIVE MOUNT ====================

app.get('/api/mount/status', (req, res) => {
  res.json({
    ok: true,
    winfspInstalled: isWinFspInstalled(),
    mounted: Boolean(mountProcess),
    driveLetter: mountDriveLetter,
    logs: mountLogs.slice(-15)
  });
});

app.post('/api/mount/start', async (req, res) => {
  try {
    if (!isWinFspInstalled()) {
      return res.status(400).json({
        ok: false,
        error: 'WinFsp לא מותקן עדיין. התקן אותו כדי לחבר את הענן ככונן ב-Windows.'
      });
    }
    if (mountProcess) {
      return res.json({ ok: true, alreadyMounted: true, driveLetter: mountDriveLetter });
    }
    const remotes = await listUserRemotes();
    if (remotes.length === 0) {
      return res.status(400).json({ ok: false, error: 'חבר לפחות חשבון ענן אחד לפני חיבור הכונן.' });
    }
    await rebuildUnion();

    const letter = ((req.body && req.body.driveLetter) || 'Z').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 1) || 'Z';
    mountLogs = [];

    const args = [
      'mount',
      `${UNION_NAME}:`,
      `${letter}:`,
      '--vfs-cache-mode', 'full',
      '--vfs-write-back', '5s',
      '--vfs-read-ahead', '128M',
      '--vfs-read-chunk-size', '32M',
      '--vfs-read-chunk-size-limit', '256M',
      '--vfs-cache-max-size', '4G',
      '--vfs-cache-max-age', '24h',
      '--vfs-fast-fingerprint',
      '--buffer-size', '64M',
      '--dir-cache-time', '5m',
      '--poll-interval', '15s',
      '--transfers', '8',
      '--checkers', '16',
      '--drive-use-trash=false',
      '--volname', 'MyCloud'
    ];

    const proc = spawn('rclone', args, { windowsHide: true });
    mountProcess = proc;
    mountDriveLetter = letter;

    proc.stdout.on('data', d => mountLogs.push(d.toString().trim()));
    proc.stderr.on('data', d => mountLogs.push(d.toString().trim()));
    proc.on('close', () => {
      if (mountProcess === proc) {
        mountProcess = null;
        mountDriveLetter = null;
      }
    });

    // Wait briefly to catch immediate mount errors
    await new Promise(r => setTimeout(r, 1500));
    if (!mountProcess) {
      return res.status(500).json({
        ok: false,
        error: mountLogs.join('\n') || 'חיבור הכונן נכשל. נסה אות כונן אחרת.'
      });
    }

    res.json({ ok: true, driveLetter: letter });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/mount/stop', (req, res) => {
  if (mountProcess) {
    try { mountProcess.kill(); } catch (_) {}
    mountProcess = null;
    mountDriveLetter = null;
  }
  res.json({ ok: true });
});

app.post('/api/mount/open', (req, res) => {
  if (!mountDriveLetter) {
    return res.status(400).json({ ok: false, error: 'הכונן לא מחובר כרגע.' });
  }
  spawn('explorer.exe', [`${mountDriveLetter}:\\`], { detached: true, stdio: 'ignore' }).unref();
  res.json({ ok: true });
});

// Cleanup on exit
function cleanup() {
  if (mountProcess) {
    try { mountProcess.kill(); } catch (_) {}
  }
  if (authJob && authJob.process) {
    try { authJob.process.kill(); } catch (_) {}
  }
  process.exit(0);
}
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('uncaughtException', err => console.error('Uncaught error:', err));
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));

app.listen(PORT, () => {
  console.log(`Unified Cloud running at http://localhost:${PORT}`);
});
