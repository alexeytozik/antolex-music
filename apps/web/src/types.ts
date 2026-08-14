export type Track = {
  id?: string;
  external_id: string;
  title: string;
  artist: string;
  album?: string;
  cover_url: string;
  source_page_url?: string;
  stream_url?: string;
  duration_seconds: number;
  status?: "processing" | "ready" | "error" | "deleting";
  error?: string;
  created_at?: string;
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

export type ShuffleResponse = {
  results: Track[];
  has_next: boolean;
  next_cursor?: string;
  cycle_complete: boolean;
};

export type User = {
  id: string;
  email: string;
  active?: boolean;
  created_at: string;
};

export type AuthSession = {
  token?: string;
  user: User;
  session_expires_at: string;
};

export type UploadStatus =
  | "pending"
  | "uploading"
  | "paused"
  | "processing"
  | "ready"
  | "error"
  | "cancelled"
  | "deleting";

export type UploadedPart = {
  part_number: number;
  etag: string;
  size_bytes?: number;
};

export type UploadSession = {
  id: string;
  file_name: string;
  size_bytes: number;
  content_type: string;
  sha256: string;
  status: UploadStatus;
  part_size: number;
  parts_total?: number;
  uploaded_parts: UploadedPart[];
  track?: Track;
  error?: string;
  created_at?: string;
  expires_at?: string;
};

export type UploadSessionEnvelope =
  | UploadSession
  | { upload: UploadSession }
  | { session: UploadSession };

export type UploadListResponse =
  | UploadSession[]
  | { results: UploadSession[]; next_cursor?: string }
  | { uploads: UploadSession[]; next_cursor?: string };

export type UploadPartURL = {
  part_number: number;
  url?: string;
  upload_url?: string;
  headers?: Record<string, string>;
};

export type APIErrorPayload = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export type APIErrorResponse = {
  error: APIErrorPayload;
};
