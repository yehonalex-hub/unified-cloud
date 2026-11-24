const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { addOneDriveAccountWithToken } = require('./connectors/onedrive');
const { rebuildUnion } = require('./connectors/union-manager');

console.log('========================================================');
console.log('   חיבור Microsoft OneDrive ב-1-קליק לענן המאוחד');
console.log('========================================================');
console.log('פותח כעת את דפדפן האינטרנט שלך להתחברות למיקרוסופט...');
console.log('אנא בחר את החשבון שלך ואשר את הגישה בחלון שנפתח.\n');

const child = spawn('rclone', ['authorize', 'onedrive'], { shell: true });
let output = '';

child.stdout.on('data', d => {
  const s = d.toString();
  output += s;
  process.stdout.write(s);
});

child.stderr.on('data', d => {
  const s = d.toString();
  output += s;
  process.stderr.write(s);
});

child.on('close', async (code) => {
  if (code !== 0) {
    console.error('\n[שגיאה] ההתחברות בוטלה או נכשלה.');
    process.exit(1);
  }

  const match = output.match(/--->\s*(\{[\s\S]*?\})\s*<---End paste/) || output.match(/(\{"access_token"[\s\S]*?\})/);
  if (!match) {
    console.error('\n[שגיאה] לא נמצא טוקן בפלט של rclone.');
    process.exit(1);
  }

  const token = match[1].trim();
  console.log('\nמגדיר את חשבון ה-OneDrive ב-rclone ובבריכת הענן המאוחד...');

  try {
    const res = await addOneDriveAccountWithToken(token);
    await rebuildUnion();
    console.log(`\n========================================================`);
    console.log(`  [הצלחה!] החשבון "${res.name}" חובר בהצלחה לענן!`);
    console.log(`========================================================\n`);

    // Auto-export base64 to clipboard for Render
    const confPath = path.join(process.env.APPDATA, 'rclone', 'rclone.conf');
    if (fs.existsSync(confPath)) {
      const b64 = fs.readFileSync(confPath).toString('base64');
      try {
        const psCmd = `Set-Clipboard -Value @"\n${b64}\n"@`;
        fs.writeFileSync(path.join(__dirname, '.temp-clip.ps1'), psCmd, 'utf8');
        execSync(`powershell.exe -ExecutionPolicy Bypass -File .temp-clip.ps1`);
        try { fs.unlinkSync(path.join(__dirname, '.temp-clip.ps1')); } catch (_) {}
        console.log('>>> ההגדרות המעודכנות הועתקו ללוח (Clipboard) שלך! <<<');
        console.log('כל מה שנותר: להדביק (Ctrl+V) את הערך ב-Render תחת:');
        console.log('Environment Variables -> RCLONE_CONFIG_BASE64');
        console.log('וה-OneDrive מחובר לענן שלך 24/7!\n');
      } catch (clipErr) {
        console.log('קובץ ההגדרות עודכן ב:', confPath);
      }
    }
  } catch (err) {
    console.error('\n[שגיאה בהגדרה]', err.message);
  }
});
