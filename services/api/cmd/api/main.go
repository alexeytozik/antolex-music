package main

import (
	"log"

	"github.com/alexeytozik/antolex-music/services/api/internal/config"
	"github.com/alexeytozik/antolex-music/services/api/internal/server"
)

func main() {
	cfg := config.Load()

	app, cleanup, err := server.New(cfg)
	if err != nil {
		log.Fatalf("failed to initialize server: %v", err)
	}
	defer cleanup()

	log.Printf("api listening on :%s", cfg.Port)
	if err := app.Listen(":" + cfg.Port); err != nil {
		log.Fatalf("server error: %v", err)
	}
}
