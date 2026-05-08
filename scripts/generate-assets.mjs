import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(rootDir, 'assets');
const webPublicDir = path.join(rootDir, 'apps', 'web', 'public');
const webAssetsDir = path.join(webPublicDir, 'assets');
const generatedAssetsDir = path.join(sourceDir, 'generated');

const mascotSource = path.join(sourceDir, 'logo_mascot.png');
const fullHorizontalSource = path.join(sourceDir, 'logo_full_h.png');

const faviconSizes = [16, 32, 48, 64, 128, 256];

async function renderPng(input, output, options) {
  const image = sharp(input).resize({
    fit: 'contain',
    background: { r: 0, g: 0, b: 0, alpha: 0 },
    ...options,
  }).png();
  await image.toFile(output);
}

async function renderPngBuffer(input, size) {
  return sharp(input)
    .resize({
      width: size,
      height: size,
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
}

function buildIco(entries) {
  const headerSize = 6;
  const entrySize = 16;
  const directorySize = headerSize + entries.length * entrySize;
  const totalSize = directorySize + entries.reduce((sum, entry) => sum + entry.buffer.length, 0);
  const ico = Buffer.alloc(totalSize);

  ico.writeUInt16LE(0, 0);
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(entries.length, 4);

  let imageOffset = directorySize;
  for (const [index, entry] of entries.entries()) {
    const offset = headerSize + index * entrySize;
    ico.writeUInt8(entry.size >= 256 ? 0 : entry.size, offset);
    ico.writeUInt8(entry.size >= 256 ? 0 : entry.size, offset + 1);
    ico.writeUInt8(0, offset + 2);
    ico.writeUInt8(0, offset + 3);
    ico.writeUInt16LE(1, offset + 4);
    ico.writeUInt16LE(32, offset + 6);
    ico.writeUInt32LE(entry.buffer.length, offset + 8);
    ico.writeUInt32LE(imageOffset, offset + 12);
    entry.buffer.copy(ico, imageOffset);
    imageOffset += entry.buffer.length;
  }

  return ico;
}

async function main() {
  await mkdir(webAssetsDir, { recursive: true });
  await mkdir(generatedAssetsDir, { recursive: true });

  await renderPng(mascotSource, path.join(webAssetsDir, 'logo_mascot_64.png'), { width: 64, height: 64 });
  await renderPng(mascotSource, path.join(webAssetsDir, 'logo_mascot_128.png'), { width: 128, height: 128 });
  await renderPng(mascotSource, path.join(webPublicDir, 'apple-touch-icon.png'), { width: 180, height: 180 });
  await renderPng(fullHorizontalSource, path.join(generatedAssetsDir, 'logo_full_h_readme.png'), {
    width: 720,
    withoutEnlargement: true,
  });

  const faviconEntries = await Promise.all(faviconSizes.map(async (size) => ({
    size,
    buffer: await renderPngBuffer(mascotSource, size),
  })));
  await writeFile(path.join(webPublicDir, 'favicon.ico'), buildIco(faviconEntries));

  console.log('Generated favicon and logo assets.');
}

await main();
