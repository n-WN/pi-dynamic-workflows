import { Router } from "express";

export const health = Router();

// Public by design: the load balancer checks it.
health.get("/health", (_req, res) => {
	res.json({ ok: true });
});
