package server

import "testing"

func TestFindAttachedArtworkStream(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		output    string
		wantIndex int
		wantFound bool
	}{
		{
			name:      "attached artwork",
			output:    `{"streams":[{"index":0,"disposition":{"attached_pic":0}},{"index":3,"disposition":{"attached_pic":1}}]}`,
			wantIndex: 3,
			wantFound: true,
		},
		{
			name:      "ordinary video is not artwork",
			output:    `{"streams":[{"index":1,"disposition":{"attached_pic":0}}]}`,
			wantIndex: 0,
			wantFound: false,
		},
		{
			name:      "audio only",
			output:    `{"streams":[{"index":0,"disposition":{"attached_pic":0}}]}`,
			wantIndex: 0,
			wantFound: false,
		},
		{
			name:      "no streams",
			output:    `{"streams":[]}`,
			wantIndex: 0,
			wantFound: false,
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			index, found, err := findAttachedArtworkStream([]byte(test.output))
			if err != nil {
				t.Fatalf("parse artwork streams: %v", err)
			}
			if index != test.wantIndex || found != test.wantFound {
				t.Fatalf("stream=(%d,%t); want (%d,%t)", index, found, test.wantIndex, test.wantFound)
			}
		})
	}
}

func TestFindAttachedArtworkStreamRejectsInvalidProbeOutput(t *testing.T) {
	t.Parallel()

	if _, _, err := findAttachedArtworkStream([]byte(`{"streams":`)); err == nil {
		t.Fatalf("expected malformed ffprobe output to fail")
	}
	if _, _, err := findAttachedArtworkStream([]byte(`{"streams":[{"index":-1,"disposition":{"attached_pic":1}}]}`)); err == nil {
		t.Fatalf("expected invalid stream index to fail")
	}
}
