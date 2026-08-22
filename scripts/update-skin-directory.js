/**
 * Script to fetch and update the lol_skins_directory.txt file
 * Supports both .zip and .fantome file extensions
 * 
 * Usage: node scripts/update-skin-directory.js [options]
 * Options:
 *   --owner=<owner>     GitHub repository owner (default: Alban1911)
 *   --repo=<repo>       GitHub repository name (default: LeagueSkins)
 *   --branch=<branch>   GitHub branch (default: main)
 */

const fs = require('fs');
const https = require('https');
const path = require('path');

// Parse command line arguments
const args = process.argv.slice(2);
const options = {
  owner: 'Alban1911',
  repo: 'LeagueSkins',
  branch: 'main'
};

args.forEach(arg => {
  const match = arg.match(/--(\w+)=(.+)/);
  if (match) {
    options[match[1]] = match[2];
  }
});

const API_URL = `https://api.github.com/repos/${options.owner}/${options.repo}/git/trees/${options.branch}?recursive=1`;
const OUTPUT_FILE = path.join(__dirname, 'lol_skins_directory.txt');

console.log('═══════════════════════════════════════════════════════════════');
console.log('           SKIN DIRECTORY UPDATER');
console.log('═══════════════════════════════════════════════════════════════');
console.log(`Repository: ${options.owner}/${options.repo}`);
console.log(`Branch: ${options.branch}`);
console.log(`Output: ${OUTPUT_FILE}`);
console.log('═══════════════════════════════════════════════════════════════\n');

console.log('Fetching repository file tree from GitHub API...');

const requestOptions = {
  headers: {
    'User-Agent': 'Node.js Script',
    'Accept': 'application/vnd.github.v3+json'
  }
};

https.get(API_URL, requestOptions, (res) => {
  let data = '';

  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    try {
      const response = JSON.parse(data);

      if (response.message) {
        console.error('❌ GitHub API Error:', response.message);
        process.exit(1);
      }

      if (!response.tree || !Array.isArray(response.tree)) {
        console.error('❌ Invalid response from GitHub API');
        process.exit(1);
      }

      console.log(`✓ Received ${response.tree.length} file entries from GitHub\n`);

      // Filter for skin files (.zip and .fantome) in the skins/ directory
      const skinFiles = response.tree
        .filter(file => {
          const path = file.path;
          return (
            path.startsWith('skins/') &&
            (path.endsWith('.zip') || path.endsWith('.fantome'))
          );
        })
        .map(file => file.path.replace('skins/', ''));

      // Sort the files for consistent output
      skinFiles.sort();

      // Count different types
      const zipCount = skinFiles.filter(f => f.endsWith('.zip')).length;
      const fantomeCount = skinFiles.filter(f => f.endsWith('.fantome')).length;
      const chromaCount = skinFiles.filter(f => (f.match(/\//g) || []).length === 3).length;
      const regularCount = skinFiles.length - chromaCount;

      console.log('File Statistics:');
      console.log(`  Total skin files: ${skinFiles.length}`);
      console.log(`  - .zip files: ${zipCount}`);
      console.log(`  - .fantome files: ${fantomeCount}`);
      console.log(`  - Regular skins (3 levels): ${regularCount}`);
      console.log(`  - Chromas (4 levels): ${chromaCount}\n`);

      // Write to file
      fs.writeFileSync(OUTPUT_FILE, skinFiles.join('\n'), 'utf8');

      console.log(`✅ Successfully wrote ${skinFiles.length} entries to ${OUTPUT_FILE}\n`);

      // Show sample entries
      console.log('Sample entries:');
      const samples = [
        ...skinFiles.filter(f => (f.match(/\//g) || []).length === 2).slice(0, 3),
        ...skinFiles.filter(f => (f.match(/\//g) || []).length === 3).slice(0, 3)
      ];
      samples.forEach(entry => console.log(`  ${entry}`));

      console.log('\n═══════════════════════════════════════════════════════════════');
      console.log('                        COMPLETE!');
      console.log('═══════════════════════════════════════════════════════════════');

    } catch (error) {
      console.error('❌ Error parsing response:', error.message);
      process.exit(1);
    }
  });

}).on('error', (error) => {
  console.error('❌ Request error:', error.message);
  process.exit(1);
});
