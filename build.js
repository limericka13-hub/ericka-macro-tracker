import fs from 'fs';
import path from 'path';

const filesToCopy = [
  'index.html',
  'styles.css',
  'config.js',
  'app.js',
  'sw.js',
  'manifest.json',
  'icon.svg'
];

const targetDir = path.resolve('public');

if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

for (const file of filesToCopy) {
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, path.join(targetDir, file));
  }
}

console.log('Build completed: Public directory prepared successfully.');
