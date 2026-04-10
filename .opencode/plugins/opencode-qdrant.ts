import { server as createServer } from "../../dist/server.js"
import type { Plugin } from "@opencode-ai/plugin"

const options = {
  qdrantUrl: "http://localhost:6333",
  embeddingProvider: "local" as const,
  indexOnStart: true,
}

const server: Plugin = async (input) => {
  return createServer(input, options)
}

export default {
  id: "opencode-qdrant",
  server,
}
