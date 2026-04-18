package main

import (
	"github.com/117503445/goutils/glog"
	"github.com/alecthomas/kong"
	"github.com/rs/zerolog/log"
)

func init() {
	glog.InitZeroLog()
}

func main() {
	ctx := kong.Parse(&cli)
	log.Info().Interface("cli", cli).Send()
	if err := ctx.Run(); err != nil {
		log.Panic().Err(err).Msg("run failed")
	}
}
