const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { runRclone, listUserRemotes } = require('./rclone-runner');

// Dedicated OneDrive & Microsoft 365 / SharePoint Connector (Atlas domain)
// Isolates all Microsoft Graph OAuth 2.0, OneDrive Personal, and Microsoft 365 Business integration

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

function getOneDriveOAuthConfig() {
  const clientId = (process.env.ONEDRIVE_CLIENT_ID || process.env.MICROSOFT_CLIENT_ID || getStoredOAuthKey('ONEDRIVE_CLIENT_ID') || '').trim();
  const clientSecret = (process.env.ONEDRIVE_CLIENT_SECRET || process.env.MICROSOFT_CLIENT_SECRET || getStoredOAuthKey('ONEDRIVE_CLIENT_SECRET') || '').trim();
  if (!clientId || !clientSecret) return null;

  return {
    clientId,
    clientSecret,
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    extraAuthParams: {
      scope: 'Files.ReadWrite.All offline_access User.Read Sites.Read.All',
      prompt: 'select_account'
    }
  };
}

/**
 * Automatically discovers drive_id and drive_type from Microsoft Graph API
 * This is crucial because rclone requires both drive_id and drive_type to mount or list OneDrive.
 */
async function resolveOneDriveDetails(tokenInput) {
  let accessToken = '';
  try {
    if (typeof tokenInput === 'string') {
      const parsed = JSON.parse(tokenInput);
      accessToken = parsed.access_token || '';
    } else if (tokenInput && typeof tokenInput === 'object') {
      accessToken = tokenInput.access_token || '';
    }
  } catch (_) {
    accessToken = String(tokenInput || '');
  }

  if (!accessToken) {
    return { drive_type: 'personal', drive_id: '' };
  }

  const result = {
    drive_id: '',
    drive_type: 'personal',
    drive_name: 'OneDrive',
    user_name: '',
    user_email: '',
    quota_total: null,
    quota_used: null
  };

  // 1. Query Microsoft Graph primary drive: GET /v1.0/me/drive
  try {
    const res = await fetch('https://graph.microsoft.com/v1.0/me/drive', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json'
      }
    });

    if (res.ok) {
      const data = await res.json();
      if (data && data.id) {
        result.drive_id = data.id;
        result.drive_type = data.driveType || 'personal';
        result.drive_name = data.name || 'OneDrive';
        if (data.quota) {
          result.quota_total = data.quota.total;
          result.quota_used = data.quota.used;
        }
        if (data.owner?.user) {
          result.user_name = data.owner.user.displayName || '';
          result.user_email = data.owner.user.email || data.owner.user.userPrincipalName || '';
        }
      }
    }
  } catch (err) {
    console.warn('[OneDrive Graph] /me/drive lookup error:', err.message);
  }

  // 2. Fallback: GET /v1.0/me/drives if primary drive ID was not found
  if (!result.drive_id) {
    try {
      const res = await fetch('https://graph.microsoft.com/v1.0/me/drives', {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json'
        }
      });
      if (res.ok) {
        const data = await res.json();
        if (data && Array.isArray(data.value) && data.value.length > 0) {
          const primary = data.value[0];
          result.drive_id = primary.id;
          result.drive_type = primary.driveType || 'personal';
          result.drive_name = primary.name || 'OneDrive';
        }
      }
    } catch (err) {
      console.warn('[OneDrive Graph] /me/drives fallback error:', err.message);
    }
  }

  // 3. User profile information: GET /v1.0/me (if name/email still blank)
  if (!result.user_email) {
    try {
      const userRes = await fetch('https://graph.microsoft.com/v1.0/me', {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json'
        }
      });
      if (userRes.ok) {
        const userData = await userRes.json();
        result.user_name = result.user_name || userData.displayName || '';
        result.user_email = userData.mail || userData.userPrincipalName || '';
      }
    } catch (_) {}
  }

  return result;
}

async function getNextOneDriveRemoteName(customName = null) {
  const existing = await listUserRemotes();
  const existingNames = new Set(existing.map(r => r.name.toLowerCase()));

  if (customName && customName.trim()) {
    const name = customName.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
    if (!name || existingNames.has(name.toLowerCase())) {
      throw new Error('שם חשבון OneDrive לא חוקי או כבר קיים.');
    }
    return name;
  }

  let idx = 1;
  while (existingNames.has(`onedrive_${idx}`)) idx++;
  return `onedrive_${idx}`;
}

/**
 * Configure and register a new OneDrive remote in rclone.
 * Automatically resolves drive_id and drive_type using Microsoft Graph API.
 */
async function addOneDriveAccountWithToken(tokenJson, customName = null, options = {}) {
  const name = await getNextOneDriveRemoteName(customName);
  const odInfo = await resolveOneDriveDetails(tokenJson);

  const driveType = options.driveType || odInfo.drive_type || 'personal';
  const driveId = options.driveId || odInfo.drive_id || '';

  const cfg = getOneDriveOAuthConfig();
  const createArgs = [
    'config', 'create', name, 'onedrive',
    `token=${tokenJson}`,
    `drive_type=${driveType}`,
    '--non-interactive'
  ];

  if (driveId) {
    createArgs.push(`drive_id=${driveId}`);
  }

  if (cfg) {
    createArgs.push(`client_id=${cfg.clientId}`);
    createArgs.push(`client_secret=${cfg.clientSecret}`);
  }

  await runRclone(createArgs, 30000);

  return {
    name,
    provider: 'onedrive',
    driveType,
    driveId,
    driveName: odInfo.drive_name,
    userName: odInfo.user_name,
    userEmail: odInfo.user_email
  };
}

function startOneDriveLocalAuth(customName = null) {
  return new Promise(async (resolve, reject) => {
    try {
      const name = await getNextOneDriveRemoteName(customName);
      const child = spawn('rclone', ['authorize', 'onedrive'], { windowsHide: true });
      resolve({ child, name, provider: 'onedrive' });
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = {
  getOneDriveOAuthConfig,
  resolveOneDriveDetails,
  getNextOneDriveRemoteName,
  addOneDriveAccountWithToken,
  startOneDriveLocalAuth
};
