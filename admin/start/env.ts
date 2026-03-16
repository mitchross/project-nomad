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

  /*
  |----------------------------------------------------------
  | Variables for configuring embeddings (RAG)
  |----------------------------------------------------------
  */
  EMBEDDING_MODEL: Env.schema.string.optional(),
  EMBEDDING_DIMENSIONS: Env.schema.string.optional(),
  EMBEDDING_SEARCH_DOC_PREFIX: Env.schema.string.optional(),
  EMBEDDING_SEARCH_QUERY_PREFIX: Env.schema.string.optional(),
  QDRANT_HOST: Env.schema.string.optional(),

  /*
  |----------------------------------------------------------
  | Variables for companion service URLs (BYO pattern)
  |----------------------------------------------------------
  */
  KIWIX_URL: Env.schema.string.optional(),
  KOLIBRI_URL: Env.schema.string.optional(),
  PROTOMAPS_URL: Env.schema.string.optional(),
  CYBERCHEF_URL: Env.schema.string.optional(),
  FLATNOTES_URL: Env.schema.string.optional(),
})
