const { PrismaClient } = require("@prisma/client");

const prisma = global.prisma || new PrismaClient();

// In development, save the instance to the global object to prevent
// multiple instances during hot reloading
if (process.env.NODE_ENV !== "production") {
  global.prisma = prisma;
}

module.exports = prisma;