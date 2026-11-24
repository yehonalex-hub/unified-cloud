const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

// Modular Connectors & Services
const {
  runRclone,
  listUserRemotes,
  getRemotesConfig,
  getMimeType,
  getRcloneConfigPath,
  getRcloneEnv
} = require('./connectors/rclone-runner');

const {
  getGoogleOAuthConfig,
  getNextGoogleRemoteName,
  addGoogleAccountWithToken,
  createGoogleRemoteFromOAuth,
  startGoogleLocalAuth,
  verifyGoogleConnection,
  getGoogleAccountInfo,
  parseGoogleRemoteMeta,
  listSharedDrives,
  addSharedDrive
} = require('./connectors/google-drive');

const {
  getOneDriveOAuthConfig,
  getNextOneDriveRemoteName,
  addOneDriveAccountWithToken,
  startOneDriveLocalAuth
} = require('./connectors/onedrive');

const {
  getProviderOAuthConfig,
  addAccountWithToken,
  addAccountWithCredentials
} = require('./connectors/cloud-providers');

const {
  UNION_NAME,
  isWinFspInstalled,
  rebuildUnion,
  getPooledStorage
} = require('./connectors/union-manager');

const {
  listFiles,
  uploadFiles,
  spawnDownloadStream,
  getFileSize,
  makeDirectory,
  renameItem,
  deleteItem
} = require('./connectors/file-service');

const app = express();
const PORT = process.env.PORT || 3456;
const IS_WINDOWS = process.platform === 'win32';
const CLOUD_PASSWORD = (process.env.CLOUD_PASSWORD || '').trim();

app.set('trust proxy', 1);
app.use(express.json());

// ==================== SIMPLE SESSION AUTH ====================
const sessions = new Map();
const loginAttempts = new Map();
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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

// Protect all other /api/* routes except auth & oauth callback
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/') || req.path.startsWith('/oauth/callback/')) return next();
  if (!isAuthenticated(req)) {
    return res.status(401).json({ ok: false, error: 'נדרשת התחברות.' });
  }
  next();
});

// ==================== WEB OAUTH (1-CLICK LOGIN ON RENDER / CLOUD) ====================
const oauthStates = new Map();

function getAnyOAuthConfig(provider) {
  if (provider === 'drive') return getGoogleOAuthConfig();
  if (provider === 'onedrive') return getOneDriveOAuthConfig();
  return getProviderOAuthConfig(provider);
}

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  return `${String(proto).split(',')[0].trim()}://${req.get('host')}`;
}

app.get('/api/oauth/start/:provider', (req, res) => {
  const provider = req.params.provider;
  const cfg = getAnyOAuthConfig(provider);
  if (!cfg) {
    return res.status(400).send(`OAuth is not configured for ${provider}. Set CLIENT_ID and CLIENT_SECRET in environment variables.`);
  }
  const state = crypto.randomBytes(24).toString('hex');
  const redirectUri = `${getBaseUrl(req)}/api/oauth/callback/${provider}`;
  const customName = (req.query.customName || '').trim();
  oauthStates.set(state, { provider, customName, redirectUri, expiresAt: Date.now() + 10 * 60 * 1000 });

  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    state,
    ...cfg.extraAuthParams
  });
  res.redirect(`${cfg.authUrl}?${params.toString()}`);
});

app.get('/api/oauth/callback/:provider', async (req, res) => {
  const provider = req.params.provider;
  const { code, state, error, error_description } = req.query;

  if (error) {
    return res.redirect(`/?oauthError=${encodeURIComponent(error_description || error)}`);
  }
  const saved = oauthStates.get(state);
  oauthStates.delete(state);
  if (!saved || saved.provider !== provider || Date.now() > saved.expiresAt || !code) {
    return res.redirect(`/?oauthError=${encodeURIComponent('פג תוקף בקשת ההתחברות. נסה שוב.')}`);
  }

  const cfg = getAnyOAuthConfig(provider);
  if (!cfg) {
    return res.redirect(`/?oauthError=${encodeURIComponent('הגדרות OAuth חסרות בשרת.')}`);
  }

  try {
    const body = new URLSearchParams({
      code: String(code),
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: saved.redirectUri,
      grant_type: 'authorization_code'
    });

    const tokenRes = await fetch(cfg.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      throw new Error(tokenData.error_description || tokenData.error || 'קבלת הטוקן נכשלה');
    }

    const expiry = new Date(Date.now() + (Number(tokenData.expires_in) || 3600) * 1000).toISOString();
    const rcloneToken = JSON.stringify({
      access_token: tokenData.access_token,
      token_type: tokenData.token_type || 'Bearer',
      refresh_token: tokenData.refresh_token || '',
      expiry
    });

    let result;
    if (provider === 'drive') {
      const gName = await getNextGoogleRemoteName(saved.customName);
      result = await addGoogleAccountWithToken(rcloneToken, gName);
    } else if (provider === 'onedrive') {
      result = await addOneDriveAccountWithToken(rcloneToken, saved.customName);
    } else {
      result = await addAccountWithToken(provider, rcloneToken, saved.customName);
    }
    await rebuildUnion();

    res.redirect(`/?connected=${encodeURIComponent(result.name)}`);
  } catch (err) {
    console.error('Web OAuth callback error:', err);
    res.redirect(`/?oauthError=${encodeURIComponent(err.message)}`);
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// Temp upload directory
const uploadDir = path.join(os.tmpdir(), 'unified-cloud-uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 2GB per file
});

// Active Local Interactive Auth Job & Mount process
let authJob = null;
let mountProcess = null;
let mountDriveLetter = null;
let mountLogs = [];

// ==================== API: ACCOUNTS & STORAGE ====================

app.get('/api/status', async (req, res) => {
  try {
    const remotes = await listUserRemotes(UNION_NAME);
    const conf = await getRemotesConfig();

    const enrichedRemotes = await Promise.all(
      remotes.map(async (r) => {
        const meta = parseGoogleRemoteMeta(r.name, r.type, conf);
        let googleInfo = null;
        if (meta.isGoogle && !meta.isSharedDrive) {
          googleInfo = await getGoogleAccountInfo(r.name, conf[r.name]);
        } else if (meta.isSharedDrive && meta.baseRemote) {
          googleInfo = await getGoogleAccountInfo(meta.baseRemote, conf[meta.baseRemote]);
        }
        return {
          name: r.name,
          type: r.type,
          isGoogle: meta.isGoogle,
          isSharedDrive: meta.isSharedDrive,
          sharedDriveId: meta.sharedDriveId,
          baseRemote: meta.baseRemote,
          email: googleInfo?.email || null,
          displayName: googleInfo?.displayName || null
        };
      })
    );

    res.json({
      ok: true,
      isWindows: IS_WINDOWS,
      authRequired: Boolean(CLOUD_PASSWORD),
      webOAuth: {
        drive: Boolean(getGoogleOAuthConfig()),
        onedrive: Boolean(getOneDriveOAuthConfig()),
        dropbox: Boolean(getProviderOAuthConfig('dropbox')),
        box: Boolean(getProviderOAuthConfig('box')),
        pcloud: Boolean(getProviderOAuthConfig('pcloud')),
        yandex: Boolean(getProviderOAuthConfig('yandex'))
      },
      remotes: enrichedRemotes,
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
    const data = await getPooledStorage();
    res.json({ ok: true, ...data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==================== GOOGLE DRIVE & SHARED DRIVES API ====================

app.get('/api/google/shared-drives', async (req, res) => {
  try {
    const remote = (req.query.remote || '').trim().replace(/:$/, '');
    if (!remote) {
      return res.status(400).json({ ok: false, error: 'יש לציין חשבון Google Drive' });
    }
    const result = await listSharedDrives(remote);
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/google/add-shared-drive', async (req, res) => {
  try {
    const { baseRemote, sharedDriveId, customName } = req.body || {};
    if (!baseRemote) {
      return res.status(400).json({ ok: false, error: 'יש לבחור חשבון Google Drive מקושר' });
    }
    if (!sharedDriveId) {
      return res.status(400).json({ ok: false, error: 'יש להזין מזהה כונן משותף (Shared Drive ID)' });
    }
    const result = await addSharedDrive(baseRemote, sharedDriveId, customName);
    await rebuildUnion();
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

function killAuthProcess(proc) {
  if (!proc) return;
  try {
    if (IS_WINDOWS && proc.pid) {
      const { execFile } = require('child_process');
      execFile('taskkill', ['/F', '/T', '/PID', String(proc.pid)], () => {});
    } else {
      proc.kill();
    }
  } catch (_) {}
}

app.post('/api/accounts/add', async (req, res) => {
  try {
    if (authJob && authJob.process) {
      killAuthProcess(authJob.process);
      authJob = null;
      await new Promise(r => setTimeout(r, 400));
    }

    const { provider, customName } = req.body || {};
    let child, name;

    if (provider === 'drive') {
      const gAuth = await startGoogleLocalAuth(customName);
      child = gAuth.child;
      name = gAuth.name;
    } else if (provider === 'onedrive') {
      const odAuth = await startOneDriveLocalAuth(customName);
      child = odAuth.child;
      name = odAuth.name;
    } else {
      const allowed = {
        dropbox: 'dropbox',
        box: 'box',
        pcloud: 'pcloud',
        yandex: 'yandex'
      };
      if (!allowed[provider]) {
        return res.status(400).json({ ok: false, error: 'ספק לא נתמך.' });
      }
      const existing = await listUserRemotes(UNION_NAME);
      const existingNames = new Set(existing.map(r => r.name.toLowerCase()));
      if (customName && customName.trim()) {
        name = customName.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
        if (!name || name.toLowerCase() === UNION_NAME || existingNames.has(name.toLowerCase())) {
          return res.status(400).json({ ok: false, error: 'שם חשבון לא חוקי או קיים.' });
        }
      } else {
        let idx = 1;
        while (existingNames.has(`${allowed[provider]}_${idx}`)) idx++;
        name = `${allowed[provider]}_${idx}`;
      }
      child = spawn('rclone', ['authorize', provider], {
        windowsHide: true,
        env: getRcloneEnv()
      });
    }

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
      if (m) {
        authJob.authUrl = m[0];
        if (IS_WINDOWS && !authJob.browserOpened) {
          authJob.browserOpened = true;
          spawn('cmd.exe', ['/c', 'start', '""', authJob.authUrl], { detached: true, stdio: 'ignore' }).unref();
        }
      }
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
          try {
            tokenJson = JSON.stringify(JSON.parse(tokenJson));
          } catch (_) {}

          if (provider === 'drive') {
            await addGoogleAccountWithToken(tokenJson, name);
          } else if (provider === 'onedrive') {
            await addOneDriveAccountWithToken(tokenJson, name);
          } else {
            const createArgs = ['config', 'create', name, provider, `token=${tokenJson}`, '--non-interactive'];
            await runRclone(createArgs, 30000);
          }
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
    killAuthProcess(authJob.process);
  }
  authJob = null;
  res.json({ ok: true });
});

app.post('/api/accounts/add-token', async (req, res) => {
  try {
    const { provider, token, customName } = req.body || {};
    const rawToken = String(token || '').trim();
    let tokenJson = rawToken;
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
      tokenJson = JSON.stringify(parsed);
    } catch {
      return res.status(400).json({ ok: false, error: 'הטוקן לא תקין. הדבק את הטוקן JSON שהתקבל מ-rclone authorize.' });
    }

    let result;
    if (provider === 'drive') {
      result = await addGoogleAccountWithToken(tokenJson, customName);
    } else if (provider === 'onedrive') {
      result = await addOneDriveAccountWithToken(tokenJson, customName);
    } else {
      result = await addAccountWithToken(provider, tokenJson, customName);
    }
    await rebuildUnion();

    res.json({ ok: true, name: result.name, provider });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/accounts/add-credentials', async (req, res) => {
  try {
    const { provider } = req.body || {};
    const result = await addAccountWithCredentials(provider, req.body || {});
    await rebuildUnion();
    res.json({ ok: true, name: result.name, provider });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/accounts/export-base64', async (req, res) => {
  try {
    // Security check: if no password set, forbid unauthenticated export from non-localhost
    if (!CLOUD_PASSWORD) {
      const ip = req.ip || req.connection?.remoteAddress || '';
      const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || req.hostname === 'localhost';
      if (!isLocal) {
        return res.status(403).json({
          ok: false,
          error: 'ייצוא הגדרות דרך רשת ציבורית חסום ללא הגדרת CLOUD_PASSWORD בשרת מטעמי אבטחה.'
        });
      }
    }

    let confFile = getRcloneConfigPath();
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
    try { await runRclone(['config', 'delete', `raw_${name}`], 10000); } catch (_) {}
    await rebuildUnion();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==================== API: FILES (UNIFIED CLOUD) ====================

app.get('/api/files', async (req, res) => {
  try {
    const remotes = await listUserRemotes(UNION_NAME);
    if (remotes.length === 0) {
      return res.json({ ok: true, path: '', remote: UNION_NAME, items: [], emptyCloud: true });
    }
    const data = await listFiles(req.query.path || '', req.query.remote || null);
    res.json({ ok: true, path: data.path, remote: data.remote, items: data.items, emptyCloud: false });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/upload', upload.array('files', 50), async (req, res) => {
  const uploadedFiles = req.files || [];
  try {
    const remotes = await listUserRemotes(UNION_NAME);
    if (remotes.length === 0) {
      return res.status(400).json({ ok: false, error: 'אין חשבונות ענן מחוברים עדיין.' });
    }
    const results = await uploadFiles(uploadedFiles, req.query.path || '', req.query.remote || null);
    res.json({ ok: true, uploaded: results });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/download', async (req, res) => {
  const relPath = req.query.path || '';
  if (!relPath) return res.status(400).send('Missing path');

  const filename = path.basename(relPath);
  const inline = req.query.inline === '1';
  const mime = getMimeType(filename);
  const encodedName = encodeURIComponent(filename);

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mime);
  res.setHeader(
    'Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodedName}`
  );

  const rangeHeader = req.headers.range;
  const fileSizeQuery = Number(req.query.size);

  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      const start = parseInt(match[1], 10);
      let totalSize = !isNaN(fileSizeQuery) && fileSizeQuery > 0 ? fileSizeQuery : await getFileSize(relPath);
      const end = match[2] ? parseInt(match[2], 10) : (totalSize ? totalSize - 1 : undefined);
      const count = end !== undefined ? (end - start + 1) : -1;

      res.status(206);
      if (totalSize) {
        res.setHeader('Content-Range', `bytes ${start}-${end !== undefined ? end : totalSize - 1}/${totalSize}`);
        if (count > 0) res.setHeader('Content-Length', count);
      } else {
        res.setHeader('Content-Range', `bytes ${start}-${end !== undefined ? end : '*'}/${totalSize || '*'}`);
      }

      const child = spawnDownloadStream(relPath, start, count);
      req.on('close', () => {
        try { child.kill(); } catch (_) {}
      });
      child.stdout.pipe(res);
      return;
    }
  }

  if (!isNaN(fileSizeQuery) && fileSizeQuery > 0) {
    res.setHeader('Content-Length', fileSizeQuery);
  }

  const child = spawnDownloadStream(relPath);
  req.on('close', () => {
    try { child.kill(); } catch (_) {}
  });
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
    await makeDirectory(req.body.path || '', req.body.name || '', req.body.remote || null);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/rename', async (req, res) => {
  try {
    await renameItem(req.body.oldPath || '', req.body.newName || '', req.body.remote || null);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/files', async (req, res) => {
  try {
    const isDir = req.query.isDir === 'true';
    await deleteItem(req.query.path || '', isDir, req.query.remote || null);
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
    const remotes = await listUserRemotes(UNION_NAME);
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
      '--drive-chunk-size', '64M',
      '--drive-upload-cutoff', '32M',
      '--drive-pacer-min-sleep', '10ms',
      '--network-mode',
      '--volname', 'MyCloud'
    ];

    const proc = spawn('rclone', args, {
      windowsHide: true,
      env: getRcloneEnv()
    });
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

app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: 'נתיב API לא נמצא — ודא ש-server.js מעודכן בשרת.' });
});

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
  rebuildUnion().catch(err => console.log('Notice: initial rebuildUnion on startup:', err.message));
});
