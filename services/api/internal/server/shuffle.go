package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/alexeytozik/antolex-music/services/api/internal/models"
)

const (
	shuffleCursorVersion = 1
	shufflePageSize      = 20
	maxShuffleExcludeLen = 512
)

type shuffleCursor struct {
	Version  int    `json:"v"`
	Anchor   string `json:"anchor"`
	After    string `json:"after"`
	Phase    int    `json:"phase"`
	Excluded string `json:"excluded,omitempty"`
}

func (s *Server) shuffle(c *fiber.Ctx) error {
	c.Set(fiber.HeaderCacheControl, "private, no-store")
	ctx := c.UserContext()
	rawCursor := strings.TrimSpace(c.Query("cursor"))
	requestedExclude := strings.TrimSpace(c.Query("exclude"))
	if len(requestedExclude) > maxShuffleExcludeLen {
		return writeAPIError(c, fiber.StatusBadRequest, "invalid_shuffle_request", "exclude is too long", nil)
	}

	var cursor shuffleCursor
	if rawCursor == "" {
		anchor, err := s.chooseShuffleAnchor(ctx)
		if errors.Is(err, pgx.ErrNoRows) {
			return c.JSON(models.ShuffleResponse{Results: []models.Track{}, CycleComplete: true})
		}
		if err != nil {
			return fiber.NewError(fiber.StatusInternalServerError, "failed to start shuffle")
		}
		cursor = shuffleCursor{
			Version:  shuffleCursorVersion,
			Anchor:   anchor,
			Phase:    0,
			Excluded: requestedExclude,
		}
	} else {
		var err error
		cursor, err = s.decodeShuffleCursor(rawCursor)
		if err != nil {
			return writeAPIError(c, fiber.StatusBadRequest, "invalid_shuffle_cursor", "shuffle cursor is invalid", nil)
		}
		if requestedExclude != "" && requestedExclude != cursor.Excluded {
			return writeAPIError(c, fiber.StatusBadRequest, "shuffle_cursor_mismatch", "exclude does not match the shuffle cycle", nil)
		}
	}

	tracks, next, err := s.listShuffleTracks(ctx, cursor, shufflePageSize)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "failed to load shuffle tracks")
	}

	response := models.ShuffleResponse{
		Results:       sanitizeTracks(tracks),
		HasNext:       next != nil,
		CycleComplete: next == nil,
	}
	if next != nil {
		response.NextCursor, err = s.encodeShuffleCursor(*next)
		if err != nil {
			return fiber.NewError(fiber.StatusInternalServerError, "failed to encode shuffle cursor")
		}
	}
	return c.JSON(response)
}

// chooseShuffleAnchor finds the first ready UUID at or after a random UUID. UUIDv4
// primary keys are already uniformly distributed, so this selects a random point
// on the indexed UUID ring without sorting the whole library by random().
func (s *Server) chooseShuffleAnchor(ctx context.Context) (string, error) {
	if s.db == nil {
		return "", pgx.ErrNoRows
	}
	candidate := uuid.NewString()
	var anchor string
	err := s.db.QueryRow(ctx, `
		SELECT track.id::text FROM library_tracks AS track
		WHERE track.status = 'ready' AND track.id >= $1::uuid
		ORDER BY track.id ASC LIMIT 1
	`, candidate).Scan(&anchor)
	if err == nil {
		return anchor, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	err = s.db.QueryRow(ctx, `
		SELECT track.id::text FROM library_tracks AS track
		WHERE track.status = 'ready'
		ORDER BY track.id ASC LIMIT 1
	`).Scan(&anchor)
	return anchor, err
}

func (s *Server) listShuffleTracks(
	ctx context.Context,
	cursor shuffleCursor,
	limit int,
) ([]models.Track, *shuffleCursor, error) {
	if s.db == nil || limit < 1 {
		return []models.Track{}, nil, nil
	}

	results := make([]models.Track, 0, limit+1)
	phase := cursor.Phase
	after := cursor.After
	for len(results) <= limit && phase <= 1 {
		phaseLimit := limit + 1 - len(results)
		page, err := s.queryShufflePhase(ctx, cursor.Anchor, after, phase, cursor.Excluded, phaseLimit)
		if err != nil {
			return nil, nil, err
		}
		results = append(results, page...)
		if len(results) > limit || len(page) == phaseLimit {
			break
		}
		phase++
		after = ""
	}

	if len(results) == 0 {
		return results, nil, nil
	}

	hasNext := len(results) > limit
	if hasNext {
		results = results[:limit]
	}
	for index := range results {
		results[index].Status = "ready"
		results[index].CoverURL = libraryTrackCoverURL(results[index])
	}
	if !hasNext {
		return results, nil, nil
	}

	last := results[len(results)-1]
	lastPhase := 1
	if uuidLessOrEqual(cursor.Anchor, last.ID) {
		lastPhase = 0
	}
	next := cursor
	next.Phase = lastPhase
	next.After = last.ID
	return results, &next, nil
}

func (s *Server) queryShufflePhase(
	ctx context.Context,
	anchor string,
	after string,
	phase int,
	excluded string,
	limit int,
) ([]models.Track, error) {
	if limit < 1 {
		return []models.Track{}, nil
	}
	comparison := "track.id >= $1::uuid"
	if phase == 1 {
		comparison = "track.id < $1::uuid"
	}
	rows, err := s.db.Query(ctx, fmt.Sprintf(`
		SELECT track.id::text, track.external_track_id, track.title, track.artist,
		       track.album, track.duration_seconds, track.created_at
		FROM library_tracks AS track
		WHERE track.status = 'ready'
		  AND %s
		  AND (NULLIF($2, '') IS NULL OR track.id > NULLIF($2, '')::uuid)
		  AND ($3 = '' OR track.external_track_id <> $3)
		ORDER BY track.id ASC
		LIMIT $4
	`, comparison), anchor, after, excluded, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	tracks := make([]models.Track, 0, limit)
	for rows.Next() {
		var track models.Track
		if err := rows.Scan(
			&track.ID,
			&track.ExternalID,
			&track.Title,
			&track.Artist,
			&track.Album,
			&track.DurationSeconds,
			&track.CreatedAt,
		); err != nil {
			return nil, err
		}
		tracks = append(tracks, track)
	}
	return tracks, rows.Err()
}

func uuidLessOrEqual(left, right string) bool {
	leftUUID, leftErr := uuid.Parse(left)
	rightUUID, rightErr := uuid.Parse(right)
	if leftErr != nil || rightErr != nil {
		return false
	}
	return strings.Compare(string(leftUUID[:]), string(rightUUID[:])) <= 0
}

func (s *Server) encodeShuffleCursor(cursor shuffleCursor) (string, error) {
	payload, err := json.Marshal(cursor)
	if err != nil {
		return "", err
	}
	encodedPayload := base64.RawURLEncoding.EncodeToString(payload)
	signature := s.signShuffleCursor(encodedPayload)
	return encodedPayload + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

func (s *Server) decodeShuffleCursor(raw string) (shuffleCursor, error) {
	parts := strings.Split(raw, ".")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return shuffleCursor{}, errors.New("malformed cursor")
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || !hmac.Equal(signature, s.signShuffleCursor(parts[0])) {
		return shuffleCursor{}, errors.New("invalid cursor signature")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return shuffleCursor{}, errors.New("invalid cursor payload")
	}
	decoder := json.NewDecoder(strings.NewReader(string(payload)))
	decoder.DisallowUnknownFields()
	var cursor shuffleCursor
	if err := decoder.Decode(&cursor); err != nil {
		return shuffleCursor{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return shuffleCursor{}, errors.New("trailing cursor data")
	}
	if err := validateShuffleCursor(cursor); err != nil {
		return shuffleCursor{}, err
	}
	return cursor, nil
}

func validateShuffleCursor(cursor shuffleCursor) error {
	if cursor.Version != shuffleCursorVersion {
		return errors.New("unsupported cursor version")
	}
	if !isCanonicalUUID(cursor.Anchor) || !isCanonicalUUID(cursor.After) {
		return errors.New("invalid cursor uuid")
	}
	if cursor.Phase != 0 && cursor.Phase != 1 {
		return errors.New("invalid cursor phase")
	}
	if len(cursor.Excluded) > maxShuffleExcludeLen || strings.TrimSpace(cursor.Excluded) != cursor.Excluded {
		return errors.New("invalid cursor exclusion")
	}
	if cursor.Phase == 0 && !uuidLessOrEqual(cursor.Anchor, cursor.After) {
		return errors.New("phase zero cursor precedes anchor")
	}
	if cursor.Phase == 1 && uuidLessOrEqual(cursor.Anchor, cursor.After) {
		return errors.New("phase one cursor follows anchor")
	}
	return nil
}

func isCanonicalUUID(raw string) bool {
	parsed, err := uuid.Parse(raw)
	return err == nil && parsed.String() == raw
}

func (s *Server) signShuffleCursor(payload string) []byte {
	secret := strings.TrimSpace(s.cfg.JWTSecret)
	if secret == "" {
		secret = "antolex-development-shuffle-cursor"
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(payload))
	return mac.Sum(nil)
}
