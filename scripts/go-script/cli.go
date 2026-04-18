package main

var cli struct {
	Build cmdBuild `cmd:"" help:"Build frontend dist and Go binary"`
	E2e   cmdE2E   `cmd:"" name:"e2e" help:"Run local Playwright e2e tests against a temporary workspace"`
}

type cmdBuild struct{}

func (c *cmdBuild) Run() error {
	return build()
}

type cmdE2E struct{}

func (c *cmdE2E) Run() error {
	return runE2E()
}
