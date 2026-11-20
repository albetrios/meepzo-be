group "default" {
  targets = ["api", "worker"]
}

target "_common" {
  context    = "."
  dockerfile = "Dockerfile"
  args = {
    NODE_VERSION = "24.21.0"
    PNPM_VERSION = "12.8.1"
  }
}

target "api" {
  inherits = ["_common"]
  target   = "api"
  args = {
    GENERATE_MCP_DOCS = "true"
  }
  tags = ["meepzo-be:latest"]
}

target "worker" {
  inherits = ["_common"]
  target   = "worker"
  args = {
    GENERATE_MCP_DOCS = "false"
  }
  tags = ["meepzo-be-worker:latest"]
}
