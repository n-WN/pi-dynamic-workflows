import { Router } from "express";
import { requireAuth } from "../middleware/auth.ts";
import { db, verifySignature } from "../db.ts";

export const payments = Router();

// Public by design: the provider calls it; the signature proves the sender.
payments.post("/payments/webhook", async (req, res) => {
	if (!verifySignature(req)) return res.status(400).end();
	await db.payments.record(req.body);
	res.status(204).end();
});

payments.get("/payments/:id", requireAuth, async (req, res) => {
	res.json(await db.payments.find(req.params.id));
});
