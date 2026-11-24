const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { runRclone, sanitizeRelPath, getMimeType, decodeFilename, getRcloneEnv } = require('./rclone-runner');
const { UNION_NAME, rebuildUnion } = require('./union-manager');

// Unified File Service
// Exposes high-level unified file management operations across all pooled clouds,
// with optional per-remote scoping (e.g. for filtering to a specific Google account or Shared Drive)

function getTargetRemote(remote) {
  if (remote && typeof remote === 'string' && remote.trim() && remote.trim() !== UNION_NAME) {
    return remote.trim().replace(/:$/, '');
  }
  return UNION_NAME;
}

async function listFiles(rawPath = '', remote = null) {
  const activeRemote = getTargetRemote(remote);
  if (activeRemote === UNION_NAME) {
    await rebuildUnion();
  }
  const relPath = sanitizeRelPath(rawPath);
  const target = relPath ? `${activeRemote}:${relPath}` : `${activeRemote}:`;
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

  return { path: relPath, remote: activeRemote, items };
}

async function uploadFiles(files, rawPath = '', remote = null) {
  const activeRemote = getTargetRemote(remote);
  const relPath = sanitizeRelPath(rawPath);
  const results = [];
  try {
    for (const file of files) {
      const originalName = decodeFilename(file.originalname);
      const destPath = relPath ? `${activeRemote}:${relPath}/${originalName}` : `${activeRemote}:${originalName}`;
      await runRclone(['copyto', file.path, destPath], 300000);
      results.push({ name: originalName, size: file.size });
    }
    return results;
  } finally {
    for (const file of files) {
      fs.unlink(file.path, () => {});
    }
  }
}

function spawnDownloadStream(relPath, remote = null) {
  const activeRemote = getTargetRemote(remote);
  const clean = sanitizeRelPath(relPath);
  return spawn('rclone', ['cat', `${activeRemote}:${clean}`], { env: getRcloneEnv() });
}

async function makeDirectory(rawPath, folderName, remote = null) {
  const activeRemote = getTargetRemote(remote);
  const relPath = sanitizeRelPath(rawPath);
  const cleanName = (folderName || '').trim().replace(/[\\/:*?"<>|]/g, '');
  if (!cleanName) throw new Error('שם תיקייה לא תקין');
  const target = relPath ? `${activeRemote}:${relPath}/${cleanName}` : `${activeRemote}:${cleanName}`;
  await runRclone(['mkdir', target], 20000);
  return true;
}

async function renameItem(oldPathRaw, newNameRaw, remote = null) {
  const activeRemote = getTargetRemote(remote);
  const oldPath = sanitizeRelPath(oldPathRaw);
  const newName = (newNameRaw || '').trim().replace(/[\\/:*?"<>|]/g, '');
  if (!oldPath || !newName) throw new Error('פרטים חסרים לשינוי שם');

  const dir = path.posix.dirname(oldPath);
  const newPath = dir === '.' ? newName : `${dir}/${newName}`;
  await runRclone(['moveto', `${activeRemote}:${oldPath}`, `${activeRemote}:${newPath}`], 30000);
  return true;
}

async function deleteItem(pathRaw, isDir, remote = null) {
  const activeRemote = getTargetRemote(remote);
  const relPath = sanitizeRelPath(pathRaw);
  if (!relPath) throw new Error('נתיב חסר למחיקה');
  const cmd = isDir ? 'purge' : 'deletefile';
  await runRclone([cmd, `${activeRemote}:${relPath}`], 30000);
  return true;
}

module.exports = {
  listFiles,
  uploadFiles,
  spawnDownloadStream,
  makeDirectory,
  renameItem,
  deleteItem
};
