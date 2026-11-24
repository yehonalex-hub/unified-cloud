const { spawn } = require('child_process');
const fs = require('fs');
const { runRclone, listUserRemotes, getRemotesConfig } = require('./rclone-runner');
const { parseGoogleRemoteMeta, getGoogleAccountInfo } = require('./google-drive');

// Union & Storage Orchestrator (Rio & Clover domain)
// Pools all clouds into single 'mycloud' upstream, manages space calculation, and handles Windows drive mounting

const UNION_NAME = 'mycloud';

function isWinFspInstalled() {
  return (
    fs.existsSync('C:\\Program Files (x86)\\WinFsp\\bin\\winfsp-x64.dll') ||
    fs.existsSync('C:\\Program Files\\WinFsp\\bin\\winfsp-x64.dll') ||
    fs.existsSync('C:\\Program Files (x86)\\WinFsp\\bin\\winfsp-x86.dll')
  );
}

async function rebuildUnion() {
  const remotes = await listUserRemotes(UNION_NAME);
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

async function getPooledStorage() {
  const remotes = await listUserRemotes(UNION_NAME);
  const conf = await getRemotesConfig();

  const results = await Promise.all(
    remotes.map(async (r) => {
      const meta = parseGoogleRemoteMeta(r.name, r.type, conf);
      let googleInfo = null;
      if (meta.isGoogle && !meta.isSharedDrive) {
        googleInfo = await getGoogleAccountInfo(r.name, conf[r.name]);
      } else if (meta.isSharedDrive && meta.baseRemote) {
        googleInfo = await getGoogleAccountInfo(meta.baseRemote, conf[meta.baseRemote]);
      }

      try {
        const { stdout } = await runRclone(['about', `${r.name}:`, '--json', '--contimeout', '10s', '--timeout', '15s', '--retries', '1'], 20000);
        const data = JSON.parse(stdout || '{}');
        const total = Number(data.total || 0);
        const free = Number(data.free != null ? data.free : Math.max(0, total - Number(data.used || 0)));
        const used = total > 0 ? Math.max(0, total - free) : Number(data.used || 0);
        return {
          name: r.name,
          type: r.type,
          total,
          used,
          free,
          error: null,
          isGoogle: meta.isGoogle,
          isSharedDrive: meta.isSharedDrive,
          sharedDriveId: meta.sharedDriveId,
          baseRemote: meta.baseRemote,
          email: googleInfo?.email || null,
          displayName: googleInfo?.displayName || null,
          unlimited: false
        };
      } catch (err) {
        // Shared Drives do not report user quota in about API
        if (meta.isSharedDrive) {
          return {
            name: r.name,
            type: r.type,
            total: 0,
            used: 0,
            free: 0,
            error: null,
            unlimited: true,
            isGoogle: true,
            isSharedDrive: true,
            sharedDriveId: meta.sharedDriveId,
            baseRemote: meta.baseRemote,
            email: googleInfo?.email || null,
            displayName: googleInfo?.displayName || null
          };
        }
        const msg = (err && err.message) || '';
        // Object storage (S3 / Cloudflare R2 / MinIO) does not support quota 'about' API
        if (r.type === 's3' || msg.includes("doesn't support about") || msg.includes('not supported') || msg.includes('Failed to about')) {
          return {
            name: r.name,
            type: r.type,
            total: 0,
            used: 0,
            free: 0,
            error: null,
            unlimited: true,
            isGoogle: meta.isGoogle,
            isSharedDrive: meta.isSharedDrive,
            sharedDriveId: meta.sharedDriveId,
            baseRemote: meta.baseRemote,
            email: googleInfo?.email || null,
            displayName: googleInfo?.displayName || null
          };
        }
        return {
          name: r.name,
          type: r.type,
          total: 0,
          used: 0,
          free: 0,
          error: err.message,
          isGoogle: meta.isGoogle,
          isSharedDrive: meta.isSharedDrive,
          sharedDriveId: meta.sharedDriveId,
          baseRemote: meta.baseRemote,
          email: googleInfo?.email || null,
          displayName: googleInfo?.displayName || null,
          unlimited: false
        };
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

  return { ...summary, accounts: results };
}

module.exports = {
  UNION_NAME,
  isWinFspInstalled,
  rebuildUnion,
  getPooledStorage
};
