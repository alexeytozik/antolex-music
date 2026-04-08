export type Track = {
  external_id: string;
  title: string;
  artist: string;
  cover_url: string;
  source_page_url?: string;
  stream_url?: string;
  duration_seconds: number;
};

export type Pagination = {
  page: number;
  page_size: number;
  total_count: number;
  total_pages: number;
  has_prev: boolean;
  has_next: boolean;
  next_cursor?: string;
};

export type SearchResponse = {
  query: string;
  source: string;
  cached: boolean;
  results: Track[];
} & Pagination;

export type LikesResponse = {
  results: Track[];
} & Pagination;

export type UploadTrackResponse = {
  track: Track;
};

export type User = {
  id: string;
  email: string;
  created_at: string;
};

export type AuthSession = {
  token: string;
  user: User;
  session_expires_at: string;
};

export type APIErrorPayload = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export type APIErrorResponse = {
  error: APIErrorPayload;
};
