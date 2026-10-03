const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Nothing in the renderer may call terminal.clearTextureAtlas().
//
// addon-webgl shares one glyph atlas between every terminal with the same
// font, theme and DPI — every session, here. clearTextureAtlas() empties that
// shared texture but rebuilds only the terminal it was called on, so every
// other session draws from an empty atlas and shows blank text until something
// rebuilds it. On 2026-10-01 a diagnostics "repair" called it about once a
// second and blanked every session the user switched to.
//
// The upstream logic is pinned too: if addon-webgl stops sharing atlases, or
// starts rebuilding every owner on a clear, this test should fail so the ban
// can be revisited rather than outliving its reason.

const PUBLIC = path.join(__dirname, '..', 'public');
const WEBGL = path.join(__dirname, '..', 'node_modules', '@xterm', 'addon-webgl', 'lib', 'addon-webgl.js');

test('no renderer code calls clearTextureAtlas()', () => {
  const offenders = [];
  for (const name of fs.readdirSync(PUBLIC)) {
    if (!name.endsWith('.js') || name.includes('bundle')) continue;
    const lines = fs.readFileSync(path.join(PUBLIC, name), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const code = line.trim().startsWith('//') || line.trim().startsWith('*') ? '' : line;
      if (/clearTextureAtlas\s*\(/.test(code)) offenders.push(`${name}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], 'clearTextureAtlas() blanks every other session — see this file');
});

test('addon-webgl still shares one atlas between terminals with equal config', () => {
  const src = fs.readFileSync(WEBGL, 'utf8');
  assert.match(src, /acquireTextureAtlas=function/, 'the shared-atlas cache is still there');
  assert.match(src, /ownedBy/, 'atlases still track the terminals that share them');
});

test('addon-webgl clearTextureAtlas still rebuilds only its own terminal', () => {
  const src = fs.readFileSync(WEBGL, 'utf8');
  const m = src.match(/clearTextureAtlas\(\)\{([^}]*)\}/);
  assert.ok(m, 'clearTextureAtlas is still defined in the WebGL renderer');
  assert.match(m[1], /clearTexture\(\)/, 'it clears the shared texture');
  assert.match(m[1], /_clearModel\(/, '...and only this renderer\'s model');
});
