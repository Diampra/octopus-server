require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const slugify = require("slugify");
const path = require("path");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const { PrismaClient } = require("@prisma/client");
const { createClient } = require("@supabase/supabase-js");

const { requireAuth } = require("./middleware/requireAuth");
const { requireAdmin } = require("./middleware/requireAdmin");

const app = express();
const prisma = new PrismaClient();
const { generateVideoPoster } = require("./utils/generateVideoPoster");
const fs = require("fs");
const os = require("os");
/* ---------- Middleware ---------- */
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());

/* ---------- Supabase Admin Client ---------- */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* ---------- Multer ---------- */
const upload = multer({ storage: multer.memoryStorage() });
async function collectDbImages(prisma) {
  const [services, portfolio, blogs] = await Promise.all([
    prisma.service.findMany({ select: { imageUrl: true } }),
    prisma.portfolioItem.findMany({ select: { imageUrl: true } }),
    // prisma.testimonial.findMany({ select: { imageUrl: true } }),
    prisma.blogPost.findMany({ select: { imageUrl: true } }),
  ]);

  return [...services, ...portfolio, ...blogs]
    .map(i => i.imageUrl)
    .filter(Boolean)
    .map(url =>
      url
        .split("/storage/v1/object/public/")[1]
        ?.replace(`${process.env.SUPABASE_BUCKET}/`, "")
    )
    .filter(Boolean);
}

async function listBucketFiles(supabase) {
  const folders = ["services", "portfolio", "testimonials", "blog", "misc"];
  let files = [];

  for (const folder of folders) {
    const { data, error } = await supabase
      .storage
      .from(process.env.SUPABASE_BUCKET)
      .list(folder, { limit: 1000 });

    if (error || !data) continue;

    files.push(
      ...data
        .filter(f => f.name)
        .map(f => `${folder}/${f.name}`)
    );
  }

  return files;
}

/* ===============================
   AUTH ROUTES
================================ */

/* LOGIN */
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;

  if (email !== process.env.ADMIN_EMAIL) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const valid = await bcrypt.compare(
    password,
    process.env.ADMIN_PASSWORD_HASH
  );

  if (!valid) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = crypto
    .createHmac("sha256", process.env.ADMIN_SESSION_SECRET)
    .update(email)
    .digest("hex");

  res.cookie("admin_session", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
  });

  res.json({
    user: { email },
    isAdmin: true,
  });
});

/* ME */
app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({
    user: req.user,
    isAdmin: true,
  });
});

/* LOGOUT */
app.post("/api/auth/logout", (_req, res) => {
  res.clearCookie("admin_session");
  res.json({ success: true });
});
app.post("/api/admin/categories", requireAdmin, async (req, res) => {
  const { name } = req.body;

  if (!name) {
    return res.status(400).json({ error: "Category name required" });
  }

  const slug = name.toLowerCase().replace(/\s+/g, "-");

try {
  const category = await prisma.blogCategory.create({
    data: { name, slug },
  });
  res.json(category);
} catch {
  res.status(409).json({ error: "Category already exists" });
}

  // res.json(category);
});
app.delete("/api/admin/categories/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;

  const postsCount = await prisma.blogPost.count({
    where: { categoryId: id },
  });

  if (postsCount > 0) {
    return res.status(409).json({
      error: "CATEGORY_IN_USE",
      message: "Category has posts assigned",
    });
  }

  await prisma.blogCategory.delete({
    where: { id },
  });

  res.json({ success: true });
});

app.get("/api/categories", async (_req, res) => {
  const categories = await prisma.blogCategory.findMany({
    orderBy: { name: "asc" },
  });

  res.json(categories);
});
/* ===============================
   ADMIN BLOG ROUTES
================================ */
app.post(
  "/api/admin/blog/upload",
  requireAdmin,
  upload.single("file"),
  async (req, res) => {
    try {
      console.log("=== UPLOAD START ===");
      console.log("FILE:", req.file);
      console.log("BODY:", req.body);
      console.log("BUCKET:", process.env.SUPABASE_BUCKET);
      console.log("URL:", process.env.SUPABASE_URL);
      console.log(
        "SERVICE KEY EXISTS:",
        !!process.env.SUPABASE_SERVICE_ROLE_KEY
      );

      if (!req.file) {
        return res.status(400).json({ error: "No file received" });
      }

      const ext = path.extname(req.file.originalname);
      const filePath = `blog/${Date.now()}${ext}`;

      console.log("UPLOAD PATH:", filePath);
      console.log("MIME:", req.file.mimetype);
      console.log("SIZE:", req.file.size);

      const { data, error } = await supabase.storage
        .from(process.env.SUPABASE_BUCKET)
        .upload(filePath, req.file.buffer, {
          contentType: req.file.mimetype,
          upsert: false,
        });

      console.log("SUPABASE DATA:", data);
      console.log("SUPABASE ERROR:", error);

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      const url = `${process.env.SUPABASE_URL}/storage/v1/object/public/${process.env.SUPABASE_BUCKET}/${filePath}`;

      console.log("PUBLIC URL:", url);
      console.log("=== UPLOAD END ===");

      res.json({ url });
    } catch (err) {
      console.error("UPLOAD CRASH:", err);
      res.status(500).json({ error: "Upload crashed" });
    }
  }
);

app.post("/api/admin/blog", requireAdmin, async (req, res) => {
  try {
    const {
      title,
      slug,
      excerpt,
      content,
      image_url,
      author,
      read_time,
      published,
      categoryId,
    } = req.body;

    const blog = await prisma.blogPost.create({
      data: {
        title,
        slug,
        excerpt,
        content,
        imageUrl: image_url,
        author,
        readTime: read_time,
        published,
        categoryId,
      },
    });

    res.json(blog);
  } catch (err) {
    res.status(500).json({ error: "Failed to create blog" });
  }
});
app.get("/api/admin/blog/:id", requireAdmin, async (req, res) => {
  const blog = await prisma.blogPost.findUnique({
    where: { id: req.params.id },
  });

  if (!blog) {
    return res.status(404).json({ error: "Post not found" });
  }

  res.json(blog);
});
app.put("/api/admin/blog/:id", requireAdmin, async (req, res) => {
  try {
    const {
      title,
      slug,
      excerpt,
      content,
      image_url,
      author,
      read_time,
      published,
      categoryId, 
    } = req.body;

    const blog = await prisma.blogPost.update({
      where: { id: req.params.id },
      data: {
        title,
        slug,
        excerpt,
        content,
        imageUrl: image_url,
        author,
        readTime: read_time,
        published,
        categoryId,
      },
    });

    res.json(blog);
  } catch {
    res.status(500).json({ error: "Failed to update blog" });
  }
});
app.delete("/api/admin/blog/:id", requireAdmin, async (req, res) => {
  await prisma.blogPost.delete({
    where: { id: req.params.id },
  });

  res.json({ success: true });
});
app.get("/api/admin/blogs", requireAdmin, async (_req, res) => {
  const blogs = await prisma.blogPost.findMany({
    orderBy: { createdAt: "desc" },
  });

  res.json(blogs);
});


/* ===============================
   PUBLIC BLOG ROUTES
================================ */

app.get("/api/blogs", async (req, res) => {
  res.set("Cache-Control", "public, max-age=300");

  const limit = Math.min(Number(req.query.limit) || 9, 50);
  const cursor = req.query.cursor;

  const blogs = await prisma.blogPost.findMany({
    where: { published: true },
    orderBy: { createdAt: "desc" },
    take: limit + 1, // fetch one extra
    ...(cursor && {
      cursor: { id: cursor },
      skip: 1,
    }),
    select: {
      id: true,
      title: true,
      slug: true,
      excerpt: true,
      imageUrl: true,
      createdAt: true,
      category: {
        select: {
          name: true,
          slug: true,
        },
      },
    },
  });

  const hasMore = blogs.length > limit;
  const items = hasMore ? blogs.slice(0, -1) : blogs;
  const nextCursor = hasMore ? items[items.length - 1].id : null;

  res.json({
    items,
    nextCursor,
  });
});

app.get("/api/blogs/:slug", async (req, res) => {
  const blog = await prisma.blogPost.findUnique({
    where: { slug: req.params.slug },
    include: {
      category: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });

  if (!blog || !blog.published) {
    return res.sendStatus(404);
  }

  res.json(blog);
});
app.post(
  "/api/admin/portfolio/upload",
  requireAdmin,
  upload.single("file"),
  async (req, res) => {
    const ext = path.extname(req.file.originalname);
    const filePath = `portfolio/${Date.now()}${ext}`;

    const { error } = await supabase.storage
      .from(process.env.SUPABASE_BUCKET)
      .upload(filePath, req.file.buffer, {
        contentType: req.file.mimetype,
      });

    if (error) return res.status(500).json({ error: error.message });

    const url = `${process.env.SUPABASE_URL}/storage/v1/object/public/${process.env.SUPABASE_BUCKET}/${filePath}`;
    res.json({ url });
  }
);
app.post("/api/admin/portfolio/categories", requireAdmin, async (req, res) => {
  const { name } = req.body;

  if (!name?.trim()) {
    return res.status(400).json({ error: "Category name required" });
  }

  const baseSlug = slugify(name, { lower: true, strict: true });

  try {
    const category = await prisma.portfolioCategory.create({
      data: {
        name,
        slug: baseSlug,
      },
    });

    return res.json(category);
  } catch (err) {
    // Handle duplicate slug safely
    if (err.code === "P2002") {
      return res.status(409).json({
        error: "CATEGORY_EXISTS",
        message: "Category already exists",
      });
    }

    console.error("Category create failed:", err);
    return res.status(500).json({ error: "Failed to create category" });
  }
});

app.get("/api/portfolio/featured", async (_req, res) => {
  const items = await prisma.portfolioItem.findMany({
    where: {
      featured: true,
      published: true,
    },
    include: {
      category: {
        select: { name: true },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 4,
  });

  res.json(items);
});
app.delete("/api/admin/portfolio/:id", requireAdmin, async (req, res) => {
  await prisma.portfolioItem.delete({
    where: { id: req.params.id },
  });

  res.json({ success: true });
});

app.delete("/api/admin/portfolio/categories/:id", requireAdmin, async (req, res) => {
  const count = await prisma.portfolioItem.count({
    where: { categoryId: req.params.id },
  });

  if (count > 0) {
    return res.status(400).json({ error: "Category has items assigned" });
  }

  await prisma.portfolioCategory.delete({
    where: { id: req.params.id },
  });

  res.json({ success: true });
});
app.post("/api/admin/portfolio", requireAdmin, async (req, res) => {
  const item = await prisma.portfolioItem.create({
    data: req.body,
  });
  res.json(item);
});

app.put("/api/admin/portfolio/:id", requireAdmin, async (req, res) => {
  const item = await prisma.portfolioItem.update({
    where: { id: req.params.id },
    data: req.body,
  });
  res.json(item);
});

app.delete("/api/admin/portfolio/:id", requireAdmin, async (req, res) => {
  await prisma.portfolioItem.delete({
    where: { id: req.params.id },
  });
  res.json({ success: true });
});
app.get("/api/portfolio", async (req, res) => {
  res.set("Cache-Control", "public, max-age=300");

  const limit = Math.min(Number(req.query.limit) || 9, 50);
  const cursor = req.query.cursor;

  const items = await prisma.portfolioItem.findMany({
    where: { published: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor && {
      cursor: { id: cursor },
      skip: 1,
    }),
    select: {
      id: true,
      title: true,
      client: true,
      description: true,
      imageUrl: true,
      category: {
        select: { name: true },
      },
    },
  });

  const hasMore = items.length > limit;
  const data = hasMore ? items.slice(0, -1) : items;

  res.json({
    items: data,
    nextCursor: hasMore ? data[data.length - 1].id : null,
  });
});

app.get("/api/portfolio/categories", async (_req, res) => {
  
  const categories = await prisma.portfolioCategory.findMany({
    orderBy: { name: "asc" },
  });
  res.json(categories);
});
app.get("/api/admin/portfolio/:id", requireAdmin, async (req, res) => {
  const item = await prisma.portfolioItem.findUnique({
    where: { id: req.params.id },
    include: {
      category: {
        select: { id: true, name: true },
      },
    },
  });

  if (!item) {
    return res.status(404).json({ error: "Portfolio item not found" });
  }

  res.json(item);
});
app.get("/api/services", async (_req, res) => {
  res.set("Cache-Control", "public, max-age=600");

  const services = await prisma.service.findMany({
    where: { published: true },
    orderBy: { order: "asc" },
    take: 20,
    select: {
      id: true,
      slug: true,
      title: true,
      description: true,
      icon: true,
      imageUrl: true,
      features: true,
    },
  });

  res.json(services);
});

app.post("/api/admin/services", requireAdmin, async (req, res) => {
  //find max order
  const last = await prisma.service.findFirst({
    orderBy: { order: "desc" },
    select: { order: true },
  });

  const nextOrder = last ? last.order + 1 : 1;

  // create service
  const service = await prisma.service.create({
    data: {
      ...req.body,
      order: nextOrder, // ALWAYS SET
    },
  });

  res.json(service);
});

app.put("/api/admin/services/:id", requireAdmin, async (req, res) => {
  const { order, ...rest } = req.body;

  const service = await prisma.service.update({
    where: { id: req.params.id },
    data: {
      ...rest,
      ...(order !== undefined && { order }),
    },
  });

  res.json(service);
});

app.get("/api/admin/services/:id", requireAdmin, async (req, res) => {
  const service = await prisma.service.findUnique({
    where: { id: req.params.id },
  });
  res.json(service);
});
app.get("/api/admin/services", requireAdmin, async (_req, res) => {
  const services = await prisma.service.findMany({
    orderBy: { order: "asc" },
  });
  res.json(services);
});
app.post(
  "/api/admin/services/upload",
  requireAdmin,
  upload.single("file"),
  async (req, res) => {
    const ext = path.extname(req.file.originalname);
    const filePath = `services/${Date.now()}${ext}`;

    const { error } = await supabase.storage
      .from(process.env.SUPABASE_BUCKET)
      .upload(filePath, req.file.buffer, {
        contentType: req.file.mimetype,
      });

    if (error) return res.status(500).json({ error: error.message });

    const url = `${process.env.SUPABASE_URL}/storage/v1/object/public/${process.env.SUPABASE_BUCKET}/${filePath}`;
    res.json({ url });
  }
);
app.patch("/api/admin/services/:id/toggle", requireAdmin, async (req, res) => {
  const { published, featured } = req.body;

  const service = await prisma.service.update({
    where: { id: req.params.id },
    data: {
      ...(published !== undefined && { published }),
      ...(featured !== undefined && { featured }),
    },
  });

  res.json(service);
});
app.get("/api/services/featured", async (_req, res) => {
  const services = await prisma.service.findMany({
    where: {
      published: true,
      featured: true,
    },
    orderBy: { order: "asc" },
    take: 4,
  });

  res.json(services);
});
app.delete("/api/admin/services/:id", requireAdmin, async (req, res) => {
  await prisma.service.delete({
    where: { id: req.params.id },
  });

  res.json({ success: true });
});
app.get("/api/testimonials/featured", async (_req, res) => {
  const testimonials = await prisma.testimonial.findMany({
    where: { published: true, featured: true },
    orderBy: { order: "asc" },
    take: 3,
  });
  res.json(testimonials);
});
app.get("/api/testimonials", async (_req, res) => {
  const testimonials = await prisma.testimonial.findMany({
    orderBy: { order: "asc" },
  });
  res.json(testimonials);
});
app.post("/api/admin/testimonials", requireAdmin, async (req, res) => {
  //find max order
  const last = await prisma.testimonial.findFirst({
    orderBy: { order: "desc" },
    select: { order: true },
  });
  const nextOrder = last ? last.order + 1 : 1;

  // create testimonial
  const testimonial = await prisma.testimonial.create({
    data: {
      ...req.body,
      order: nextOrder, // ALWAYS SET
    },
  });

  res.json(testimonial);
});
app.put("/api/admin/testimonials/:id", requireAdmin, async (req, res) => {
  const { order, ...rest } = req.body;
  const testimonial = await prisma.testimonial.update({
    where: { id: req.params.id },
    data: {
      ...rest,
      ...(order !== undefined && { order }),
    },
  });
  res.json(testimonial);
});

app.patch("/api/admin/testimonials/:id/toggle",
  requireAdmin,
  async (req, res) => {
    const { published, featured } = req.body;
    const testimonial = await prisma.testimonial.update({
      where: { id: req.params.id },
      data: {
        ...(published !== undefined && { published }),
        ...(featured !== undefined && { featured }),
      },
    });

    res.json(testimonial);
  }
);
app.get("/api/admin/testimonials/:id", requireAdmin, async (req, res) => {
  const testimonial = await prisma.testimonial.findUnique({
    where: { id: req.params.id },
  });

  if (!testimonial) {
    return res.status(404).json({ error: "Testimonial not found" });
  }

  res.json(testimonial);
});
app.delete("/api/admin/testimonials/:id", requireAdmin, async (req, res) => {
  await prisma.testimonial.delete({
    where: { id: req.params.id },
  });
  res.json({ success: true });
});

app.get("/api/admin/storage/audit", requireAdmin, async (_req, res) => {
  // Parallel data fetching - major improvement
  const [dbFiles, storageFiles] = await Promise.all([
    collectDbImages(prisma),
    listBucketFiles(supabase)
  ]);

  // Convert both to Sets for O(1) lookups
  const dbSet = new Set(dbFiles);
  const storageSet = new Set(storageFiles);

  const linked = [];
  const orphan = [];
  const missing = [];

  // Single pass through storage files
  for (const file of storageFiles) {
    if (dbSet.has(file)) {
      linked.push({ file, status: "linked" });
    } else {
      orphan.push({ file, status: "orphan" });
    }
  }

  // Efficient missing file detection using Set
  for (const file of dbFiles) {
    if (!storageSet.has(file)) {
      missing.push({ file, status: "missing" });
    }
  }

  res.json({
    summary: {
      linked: linked.length,
      orphan: orphan.length,
      missing: missing.length,
    },
    linked,
    orphan,
    missing,
  });
});
app.post("/api/admin/storage/delete", requireAdmin, async (req, res) => {
  const { files } = req.body;

  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: "No files provided" });
  }

  const { error } = await supabase
    .storage
    .from(process.env.SUPABASE_BUCKET)
    .remove(files);

  if (error) return res.status(500).json({ error: error.message });

  res.json({ success: true, deleted: files.length });
});

// ADMIN DASHBOARD STATS
app.get("/api/admin/dashboard", requireAdmin, async (_req, res) => {
  const [
    totalPosts,
    publishedPosts,
    totalCategories,
    totalPortfolio,
    publishedPortfolio,
    totalServices,
    publishedServices,
    totalTestimonials,
    publishedTestimonials,
  ] = await Promise.all([
    prisma.blogPost.count(),
    prisma.blogPost.count({ where: { published: true } }),

    prisma.blogCategory.count(),

    prisma.portfolioItem.count(),
    prisma.portfolioItem.count({ where: { published: true } }),

    prisma.service.count(),
    prisma.service.count({ where: { published: true } }),

    prisma.testimonial.count(),
    prisma.testimonial.count({ where: { published: true } }),
  ]);

  res.json({
    posts: {
      total: totalPosts,
      published: publishedPosts,
    },
    categories: totalCategories,
    portfolio: {
      total: totalPortfolio,
      published: publishedPortfolio,
    },
    services: {
      total: totalServices,
      published: publishedServices,
    },
    testimonials: {
      total: totalTestimonials,
      published: publishedTestimonials,
    },
  });
});
app.post(
  "/api/admin/storage/upload",
  requireAdmin,
  upload.single("file"),
  async (req, res) => {
    try {
      const { folder = "misc" } = req.body;
      const isVideo = req.file.mimetype.startsWith("video/");
      const ext = path.extname(req.file.originalname);
      const baseName = Date.now();

      const filePath = `${folder}/${baseName}${ext}`;
      let posterPath = null;

      /* Upload original */
      await supabase.storage
        .from(process.env.SUPABASE_BUCKET)
        .upload(filePath, req.file.buffer, {
          contentType: req.file.mimetype,
        });

      /* Generate poster if video */
      if (isVideo) {
        const tempVideo = path.join(os.tmpdir(), `${baseName}${ext}`);
        fs.writeFileSync(tempVideo, req.file.buffer);

        const generatedPoster = await generateVideoPoster(tempVideo);
        posterPath = `${folder}/posters/${baseName}.jpg`;

        const posterBuffer = fs.readFileSync(generatedPoster);

        await supabase.storage
          .from(process.env.SUPABASE_BUCKET)
          .upload(posterPath, posterBuffer, {
            contentType: "image/jpeg",
            upsert: true,
          });

        fs.unlinkSync(tempVideo);
        fs.unlinkSync(generatedPoster);
      }

      /* SAVE IN DB (THIS WAS NEVER RUNNING BEFORE) */
      const media = await prisma.media.create({
        data: {
          filePath,
          posterPath,
          folder,
          type: isVideo ? "video" : "image",
        },
      });

      res.json(media);
    } catch (err) {
      console.error("UPLOAD FAILED:", err);
      res.status(500).json({ error: "Upload failed" });
    }
  }
);
app.post("/api/admin/storage/delete", requireAdmin, async (req, res) => {
  const { files } = req.body;

  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: "No files provided" });
  }

  const mediaRecords = await prisma.media.findMany({
    where: { filePath: { in: files } },
  });

  const pathsToDelete = new Set();

  for (const file of files) {
    pathsToDelete.add(file);

    //  fallback poster inference (old uploads)
    const posterGuess = file.replace(/\/([^/]+)\.\w+$/, "/posters/$1.jpg");
    pathsToDelete.add(posterGuess);
  }

  for (const media of mediaRecords) {
    if (media.posterPath) {
      pathsToDelete.add(media.posterPath);
    }
  }

  await supabase.storage
    .from(process.env.SUPABASE_BUCKET)
    .remove([...pathsToDelete]);

  await prisma.media.deleteMany({
    where: { filePath: { in: files } },
  });

  res.json({
    success: true,
    deleted: [...pathsToDelete],
  });
});
app.post("/api/admin/storage/cleanup-posters", requireAdmin, async (_req, res) => {
  const { data, error } = await supabase.storage
    .from(process.env.SUPABASE_BUCKET)
    .list("misc/posters", { limit: 1000 });

  if (error) return res.status(500).json({ error: error.message });

  const dbPosters = await prisma.media.findMany({
    where: { posterPath: { not: null } },
    select: { posterPath: true },
  });

  const dbSet = new Set(dbPosters.map(p => p.posterPath));

  const orphanPosters = data
    .map(f => `misc/posters/${f.name}`)
    .filter(p => !dbSet.has(p));

  if (orphanPosters.length > 0) {
    await supabase.storage
      .from(process.env.SUPABASE_BUCKET)
      .remove(orphanPosters);
  }

  res.json({
    deleted: orphanPosters.length,
    files: orphanPosters,
  });
});

app.get("/api/admin/media", requireAdmin, async (_req, res) => {
  const media = await prisma.media.findMany({
    orderBy: { createdAt: "desc" },
  });
  res.json(media);
});

/* ===============================
   START SERVER
================================ */

app.listen(5000, () => {
  console.log("Blog server running on port 5000");
});
