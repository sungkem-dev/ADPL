/**
 * food.controller.ts — Food Scan & Food Log Endpoints
 *
 * Handles:
 *   POST /api/food/scan     — AI food recognition via Google Gemini
 *   GET  /api/food/logs     — Fetch user's food logs
 *   POST /api/food/logs     — Manual food log entry
 *   DELETE /api/food/logs/:id — Delete a food log entry
 */
import type { Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../config/supabaseClient.js';
import { analyzeFood } from '../services/gemini.service.js';
import { uploadFoodImage } from '../services/storage.service.js';
import { createError } from '../middleware/errorHandler.js';

// ─── POST /api/food/scan ──────────────────────────────────────────────────────

/**
 * scanFood — The core AI feature.
 *
 * Complete flow:
 *   1. Receive image from multipart/form-data (via multer)
 *   2. Upload image to Supabase Storage → get public URL
 *   3. Send image buffer to Gemini AI → get nutritional data
 *   4. Insert record into `food_logs` table
 *   5. Insert record into `ai_scan_results` table
 *   6. Return formatted response to frontend
 */
export async function scanFood(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // ── Validate that a file was provided ───────────────────────────────────
    if (!req.file) {
      throw createError(400, 'No image file provided. Send a multipart/form-data request with field "image".');
    }

    const userId = req.user!.id;
    const { buffer, mimetype, originalname } = req.file;

    // Optional fields from the form body
    const mealType = (req.body.meal_type as string | undefined) ?? 'snack';
    const validMealTypes = ['breakfast', 'lunch', 'dinner', 'snack'];
    const sanitizedMealType = validMealTypes.includes(mealType) ? mealType : 'snack';

    // ── auto_save control ────────────────────────────────────────────────────
    // When the frontend detects low confidence (< 0.70), it sends auto_save=false.
    // In that case we still run the AI analysis but do NOT insert into food_logs
    // or ai_scan_results. The frontend will let the user correct the food name
    // and then call POST /api/food/logs manually.
    const autoSaveParam = req.body.auto_save ?? req.query.auto_save ?? 'true';
    const autoSave = autoSaveParam !== 'false' && autoSaveParam !== false;

    console.log(`[Food Scan] User ${userId} scanning food image: ${originalname} (auto_save=${autoSave})`);

    // ── Step 1: Upload image to Supabase Storage ─────────────────────────────
    console.log('[Food Scan] Uploading to Supabase Storage...');
    const { publicUrl } = await uploadFoodImage(buffer, originalname, userId, mimetype);
    console.log(`[Food Scan] Image stored at: ${publicUrl}`);

    // ── Step 2: Analyze with Google Gemini AI ─────────────────────────────────
    console.log('[Food Scan] Sending to Gemini AI for analysis...');
    const nutritionData = await analyzeFood(buffer, mimetype);
    console.log(`[Food Scan] Detected: ${nutritionData.foodName} (${nutritionData.calories} kcal, confidence: ${(nutritionData.confidence * 100).toFixed(1)}%)`);

    // ── Step 3 & 4: Conditionally save to DB ─────────────────────────────────
    let foodLogId: string | null = null;

    if (autoSave) {
      // Insert into food_logs
      const { data: foodLog, error: foodLogError } = await supabaseAdmin
        .from('food_logs')
        .insert({
          user_id:   userId,
          food_name: nutritionData.foodName,
          calories:  nutritionData.calories,
          protein:   nutritionData.protein,
          carbs:     nutritionData.carbs,
          fat:       nutritionData.fat,
          fiber:     nutritionData.fiber,
          meal_type: sanitizedMealType,
          source:    'ai_scan',
          consumed_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (foodLogError) {
        console.error('[Food Scan] Failed to insert food_log:', foodLogError);
        throw createError(500, `Database error inserting food log: ${foodLogError.message}`);
      }

      foodLogId = foodLog.id;

      // Insert into ai_scan_results
      const { error: scanError } = await supabaseAdmin
        .from('ai_scan_results')
        .insert({
          user_id:              userId,
          food_log_id:          foodLog.id,
          image_url:            publicUrl,
          raw_api_response_json: nutritionData.rawResponse,
          detected_foods:       nutritionData.detectedFoods,
          confidence_score:     nutritionData.confidence,
        });

      if (scanError) {
        console.error('[Food Scan] Failed to insert ai_scan_results:', scanError);
      }

      console.log(`[Food Scan] ✓ Auto-saved to food_logs (id: ${foodLog.id})`);
    } else {
      console.log('[Food Scan] ⊘ auto_save=false — returning analysis only, not persisting');
    }

    // ── Step 5: Return formatted response ─────────────────────────────────────
    res.status(201).json({
      success: true,
      message: autoSave
        ? 'Food analyzed and logged successfully'
        : 'Food analyzed successfully (not saved — low confidence or manual review)',
      data: {
        food_log_id:    foodLogId,
        food_name:      nutritionData.foodName,
        detected_foods: nutritionData.detectedFoods,
        meal_type:      sanitizedMealType,
        image_url:      publicUrl,
        confidence:     nutritionData.confidence,
        auto_saved:     autoSave,
        nutrition: {
          calories: nutritionData.calories,
          protein:  nutritionData.protein,
          carbs:    nutritionData.carbs,
          fat:      nutritionData.fat,
          fiber:    nutritionData.fiber,
        },
        consumed_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
}


// ─── GET /api/food/logs ───────────────────────────────────────────────────────

/**
 * getFoodLogs — Retrieves the authenticated user's food logs.
 * Supports optional query params: date (YYYY-MM-DD), limit, offset
 */
export async function getFoodLogs(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.user!.id;
    const { date, limit = '50', offset = '0' } = req.query;

    let query = supabaseAdmin
      .from('food_logs')
      .select('*')
      .eq('user_id', userId)
      .order('consumed_at', { ascending: false })
      .limit(parseInt(limit as string, 10))
      .range(
        parseInt(offset as string, 10),
        parseInt(offset as string, 10) + parseInt(limit as string, 10) - 1
      );

    // Filter by specific date if provided
    if (date && typeof date === 'string') {
      const startOfDay = `${date}T00:00:00.000Z`;
      const endOfDay   = `${date}T23:59:59.999Z`;
      query = query.gte('consumed_at', startOfDay).lte('consumed_at', endOfDay);
    }

    const { data, error, count } = await query;

    if (error) {
      throw createError(500, `Failed to fetch food logs: ${error.message}`);
    }

    res.json({
      success: true,
      data: data ?? [],
      meta: { total: count ?? 0 },
    });
  } catch (err) {
    next(err);
  }
}

// ─── POST /api/food/logs (manual entry) ──────────────────────────────────────

export async function createFoodLog(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.user!.id;
    const { food_name, calories, protein, carbs, fat, fiber, meal_type, consumed_at } = req.body;

    if (!food_name || calories === undefined) {
      throw createError(400, 'Required fields: food_name, calories');
    }

    const { data, error } = await supabaseAdmin
      .from('food_logs')
      .insert({
        user_id:     userId,
        food_name,
        calories:    Number(calories),
        protein:     Number(protein ?? 0),
        carbs:       Number(carbs ?? 0),
        fat:         Number(fat ?? 0),
        fiber:       Number(fiber ?? 0),
        meal_type:   meal_type ?? 'snack',
        source:      'manual',
        consumed_at: consumed_at ?? new Date().toISOString(),
      })
      .select()
      .single();

    if (error) {
      throw createError(500, `Failed to create food log: ${error.message}`);
    }

    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// ─── DELETE /api/food/logs/:id ────────────────────────────────────────────────

export async function deleteFoodLog(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    const { error } = await supabaseAdmin
      .from('food_logs')
      .delete()
      .eq('id', id)
      .eq('user_id', userId); // Ensures users can only delete their own logs

    if (error) {
      throw createError(500, `Failed to delete food log: ${error.message}`);
    }

    res.json({ success: true, message: 'Food log deleted successfully' });
  } catch (err) {
    next(err);
  }
}
