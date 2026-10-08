import { Router } from "express";
import { requireAuth } from "../middleware/auth.ts";
import { db } from "../db.ts";

export const users = Router();

users.get("/users/:id", requireAuth, async (req, res) => {
	res.json(await db.users.find(req.params.id));
});

users.patch("/users/:id", async (req, res) => {
	await db.users.update(req.params.id, req.body);
	res.json({ ok: true });
});

users.delete("/users/:id", requireAuth, async (req, res) => {
	await db.users.remove(req.params.id);
	res.status(204).end();
});
