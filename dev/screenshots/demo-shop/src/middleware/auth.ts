import type { NextFunction, Request, Response } from "express";

/** Rejects requests without a valid session. */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
	if (!req.session?.userId) return res.status(401).json({ error: "login required" });
	next();
}

/** Rejects users without the given role. Use after requireAuth. */
export function requireRole(role: string) {
	return (req: Request, res: Response, next: NextFunction) => {
		if (req.session?.role !== role) return res.status(403).json({ error: "forbidden" });
		next();
	};
}
