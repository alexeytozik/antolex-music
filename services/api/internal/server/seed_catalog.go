package server

import (
	"context"
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

	"github.com/tozikron/tozikron-music/services/api/internal/config"
)

const seedTrackURLTTL = 30 * time.Minute

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
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "no such key") ||
		strings.Contains(message, "not found") ||
		strings.Contains(message, "status code: 404")
}
