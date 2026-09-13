const fs = require('fs');

// 1. fileImportService: swap the wrongly-replaced variable names
let s = fs.readFileSync('src/main/services/fileImportService.ts', 'utf8');
const sNl = s.includes('\r\n') ? '\r\n' : '\n';
const sLines = s.split(sNl);
if (sLines[283] && sLines[283].includes('findSiblingPreview(zipPath)')) {
  sLines[283] = sLines[283].replace('zipPath', 'wadPath');
  console.log('283 fixed to wadPath');
}
if (sLines[417] && sLines[417].includes('findSiblingPreview(wadPath)')) {
  sLines[417] = sLines[417].replace('wadPath', 'zipPath');
  console.log('417 fixed to zipPath');
}
fs.writeFileSync('src/main/services/fileImportService.ts', sLines.join(sNl));

// 2. webImportService: executeJavaScript needs the userGesture argument
let w = fs.readFileSync('src/main/services/webImportService.ts', 'utf8');
const wNl = w.includes('\r\n') ? '\r\n' : '\n';
const wLines = w.split(wNl);
for (let i = 0; i < wLines.length; i++) {
  if (wLines[i].trim() === ')(' && i > 0 && wLines[i - 1].trim() === ')()`') {
    // insert ', true' before the closing of executeJavaScript's first arg
    wLines[i - 1] = wLines[i - 1].replace(')`', ')`');
    wLines[i] = '              , true' + wNl + '            )(';
    console.log('gesture arg handled at line', i + 1);
    break;
  }
}
fs.writeFileSync('src/main/services/webImportService.ts', wLines.join(wNl));
console.log('done');
