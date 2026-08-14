package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path"
	"strconv"
	"strings"
)

type audioMetadata struct {
	Title           string
	Artist          string
	Album           string
	DurationSeconds int
}

type ffprobeOutput struct {
	Format struct {
		Duration string            `json:"duration"`
		Tags     map[string]string `json:"tags"`
	} `json:"format"`
}

type ffprobeArtworkOutput struct {
	Streams []struct {
		Index       int `json:"index"`
		Disposition struct {
			AttachedPic int `json:"attached_pic"`
		} `json:"disposition"`
	} `json:"streams"`
}

func extractAudioMetadataFromFile(ctx context.Context, filePath string) (audioMetadata, error) {
	if _, err := exec.LookPath("ffprobe"); err != nil {
		return audioMetadata{}, nil
	}

	cmd := exec.CommandContext(
		ctx,
		"ffprobe",
		"-v", "error",
		"-show_entries", "format=duration:format_tags=title,artist,album,album_artist,ARTIST,TITLE,ALBUM",
		"-of", "json",
		filePath,
	)

	output, err := cmd.Output()
	if err != nil {
		return audioMetadata{}, nil
	}

	var probe ffprobeOutput
	if err := json.Unmarshal(output, &probe); err != nil {
		return audioMetadata{}, nil
	}

	metadata := audioMetadata{
		Title:  firstNonEmptyTag(probe.Format.Tags, "title", "TITLE"),
		Artist: firstNonEmptyTag(probe.Format.Tags, "artist", "album_artist", "ARTIST"),
		Album:  firstNonEmptyTag(probe.Format.Tags, "album", "ALBUM"),
	}

	if seconds, err := strconvDuration(probe.Format.Duration); err == nil {
		metadata.DurationSeconds = seconds
	}

	return metadata, nil
}

func probeAudioFileStrict(ctx context.Context, filePath string) (audioMetadata, error) {
	if _, err := exec.LookPath("ffprobe"); err != nil {
		return audioMetadata{}, fmt.Errorf("ffprobe is not installed")
	}
	cmd := exec.CommandContext(ctx, "ffprobe", "-v", "error", "-show_entries", "format=duration:format_tags=title,artist,album,album_artist,ARTIST,TITLE,ALBUM", "-of", "json", filePath)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return audioMetadata{}, fmt.Errorf("invalid audio file: %w: %s", err, strings.TrimSpace(string(output)))
	}
	var probe ffprobeOutput
	if err := json.Unmarshal(output, &probe); err != nil {
		return audioMetadata{}, fmt.Errorf("decode ffprobe output: %w", err)
	}
	seconds, err := strconvDuration(probe.Format.Duration)
	if err != nil {
		return audioMetadata{}, fmt.Errorf("audio duration is missing or invalid")
	}
	return audioMetadata{
		Title:           firstNonEmptyTag(probe.Format.Tags, "title", "TITLE"),
		Artist:          firstNonEmptyTag(probe.Format.Tags, "artist", "album_artist", "ARTIST"),
		Album:           firstNonEmptyTag(probe.Format.Tags, "album", "ALBUM"),
		DurationSeconds: seconds,
	}, nil
}

func extractAudioArtworkFromFile(ctx context.Context, filePath string) (string, string, error) {
	if _, err := exec.LookPath("ffprobe"); err != nil {
		return "", "", fmt.Errorf("locate ffprobe: %w", err)
	}
	probeCmd := exec.CommandContext(
		ctx,
		"ffprobe",
		"-v", "error",
		"-show_entries", "stream=index:stream_disposition=attached_pic",
		"-of", "json",
		filePath,
	)
	probeOutput, err := probeCmd.CombinedOutput()
	if err != nil {
		return "", "", fmt.Errorf("probe embedded artwork: %w: %s", err, strings.TrimSpace(string(probeOutput)))
	}
	streamIndex, found, err := findAttachedArtworkStream(probeOutput)
	if err != nil {
		return "", "", fmt.Errorf("decode embedded artwork probe: %w", err)
	}
	if !found {
		return "", "", nil
	}

	if _, err := exec.LookPath("ffmpeg"); err != nil {
		return "", "", fmt.Errorf("locate ffmpeg: %w", err)
	}

	tempFile, err := os.CreateTemp("", "antolex-cover-*.jpg")
	if err != nil {
		return "", "", fmt.Errorf("create temporary artwork file: %w", err)
	}
	tempPath := tempFile.Name()
	if err := tempFile.Close(); err != nil {
		_ = os.Remove(tempPath)
		return "", "", fmt.Errorf("close temporary artwork file: %w", err)
	}
	keepTempFile := false
	defer func() {
		if !keepTempFile {
			_ = os.Remove(tempPath)
		}
	}()

	cmd := exec.CommandContext(
		ctx,
		"ffmpeg",
		"-v", "error",
		"-y",
		"-i", filePath,
		"-map", fmt.Sprintf("0:%d", streamIndex),
		"-frames:v", "1",
		tempPath,
	)

	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", "", fmt.Errorf("extract embedded artwork stream %d: %w: %s", streamIndex, err, strings.TrimSpace(string(output)))
	}

	info, err := os.Stat(tempPath)
	if err != nil {
		return "", "", fmt.Errorf("inspect extracted artwork: %w", err)
	}
	if info.Size() == 0 {
		return "", "", fmt.Errorf("extracted artwork is empty")
	}

	keepTempFile = true
	return tempPath, "image/jpeg", nil
}

func findAttachedArtworkStream(output []byte) (int, bool, error) {
	var probe ffprobeArtworkOutput
	if err := json.Unmarshal(output, &probe); err != nil {
		return 0, false, err
	}
	for _, stream := range probe.Streams {
		if stream.Disposition.AttachedPic != 0 {
			if stream.Index < 0 {
				return 0, false, fmt.Errorf("invalid attached artwork stream index %d", stream.Index)
			}
			return stream.Index, true, nil
		}
	}
	return 0, false, nil
}

func deriveTrackMetadata(
	ctx context.Context,
	filePath string,
	fileName string,
	explicitTitle string,
	explicitArtist string,
	explicitDuration int,
) audioMetadata {
	metadata, _ := extractAudioMetadataFromFile(ctx, filePath)

	fileArtist, fileTitle := inferTrackFieldsFromFilename(fileName)

	if strings.TrimSpace(metadata.Title) == "" {
		metadata.Title = strings.TrimSpace(explicitTitle)
	}
	if strings.TrimSpace(metadata.Artist) == "" {
		metadata.Artist = strings.TrimSpace(explicitArtist)
	}
	if metadata.DurationSeconds <= 0 {
		metadata.DurationSeconds = explicitDuration
	}

	if strings.TrimSpace(metadata.Title) == "" {
		metadata.Title = fileTitle
	}
	if strings.TrimSpace(metadata.Artist) == "" {
		metadata.Artist = fileArtist
	}
	if strings.TrimSpace(metadata.Title) == "" {
		metadata.Title = "Untitled Track"
	}
	if strings.TrimSpace(metadata.Artist) == "" {
		metadata.Artist = "Unknown Artist"
	}

	return metadata
}

func writeReaderToTempAudioFile(reader io.Reader, sourceName string) (string, int64, error) {
	ext := strings.ToLower(path.Ext(sourceName))
	tempFile, err := os.CreateTemp("", "antolex-audio-*"+ext)
	if err != nil {
		return "", 0, fmt.Errorf("create temp file: %w", err)
	}

	defer tempFile.Close()

	written, err := io.Copy(tempFile, reader)
	if err != nil {
		_ = os.Remove(tempFile.Name())
		return "", 0, fmt.Errorf("copy temp file: %w", err)
	}

	return tempFile.Name(), written, nil
}

func inferTrackFieldsFromFilename(fileName string) (string, string) {
	base := strings.TrimSuffix(path.Base(fileName), path.Ext(fileName))
	base = strings.ReplaceAll(base, "_", " ")
	base = strings.Join(strings.Fields(base), " ")
	if base == "" {
		return "", "Untitled Track"
	}

	parts := strings.SplitN(base, " - ", 2)
	if len(parts) == 2 {
		artist := strings.TrimSpace(parts[0])
		title := strings.TrimSpace(parts[1])
		if title != "" {
			return artist, title
		}
	}

	return "", base
}

func firstNonEmptyTag(tags map[string]string, keys ...string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(tags[key]); value != "" {
			return value
		}
	}
	return ""
}

func strconvDuration(value string) (int, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0, fmt.Errorf("empty duration")
	}

	seconds, err := strconv.ParseFloat(value, 64)
	if err != nil || !isFinitePositive(seconds) {
		return 0, fmt.Errorf("invalid duration")
	}

	return int(math.Round(seconds)), nil
}

func isFinitePositive(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value > 0
}
