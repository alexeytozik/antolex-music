# ANTOLEX Music brand assets

The mark combines a geometric `A` with a six-bar waveform. It is designed to stay recognizable at favicon size and to fit inside Android and iOS icon masks.

## Palette

| Use | Color |
| --- | --- |
| Primary background | `#07100E` |
| Elevated dark surface | `#0C1B17` |
| Mint highlight | `#71FFD2` |
| Mint primary | `#54F5C5` |
| Mint deep | `#18CFA8` |
| Primary text | `#F4FBF8` |

Do not place the full-color mark on a similarly bright green surface. Use `icon-monochrome.svg` where only one foreground color is supported.

## Files

- `logo-mark.svg`: rounded full-color brand tile.
- `logo-wordmark.svg`: horizontal mark with the ANTOLEX Music name.
- `favicon.svg`: small full-color browser icon.
- `icon-maskable.svg` and `icon-maskable-512.png`: artwork kept inside the maskable safe area.
- `icon-monochrome.svg`: one-color transparent mark.
- `icon-192.png`, `icon-512.png`, and `icon-1024.png`: general application icons.
- `apple-touch-icon.png`: 180 px iOS home-screen icon.
- `cover-fallback.svg`: neutral artwork for tracks without embedded covers.

## Font

Manrope is the interface and wordmark typeface. The web build imports it from `@fontsource-variable/manrope`, bundles the WOFF2 files into its own static assets, and does not call a third-party font CDN at runtime. Inter, the system UI font, and Segoe UI remain the fallback stack; `font-display: swap` keeps the authentication screen usable while the local font loads.
