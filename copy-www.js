const fs = require('fs');
const path = require('path');

const WWW_DIR = path.join(__dirname, 'www');

// Ensure www exists
if (fs.existsSync(WWW_DIR)) {
  fs.rmSync(WWW_DIR, { recursive: true, force: true });
}
fs.mkdirSync(WWW_DIR, { recursive: true });

const filesToCopy = [
  'index.html',
  'admin.html',
  'download.html',
  'pbp-catalog.js',
  'manifest.json',
  'sw.js',
  '_headers'
];

filesToCopy.forEach(file => {
  const src = path.join(__dirname, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(WWW_DIR, file));
  }
});

// Copy js directory
const jsSrc = path.join(__dirname, 'js');
const jsDest = path.join(WWW_DIR, 'js');
if (fs.existsSync(jsSrc)) {
  fs.cpSync(jsSrc, jsDest, { recursive: true });
}

console.log('[BUILD SUCCESS] Production web assets copied to www/ for Android Capacitor packaging.');
