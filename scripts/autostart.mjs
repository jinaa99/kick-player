// macOS: run the server in the background at login via launchd, so there's nothing to start by hand.
//   npm run autostart          install + start
//   npm run autostart:off      stop + remove
//   npm run restart            restart after updating the code
import { writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LABEL = 'com.kickplayer.server';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plistPath = path.join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const logPath = path.join(homedir(), 'Library', 'Logs', 'kick-player.log');
const domain = `gui/${process.getuid()}`;

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function launchctl(...args) {
  try {
    execFileSync('launchctl', args, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function install() {
  mkdirSync(path.dirname(plistPath), { recursive: true });
  // Homebrew paths so the server can find curl / streamlink like it does from a terminal.
  const envPath = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(process.execPath)}</string>
    <string>${esc(path.join(root, 'server.mjs'))}</string>
  </array>
  <key>WorkingDirectory</key><string>${esc(root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${envPath}</string>
    <key>LOG_SEGMENTS</key><string>0</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${esc(logPath)}</string>
  <key>StandardErrorPath</key><string>${esc(logPath)}</string>
</dict>
</plist>
`;
  launchctl('bootout', `${domain}/${LABEL}`);
  writeFileSync(plistPath, plist);
  if (!launchctl('bootstrap', domain, plistPath)) {
    console.error('launchctl bootstrap амжилтгүй. Лог:', logPath);
    process.exit(1);
  }
  console.log(`✔ Автоматаар асдаг боллоо. Mac асах бүрт ард ажиллана.
  Нээх:   http://localhost:8080
  Лог:    ${logPath}
  Унтраах: npm run autostart:off`);
}

function uninstall() {
  launchctl('bootout', `${domain}/${LABEL}`);
  if (existsSync(plistPath)) rmSync(plistPath);
  console.log('✔ Автоматаар асахыг унтраалаа.');
}

function restart() {
  if (!launchctl('kickstart', '-k', `${domain}/${LABEL}`)) {
    console.error('Автоматаар асах тохиргоо алга. Эхлээд: npm run autostart');
    process.exit(1);
  }
  console.log('✔ Серверийг дахин эхлүүллээ.');
}

if (process.platform !== 'darwin') {
  console.error('Энэ скрипт зөвхөн macOS дээр ажиллана.');
  process.exit(1);
}
({ install, uninstall, restart })[process.argv[2] || 'install']();
