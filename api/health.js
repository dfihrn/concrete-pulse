import { createVercelHandlers } from "../vercel-pulse.js";
export default function handler(req, res) { return createVercelHandlers().health(req, res); }
