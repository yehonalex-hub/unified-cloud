const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Support loading rclone.conf from RCLONE_CONFIG_BASE64 env var
let rcloneConfigPath = process.env.RCLONE_CONFIG || null;
if (process.env.RCLONE_CONFIG_BASE64) {
  const confDir = path.join(os.tmpdir(), 'unified-cloud-rclone');
  if (!fs.existsSync(confDir)) fs.mkdirSync(confDir, { recursive: true });
  rcloneConfigPath = path.join(confDir, 'rclone.conf');
  const decoded = Buffer.from(process.env.RCLONE_CONFIG_BASE64.trim(), 'base64').toString('utf8');
  fs.writeFileSync(rcloneConfigPath, decoded, { mode: 0o600 });
}

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

function sanitizeRelPath(p) {
  if (!p) return '';
  let clean = String(p).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  const parts = clean.split('/').filter(seg => seg && seg !== '.' && seg !== '..');
  return parts.join('/');
}

async function listUserRemotes(unionName = 'mycloud') {
  try {
    const { stdout } = await runRclone(['listremotes', '--long'], 15000);
    const remotes = [];
    const rawMap = {};
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const match = trimmed.match(/^([^:]+):\s+(\S+)/);
      if (match) {
        rawMap[match[1].trim()] = match[2].trim();
      }
    }
    for (const [name, type] of Object.entries(rawMap)) {
      if (name !== unionName && !name.startsWith('raw_')) {
        let displayType = type;
        if (type === 'alias' && rawMap[`raw_${name}`]) {
          displayType = rawMap[`raw_${name}`];
        }
        remotes.push({ name, type: displayType });
      }
    }
    return remotes;
  } catch (e) {
    return [];
  }
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
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    if (decoded.includes('\uFFFD')) return name;
    return decoded;
  } catch {
    return name;
  }
}

async function getRemotesConfig() {
  try {
    const { stdout } = await runRclone(['config', 'dump'], 15000);
    return JSON.parse(stdout || '{}');
  } catch (e) {
    return {};
  }
}

module.exports = {
  runRclone,
  getRcloneEnv,
  sanitizeRelPath,
  listUserRemotes,
  getRemotesConfig,
  getMimeType,
  decodeFilename,
  getRcloneConfigPath: () => rcloneConfigPath
};
