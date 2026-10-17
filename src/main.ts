// Entry point: `npm start` serves the app on PORT (default 7860).
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";

const cfg = loadConfig();
const app = createApp(cfg);
serve({ fetch: app.fetch, port: cfg.port }, (i) => console.error(`CatOrder on http://localhost:${i.port}`));
