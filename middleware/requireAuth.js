const crypto = require("crypto");

function requireAuth(req, res, next) {
  const token = req.cookies.admin_session;
  if (!token) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const expected = crypto
    .createHmac("sha256", process.env.ADMIN_SESSION_SECRET)
    .update(process.env.ADMIN_EMAIL)
    .digest("hex");

  if (token !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  req.user = { email: process.env.ADMIN_EMAIL };
  next();
}

module.exports = { requireAuth };
