package main

import (
	"context"
	"log"
	"os/signal"
	"syscall"

	"github.com/alexeytozik/antolex-music/services/api/internal/config"
	"github.com/alexeytozik/antolex-music/services/api/internal/server"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := server.RunWorker(ctx, config.Load()); err != nil {
		log.Fatalf("worker stopped: %v", err)
	}
}
