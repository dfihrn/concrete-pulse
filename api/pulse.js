import { createVercelHandlers } from "../vercel-pulse.js";
export default function handler(req, res) { return createVercelHandlers().pulse(req, res); }
