# Brand assets

The logo is drawn as **inline SVG** by `src/components/logo.tsx`, using the path
data in `src/components/logo-paths.ts`. That file is generated from
`source/astraeya-adaptive-*.svg`. The neutral parts of the logo use
`currentColor` (`--text-primary`), so they follow the app's light and dark theme.
The blue parts use the fixed brand colour `--brand` (`#1E6BFF`), not the accent
preference.

## Source artwork (`source/`)

| File | Use |
| --- | --- |
| `astraeya-adaptive-with-name-horizontal.svg` | Main logo: navbar, sidebar, login, register, footer |
| `astraeya-adaptive-icon-only.svg` | The mark alone, where only a square fits |
| `astraeya-adaptive-with-name-stacked.svg` | Spare, not currently used on the web |
| `astraeya-dark-astraeya-*.svg` | White and blue on black: app icons, favicons, mobile splash |

## Generated files

| File | Used by | Made from |
| --- | --- | --- |
| `icon.svg` | Browser tab (modern browsers) | Adaptive icon; follows the OS colour scheme |
| `favicon.ico` | Browser tab fallback | Dark icon on black, 16/32/48 |
| `apple-touch-icon.png` | iOS home screen | Dark icon on black, 180×180 |
| `icon-192.png`, `icon-512.png` | Web app manifest | Dark icon on black |
| `icon-maskable-512.png` | Manifest, Android adaptive shapes | Dark icon on black, extra padding for the safe zone |

`favicon.ico` and `apple-touch-icon.png` are **also served from the site root**,
because browsers request `/favicon.ico` unconditionally and iOS requests
`/apple-touch-icon.png`, both ignoring the tags in `layout.tsx` entirely. The
copies in `public/` and `public/brand/` must match.

## Components

- `AstraeyaLockupInline` — the horizontal logo. `height` sets the whole lockup.
- `AstraeyaLockup` — the horizontal logo with the `Think · Decide · Grow`
  strapline beneath. The strapline drops out below 36px.
- `AstraeyaIcon` — the mark alone.
- `AstraeyaWordmark` — the name as text: "Astra" in the text colour, "eya" in
  brand blue. For places the name appears as type rather than as the logo.
