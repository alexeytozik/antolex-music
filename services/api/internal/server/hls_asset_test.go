package server

import (
	"bufio"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestParseCMAFPlaylist(t *testing.T) {
	playlist := `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MAP:URI="audio.mp4",BYTERANGE="765@0"
#EXTINF:10.005333,
#EXT-X-BYTERANGE:301930@765
audio.mp4
#EXTINF:3.010667,
#EXT-X-BYTERANGE:91568
audio.mp4
#EXT-X-ENDLIST
`
	index, err := parseCMAFPlaylistLines(
		bufio.NewScanner(strings.NewReader(playlist)),
		"audio.mp4",
		394263,
	)
	if err != nil {
		t.Fatalf("parse playlist: %v", err)
	}
	if index.InitOffset != 0 || index.InitLength != 765 {
		t.Fatalf("unexpected init range: %d@%d", index.InitLength, index.InitOffset)
	}
	if index.TargetDuration != 11 || index.DurationMS != 13016 {
		t.Fatalf("unexpected durations: target=%d total=%d", index.TargetDuration, index.DurationMS)
	}
	if len(index.Segments) != 2 {
		t.Fatalf("got %d segments, want 2", len(index.Segments))
	}
	if got := index.Segments[1]; got.Offset != 302695 || got.Length != 91568 || got.DurationMS != 3011 {
		t.Fatalf("unexpected second segment: %+v", got)
	}
	encoded, err := index.segmentsJSON()
	if err != nil {
		t.Fatalf("encode segments: %v", err)
	}
	if string(encoded) != `[{"offset":765,"length":301930,"duration_ms":10005},{"offset":302695,"length":91568,"duration_ms":3011}]` {
		t.Fatalf("unexpected JSON: %s", encoded)
	}
}

func TestParseCMAFPlaylistRejectsUnsafeOrInconsistentRanges(t *testing.T) {
	tests := []struct {
		name       string
		playlist   string
		objectSize int64
		want       string
	}{
		{
			name: "wrong media URI",
			playlist: `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-MAP:URI="other.mp4",BYTERANGE="10@0"
#EXTINF:1,
#EXT-X-BYTERANGE:10@10
other.mp4
#EXT-X-ENDLIST`,
			objectSize: 20,
			want:       "unexpected media URI",
		},
		{
			name: "gap between ranges",
			playlist: `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-MAP:URI="audio.mp4",BYTERANGE="10@0"
#EXTINF:1,
#EXT-X-BYTERANGE:10@11
audio.mp4
#EXT-X-ENDLIST`,
			objectSize: 21,
			want:       "non-contiguous segment range",
		},
		{
			name: "range exceeds object",
			playlist: `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-MAP:URI="audio.mp4",BYTERANGE="10@0"
#EXTINF:1,
#EXT-X-BYTERANGE:11@10
audio.mp4
#EXT-X-ENDLIST`,
			objectSize: 20,
			want:       "exceeds media object",
		},
		{
			name: "missing end list",
			playlist: `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-MAP:URI="audio.mp4",BYTERANGE="10@0"
#EXTINF:1,
#EXT-X-BYTERANGE:10@10
audio.mp4`,
			objectSize: 20,
			want:       "playlist is incomplete",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := parseCMAFPlaylistLines(
				bufio.NewScanner(strings.NewReader(test.playlist)),
				"audio.mp4",
				test.objectSize,
			)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("got error %v, want substring %q", err, test.want)
			}
		})
	}
}

func TestPackageCMAFProducesSingleByteRangeObject(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is required")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe is required")
	}
	directory := t.TempDir()
	inputPath := filepath.Join(directory, "source.m4a")
	command := exec.Command(
		"ffmpeg",
		"-v", "error",
		"-y",
		"-f", "lavfi",
		"-i", "sine=frequency=440:duration=23",
		"-c:a", "aac",
		"-profile:a", "aac_low",
		"-b:a", "256k",
		inputPath,
	)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("create audio fixture: %v: %s", err, output)
	}

	asset, err := packageCMAF(context.Background(), inputPath)
	if err != nil {
		t.Fatalf("package CMAF: %v", err)
	}
	defer asset.Cleanup()
	info, err := os.Stat(asset.MediaPath)
	if err != nil {
		t.Fatalf("stat media: %v", err)
	}
	if info.Size() < 1 || len(asset.Index.Segments) != 4 {
		t.Fatalf("unexpected packaged asset: size=%d segments=%d", info.Size(), len(asset.Index.Segments))
	}
	last := asset.Index.Segments[len(asset.Index.Segments)-1]
	if last.Offset+last.Length != info.Size() {
		t.Fatalf("last byte range ends at %d, object size is %d", last.Offset+last.Length, info.Size())
	}
}

func TestPackageCMAFSupportsMobileAudioInputs(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is required")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe is required")
	}
	tests := []struct {
		name               string
		extension          string
		sourceCodec        string
		sourceSampleRate   string
		sourceChannels     string
		packagedSampleRate string
		packagedChannels   string
	}{
		{
			name: "AAC mono 44.1 kHz", extension: ".m4a", sourceCodec: "aac",
			sourceSampleRate: "44100", sourceChannels: "1",
			packagedSampleRate: "44100", packagedChannels: "1",
		},
		{
			name: "AAC stereo 48 kHz", extension: ".m4a", sourceCodec: "aac",
			sourceSampleRate: "48000", sourceChannels: "2",
			packagedSampleRate: "48000", packagedChannels: "2",
		},
		{
			name: "AAC unsupported sample rate", extension: ".m4a", sourceCodec: "aac",
			sourceSampleRate: "32000", sourceChannels: "1",
			packagedSampleRate: "48000", packagedChannels: "2",
		},
		{
			name: "MP3 legacy source", extension: ".mp3", sourceCodec: "libmp3lame",
			sourceSampleRate: "44100", sourceChannels: "2",
			packagedSampleRate: "48000", packagedChannels: "2",
		},
		{
			name: "FLAC legacy source", extension: ".flac", sourceCodec: "flac",
			sourceSampleRate: "48000", sourceChannels: "2",
			packagedSampleRate: "48000", packagedChannels: "2",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			directory := t.TempDir()
			inputPath := filepath.Join(directory, "source"+test.extension)
			command := exec.Command(
				"ffmpeg",
				"-v", "error",
				"-y",
				"-f", "lavfi",
				"-i", "sine=frequency=440:duration=13",
				"-c:a", test.sourceCodec,
				"-ar", test.sourceSampleRate,
				"-ac", test.sourceChannels,
				inputPath,
			)
			if output, err := command.CombinedOutput(); err != nil {
				t.Fatalf("create %s fixture: %v: %s", test.name, err, output)
			}

			asset, err := packageCMAF(context.Background(), inputPath)
			if err != nil {
				t.Fatalf("package %s: %v", test.name, err)
			}
			defer asset.Cleanup()
			info, err := os.Stat(asset.MediaPath)
			if err != nil {
				t.Fatalf("stat packaged %s: %v", test.name, err)
			}
			if len(asset.Index.Segments) < 2 {
				t.Fatalf("packaged %s segments=%d; want at least 2", test.name, len(asset.Index.Segments))
			}
			expectedOffset := asset.Index.InitOffset + asset.Index.InitLength
			var maxDurationMS int64
			for index, segment := range asset.Index.Segments {
				if segment.Offset != expectedOffset {
					t.Fatalf("%s segment %d offset=%d; want %d", test.name, index, segment.Offset, expectedOffset)
				}
				expectedOffset += segment.Length
				maxDurationMS = max(maxDurationMS, segment.DurationMS)
			}
			if expectedOffset != info.Size() {
				t.Fatalf("%s byte coverage=%d; object size=%d", test.name, expectedOffset, info.Size())
			}
			expectedTargetDuration := int((maxDurationMS + 999) / 1000)
			if asset.Index.TargetDuration != expectedTargetDuration {
				t.Fatalf(
					"%s target duration=%d; want ceil(max)=%d",
					test.name, asset.Index.TargetDuration, expectedTargetDuration,
				)
			}
			stream := probeTestAudioStream(t, asset.MediaPath)
			if stream["codec_name"] != "aac" ||
				stream["sample_rate"] != test.packagedSampleRate ||
				stream["channels"] != test.packagedChannels {
				t.Fatalf("%s packaged stream=%v", test.name, stream)
			}
		})
	}
}

func TestDynamicPlaybackManifestDecodesAcrossThreeCMAFAssets(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is required")
	}

	directory := t.TempDir()
	items := make([]playbackSessionItem, 0, 3)
	mediaPaths := make(map[string]string, 3)
	firstSequence := int64(0)
	for index, frequency := range []int{330, 440, 550} {
		inputPath := filepath.Join(directory, fmt.Sprintf("source-%d.m4a", index))
		command := exec.Command(
			"ffmpeg",
			"-v", "error",
			"-y",
			"-f", "lavfi",
			"-i", fmt.Sprintf("sine=frequency=%d:duration=2", frequency),
			"-c:a", "aac",
			"-profile:a", "aac_low",
			"-b:a", "128k",
			"-ar", "48000",
			"-ac", "2",
			inputPath,
		)
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("create source %d: %v: %s", index, err, output)
		}

		packaged, err := packageCMAF(context.Background(), inputPath)
		if err != nil {
			t.Fatalf("package source %d: %v", index, err)
		}
		defer packaged.Cleanup()
		segments := make([]playbackSegment, len(packaged.Index.Segments))
		for segmentIndex, segment := range packaged.Index.Segments {
			segments[segmentIndex] = playbackSegment(segment)
		}
		item := manifestTestItem(index, firstSequence, segments)
		item.Asset.InitOffset = packaged.Index.InitOffset
		item.Asset.InitLength = packaged.Index.InitLength
		item.Asset.DurationMS = packaged.Index.DurationMS
		item.Asset.TargetDuration = packaged.Index.TargetDuration
		item.DurationMS = packaged.Index.DurationMS
		items = append(items, item)
		assetPath := fmt.Sprintf("/assets/0/%d.mp4", index)
		mediaPaths[assetPath] = packaged.MediaPath
		firstSequence += int64(len(segments))
	}

	record := playbackSessionRecord{
		SourceKind:  "search",
		SourceState: playbackSourceState{HasMore: false},
	}
	manifest, err := renderPlaybackManifest(record, items, false, 0)
	if err != nil {
		t.Fatalf("render playback manifest: %v", err)
	}
	if count := strings.Count(manifest, "#EXT-X-DISCONTINUITY\n"); count != 2 {
		t.Fatalf("manifest discontinuities=%d; want 2\n%s", count, manifest)
	}
	if count := strings.Count(manifest, "#EXT-X-MAP:"); count != 3 {
		t.Fatalf("manifest maps=%d; want 3\n%s", count, manifest)
	}

	var requestsMu sync.Mutex
	rangedAssets := make(map[string]bool, 3)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/index.m3u8" {
			response.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			_, _ = response.Write([]byte(manifest))
			return
		}
		mediaPath, ok := mediaPaths[request.URL.Path]
		if !ok {
			http.NotFound(response, request)
			return
		}
		media, err := os.Open(mediaPath)
		if err != nil {
			http.Error(response, err.Error(), http.StatusInternalServerError)
			return
		}
		defer media.Close()
		info, err := media.Stat()
		if err != nil {
			http.Error(response, err.Error(), http.StatusInternalServerError)
			return
		}
		if request.Header.Get("Range") != "" {
			requestsMu.Lock()
			rangedAssets[request.URL.Path] = true
			requestsMu.Unlock()
		}
		response.Header().Set("Content-Type", "audio/mp4")
		http.ServeContent(response, request, info.Name(), info.ModTime(), media)
	}))
	defer server.Close()

	command := exec.Command(
		"ffmpeg",
		"-v", "error",
		"-i", server.URL+"/index.m3u8",
		"-map", "0:a:0",
		"-f", "null",
		"-",
	)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("decode dynamic playback manifest: %v: %s\n%s", err, output, manifest)
	}
	requestsMu.Lock()
	defer requestsMu.Unlock()
	for assetPath := range mediaPaths {
		if !rangedAssets[assetPath] {
			t.Fatalf("ffmpeg did not request byte ranges from %s; ranged=%v", assetPath, rangedAssets)
		}
	}
}

func probeTestAudioStream(t *testing.T, filePath string) map[string]string {
	t.Helper()
	command := exec.Command(
		"ffprobe",
		"-v", "error",
		"-select_streams", "a:0",
		"-show_entries", "stream=codec_name,sample_rate,channels",
		"-of", "default=noprint_wrappers=1",
		filePath,
	)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("probe packaged stream: %v: %s", err, output)
	}
	values := make(map[string]string)
	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			t.Fatalf("unexpected ffprobe line %q in %s", line, fmt.Sprintf("%q", output))
		}
		values[key] = value
	}
	return values
}
