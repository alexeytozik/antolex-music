FROM golang:1.25-alpine AS build

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /usr/local/bin/antolex-api ./cmd/api && \
    CGO_ENABLED=0 GOOS=linux go build -o /usr/local/bin/antolex-worker ./cmd/worker

FROM alpine:3.22

RUN apk add --no-cache ca-certificates wget ffmpeg

COPY --from=build /usr/local/bin/antolex-api /usr/local/bin/antolex-api
COPY --from=build /usr/local/bin/antolex-worker /usr/local/bin/antolex-worker

EXPOSE 8080

CMD ["antolex-api"]
