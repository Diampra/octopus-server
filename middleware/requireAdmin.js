const { requireAuth } = require("./requireAuth");

function requireAdmin(req, res, next) {
  return requireAuth(req, res, next);
}

module.exports = { requireAdmin };