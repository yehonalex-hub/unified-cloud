const { spawn } = require('child_process');
const { runRclone, listUserRemotes, getRemotesConfig, getRcloneEnv } = require('./rclone-runner');

// Dedicated Google Drive Connector (Luna / Pixel domain)
// Isolates all Google Drive interactions: OAuth 2.0 Web, rclone authorize local, Multi-Google & Shared Drives

const googleAccountCache = new Map(); // remoteName -> { email, displayName, fetchedAt }

function getGoogleOAuthConfig() {
  const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    extraAuthParams: {
      scope: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/userinfo.email openid',
      access_type: 'offline',
      prompt: 'select_account consent'
    }
  };
}

async function getNextGoogleRemoteName(customName = null) {
  const existing = await listUserRemotes();
  const existingNames = new Set(existing.map(r => r.name.toLowerCase()));
  if (customName && customName.trim()) {
    const name = customName.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
    if (!name || existingNames.has(name.toLowerCase())) {
      throw new Error('שם חשבון Google לא חוקי או כבר קיים.');
    }
    return name;
  }
  let idx = 1;
  while (existingNames.has(`google_${idx}`)) idx++;
  return `google_${idx}`;
}

async function addGoogleAccountWithToken(tokenJson, customName = null) {
  const name = await getNextGoogleRemoteName(customName);
  const createArgs = ['config', 'create', name, 'drive', `token=${tokenJson}`, '--non-interactive'];
  await runRclone(createArgs, 30000);
  return { name, provider: 'drive' };
}

function startGoogleLocalAuth(customName = null) {
  return new Promise(async (resolve, reject) => {
    try {
      const name = await getNextGoogleRemoteName(customName);
      const child = spawn('rclone', ['authorize', 'drive'], {
        windowsHide: true,
        env: getRcloneEnv()
      });
      resolve({ child, name, provider: 'drive' });
    } catch (err) {
      reject(err);
    }
  });
}

function decodeJwtPayload(jwt) {
  try {
    const parts = String(jwt || '').split('.');
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const jsonStr = Buffer.from(b64, 'base64').toString('utf8');
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

async function getGoogleAccountInfo(remoteName, remoteConfig) {
  if (!remoteConfig) return null;
  const cached = googleAccountCache.get(remoteName);
  if (cached && (Date.now() - cached.fetchedAt < 30 * 60 * 1000)) {
    return cached;
  }

  let email = null;
  let displayName = null;

  try {
    let tokenObj = null;
    if (typeof remoteConfig.token === 'string') {
      try { tokenObj = JSON.parse(remoteConfig.token); } catch (_) {}
    } else if (remoteConfig.token && typeof remoteConfig.token === 'object') {
      tokenObj = remoteConfig.token;
    }

    // 1. Try decoding id_token first (zero network overhead)
    if (tokenObj && tokenObj.id_token) {
      const payload = decodeJwtPayload(tokenObj.id_token);
      if (payload) {
        email = payload.email || null;
        displayName = payload.name || payload.email || null;
      }
    }

    // 2. Query Google Drive API with access_token if needed
    if (!email && tokenObj && tokenObj.access_token) {
      const res = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress)', {
        headers: { Authorization: `Bearer ${tokenObj.access_token}` },
        signal: AbortSignal.timeout(3500)
      });
      if (res.ok) {
        const data = await res.json();
        if (data && data.user) {
          email = data.user.emailAddress || null;
          displayName = data.user.displayName || email || null;
        }
      }
    }
  } catch (_) {}

  const result = { email, displayName, fetchedAt: Date.now() };
  if (email || displayName) {
    googleAccountCache.set(remoteName, result);
  }
  return result;
}

function parseGoogleRemoteMeta(remoteName, remoteType, config = {}) {
  // Support both full config object { remoteName: { ... } } or single remote config { type: ... }
  const rConf = (config && config[remoteName]) ? config[remoteName] : (config || {});
  const type = remoteType || rConf.type || '';
  const isDirectDrive = type === 'drive';
  const isAlias = type === 'alias';
  
  let isSharedDrive = false;
  let sharedDriveId = null;
  let baseRemote = null;

  if (isDirectDrive && rConf.team_drive) {
    isSharedDrive = true;
    sharedDriveId = rConf.team_drive;
    baseRemote = remoteName;
  } else if (isAlias && rConf.remote && rConf.remote.includes('team_drive=')) {
    isSharedDrive = true;
    const m = rConf.remote.match(/team_drive=([^,:]+)/);
    sharedDriveId = m ? m[1] : null;
    baseRemote = rConf.remote.split(',')[0].replace(/:$/, '').trim();
  }

  const isGoogle = isDirectDrive || isSharedDrive || Boolean(isAlias && baseRemote && config[baseRemote]?.type === 'drive');

  return {
    isGoogle: Boolean(isGoogle),
    isSharedDrive,
    sharedDriveId,
    baseRemote
  };
}

async function listSharedDrives(remoteName) {
  const remotes = await listUserRemotes();
  const conf = await getRemotesConfig();
  const target = remotes.find(r => r.name.toLowerCase() === remoteName.toLowerCase());
  if (!target) {
    throw new Error(`חשבון הענן "${remoteName}" לא נמצא.`);
  }

  const meta = parseGoogleRemoteMeta(target.name, target.type, conf);
  if (!meta.isGoogle || meta.isSharedDrive) {
    throw new Error(`החשבון "${remoteName}" אינו חשבון Google Drive ראשי.`);
  }

  try {
    const { stdout } = await runRclone(['backend', 'drives', `${target.name}:`], 20000);
    let list = [];
    try {
      list = JSON.parse(stdout || '[]');
    } catch {
      const match = stdout.match(/\[[\s\S]*\]/);
      if (match) list = JSON.parse(match[0]);
    }

    // Map existing shared drives to detect if already connected
    const connectedDriveIds = new Map();
    for (const r of remotes) {
      const rMeta = parseGoogleRemoteMeta(r.name, r.type, conf);
      if (rMeta.isSharedDrive && rMeta.sharedDriveId) {
        connectedDriveIds.set(rMeta.sharedDriveId, r.name);
      }
    }

    const drives = (Array.isArray(list) ? list : []).map(d => ({
      id: d.id,
      name: d.name,
      alreadyConnected: connectedDriveIds.has(d.id),
      connectedRemoteName: connectedDriveIds.get(d.id) || null
    }));

    return { ok: true, remote: target.name, drives };
  } catch (err) {
    return {
      ok: true,
      remote: target.name,
      drives: [],
      note: 'לא אותרו כוננים משותפים או שאין הרשאת גישה לכונני צוות בחשבון זה.'
    };
  }
}

async function addSharedDrive(baseRemote, rawSharedDriveId, customName = null) {
  let sharedDriveId = String(rawSharedDriveId || '').trim();
  // Support pasting full Google Drive URL
  const urlMatch = sharedDriveId.match(/folders\/([a-zA-Z0-9_-]+)/);
  if (urlMatch) {
    sharedDriveId = urlMatch[1];
  }

  if (!sharedDriveId) {
    throw new Error('יש להזין מזהה כונן משותף (Shared Drive ID) תקין.');
  }

  const remotes = await listUserRemotes();
  const conf = await getRemotesConfig();
  const target = remotes.find(r => r.name.toLowerCase() === baseRemote.toLowerCase());
  if (!target) {
    throw new Error(`חשבון הבסיס "${baseRemote}" לא נמצא.`);
  }

  const existingNames = new Set(remotes.map(r => r.name.toLowerCase()));
  let name = '';
  if (customName && customName.trim()) {
    name = customName.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
    if (!name || existingNames.has(name.toLowerCase())) {
      throw new Error('שם כונן לא חוקי או שכבר קיים חשבון בשם הזה.');
    }
  } else {
    let idx = 1;
    while (existingNames.has(`shared_drive_${idx}`)) idx++;
    name = `shared_drive_${idx}`;
  }

  const aliasTarget = `${target.name},team_drive=${sharedDriveId},root_folder_id=:`;
  await runRclone([
    'config', 'create', name, 'alias',
    `remote=${aliasTarget}`,
    '--non-interactive'
  ], 20000);

  return { ok: true, name, baseRemote: target.name, sharedDriveId };
}

async function createGoogleRemoteFromOAuth(cfg, tokenData, customName = null) {
  const expiry = new Date(Date.now() + (Number(tokenData.expires_in) || 3600) * 1000).toISOString();
  const rcloneToken = JSON.stringify({
    access_token: tokenData.access_token,
    token_type: tokenData.token_type || 'Bearer',
    refresh_token: tokenData.refresh_token || '',
    expiry
  });
  return await addGoogleAccountWithToken(rcloneToken, customName);
}

async function verifyGoogleConnection(name) {
  try {
    await runRclone(['about', `${name}:`, '--json'], 15000);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  getGoogleOAuthConfig,
  getNextGoogleRemoteName,
  addGoogleAccountWithToken,
  startGoogleLocalAuth,
  getGoogleAccountInfo,
  parseGoogleRemoteMeta,
  listSharedDrives,
  addSharedDrive,
  createGoogleRemoteFromOAuth,
  verifyGoogleConnection
};
