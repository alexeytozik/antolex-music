package server

import (
	"context"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestShuffleCursorIsSignedAndStrictlyValidated(t *testing.T) {
	t.Parallel()
	srv := &Server{}
	srv.cfg.JWTSecret = "shuffle-test-secret-at-least-32-bytes"
	cursor := shuffleCursor{
		Version:  shuffleCursorVersion,
		Anchor:   "30000000-0000-4000-8000-000000000000",
		After:    "40000000-0000-4000-8000-000000000000",
		Phase:    0,
		Excluded: "current-track",
	}

	encoded, err := srv.encodeShuffleCursor(cursor)
	if err != nil {
		t.Fatalf("encode cursor: %v", err)
	}
	decoded, err := srv.decodeShuffleCursor(encoded)
	if err != nil {
		t.Fatalf("decode cursor: %v", err)
	}
	if decoded != cursor {
		t.Fatalf("decoded cursor = %+v; want %+v", decoded, cursor)
	}

	tampered := encoded[:len(encoded)-1] + "A"
	if _, err := srv.decodeShuffleCursor(tampered); err == nil {
		t.Fatal("expected a tampered cursor to be rejected")
	}

	invalidPhase := cursor
	invalidPhase.Phase = 2
	invalidEncoded, err := srv.encodeShuffleCursor(invalidPhase)
	if err != nil {
		t.Fatalf("encode invalid cursor: %v", err)
	}
	if _, err := srv.decodeShuffleCursor(invalidEncoded); err == nil {
		t.Fatal("expected a signed cursor with an invalid phase to be rejected")
	}

	other := &Server{}
	other.cfg.JWTSecret = "a-different-shuffle-secret-32-bytes"
	if _, err := other.decodeShuffleCursor(encoded); err == nil {
		t.Fatal("expected a cursor signed by a different server to be rejected")
	}
}

func TestShuffleUUIDPhaseValidation(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		cursor shuffleCursor
		valid  bool
	}{
		{
			name:   "phase zero follows anchor",
			cursor: shuffleCursor{Version: 1, Anchor: "30000000-0000-4000-8000-000000000000", After: "40000000-0000-4000-8000-000000000000", Phase: 0},
			valid:  true,
		},
		{
			name:   "phase one wrapped before anchor",
			cursor: shuffleCursor{Version: 1, Anchor: "30000000-0000-4000-8000-000000000000", After: "20000000-0000-4000-8000-000000000000", Phase: 1},
			valid:  true,
		},
		{
			name:   "phase zero cannot precede anchor",
			cursor: shuffleCursor{Version: 1, Anchor: "30000000-0000-4000-8000-000000000000", After: "20000000-0000-4000-8000-000000000000", Phase: 0},
		},
		{
			name:   "uuid must be canonical",
			cursor: shuffleCursor{Version: 1, Anchor: "30000000-0000-4000-8000-000000000000", After: "NOT-A-UUID", Phase: 0},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := validateShuffleCursor(test.cursor)
			if (err == nil) != test.valid {
				t.Fatalf("validate cursor error = %v; valid=%v", err, test.valid)
			}
		})
	}
}

func TestShuffleRingHasNoRepeatsAndToleratesLibraryChanges(t *testing.T) {
	db := newLifecycleTestDB(t)
	ctx := context.Background()
	srv := &Server{db: db}

	readyIDs := []string{
		"10000000-0000-4000-8000-000000000000",
		"20000000-0000-4000-8000-000000000000",
		"30000000-0000-4000-8000-000000000000",
		"40000000-0000-4000-8000-000000000000",
		"50000000-0000-4000-8000-000000000000",
	}
	for index, id := range readyIDs {
		insertShuffleTrack(t, db, id, "ready", "track-"+id[:1], index)
	}
	insertShuffleTrack(t, db, "35000000-0000-4000-8000-000000000000", "processing", "not-ready", 99)

	cursor := shuffleCursor{Version: 1, Anchor: readyIDs[2], Phase: 0, Excluded: "track-4"}
	first, next, err := srv.listShuffleTracks(ctx, cursor, 1)
	if err != nil {
		t.Fatalf("first shuffle page: %v", err)
	}
	if len(first) != 1 || first[0].ID != readyIDs[2] || next == nil {
		t.Fatalf("unexpected first page: tracks=%+v next=%+v", first, next)
	}

	// Add a track ahead of the cursor and delete an unplayed one. The stable
	// cursor must include the addition when reached and never replay page one.
	insertShuffleTrack(t, db, "45000000-0000-4000-8000-000000000000", "ready", "track-added", 6)
	if _, err := db.Exec(ctx, `DELETE FROM library_tracks WHERE id=$1`, readyIDs[4]); err != nil {
		t.Fatalf("delete track during cycle: %v", err)
	}

	seen := map[string]bool{first[0].ID: true}
	current := next
	for current != nil {
		page, following, err := srv.listShuffleTracks(ctx, *current, 1)
		if err != nil {
			t.Fatalf("next shuffle page: %v", err)
		}
		for _, track := range page {
			if seen[track.ID] {
				t.Fatalf("track %s repeated in one shuffle cycle", track.ID)
			}
			if track.ExternalID == "track-4" || track.ExternalID == "not-ready" {
				t.Fatalf("excluded or non-ready track leaked into shuffle: %+v", track)
			}
			seen[track.ID] = true
		}
		current = following
	}

	want := []string{readyIDs[0], readyIDs[1], readyIDs[2], "45000000-0000-4000-8000-000000000000"}
	for _, id := range want {
		if !seen[id] {
			t.Fatalf("ready track %s missing from cycle; seen=%v", id, seen)
		}
	}

	if _, err := db.Exec(ctx, `UPDATE library_tracks SET status='error'`); err != nil {
		t.Fatalf("hide shuffle fixtures: %v", err)
	}
	if _, err := db.Exec(ctx, `UPDATE library_tracks SET status='ready' WHERE id=$1`, readyIDs[0]); err != nil {
		t.Fatalf("restore single ready track: %v", err)
	}
	singleCursor := shuffleCursor{
		Version:  1,
		Anchor:   readyIDs[0],
		Phase:    0,
		Excluded: "track-1",
	}
	excludedOnlyTrack, next, err := srv.listShuffleTracks(ctx, singleCursor, 20)
	if err != nil {
		t.Fatalf("single-track exclusion: %v", err)
	}
	if len(excludedOnlyTrack) != 0 || next != nil {
		t.Fatalf("current-only library must complete empty: tracks=%+v next=%+v", excludedOnlyTrack, next)
	}
	singleCursor.Excluded = ""
	singleTrack, next, err := srv.listShuffleTracks(ctx, singleCursor, 20)
	if err != nil {
		t.Fatalf("single-track shuffle: %v", err)
	}
	if len(singleTrack) != 1 || singleTrack[0].ID != readyIDs[0] || next != nil {
		t.Fatalf("single ready track mismatch: tracks=%+v next=%+v", singleTrack, next)
	}
}

func insertShuffleTrack(t *testing.T, db *pgxpool.Pool, id, status, externalID string, index int) {
	t.Helper()
	if _, err := db.Exec(context.Background(), `
		INSERT INTO library_tracks(
			id,external_track_id,title,artist,object_key,content_type,size_bytes,status
		) VALUES($1,$2,$3,'Shuffle Artist',$4,'audio/mp4',1,$5)
	`, id, externalID, fmt.Sprintf("Shuffle Track %d", index), "shuffle/"+id+".m4a", status); err != nil {
		t.Fatalf("insert shuffle track %s: %v", id, err)
	}
}
