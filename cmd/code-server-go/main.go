package main

import (
	"context"
	"errors"
	"os"
	"os/signal"
	"syscall"

	distfs "github.com/117503445/vscgo"
	"github.com/117503445/vscgo/internal/app"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
)

func main() {
	zerolog.TimeFieldFormat = zerolog.TimeFormatUnix
	log.Logger = log.Output(zerolog.ConsoleWriter{Out: os.Stderr})

	addr := os.Getenv("CODE_SERVER_GO_ADDR")
	if addr == "" {
		addr = ":8080"
	}

	workspaceRoot, err := os.Getwd()
	if err != nil {
		log.Fatal().Err(err).Msg("resolve workspace root")
	}

	server, err := app.New(app.Config{
		Addr:          addr,
		WorkspaceRoot: workspaceRoot,
		StaticFS:      distfs.FS,
	}, log.Logger)
	if err != nil {
		log.Fatal().Err(err).Msg("initialize server")
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	if err := server.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		log.Fatal().Err(err).Msg("server exited")
	}
}
