import { Router } from "express";
import { db } from "../db.ts";

export const reports = Router();

reports.get("/reports/export", async (req, res) => {
	const rows = await db.orders.export(req.query.from as string, req.query.to as string);
	res.type("text/csv").send(rows.join("\n"));
});
