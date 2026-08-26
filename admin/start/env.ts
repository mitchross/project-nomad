/*
|--------------------------------------------------------------------------
| Environment variables service
|--------------------------------------------------------------------------
|
| The `Env.create` method creates an instance of the Env service. The
| service validates the environment variables and also cast values
| to JavaScript data types.
|
*/

import { Env } from '@adonisjs/core/env'

export default await Env.create(new URL('../', import.meta.url), {
  NODE_ENV: Env.schema.enum(['development', 'production', 'test'] as const),
  PORT: Env.schema.number(),
  APP_KEY: Env.schema.string(),
  HOST: Env.schema.string({ format: 'host' }),
  URL: Env.schema.string(),
  LOG_LEVEL: Env.schema.string(),
  INTERNET_STATUS_TEST_URL: Env.schema.string.optional(),
  DISABLE_COMPRESSION: Env.schema.boolean.optional(),

  /*
  |----------------------------------------------------------
  | Variables for configuring storage paths
  |----------------------------------------------------------
  */
  NOMAD_STORAGE_PATH: Env.schema.string.optional(),

  /*
  |----------------------------------------------------------
  | Variables for configuring session package
  |----------------------------------------------------------
  */
  //SESSION_DRIVER: Env.schema.enum(['cookie', 'memory'] as const),

  /*
  |----------------------------------------------------------
  | Variables for configuring the database package
  |----------------------------------------------------------
  */
  DB_HOST: Env.schema.string({ format: 'host' }),
  DB_PORT: Env.schema.number(),
  DB_USER: Env.schema.string(),
  DB_PASSWORD: Env.schema.string.optional(),
  DB_DATABASE: Env.schema.string(),
  DB_SSL: Env.schema.boolean.optional(),

  /*
  |----------------------------------------------------------
  | Variables for configuring the Redis connection
  |----------------------------------------------------------
  */
  REDIS_HOST: Env.schema.string({ format: 'host' }),
  REDIS_PORT: Env.schema.number(),
  REDIS_DB: Env.schema.number.optional(),

  /*
  |----------------------------------------------------------
  | Variables for configuring Project Nomad's external API URL
  |----------------------------------------------------------
  */
  NOMAD_API_URL: Env.schema.string.optional(),

  /*
  |----------------------------------------------------------
  | Variables for configuring the LLM provider
  |----------------------------------------------------------
  */
  LLM_PROVIDER: Env.schema.enum.optional(['ollama', 'openai'] as const),
  LLM_HOST: Env.schema.string.optional(),
  LLM_API_KEY: Env.schema.string.optional(),
  OLLAMA_HOST: Env.schema.string.optional(),
  AI_BENCHMARK_MODEL: Env.schema.string.optional(),
  // Comma-separated substrings identifying reasoning ("thinking") models on
  // OpenAI-compatible backends, which expose no capability metadata. Overrides
  // the built-in list in OpenAIProvider when set.
  LLM_THINKING_MODELS: Env.schema.string.optional(),

  /*
  |----------------------------------------------------------
  | Variables for configuring embeddings (RAG)
  |----------------------------------------------------------
  */
  EMBEDDING_MODEL: Env.schema.string.optional(),
  EMBEDDING_DIMENSIONS: Env.schema.string.optional(),
  EMBEDDING_SEARCH_DOC_PREFIX: Env.schema.string.optional(),
  EMBEDDING_SEARCH_QUERY_PREFIX: Env.schema.string.optional(),
  EMBEDDING_HOST: Env.schema.string.optional(),
  EMBEDDING_API_KEY: Env.schema.string.optional(),
  QDRANT_HOST: Env.schema.string.optional(),

  /*
  |----------------------------------------------------------
  | Variables for companion service URLs (BYO pattern)
  |----------------------------------------------------------
  */
  KIWIX_URL: Env.schema.string.optional(),
  KIWIX_BROWSER_URL: Env.schema.string.optional(),
  KIWIX_CONTENT_MODE: Env.schema.enum.optional(['shared', 'external'] as const),
  KOLIBRI_URL: Env.schema.string.optional(),
  CYBERCHEF_URL: Env.schema.string.optional(),
  FLATNOTES_URL: Env.schema.string.optional(),

  /*
  |----------------------------------------------------------
  | Creator Packs (gated content downloads)
  |----------------------------------------------------------
  | CREATOR_PACKS_APP_KEY is the shared bearer key the entitlement Worker
  | requires; official release builds inject it at build time (it is NOT
  | committed to source). When unset, pack installs fail with a clear
  | "not configured" error and the rest of the app is unaffected.
  | CREATOR_PACKS_WORKER_BASE overrides the default Worker origin (e.g. to
  | point at a branded packs.projectnomad.us domain later).
  */
  CREATOR_PACKS_APP_KEY: Env.schema.string.optional(),
  CREATOR_PACKS_WORKER_BASE: Env.schema.string.optional(),
})
