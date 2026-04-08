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
	DurationSeconds int
}

type ffprobeOutput struct {
	Format struct {
		Duration string            `json:"duration"`
		Tags     map[string]string `json:"tags"`
	} `json:"format"`
}

func extractAudioMetadataFromFile(ctx context.Context, filePath string) (audioMetadata, error) {
	if _, err := exec.LookPath("ffprobe"); err != nil {
		return audioMetadata{}, nil
	}

	cmd := exec.CommandContext(
		ctx,
		"ffprobe",
		"-v", "error",
		"-show_entries", "format=duration:format_tags=title,artist,album_artist,ARTIST,TITLE",
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
	}

	if seconds, err := strconvDuration(probe.Format.Duration); err == nil {
		metadata.DurationSeconds = seconds
	}

	return metadata, nil
}

func extractAudioArtworkFromFile(ctx context.Context, filePath string) (string, string, error) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		return "", "", nil
	}

	tempFile, err := os.CreateTemp("", "tozikron-cover-*.jpg")
	if err != nil {
		return "", "", nil
	}
	tempPath := tempFile.Name()
	_ = tempFile.Close()

	cmd := exec.CommandContext(
		ctx,
		"ffmpeg",
		"-v", "error",
		"-y",
		"-i", filePath,
		"-map", "0:v:0",
		"-frames:v", "1",
		tempPath,
	)

	if _, err := cmd.Output(); err != nil {
		_ = os.Remove(tempPath)
		return "", "", nil
	}

	info, err := os.Stat(tempPath)
	if err != nil || info.Size() == 0 {
		_ = os.Remove(tempPath)
		return "", "", nil
	}

	return tempPath, "image/jpeg", nil
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
	tempFile, err := os.CreateTemp("", "tozikron-audio-*"+ext)
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
