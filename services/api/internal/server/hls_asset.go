package server

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

const hlsTargetSegmentSeconds = 6

type hlsSegment struct {
	Offset     int64 `json:"offset"`
	Length     int64 `json:"length"`
	DurationMS int64 `json:"duration_ms"`
}

type cmafPlaylistIndex struct {
	InitOffset     int64
	InitLength     int64
	Segments       []hlsSegment
	DurationMS     int64
	TargetDuration int
}

type packagedCMAF struct {
	Directory string
	MediaPath string
	Index     cmafPlaylistIndex
}

func (asset packagedCMAF) Cleanup() {
	if asset.Directory != "" {
		_ = os.RemoveAll(asset.Directory)
	}
}

// packageCMAF remuxes an AAC playback file into one fragmented MP4 object.
// The temporary media playlist is parsed into byte ranges and is not uploaded.
func packageCMAF(ctx context.Context, inputPath string) (packagedCMAF, error) {
	directory, err := os.MkdirTemp("", "antolex-cmaf-*")
	if err != nil {
		return packagedCMAF{}, fmt.Errorf("create CMAF workspace: %w", err)
	}
	result := packagedCMAF{
		Directory: directory,
		MediaPath: filepath.Join(directory, "audio.mp4"),
	}
	playlistPath := filepath.Join(directory, "index.m3u8")
	copyCodec, err := inputUsesCompatibleAAC(ctx, inputPath)
	if err != nil {
		result.Cleanup()
		return packagedCMAF{}, err
	}
	var copyOutput []byte
	var copyErr error
	if copyCodec {
		copyOutput, copyErr = runCMAFPackager(ctx, inputPath, result.MediaPath, playlistPath, true)
	} else {
		copyErr = fmt.Errorf("source codec is not AAC")
	}
	if !copyCodec || copyErr != nil {
		// Older library rows may still point at MP3/FLAC originals. Only AAC is
		// safe to remux into a mobile CMAF asset; every other codec is normalized.
		_ = os.Remove(result.MediaPath)
		_ = os.Remove(playlistPath)
		transcodeOutput, transcodeErr := runCMAFPackager(ctx, inputPath, result.MediaPath, playlistPath, false)
		if transcodeErr != nil {
			result.Cleanup()
			return packagedCMAF{}, fmt.Errorf(
				"package CMAF playback: copy failed: %v: %s; transcode failed: %w: %s",
				copyErr,
				strings.TrimSpace(string(copyOutput)),
				transcodeErr,
				strings.TrimSpace(string(transcodeOutput)),
			)
		}
	}

	mediaInfo, err := os.Stat(result.MediaPath)
	if err != nil {
		result.Cleanup()
		return packagedCMAF{}, fmt.Errorf("inspect CMAF playback: %w", err)
	}
	if mediaInfo.Size() == 0 {
		result.Cleanup()
		return packagedCMAF{}, fmt.Errorf("CMAF packager produced an empty file")
	}
	playlist, err := os.Open(playlistPath)
	if err != nil {
		result.Cleanup()
		return packagedCMAF{}, fmt.Errorf("open CMAF playlist: %w", err)
	}
	index, parseErr := parseCMAFPlaylist(playlist, filepath.Base(result.MediaPath), mediaInfo.Size())
	closeErr := playlist.Close()
	if parseErr != nil {
		result.Cleanup()
		return packagedCMAF{}, parseErr
	}
	if closeErr != nil {
		result.Cleanup()
		return packagedCMAF{}, fmt.Errorf("close CMAF playlist: %w", closeErr)
	}
	result.Index = index
	return result, nil
}

func inputUsesCompatibleAAC(ctx context.Context, inputPath string) (bool, error) {
	output, err := exec.CommandContext(
		ctx,
		"ffprobe",
		"-v", "error",
		"-select_streams", "a:0",
		"-show_entries", "stream=codec_name,profile,sample_rate,channels",
		"-of", "json",
		inputPath,
	).CombinedOutput()
	if err != nil {
		return false, fmt.Errorf("probe CMAF source codec: %w: %s", err, strings.TrimSpace(string(output)))
	}
	var probe struct {
		Streams []struct {
			CodecName  string `json:"codec_name"`
			Profile    string `json:"profile"`
			SampleRate string `json:"sample_rate"`
			Channels   int    `json:"channels"`
		} `json:"streams"`
	}
	if err := json.Unmarshal(output, &probe); err != nil {
		return false, fmt.Errorf("decode CMAF source codec: %w", err)
	}
	if len(probe.Streams) == 0 {
		return false, fmt.Errorf("probe CMAF source codec: audio stream is missing")
	}
	stream := probe.Streams[0]
	compatibleSampleRate := stream.SampleRate == "44100" || stream.SampleRate == "48000"
	return stream.CodecName == "aac" &&
		strings.EqualFold(stream.Profile, "LC") &&
		stream.Channels >= 1 && stream.Channels <= 2 &&
		compatibleSampleRate, nil
}

func runCMAFPackager(
	ctx context.Context,
	inputPath string,
	mediaPath string,
	playlistPath string,
	copyCodec bool,
) ([]byte, error) {
	args := []string{
		"-v", "error",
		"-y",
		"-i", inputPath,
		"-map", "0:a:0",
		"-vn",
	}
	if copyCodec {
		args = append(args, "-c:a", "copy")
	} else {
		args = append(
			args,
			"-c:a", "aac",
			"-profile:a", "aac_low",
			"-b:a", "256k",
			"-ar", "48000",
			"-ac", "2",
		)
	}
	args = append(
		args,
		"-f", "hls",
		"-hls_time", strconv.Itoa(hlsTargetSegmentSeconds),
		"-hls_playlist_type", "vod",
		"-hls_segment_type", "fmp4",
		"-hls_flags", "single_file+independent_segments",
		"-hls_segment_filename", mediaPath,
		playlistPath,
	)
	return exec.CommandContext(ctx, "ffmpeg", args...).CombinedOutput()
}

func (index cmafPlaylistIndex) segmentsJSON() ([]byte, error) {
	encoded, err := json.Marshal(index.Segments)
	if err != nil {
		return nil, fmt.Errorf("encode CMAF segment index: %w", err)
	}
	return encoded, nil
}

func parseCMAFPlaylist(
	playlist *os.File,
	expectedMediaName string,
	objectSize int64,
) (cmafPlaylistIndex, error) {
	return parseCMAFPlaylistLines(bufio.NewScanner(playlist), expectedMediaName, objectSize)
}

func parseCMAFPlaylistLines(
	scanner *bufio.Scanner,
	expectedMediaName string,
	objectSize int64,
) (cmafPlaylistIndex, error) {
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	var result cmafPlaylistIndex
	var pendingDurationMS int64
	var pendingRangeLength int64
	var pendingRangeOffset int64
	var previousRangeEnd int64
	var maxSegmentDurationMS int64
	var sawHeader bool
	var sawEndList bool

	for lineNumber := 1; scanner.Scan(); lineNumber++ {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		if !sawHeader {
			if line != "#EXTM3U" {
				return cmafPlaylistIndex{}, fmt.Errorf("invalid CMAF playlist header on line %d", lineNumber)
			}
			sawHeader = true
			continue
		}

		switch {
		case strings.HasPrefix(line, "#EXT-X-TARGETDURATION:"):
			value := strings.TrimSpace(strings.TrimPrefix(line, "#EXT-X-TARGETDURATION:"))
			targetDuration, err := strconv.Atoi(value)
			if err != nil || targetDuration < 1 {
				return cmafPlaylistIndex{}, fmt.Errorf("invalid target duration on line %d", lineNumber)
			}
			result.TargetDuration = targetDuration

		case strings.HasPrefix(line, "#EXT-X-MAP:"):
			attributes, err := parseHLSAttributeList(strings.TrimPrefix(line, "#EXT-X-MAP:"))
			if err != nil {
				return cmafPlaylistIndex{}, fmt.Errorf("parse init map on line %d: %w", lineNumber, err)
			}
			if err := validateHLSMediaURI(attributes["URI"], expectedMediaName); err != nil {
				return cmafPlaylistIndex{}, fmt.Errorf("invalid init map on line %d: %w", lineNumber, err)
			}
			length, offset, err := parseHLSByteRange(attributes["BYTERANGE"], 0)
			if err != nil {
				return cmafPlaylistIndex{}, fmt.Errorf("invalid init byte range on line %d: %w", lineNumber, err)
			}
			result.InitOffset = offset
			result.InitLength = length
			previousRangeEnd = offset + length

		case strings.HasPrefix(line, "#EXTINF:"):
			if pendingDurationMS != 0 || pendingRangeLength != 0 {
				return cmafPlaylistIndex{}, fmt.Errorf("incomplete segment before line %d", lineNumber)
			}
			value := strings.TrimSpace(strings.TrimPrefix(line, "#EXTINF:"))
			if comma := strings.IndexByte(value, ','); comma >= 0 {
				value = value[:comma]
			}
			durationSeconds, err := strconv.ParseFloat(value, 64)
			if err != nil || durationSeconds <= 0 || math.IsInf(durationSeconds, 0) || math.IsNaN(durationSeconds) {
				return cmafPlaylistIndex{}, fmt.Errorf("invalid segment duration on line %d", lineNumber)
			}
			pendingDurationMS = int64(math.Round(durationSeconds * 1000))
			if pendingDurationMS < 1 {
				return cmafPlaylistIndex{}, fmt.Errorf("segment duration is below one millisecond on line %d", lineNumber)
			}

		case strings.HasPrefix(line, "#EXT-X-BYTERANGE:"):
			if pendingDurationMS == 0 || pendingRangeLength != 0 {
				return cmafPlaylistIndex{}, fmt.Errorf("unexpected segment byte range on line %d", lineNumber)
			}
			length, offset, err := parseHLSByteRange(
				strings.TrimSpace(strings.TrimPrefix(line, "#EXT-X-BYTERANGE:")),
				previousRangeEnd,
			)
			if err != nil {
				return cmafPlaylistIndex{}, fmt.Errorf("invalid segment byte range on line %d: %w", lineNumber, err)
			}
			pendingRangeLength = length
			pendingRangeOffset = offset

		case line == "#EXT-X-ENDLIST":
			sawEndList = true

		case strings.HasPrefix(line, "#"):
			continue

		default:
			if pendingDurationMS == 0 || pendingRangeLength == 0 {
				return cmafPlaylistIndex{}, fmt.Errorf("unexpected media URI on line %d", lineNumber)
			}
			if err := validateHLSMediaURI(line, expectedMediaName); err != nil {
				return cmafPlaylistIndex{}, fmt.Errorf("invalid segment URI on line %d: %w", lineNumber, err)
			}
			if pendingRangeOffset != previousRangeEnd {
				return cmafPlaylistIndex{}, fmt.Errorf(
					"non-contiguous segment range on line %d: got offset %d, want %d",
					lineNumber,
					pendingRangeOffset,
					previousRangeEnd,
				)
			}
			segmentEnd := pendingRangeOffset + pendingRangeLength
			if segmentEnd < pendingRangeOffset || (objectSize > 0 && segmentEnd > objectSize) {
				return cmafPlaylistIndex{}, fmt.Errorf("segment range exceeds media object on line %d", lineNumber)
			}
			result.Segments = append(result.Segments, hlsSegment{
				Offset:     pendingRangeOffset,
				Length:     pendingRangeLength,
				DurationMS: pendingDurationMS,
			})
			result.DurationMS += pendingDurationMS
			if pendingDurationMS > maxSegmentDurationMS {
				maxSegmentDurationMS = pendingDurationMS
			}
			previousRangeEnd = segmentEnd
			pendingDurationMS = 0
			pendingRangeLength = 0
			pendingRangeOffset = 0
		}
	}
	if err := scanner.Err(); err != nil {
		return cmafPlaylistIndex{}, fmt.Errorf("read CMAF playlist: %w", err)
	}
	if !sawHeader || !sawEndList {
		return cmafPlaylistIndex{}, fmt.Errorf("CMAF playlist is incomplete")
	}
	if result.TargetDuration < 1 || result.InitLength < 1 || len(result.Segments) == 0 {
		return cmafPlaylistIndex{}, fmt.Errorf("CMAF playlist is missing required media data")
	}
	requiredTargetDuration := int((maxSegmentDurationMS + 999) / 1000)
	result.TargetDuration = requiredTargetDuration
	if pendingDurationMS != 0 || pendingRangeLength != 0 {
		return cmafPlaylistIndex{}, fmt.Errorf("CMAF playlist ends with an incomplete segment")
	}
	if objectSize > 0 && previousRangeEnd != objectSize {
		return cmafPlaylistIndex{}, fmt.Errorf(
			"CMAF byte ranges cover %d bytes, object has %d bytes",
			previousRangeEnd,
			objectSize,
		)
	}
	return result, nil
}

func parseHLSByteRange(value string, implicitOffset int64) (length int64, offset int64, err error) {
	value = strings.Trim(strings.TrimSpace(value), `"`)
	parts := strings.Split(value, "@")
	if len(parts) < 1 || len(parts) > 2 || strings.TrimSpace(parts[0]) == "" {
		return 0, 0, fmt.Errorf("expected length[@offset]")
	}
	length, err = strconv.ParseInt(strings.TrimSpace(parts[0]), 10, 64)
	if err != nil || length < 1 {
		return 0, 0, fmt.Errorf("length must be a positive integer")
	}
	offset = implicitOffset
	if len(parts) == 2 {
		offset, err = strconv.ParseInt(strings.TrimSpace(parts[1]), 10, 64)
		if err != nil || offset < 0 {
			return 0, 0, fmt.Errorf("offset must be a non-negative integer")
		}
	}
	if offset > math.MaxInt64-length {
		return 0, 0, fmt.Errorf("byte range overflows int64")
	}
	return length, offset, nil
}

func validateHLSMediaURI(value, expectedMediaName string) error {
	value = strings.Trim(strings.TrimSpace(value), `"`)
	if value == "" {
		return fmt.Errorf("media URI is empty")
	}
	if value != expectedMediaName || strings.Contains(value, "?") || strings.Contains(value, "#") {
		return fmt.Errorf("unexpected media URI %q", value)
	}
	return nil
}

func parseHLSAttributeList(value string) (map[string]string, error) {
	attributes := make(map[string]string)
	for len(strings.TrimSpace(value)) > 0 {
		value = strings.TrimSpace(value)
		equals := strings.IndexByte(value, '=')
		if equals < 1 {
			return nil, fmt.Errorf("expected key=value")
		}
		key := strings.TrimSpace(value[:equals])
		value = value[equals+1:]
		var attributeValue string
		if strings.HasPrefix(value, `"`) {
			closing := strings.IndexByte(value[1:], '"')
			if closing < 0 {
				return nil, fmt.Errorf("unterminated quoted value for %s", key)
			}
			closing++
			attributeValue = value[1:closing]
			value = value[closing+1:]
		} else if comma := strings.IndexByte(value, ','); comma >= 0 {
			attributeValue = strings.TrimSpace(value[:comma])
			value = value[comma:]
		} else {
			attributeValue = strings.TrimSpace(value)
			value = ""
		}
		if key == "" || attributeValue == "" {
			return nil, fmt.Errorf("empty attribute")
		}
		attributes[key] = attributeValue
		value = strings.TrimSpace(value)
		if value == "" {
			break
		}
		if value[0] != ',' {
			return nil, fmt.Errorf("expected comma between attributes")
		}
		value = value[1:]
	}
	return attributes, nil
}
