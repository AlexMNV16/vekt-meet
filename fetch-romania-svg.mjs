#!/usr/bin/env node
// =============================================================
// tools/fetch-romania-svg.mjs
//
// Converts a Romania counties GeoJSON file into <g class="county">
// blocks ready to paste into public/index.html (replacing the
// schematic placeholder grid).
//
// Usage:
//   node tools/fetch-romania-svg.mjs <path-to-judete.geojson>
//
// Recommended public sources for Romanian county (judet) GeoJSON:
//   - https://github.com/codeforromania/judete-romania
//   - https://github.com/octav/romania-geojson
//   - GADM: https://gadm.org/  (level 1 = judete)
//
// The GeoJSON must be FeatureCollection with each feature having:
//   properties.mnemonic  (e.g. "CJ", "B")  OR  properties.name / properties.NAME_1
// (the script normalises by name match against the canonical list).
//
// Output:
//   - Writes new SVG block to:  public/romania-counties.svg.html
//   - Optionally patches public/index.html if --patch passed
// =============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// Canonical 42-unit name -> id
const NAME_TO_ID = {
  'alba':'AB','arad':'AR','arges':'AG','argeș':'AG',
  'bacau':'BC','bacău':'BC','bihor':'BH',
  'bistrita-nasaud':'BN','bistrița-năsăud':'BN','bistrita nasaud':'BN',
  'botosani':'BT','botoșani':'BT','brasov':'BV','brașov':'BV',
  'braila':'BR','brăila':'BR','bucuresti':'B','bucurești':'B','bucharest':'B',
  'buzau':'BZ','buzău':'BZ','caras-severin':'CS','caraș-severin':'CS','caras severin':'CS',
  'calarasi':'CL','călărași':'CL','cluj':'CJ','constanta':'CT','constanța':'CT',
  'covasna':'CV','dambovita':'DB','dâmbovița':'DB','dolj':'DJ',
  'galati':'GL','galați':'GL','giurgiu':'GR','gorj':'GJ','harghita':'HR',
  'hunedoara':'HD','ialomita':'IL','ialomița':'IL','iasi':'IS','iași':'IS',
  'ilfov':'IF','maramures':'MM','maramureș':'MM','mehedinti':'MH','mehedinți':'MH',
  'mures':'MS','mureș':'MS','neamt':'NT','neamț':'NT','olt':'OT',
  'prahova':'PH','salaj':'SJ','sălaj':'SJ','satu mare':'SM','sibiu':'SB',
  'suceava':'SV','teleorman':'TR','timis':'TM','timiș':'TM',
  'tulcea':'TL','vaslui':'VS','valcea':'VL','vâlcea':'VL','vrancea':'VN',
};

const ID_TO_NAME = {
  AB:'Alba', AR:'Arad', AG:'Argeș', BC:'Bacău', BH:'Bihor',
  BN:'Bistrița-Năsăud', BT:'Botoșani', BV:'Brașov', BR:'Brăila',
  B:'București', BZ:'Buzău', CS:'Caraș-Severin', CL:'Călărași',
  CJ:'Cluj', CT:'Constanța', CV:'Covasna', DB:'Dâmbovița',
  DJ:'Dolj', GL:'Galați', GR:'Giurgiu', GJ:'Gorj', HR:'Harghita',
  HD:'Hunedoara', IL:'Ialomița', IS:'Iași', IF:'Ilfov',
  MM:'Maramureș', MH:'Mehedinți', MS:'Mureș', NT:'Neamț',
  OT:'Olt', PH:'Prahova', SJ:'Sălaj', SM:'Satu Mare', SB:'Sibiu',
  SV:'Suceava', TR:'Teleorman', TM:'Timiș', TL:'Tulcea',
  VS:'Vaslui', VL:'Vâlcea', VN:'Vrancea',
};

// Romania bounding box (rough): lng [20.26, 29.71], lat [43.62, 48.27]
// We project to viewBox 760x600 with margin.
const VIEW_W = 760;
const VIEW_H = 600;
const MARGIN = 20;

function normalise(name) {
  return String(name || '').toLowerCase().trim()
    .replace(/^județul\s+/i, '')
    .replace(/^judetul\s+/i, '');
}

function resolveId(props) {
  const candidates = [
    props.mnemonic, props.MNEMONIC, props.id, props.ID, props.code,
    props.name, props.NAME, props.NAME_1, props.judet, props.JUDET,
    props.county, props.COUNTY,
  ].filter(Boolean);
  for (const c of candidates) {
    const v = String(c).toUpperCase().trim();
    if (ID_TO_NAME[v]) return v;
    const id = NAME_TO_ID[normalise(c)];
    if (id) return id;
  }
  return null;
}

// Project (lng, lat) -> (x, y) in viewBox using equirectangular.
function makeProjector(features) {
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const f of features) {
    walkCoords(f.geometry, ([lng, lat]) => {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    });
  }
  const w = VIEW_W - MARGIN * 2;
  const h = VIEW_H - MARGIN * 2;
  const sx = w / (maxLng - minLng);
  const sy = h / (maxLat - minLat);
  // Equirectangular distortion correction: scale lat by cos(midLat)
  const midLat = (minLat + maxLat) / 2;
  const aspect = Math.cos(midLat * Math.PI / 180);
  const s = Math.min(sx * aspect, sy);
  const offsetX = MARGIN + (w - (maxLng - minLng) * s / aspect) / 2;
  const offsetY = MARGIN + (h - (maxLat - minLat) * s) / 2;
  return ([lng, lat]) => [
    +(offsetX + (lng - minLng) * s / aspect).toFixed(2),
    +(offsetY + (maxLat - lat) * s).toFixed(2),
  ];
}

function walkCoords(geom, fn) {
  if (!geom) return;
  if (geom.type === 'Polygon') geom.coordinates.forEach(ring => ring.forEach(fn));
  else if (geom.type === 'MultiPolygon') geom.coordinates.forEach(poly => poly.forEach(ring => ring.forEach(fn)));
}

function geomToPath(geom, project) {
  const ringsToD = (rings) => rings.map(ring => {
    return ring.map((pt, i) => {
      const [x, y] = project(pt);
      return (i === 0 ? 'M' : 'L') + x + ',' + y;
    }).join(' ') + ' Z';
  }).join(' ');
  if (geom.type === 'Polygon') return ringsToD(geom.coordinates);
  if (geom.type === 'MultiPolygon') return geom.coordinates.map(rings => ringsToD(rings)).join(' ');
  return '';
}

// Visual centroid = simple bbox center of largest polygon
function geomCentroid(geom, project) {
  let pts = [];
  walkCoords(geom, p => pts.push(p));
  if (!pts.length) return [0, 0];
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const [lng, lat] of pts) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return project([(minLng + maxLng) / 2, (minLat + maxLat) / 2]);
}

// =============================================================
// Main
// =============================================================
const inputArg = process.argv[2];
if (!inputArg) {
  console.error('Usage: node tools/fetch-romania-svg.mjs <path-to-judete.geojson> [--patch]');
  process.exit(1);
}

const raw = fs.readFileSync(path.resolve(inputArg), 'utf8');
const gj  = JSON.parse(raw);
const features = gj.features || [];
if (!features.length) {
  console.error('No features in GeoJSON.');
  process.exit(1);
}

const project = makeProjector(features);

const seen = new Set();
const blocks = [];
for (const f of features) {
  const id = resolveId(f.properties || {});
  if (!id) {
    console.warn('  [skip] cannot resolve id for', f.properties);
    continue;
  }
  if (seen.has(id)) continue;
  seen.add(id);
  const d = geomToPath(f.geometry, project);
  if (!d) continue;
  const [cx, cy] = geomCentroid(f.geometry, project);
  blocks.push(`          <g class="county" data-id="${id}" data-name="${ID_TO_NAME[id]}">
            <path class="hit" d="${d}"/>
            <text class="abbr" x="${cx}" y="${cy - 2}">${id}</text>
            <text class="cnt"  x="${cx}" y="${cy + 12}">0</text>
          </g>`);
}

const missing = Object.keys(ID_TO_NAME).filter(id => !seen.has(id));
if (missing.length) {
  console.warn(`  [warn] ${missing.length} counties not found in GeoJSON: ${missing.join(', ')}`);
}

const svgBlock = blocks.join('\n');
const outPath = path.join(ROOT, 'public', 'romania-counties.svg.html');
fs.writeFileSync(outPath, svgBlock + '\n', 'utf8');
console.log(`Wrote ${blocks.length} counties -> ${outPath}`);

// Optional: patch index.html
if (process.argv.includes('--patch')) {
  const indexPath = path.join(ROOT, 'public', 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');
  const startMarker = '<!-- ROW 0 (north tier) -->';
  const endMarker   = '</svg>';
  const startIdx = html.indexOf(startMarker);
  const endIdx   = html.indexOf(endMarker, startIdx);
  if (startIdx === -1 || endIdx === -1) {
    console.error('Could not locate SVG markers in index.html. Skipping patch.');
    process.exit(2);
  }
  const before = html.slice(0, startIdx);
  const after  = html.slice(endIdx);
  html = before + '<!-- Generated from GeoJSON -->\n' + svgBlock + '\n        ' + after;
  fs.writeFileSync(indexPath, html, 'utf8');
  console.log(`Patched ${indexPath}`);
}
