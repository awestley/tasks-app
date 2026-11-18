#!/usr/bin/env node
/**
 * Clean glass app icons.
 *
 * One spec file in, every icon artefact out:
 *
 *   AppIcon.icon/            Icon Composer bundle. Xcode 26 reads it and the system renders
 *                            Liquid Glass and the Default, Dark, Clear and Tinted appearances.
 *   AppIcon-light.svg        Flattened glass render on the macOS grid (824 body in 1024)
 *   AppIcon-dark.svg         Same, dark appearance
 *   favicon.svg              Squircle crop that follows prefers-color-scheme
 *   png/                     1024 renders of each appearance, grid and full-bleed tile
 *   ...and every path listed under "exports" in the spec (asset catalogs, web icons)
 *
 * Usage:   node glass-icon.mjs <icon.spec.json> [outDir]
 * PNGs need `sharp` (npm i -D sharp). Without it, only the SVGs and the bundle are written.
 *
 * The method and the rules are in APP-ICON.md next to this file. Change the spec, not
 * this script; change this script only to change every app's icon at once.
 */

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Fixed rules (APP-ICON.md, "Grid")

const BODY = { x: 100, size: 824, radius: 283, n: 3.2 }; // macOS grid, continuous corners
const GRID = { units: 24, unit: 26, origin: 200 }; // 24-unit grid -> 624 px live area at (200, 200)

// BLUE: the one departure from Clean's tokens. Clean's accent (#2563eb, hue 221) leans
// violet and reads purple at icon size, so icons use a true blue at hue 211 instead
// (the family of the original Notebook icon's #006FEA). Everything else is a Clean token.
//
// Clean tokens by icon part, per appearance. Each part is one Clean token in its light
// and dark theme, so the icon flips exactly the way the interface does. A part given as
// [top, bottom] is shaded between two Clean values; otherwise it is lightened slightly at
// the top. Blue stays inside Clean's accents: never mix white into it (it goes periwinkle).
export const TOKENS = {
    light: {
        groundTop: '#ffffff', // bg-surface
        ground: '#f1f1f2', // bg-canvas
        back: ['#0a84ff', '#0062e0'], // icon blue, as thinner glass behind the front piece
        front: ['#0a84ff', '#0062e0'], // icon blue (see BLUE above)
        mark: '#ffffff', // on-accent
        rim: ['#0f0f10', 0.10] // border, as a hairline on the body
    },
    dark: {
        groundTop: '#1c1c1f',
        ground: '#0a0a0b', // bg-surface
        back: ['#2b95ff', '#0a6cf0'], // icon blue, as thinner glass behind the front piece
        front: ['#2b95ff', '#0a6cf0'], // icon blue, a touch lighter on black
        mark: '#0a0a0b', // on-accent
        rim: ['#ffffff', 0.14]
    }
};

// How the flattened render imitates Liquid Glass. Same for every app.
const GLASS = {
    light: { translucency: { back: 0.72, front: 0.97 }, frost: 22, sheen: 0.07, highlight: 0.95, catch: 0.45, edge: 0.30, shadow: 0.30, iconShadow: 0.20 },
    dark: { translucency: { back: 0.72, front: 0.97 }, frost: 22, sheen: 0.08, highlight: 0.90, catch: 0.35, edge: 0.22, shadow: 0.55, iconShadow: 0.50 }
};

// ---------------------------------------------------------------------------
// Colour

function hex(c) {
    const h = c.replace('#', '');
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
function mix(a, b, t) {
    const A = hex(a), B = hex(b);
    return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('');
}
/** A part's colour as [top, bottom] for the glass tint. */
function pair(c) {
    return Array.isArray(c) ? c : [mix(c, '#ffffff', 0.2), c];
}
/** The flat colour of a part: marks, layer assets, single-colour contexts. */
function solid(c) {
    return Array.isArray(c) ? c[0] : c;
}
function srgb(c) {
    const [r, g, b] = hex(c).map((v) => (v / 255).toFixed(5));
    return `srgb:${r},${g},${b},1.00000`;
}

// ---------------------------------------------------------------------------
// Geometry. Specs are written in grid units; 1 unit = 26 px.

function squirclePath({ x, size, radius, n }) {
    const pts = [];
    const corner = (cx, cy, from, to) => {
        for (let i = 0; i <= 24; i++) {
            const t = ((from + (to - from) * (i / 24)) * Math.PI) / 180;
            const c = Math.cos(t), s = Math.sin(t);
            pts.push([cx + Math.sign(c) * Math.pow(Math.abs(c), 2 / n) * radius, cy - Math.sign(s) * Math.pow(Math.abs(s), 2 / n) * radius]);
        }
    };
    const a = x + radius, b = x + size - radius;
    corner(b, a, 0, 90);
    corner(a, a, 90, 180);
    corner(a, b, 180, 270);
    corner(b, b, 270, 360);
    return 'M' + pts.map(([px, py]) => `${px.toFixed(1)} ${py.toFixed(1)}`).join('L') + 'Z';
}

/** A rounded rectangle as path data, in grid units. */
function rectPath({ x, y, w, h, r }) {
    return `M${x + r} ${y}H${x + w - r}a${r} ${r} 0 0 1 ${r} ${r}V${y + h - r}a${r} ${r} 0 0 1 -${r} ${r}H${x + r}a${r} ${r} 0 0 1 -${r} -${r}V${y + r}a${r} ${r} 0 0 1 ${r} -${r}Z`;
}

function transformOf(layer) {
    const base = `translate(${GRID.origin} ${GRID.origin}) scale(${GRID.unit})`;
    if (!layer.rotate) return base;
    const [cx, cy] = layer.rotateAbout;
    return `${base} rotate(${layer.rotate} ${cx} ${cy})`;
}

/** The layer's geometry in 1024 space, painted with `paint`. */
function shape(layer, paint) {
    const d = layer.rect ? rectPath(layer.rect) : (layer.fill ?? layer.stroke);
    const attrs = layer.stroke
        ? `fill="none" stroke="${paint}" stroke-width="${layer.strokeWidth ?? 2}" stroke-linecap="round" stroke-linejoin="round"`
        : `fill="${paint}"`;
    return `<path transform="${transformOf(layer)}" d="${d}" ${attrs}/>`;
}

const isGlass = (l) => l.part !== 'mark';

// ---------------------------------------------------------------------------
// Flattened render: Liquid Glass approximated in plain SVG, so web, Android and
// pre-26 Apple builds show the same icon as the system renders from the bundle.

function renderFlat(spec, appearance, { variant = 'grid', idPrefix = '' } = {}) {
    const tok = { ...TOKENS[appearance], ...(spec.tokens?.[appearance] ?? {}) };
    const g = GLASS[appearance];
    const id = (s) => `${idPrefix}${s}`;
    const layers = spec.layers; // back to front

    const defs = [];
    const scene = [];
    const ground = `<rect width="1024" height="1024" fill="url(#${id('ground')})"/>`;
    scene.push(ground);

    layers.forEach((l, i) => {
        const [top, colour] = pair(tok[l.part]);
        const m = (s) => id(`${s}-${i}`);
        if (!isGlass(l)) {
            scene.push(`<g opacity="${l.opacity ?? 1}">${shape(l, solid(tok[l.part]))}</g>`);
            return;
        }
        defs.push(`
    <mask id="${m('in')}" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024">${shape(l, '#fff')}</mask>
    <mask id="${m('hi')}" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024">${shape(l, '#fff')}<g transform="translate(3 7)">${shape(l, '#000')}</g></mask>
    <mask id="${m('lo')}" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024">${shape(l, '#fff')}<g transform="translate(-2 -5)">${shape(l, '#000')}</g></mask>
    <linearGradient id="${m('tint')}" x1="0" y1="${GRID.origin}" x2="0" y2="${GRID.origin + 624}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${top}"/>
      <stop offset="1" stop-color="${colour}"/>
    </linearGradient>`);
        const below = scene.join('');
        scene.push(`
    <!-- ${l.name}: ${l.part} glass -->
    <g opacity="${g.shadow}" filter="url(#${id('drop')})" transform="translate(0 18)">${shape(l, mix(colour, '#000000', 0.55))}</g>
    <g mask="url(#${m('in')})">
      <g filter="url(#${id('frost')})">${below}</g>
      <rect width="1024" height="1024" fill="url(#${m('tint')})" opacity="${g.translucency[l.part]}"/>
      <rect width="1024" height="1024" fill="url(#${id('sheen')})"/>
    </g>
    <rect width="1024" height="1024" fill="#fff" opacity="${g.highlight}" mask="url(#${m('hi')})"/>
    <rect width="1024" height="1024" fill="#fff" opacity="${g.catch}" mask="url(#${m('lo')})"/>
    ${l.stroke ? '' : `<g opacity="${g.edge}">${shape({ ...l, stroke: l.fill ?? (l.rect ? rectPath(l.rect) : ''), fill: undefined, rect: undefined, strokeWidth: 0.12 }, '#fff')}</g>`}`);
    });

    const body = variant === 'tile'
        ? `<rect id="body" x="0" y="0" width="1024" height="1024"/>`
        : `<path id="body" d="${squirclePath(BODY)}"/>`;
    const viewBox = variant === 'grid' ? 'viewBox="0 0 1024 1024"' : `viewBox="${BODY.x} ${BODY.x} ${BODY.size} ${BODY.size}"`;
    const iconShadow = variant === 'grid'
        ? `\n  <!-- Icon shadow, in the grid margin -->\n  <use xlink:href="#body" transform="translate(0 12)" fill="#000" opacity="${g.iconShadow}" filter="url(#${id('iconDrop')})"/>`
        : '';
    const bodyRim = variant === 'tile'
        ? ''
        : `\n    <use xlink:href="#body" fill="none" stroke="${tok.rim[0]}" stroke-opacity="${tok.rim[1]}" stroke-width="4"/>`;

    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${viewBox} width="1024" height="1024">
  <!--
    ${spec.name} app icon, ${appearance}. Generated by design/app-icon/glass-icon.mjs from
    icon.spec.json: edit the spec and regenerate rather than editing this file.
    Clean tokens: ground ${tok.groundTop} to ${tok.ground}, back ${[].concat(tok.back).join(' to ')}, front ${[].concat(tok.front).join(' to ')}, mark ${tok.mark}.
  -->
  <defs>
    ${body}
    <clipPath id="${id('bodyClip')}"><use xlink:href="#body"/></clipPath>
    <linearGradient id="${id('ground')}" x1="0" y1="${BODY.x}" x2="0" y2="${BODY.x + BODY.size}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${tok.groundTop}"/>
      <stop offset="1" stop-color="${tok.ground}"/>
    </linearGradient>
    <!-- Light falling from above onto the glass -->
    <linearGradient id="${id('sheen')}" x1="0" y1="${GRID.origin}" x2="0" y2="${GRID.origin + 624}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#fff" stop-opacity="${g.sheen}"/>
      <stop offset="0.45" stop-color="#fff" stop-opacity="0.04"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <filter id="${id('frost')}" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="${g.frost}"/></filter>
    <filter id="${id('drop')}" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="24"/></filter>
    <filter id="${id('iconDrop')}" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="16"/></filter>${defs.join('')}
  </defs>${iconShadow}

  <g clip-path="url(#${id('bodyClip')})">
    ${scene.join('\n    ')}${bodyRim}
  </g>
</svg>
`;
}

/** Favicon: the squircle crop, light and dark in one file, switched by the browser's scheme. */
function renderFavicon(spec) {
    const one = (a) => renderFlat(spec, a, { variant: 'squircle', idPrefix: `${a}-` })
        .replace(/^<svg[^>]*>/, '')
        .replace(/<\/svg>\s*$/, '')
        .replace(/id="body"/g, `id="${a}-body"`)
        .replace(/#body"/g, `#${a}-body"`);
    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${BODY.x} ${BODY.x} ${BODY.size} ${BODY.size}" width="1024" height="1024">
  <style>
    .dark { display: none; }
    @media (prefers-color-scheme: dark) { .light { display: none; } .dark { display: inline; } }
  </style>
  <g class="light">${one('light')}</g>
  <g class="dark">${one('dark')}</g>
</svg>
`;
}

// ---------------------------------------------------------------------------
// Icon Composer bundle

function iconJson(spec) {
    const L = { ...TOKENS.light, ...(spec.tokens?.light ?? {}) };
    const D = { ...TOKENS.dark, ...(spec.tokens?.dark ?? {}) };
    const fill = (c) => (Array.isArray(c) ? { 'linear-gradient': c.map(srgb) } : { solid: srgb(c) });
    const fillFor = (part) => [
        { value: fill(L[part]) },
        { appearance: 'dark', value: fill(D[part]) }
    ];
    const layer = (l) => ({
        name: l.name,
        'image-name': `${l.name}.svg`,
        glass: isGlass(l),
        'fill-specializations': fillFor(l.part),
        ...(l.opacity != null ? { opacity: l.opacity } : {})
    });
    // One group per depth, front to back. A mark sits in the group of the glass it is
    // drawn on, so it moves and catches light with that piece.
    const depths = ['front', 'back'];
    const groups = depths
        .map((depth) => ({
            name: depth === 'front' ? 'Front' : 'Back',
            layers: spec.layers.filter((l) => (l.part === 'mark' ? 'front' : l.part) === depth).reverse().map(layer),
            lighting: 'individual',
            specular: true,
            shadow: { kind: 'layer-color', opacity: 0.5 },
            translucency: { enabled: true, value: depth === 'front' ? 0.4 : 0.2 }
        }))
        .filter((group) => group.layers.length > 0);
    return {
        'fill-specializations': [
            { value: { 'linear-gradient': [srgb(L.groundTop), srgb(L.ground)] } },
            { appearance: 'dark', value: { 'linear-gradient': [srgb(D.groundTop), srgb(D.ground)] } }
        ],
        groups,
        'supported-platforms': { squares: 'shared' }
    };
}

function writeBundle(spec, outDir) {
    const dir = path.join(outDir, 'AppIcon.icon');
    const assets = path.join(dir, 'Assets');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(assets, { recursive: true });
    for (const l of spec.layers) {
        // Each layer is a 1024 canvas with the shape in place, drawn in its light colour;
        // the bundle's fills recolour it per appearance.
        fs.writeFileSync(path.join(assets, `${l.name}.svg`), `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <title>${l.name}</title>
  ${shape(l, solid(TOKENS.light[l.part]))}
</svg>
`);
    }
    fs.writeFileSync(path.join(dir, 'icon.json'), JSON.stringify(iconJson(spec), null, 2) + '\n');
}

// ---------------------------------------------------------------------------

async function main() {
    const [specPath, outArg] = process.argv.slice(2);
    if (!specPath) {
        console.error('Usage: node glass-icon.mjs <icon.spec.json> [outDir]');
        process.exit(1);
    }
    const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
    const outDir = outArg ?? path.dirname(specPath);
    fs.mkdirSync(outDir, { recursive: true });

    writeBundle(spec, outDir);
    const svg = {};
    for (const a of ['light', 'dark']) {
        svg[`AppIcon-${a}.svg`] = renderFlat(spec, a, { variant: 'grid' });
        svg[`AppIcon-${a}-tile.svg`] = renderFlat(spec, a, { variant: 'tile' });
        fs.writeFileSync(path.join(outDir, `AppIcon-${a}.svg`), svg[`AppIcon-${a}.svg`]);
    }
    fs.writeFileSync(path.join(outDir, 'favicon.svg'), renderFavicon(spec));

    // Exports put outputs where each platform reads its icon. Paths are relative to the spec.
    const exports = spec.exports ?? [];
    const exportTo = (e) => {
        const to = path.resolve(path.dirname(specPath), e.to);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        return to;
    };
    for (const e of exports.filter((x) => !x.size)) fs.copyFileSync(path.join(outDir, e.from), exportTo(e));

    let sharp;
    try {
        sharp = (await import('sharp')).default;
    } catch {
        console.log('sharp not found: wrote the bundle and SVGs, skipped PNGs and sized exports (npm i -D sharp)');
        return;
    }
    const png = path.join(outDir, 'png');
    fs.mkdirSync(png, { recursive: true });
    for (const a of ['light', 'dark']) {
        await sharp(Buffer.from(svg[`AppIcon-${a}.svg`])).png().toFile(path.join(png, `AppIcon-${a}.png`));
        // Full bleed and opaque: iOS and Android mask it themselves and composite
        // transparency onto black.
        await sharp(Buffer.from(svg[`AppIcon-${a}-tile.svg`]))
            .resize(1024, 1024)
            .flatten({ background: TOKENS[a].ground })
            .png()
            .toFile(path.join(png, `AppIcon-${a}-tile.png`));
    }
    // Sized exports are downscaled from the 1024 render, never rasterised small:
    // librsvg scales blur radii with density, so a 16 px render loses the glass.
    for (const e of exports.filter((x) => x.size)) {
        let image = sharp(path.join(outDir, e.from)).resize(e.size, e.size, { kernel: 'lanczos3' });
        if (e.size <= 64) image = image.sharpen({ sigma: 0.5 });
        await image.png({ compressionLevel: 9 }).toFile(exportTo(e));
    }
    console.log(`Wrote ${spec.name} icon to ${outDir} and ${exports.length} exports`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) await main();

export { renderFlat, renderFavicon, iconJson };
