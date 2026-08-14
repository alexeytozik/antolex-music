package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/gofiber/fiber/v2"

	"github.com/alexeytozik/antolex-music/services/api/internal/models"
)

func TestGeneratedTrackCoverSVGIsDeterministicDistinctAndSized(t *testing.T) {
	t.Parallel()
	track := models.Track{
		ExternalID: "track-1",
		Title:      "Hymns in Dissonance",
		Artist:     "Whitechapel",
		Album:      "Hymns in Dissonance",
	}

	first := generatedTrackCoverSVG(track)
	second := generatedTrackCoverSVG(track)
	if first != second {
		t.Fatalf("generated cover changed for identical track metadata")
	}
	if !strings.Contains(first, `width="512" height="512" viewBox="0 0 512 512"`) {
		t.Fatalf("generated cover is not explicitly 512x512")
	}
	if !strings.Contains(first, "ANTOLEX") || !strings.Contains(first, "Hymns in Dissonance") {
		t.Fatalf("generated cover is missing branding or track metadata")
	}

	different := track
	different.ExternalID = "track-2"
	different.Title = "Warrior"
	if other := generatedTrackCoverSVG(different); other == first {
		t.Fatalf("different track metadata produced the same SVG")
	}
	if generatedTrackCoverVersion(different) == generatedTrackCoverVersion(track) {
		t.Fatalf("different track metadata produced the same cover version")
	}
	sameMetadata := track
	sameMetadata.ExternalID = "duplicate-row"
	if duplicate := generatedTrackCoverSVG(sameMetadata); duplicate != first {
		t.Fatalf("identical metadata produced different artwork for a duplicate row")
	}
	if generatedTrackCoverVersion(sameMetadata) != generatedTrackCoverVersion(track) {
		t.Fatalf("identical metadata produced different cover versions")
	}
}

func TestGeneratedTrackCoverSVGEscapesAndTruncatesUnicode(t *testing.T) {
	t.Parallel()
	longTitle := `<script>alert("x") & ` + strings.Repeat("Ж", 40)
	track := models.Track{
		ExternalID: "unsafe-track",
		Title:      longTitle,
		Artist:     `Artist <img onerror="bad"> & friends`,
		Album:      "Альбом\u0007 с названием",
	}

	generated := generatedTrackCoverSVG(track)
	if strings.Contains(generated, "<script") || strings.Contains(generated, "<img") {
		t.Fatalf("raw markup from metadata reached generated SVG")
	}
	for _, escaped := range []string{"&lt;script&gt;", "&lt;img", "&amp;"} {
		if !strings.Contains(generated, escaped) {
			t.Fatalf("generated SVG does not contain escaped metadata %q", escaped)
		}
	}

	truncated := generatedCoverText(longTitle, "", 28)
	if !utf8.ValidString(truncated) {
		t.Fatalf("Unicode truncation produced invalid UTF-8")
	}
	if utf8.RuneCountInString(truncated) > 28 || !strings.HasSuffix(truncated, "…") {
		t.Fatalf("unexpected Unicode truncation: %q", truncated)
	}
	if strings.Contains(generated, "\u0007") {
		t.Fatalf("control character reached generated SVG")
	}
}

func TestLibraryTrackCoverURLIsVersioned(t *testing.T) {
	t.Parallel()
	track := models.Track{ExternalID: "track / one", Title: "Title", Artist: "Artist"}
	parsed, err := url.Parse(libraryTrackCoverURL(track))
	if err != nil {
		t.Fatalf("parse cover URL: %v", err)
	}
	if parsed.Path != "/api/v1/tracks/track / one/cover" {
		t.Fatalf("unexpected cover path: %q", parsed.Path)
	}
	if got, want := parsed.Query().Get("v"), generatedTrackCoverVersion(track); got != want {
		t.Fatalf("cover version = %q; want %q", got, want)
	}
}

func TestWriteTrackCoverGeneratesArtworkWithoutStorage(t *testing.T) {
	t.Parallel()
	track := models.Track{ExternalID: "track-1", Title: "Murad", Artist: "Re:drum"}
	srv := &Server{}
	app := fiber.New()
	app.Get("/cover", func(c *fiber.Ctx) error { return srv.writeTrackCover(c, track, "") })

	response, err := app.Test(httptest.NewRequest(http.MethodGet, "/cover", nil))
	if err != nil {
		t.Fatalf("generated cover request: %v", err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read generated cover: %v", err)
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("generated cover status = %d; want 200", response.StatusCode)
	}
	if got := response.Header.Get("Content-Type"); !strings.HasPrefix(got, "image/svg+xml") {
		t.Fatalf("generated cover content type = %q", got)
	}
	if !strings.Contains(string(body), "Murad") || strings.Contains(string(body), "cover placeholder") {
		t.Fatalf("route did not return per-track generated artwork")
	}
}

func TestWriteTrackCoverGeneratesArtworkWhenObjectIsMissing(t *testing.T) {
	t.Parallel()
	storage := newFakeR2(t)
	track := models.Track{ExternalID: "track-1", Title: "Windows", Artist: "Re:drum"}
	srv := &Server{seedCatalog: storage.catalog}
	app := fiber.New()
	app.Get("/cover", func(c *fiber.Ctx) error {
		return srv.writeTrackCover(c, track, "covers/missing.jpg")
	})

	response, err := app.Test(httptest.NewRequest(http.MethodGet, "/cover", nil))
	if err != nil {
		t.Fatalf("missing cover request: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("missing cover status = %d; want 200", response.StatusCode)
	}
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read missing cover response: %v", err)
	}
	if !strings.Contains(string(body), "Windows") {
		t.Fatalf("missing R2 object did not use generated track artwork")
	}
}

func TestWriteTrackCoverRedirectsToExistingArtwork(t *testing.T) {
	t.Parallel()
	storage := newFakeR2(t)
	coverKey := "covers/track-1.jpg"
	storage.put(coverKey, "image/jpeg", []byte("jpeg-data"))
	track := models.Track{ExternalID: "track-1", Title: "Cover Test Song", Artist: "Cover Test Artist"}
	srv := &Server{seedCatalog: storage.catalog}
	app := fiber.New()
	app.Get("/cover", func(c *fiber.Ctx) error { return srv.writeTrackCover(c, track, coverKey) })

	response, err := app.Test(httptest.NewRequest(http.MethodGet, "/cover", nil))
	if err != nil {
		t.Fatalf("existing cover request: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusTemporaryRedirect {
		t.Fatalf("existing cover status = %d; want 307", response.StatusCode)
	}
	if location := response.Header.Get("Location"); location == "" || !strings.Contains(location, "track-1.jpg") {
		t.Fatalf("existing cover redirect location = %q", location)
	}
}

func TestTrackCoverUnknownTrackKeepsGenericFallback(t *testing.T) {
	t.Parallel()
	srv := &Server{}
	app := fiber.New()
	app.Get("/tracks/:externalID/cover", srv.trackCover)

	response, err := app.Test(httptest.NewRequest(http.MethodGet, "/tracks/unknown/cover", nil))
	if err != nil {
		t.Fatalf("unknown cover request: %v", err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read unknown cover response: %v", err)
	}
	if !strings.Contains(string(body), "cover placeholder") {
		t.Fatalf("unknown track did not keep generic fallback")
	}
}
