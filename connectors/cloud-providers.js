const path = require('path');
const fs = require('fs');
const { runRclone, listUserRemotes } = require('./rclone-runner');
const { getOneDriveOAuthConfig, addOneDriveAccountWithToken } = require('./onedrive');

function getStoredOAuthKey(key) {
  try {
    const p = path.join(__dirname, '..', 'oauth-settings.json');
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      return data[key] || '';
    }
  } catch (_) {}
  return '';
}

// Modular Cloud Providers Connector (Ember, Skye, Turnip domain)
// Isolates Dropbox, MEGA, Box, pCloud, Koofr, Cloudflare R2 / S3, Yandex, delegating OneDrive to Atlas's onedrive connector

const PROVIDER_NAMES = {
  drive: 'google',
  onedrive: 'onedrive',
  dropbox: 'dropbox',
  box: 'box',
  pcloud: 'pcloud',
  yandex: 'yandex',
  mega: 'mega',
  koofr: 'koofr',
  s3: 'r2',
  webdav: 'webdav'
};

function getProviderOAuthConfig(provider) {
  if (provider === 'dropbox') {
    const clientId = (process.env.DROPBOX_CLIENT_ID || getStoredOAuthKey('DROPBOX_CLIENT_ID') || '').trim();
    const clientSecret = (process.env.DROPBOX_CLIENT_SECRET || getStoredOAuthKey('DROPBOX_CLIENT_SECRET') || '').trim();
    if (!clientId || !clientSecret) return null;
    return {
      clientId,
      clientSecret,
      authUrl: 'https://www.dropbox.com/oauth2/authorize',
      tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
      extraAuthParams: { token_access_type: 'offline' }
    };
  }
  if (provider === 'onedrive') {
    return getOneDriveOAuthConfig();
  }
  if (provider === 'box') {
    const clientId = (process.env.BOX_CLIENT_ID || getStoredOAuthKey('BOX_CLIENT_ID') || '').trim();
    const clientSecret = (process.env.BOX_CLIENT_SECRET || getStoredOAuthKey('BOX_CLIENT_SECRET') || '').trim();
    if (!clientId || !clientSecret) return null;
    return {
      clientId,
      clientSecret,
      authUrl: 'https://account.box.com/api/oauth2/authorize',
      tokenUrl: 'https://api.box.com/oauth2/token',
      extraAuthParams: {}
    };
  }
  if (provider === 'pcloud') {
    const clientId = (process.env.PCLOUD_CLIENT_ID || getStoredOAuthKey('PCLOUD_CLIENT_ID') || '').trim();
    const clientSecret = (process.env.PCLOUD_CLIENT_SECRET || getStoredOAuthKey('PCLOUD_CLIENT_SECRET') || '').trim();
    if (!clientId || !clientSecret) return null;
    return {
      clientId,
      clientSecret,
      authUrl: 'https://my.pcloud.com/oauth2/authorize',
      tokenUrl: 'https://api.pcloud.com/oauth2_token',
      extraAuthParams: {}
    };
  }
  if (provider === 'yandex') {
    const clientId = (process.env.YANDEX_CLIENT_ID || getStoredOAuthKey('YANDEX_CLIENT_ID') || '').trim();
    const clientSecret = (process.env.YANDEX_CLIENT_SECRET || getStoredOAuthKey('YANDEX_CLIENT_SECRET') || '').trim();
    if (!clientId || !clientSecret) return null;
    return {
      clientId,
      clientSecret,
      authUrl: 'https://oauth.yandex.com/authorize',
      tokenUrl: 'https://oauth.yandex.com/token',
      extraAuthParams: {}
    };
  }
  return null;
}

async function getNextRemoteName(provider, customName = null) {
  const allowed = PROVIDER_NAMES[provider];
  if (!allowed) throw new Error(`ספק ענן לא נתמך: ${provider}`);

  const existing = await listUserRemotes();
  const existingNames = new Set(existing.map(r => r.name.toLowerCase()));

  if (customName && customName.trim()) {
    const name = customName.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
    if (!name || existingNames.has(name.toLowerCase())) {
      throw new Error('שם חשבון לא חוקי או כבר קיים.');
    }
    return name;
  }

  let idx = 1;
  while (existingNames.has(`${allowed}_${idx}`)) idx++;
  return `${allowed}_${idx}`;
}

async function addAccountWithToken(provider, tokenJson, customName = null) {
  if (provider === 'onedrive') {
    return await addOneDriveAccountWithToken(tokenJson, customName);
  }
  const name = await getNextRemoteName(provider, customName);
  const createArgs = ['config', 'create', name, provider, `token=${tokenJson}`, '--non-interactive'];
  await runRclone(createArgs, 30000);
  return { name, provider };
}

async function addAccountWithCredentials(provider, params) {
  const { user, password, accessKey, secretKey, endpoint, bucket, region, url, vendor, customName } = params;
  const name = await getNextRemoteName(provider, customName);
  const cleanBucket = (bucket || '').trim().replace(/^\/+|\/+$/g, '');

  if (provider === 'mega') {
    if (!user || !password) throw new Error('יש להזין אימייל וסיסמה של MEGA.');
    const createArgs = ['config', 'create', name, 'mega', `user=${user.trim()}`, `pass=${password}`, '--obscure', '--non-interactive'];
    await runRclone(createArgs, 30000);

    // Proactive live connection verification for MEGA
    try {
      await runRclone(['lsd', `${name}:`, '--contimeout', '6s', '--timeout', '12s', '--retries', '1'], 15000);
    } catch (testErr) {
      try { await runRclone(['config', 'delete', name], 10000); } catch (_) {}
      const raw = testErr.message || '';
      let msg = 'אימות מול MEGA נכשל: ';
      if (raw.includes('not found') || raw.includes('login') || raw.includes('password') || raw.includes('blocked')) {
        msg += 'אימייל או סיסמה שגויים, או שמופעל בחשבון אימות דו-שלבי.';
      } else {
        msg += raw;
      }
      throw new Error(msg);
    }

    return { name, provider };
  }

  if (provider === 'koofr') {
    if (!user || !password) throw new Error('יש להזין אימייל ו-App Password של Koofr.');
    const createArgs = ['config', 'create', name, 'koofr', 'provider=koofr', `user=${user.trim()}`, `password=${password}`, '--obscure', '--non-interactive'];
    await runRclone(createArgs, 30000);

    try {
      await runRclone(['lsd', `${name}:`, '--contimeout', '6s', '--timeout', '12s', '--retries', '1'], 15000);
    } catch (testErr) {
      try { await runRclone(['config', 'delete', name], 10000); } catch (_) {}
      throw new Error(`אימות מול Koofr נכשל: ${testErr.message || 'פרטים שגויים.'}`);
    }

    return { name, provider };
  }

  if (provider === 's3') {
    if (!accessKey || !secretKey) {
      throw new Error('יש להזין Access Key ID ו-Secret Access Key.');
    }
    const rawEndpoint = (endpoint || '').trim();
    const rawRegion = (region || '').trim();
    if (!rawEndpoint && !rawRegion) {
      throw new Error('יש להזין Endpoint (עבור Cloudflare R2 / S3 תואם) או Region (עבור AWS S3).');
    }

    // Smart S3 provider detection
    let s3Provider = 'Cloudflare';
    if (rawEndpoint.includes('r2.cloudflarestorage.com')) s3Provider = 'Cloudflare';
    else if (rawEndpoint.includes('wasabisys.com')) s3Provider = 'Wasabi';
    else if (rawEndpoint.includes('digitaloceanspaces.com')) s3Provider = 'DigitalOcean';
    else if (rawEndpoint.includes('amazonaws.com') || (!rawEndpoint && rawRegion)) s3Provider = 'AWS';
    else if (rawEndpoint) s3Provider = 'Other';

    const baseName = cleanBucket ? `raw_${name}` : name;
    const s3Args = [
      'config', 'create', baseName, 's3',
      `provider=${s3Provider}`,
      `access_key_id=${accessKey.trim()}`,
      `secret_access_key=${secretKey.trim()}`
    ];
    if (rawEndpoint) s3Args.push(`endpoint=${rawEndpoint}`);
    if (rawRegion) s3Args.push(`region=${rawRegion}`);
    if (cleanBucket) s3Args.push('no_check_bucket=true');
    s3Args.push('--non-interactive');

    await runRclone(s3Args, 30000);

    if (cleanBucket) {
      await runRclone(['config', 'create', name, 'alias', `remote=${baseName}:${cleanBucket}`, '--non-interactive'], 15000);
    }

    // Proactive live connection verification for S3/R2
    try {
      await runRclone(['lsd', `${name}:`, '--contimeout', '6s', '--timeout', '12s', '--retries', '1'], 15000);
    } catch (testErr) {
      try { await runRclone(['config', 'delete', name], 10000); } catch (_) {}
      if (cleanBucket) {
        try { await runRclone(['config', 'delete', baseName], 10000); } catch (_) {}
      }
      const raw = testErr.message || '';
      let msg = 'אימות מול S3 / Cloudflare R2 נכשל: ';
      if (raw.includes('AccessDenied') || raw.includes('InvalidAccessKeyId') || raw.includes('SignatureDoesNotMatch') || raw.includes('403')) {
        msg += 'מפתחות גישה שגויים או שאין הרשאת גישה ל-Bucket / Endpoint.';
      } else if (raw.includes('NoSuchEndpoint') || raw.includes('no such host')) {
        msg += 'כתובת ה-Endpoint שגויה או שלא ניתן להגיע לשרת.';
      } else if (raw.includes('NoSuchBucket')) {
        msg += `ה-Bucket "${cleanBucket}" לא קיים בשרת.`;
      } else {
        msg += raw;
      }
      throw new Error(msg);
    }

    return { name, provider };
  }

  if (provider === 'webdav') {
    if (!url || !url.trim()) throw new Error('יש להזין כתובת שרת WebDAV (URL).');
    let targetUrl = url.trim();
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      targetUrl = 'https://' + targetUrl;
    }
    const vendorChoice = (vendor && vendor.trim()) ? vendor.trim().toLowerCase() : 'other';
    const createArgs = [
      'config', 'create', name, 'webdav',
      `url=${targetUrl}`,
      `vendor=${vendorChoice}`,
      '--non-interactive'
    ];
    if (user && user.trim()) {
      createArgs.push(`user=${user.trim()}`);
    }
    if (password) {
      createArgs.push(`pass=${password}`);
      createArgs.push('--obscure');
    }

    await runRclone(createArgs, 30000);

    // Live connection verification for WebDAV
    try {
      await runRclone(['lsd', `${name}:`, '--contimeout', '6s', '--timeout', '12s', '--retries', '1'], 15000);
    } catch (testErr) {
      const raw = testErr.message || '';
      if (raw.includes('401') || raw.includes('Unauthorized') || raw.includes('authentication')) {
        try { await runRclone(['config', 'delete', name], 10000); } catch (_) {}
        throw new Error('אימות מול שרת WebDAV נכשל: שם משתמש או סיסמה שגויים (401 Unauthorized).');
      }
      if (raw.includes('no such host') || raw.includes('connection refused') || raw.includes('timeout')) {
        try { await runRclone(['config', 'delete', name], 10000); } catch (_) {}
        throw new Error(`חיבור לשרת WebDAV נכשל: ${raw}`);
      }
    }

    return { name, provider };
  }

  if (provider === 'pcloud') {
    if (!user || !password) throw new Error('יש להזין אימייל וסיסמה של pCloud.');
    const isEu = (endpoint && endpoint.toLowerCase().includes('eu')) || (region && region.toLowerCase().includes('eu'));
    const pcloudUrl = isEu ? 'https://ewebdav.pcloud.com' : 'https://webdav.pcloud.com';
    const createArgs = [
      'config', 'create', name, 'webdav',
      `url=${pcloudUrl}`,
      'vendor=other',
      `user=${user.trim()}`,
      `pass=${password}`,
      '--obscure',
      '--non-interactive'
    ];

    await runRclone(createArgs, 30000);

    try {
      await runRclone(['lsd', `${name}:`, '--contimeout', '6s', '--timeout', '12s', '--retries', '1'], 15000);
    } catch (testErr) {
      const raw = testErr.message || '';
      if (raw.includes('401') || raw.includes('Unauthorized')) {
        try { await runRclone(['config', 'delete', name], 10000); } catch (_) {}
        throw new Error('אימות מול pCloud נכשל: אימייל או סיסמה שגויים (וודא גם שבחרת את אזור השרת הנכון ארה"ב/אירופה).');
      }
      if (raw.includes('no such host') || raw.includes('timeout')) {
        try { await runRclone(['config', 'delete', name], 10000); } catch (_) {}
        throw new Error(`חיבור ל-pCloud נכשל: ${raw}`);
      }
    }

    return { name, provider };
  }

  if (provider === 'yandex') {
    if (!user || !password) throw new Error('יש להזין אימייל ו-App Password של Yandex Disk.');
    const createArgs = [
      'config', 'create', name, 'webdav',
      'url=https://webdav.yandex.com',
      'vendor=other',
      `user=${user.trim()}`,
      `pass=${password}`,
      '--obscure',
      '--non-interactive'
    ];

    await runRclone(createArgs, 30000);

    try {
      await runRclone(['lsd', `${name}:`, '--contimeout', '6s', '--timeout', '12s', '--retries', '1'], 15000);
    } catch (testErr) {
      const raw = testErr.message || '';
      if (raw.includes('401') || raw.includes('Unauthorized')) {
        try { await runRclone(['config', 'delete', name], 10000); } catch (_) {}
        throw new Error('אימות מול Yandex נכשל: אימייל או סיסמת אפליקציה (App Password) שגויים.');
      }
      if (raw.includes('no such host') || raw.includes('timeout')) {
        try { await runRclone(['config', 'delete', name], 10000); } catch (_) {}
        throw new Error(`חיבור ל-Yandex נכשל: ${raw}`);
      }
    }

    return { name, provider };
  }

  throw new Error(`חיבור בסיסמאות לא נתמך עבור ${provider}`);
}

module.exports = {
  PROVIDER_NAMES,
  getProviderOAuthConfig,
  getNextRemoteName,
  addAccountWithToken,
  addAccountWithCredentials
};
