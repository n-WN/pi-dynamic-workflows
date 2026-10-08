import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.ts";
import { db } from "../db.ts";

export const admin = Router();

admin.get("/admin/stats", async (_req, res) => {
	res.json({ users: await db.users.count(), revenue: await db.orders.revenue() });
});

admin.post("/admin/flags", requireAuth, requireRole("admin"), async (req, res) => {
	await db.flags.set(req.body.name, req.body.value);
	res.json({ ok: true });
});
