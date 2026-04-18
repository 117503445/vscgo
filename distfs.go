package distfs

import "embed"

// FS contains the generated static assets copied into ./dist by scripts/go-script build.
//
//go:embed all:dist
var FS embed.FS
