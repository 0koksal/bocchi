const fs = require('fs');

// 1. index.ts: remove the TEMPORARY fake update block
let s = fs.readFileSync('src/main/index.ts', 'utf8');
const nl = s.includes('\r\n') ? '\r\n' : '\n';
const fakeBlock = [
  '  // TEMPORARY (dev preview): fake update-available so the update dialog can be',
  '  // checked with the new release notes — REMOVE BEFORE RELEASING',
  '  if (is.dev) {',
  '    setTimeout(() => {',
  '      try {',
  "      updaterService.setFakeUpdateInfo('2.0.4')",
  '        mainWindow?.webContents.send("update-available", { version: "2.0.4" })',
  "        console.log('[Updater] DEV: emitted fake update-available')",
  '      } catch {',
  '        // Window gone',
  '      }',
  '    }, 5000)',
  '  },',
  ''
].join(nl);
if (!s.includes(fakeBlock)) { console.log('FAKE BLOCK NOT FOUND'); process.exit(1); }
s = s.replace(fakeBlock, '');
fs.writeFileSync('src/main/index.ts', s);
console.log('fake block removed:', !s.includes('fake update-available'));

// 2. updaterService: remove the setFakeUpdateInfo helper
let u = fs.readFileSync('src/main/services/updaterService.ts', 'utf8');
const setterBlock = [
  '  // TEMPORARY (dev preview): populate update info for the fake update dialog',
  '  setFakeUpdateInfo(version: string): void {',
  '    this.updateInfo = { version }',
  '  },',
  ''
].join(nl);
if (!u.includes(setterBlock)) { console.log('SETTER NOT FOUND'); process.exit(1); }
u = u.replace(setterBlock, '');
fs.writeFileSync('src/main/services/updaterService.ts', u);
console.log('setter removed:', !u.includes('setFakeUpdateInfo'));

// 3. package.json: version 2.0.3 -> 2.0.1
let p = fs.readFileSync('package.json', 'utf8');
p = p.replace('"version": "2.0.3"', '"version": "2.0.1"');
fs.writeFileSync('package.json', p);
console.log('version set to 2.0.1');
