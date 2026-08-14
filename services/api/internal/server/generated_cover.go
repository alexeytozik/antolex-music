package server

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"html"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/gofiber/fiber/v2"

	"github.com/alexeytozik/antolex-music/services/api/internal/models"
)

const generatedCoverAssetVersion = "g1"

type generatedCoverPalette struct {
	backgroundStart string
	backgroundEnd   string
	accent          string
	highlight       string
	text            string
}

var generatedCoverPalettes = [...]generatedCoverPalette{
	{backgroundStart: "#071A15", backgroundEnd: "#123F34", accent: "#22DDB0", highlight: "#82FFE0", text: "#E8FFF8"},
	{backgroundStart: "#07161C", backgroundEnd: "#123A45", accent: "#28D7C4", highlight: "#8CFFF2", text: "#ECFFFC"},
	{backgroundStart: "#101225", backgroundEnd: "#27305B", accent: "#65E7C3", highlight: "#B1FFE8", text: "#F1FFFA"},
	{backgroundStart: "#171020", backgroundEnd: "#492C4A", accent: "#49E5B8", highlight: "#B5FFE9", text: "#FFF7FD"},
	{backgroundStart: "#1E1509", backgroundEnd: "#4B3822", accent: "#5BE2B6", highlight: "#C1FFE9", text: "#FFF9ED"},
	{backgroundStart: "#1C1011", backgroundEnd: "#49302D", accent: "#43DDB2", highlight: "#B3FFE6", text: "#FFF7F5"},
}

func generatedTrackCoverSeed(track models.Track) [sha256.Size]byte {
	parts := []string{
		normalizeGeneratedCoverText(track.Title),
		normalizeGeneratedCoverText(track.Artist),
		normalizeGeneratedCoverText(track.Album),
	}
	return sha256.Sum256([]byte(strings.Join(parts, "\x1f")))
}

func generatedTrackCoverVersion(track models.Track) string {
	seed := generatedTrackCoverSeed(track)
	return generatedCoverAssetVersion + "-" + hex.EncodeToString(seed[:6])
}

func generatedTrackCoverSVG(track models.Track) string {
	seed := generatedTrackCoverSeed(track)
	palette := generatedCoverPalettes[int(seed[0])%len(generatedCoverPalettes)]
	title := generatedCoverText(track.Title, "Untitled Track", 28)
	artist := generatedCoverText(track.Artist, "Unknown Artist", 34)
	album := generatedCoverText(track.Album, "", 30)

	titleSize := 42
	switch runeCount := utf8.RuneCountInString(title); {
	case runeCount > 24:
		titleSize = 30
	case runeCount > 18:
		titleSize = 35
	}

	albumMarkup := ""
	if album != "" {
		albumMarkup = fmt.Sprintf(`<text x="44" y="463" fill="%s" fill-opacity=".64" font-family="Inter, system-ui, sans-serif" font-size="15" font-weight="600" letter-spacing="1.2">%s</text>`, palette.text, html.EscapeString(album))
	}

	return fmt.Sprintf(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" role="img" aria-labelledby="cover-title cover-desc">
  <title id="cover-title">%s — %s</title>
  <desc id="cover-desc">Generated ANTOLEX Music cover for %s by %s</desc>
  <defs>
    <linearGradient id="background" x1="28" y1="16" x2="484" y2="496" gradientUnits="userSpaceOnUse">
      <stop stop-color="%s"/><stop offset="1" stop-color="%s"/>
    </linearGradient>
    <linearGradient id="accent" x1="56" y1="128" x2="456" y2="296" gradientUnits="userSpaceOnUse">
      <stop stop-color="%s"/><stop offset="1" stop-color="%s"/>
    </linearGradient>
    <linearGradient id="text-fade" x1="256" y1="280" x2="256" y2="512" gradientUnits="userSpaceOnUse">
      <stop stop-color="%s" stop-opacity="0"/><stop offset=".38" stop-color="%s" stop-opacity=".88"/><stop offset="1" stop-color="%s"/>
    </linearGradient>
    <filter id="soft-glow" x="-30%%" y="-30%%" width="160%%" height="160%%"><feGaussianBlur stdDeviation="18"/></filter>
  </defs>
  <rect width="512" height="512" rx="28" fill="url(#background)"/>
  %s
  %s
  <rect y="270" width="512" height="242" fill="url(#text-fade)"/>
  <g font-family="Inter, system-ui, sans-serif">
    <text x="44" y="62" fill="%s" font-size="17" font-weight="800" letter-spacing="4">ANTOLEX</text>
    <text x="44" y="84" fill="%s" fill-opacity=".72" font-size="9" font-weight="700" letter-spacing="5.4">MUSIC</text>
    <text x="44" y="384" fill="%s" font-size="%d" font-weight="800" letter-spacing="-.8">%s</text>
    <text x="44" y="426" fill="%s" fill-opacity=".82" font-size="19" font-weight="600">%s</text>
    %s
  </g>
</svg>`,
		html.EscapeString(title), html.EscapeString(artist),
		html.EscapeString(title), html.EscapeString(artist),
		palette.backgroundStart, palette.backgroundEnd,
		palette.accent, palette.highlight,
		palette.backgroundStart, palette.backgroundStart, palette.backgroundStart,
		generatedCoverPattern(seed, palette), generatedCoverWaveform(seed, palette),
		palette.highlight, palette.accent, palette.text, titleSize, html.EscapeString(title),
		palette.text, html.EscapeString(artist), albumMarkup,
	)
}

func generatedCoverPattern(seed [sha256.Size]byte, palette generatedCoverPalette) string {
	switch seed[1] % 4 {
	case 0:
		centerX := 150 + int(seed[2])%220
		centerY := 130 + int(seed[3])%120
		return fmt.Sprintf(`<g fill="none" stroke="%s" stroke-opacity=".16"><circle cx="%d" cy="%d" r="72" stroke-width="2"/><circle cx="%d" cy="%d" r="126"/><circle cx="%d" cy="%d" r="184"/></g>`, palette.highlight, centerX, centerY, centerX, centerY, centerX, centerY)
	case 1:
		var lines strings.Builder
		lines.WriteString(`<g fill="none" stroke="` + palette.highlight + `" stroke-opacity=".12" stroke-width="2">`)
		offset := int(seed[2]) % 56
		for index := -4; index < 10; index++ {
			x := index*58 + offset
			fmt.Fprintf(&lines, `<path d="M%d -24L%d 326"/>`, x, x+230)
		}
		lines.WriteString(`</g>`)
		return lines.String()
	case 2:
		var dots strings.Builder
		dots.WriteString(`<g fill="` + palette.highlight + `" fill-opacity=".15">`)
		offsetX := 30 + int(seed[2])%26
		offsetY := 112 + int(seed[3])%24
		for row := 0; row < 4; row++ {
			for column := 0; column < 8; column++ {
				radius := 2 + int(seed[(row*8+column+4)%sha256.Size])%5
				fmt.Fprintf(&dots, `<circle cx="%d" cy="%d" r="%d"/>`, offsetX+column*62, offsetY+row*54, radius)
			}
		}
		dots.WriteString(`</g>`)
		return dots.String()
	default:
		bend := 110 + int(seed[2])%150
		return fmt.Sprintf(`<g fill="none" stroke="%s" stroke-opacity=".14"><path d="M-40 180C80 %d 176 %d 552 112" stroke-width="2"/><path d="M-40 224C126 %d 292 %d 552 156"/><path d="M-40 272C140 %d 366 %d 552 206"/></g>`, palette.highlight, bend, 330-bend/2, 330-bend/3, bend, bend+40, 340-bend/3)
	}
}

func generatedCoverWaveform(seed [sha256.Size]byte, palette generatedCoverPalette) string {
	var bars strings.Builder
	bars.WriteString(`<g fill="` + palette.accent + `" fill-opacity=".18" filter="url(#soft-glow)">`)
	for index := 0; index < 9; index++ {
		height := 44 + int(seed[index+8])%116
		x := 52 + index*50
		y := 210 - height/2
		fmt.Fprintf(&bars, `<rect x="%d" y="%d" width="18" height="%d" rx="9"/>`, x, y, height)
	}
	bars.WriteString(`</g><g fill="url(#accent)">`)
	for index := 0; index < 9; index++ {
		height := 28 + int(seed[index+17])%104
		x := 52 + index*50
		y := 210 - height/2
		fmt.Fprintf(&bars, `<rect x="%d" y="%d" width="18" height="%d" rx="9"/>`, x, y, height)
	}
	bars.WriteString(`</g>`)
	return bars.String()
}

func generatedCoverText(value, fallback string, maxRunes int) string {
	value = normalizeGeneratedCoverText(value)
	if value == "" {
		value = fallback
	}
	return truncateGeneratedCoverText(value, maxRunes)
}

func normalizeGeneratedCoverText(value string) string {
	value = strings.Map(func(character rune) rune {
		if unicode.IsControl(character) || unicode.Is(unicode.Cf, character) {
			return ' '
		}
		return character
	}, value)
	return strings.Join(strings.Fields(value), " ")
}

func truncateGeneratedCoverText(value string, maxRunes int) string {
	characters := []rune(value)
	if maxRunes <= 0 {
		return ""
	}
	if len(characters) <= maxRunes {
		return value
	}
	if maxRunes == 1 {
		return "…"
	}
	return strings.TrimSpace(string(characters[:maxRunes-1])) + "…"
}

func writeGeneratedTrackCoverSVG(c *fiber.Ctx, track models.Track) error {
	c.Set(fiber.HeaderContentType, "image/svg+xml; charset=utf-8")
	c.Set(fiber.HeaderCacheControl, "private, max-age=300")
	c.Set("X-Content-Type-Options", "nosniff")
	return c.SendString(generatedTrackCoverSVG(track))
}
