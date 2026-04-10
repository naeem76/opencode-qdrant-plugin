import type { Plugin } from "@opencode-ai/plugin"
import { server as createServer } from "../../dist/server.js"

const options = {
  qdrantUrl: "http://localhost:6333",
  embeddingProvider: "local" as const,
  indexOnStart: true,
}

export const OpencodeQdrant: Plugin = async (input) => {
  return createServer(input, options)
}
