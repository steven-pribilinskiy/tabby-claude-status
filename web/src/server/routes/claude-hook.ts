import { Hono } from "hono";
import { handleHookEvent } from "../lib/claude-hook.js";

const app = new Hono();

app.post("/hook", async (c) => {
	const body = await c.req.json();
	await handleHookEvent(body);
	return c.body(null, 204);
});

export default app;
