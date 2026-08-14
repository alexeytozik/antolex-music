package server

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/alexeytozik/antolex-music/services/api/internal/models"
)

func TestSearchLibraryTracksUsesFullTextPrefixesAndFuzzyFallback(t *testing.T) {
	db := newLifecycleTestDB(t)
	ctx := context.Background()
	srv := &Server{db: db}
	createdAt := time.Date(2026, 8, 14, 9, 0, 0, 0, time.UTC)

	insertSearchTrack(t, db, searchTrackFixture{
		externalID: "ranking-exact-title", title: "Ränkneedle", artist: "Exact Title Artist", album: "Ranking", createdAt: createdAt,
	})
	insertSearchTrack(t, db, searchTrackFixture{
		externalID: "ranking-title-prefix", title: "Rankneedle Live", artist: "Prefix Artist", album: "Ranking", createdAt: createdAt,
	})
	insertSearchTrack(t, db, searchTrackFixture{
		externalID: "ranking-exact-artist", title: "Artist Match", artist: "Rankneedle", album: "Ranking", createdAt: createdAt,
	})
	insertSearchTrack(t, db, searchTrackFixture{
		externalID: "ranking-artist-prefix", title: "Tribute Song", artist: "Rankneedle Tribute", album: "Ranking", createdAt: createdAt,
	})
	insertSearchTrack(t, db, searchTrackFixture{
		externalID: "ranking-album", title: "Album Match", artist: "Other Artist", album: "Rankneedle Collection", createdAt: createdAt,
	})
	insertSearchTrack(t, db, searchTrackFixture{
		externalID: "cross-field", title: "Reise, Reise", artist: "Rammstein", album: "Reise, Reise", createdAt: createdAt,
	})
	insertSearchTrack(t, db, searchTrackFixture{
		externalID: "cyrillic-prefix", title: "Голоса в голове", artist: "Boulevard Depo", album: "Stay Ugly", createdAt: createdAt,
	})
	insertSearchTrack(t, db, searchTrackFixture{
		externalID: "diacritic", title: "Ace of Spades", artist: "Motörhead", album: "No Remorse", createdAt: createdAt,
	})
	insertSearchTrack(t, db, searchTrackFixture{
		externalID: "literal-punctuation", title: "Alpha Beta", artist: "Punctuation", album: "Symbols", createdAt: createdAt,
	})
	insertSearchTrack(t, db, searchTrackFixture{
		externalID: "not-ready", title: "Rammstein Processing", artist: "Rammstein", album: "Reise", status: "processing", createdAt: createdAt,
	})

	t.Run("words match in any order and across fields", func(t *testing.T) {
		for _, query := range []string{"rammstein reise", "reise rammstein", `"rammstein" "reise"`} {
			tracks, _, err := srv.searchLibraryTracks(ctx, query, 1, "")
			if err != nil {
				t.Fatalf("search %q: %v", query, err)
			}
			if !containsExternalID(tracks, "cross-field") {
				t.Fatalf("search %q did not return the cross-field match: %+v", query, tracks)
			}
			if containsExternalID(tracks, "not-ready") {
				t.Fatalf("search %q returned a processing track", query)
			}
		}
	})

	t.Run("Cyrillic and unfinished words match as prefixes", func(t *testing.T) {
		tracks, _, err := srv.searchLibraryTracks(ctx, "голос голове", 1, "")
		if err != nil {
			t.Fatalf("search Cyrillic prefixes: %v", err)
		}
		if !containsExternalID(tracks, "cyrillic-prefix") {
			t.Fatalf("Cyrillic prefix result missing: %+v", tracks)
		}
	})

	t.Run("query and fields use the same diacritic normalization", func(t *testing.T) {
		tracks, _, err := srv.searchLibraryTracks(ctx, "motorhead", 1, "")
		if err != nil {
			t.Fatalf("search without diacritic: %v", err)
		}
		if !containsExternalID(tracks, "diacritic") {
			t.Fatalf("diacritic result missing: %+v", tracks)
		}
	})

	t.Run("fuzzy fallback repairs a soft typo", func(t *testing.T) {
		tracks, _, err := srv.searchLibraryTracks(ctx, "ramstein", 1, "")
		if err != nil {
			t.Fatalf("fuzzy search: %v", err)
		}
		if !containsExternalID(tracks, "cross-field") {
			t.Fatalf("fuzzy result missing: %+v", tracks)
		}
	})

	t.Run("exact and prefix tiers outrank artist and album", func(t *testing.T) {
		tracks, _, err := srv.searchLibraryTracks(ctx, "rankneedle", 1, "")
		if err != nil {
			t.Fatalf("ranked search: %v", err)
		}
		wantPrefix := []string{
			"ranking-exact-title",
			"ranking-title-prefix",
			"ranking-exact-artist",
			"ranking-artist-prefix",
		}
		if len(tracks) < len(wantPrefix) {
			t.Fatalf("ranked search returned only %d tracks: %+v", len(tracks), tracks)
		}
		for index, want := range wantPrefix {
			if tracks[index].ExternalID != want {
				t.Fatalf("rank %d external_id=%q; want %q", index, tracks[index].ExternalID, want)
			}
		}
		albumPosition := externalIDPosition(tracks, "ranking-album")
		if albumPosition < len(wantPrefix) {
			t.Fatalf("album match position=%d; want it after title/artist tiers", albumPosition)
		}
	})

	t.Run("punctuation is text rather than query syntax", func(t *testing.T) {
		tracks, _, err := srv.searchLibraryTracks(ctx, "alpha-beta", 1, "")
		if err != nil {
			t.Fatalf("search punctuation-separated words: %v", err)
		}
		if !containsExternalID(tracks, "literal-punctuation") {
			t.Fatalf("punctuation-separated result missing: %+v", tracks)
		}
		for _, query := range []string{"%", "_"} {
			tracks, pagination, err := srv.searchLibraryTracks(ctx, query, 1, "")
			if err != nil {
				t.Fatalf("search literal %q: %v", query, err)
			}
			if len(tracks) != 0 || pagination.TotalCount != 0 {
				t.Fatalf("literal %q behaved like a wildcard: tracks=%d total=%d", query, len(tracks), pagination.TotalCount)
			}
		}
	})
}

func TestSearchLibraryTracksCursorV2IsStableAndStaleSafe(t *testing.T) {
	db := newLifecycleTestDB(t)
	ctx := context.Background()
	srv := &Server{db: db}
	createdAt := time.Date(2026, 8, 14, 10, 0, 0, 0, time.UTC)

	for index := 0; index < 25; index++ {
		insertSearchTrack(t, db, searchTrackFixture{
			externalID: fmt.Sprintf("cursor-%02d", index),
			title:      fmt.Sprintf("Cursorfixture %02d", index),
			artist:     "Pagination Artist",
			album:      "Pagination Album",
			createdAt:  createdAt,
		})
	}

	first, firstPagination, err := srv.searchLibraryTracks(ctx, "cursorfixture", 1, "")
	if err != nil {
		t.Fatalf("first cursor page: %v", err)
	}
	if len(first) != searchResultLimit || firstPagination.NextCursor == "" || !firstPagination.HasNext {
		t.Fatalf("unexpected first page: tracks=%d pagination=%+v", len(first), firstPagination)
	}
	decoded, err := decodeSearchCursor(firstPagination.NextCursor)
	if err != nil {
		t.Fatalf("decode next cursor: %v", err)
	}
	if decoded.Mode != searchModePrimary || decoded.QueryFingerprint != searchQueryFingerprint("cursorfixture") {
		t.Fatalf("unexpected cursor identity: %+v", decoded)
	}

	second, secondPagination, err := srv.searchLibraryTracks(ctx, "cursorfixture", 2, firstPagination.NextCursor)
	if err != nil {
		t.Fatalf("second cursor page: %v", err)
	}
	if len(second) != 5 || secondPagination.HasNext || secondPagination.NextCursor != "" {
		t.Fatalf("unexpected second page: tracks=%d pagination=%+v", len(second), secondPagination)
	}
	seen := make(map[string]struct{}, 25)
	for _, track := range append(first, second...) {
		if _, exists := seen[track.ID]; exists {
			t.Fatalf("track %s appeared on more than one cursor page", track.ID)
		}
		seen[track.ID] = struct{}{}
	}
	if len(seen) != 25 {
		t.Fatalf("cursor pages covered %d tracks; want 25", len(seen))
	}

	legacyCursor := encodeTrackCursor(first[len(first)-1])
	restarted, restartedPagination, err := srv.searchLibraryTracks(ctx, "cursorfixture", 2, legacyCursor)
	if err != nil {
		t.Fatalf("search with legacy cursor: %v", err)
	}
	if restartedPagination.Page != 1 || len(restarted) != searchResultLimit {
		t.Fatalf("legacy cursor did not restart page one: tracks=%d pagination=%+v", len(restarted), restartedPagination)
	}
	for index := range first {
		if restarted[index].ID != first[index].ID {
			t.Fatalf("restarted item %d=%s; want first-page item %s", index, restarted[index].ID, first[index].ID)
		}
	}

	_, mismatchedPagination, err := srv.searchLibraryTracks(ctx, "different query", 3, firstPagination.NextCursor)
	if err != nil {
		t.Fatalf("search with mismatched cursor: %v", err)
	}
	if mismatchedPagination.Page != 1 {
		t.Fatalf("mismatched cursor page=%d; want 1", mismatchedPagination.Page)
	}
}

func TestSearchLibraryTracksFuzzyCursorDoesNotRepeatOrSkipTracks(t *testing.T) {
	db := newLifecycleTestDB(t)
	ctx := context.Background()
	srv := &Server{db: db}
	createdAt := time.Date(2026, 8, 14, 11, 0, 0, 0, time.UTC)

	for index := 0; index < 25; index++ {
		insertSearchTrack(t, db, searchTrackFixture{
			externalID: fmt.Sprintf("fuzzy-cursor-%02d", index),
			title:      fmt.Sprintf("Fuzzyfixture %02d", index),
			artist:     "Typo Artist",
			album:      "Typo Album",
			createdAt:  createdAt,
		})
	}

	const misspelledQuery = "fuzzyficture"
	first, firstPagination, err := srv.searchLibraryTracks(ctx, misspelledQuery, 1, "")
	if err != nil {
		t.Fatalf("first fuzzy cursor page: %v", err)
	}
	if len(first) != searchResultLimit || firstPagination.NextCursor == "" || !firstPagination.HasNext {
		t.Fatalf("unexpected first fuzzy page: tracks=%d pagination=%+v", len(first), firstPagination)
	}
	decoded, err := decodeSearchCursor(firstPagination.NextCursor)
	if err != nil {
		t.Fatalf("decode fuzzy cursor: %v", err)
	}
	if decoded.Mode != searchModeFuzzy {
		t.Fatalf("fuzzy cursor mode=%q; want %q", decoded.Mode, searchModeFuzzy)
	}

	second, secondPagination, err := srv.searchLibraryTracks(ctx, misspelledQuery, 2, firstPagination.NextCursor)
	if err != nil {
		t.Fatalf("second fuzzy cursor page: %v", err)
	}
	if len(second) != 5 || secondPagination.HasNext || secondPagination.NextCursor != "" {
		t.Fatalf("unexpected second fuzzy page: tracks=%d pagination=%+v", len(second), secondPagination)
	}
	seen := make(map[string]struct{}, 25)
	for _, track := range append(first, second...) {
		if _, exists := seen[track.ID]; exists {
			t.Fatalf("fuzzy track %s appeared on more than one cursor page", track.ID)
		}
		seen[track.ID] = struct{}{}
	}
	if len(seen) != 25 {
		t.Fatalf("fuzzy cursor pages covered %d tracks; want 25", len(seen))
	}
}

type searchTrackFixture struct {
	externalID string
	title      string
	artist     string
	album      string
	status     string
	createdAt  time.Time
}

func insertSearchTrack(t *testing.T, db *pgxpool.Pool, fixture searchTrackFixture) {
	t.Helper()
	if fixture.status == "" {
		fixture.status = "ready"
	}
	id := uuid.NewString()
	if _, err := db.Exec(context.Background(), `
		INSERT INTO library_tracks(
			id, external_track_id, title, artist, album, cover_url, object_key,
			content_type, size_bytes, status, created_at, updated_at
		) VALUES($1,$2,$3,$4,$5,'',$6,'audio/mp4',1,$7,$8,$8)
	`, id, fixture.externalID, fixture.title, fixture.artist, fixture.album, "playback/"+id+".m4a", fixture.status, fixture.createdAt); err != nil {
		t.Fatalf("insert search track %q: %v", fixture.externalID, err)
	}
}

func containsExternalID(tracks []models.Track, externalID string) bool {
	return externalIDPosition(tracks, externalID) >= 0
}

func externalIDPosition(tracks []models.Track, externalID string) int {
	for index, track := range tracks {
		if track.ExternalID == externalID {
			return index
		}
	}
	return -1
}
