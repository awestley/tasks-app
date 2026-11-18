# Clean glass app icons

How the Tasks and Notebook app icons are made, written so the next app gets an icon from the same family by writing one spec file. `glass-icon.mjs` and this file are identical in every repo that uses them. To start a new app, copy both into its `design/app-icon/` folder.

## What one spec produces

`node design/app-icon/glass-icon.mjs design/app-icon/icon.spec.json` writes:

| Output | Used by |
|---|---|
| `AppIcon.icon/` | Xcode 26 and later. Icon Composer bundle: the system renders Liquid Glass and the Default, Dark, Clear and Tinted appearances from it. |
| `AppIcon-light.svg`, `AppIcon-dark.svg` | Flattened glass render on the macOS grid, for anything that can't read a `.icon`: web, Android, `iconutil`, older Xcode. |
| `favicon.svg` | Browser tab. Squircle crop holding both appearances, switched by `prefers-color-scheme`. |
| `png/AppIcon-{light,dark}.png` | 1024 render with the macOS grid margin and shadow (Mac icon slots, desktop PWA). |
| `png/AppIcon-{light,dark}-tile.png` | 1024 full bleed and opaque (iOS slots, `apple-touch-icon`, maskable web icons). |
| everything under `exports` | Copies and resized PNGs written straight into the app's asset catalog and web folder. |

PNGs and sized exports need `sharp` (`npm i -D sharp`). Without it, the bundle and SVGs are still written.

## Look

Apple's iOS 26 icons, built from Clean. A white surface (black in dark mode) with one or two solid pieces of blue glass on it, and a mark on the front piece. Pieces are simple, chunky objects, never thin line icons; the glass reads through overlap, an edge highlight and a coloured shadow, not through decoration.

- One glass object is enough (Tasks). Two give depth (Notebook); never more than two.
- The back piece is the same blue as the front, as thinner glass. It is never grey or near-black: grey glass reads as dirt on white.
- The mark is the one detail: a check, lines of text. No letters, no product name, no emoji, no second hue.

## Colour

Each part of the icon takes one colour per appearance. Everything except the blue is a Clean token, and flips the way Clean's dark theme does.

| Part | Light | Dark |
|---|---|---|
| Ground | `bg-surface` `#ffffff` at the top to `bg-canvas` `#f1f1f2` | `#1c1c1f` at the top to `bg-surface` `#0a0a0b` |
| Front glass | icon blue `#0a84ff` to `#0062e0` | `#2b95ff` to `#0a6cf0` |
| Back glass | the same blue, at 0.72 opacity | the same, at 0.72 |
| Mark | `on-accent` `#ffffff` | `on-accent` `#0a0a0b` |
| Body rim | `border` hairline, 10% near-black | 14% white |

**Icon blue is the one departure from Clean.** Clean's `accent` (`#2563eb`, hue 221) leans violet and reads purple at icon size. Icons use a true blue at hue 211 instead, the family of the original Notebook icon's `#006FEA` and Apple's system blue. Never mix white into the blue to lighten it: it turns periwinkle. Shade it between its two stops instead.

A spec can override a colour (`"tokens": { "light": { "front": ["#…", "#…"] } }`), but only to follow a change in Clean. If an app needs to be told apart, change its shapes, not its colour.

## Grid

Geometry is written in a 24-unit grid, the coordinates of Clean's `Icon` set, so shapes can borrow from UI icons.

- Canvas 1024 x 1024. The grid maps to a 624 px live area at (200, 200): 1 unit = 26 px.
- macOS body: an 824 px squircle centred in the canvas, continuous corners (superellipse, n = 3.2, 283 px corner span), shadow in the margin. iOS tiles are the same art cropped to the body, full bleed.
- Glass pieces are filled shapes, corner radius 3 to 4.75 units (about a quarter of the piece's short side, like Clean's `radius-lg` on a card).
- Marks are strokes of 1.75 to 2.75 units with round caps and joins, or small fills.
- Keep the combined shape's visual centre on (12, 12). A single piece is about 18 units square (Tasks); a pair spans about 21 units with the back piece up and right of the front (Notebook).
- Android's maskable crop keeps a circle 80% across. Check that the farthest corner stays within it (Notebook's tilted back sheet reaches about 400 px from centre, so its maskable tiles use an inset of 120).

## Glass

The `.icon` bundle declares the glass and the system draws it. The settings are fixed for the family:

- One group per depth, `Front` and `Back`. Lighting `individual`, specular on, shadow `layer-color` (chromatic) at 0.5, translucency 0.4 on the front and 0.2 on the back.
- Glass pieces are `glass: true`; marks are `glass: false` and sit in the front group, so they move and catch light with the piece they're on.
- Ground: a linear gradient between the two ground colours. Each layer is a 1024 SVG with its shape in place, recoloured per appearance by `fill-specializations`; blue parts get a two-stop `linear-gradient`.

The flattened SVGs imitate the system render so every other surface matches. For each glass piece, back to front: a blurred shadow in a darkened version of its own colour; inside the piece, everything below it blurred (frost), then the blue tint at 0.97 (front) or 0.72 (back), then a faint top sheen. On top of that go a bright highlight along the top-left edge (the shape minus itself nudged down and right), a fainter catch along the bottom-right edge, and a white hairline at 30%. The strengths are in `GLASS` in the generator. Change them there, for every app at once, never per app.

Clean's "no gradients, barely there shadows" rule is for interface surfaces. The icon is the one exception, and only for the effects above.

## The spec

```json
{
  "name": "Notebook",
  "layers": [
    { "name": "under", "part": "back", "rect": { "x": 7.5, "y": 0.5, "w": 14.5, "h": 19, "r": 3 }, "rotate": 8, "rotateAbout": [14.75, 10] },
    { "name": "page", "part": "front", "fill": "M6 4H13.5L18 8.5V20.5A3 3 0 0 1 15 23.5H6A3 3 0 0 1 3 20.5V7A3 3 0 0 1 6 4Z" },
    { "name": "fold", "part": "mark", "opacity": 0.45, "fill": "M13.5 4v3a1.5 1.5 0 0 0 1.5 1.5h3Z" },
    { "name": "title", "part": "mark", "stroke": "M6.5 12.5h5", "strokeWidth": 2.25 },
    { "name": "lines", "part": "mark", "opacity": 0.75, "stroke": "M6.5 16.25h7.5M6.5 19.75h5.5", "strokeWidth": 1.75 }
  ],
  "exports": [
    { "from": "AppIcon-light.svg", "to": "../../macos/Resources/AppIcon.svg" }
  ]
}
```

- `layers` run back to front. Each has a `name` (also its asset file name), a `part` (`back`, `front` or `mark`), and one shape: `rect` (`x`, `y`, `w`, `h`, `r`), `fill` (path data) or `stroke` (path data, with `strokeWidth`). `rotate` with `rotateAbout` and `opacity` are optional. All values are grid units.
- `exports` copy an output (`from`, relative to the output folder) to a path in the app (`to`, relative to the spec). Add `size` to resize a PNG. Small sizes are downscaled from the 1024 render, never rendered small, because blur radii collapse at low resolution.

## Adding an icon to a new app

1. Copy `glass-icon.mjs` and this file into `design/app-icon/`, and add `sharp` as a dev dependency.
2. Sketch the app's object as one or two pieces plus a mark, write `icon.spec.json`, and run the generator. Put `png/AppIcon-light.png` and `AppIcon-dark.png` beside the Tasks and Notebook ones at 1024 and at 32 px. They should look like one set.
3. Apple, Xcode 26: add `design/app-icon/AppIcon.icon` to the app target. In XcodeGen, list it under the target's `sources`. With `ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon`, Xcode uses the bundle in place of the `AppIcon` image set and derives icons for older OS versions from it.
4. Apple, older Xcode or as a fallback: export into the `.appiconset`. The iOS 1024 slot gets `AppIcon-light-tile.png`, a second iOS slot with `"appearances": [{ "appearance": "luminosity", "value": "dark" }]` gets `AppIcon-dark-tile.png`, and each mac slot gets `AppIcon-light.png` at its size: 16, 32, 128, 256 and 512 at 1x and 2x.
5. Web: export `favicon.svg` to the public folder, plus full-bleed tiles at 180 (`apple-touch-icon`), 192 and 512 (manifest).
6. To check the system render, open `AppIcon.icon` in Icon Composer. The Default and Dark previews should match `png/`. If you adjust anything there, port it back into the spec or the generator, or the next run overwrites it.

## Current icons

| App | Pieces | Mark | Where its icon is installed |
|---|---|---|---|
| Tasks | one blue glass checkbox | white check | `AppIcon.icon` is in both app targets in `apple/project.yml`, with no image set; `design/app-icon` exports to `web/public` |
| Notebook | blue glass page over a tilted, thinner blue sheet | folded corner, a title and two lines | `design/app-icon` exports to `macos/Resources/AppIcon.svg` and `AppIcon-dark.svg`; `npm run generate-favicons` and `node scripts/build-ios-icon.js` take everything else from those |
