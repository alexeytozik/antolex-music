package server

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"strings"
	"time"

	aws "github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"

	"github.com/alexeytozik/antolex-music/services/api/internal/config"
)

const seedTrackURLTTL = 30 * time.Minute
const uploadPartURLTTL = 15 * time.Minute

type uploadedPart struct {
	PartNumber int
	ETag       string
	SizeBytes  int64
}

type seedCatalog struct {
	bucket    string
	client    *s3.Client
	presigner *s3.PresignClient
}

func newSeedCatalog(cfg config.Config) (*seedCatalog, error) {
	if strings.TrimSpace(cfg.R2AccountID) == "" ||
		strings.TrimSpace(cfg.R2BucketName) == "" ||
		strings.TrimSpace(cfg.R2AccessKeyID) == "" ||
		strings.TrimSpace(cfg.R2SecretAccessKey) == "" {
		return nil, nil
	}

	awsCfg, err := awsconfig.LoadDefaultConfig(
		context.Background(),
		awsconfig.WithRegion("auto"),
		awsconfig.WithCredentialsProvider(
			credentials.NewStaticCredentialsProvider(cfg.R2AccessKeyID, cfg.R2SecretAccessKey, ""),
		),
	)
	if err != nil {
		return nil, err
	}

	endpoint := fmt.Sprintf("https://%s.r2.cloudflarestorage.com", cfg.R2AccountID)
	client := s3.NewFromConfig(awsCfg, func(o *s3.Options) {
		o.BaseEndpoint = aws.String(endpoint)
		o.UsePathStyle = true
	})

	return &seedCatalog{
		bucket:    cfg.R2BucketName,
		client:    client,
		presigner: s3.NewPresignClient(client),
	}, nil
}

func (c *seedCatalog) PresignObjectKey(ctx context.Context, objectKey string) (string, error) {
	req, err := c.presigner.PresignGetObject(
		ctx,
		&s3.GetObjectInput{
			Bucket: aws.String(c.bucket),
			Key:    aws.String(objectKey),
		},
		func(options *s3.PresignOptions) {
			options.Expires = seedTrackURLTTL
		},
	)
	if err != nil {
		return "", err
	}
	return req.URL, nil
}

func (c *seedCatalog) CreateMultipartUpload(ctx context.Context, objectKey, contentType string) (string, error) {
	result, err := c.client.CreateMultipartUpload(ctx, &s3.CreateMultipartUploadInput{
		Bucket: aws.String(c.bucket), Key: aws.String(objectKey), ContentType: aws.String(contentType),
	})
	if err != nil {
		return "", err
	}
	return aws.ToString(result.UploadId), nil
}

func (c *seedCatalog) PresignUploadPart(ctx context.Context, objectKey, uploadID string, partNumber int, contentLength int64) (string, time.Time, error) {
	result, err := c.presigner.PresignUploadPart(ctx, &s3.UploadPartInput{
		Bucket: aws.String(c.bucket), Key: aws.String(objectKey), UploadId: aws.String(uploadID),
		PartNumber: aws.Int32(int32(partNumber)), ContentLength: aws.Int64(contentLength),
	}, func(options *s3.PresignOptions) { options.Expires = uploadPartURLTTL })
	if err != nil {
		return "", time.Time{}, err
	}
	return result.URL, time.Now().Add(uploadPartURLTTL), nil
}

func (c *seedCatalog) ListUploadedParts(ctx context.Context, objectKey, uploadID string) ([]uploadedPart, error) {
	parts := make([]uploadedPart, 0, 32)
	var marker *string
	for {
		result, err := c.client.ListParts(ctx, &s3.ListPartsInput{
			Bucket: aws.String(c.bucket), Key: aws.String(objectKey), UploadId: aws.String(uploadID), PartNumberMarker: marker,
		})
		if err != nil {
			return nil, err
		}
		for _, part := range result.Parts {
			parts = append(parts, uploadedPart{PartNumber: int(aws.ToInt32(part.PartNumber)), ETag: aws.ToString(part.ETag), SizeBytes: aws.ToInt64(part.Size)})
		}
		if !aws.ToBool(result.IsTruncated) {
			break
		}
		marker = result.NextPartNumberMarker
	}
	return parts, nil
}

func (c *seedCatalog) CompleteMultipartUpload(ctx context.Context, objectKey, uploadID string, parts []uploadedPart) error {
	completed := make([]s3types.CompletedPart, 0, len(parts))
	for _, part := range parts {
		completed = append(completed, s3types.CompletedPart{ETag: aws.String(part.ETag), PartNumber: aws.Int32(int32(part.PartNumber))})
	}
	_, err := c.client.CompleteMultipartUpload(ctx, &s3.CompleteMultipartUploadInput{
		Bucket: aws.String(c.bucket), Key: aws.String(objectKey), UploadId: aws.String(uploadID),
		MultipartUpload: &s3types.CompletedMultipartUpload{Parts: completed},
	})
	return err
}

func (c *seedCatalog) AbortMultipartUpload(ctx context.Context, objectKey, uploadID string) error {
	_, err := c.client.AbortMultipartUpload(ctx, &s3.AbortMultipartUploadInput{
		Bucket: aws.String(c.bucket), Key: aws.String(objectKey), UploadId: aws.String(uploadID),
	})
	return err
}

func (c *seedCatalog) DownloadObject(ctx context.Context, objectKey string) (io.ReadCloser, error) {
	result, err := c.client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(c.bucket), Key: aws.String(objectKey)})
	if err != nil {
		return nil, err
	}
	return result.Body, nil
}

type rangedObjectMetadata struct {
	ContentType string
	ETag        string
}

func (c *seedCatalog) DownloadObjectRange(
	ctx context.Context,
	objectKey string,
	rangeHeader string,
) (io.ReadCloser, rangedObjectMetadata, error) {
	input := &s3.GetObjectInput{
		Bucket: aws.String(c.bucket),
		Key:    aws.String(objectKey),
	}
	if strings.TrimSpace(rangeHeader) != "" {
		input.Range = aws.String(rangeHeader)
	}
	result, err := c.client.GetObject(ctx, input)
	if err != nil {
		return nil, rangedObjectMetadata{}, err
	}
	return result.Body, rangedObjectMetadata{
		ContentType: aws.ToString(result.ContentType),
		ETag:        aws.ToString(result.ETag),
	}, nil
}

func (c *seedCatalog) UploadObject(
	ctx context.Context,
	objectKey string,
	contentType string,
	body io.Reader,
) error {
	_, err := c.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(c.bucket),
		Key:         aws.String(objectKey),
		Body:        body,
		ContentType: aws.String(contentType),
	})
	return err
}

func (c *seedCatalog) DeleteObject(ctx context.Context, objectKey string) error {
	_, err := c.client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(c.bucket),
		Key:    aws.String(objectKey),
	})
	return err
}

func (c *seedCatalog) ListObjects(ctx context.Context, prefix string) ([]s3types.Object, error) {
	objects := make([]s3types.Object, 0, 128)
	var token *string

	for {
		res, err := c.client.ListObjectsV2(ctx, &s3.ListObjectsV2Input{
			Bucket:            aws.String(c.bucket),
			Prefix:            aws.String(prefix),
			ContinuationToken: token,
		})
		if err != nil {
			return nil, err
		}

		objects = append(objects, res.Contents...)
		if !aws.ToBool(res.IsTruncated) {
			break
		}
		token = res.NextContinuationToken
	}

	return objects, nil
}

func (c *seedCatalog) HeadObject(ctx context.Context, objectKey string) (string, int64, error) {
	res, err := c.client.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(c.bucket),
		Key:    aws.String(objectKey),
	})
	if err != nil {
		return "", 0, err
	}

	return aws.ToString(res.ContentType), aws.ToInt64(res.ContentLength), nil
}

func (c *seedCatalog) DownloadObjectMetadata(
	ctx context.Context,
	objectKey string,
) (string, func(), audioMetadata, error) {
	res, err := c.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(c.bucket),
		Key:    aws.String(objectKey),
	})
	if err != nil {
		return "", nil, audioMetadata{}, err
	}
	defer res.Body.Close()

	tempPath, _, err := writeReaderToTempAudioFile(res.Body, path.Base(objectKey))
	if err != nil {
		return "", nil, audioMetadata{}, err
	}

	cleanup := func() {
		_ = os.Remove(tempPath)
	}

	return tempPath, cleanup, audioMetadata{}, nil
}

func isObjectNotFoundError(err error) bool {
	var apiErr smithy.APIError
	if errors.As(err, &apiErr) {
		switch apiErr.ErrorCode() {
		case "NoSuchKey", "NotFound", "404":
			return true
		}
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "no such key") ||
		strings.Contains(message, "not found") ||
		strings.Contains(message, "status code: 404")
}

func isNoSuchUploadError(err error) bool {
	if err == nil {
		return false
	}
	var apiErr smithy.APIError
	return errors.As(err, &apiErr) && apiErr.ErrorCode() == "NoSuchUpload"
}
