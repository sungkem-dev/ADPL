/**
 * food.routes.ts — Food-related API routes
 *
 * Base path: /api/food (mounted in server.ts)
 *
 * Routes:
 *   POST   /api/food/scan          → AI food recognition (multipart/form-data)
 *   GET    /api/food/logs          → Get user's food logs
 *   POST   /api/food/logs          → Manual food log entry
 *   DELETE /api/food/logs/:id      → Delete a food log entry
 */
import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/auth.js';
import {
  scanFood,
  getFoodLogs,
  createFoodLog,
  deleteFoodLog,
} from '../controllers/food.controller.js';

const router = Router();

/**
 * Multer configuration — in-memory storage.
 *
 * Files are stored as Buffer in memory (req.file.buffer) rather than on disk.
 * This is ideal for small-to-medium images being forwarded to a third-party API.
 *
 * Limits:
 *   - File size: 10MB (Gemini supports up to 20MB inline)
 *   - Only images accepted (jpeg, png, webp, gif)
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
  fileFilter: (_req, file, callback) => {
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowedMimeTypes.includes(file.mimetype)) {
      callback(null, true);
    } else {
      callback(new Error(`Unsupported file type: ${file.mimetype}. Allowed: JPEG, PNG, WebP, GIF`));
    }
  },
});

// All food routes require authentication
router.use(authenticate);

// AI Food Scan — accepts multipart/form-data with field name "image"
router.post('/scan', upload.single('image'), scanFood);

// Food Logs CRUD
router.get('/logs',       getFoodLogs);
router.post('/logs',      createFoodLog);
router.delete('/logs/:id', deleteFoodLog);

export default router;
