package models

import "time"

type User struct {
	ID           string    `json:"id"`
	Email        string    `json:"email"`
	PasswordHash string    `json:"-"`
	CreatedAt    time.Time `json:"created_at"`
}

type Track struct {
	ExternalID      string `json:"external_id"`
	Title           string `json:"title"`
	Artist          string `json:"artist"`
	CoverURL        string `json:"cover_url"`
	SourcePageURL   string `json:"source_page_url,omitempty"`
	StreamURL       string `json:"stream_url,omitempty"`
	DurationSeconds int    `json:"duration_seconds"`
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
