package models

import "time"

const (
	AccessStatusPending = "pending"
	AccessStatusActive  = "active"
	AccessStatusBlocked = "blocked"
)

type User struct {
	ID           string    `json:"id"`
	Email        string    `json:"email"`
	Active       bool      `json:"active"`
	AccessStatus string    `json:"access_status"`
	IsAdmin      bool      `json:"is_admin"`
	CreatedAt    time.Time `json:"created_at"`
}

type AdminUser struct {
	ID           string    `json:"id"`
	Email        string    `json:"email"`
	AccessStatus string    `json:"access_status"`
	IsAdmin      bool      `json:"is_admin"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

type Track struct {
	ID              string    `json:"id,omitempty"`
	ExternalID      string    `json:"external_id"`
	Title           string    `json:"title"`
	Artist          string    `json:"artist"`
	Album           string    `json:"album,omitempty"`
	Status          string    `json:"status,omitempty"`
	Error           string    `json:"error,omitempty"`
	CoverURL        string    `json:"cover_url"`
	SourcePageURL   string    `json:"source_page_url,omitempty"`
	StreamURL       string    `json:"stream_url,omitempty"`
	DurationSeconds int       `json:"duration_seconds"`
	CreatedAt       time.Time `json:"created_at,omitempty"`
}

type Pagination struct {
	Page       int    `json:"page"`
	PageSize   int    `json:"page_size"`
	TotalCount int    `json:"total_count"`
	TotalPages int    `json:"total_pages"`
	HasPrev    bool   `json:"has_prev"`
	HasNext    bool   `json:"has_next"`
	NextCursor string `json:"next_cursor,omitempty"`
}

type SearchResponse struct {
	Query   string  `json:"query"`
	Source  string  `json:"source"`
	Cached  bool    `json:"cached"`
	Results []Track `json:"results"`
	Pagination
}

type LikesResponse struct {
	Results []Track `json:"results"`
	Pagination
}

type ShuffleResponse struct {
	Results       []Track `json:"results"`
	HasNext       bool    `json:"has_next"`
	NextCursor    string  `json:"next_cursor,omitempty"`
	CycleComplete bool    `json:"cycle_complete"`
}
