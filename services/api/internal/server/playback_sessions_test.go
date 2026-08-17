package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/alexeytozik/antolex-music/services/api/internal/models"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestValidateCreatePlaybackSessionRequest(t *testing.T) {
	valid := createPlaybackSessionRequest{
		Source:             playbackSessionSource{Kind: " SEARCH ", Query: " artist "},
		InitialExternalIDs: []string{" first ", "second"},
		CurrentExternalID:  " first ",
		CurrentIndex:       0,
		PositionSeconds:    12.5,
	}
	if err := validateCreatePlaybackSessionRequest(&valid); err != nil {
		t.Fatalf("valid request: %v", err)
	}
	if valid.Source.Kind != "search" || valid.Source.Query != "artist" || valid.InitialExternalIDs[0] != "first" {
		t.Fatalf("request was not normalized: %+v", valid)
	}

	tests := []struct {
		name   string
		mutate func(*createPlaybackSessionRequest)
	}{
		{name: "source", mutate: func(request *createPlaybackSessionRequest) { request.Source.Kind = "playlist" }},
		{name: "empty queue", mutate: func(request *createPlaybackSessionRequest) { request.InitialExternalIDs = nil }},
		{name: "current index", mutate: func(request *createPlaybackSessionRequest) { request.CurrentIndex = 2 }},
		{name: "current id", mutate: func(request *createPlaybackSessionRequest) { request.CurrentExternalID = "second" }},
		{name: "source page", mutate: func(request *createPlaybackSessionRequest) { request.Page = playbackSourcePageLimit + 1 }},
		{name: "duplicate", mutate: func(request *createPlaybackSessionRequest) { request.InitialExternalIDs[1] = "first" }},
		{name: "negative position", mutate: func(request *createPlaybackSessionRequest) { request.PositionSeconds = -1 }},
		{name: "NaN position", mutate: func(request *createPlaybackSessionRequest) { request.PositionSeconds = math.NaN() }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := valid
			request.InitialExternalIDs = append([]string(nil), valid.InitialExternalIDs...)
			test.mutate(&request)
			if err := validateCreatePlaybackSessionRequest(&request); err == nil {
				t.Fatal("invalid request was accepted")
			}
		})
	}
}

func TestParseSingleByteRange(t *testing.T) {
	tests := []struct {
		name       string
		raw        string
		want       parsedByteRange
		wantStatus int
		wantError  bool
	}{
		{name: "full", raw: "", want: parsedByteRange{Start: 0, End: 99}, wantStatus: http.StatusOK},
		{name: "bounded", raw: "bytes=10-19", want: parsedByteRange{Start: 10, End: 19}, wantStatus: http.StatusPartialContent},
		{name: "open", raw: "bytes=90-", want: parsedByteRange{Start: 90, End: 99}, wantStatus: http.StatusPartialContent},
		{name: "suffix", raw: "bytes=-5", want: parsedByteRange{Start: 95, End: 99}, wantStatus: http.StatusPartialContent},
		{name: "clamped", raw: "bytes=90-150", want: parsedByteRange{Start: 90, End: 99}, wantStatus: http.StatusPartialContent},
		{name: "multiple", raw: "bytes=0-1,4-5", wantError: true},
		{name: "outside", raw: "bytes=100-101", wantError: true},
		{name: "reverse", raw: "bytes=20-10", wantError: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, status, err := parseSingleByteRange(test.raw, 100)
			if (err != nil) != test.wantError {
				t.Fatalf("error=%v; wantError=%v", err, test.wantError)
			}
			if test.wantError {
				return
			}
			if got != test.want || status != test.wantStatus {
				t.Fatalf("range=%+v status=%d; want %+v status=%d", got, status, test.want, test.wantStatus)
			}
		})
	}
}

func TestRenderPlaybackManifest(t *testing.T) {
	record := playbackSessionRecord{
		ID:              "session",
		SourceKind:      "search",
		StartPositionMS: 1250,
		SourceState:     playbackSourceState{HasMore: false},
	}
	items := []playbackSessionItem{
		manifestTestItem(0, 0, []playbackSegment{
			{Offset: 100, Length: 200, DurationMS: 4100},
			{Offset: 300, Length: 220, DurationMS: 3900},
		}),
		manifestTestItem(1, 2, []playbackSegment{
			{Offset: 80, Length: 180, DurationMS: 5200},
		}),
	}
	manifest, err := renderPlaybackManifest(record, items, false, 0)
	if err != nil {
		t.Fatalf("render manifest: %v", err)
	}
	for _, fragment := range []string{
		"#EXT-X-VERSION:10",
		"#EXT-X-PLAYLIST-TYPE:EVENT",
		"#EXT-X-INDEPENDENT-SEGMENTS",
		"#EXT-X-TARGETDURATION:7",
		"#EXT-X-MEDIA-SEQUENCE:0",
		"#EXT-X-START:TIME-OFFSET=1.250,PRECISE=YES",
		"#EXT-X-MAP:URI=\"assets/0/0.mp4\",BYTERANGE=\"64@0\"",
		"#EXT-X-BYTERANGE:200@100",
		"#EXT-X-DISCONTINUITY",
		"assets/0/1.mp4",
		"#EXT-X-ENDLIST",
	} {
		if !strings.Contains(manifest, fragment) {
			t.Fatalf("manifest does not contain %q:\n%s", fragment, manifest)
		}
	}
	if count := strings.Count(manifest, "#EXTINF:"); count != 3 {
		t.Fatalf("EXTINF count=%d; want 3\n%s", count, manifest)
	}
}

func TestRenderPlaybackDeltaKeepsParentSequence(t *testing.T) {
	segments := make([]playbackSegment, 20)
	for index := range segments {
		segments[index] = playbackSegment{
			Offset: int64(64 + index*100), Length: 100, DurationMS: int64((6 * time.Second) / time.Millisecond),
		}
	}
	record := playbackSessionRecord{
		SourceKind:  "shuffle",
		SourceState: playbackSourceState{HasMore: true},
	}
	manifest, err := renderPlaybackManifest(record, []playbackSessionItem{manifestTestItem(0, 0, segments)}, true, len(segments))
	if err != nil {
		t.Fatalf("render delta manifest: %v", err)
	}
	if !strings.Contains(manifest, "#EXT-X-MEDIA-SEQUENCE:0\n") ||
		!strings.Contains(manifest, "#EXT-X-DISCONTINUITY-SEQUENCE:0\n") ||
		!strings.Contains(manifest, "#EXT-X-SKIP:SKIPPED-SEGMENTS=8\n") {
		t.Fatalf("delta sequence metadata is invalid:\n%s", manifest)
	}
	if count := strings.Count(manifest, "#EXTINF:"); count != playbackManifestTailSegmentNum {
		t.Fatalf("delta EXTINF count=%d; want %d", count, playbackManifestTailSegmentNum)
	}
	if strings.Contains(manifest, "#EXT-X-ENDLIST") {
		t.Fatalf("shuffle delta unexpectedly ended:\n%s", manifest)
	}
}

func TestRenderPlaybackDeltaDoesNotSkipUnfetchedAppend(t *testing.T) {
	segments := make([]playbackSegment, 20)
	for index := range segments {
		segments[index] = playbackSegment{
			Offset: int64(64 + index*100), Length: 100, DurationMS: 6000,
		}
	}
	record := playbackSessionRecord{
		SourceKind:  "search",
		SourceState: playbackSourceState{HasMore: true},
	}
	manifest, err := renderPlaybackManifest(
		record,
		[]playbackSessionItem{manifestTestItem(0, 0, segments)},
		true,
		3,
	)
	if err != nil {
		t.Fatalf("render safely capped delta: %v", err)
	}
	if !strings.Contains(manifest, "#EXT-X-SKIP:SKIPPED-SEGMENTS=3\n") {
		t.Fatalf("delta was not capped to fetched media:\n%s", manifest)
	}
	if count := strings.Count(manifest, "#EXTINF:"); count != 17 {
		t.Fatalf("safely capped delta segments=%d; want 17", count)
	}
}

func TestRenderPlaybackDeltaRequiresLongActiveWindow(t *testing.T) {
	makeSegments := func(count int) []playbackSegment {
		segments := make([]playbackSegment, count)
		for index := range segments {
			segments[index] = playbackSegment{
				Offset: int64(64 + index*100), Length: 100, DurationMS: 6000,
			}
		}
		return segments
	}

	t.Run("too little history", func(t *testing.T) {
		record := playbackSessionRecord{SourceKind: "search", SourceState: playbackSourceState{HasMore: true}}
		manifest, err := renderPlaybackManifest(record, []playbackSessionItem{manifestTestItem(0, 0, makeSegments(7))}, true, 7)
		if err != nil {
			t.Fatalf("render short delta: %v", err)
		}
		if strings.Contains(manifest, "#EXT-X-SERVER-CONTROL") || strings.Contains(manifest, "#EXT-X-SKIP") {
			t.Fatalf("short delta advertised skipping:\n%s", manifest)
		}
		if count := strings.Count(manifest, "#EXTINF:"); count != 7 {
			t.Fatalf("short delta segment count=%d; want 7", count)
		}
	})

	t.Run("short segments expand retained tail", func(t *testing.T) {
		segments := make([]playbackSegment, 50)
		for index := range segments {
			segments[index] = playbackSegment{
				Offset: int64(64 + index*100), Length: 100, DurationMS: 1000,
			}
		}
		record := playbackSessionRecord{SourceKind: "search", SourceState: playbackSourceState{HasMore: true}}
		manifest, err := renderPlaybackManifest(record, []playbackSessionItem{manifestTestItem(0, 0, segments)}, true, 50)
		if err != nil {
			t.Fatalf("render short-segment delta: %v", err)
		}
		if !strings.Contains(manifest, "#EXT-X-SERVER-CONTROL:CAN-SKIP-UNTIL=42.000\n") ||
			!strings.Contains(manifest, "#EXT-X-SKIP:SKIPPED-SEGMENTS=8\n") {
			t.Fatalf("short-segment skip boundary is invalid:\n%s", manifest)
		}
		if count := strings.Count(manifest, "#EXTINF:"); count != 42 {
			t.Fatalf("short-segment retained count=%d; want 42", count)
		}
	})

	t.Run("ended event", func(t *testing.T) {
		record := playbackSessionRecord{SourceKind: "likes", SourceState: playbackSourceState{HasMore: false}}
		manifest, err := renderPlaybackManifest(record, []playbackSessionItem{manifestTestItem(0, 0, makeSegments(20))}, true, 20)
		if err != nil {
			t.Fatalf("render ended delta: %v", err)
		}
		if strings.Contains(manifest, "#EXT-X-SERVER-CONTROL") || strings.Contains(manifest, "#EXT-X-SKIP") {
			t.Fatalf("ended manifest advertised skipping:\n%s", manifest)
		}
		if !strings.Contains(manifest, "#EXT-X-ENDLIST") || strings.Count(manifest, "#EXTINF:") != 20 {
			t.Fatalf("ended manifest was truncated:\n%s", manifest)
		}
	})
}

func TestHLSDeltaDirectiveIsCaseSensitive(t *testing.T) {
	for _, value := range []string{"YES", "v2"} {
		if !isHLSDeltaRequest(value) {
			t.Fatalf("valid delta directive %q was ignored", value)
		}
	}
	for _, value := range []string{"", "yes", "V2", "1", " YES ", "true"} {
		if isHLSDeltaRequest(value) {
			t.Fatalf("unknown delta directive %q was accepted", value)
		}
	}
}

func TestRenderPlaybackTargetDurationStaysStableAcrossAppend(t *testing.T) {
	record := playbackSessionRecord{SourceKind: "search", SourceState: playbackSourceState{HasMore: true}}
	first := manifestTestItem(0, 0, []playbackSegment{{Offset: 64, Length: 100, DurationMS: 4000}})
	initial, err := renderPlaybackManifest(record, []playbackSessionItem{first}, false, 0)
	if err != nil {
		t.Fatalf("render initial stable target: %v", err)
	}
	second := manifestTestItem(1, 1, []playbackSegment{{Offset: 64, Length: 100, DurationMS: 6500}})
	second.Asset.TargetDuration = 7
	appended, err := renderPlaybackManifest(record, []playbackSessionItem{first, second}, false, 0)
	if err != nil {
		t.Fatalf("render appended stable target: %v", err)
	}
	for label, manifest := range map[string]string{"initial": initial, "appended": appended} {
		if !strings.Contains(manifest, "#EXT-X-TARGETDURATION:7\n") {
			t.Fatalf("%s manifest target changed:\n%s", label, manifest)
		}
	}
	invalid := manifestTestItem(1, 1, []playbackSegment{{Offset: 64, Length: 100, DurationMS: 7001}})
	invalid.Asset.TargetDuration = 8
	if _, err := renderPlaybackManifest(record, []playbackSessionItem{first, invalid}, false, 0); err == nil {
		t.Fatal("manifest accepted an asset above its stable target duration")
	}
}

func TestPlaybackContinuationHorizonStartsAfterLastFetchedSegment(t *testing.T) {
	segments := make([]playbackSegment, 1300)
	for index := range segments {
		segments[index] = playbackSegment{Offset: int64(index), Length: 1, DurationMS: 6000}
	}
	item := manifestTestItem(0, 0, segments)
	record := playbackSessionRecord{
		SourceKind:               "search",
		SourceState:              playbackSourceState{HasMore: true},
		LastFetchedMediaSequence: -1,
	}
	if playbackNeedsContinuation(record, []playbackSessionItem{item}) {
		t.Fatal("unplayed 130-minute horizon was treated as shorter than two hours")
	}
	record.LastFetchedMediaSequence = 100
	if !playbackNeedsContinuation(record, []playbackSessionItem{item}) {
		t.Fatal("horizon ignored time consumed inside the current track")
	}
}

func manifestTestItem(ordinal int, firstSequence int64, segments []playbackSegment) playbackSessionItem {
	durationMS := int64(0)
	for _, segment := range segments {
		durationMS += segment.DurationMS
	}
	return playbackSessionItem{
		Ordinal:            ordinal,
		Track:              models.Track{ExternalID: "track"},
		TimelineStartMS:    0,
		DurationMS:         durationMS,
		FirstMediaSequence: firstSequence,
		SegmentCount:       len(segments),
		Asset: playbackAsset{
			ID:             "asset",
			ObjectKey:      "asset.mp4",
			InitOffset:     0,
			InitLength:     64,
			DurationMS:     durationMS,
			TargetDuration: 6,
			Segments:       segments,
		},
	}
}

func TestPlaybackSessionBackfillGateOwnershipLimitAndCleanup(t *testing.T) {
	db := newLifecycleTestDB(t)
	ctx := context.Background()
	srv := &Server{db: db}
	userID := uuid.NewString()
	otherUserID := uuid.NewString()
	if _, err := db.Exec(ctx, `
		INSERT INTO users(id,email,password_hash,role,active,access_status)
		VALUES($1,'player@example.com','','listener',TRUE,'active'),
		      ($2,'other-player@example.com','','listener',TRUE,'active')
	`, userID, otherUserID); err != nil {
		t.Fatalf("insert playback users: %v", err)
	}
	insertSearchTrack(t, db, searchTrackFixture{
		externalID: "playback-track", title: "Playback", artist: "Test", album: "Session", createdAt: time.Now(),
	})

	missing, err := srv.libraryHasMissingPlaybackAssets(ctx)
	if err != nil || !missing {
		t.Fatalf("missing assets=%v error=%v; want true", missing, err)
	}
	gateApp := fiber.New()
	gateApp.Use(func(c *fiber.Ctx) error {
		c.Locals("userID", userID)
		return c.Next()
	})
	gateApp.Post("/sessions", srv.createPlaybackSession)
	gateRequest, err := http.NewRequest(http.MethodPost, "/sessions", strings.NewReader(`{
		"source":{"kind":"search"},
		"initial_external_ids":["playback-track"],
		"current_external_id":"playback-track",
		"current_index":0,
		"position_seconds":0,
		"page":1,
		"has_more":false
	}`))
	if err != nil {
		t.Fatalf("create gate request: %v", err)
	}
	gateRequest.Header.Set("Content-Type", "application/json")
	gateResponse, err := gateApp.Test(gateRequest, -1)
	if err != nil {
		t.Fatalf("backfill gate request: %v", err)
	}
	if gateResponse.StatusCode != http.StatusServiceUnavailable {
		gateResponse.Body.Close()
		t.Fatalf("backfill gate status=%d; want 503", gateResponse.StatusCode)
	}
	var gateError models.ErrorResponse
	if err := json.NewDecoder(gateResponse.Body).Decode(&gateError); err != nil {
		gateResponse.Body.Close()
		t.Fatalf("decode backfill gate: %v", err)
	}
	gateResponse.Body.Close()
	if gateError.Error.Code != "hls_backfill_incomplete" {
		t.Fatalf("backfill gate code=%q; want hls_backfill_incomplete", gateError.Error.Code)
	}
	var trackID string
	if err := db.QueryRow(ctx, `SELECT id::text FROM library_tracks WHERE external_track_id='playback-track'`).Scan(&trackID); err != nil {
		t.Fatalf("load playback track id: %v", err)
	}
	assetObjectKey := "playback/" + trackID + "/cmaf/test.mp4"
	if _, err := db.Exec(ctx, `
		INSERT INTO track_playback_assets(
			track_id,object_key,init_offset,init_length,segments,duration_ms,target_duration,status
		) VALUES($1,$2,0,64,'[{"offset":64,"length":128,"duration_ms":6000}]',6000,6,'ready')
	`, trackID, assetObjectKey); err != nil {
		t.Fatalf("insert playback asset: %v", err)
	}
	missing, err = srv.libraryHasMissingPlaybackAssets(ctx)
	if err != nil || missing {
		t.Fatalf("missing assets=%v error=%v; want false", missing, err)
	}

	seed, err := srv.loadPlaybackSeedTracks(ctx, []string{"playback-track"})
	if err != nil {
		t.Fatalf("load playback seed: %v", err)
	}
	request := createPlaybackSessionRequest{
		Source:             playbackSessionSource{Kind: "search"},
		InitialExternalIDs: []string{"playback-track"},
		CurrentExternalID:  "playback-track",
		CurrentIndex:       0,
	}
	var sessionIDs []string
	for index := 0; index < 4; index++ {
		response, err := srv.insertPlaybackSession(ctx, userID, request, playbackSourceState{}, seed)
		if err != nil {
			t.Fatalf("insert playback session %d: %v", index, err)
		}
		sessionIDs = append(sessionIDs, response.ID)
		time.Sleep(time.Millisecond)
	}
	var activeCount int
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM playback_sessions WHERE user_id=$1 AND status='active'`, userID).Scan(&activeCount); err != nil {
		t.Fatalf("count active playback sessions: %v", err)
	}
	if activeCount != 3 {
		t.Fatalf("active sessions=%d; want 3", activeCount)
	}
	if _, _, err := srv.loadPlaybackSession(ctx, sessionIDs[0], userID, false); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("oldest session error=%v; want pgx.ErrNoRows", err)
	}
	if _, _, err := srv.loadPlaybackSession(ctx, sessionIDs[3], otherUserID, false); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("cross-user session error=%v; want pgx.ErrNoRows", err)
	}
	ownershipApp := fiber.New()
	ownershipApp.Use(func(c *fiber.Ctx) error {
		c.Locals("userID", otherUserID)
		return c.Next()
	})
	ownershipApp.Get("/sessions/:id", srv.getPlaybackSession)
	ownershipApp.Get("/sessions/:id/assets/:revision/:ordinal.mp4", srv.playbackAsset)
	for _, target := range []string{
		"/sessions/" + sessionIDs[3],
		"/sessions/" + sessionIDs[3] + "/assets/0/0.mp4",
	} {
		response, err := ownershipApp.Test(newTestRequest(t, http.MethodGet, target), -1)
		if err != nil {
			t.Fatalf("ownership request %s: %v", target, err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusNotFound {
			t.Fatalf("ownership request %s status=%d; want 404", target, response.StatusCode)
		}
	}

	storage := newFakeR2(t)
	assetBody := make([]byte, 192)
	for index := range assetBody {
		assetBody[index] = byte(index)
	}
	storage.put(assetObjectKey, "audio/mp4", assetBody)
	srv.seedCatalog = storage.catalog
	assetApp := fiber.New()
	assetApp.Use(func(c *fiber.Ctx) error {
		c.Locals("userID", userID)
		return c.Next()
	})
	assetApp.Get("/sessions/:id/assets/:revision/:ordinal.mp4", srv.playbackAsset)
	assetApp.Head("/sessions/:id/assets/:revision/:ordinal.mp4", srv.playbackAsset)
	assetTarget := "/sessions/" + sessionIDs[3] + "/assets/0/0.mp4"
	fullResponse, err := assetApp.Test(newTestRequest(t, http.MethodGet, assetTarget), -1)
	if err != nil {
		t.Fatalf("full asset request: %v", err)
	}
	fullBody, readErr := io.ReadAll(fullResponse.Body)
	fullResponse.Body.Close()
	if readErr != nil {
		t.Fatalf("read full asset: %v", readErr)
	}
	if fullResponse.StatusCode != http.StatusOK || !bytes.Equal(fullBody, assetBody) {
		t.Fatalf("full asset status=%d body=%d bytes; want 200/%d", fullResponse.StatusCode, len(fullBody), len(assetBody))
	}

	rangeRequest := newTestRequest(t, http.MethodGet, assetTarget)
	rangeRequest.Header.Set("Range", "bytes=64-127")
	rangeResponse, err := assetApp.Test(rangeRequest, -1)
	if err != nil {
		t.Fatalf("range asset request: %v", err)
	}
	rangeBody, readErr := io.ReadAll(rangeResponse.Body)
	rangeResponse.Body.Close()
	if readErr != nil {
		t.Fatalf("read range asset: %v", readErr)
	}
	if rangeResponse.StatusCode != http.StatusPartialContent ||
		rangeResponse.Header.Get("Content-Range") != "bytes 64-127/192" ||
		!bytes.Equal(rangeBody, assetBody[64:128]) {
		t.Fatalf("range response status=%d content-range=%q body=%d bytes",
			rangeResponse.StatusCode, rangeResponse.Header.Get("Content-Range"), len(rangeBody))
	}

	headResponse, err := assetApp.Test(newTestRequest(t, http.MethodHead, assetTarget), -1)
	if err != nil {
		t.Fatalf("head asset request: %v", err)
	}
	headBody, readErr := io.ReadAll(headResponse.Body)
	headResponse.Body.Close()
	if readErr != nil {
		t.Fatalf("read head asset response: %v", readErr)
	}
	if headResponse.StatusCode != http.StatusOK || headResponse.ContentLength != 192 || len(headBody) != 0 {
		t.Fatalf("HEAD status=%d content-length=%d body=%d; want 200/192/0",
			headResponse.StatusCode, headResponse.ContentLength, len(headBody))
	}

	invalidRangeRequest := newTestRequest(t, http.MethodGet, assetTarget)
	invalidRangeRequest.Header.Set("Range", "bytes=192-")
	invalidRangeResponse, err := assetApp.Test(invalidRangeRequest, -1)
	if err != nil {
		t.Fatalf("invalid range request: %v", err)
	}
	invalidRangeResponse.Body.Close()
	if invalidRangeResponse.StatusCode != http.StatusRequestedRangeNotSatisfiable ||
		invalidRangeResponse.Header.Get("Content-Range") != "bytes */192" {
		t.Fatalf("invalid range status=%d content-range=%q; want 416 bytes */192",
			invalidRangeResponse.StatusCode, invalidRangeResponse.Header.Get("Content-Range"))
	}

	if _, err := db.Exec(ctx, `
		UPDATE playback_sessions
		SET created_at=NOW()-INTERVAL '2 hours',expires_at=NOW()-INTERVAL '1 hour'
		WHERE user_id=$1
	`, userID); err != nil {
		t.Fatalf("expire playback sessions: %v", err)
	}
	if err := cleanupExpiredPlaybackSessions(ctx, db); err != nil {
		t.Fatalf("cleanup playback sessions: %v", err)
	}
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM playback_sessions WHERE user_id=$1`, userID).Scan(&activeCount); err != nil {
		t.Fatalf("count cleaned playback sessions: %v", err)
	}
	if activeCount != 0 {
		t.Fatalf("playback sessions after cleanup=%d; want 0", activeCount)
	}
}

func TestPlaybackSessionContinuesPastFirstTwentyTracks(t *testing.T) {
	db := newLifecycleTestDB(t)
	ctx := context.Background()
	srv := &Server{db: db}
	userID := uuid.NewString()
	if _, err := db.Exec(ctx, `
		INSERT INTO users(id,email,password_hash,role,active,access_status)
		VALUES($1,'continuation-player@example.com','','listener',TRUE,'active')
	`, userID); err != nil {
		t.Fatalf("insert continuation user: %v", err)
	}
	createdAt := time.Date(2026, 8, 17, 12, 0, 0, 0, time.UTC)
	longTrackSegments := make([]playbackSegment, 50)
	for index := range longTrackSegments {
		longTrackSegments[index] = playbackSegment{
			Offset: 64 + int64(index*128), Length: 128, DurationMS: 6000,
		}
	}
	longTrackSegmentsJSON, err := json.Marshal(longTrackSegments)
	if err != nil {
		t.Fatalf("encode long-track segments: %v", err)
	}
	for index := 0; index < 25; index++ {
		externalID := "playback-continuation-" + strings.Repeat("0", max(0, 2-len(strconv.Itoa(index)))) + strconv.Itoa(index)
		insertSearchTrack(t, db, searchTrackFixture{
			externalID: externalID,
			title:      "Continuationfixture " + strconv.Itoa(index),
			artist:     "Playback Test",
			album:      "Long Queue",
			createdAt:  createdAt,
		})
		var trackID string
		if err := db.QueryRow(ctx, `SELECT id::text FROM library_tracks WHERE external_track_id=$1`, externalID).Scan(&trackID); err != nil {
			t.Fatalf("load continuation track %d: %v", index, err)
		}
		if _, err := db.Exec(ctx, `
			INSERT INTO track_playback_assets(
				track_id,object_key,init_offset,init_length,segments,duration_ms,target_duration,status
			) VALUES($1,$2,0,64,$3,300000,6,'ready')
		`, trackID, "playback/"+trackID+"/cmaf/continuation.mp4", longTrackSegmentsJSON); err != nil {
			t.Fatalf("insert continuation asset %d: %v", index, err)
		}
	}

	firstPage, pagination, err := srv.searchLibraryTracks(ctx, "continuationfixture", 1, "")
	if err != nil {
		t.Fatalf("load first continuation page: %v", err)
	}
	if len(firstPage) != 20 || !pagination.HasNext || pagination.NextCursor == "" {
		t.Fatalf("first continuation page tracks=%d pagination=%+v", len(firstPage), pagination)
	}
	initialIDs := make([]string, 0, len(firstPage))
	for _, track := range firstPage {
		initialIDs = append(initialIDs, track.ExternalID)
	}
	seed, err := srv.loadPlaybackSeedTracks(ctx, initialIDs)
	if err != nil {
		t.Fatalf("load continuation seed: %v", err)
	}
	request := createPlaybackSessionRequest{
		Source:             playbackSessionSource{Kind: "search", Query: "continuationfixture"},
		InitialExternalIDs: initialIDs,
		CurrentExternalID:  initialIDs[0],
		CurrentIndex:       0,
		Cursor:             pagination.NextCursor,
		Page:               1,
		HasMore:            true,
	}
	state := playbackSourceState{Cursor: request.Cursor, Page: request.Page, HasMore: request.HasMore}
	created, err := srv.insertPlaybackSession(ctx, userID, request, state, seed)
	if err != nil {
		t.Fatalf("insert continuation session: %v", err)
	}
	if err := srv.ensurePlaybackHorizon(ctx, created.ID, userID); err != nil {
		t.Fatalf("continue playback horizon: %v", err)
	}
	record, items, err := srv.loadPlaybackSession(ctx, created.ID, userID, false)
	if err != nil {
		t.Fatalf("load continued session: %v", err)
	}
	if len(items) != 25 {
		t.Fatalf("continued session items=%d; want 25", len(items))
	}
	if record.SourceState.HasMore {
		t.Fatalf("continued session still reports another search page: %+v", record.SourceState)
	}
	if duration := items[len(items)-1].TimelineStartMS + items[len(items)-1].DurationMS; duration < int64(2*time.Hour/time.Millisecond) {
		t.Fatalf("continued duration=%dms; want at least 2h", duration)
	}
}

func TestPlaybackDeltaLoadsOnlyRequiredSuffix(t *testing.T) {
	db := newLifecycleTestDB(t)
	ctx := context.Background()
	srv := &Server{db: db}
	userID := uuid.NewString()
	if _, err := db.Exec(ctx, `
		INSERT INTO users(id,email,password_hash,role,active,access_status)
		VALUES($1,'delta-suffix@example.com','','listener',TRUE,'active')
	`, userID); err != nil {
		t.Fatalf("insert delta user: %v", err)
	}
	insertSearchTrack(t, db, searchTrackFixture{
		externalID: "delta-suffix-track",
		title:      "Delta suffix",
		artist:     "Playback Test",
		createdAt:  time.Date(2026, 8, 17, 14, 0, 0, 0, time.UTC),
	})
	var trackID string
	if err := db.QueryRow(ctx, `
		SELECT id::text FROM library_tracks WHERE external_track_id='delta-suffix-track'
	`).Scan(&trackID); err != nil {
		t.Fatalf("load delta track: %v", err)
	}
	var assetID string
	if err := db.QueryRow(ctx, `
		INSERT INTO track_playback_assets(
			track_id,object_key,init_offset,init_length,segments,duration_ms,target_duration,status
		) VALUES(
			$1,$2,0,64,'[{"offset":64,"length":128,"duration_ms":6000}]',6000,6,'ready'
		) RETURNING id::text
	`, trackID, "playback/"+trackID+"/cmaf/delta.mp4").Scan(&assetID); err != nil {
		t.Fatalf("insert delta asset: %v", err)
	}
	var sessionID string
	if err := db.QueryRow(ctx, `
		INSERT INTO playback_sessions(user_id,source_kind,source_state,status,last_fetched_media_sequence)
		VALUES($1,'search','{"has_more":true}','active',99)
		RETURNING id::text
	`, userID).Scan(&sessionID); err != nil {
		t.Fatalf("insert delta session: %v", err)
	}
	snapshot, err := json.Marshal(models.Track{
		ID: trackID, ExternalID: "delta-suffix-track", Title: "Delta suffix", Status: "ready",
	})
	if err != nil {
		t.Fatalf("encode delta track snapshot: %v", err)
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO playback_session_items(
			session_id,ordinal,track_id,hls_asset_id,track_snapshot,first_media_sequence,
			segment_count,timeline_start_ms,duration_ms
		)
		SELECT $1,ordinal,NULL,$2,$3,ordinal,1,ordinal*6000,6000
		FROM generate_series(0,99) ordinal
	`, sessionID, assetID, snapshot); err != nil {
		t.Fatalf("insert long delta timeline: %v", err)
	}

	items, err := srv.loadPlaybackManifestItems(ctx, sessionID, true, 100)
	if err != nil {
		t.Fatalf("load delta suffix: %v", err)
	}
	if len(items) != playbackManifestTailSegmentNum || items[0].Ordinal != 88 || items[len(items)-1].Ordinal != 99 {
		t.Fatalf("delta suffix ordinals=%d..%d count=%d; want 88..99 count=%d",
			items[0].Ordinal, items[len(items)-1].Ordinal, len(items), playbackManifestTailSegmentNum)
	}
	record, err := srv.loadPlaybackSessionRecord(ctx, sessionID, userID)
	if err != nil {
		t.Fatalf("load delta record: %v", err)
	}
	manifest, err := renderPlaybackManifest(record, items, true, 100)
	if err != nil {
		t.Fatalf("render delta suffix: %v", err)
	}
	if !strings.Contains(manifest, "#EXT-X-SKIP:SKIPPED-SEGMENTS=88\n") ||
		strings.Count(manifest, "#EXTINF:") != playbackManifestTailSegmentNum {
		t.Fatalf("delta suffix manifest is invalid:\n%s", manifest)
	}

	if _, err := db.Exec(ctx, `
		UPDATE playback_sessions SET source_state='{"has_more":false}' WHERE id=$1
	`, sessionID); err != nil {
		t.Fatalf("finish delta source: %v", err)
	}
	endedRecord, err := srv.loadPlaybackSessionRecord(ctx, sessionID, userID)
	if err != nil {
		t.Fatalf("load ended delta record: %v", err)
	}
	deltaEligible := playbackSessionIsEventActive(endedRecord)
	if deltaEligible {
		t.Fatal("ended search session remained eligible for a delta suffix")
	}
	endedItems, err := srv.loadPlaybackManifestItems(
		ctx,
		sessionID,
		deltaEligible,
		100,
	)
	if err != nil {
		t.Fatalf("load ended delta history: %v", err)
	}
	if len(endedItems) != 100 || endedItems[0].Ordinal != 0 || endedItems[len(endedItems)-1].Ordinal != 99 {
		t.Fatalf("ended delta history ordinals=%d..%d count=%d; want 0..99 count=100",
			endedItems[0].Ordinal, endedItems[len(endedItems)-1].Ordinal, len(endedItems))
	}
	endedManifest, err := renderPlaybackManifest(endedRecord, endedItems, true, 100)
	if err != nil {
		t.Fatalf("render ended delta history: %v", err)
	}
	if !strings.Contains(endedManifest, "#EXT-X-ENDLIST\n") ||
		strings.Contains(endedManifest, "#EXT-X-SKIP:") ||
		strings.Count(endedManifest, "#EXTINF:") != 100 {
		t.Fatalf("ended delta history was truncated:\n%s", endedManifest)
	}
}

func TestShuffleContinuationRollsOverCompleteCycle(t *testing.T) {
	db := newLifecycleTestDB(t)
	ctx := context.Background()
	srv := &Server{db: db}
	externalIDs := []string{"shuffle-excluded", "shuffle-second", "shuffle-third"}
	for index, externalID := range externalIDs {
		insertSearchTrack(t, db, searchTrackFixture{
			externalID: externalID,
			title:      "Shuffle rollover " + strconv.Itoa(index),
			artist:     "Playback Test",
			createdAt:  time.Date(2026, 8, 17, 13, 0, 0, index, time.UTC),
		})
	}
	record := playbackSessionRecord{
		SourceKind: "shuffle",
		SourceState: playbackSourceState{
			Page:              1,
			HasMore:           true,
			ExcludeExternalID: externalIDs[0],
			Cycle:             4,
		},
	}
	firstCycle, nextState, err := srv.fetchPlaybackContinuation(ctx, record)
	if err != nil {
		t.Fatalf("fetch first shuffle cycle: %v", err)
	}
	if len(firstCycle) != 2 || nextState.Cursor != "" || !nextState.HasMore ||
		nextState.Cycle != 5 || nextState.ExcludeExternalID != "" {
		t.Fatalf("first shuffle rollover tracks=%d state=%+v", len(firstCycle), nextState)
	}
	for _, track := range firstCycle {
		if track.ExternalID == externalIDs[0] {
			t.Fatalf("initial shuffle cycle returned excluded track: %+v", firstCycle)
		}
	}
	record.SourceState = nextState
	secondCycle, secondState, err := srv.fetchPlaybackContinuation(ctx, record)
	if err != nil {
		t.Fatalf("fetch second shuffle cycle: %v", err)
	}
	if len(secondCycle) != 3 || secondState.Cycle != 6 {
		t.Fatalf("second shuffle rollover tracks=%d state=%+v", len(secondCycle), secondState)
	}
	if !containsExternalID(secondCycle, externalIDs[0]) {
		t.Fatalf("later shuffle cycle still excluded current track: %+v", secondCycle)
	}
}

func TestShuffleRecreatedSessionDeduplicatesStaleCursorWithinCycle(t *testing.T) {
	db := newLifecycleTestDB(t)
	ctx := context.Background()
	srv := &Server{db: db}
	srv.cfg.JWTSecret = "playback-shuffle-cycle-test-secret"
	userID := uuid.NewString()
	if _, err := db.Exec(ctx, `
		INSERT INTO users(id,email,password_hash,role,active,access_status)
		VALUES($1,'shuffle-session@example.com','','listener',TRUE,'active')
	`, userID); err != nil {
		t.Fatalf("insert shuffle session user: %v", err)
	}
	for index := 0; index < 3; index++ {
		externalID := "shuffle-session-" + strconv.Itoa(index)
		insertSearchTrack(t, db, searchTrackFixture{
			externalID: externalID,
			title:      "Shuffle session " + strconv.Itoa(index),
			artist:     "Playback Test",
			createdAt:  time.Date(2026, 8, 17, 14, 0, 0, index, time.UTC),
		})
	}

	rows, err := db.Query(ctx, `
		SELECT id::text,external_track_id
		FROM library_tracks
		WHERE external_track_id LIKE 'shuffle-session-%'
		ORDER BY id
	`)
	if err != nil {
		t.Fatalf("load ordered shuffle tracks: %v", err)
	}
	orderedIDs := make([]string, 0, 3)
	orderedExternalIDs := make([]string, 0, 3)
	for rows.Next() {
		var trackID, externalID string
		if err := rows.Scan(&trackID, &externalID); err != nil {
			rows.Close()
			t.Fatalf("scan ordered shuffle track: %v", err)
		}
		orderedIDs = append(orderedIDs, trackID)
		orderedExternalIDs = append(orderedExternalIDs, externalID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		t.Fatalf("iterate ordered shuffle tracks: %v", err)
	}
	rows.Close()
	if len(orderedIDs) != 3 {
		t.Fatalf("ordered shuffle tracks=%d; want 3", len(orderedIDs))
	}
	for _, trackID := range orderedIDs {
		if _, err := db.Exec(ctx, `
			INSERT INTO track_playback_assets(
				track_id,object_key,init_offset,init_length,segments,duration_ms,target_duration,status
			) VALUES($1,$2,0,64,'[{"offset":64,"length":128,"duration_ms":6000}]',6000,6,'ready')
		`, trackID, "playback/"+trackID+"/cmaf/shuffle-session.mp4"); err != nil {
			t.Fatalf("insert shuffle playback asset: %v", err)
		}
	}

	// This cursor starts before the seed item. It models restoring a queue
	// after its previous server session expired with an older continuation.
	staleCursor, err := srv.encodeShuffleCursor(shuffleCursor{
		Version: shuffleCursorVersion,
		Anchor:  orderedIDs[0],
		After:   orderedIDs[0],
		Phase:   0,
	})
	if err != nil {
		t.Fatalf("encode stale shuffle cursor: %v", err)
	}
	seed, err := srv.loadPlaybackSeedTracks(ctx, orderedExternalIDs[:2])
	if err != nil {
		t.Fatalf("load recreated shuffle seed: %v", err)
	}
	request := createPlaybackSessionRequest{
		Source:             playbackSessionSource{Kind: "shuffle"},
		InitialExternalIDs: orderedExternalIDs[:2],
		CurrentExternalID:  orderedExternalIDs[1],
		CurrentIndex:       1,
		Cursor:             staleCursor,
		Page:               1,
		HasMore:            true,
	}
	state := playbackSourceState{Cursor: staleCursor, Page: 1, HasMore: true}
	created, err := srv.insertPlaybackSession(ctx, userID, request, state, seed)
	if err != nil {
		t.Fatalf("insert recreated shuffle session: %v", err)
	}

	record, _, err := srv.loadPlaybackSession(ctx, created.ID, userID, false)
	if err != nil {
		t.Fatalf("load recreated shuffle session: %v", err)
	}
	tracks, nextState, err := srv.fetchPlaybackContinuation(ctx, record)
	if err != nil {
		t.Fatalf("fetch stale-cursor continuation: %v", err)
	}
	if nextState.Cycle != 1 {
		t.Fatalf("stale-cursor next cycle=%d; want 1", nextState.Cycle)
	}
	continuation, err := srv.loadPlaybackTracksIgnoringMissing(ctx, tracks)
	if err != nil {
		t.Fatalf("load stale-cursor continuation assets: %v", err)
	}
	if err := srv.appendPlaybackContinuation(ctx, record, nextState, continuation); err != nil {
		t.Fatalf("append stale-cursor continuation: %v", err)
	}

	var firstCycleItems, firstCycleDistinct, maxOrdinal int
	if err := db.QueryRow(ctx, `
		SELECT COUNT(*),COUNT(DISTINCT track_id),MAX(ordinal)
		FROM playback_session_items
		WHERE session_id=$1 AND cycle_no=0
	`, created.ID).Scan(&firstCycleItems, &firstCycleDistinct, &maxOrdinal); err != nil {
		t.Fatalf("count first shuffle cycle: %v", err)
	}
	if firstCycleItems != 3 || firstCycleDistinct != 3 || maxOrdinal != 2 {
		t.Fatalf("first cycle items=%d distinct=%d maxOrdinal=%d; want 3/3/2",
			firstCycleItems, firstCycleDistinct, maxOrdinal)
	}

	// The same tracks are valid again after rollover, but still only once in
	// that new cycle.
	record, _, err = srv.loadPlaybackSession(ctx, created.ID, userID, false)
	if err != nil {
		t.Fatalf("reload rolled-over shuffle session: %v", err)
	}
	tracks, nextState, err = srv.fetchPlaybackContinuation(ctx, record)
	if err != nil {
		t.Fatalf("fetch second shuffle cycle: %v", err)
	}
	continuation, err = srv.loadPlaybackTracksIgnoringMissing(ctx, tracks)
	if err != nil {
		t.Fatalf("load second-cycle continuation assets: %v", err)
	}
	if err := srv.appendPlaybackContinuation(ctx, record, nextState, continuation); err != nil {
		t.Fatalf("append second shuffle cycle: %v", err)
	}
	var secondCycleItems, secondCycleDistinct, repeatedAcrossCycles int
	if err := db.QueryRow(ctx, `
		SELECT
			COUNT(*) FILTER (WHERE cycle_no=1),
			COUNT(DISTINCT track_id) FILTER (WHERE cycle_no=1),
			COUNT(*) FILTER (WHERE track_id=$2)
		FROM playback_session_items
		WHERE session_id=$1
	`, created.ID, orderedIDs[1]).Scan(&secondCycleItems, &secondCycleDistinct, &repeatedAcrossCycles); err != nil {
		t.Fatalf("count second shuffle cycle: %v", err)
	}
	if secondCycleItems != 3 || secondCycleDistinct != 3 || repeatedAcrossCycles != 2 {
		t.Fatalf("second cycle items=%d distinct=%d repeated=%d; want 3/3/2",
			secondCycleItems, secondCycleDistinct, repeatedAcrossCycles)
	}
}

func newTestRequest(t *testing.T, method, target string) *http.Request {
	t.Helper()
	request, err := http.NewRequest(method, target, nil)
	if err != nil {
		t.Fatalf("create request: %v", err)
	}
	return request
}
