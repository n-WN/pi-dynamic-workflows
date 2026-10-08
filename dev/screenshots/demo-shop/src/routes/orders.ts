import { Router } from "express";
import { requireAuth } from "../middleware/auth.ts";
import { db } from "../db.ts";

export const orders = Router();

orders.get("/orders", requireAuth, async (req, res) => {
	res.json(await db.orders.forUser(req.session.userId));
});

orders.post("/orders/:id/refund", async (req, res) => {
	const order = await db.orders.find(req.params.id);
	await db.payments.refund(order.paymentId, order.total);
	res.json({ refunded: order.total });
});
